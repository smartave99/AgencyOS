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
    hold: false, // a download that stays open until it is cancelled
    async version() { return f.up ? '0.40.3' : null; },
    async has(m) { return f.installed.has(m) || f.installed.has(`${m}:latest`); },
    async installedModelDetails() {
      return [...f.installed].map((name) => ({ name, sizeBytes: 1_500_000_000, modifiedAt: '2026-01-01T00:00:00Z', parameterSize: '4B', quantization: 'Q4' }));
    },
    async removeStrict(m) {
      f.calls.push(['removeStrict', m]);
      if (!f.installed.has(m)) throw new Error('model not found');
      f.installed.delete(m);
    },
    async pull(model, onProgress, { signal } = {}) {
      f.calls.push(['pull', model]);
      if (failPull) { const e = failPull(model); if (e) throw e; }
      if (f.hold) {
        await new Promise((resolve, reject) => {
          onProgress({ status: 'pulling', completed: 10, total: 100, fraction: 0.1 });
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
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

  // `auto` is whether the person turned automatic setup on; a fresh install starts with it off.
  const make = ({ hw = hardware(), client = fakeOllama(), runtime, registry, sleepFn, auto = true } = {}) => {
    const rt = runtime || fakeRuntime(client);
    const started = [];
    const stopped = [];
    const mgr = new AiManager({
      paths,
      ollamaHost: 'http://127.0.0.1:11434',
      hostEnv: {},
      detect: async () => hw,
      registry: registry || (async () => ({ exists: true })),
      makeClient: () => client,
      makeRuntime: () => rt,
      startOllama: async () => { started.push(true); client.up = true; },
      stopOllama: async () => { stopped.push(true); client.up = false; },
      sleepFn: sleepFn || (async () => {}),
    });
    if (auto) mgr.setAuto(true);
    return { mgr, client, rt, started, stopped };
  };
  const settle = async (mgr, done) => {
    for (let i = 0; i < 200; i += 1) {
      if (done(mgr.snapshot())) return mgr.snapshot();
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`never settled: ${JSON.stringify(mgr.snapshot().download || mgr.snapshot().engineTask)}`);
  };

  it('plans, installs the runtime, pulls both models, checks them and reports ready', async () => {
    const { mgr, client, rt, started } = make();
    const plan = await mgr.planModels();
    assert.equal(plan.tier, 'standard');
    assert.deepEqual(mgr.appEnv(), { OLLAMA_HOST: 'http://127.0.0.1:11434', AI_MODEL: 'qwen3.5:4b', EMBEDDING_MODEL: 'embeddinggemma' });

    const outcome = await mgr.run();
    assert.equal(outcome, 'ready');
    assert.equal(rt.installs, 1);
    assert.equal(started.length, 1);
    assert.deepEqual([...client.installed].sort(), ['embeddinggemma', 'qwen3.5:4b']);
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
      client.rate = model === 'qwen3.5:4b' ? 1.5 : 25;
      return realGenerate(model, prompt, opts);
    };
    const outcome = await mgr.run();
    assert.equal(outcome, 'ready');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].AI_MODEL, 'qwen3.5:2b');
    assert.ok(client.calls.some(([c, m]) => c === 'remove' && m === 'qwen3.5:4b'));
    assert.ok(client.installed.has('qwen3.5:2b'));
    assert.equal(mgr.snapshot().tier, 'compact');
    assert.match(mgr.snapshot().reasons[0], /too slow/);
  });

  it('remembers the step-down so the next start does not repeat the benchmark or the download', async () => {
    const client = fakeOllama({ tokensPerSecond: 1.5 });
    const first = make({ client });
    await first.mgr.planModels();
    const realGenerate = client.generate;
    client.generate = async (m, p, o) => { client.rate = m === 'qwen3.5:4b' ? 1.5 : 25; return realGenerate(m, p, o); };
    await first.mgr.run();

    const registryCalls = [];
    const second = make({ client, registry: async (id) => { registryCalls.push(id); return { exists: true }; } });
    await second.mgr.planModels();
    assert.equal(second.mgr.appEnv().AI_MODEL, 'qwen3.5:2b');
    assert.deepEqual(registryCalls, [], 'cached plan needs no registry lookups');
    const before = client.calls.length;
    assert.equal(await second.mgr.run(), 'ready');
    assert.equal(client.calls.slice(before).filter(([c]) => c === 'pull').length, 0);
  });

  it('falls back to the next candidate when the registry no longer has the preferred tag', async () => {
    const { mgr } = make({ registry: async (id) => ({ exists: id !== 'qwen3.5:4b' }) });
    const plan = await mgr.planModels();
    assert.equal(plan.textModel, 'gemma4:e2b');
  });

  it('keeps the planned name when the registry cannot be reached (offline first run)', async () => {
    const { mgr } = make({ registry: async () => ({ exists: null }) });
    const plan = await mgr.planModels();
    assert.equal(plan.textModel, 'qwen3.5:4b');
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

  it('retries a transient registry error (503) soon instead of giving up', async () => {
    let failed = false;
    const client = fakeOllama({ failPull: () => (failed ? null : ((failed = true), new Error('503: '))) });
    const sleeps = [];
    const { mgr } = make({ client, sleepFn: async (ms) => { sleeps.push(ms); } });
    await mgr.planModels();
    assert.equal(await mgr.run(), 'ready');
    assert.deepEqual(sleeps, [20000]);
    assert.ok(client.installed.has('embeddinggemma'));
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

  describe('local AI by hand', () => {
    it('a new install downloads and starts nothing: the Antigravity CLI answers until someone wants a local model', async () => {
      const { mgr, client, rt, started } = make({ auto: false });
      assert.equal(mgr.auto, false);
      assert.equal(mgr.engineWanted, false);
      await mgr.planModels();
      assert.equal(await mgr.run(), 'standby');
      assert.equal(rt.installs, 0);
      assert.equal(started.length, 0);
      assert.deepEqual([...client.installed], []);
      assert.equal(mgr.snapshot().phase, 'standby');
      assert.equal(mgr.snapshot().auto, false);
    });

    it('an install that already set local AI up keeps it automatic after the update', async () => {
      const first = make({ auto: true });
      await first.mgr.planModels(); // writes the state an older version also wrote
      const upgraded = new AiManager({
        paths, ollamaHost: 'http://127.0.0.1:11434', hostEnv: {}, detect: async () => hardware(),
        registry: async () => ({ exists: true }), makeClient: () => first.client, makeRuntime: () => first.rt,
      });
      assert.equal(upgraded.auto, true);

      // An older state file has no "auto" at all: a plan or an installed engine means it was in use.
      const state = JSON.parse(fs.readFileSync(paths.data.aiState, 'utf8'));
      delete state.auto;
      fs.writeFileSync(paths.data.aiState, JSON.stringify(state));
      const old = new AiManager({
        paths, ollamaHost: 'http://127.0.0.1:11434', hostEnv: {}, detect: async () => hardware(),
        registry: async () => ({ exists: true }), makeClient: () => first.client, makeRuntime: () => first.rt,
      });
      assert.equal(old.auto, true);
    });

    it('an engine that setup put in place does not switch automatic setup on, but an engine on an unprepared install still does', async () => {
      const client = fakeOllama();
      const rt = fakeRuntime(client);
      rt.installed = true; // the engine is on disk either way
      const open = () =>
        new AiManager({
          paths, ollamaHost: 'http://127.0.0.1:11434', hostEnv: {}, detect: async () => hardware(),
          registry: async () => ({ exists: true }), makeClient: () => client, makeRuntime: () => rt,
        });
      // An older install: the engine was put there by automatic setup.
      assert.equal(open().auto, true);
      // A new install: setup downloaded the engine and left its record, and nothing else was asked for.
      fs.mkdirSync(paths.data.config, { recursive: true });
      fs.writeFileSync(path.join(paths.data.config, 'prepare.json'), '{}');
      const fresh = open();
      assert.equal(fresh.auto, false);
      assert.equal(fresh.engineWanted, false);
      assert.equal(fresh.snapshot().auto, false);
    });

    it('turning automatic setup on sets everything up, and off stops doing so without deleting anything', async () => {
      const { mgr, client } = make({ auto: false });
      await mgr.planModels();
      assert.equal(await mgr.run(), 'standby');
      mgr.setAuto(true);
      assert.equal(await mgr.run(), 'ready');
      assert.ok(client.installed.has('embeddinggemma'));
      mgr.setAuto(false);
      assert.equal(mgr.snapshot().phase, 'standby');
      assert.ok(client.installed.has('embeddinggemma'), 'nothing is removed');
    });

    it('lists what is installed with sizes and what each is used for, and suggests models with the recommended first', async () => {
      const { mgr, client } = make();
      await mgr.planModels();
      await mgr.run();
      const list = await mgr.models();
      assert.equal(list.engine.running, true);
      assert.deepEqual(list.installed.map((m) => m.name).sort(), ['embeddinggemma', 'qwen3.5:4b']);
      assert.deepEqual(list.installed.find((m) => m.name === 'qwen3.5:4b').roles, ['copy']);
      assert.deepEqual(list.installed.find((m) => m.name === 'embeddinggemma').roles, ['search']);
      assert.equal(list.suggestions[0].recommended, true);
      assert.ok(list.suggestions.some((s) => s.id === 'gemma3:1b' && s.sizeGB));
      client.up = false;
      assert.deepEqual((await mgr.models()).installed, []); // an engine that is off lists nothing
    });

    it('downloads a model the person names, with progress, and refuses a name that is not one', async () => {
      const { mgr, client } = make({ auto: false });
      await assert.rejects(async () => mgr.downloadModel('gemma3:1b; rm -rf /'), /valid model name/);
      await assert.rejects(async () => mgr.downloadModel(''), /valid model name/);
      mgr.downloadModel('gemma3:4b');
      const done = await settle(mgr, (s) => s.download?.state === 'done');
      assert.equal(done.download.model, 'gemma3:4b');
      assert.ok(client.installed.has('gemma3:4b'));
      assert.equal(mgr.snapshot().phase, 'standby'); // downloading by hand does not turn automatic setup on
    });

    it('a download can be cancelled, and only one runs at a time', async () => {
      const { mgr, client } = make({ auto: false });
      client.hold = true;
      mgr.downloadModel('gemma3:4b');
      await settle(mgr, (s) => s.download?.state === 'downloading' && s.download.fraction > 0);
      assert.throws(() => mgr.downloadModel('gemma3:1b'), /still running/);
      assert.deepEqual(mgr.cancelDownload(), { cancelled: true });
      const cancelled = await settle(mgr, (s) => s.download?.state === 'cancelled');
      assert.equal(cancelled.download.error, null);
      assert.ok(!client.installed.has('gemma3:4b'));
      mgr.downloadModel('gemma3:1b'); // free again
      client.hold = false;
      await settle(mgr, (s) => s.download?.model === 'gemma3:1b' && s.download.state === 'done');
    });

    it('deletes a model for good: it is unloaded, removed, and never downloaded again by the automatic setup', async () => {
      const { mgr, client } = make();
      await mgr.planModels();
      await mgr.run();
      assert.deepEqual(await mgr.deleteModel('qwen3.5:4b'), { deleted: 'qwen3.5:4b' });
      assert.ok(!client.installed.has('qwen3.5:4b'));
      assert.ok(client.calls.some(([c, m]) => c === 'unload' && m === 'qwen3.5:4b'));
      assert.equal(mgr.snapshot().models.text.state, 'removed');

      const before = client.calls.filter(([c]) => c === 'pull').length;
      assert.equal(await mgr.run(), 'ready');
      assert.equal(client.calls.filter(([c]) => c === 'pull').length, before, 'the deleted model was not pulled again');

      // Asking for it again by name undoes that choice.
      mgr.downloadModel('qwen3.5:4b');
      await settle(mgr, (s) => s.download?.model === 'qwen3.5:4b' && s.download.state === 'done');
      assert.ok(client.installed.has('qwen3.5:4b'));
    });

    it('says plainly when a model cannot be deleted: not installed, engine off, or the engine refused', async () => {
      const { mgr, client } = make();
      await mgr.planModels();
      await mgr.run();
      await assert.rejects(mgr.deleteModel('nothing:1b'), (e) => e.status === 404 && /not installed/.test(e.message));
      client.removeStrict = async () => { throw new Error('file is in use'); };
      await assert.rejects(mgr.deleteModel('qwen3.5:4b'), (e) => e.status === 502 && /file is in use/.test(e.message));
      client.up = false;
      await assert.rejects(mgr.deleteModel('qwen3.5:4b'), (e) => e.status === 409 && /Start the local AI engine/.test(e.message));
    });

    it('installs, starts and stops the engine on request, remembering whether it should run at the next start', async () => {
      const { mgr, rt, started, stopped } = make({ auto: false });
      assert.equal(mgr.engineWanted, false);
      mgr.installEngine();
      await settle(mgr, (s) => s.engineTask?.state === 'done');
      assert.equal(rt.installs, 1);
      assert.equal(started.length, 1);
      assert.equal(mgr.engineWanted, true);

      mgr.stopEngine();
      await settle(mgr, (s) => s.engineTask?.action === 'stop' && s.engineTask.state === 'done');
      assert.equal(stopped.length, 1);
      assert.equal(mgr.engineWanted, false, 'stopped by the person: it stays off at the next start');
      assert.equal((await mgr.engineState()).running, false);

      mgr.startEngine();
      await settle(mgr, (s) => s.engineTask?.action === 'start' && s.engineTask.state === 'done');
      assert.equal((await mgr.engineState()).running, true);
    });

    it('will not stop an engine AgencyOS did not start, and starting one that is not installed says to install it', async () => {
      const external = make({ auto: false });
      external.client.up = true; // someone else's Ollama
      external.mgr.stopEngine();
      const failed = await settle(external.mgr, (s) => s.engineTask?.state === 'failed');
      assert.match(failed.engineTask.error, /outside AgencyOS/);

      const bare = make({ auto: false });
      bare.mgr.startEngine();
      const noEngine = await settle(bare.mgr, (s) => s.engineTask?.state === 'failed');
      assert.match(noEngine.engineTask.error, /not installed/);
    });

    it('tries a model: a text model answers with its speed, an embedding model returns a vector', async () => {
      const { mgr } = make();
      await mgr.planModels();
      await mgr.run();
      const text = await mgr.tryModel('qwen3.5:4b');
      assert.equal(text.ok, true);
      assert.equal(text.kind, 'text');
      assert.ok(text.tokensPerSecond > 0);
      const embed = await mgr.tryModel('embeddinggemma');
      assert.deepEqual({ ok: embed.ok, kind: embed.kind, dimensions: embed.dimensions }, { ok: true, kind: 'embedding', dimensions: 768 });
    });
  });
});
