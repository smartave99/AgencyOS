import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiManager, summarizeHardware } from '../lib/ai.mjs';
import { resolvePaths } from '../lib/paths.mjs';

const hardware = (over = {}) => ({
  platform: 'win32',
  arch: 'x64',
  osName: 'Windows 11',
  cpu: { name: 'Test CPU', threads: 8 },
  ramGB: 16,
  disk: { freeGB: 200 },
  gpus: [],
  warnings: [],
  ...over,
});

/** A scripted Ollama: tracks which models are installed and what it was asked to do. */
function fakeOllama({ tokensPerSecond = 20, failPull = null } = {}) {
  const f = {
    up: false,
    installed: new Set(),
    calls: [],
    rate: tokensPerSecond,
    async version() { return f.up ? '0.40.3' : null; },
    async has(m) { return f.installed.has(m) || f.installed.has(`${m}:latest`); },
    async pull(model, onProgress) {
      f.calls.push(['pull', model]);
      if (failPull) { const e = failPull(model); if (e) throw e; }
      onProgress({ status: 'pulling', completed: 50, total: 100, fraction: 0.5 });
      onProgress({ status: 'success', completed: 100, total: 100, fraction: 1 });
      f.installed.add(model);
    },
    async embed() { return [new Array(768).fill(0.1)]; },
    async generate(model, prompt, opts = {}) {
      f.calls.push(['generate', model]);
      const n = opts.options?.num_predict ?? 4;
      return { response: '{"headlines":["a","b","c"]}', eval_count: n, eval_duration: (n / f.rate) * 1e9 };
    },
    async unload(m) { f.calls.push(['unload', m]); },
    async remove(m) { f.calls.push(['remove', m]); f.installed.delete(m); },
  };
  return f;
}

function fakeRuntime(client, { installError = null } = {}) {
  const r = {
    installed: false,
    version: null,
    installs: 0,
    async install(hw, { onProgress } = {}) {
      r.installs += 1;
      if (installError?.()) throw installError();
      onProgress?.({ received: 100, total: 200 });
      r.installed = true;
      r.version = 'v0.40.3';
    },
  };
  return r;
}

