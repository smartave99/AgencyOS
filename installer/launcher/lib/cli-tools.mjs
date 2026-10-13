// The command-line AI tools AgencyOS can use: Antigravity (installed with AgencyOS), and Claude Code and
// Codex, which are downloaded only when the person asks. Each is installed by its own vendor's official
// Windows installer, and each is signed in through the vendor's browser page, never in a terminal window.
//
// One thing runs at a time (a download or a sign-in). Everything the vendors' programs print is kept for
// the log and the last lines are shown when something fails; no sign-in secret ever passes through here:
// the programs store their own credentials, and this only asks them whether they are signed in.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export const TOOL_IDS = ['antigravity', 'claude', 'codex'];

/**
 * installUrl: the vendor's documented Windows installer script (run as `irm <url> | iex`, no administrator needed).
 * login: how a browser sign-in is started. `process` runs the program's own login command and watches it;
 *        `window` starts the program itself in a hidden window (its first start opens the Google sign-in page).
 * hosts: the only sites a sign-in link may point at when one is shown to the person as a fallback.
 */
export const CATALOG = {
  antigravity: {
    label: 'Antigravity CLI',
    binary: 'agy',
    installUrl: 'https://antigravity.google/cli/install.ps1',
    login: { mode: 'window' },
    check: { kind: 'probe' },
    hosts: ['accounts.google.com', 'google.com', 'antigravity.google'],
    canSignOut: false,
  },
  claude: {
    label: 'Claude Code',
    binary: 'claude',
    installUrl: 'https://claude.ai/install.ps1',
    login: { mode: 'process', args: ['auth', 'login'] },
    check: { kind: 'exit', args: ['auth', 'status'] },
    logout: { args: ['auth', 'logout'] },
    hosts: ['claude.ai', 'claude.com', 'anthropic.com', 'platform.claude.com'],
    canSignOut: true,
  },
  codex: {
    label: 'Codex CLI',
    binary: 'codex',
    installUrl: 'https://chatgpt.com/codex/install.ps1',
    login: { mode: 'process', args: ['login'] },
    check: { kind: 'exit', args: ['login', 'status'] },
    logout: { args: ['logout'] },
    hosts: ['auth.openai.com', 'openai.com', 'chatgpt.com'],
    canSignOut: true,
  },
};

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 4000;
const VERSION_TIMEOUT_MS = 15000;
const CHECK_TIMEOUT_MS = 20000;
const PROBE_TIMEOUT_MS = 60000;
const SIGNED_OUT = /log ?in|sign ?in|authenticat|not logged|unauthori[sz]ed|credential|login required/i;

export class CliToolError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const lastLines = (text, n = 6) =>
  String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' ')
    .slice(0, 400);

/** Runs a program and collects what it prints. Never throws: a program that cannot start has code -1. */
export function run(command, args, { timeoutMs = 30000, env, cwd, onLine, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      done({ code: -2, timedOut: true });
    }, timeoutMs);
    try {
      child = spawnImpl(command, args, { env: env ?? process.env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return done({ code: -1, error: error.message });
    }
    const feed = (chunk, which) => {
      const text = chunk.toString();
      if (which === 'out') stdout = (stdout + text).slice(-20000);
      else stderr = (stderr + text).slice(-20000);
      if (onLine) for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim());
    };
    child.stdout?.on('data', (c) => feed(c, 'out'));
    child.stderr?.on('data', (c) => feed(c, 'err'));
    child.on('error', (error) => done({ code: -1, error: error.message }));
    child.on('close', (code) => done({ code: code ?? -1 }));
  });
}

