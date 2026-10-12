// Starts the services in dependency order, waits for each to be ready, restarts crashed ones
// with backoff, and stops everything cleanly. It does not know what any service is; see
// services.mjs for the contract each service satisfies.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { sleep, waitFor } from './net.mjs';

const RESTART_WINDOW_MS = 5 * 60 * 1000;
const MAX_RESTARTS_IN_WINDOW = 6;
const START_ATTEMPTS = 3;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Name of the executable behind a PID, so a recycled PID is never mistaken for ours. */
export function processName(pid, platform = process.platform) {
  return new Promise((resolve) => {
    if (platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (error, stdout) => {
        const m = /^"([^"]+)"/.exec(String(stdout || '').trim());
        resolve(error || !m ? null : m[1].toLowerCase());
      });
    } else {
      fsp.readFile(`/proc/${pid}/comm`, 'utf8').then((s) => resolve(s.trim().toLowerCase())).catch(() => resolve(null));
    }
  });
}

/** Ends a process and everything it started (Ollama starts llama-server; Windows has no process groups). */
export function killTree(pid, platform = process.platform) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    resolve();
  });
}

export function rotateLog(file, { keep = 3, maxBytes = LOG_MAX_BYTES } = {}) {
  try {
    if (fs.statSync(file).size < maxBytes) return;
  } catch {
    return;
  }
  for (let i = keep - 1; i >= 1; i -= 1) {
    try {
      fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch {
      /* nothing to shift */
    }
  }
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* in use */
  }
}