describe('AiManager', () => {
  let dir;
  let paths;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agencyos-ai-'));
    paths = resolvePaths({ launcherDir: path.join(dir, 'install', 'launcher'), env: { AGENCYOS_DATA: path.join(dir, 'data') }, platform: process.platform });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const make = ({ hw = hardware(), client = fakeOllama(), runtime, registry, sleepFn } = {}) => {
    const rt = runtime || fakeRuntime(client);
    const started = [];
    const mgr = new AiManager({
      paths,
      ollamaHost: 'http://127.0.0.1:11434',
      hostEnv: {},
      detect: async () => hw,
      registry: registry || (async () => ({ exists: true })),
      makeClient: () => client,
      makeRuntime: () => rt,
      startOllama: async () => { started.push(true); client.up = true; },
      sleepFn: sleepFn || (async () => {}),
    });
    return { mgr, client, rt, started };
  };

  it('plans, installs the runtime, pulls both models, checks them and reports ready', async () => {
    const { mgr, client, rt, started } = make();
    const plan = await mgr.planModels();
    assert.equal(plan.tier, 'standard');
    assert.deepEqual(mgr.appEnv(), { OLLAMA_HOST: 'http://127.0.0.1:11434', AI_MODEL: 'gemma4:e2b', EMBEDDING_MODEL: 'embeddinggemma' });

    const outcome = await mgr.run();
    assert.equal(outcome, 'ready');
    assert.equal(rt.installs, 1);
    assert.equal(started.length, 1);
    assert.deepEqual([...client.installed].sort(), ['embeddinggemma', 'gemma4:e2b']);
    const snap = mgr.snapshot();
    assert.equal(snap.phase, 'ready');
    assert.equal(snap.models.embedding.state, 'ready');
    assert.equal(snap.models.embedding.dimensions, 768);
    assert.equal(snap.models.text.state, 'ready');
    assert.ok(snap.benchmark.tokensPerSecond > 0);
  });

  it('steps down a tier, deletes the rejected model, and announces the new model names when the machine is too slow', async () => {
    const client = fakeOllama({ tokensPerSecond: 1.5 });
    const { mgr } = make({ client });
    const changes = [];
    mgr.on('models-changed', (env) => changes.push(env));
    await mgr.planModels();
    // The lighter model is fast enough.
    const realGenerate = client.generate;
    client.generate = async (model, prompt, opts) => {
      client.rate = model === 'gemma4:e2b' ? 1.5 : 25;
      return realGenerate(model, prompt, opts);
    };
    const outcome = await mgr.run();
    assert.equal(outcome, 'ready');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].AI_MODEL, 'gemma3:1b');
    assert.ok(client.calls.some(([c, m]) => c === 'remove' && m === 'gemma4:e2b'));
    assert.ok(client.installed.has('gemma3:1b'));
    assert.equal(mgr.snapshot().tier, 'light');
    assert.match(mgr.snapshot().reasons[0], /too slow/);
  });

  it('remembers the step-down so the next start does not repeat the benchmark or the download', async () => {
    const client = fakeOllama({ tokensPerSecond: 1.5 });
    const first = make({ client });
    await first.mgr.planModels();
    const realGenerate = client.generate;
    client.generate = async (m, p, o) => { client.rate = m === 'gemma4:e2b' ? 1.5 : 25; return realGenerate(m, p, o); };
    await first.mgr.run();

    const registryCalls = [];
    const second = make({ client, registry: async (id) => { registryCalls.push(id); return { exists: true }; } });
    await second.mgr.planModels();
    assert.equal(second.mgr.appEnv().AI_MODEL, 'gemma3:1b');
    assert.deepEqual(registryCalls, [], 'cached plan needs no registry lookups');
    const before = client.calls.length;
    assert.equal(await second.mgr.run(), 'ready');
    assert.equal(client.calls.slice(before).filter(([c]) => c === 'pull').length, 0);
  });

  it('falls back to the next candidate when the registry no longer has the preferred tag', async () => {
    const { mgr } = make({ registry: async (id) => ({ exists: id !== 'gemma4:e2b' }) });
    const plan = await mgr.planModels();
    assert.equal(plan.textModel, 'gemma3:4b');
  });

  it('keeps the planned name when the registry cannot be reached (offline first run)', async () => {
    const { mgr } = make({ registry: async () => ({ exists: null }) });
    const plan = await mgr.planModels();
    assert.equal(plan.textModel, 'gemma4:e2b');
  });

  it('waits for the internet instead of failing, then finishes once it is back', async () => {
    const client = fakeOllama();
    let online = false;
    const rt = fakeRuntime(client, { installError: () => (online ? null : new Error('fetch failed')) });
    const sleeps = [];
    const { mgr } = make({
      client,
      runtime: rt,
      sleepFn: async (ms) => { sleeps.push(ms); online = true; },
    });
    await mgr.planModels();
    const phases = [];
    mgr.on('status', (s) => phases.push(s.phase));
    assert.equal(await mgr.run(), 'ready');
    assert.ok(phases.includes('waiting-network'));
    assert.equal(sleeps.length, 1);
    assert.equal(rt.installs, 2);
  });

  it('does nothing on a machine that is too small and says so', async () => {
    const { mgr, rt } = make({ hw: hardware({ ramGB: 3 }) });
    await mgr.planModels();
    assert.equal(await mgr.run(), 'off');
    assert.equal(rt.installs, 0);
    assert.equal(mgr.snapshot().phase, 'off');
    assert.deepEqual(mgr.appEnv(), { OLLAMA_HOST: 'http://127.0.0.1:11434' });
  });

  it('uses an Ollama that is already running and installs nothing', async () => {
    const client = fakeOllama();
    client.up = true;
    const { mgr, rt, started } = make({ client });
    await mgr.planModels();
    assert.equal(mgr.snapshot().external, true);
    assert.equal(await mgr.run(), 'ready');
    assert.equal(rt.installs, 0);
    assert.equal(started.length, 0);
  });

  it('summarizeHardware prefers a real GPU over a virtual one', () => {
    const s = summarizeHardware(hardware({ gpus: [{ vendor: 'virtual', name: 'Hyper-V Video' }, { vendor: 'nvidia', name: 'RTX 4060', vramGB: 8 }] }));
    assert.equal(s.gpu, 'RTX 4060 (8 GB)');
  });
});
