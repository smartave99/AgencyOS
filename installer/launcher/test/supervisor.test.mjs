import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Supervisor, isAlive, rotateLog, tailFile, cleanupStale } from '../lib/supervisor.mjs';
import { waitFor, sleep } from '../lib/net.mjs';

const NODE = process.execPath;
// A child that marks itself ready, then idles until killed.
const idler = (marker) => ({
  command: NODE,
  args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`],
});

describe('Supervisor', () => {
  let dir;
  let sup;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agencyos-sup-'));
  });
  afterEach(async () => {
    if (sup) await sup.stopAll().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const make = (services, over = {}) => {
    sup = new Supervisor({
      services,
      logsDir: path.join(dir, 'logs'),
      runDir: path.join(dir, 'run'),
      backoffMs: () => 30,
      pollMs: 25,
      ...over,
    });
    return sup;
  };
  const markerReady = (marker) => async () => fs.existsSync(marker);

  it('starts services after the ones they depend on and reports readiness', async () => {
    const order = [];
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    make([
      { name: 'b', label: 'B', required: true, dependsOn: ['a'], spawn: () => { order.push('spawn-b'); return idler(b); }, isReady: markerReady(b) },
      { name: 'a', label: 'A', required: true, dependsOn: [], spawn: () => { order.push('spawn-a'); return idler(a); }, isReady: markerReady(a) },
    ]);
    await sup.startAll();
    assert.deepEqual(order, ['spawn-a', 'spawn-b']);
    assert.equal(sup.isReady(), true);
    assert.deepEqual(sup.snapshot().map((s) => s.state), ['ready', 'ready']);
  });

  it('marks a service failed, with a readable reason, when its dependency never starts', async () => {
    make([
      { name: 'db', label: 'Database', required: true, dependsOn: [], readyTimeoutMs: 300, spawn: () => ({ command: NODE, args: ['-e', 'process.exit(3)'] }), isReady: async () => false },
      { name: 'app', label: 'App', required: true, dependsOn: ['db'], spawn: () => idler(path.join(dir, 'never')), isReady: async () => true },
    ]);
    await sup.startAll();
    const states = Object.fromEntries(sup.snapshot().map((s) => [s.name, s]));
    assert.equal(states.db.state, 'failed');
    assert.equal(states.app.state, 'failed');
    assert.match(states.app.error, /Database is not running/);
    assert.equal(sup.hasFailed(), true);
    assert.equal(sup.isReady(), false);
  });

  it('restarts a process that dies after it was running', async () => {
    const marker = path.join(dir, 'm');
    let runs = 0;
    make([
      {
        name: 'flaky',
        label: 'Flaky',
        required: true,
        dependsOn: [],
        spawn: () => {
          runs += 1;
          // First run dies shortly after becoming ready; later runs stay up.
          const life = runs === 1 ? 'setTimeout(() => process.exit(7), 700)' : 'setInterval(() => {}, 1000)';
          return { command: NODE, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1'); ${life}`] };
        },
        isReady: markerReady(marker),
      },
    ]);
    await sup.startAll();
    assert.equal(sup.get('flaky').state, 'ready');
    const recovered = await waitFor(() => runs === 2 && sup.get('flaky').state === 'ready', { timeoutMs: 8000, intervalMs: 50 });
    assert.ok(recovered, `expected a restart, runs=${runs} state=${sup.get('flaky').state}`);
    assert.equal(sup.snapshot()[0].restarts, 1);
  });

  it('gives up on a process that keeps crashing instead of looping forever', async () => {
    make([
      { name: 'bad', label: 'Bad', required: true, dependsOn: [], readyTimeoutMs: 2000, spawn: () => ({ command: NODE, args: ['-e', 'process.exit(9)'] }), isReady: async () => false },
    ]);
    await sup.startAll();
    const s = sup.snapshot()[0];
    assert.equal(s.state, 'failed');
    assert.match(s.error, /stopped while starting \(exit code 9\)/);
  });

  it('stopAll ends every child process', async () => {
    const m1 = path.join(dir, 'm1');
    const m2 = path.join(dir, 'm2');
    make([
      { name: 'one', label: 'One', required: true, dependsOn: [], spawn: () => idler(m1), isReady: markerReady(m1) },
      { name: 'two', label: 'Two', required: true, dependsOn: ['one'], spawn: () => idler(m2), isReady: markerReady(m2) },
    ]);
    await sup.startAll();
    const pids = sup.snapshot().map((s) => s.pid);
    assert.ok(pids.every(isAlive));
    await sup.stopAll();
    await sleep(100);
    assert.ok(pids.every((p) => !isAlive(p)), 'children must be gone');
    assert.deepEqual(sup.snapshot().map((s) => s.state), ['stopped', 'stopped']);
  });

  it('stops dependents before the things they depend on', async () => {
    const stops = [];
    const mk = (name, dependsOn) => ({
      name, label: name, required: true, dependsOn,
      spawn: () => ({ daemon: true }),
      isReady: async () => true,
      stop: async () => { stops.push(name); await sleep(10); },
    });
    make([mk('db', []), mk('api', ['db']), mk('web', ['api'])]);
    await sup.startAll();
    await sup.stopAll();
    assert.deepEqual(stops, ['web', 'api', 'db']);
  });

  it('runs one-shot tasks to completion and reports failures with the log tail', async () => {
    make([
      { name: 'good', label: 'Good task', required: true, oneShot: true, dependsOn: [], spawn: () => ({ command: NODE, args: ['-e', 'console.log("migrated")'] }) },
      { name: 'bad', label: 'Bad task', required: true, oneShot: true, dependsOn: [], spawn: () => ({ command: NODE, args: ['-e', 'console.error("boom: relation missing"); process.exit(2)'] }) },
    ]);
    await sup.startAll();
    const byName = Object.fromEntries(sup.snapshot().map((s) => [s.name, s]));
    assert.equal(byName.good.state, 'done');
    assert.match(sup.tail('good'), /migrated/);
    assert.equal(byName.bad.state, 'failed');
    assert.match(byName.bad.error, /exit code 2/);
    assert.match(byName.bad.error, /relation missing/);
  });

  it('does not start optional services until asked', async () => {
    const m = path.join(dir, 'opt');
    make([
      { name: 'core', label: 'Core', required: true, dependsOn: [], spawn: () => idler(path.join(dir, 'core')), isReady: markerReady(path.join(dir, 'core')) },
      { name: 'ai', label: 'AI', required: false, optionalStart: true, dependsOn: [], spawn: () => idler(m), isReady: markerReady(m) },
    ]);
    await sup.startAll();
    assert.equal(sup.get('ai').state, 'idle');
    assert.equal(sup.isReady(), true);
    await sup.start('ai');
    assert.equal(sup.get('ai').state, 'ready');
  });

  it('restart() replaces the process', async () => {
    const m = path.join(dir, 'r');
    make([{ name: 'r', label: 'R', required: true, dependsOn: [], spawn: () => idler(m), isReady: markerReady(m) }]);
    await sup.startAll();
    const first = sup.get('r').pid;
    fs.rmSync(m);
    await sup.restart('r');
    assert.equal(sup.get('r').state, 'ready');
    assert.notEqual(sup.get('r').pid, first);
    assert.equal(isAlive(first), false);
  });
});

describe('log helpers', () => {
  it('rotateLog shifts old logs and tailFile reads the end of a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agencyos-log-'));
    const file = path.join(dir, 'x.log');
    fs.writeFileSync(file, 'a'.repeat(50));
    rotateLog(file, { maxBytes: 10 });
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8').length, 50);
    fs.writeFileSync(file, 'line1\nline2\nline3\nline4\n');
    assert.equal(tailFile(file, 2), 'line3\nline4');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('cleanupStale removes pid files and leaves unrelated processes alone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agencyos-stale-'));
    fs.writeFileSync(path.join(dir, 'ghost.pid'), '999999');
    fs.writeFileSync(path.join(dir, 'mine.pid'), String(process.pid)); // this test runner is "node", not an expected image here
    await cleanupStale({ runDir: dir, expectedImages: ['redis-server'] });
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(isAlive(process.pid), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