export function tailFile(file, lines = 200, maxBytes = 128 * 1024) {
  try {
    const { size } = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8').replace(/\r?\n$/, '').split(/\r?\n/).slice(-lines).join('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export class Supervisor extends EventEmitter {
  constructor({
    services,
    logsDir,
    runDir,
    platform = process.platform,
    log = () => {},
    backoffMs = (n) => Math.min(1000 * 2 ** n, 30000),
    pollMs = 400,
    expectedImages = [],
  }) {
    super();
    this.logsDir = logsDir;
    this.runDir = runDir;
    this.platform = platform;
    this.log = log;
    this.backoffMs = backoffMs;
    this.pollMs = pollMs;
    this.expectedImages = expectedImages;
    this.shuttingDown = false;
    this.rt = new Map(
      services.map((def) => [
        def.name,
        { def, state: def.optionalStart ? 'idle' : 'pending', message: '', child: null, pid: null, error: null, restartTimes: [], startedAt: null, timers: new Set(), starting: null },
      ])
    );
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
  }

  #update(rt, patch) {
    Object.assign(rt, patch);
    this.emit('change', this.snapshot());
  }

  get(name) {
    const rt = this.rt.get(name);
    if (!rt) throw new Error(`Unknown service: ${name}`);
    return rt;
  }

  logFile(name) {
    return path.join(this.logsDir, `${name}.log`);
  }

  tail(name, lines = 200) {
    return tailFile(this.logFile(name), lines);
  }

  snapshot() {
    return [...this.rt.values()].map((rt) => ({
      name: rt.def.name,
      label: rt.def.label,
      required: !!rt.def.required,
      state: rt.state,
      message: rt.message,
      error: rt.error,
      pid: rt.pid,
      startedAt: rt.startedAt,
      restarts: rt.restartTimes.length,
    }));
  }

  /** True when every required service is up (one-shot tasks count when they finished). */
  isReady() {
    return [...this.rt.values()].filter((r) => r.def.required).every((r) => r.state === 'ready' || r.state === 'done');
  }

  hasFailed() {
    return [...this.rt.values()].some((r) => r.def.required && r.state === 'failed');
  }

  // ---- starting ------------------------------------------------------------------------

  async startAll() {
    const names = [...this.rt.values()].filter((r) => !r.def.optionalStart).map((r) => r.def.name);
    await Promise.all(names.map((n) => this.start(n)));
  }

  /** Starts one service after the ones it depends on. Safe to call twice. */
  start(name) {
    const rt = this.get(name);
    if (rt.starting) return rt.starting;
    rt.starting = (async () => {
      try {
        for (const dep of rt.def.dependsOn || []) {
          const d = this.get(dep);
          if (d.starting) await d.starting;
          else if (!['ready', 'done'].includes(d.state)) await this.start(dep);
          if (!['ready', 'done'].includes(d.state)) {
            this.#update(rt, { state: 'failed', error: `${rt.def.label} could not start because ${d.def.label} is not running.`, message: 'Waiting on another service' });
            return false;
          }
        }
        return await this.#startWithRetries(rt);
      } finally {
        rt.starting = null;
      }
    })();
    return rt.starting;
  }

  async #startWithRetries(rt) {
    for (let attempt = 1; attempt <= START_ATTEMPTS; attempt += 1) {
      if (this.shuttingDown) return false;
      try {
        await this.#startOnce(rt);
        return true;
      } catch (error) {
        this.log(`${rt.def.name}: start attempt ${attempt} failed: ${error.message}`);
        await this.#killChild(rt);
        this.#update(rt, { state: attempt < START_ATTEMPTS ? 'restarting' : 'failed', error: error.message, message: error.message });
        if (attempt < START_ATTEMPTS) await sleep(this.backoffMs(attempt - 1));
      }
    }
    return false;
  }

  async #startOnce(rt) {
    const { def } = rt;
    this.#update(rt, { state: 'starting', message: 'Starting', error: null });
    await def.prepare?.((message) => this.#update(rt, { message }));
    // A start that never returns must fail visibly instead of showing "Starting" forever.
    let timer;
    const spec = await Promise.race([
      Promise.resolve(def.spawn()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${def.label} did not start within ${Math.round((def.readyTimeoutMs || 60000) / 1000)} seconds.`)), def.readyTimeoutMs || 60000);
      }),
    ]).finally(() => clearTimeout(timer));

    if (spec.daemon) {
      this.#update(rt, { pid: null, startedAt: Date.now() });
    } else if (def.oneShot) {
      await this.#runOneShot(rt, spec);
      this.#update(rt, { state: 'done', message: 'Done' });
      return;
    } else {
      this.#launch(rt, spec);
    }

    const deadline = Date.now() + (def.readyTimeoutMs || 60000);
    for (;;) {
      if (rt.exited) {
        throw new Error(`${def.label} stopped while starting (exit code ${rt.exited.code}).\n${this.tail(def.name, 12)}`);
      }
      if (await Promise.resolve(def.isReady()).catch(() => false)) break;
      if (Date.now() >= deadline) throw new Error(`${def.label} did not become ready in time.\n${this.tail(def.name, 12)}`);
      await sleep(this.pollMs);
    }
    await def.afterReady?.();
    this.#update(rt, { state: 'ready', message: 'Running', error: null });
  }

  #open(rt) {
    const file = this.logFile(rt.def.name);
    rotateLog(file);
    return fs.openSync(file, 'a');
  }

  #launch(rt, spec) {
    const fd = this.#open(rt);
    fs.writeSync(fd, `\n--- ${new Date().toISOString()} starting ${path.basename(spec.command)} ---\n`);
    rt.exited = null;
    const child = spawn(spec.command, spec.args || [], {
      cwd: spec.cwd,
      env: spec.env || process.env,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      detached: this.platform !== 'win32', // own process group on Unix so killTree can reach children
    });
    fs.closeSync(fd);
    rt.child = child;
    child.on('error', (error) => {
      rt.exited = { code: -1, error: error.message };
      this.log(`${rt.def.name}: ${error.message}`);
    });
    this.#update(rt, { pid: child.pid, startedAt: Date.now() });
    if (child.pid) fs.writeFileSync(path.join(this.runDir, `${rt.def.name}.pid`), String(child.pid));
    child.on('exit', (code, signal) => this.#onExit(rt, child, code, signal));
  }

  #runOneShot(rt, spec) {
    return new Promise((resolve, reject) => {
      const fd = this.#open(rt);
      fs.writeSync(fd, `\n--- ${new Date().toISOString()} running ${path.basename(spec.command)} ${(spec.args || []).slice(0, 3).join(' ')} ---\n`);
      const child = spawn(spec.command, spec.args || [], { cwd: spec.cwd, env: spec.env || process.env, windowsHide: true, stdio: ['ignore', fd, fd] });
      fs.closeSync(fd);
      const timer = setTimeout(() => {
        killTree(child.pid, this.platform);
        reject(new Error(`${rt.def.label} took too long.`));
      }, rt.def.readyTimeoutMs || 300000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`${rt.def.label} failed (exit code ${code}).\n${this.tail(rt.def.name, 15)}`));
      });
    });
  }

  #onExit(rt, child, code, signal) {
    try {
      fs.rmSync(path.join(this.runDir, `${rt.def.name}.pid`), { force: true });
    } catch {
      /* ignore */
    }
    if (rt.child !== child) return;
    rt.child = null;
    rt.exited = { code, signal };
    if (rt.stopping || this.shuttingDown) {
      this.#update(rt, { state: 'stopped', pid: null, message: 'Stopped' });
      return;
    }
    if (rt.state === 'starting') return; // #startOnce notices through rt.exited
    const now = Date.now();
    rt.restartTimes = [...rt.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS), now];
    this.log(`${rt.def.name}: exited (code ${code}, signal ${signal})`);
    if (rt.restartTimes.length > MAX_RESTARTS_IN_WINDOW) {
      this.#update(rt, { state: 'failed', pid: null, error: `${rt.def.label} keeps stopping (exit code ${code}). See its log for the reason.`, message: 'Keeps stopping' });
      return;
    }
    this.#update(rt, { state: 'restarting', pid: null, message: `Restarting after exit code ${code}` });
    const timer = setTimeout(() => {
      rt.timers.delete(timer);
      if (!this.shuttingDown) this.#startWithRetries(rt);
    }, this.backoffMs(rt.restartTimes.length - 1));
    rt.timers.add(timer);
  }

  // ---- stopping ------------------------------------------------------------------------

  async #killChild(rt) {
    const child = rt.child;
    if (!child) return;
    rt.stopping = true;
    await killTree(child.pid, this.platform);
    await waitFor(() => !isAlive(child.pid), { timeoutMs: 10000, intervalMs: 100 });
    rt.child = null;
    rt.stopping = false;
  }

  async stop(name) {
    const rt = this.get(name);
    for (const t of rt.timers) clearTimeout(t);
    rt.timers.clear();
    rt.stopping = true;
    try {
      if (rt.def.stop) await rt.def.stop();
      await this.#killChild(rt);
    } finally {
      rt.stopping = false;
    }
    this.#update(rt, { state: rt.def.optionalStart ? 'idle' : 'stopped', pid: null, message: 'Stopped' });
  }

  /** Reverse dependency order: apps first, then their engines, the database last. */
  #shutdownOrder() {
    const order = [];
    const seen = new Set();
    const visit = (name) => {
      if (seen.has(name)) return;
      seen.add(name);
      for (const dep of this.get(name).def.dependsOn || []) visit(dep);
      order.push(name);
    };
    for (const name of this.rt.keys()) visit(name);
    return order.reverse();
  }

  async stopAll() {
    this.shuttingDown = true;
    const order = this.#shutdownOrder();
    // Independent services stop together; anything that others depend on waits for them.
    const remaining = new Set(order);
    while (remaining.size) {
      const batch = [...remaining].filter((n) => ![...remaining].some((o) => o !== n && (this.get(o).def.dependsOn || []).includes(n)));
      await Promise.all(batch.map((n) => this.stop(n).catch((e) => this.log(`${n}: stop failed: ${e.message}`))));
      batch.forEach((n) => remaining.delete(n));
      if (!batch.length) break;
    }
  }

  async restart(name) {
    const rt = this.get(name);
    this.shuttingDown = false;
    await this.stop(name);
    rt.restartTimes = [];
    return this.start(name);
  }
}

/**
 * Removes processes left behind by a supervisor that was killed (power loss, task manager).
 * Only PIDs whose executable name is one of ours are touched.
 */
export async function cleanupStale({ runDir, expectedImages, platform = process.platform, log = () => {} }) {
  let files = [];
  try {
    files = (await fsp.readdir(runDir)).filter((f) => f.endsWith('.pid'));
  } catch {
    return;
  }
  for (const f of files) {
    const file = path.join(runDir, f);
    const pid = Number.parseInt(await fsp.readFile(file, 'utf8').catch(() => ''), 10);
    if (pid && isAlive(pid)) {
      const image = await processName(pid, platform);
      if (image && expectedImages.some((e) => image.startsWith(e.toLowerCase().replace(/\.exe$/, '')))) {
        log(`Stopping leftover ${image} (pid ${pid}) from a previous run`);
        await killTree(pid, platform);
      }
    }
    await fsp.rm(file, { force: true });
  }
}