const psExe = (env) => path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export class CliTools {
  /**
   * @param opts.platform   'win32' for the real thing; tests pass 'linux' with their own `install`
   * @param opts.install    async (tool, { onLine }) => void, replaces running the vendor's script
   * @param opts.extraDirs  folders searched for a program besides the user's PATH
   */
  constructor({ env = process.env, platform = process.platform, log = () => {}, install, extraDirs, spawnImpl = spawn, pollMs = POLL_MS, startWindow } = {}) {
    this.env = env;
    this.platform = platform;
    this.log = log;
    this.installImpl = install;
    this.spawnImpl = spawnImpl;
    this.pollMs = pollMs;
    this.startWindow = startWindow ?? ((file, tool) => this.#startHiddenWindow(file, tool));
    this.home = env.USERPROFILE || env.HOME || os.homedir();
    this.extraDirs =
      extraDirs ??
      [path.join(this.home, '.local', 'bin'), ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'agy', 'bin')] : [])];
    this.task = null;
    this.child = null;
    this.windowPid = null;
    this.cache = new Map(); // tool -> { signedIn, at, detail }
    this.cancelled = false;
  }

  // ---- finding what is installed ---------------------------------------------------------

  /** The user's own PATH as the registry holds it, which is where the vendors' installers add their folders. */
  async userPathDirs() {
    if (this.platform !== 'win32') return [];
    const res = await run(path.join(this.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'), ['query', 'HKCU\\Environment', '/v', 'Path'], {
      timeoutMs: 8000,
      spawnImpl: this.spawnImpl,
    });
    const match = /Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(res.stdout || '');
    if (!match) return [];
    const expand = (s) => s.replace(/%([^%]+)%/g, (all, name) => this.env[name] ?? this.env[name.toUpperCase()] ?? all);
    return match[1].trim().split(';').map((d) => expand(d.trim())).filter(Boolean);
  }

  async locate(id) {
    const tool = CATALOG[id];
    const dirs = [...(await this.userPathDirs()), ...(this.env.PATH || '').split(path.delimiter), ...this.extraDirs].filter(Boolean);
    const names = this.platform === 'win32' ? [`${tool.binary}.exe`, `${tool.binary}.cmd`] : [tool.binary];
    for (const dir of dirs) {
      for (const name of names) {
        const full = path.join(dir, name);
        try {
          if (fs.statSync(full).isFile()) return full;
        } catch {
          /* not here */
        }
      }
    }
    return null;
  }

  async version(file) {
    const res = await run(file, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS, spawnImpl: this.spawnImpl });
    if (res.code !== 0) return null;
    return lastLines(res.stdout || res.stderr, 1).slice(0, 80) || null;
  }

  // ---- am I signed in? ---------------------------------------------------------------------

  /** Asks the program itself. true / false, or null when it cannot tell (reported plainly, never guessed). */
  async check(id) {
    const tool = this.#validTool(id);
    const file = await this.locate(id);
    if (!file) return this.#remember(id, null, 'Not installed.');
    if (tool.check.kind === 'exit') {
      const res = await run(file, tool.check.args, { timeoutMs: CHECK_TIMEOUT_MS, spawnImpl: this.spawnImpl });
      if (res.code === 0) return this.#remember(id, true, 'Signed in.');
      if (res.code === 1) return this.#remember(id, false, 'Not signed in.');
      return this.#remember(id, null, 'Could not tell whether it is signed in.');
    }
    // Antigravity has no status command: ask it for one word. A program that is not signed in refuses at once.
    const res = await run(file, ['-p', 'Reply with the single word OK.'], { timeoutMs: PROBE_TIMEOUT_MS, spawnImpl: this.spawnImpl });
    if (res.code === 0 && res.stdout.trim()) return this.#remember(id, true, 'Signed in.');
    if (SIGNED_OUT.test(`${res.stderr}\n${res.stdout}`)) return this.#remember(id, false, 'Not signed in.');
    return this.#remember(id, null, 'Could not tell whether it is signed in.');
  }

  #remember(id, signedIn, detail) {
    this.cache.set(id, { signedIn, detail, at: Date.now() });
    return signedIn;
  }

  /** What the settings page shows. Sign-in is the last answer the program gave; press Check to ask again. */
  async snapshot() {
    const tools = [];
    for (const id of TOOL_IDS) {
      const tool = CATALOG[id];
      const file = await this.locate(id);
      const known = this.cache.get(id);
      tools.push({
        id,
        label: tool.label,
        installed: !!file,
        path: file,
        version: file ? await this.version(file) : null,
        signedIn: file ? known?.signedIn ?? null : false,
        canSignOut: tool.canSignOut,
      });
    }
    return { platform: this.platform, tools, task: this.task ? { ...this.task } : null };
  }

  // ---- one thing at a time ---------------------------------------------------------------

  #begin(tool, action, message) {
    if (this.task && ['working', 'waiting'].includes(this.task.state)) {
      throw new CliToolError(`${CATALOG[this.task.tool].label}: ${this.task.message} Wait for it to finish, or cancel it.`, 409);
    }
    this.cancelled = false;
    this.task = { tool, action, state: 'working', message };
  }

  #set(patch) {
    if (this.task) this.task = { ...this.task, ...patch };
  }

  #validTool(id) {
    if (!TOOL_IDS.includes(id)) throw new CliToolError('Unknown tool.', 400);
    return CATALOG[id];
  }

  // ---- download ---------------------------------------------------------------------------

  /** Downloads and installs the program with its vendor's official installer. Returns at once; progress is in the snapshot. */
  startInstall(id) {
    const tool = this.#validTool(id);
    if (this.platform !== 'win32' && !this.installImpl) {
      throw new CliToolError(`${tool.label} can be downloaded here only in the Windows app.`, 400);
    }
    this.#begin(id, 'install', `Downloading ${tool.label}…`);
    this.#install(id).catch((error) => {
      this.log(`${tool.label}: ${error.message}`);
      this.#set({ state: 'failed', message: '', error: error.message });
    });
    return { started: true };
  }

  async #install(id) {
    const tool = CATALOG[id];
    const lines = [];
    const onLine = (line) => {
      lines.push(line);
      if (lines.length > 40) lines.shift();
    };
    if (this.installImpl) {
      await this.installImpl(id, { onLine });
    } else {
      const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; irm '${tool.installUrl}' | iex`;
      const res = await run(psExe(this.env), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        timeoutMs: INSTALL_TIMEOUT_MS,
        spawnImpl: this.spawnImpl,
        onLine,
      });
      this.log(`${tool.label} installer exited with ${res.code}: ${lastLines(`${res.stdout}\n${res.stderr}`, 8)}`);
      if (res.timedOut) throw new Error(`The ${tool.label} download did not finish in ten minutes. Check the internet connection and try again.`);
      if (res.code !== 0) {
        throw new Error(`The ${tool.label} installer stopped: ${lastLines(`${res.stderr}\n${res.stdout}`) || 'no details were given'}`);
      }
    }
    if (this.cancelled) return this.#set({ state: 'cancelled', message: 'Cancelled.' });
    const file = await this.locate(id);
    if (!file) throw new Error(`The ${tool.label} installer finished, but the program could not be found afterwards.`);
    const version = await this.version(file);
    if (!version) throw new Error(`${tool.label} was installed but does not start. ${lastLines(lines.join('\n'))}`);
    this.log(`${tool.label} ${version} installed at ${file}`);
    this.#set({ state: 'done', message: `${tool.label} ${version} is ready.`, error: null });
  }

  // ---- sign in through the browser ------------------------------------------------------

  startLogin(id) {
    const tool = this.#validTool(id);
    this.#begin(id, 'login', 'Opening your browser to sign in…');
    this.#login(id).catch((error) => {
      this.log(`${tool.label} sign-in: ${error.message}`);
      this.#stopChild();
      this.#set({ state: 'failed', message: '', error: error.message });
    });
    return { started: true };
  }

  async #login(id) {
    const tool = CATALOG[id];
    const file = await this.locate(id);
    if (!file) throw new Error(`${tool.label} is not installed yet. Download it first.`);
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let url = null;
    let exit = null;
    const lines = [];

    if (tool.login.mode === 'process') {
      this.child = this.spawnImpl(file, tool.login.args, { env: this.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const feed = (chunk) => {
        for (const raw of chunk.toString().split(/\r?\n/)) {
          const line = raw.trim();
          if (!line) continue;
          lines.push(line);
          if (lines.length > 40) lines.shift();
          const link = this.#safeLink(id, line);
          if (link && !url) {
            url = link;
            this.#set({ url });
          }
        }
      };
      this.child.stdout?.on('data', feed);
      this.child.stderr?.on('data', feed);
      this.child.on('error', (error) => {
        exit = { code: -1, error: error.message };
      });
      this.child.on('close', (code) => {
        exit = { code: code ?? -1 };
      });
    } else {
      // The program's first start opens the sign-in page itself. It runs in a window nobody sees, and is closed again afterwards.
      this.windowPid = await this.startWindow(file, tool);
    }

    this.#set({ state: 'waiting', message: 'Finish signing in in your browser. AgencyOS notices by itself.' });
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      if (this.cancelled) return this.#stopChild();
      if (tool.login.mode === 'process' && exit && exit.code !== 0) {
        throw new Error(`${tool.label} could not start the sign-in. ${exit.error || lastLines(lines.join('\n')) || ''}`.trim());
      }
      const signedIn = await this.check(id);
      if (signedIn === true) {
        this.#stopChild();
        this.#set({ state: 'done', message: `Signed in to ${tool.label}.`, url: null, error: null });
        return;
      }
      if (tool.login.mode === 'process' && exit && exit.code === 0 && signedIn !== true) {
        // The program has finished: what it saved a moment ago may not have been in place when it was asked.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if ((await this.check(id)) === true) {
            this.#set({ state: 'done', message: `Signed in to ${tool.label}.`, url: null, error: null });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, this.pollMs));
        }
        throw new Error(`The sign-in finished, but ${tool.label} still says it is not signed in.`);
      }
    }
    this.#stopChild();
    throw new Error('The sign-in was not completed in ten minutes, so it was stopped. Try again when you are ready.');
  }

  /** Starts a program in a window nobody sees (Windows) and returns its process id. */
  async #startHiddenWindow(file, tool) {
    const started = await run(
      psExe(this.env),
      ['-NoProfile', '-NonInteractive', '-Command', `(Start-Process -FilePath '${file.replace(/'/g, "''")}' -WindowStyle Hidden -PassThru).Id`],
      { timeoutMs: 20000, spawnImpl: this.spawnImpl }
    );
    const pid = Number.parseInt(String(started.stdout).trim(), 10);
    if (!Number.isInteger(pid)) throw new Error(`${tool.label} could not be started to sign in. ${lastLines(started.stderr)}`);
    return pid;
  }

  #safeLink(id, line) {
    const found = /https:\/\/[^\s"'<>]+/.exec(line);
    if (!found) return null;
    try {
      const url = new URL(found[0]);
      const ok = CATALOG[id].hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
      return ok ? url.toString() : null;
    } catch {
      return null;
    }
  }

  #stopChild() {
    try {
      this.child?.kill();
    } catch {
      /* already gone */
    }
    this.child = null;
    if (this.windowPid && this.platform === 'win32') {
      spawn(path.join(this.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(this.windowPid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => {});
    }
    this.windowPid = null;
  }

  /** Stops a download wait or a sign-in the person no longer wants. */
  cancel() {
    if (!this.task || !['working', 'waiting'].includes(this.task.state)) return { cancelled: false };
    this.cancelled = true;
    this.#stopChild();
    this.#set({ state: 'cancelled', message: 'Cancelled.', url: null });
    return { cancelled: true };
  }

  // ---- sign out -----------------------------------------------------------------------------

  async signOut(id) {
    const tool = this.#validTool(id);
    if (!tool.logout) throw new CliToolError(`${tool.label} cannot be signed out from here.`, 400);
    const file = await this.locate(id);
    if (!file) throw new CliToolError(`${tool.label} is not installed.`, 404);
    const res = await run(file, tool.logout.args, { timeoutMs: CHECK_TIMEOUT_MS, spawnImpl: this.spawnImpl });
    if (res.code !== 0) throw new CliToolError(`${tool.label} did not sign out: ${lastLines(`${res.stderr}\n${res.stdout}`)}`, 502);
    this.cache.set(id, { signedIn: false, detail: 'Signed out.', at: Date.now() });
    return { signedOut: true };
  }
}
