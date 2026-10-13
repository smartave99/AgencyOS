// Sets up local AI without the person doing anything: looks at the hardware, picks models,
// installs the Ollama runtime if it is missing, downloads the models, checks that they really
// answer, measures the speed, and steps down to a lighter model if the machine is too slow.
//
// The app never waits for this. It starts with the chosen model names in its environment;
// until a model is downloaded the app's own fallbacks (keyword search, template copy) apply.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { detectHardware } from './hardware.mjs';
import { selectModels, lowerTier, judgeSpeed, EMBEDDING_MODELS, TEXT_TIERS } from './models.mjs';
import { OllamaClient, OllamaRuntime, registryInfo, sameModel, tokensPerSecond, validModelName, waitForOllama } from './ollama.mjs';
import { sleep } from './net.mjs';

// A failed download is retried quickly at first (a registry hiccup, a dropped connection) and then
// every five minutes.
const RETRY_DELAYS_MS = [20_000, 45_000, 90_000, 180_000, 5 * 60 * 1000];
const TRANSIENT = /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|timeout|network|dial tcp|no such host|i\/o|\b5\d\d\b|\b429\b|rate limit|temporar|unavailable|reset/i;

export const fingerprint = (hw) =>
  JSON.stringify([
    Math.round(hw.ramGB || 0),
    hw.cpu?.threads || 0,
    hw.arch,
    (hw.gpus || []).filter((g) => g.vendor === 'nvidia').map((g) => `${g.name}:${Math.round(g.vramGB || 0)}`),
  ]);

const BENCH_PROMPT =
  'Write three short advertising headlines for a neighbourhood bakery. Reply only as JSON: {"headlines":["...","...","..."]}';

export class AiManager extends EventEmitter {
  constructor({
    paths,
    hostEnv = process.env,
    userEnv = () => ({}),
    ollamaHost,
    runtimeManifest = null,
    startOllama = async () => {},
    stopOllama = async () => {},
    log = () => {},
    detect = detectHardware,
    registry = registryInfo,
    makeClient = (host) => new OllamaClient({ host }),
    makeRuntime = (opts) => new OllamaRuntime(opts),
    sleepFn = sleep,
  }) {
    super();
    this.paths = paths;
    this.hostEnv = hostEnv;
    this.userEnv = userEnv;
    this.host = ollamaHost;
    this.runtimeManifest = runtimeManifest;
    this.startOllama = startOllama;
    this.stopOllama = stopOllama;
    this.log = log;
    this.detect = detect;
    this.registry = registry;
    this.client = makeClient(ollamaHost);
    this.runtime = makeRuntime({ dir: paths.data.ollamaApp, manifest: runtimeManifest, log });
    this.sleep = sleepFn;
    this.hw = null;
    this.plan = null;
    this.state = this.#load();
    // Decided once. An install that already set local AI up keeps it automatic; a new install starts
    // with nothing downloaded, because the Antigravity CLI answers until someone wants a local model.
    // An engine that setup itself put in place (it leaves prepare.json) is not a sign anyone wanted
    // local AI: only a plan, or an engine on an install setup never prepared, counts as earlier use.
    const preparedBySetup = fs.existsSync(path.join(paths.data.config, 'prepare.json'));
    if (typeof this.state.auto !== 'boolean') {
      this.state.auto = !!(this.state.plan || (this.runtime.installed && !preparedBySetup));
    }
    this.manual = null; // the download the person asked for: { model, controller }
    this.status = {
      phase: 'idle',
      message: 'Waiting to start',
      progress: null,
      external: false,
      runtime: null,
      tier: this.state.plan?.tier || null,
      label: this.state.plan?.label || null,
      models: this.#modelStatus(this.state.plan),
      reasons: this.state.plan?.reasons || [],
      benchmark: this.state.benchmark || null,
      hardware: this.state.hardware || null,
      auto: this.state.auto,
      download: null,
    };
    this.stopped = false;
  }

  /** Whether AgencyOS sets up and starts local AI by itself. Off for a new install. */
  get auto() {
    return this.state.auto === true;
  }

  /** Whether the engine should be running at start: automatic setup, or the person last started it. */
  get engineWanted() {
    return this.auto || this.state.engineWanted === true;
  }

  setAuto(enabled) {
    this.state.auto = enabled === true;
    this.#save();
    this.#set({ auto: this.state.auto, ...(this.state.auto ? {} : this.#standby()) });
    if (!this.state.auto) this.stop();
    return this.state.auto;
  }

  #standby() {
    return {
      phase: 'standby',
      message: 'Local AI is off. Turn it on, or download a model yourself, to use one on this computer.',
      progress: null,
    };
  }

  // ---- persistence ---------------------------------------------------------------------

  #load() {
    try {
      return JSON.parse(fs.readFileSync(this.paths.data.aiState, 'utf8'));
    } catch {
      return { version: 1, maxTier: null, plan: null, benchmark: null, hardware: null };
    }
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.paths.data.aiState), { recursive: true });
      fs.writeFileSync(this.paths.data.aiState, JSON.stringify(this.state, null, 2));
    } catch (error) {
      this.log(`Could not save AI state: ${error.message}`);
    }
  }

  #modelStatus(plan) {
    return {
      embedding: plan?.embeddingModel ? { id: plan.embeddingModel, state: this.status?.models?.embedding?.state || 'pending' } : null,
      text: plan?.textModel ? { id: plan.textModel, state: this.status?.models?.text?.state || 'pending' } : null,
    };
  }

  #set(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  #setModel(kind, patch) {
    const current = this.status.models[kind] || {};
    this.#set({ models: { ...this.status.models, [kind]: { ...current, ...patch } } });
  }

  // ---- planning (fast; runs before the app starts) -------------------------------------

  /** Environment variables the app reads. Model names are final as soon as planning is done. */
  appEnv() {
    const p = this.state.plan;
    return {
      OLLAMA_HOST: this.host,
      ...(p?.textModel ? { AI_MODEL: p.textModel } : {}),
      ...(p?.embeddingModel ? { EMBEDDING_MODEL: p.embeddingModel } : {}),
    };
  }

  async planModels() {
    this.#set({ phase: 'planning', message: 'Looking at this computer to choose AI models' });
    const runtime = this.runtime;
    const hw = await this.detect({ dataDir: this.paths.data.ollamaModels });
    this.hw = hw;
    runtime.arch = hw.arch; // pick the matching Ollama build (x64 or Windows-on-ARM)
    const external = !!(await this.client.version()) && !runtime.installed;
    const env = { ...this.userEnv(), ...pickAiEnv(this.hostEnv) };
    const fp = fingerprint(hw);

    const cached = this.state.plan;
    if (cached && this.state.fingerprint === fp && this.state.envKey === JSON.stringify(env)) {
      this.plan = cached;
      this.#set({ ...this.#summary(cached), phase: 'planned', message: this.#plannedMessage(cached), hardware: summarizeHardware(hw), external });
      return cached;
    }

    const selected = selectModels(hw, { env, runtimePresent: runtime.installed || external, maxTier: this.state.maxTier });
    const resolved = await this.#resolve(selected);
    this.state = { ...this.state, fingerprint: fp, envKey: JSON.stringify(env), hardware: summarizeHardware(hw), plan: resolved };
    this.#save();
    this.plan = resolved;
    this.#set({ ...this.#summary(resolved), phase: 'planned', message: this.#plannedMessage(resolved), hardware: this.state.hardware, external });
    this.log(`AI plan: tier=${resolved.tier} text=${resolved.textModel || '-'} embedding=${resolved.embeddingModel || '-'}`);
    return resolved;
  }

  #plannedMessage(plan) {
    if (plan.tier === 'none') return plan.reasons.at(-1) || 'Local AI is off';
    const parts = [plan.embeddingModel, plan.textModel].filter(Boolean);
    return `Chosen for this computer: ${parts.join(' + ')}. Downloads start once AgencyOS is running.`;
  }

  #summary(plan) {
    return {
      tier: plan.tier,
      label: plan.label,
      reasons: plan.reasons,
      models: this.#modelStatus(plan),
    };
  }

  /** Picks the first candidate the registry still has (or all of them when the registry is unreachable). */
  async #resolve(selected) {
    const firstAvailable = async (candidates) => {
      for (const c of candidates || []) {
        const info = await this.registry(c.id);
        if (info.exists !== false) return { ...c, sizeGB: info.sizeGB ?? c.downloadGB };
      }
      return null;
    };
    const [embedding, text] = await Promise.all([
      selected.embedding ? firstAvailable(selected.embedding) : null,
      selected.text ? firstAvailable(selected.text.candidates) : null,
    ]);
    const reasons = [...selected.reasons];
    if (selected.text && !text) reasons.push('None of the preferred text models are available from the model registry right now.');
    return {
      tier: text || selected.tier === 'none' ? selected.tier : embedding ? 'minimal' : 'none',
      label: text || selected.tier === 'none' ? selected.label : 'Search only',
      acceleration: selected.acceleration,
      budgetGB: selected.budgetGB,
      reasons,
      embeddingModel: embedding?.id || null,
      textModel: text?.id || null,
      textCandidates: selected.text ? selected.text.candidates.map((c) => c.id) : [],
      minTokensPerSecond: selected.text?.minTokensPerSecond ?? 0,
    };
  }

  // ---- doing the work (background) -----------------------------------------------------

  stop() {
    this.stopped = true;
  }

  async run() {
    this.stopped = false;
    let failures = 0;
    while (!this.stopped) {
      try {
        const outcome = await this.#once();
        if (outcome === 'retry-now') continue; // stepped down a tier: set up the lighter model straight away
        return outcome;
      } catch (error) {
        failures += 1;
        this.log(`AI setup: ${error.message}`);
        this.#set({
          phase: error.network ? 'waiting-network' : 'error',
          message: error.network
            ? 'Waiting for an internet connection to download the AI models. AgencyOS works without them meanwhile.'
            : `AI setup stopped: ${error.message}`,
          progress: null,
        });
      }
      await this.sleep(RETRY_DELAYS_MS[Math.min(failures - 1, RETRY_DELAYS_MS.length - 1)]);
    }
    return 'stopped';
  }

  async #once() {
    if (!this.auto) {
      this.#set(this.#standby());
      return 'standby';
    }
    if (!this.plan) await this.planModels();
    const plan = this.plan;
    if (plan.tier === 'none' || (!plan.embeddingModel && !plan.textModel)) {
      this.#set({ phase: 'off', message: plan.reasons.at(-1) || 'Local AI is off', progress: null });
      return 'off';
    }

    await this.#ensureServer();

    if (plan.embeddingModel) await this.#ensureModel('embedding', plan.embeddingModel);
    if (plan.textModel && (await this.#ensureModel('text', plan.textModel))) {
      const kept = await this.#calibrate(plan);
      if (!kept) return 'retry-now';
    }

    this.#set({ phase: 'ready', message: 'Local AI is ready', progress: null });
    this.emit('ready', this.appEnv());
    return 'ready';
  }

  async #ensureServer() {
    const runtime = this.runtime;
    if (await this.client.version()) {
      this.#set({ runtime: { external: !runtime.installed, version: runtime.version } });
      return;
    }
    if (!runtime.installed) {
      this.#set({ phase: 'installing-runtime', message: 'Downloading the local AI engine (once, about 1.4 GB)' });
      try {
        await runtime.install(this.hw, {
          onProgress: (p) => this.#set({ progress: { ...p, fraction: p.total ? p.received / p.total : 0 } }),
        });
      } catch (error) {
        error.network = !/checksum/i.test(error.message);
        throw error;
      }
      this.#set({ progress: null });
    }
    this.#set({ phase: 'starting', message: 'Starting the local AI engine', runtime: { external: false, version: runtime.version } });
    await this.startOllama(runtime);
    if (!(await waitForOllama(this.client, 90000))) throw new Error('The local AI engine did not start.');
  }

  /** True when the model is there. A model the person deleted is not downloaded again behind their back. */
  async #ensureModel(kind, id) {
    if (await this.client.has(id)) {
      this.#setModel(kind, { state: 'ready', id });
      return true;
    }
    if ((this.state.declined || []).some((d) => sameModel(d, id))) {
      this.#setModel(kind, { state: 'removed', id });
      return false;
    }
    this.#set({ phase: kind === 'embedding' ? 'downloading-embedding' : 'downloading-text', message: `Downloading ${id}` });
    this.#setModel(kind, { state: 'downloading', id });
    const started = Date.now();
    try {
      await this.client.pull(id, (p) => {
        const seconds = Math.max((Date.now() - started) / 1000, 1);
        const bps = p.completed / seconds;
        this.#set({ progress: { fraction: p.fraction, received: p.completed, total: p.total, bytesPerSecond: bps, model: id } });
        this.#setModel(kind, { state: 'downloading', id, fraction: p.fraction });
      });
    } catch (error) {
      this.#setModel(kind, { state: 'failed', id, error: error.message });
      error.network = TRANSIENT.test(error.message);
      throw error;
    }
    if (kind === 'embedding') {
      const vectors = await this.client.embed(id, ['AgencyOS embedding check']);
      if (!vectors[0]?.length) throw new Error(`${id} downloaded but did not return an embedding.`);
      this.#setModel(kind, { state: 'ready', id, dimensions: vectors[0].length });
    } else {
      this.#setModel(kind, { state: 'ready', id });
    }
    this.#set({ progress: null });
    return true;
  }

  /** Runs a short generation; keeps the model or steps down a tier. Returns true to keep. */
  async #calibrate(plan) {
    if (this.state.benchmark?.model === plan.textModel && this.state.benchmark?.keep) {
      this.#setModel('text', { state: 'ready', tokensPerSecond: this.state.benchmark.tokensPerSecond });
      return true;
    }
    this.#set({ phase: 'checking', message: `Checking that ${plan.textModel} runs well on this computer` });
    let rate = 0;
    let validJson = null;
    try {
      await this.client.generate(plan.textModel, 'Say OK.', { options: { num_predict: 4 } }); // load into memory
      const result = await this.client.generate(plan.textModel, BENCH_PROMPT, {
        format: 'json',
        options: { num_predict: 96, temperature: 0.7 },
      });
      rate = tokensPerSecond(result);
      try {
        validJson = Array.isArray(JSON.parse(result.response).headlines);
      } catch {
        validJson = false;
      }
    } catch (error) {
      this.log(`Benchmark failed for ${plan.textModel}: ${error.message}`);
    }
    const verdict = judgeSpeed({ text: { minTokensPerSecond: plan.minTokensPerSecond } }, rate);
    this.state.benchmark = { model: plan.textModel, tokensPerSecond: Math.round(rate * 10) / 10, validJson, keep: verdict.keep, at: new Date().toISOString(), note: verdict.reason };
    this.#save();
    this.#set({ benchmark: this.state.benchmark });
    this.log(`Benchmark ${plan.textModel}: ${verdict.reason}`);

    if (verdict.keep) {
      this.#setModel('text', { state: 'ready', tokensPerSecond: this.state.benchmark.tokensPerSecond });
      return true;
    }

    const next = lowerTier(plan.tier);
    this.state.maxTier = next;
    await this.client.unload(plan.textModel);
    await this.client.remove(plan.textModel); // give the disk space back
    this.log(`Stepping down from ${plan.tier} to ${next || 'none'}: ${verdict.reason}`);
    const previous = plan.textModel;
    this.plan = null;
    this.state.plan = null;
    const smaller = await this.planModels();
    smaller.reasons.unshift(`${previous} was too slow here (${verdict.reason}) so a lighter model is used.`);
    this.#save();
    this.#set({ reasons: smaller.reasons });
    this.emit('models-changed', this.appEnv());
    return false;
  }

  // ---- what the person can do by hand ----------------------------------------------------
  // Download a model, start or stop the engine, try a model, delete one. Each is a plain action the
  // person asked for: nothing here runs on its own, and a model they delete stays deleted.

  #checkName(model) {
    if (!validModelName(model)) {
      throw Object.assign(new Error('That is not a valid model name. Use a name like gemma3:4b.'), { status: 400 });
    }
    return model.trim();
  }

  #busyError() {
    return Object.assign(new Error('Another local AI action is still running. Wait for it, or cancel the download.'), { status: 409 });
  }

  get #working() {
    return !!this.manual || this.status.engineTask?.state === 'working';
  }

  async engineState() {
    const version = await this.client.version();
    const installed = this.runtime.installed;
    return { installed, running: !!version, version, external: !!version && !installed };
  }

  /** What the models screen shows: the engine, what is installed, what could be downloaded. */
  async models() {
    const engine = await this.engineState();
    let installed = [];
    let listError = null;
    if (engine.running) {
      try {
        installed = await this.client.installedModelDetails();
      } catch (error) {
        listError = error.message;
      }
    }
    const plan = this.state.plan;
    const roleOf = (name) => {
      const roles = [];
      if (plan?.textModel && sameModel(name, plan.textModel)) roles.push('copy');
      if (plan?.embeddingModel && sameModel(name, plan.embeddingModel)) roles.push('search');
      return roles;
    };
    return {
      auto: this.auto,
      engine,
      installed: installed.map((m) => ({ ...m, roles: roleOf(m.name) })),
      listError,
      suggestions: this.suggestions(),
      download: this.status.download || null,
      engineTask: this.status.engineTask || null,
      freeDiskGB: this.hw?.disk?.freeGB ?? this.state.hardware?.freeDiskGB ?? null,
      modelsDir: this.paths.data.ollamaModels,
    };
  }

  /** Recommended first (what the automatic setup would choose), then other sizes. */
  suggestions() {
    const plan = this.state.plan;
    const out = [];
    const seen = new Set();
    const add = (id, label, kind, sizeGB, recommended, note = '') => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ id, label, kind, sizeGB: sizeGB ?? null, recommended, note });
    };
    const sizeOf = (id) => {
      const embedding = EMBEDDING_MODELS.find((m) => m.id === id);
      if (embedding) return embedding.downloadGB;
      for (const tier of TEXT_TIERS) {
        const found = tier.candidates.find((c) => c.id === id);
        if (found) return found.downloadGB;
      }
      return null;
    };
    if (plan?.textModel) add(plan.textModel, 'Recommended for this computer', 'text', sizeOf(plan.textModel), true);
    if (plan?.embeddingModel) add(plan.embeddingModel, 'Recommended for search', 'embedding', sizeOf(plan.embeddingModel), true);
    for (const tier of [...TEXT_TIERS].reverse()) {
      for (const c of tier.candidates) add(c.id, tier.label, 'text', c.downloadGB, false);
    }
    for (const m of EMBEDDING_MODELS) add(m.id, m.label, 'embedding', m.downloadGB, false);
    return out;
  }

  /** Turns the engine on (downloading it first if it is missing). Returns at once; progress is in the status. */
  installEngine() {
    return this.#engineTask('install', async () => {
      await this.#ensureServer();
      this.state.engineWanted = true;
      this.#save();
    });
  }

  startEngine() {
    return this.#engineTask('start', async () => {
      if (!this.runtime.installed && !(await this.client.version())) {
        throw new Error('The local AI engine is not installed yet. Install it first.');
      }
      await this.#ensureServer();
      this.state.engineWanted = true;
      this.#save();
    });
  }

  stopEngine() {
    return this.#engineTask('stop', async () => {
      if (!this.runtime.installed && (await this.client.version())) {
        throw new Error('This engine was started outside AgencyOS, so AgencyOS cannot stop it.');
      }
      this.manual?.controller.abort();
      await this.stopOllama();
      this.state.engineWanted = false;
      this.#save();
    });
  }

  #engineTask(action, work) {
    if (this.#working) throw this.#busyError();
    const labels = { install: 'Setting up the local AI engine', start: 'Starting the local AI engine', stop: 'Stopping the local AI engine' };
    this.#set({ engineTask: { action, state: 'working', message: labels[action] } });
    work()
      .then(() => this.#set({ engineTask: { action, state: 'done', message: '' }, progress: null, ...(this.auto ? {} : this.#standby()) }))
      .catch((error) => {
        this.log(`Local AI engine (${action}): ${error.message}`);
        this.#set({ engineTask: { action, state: 'failed', message: '', error: error.message }, progress: null });
      });
    return { started: true };
  }

  /** Downloads one model the person chose. Returns at once; progress is in the status. */
  downloadModel(model) {
    const id = this.#checkName(model);
    if (this.#working) throw this.#busyError();
    this.state.declined = (this.state.declined || []).filter((d) => !sameModel(d, id));
    this.#save();
    const controller = new AbortController();
    this.manual = { model: id, controller };
    const started = Date.now();
    const progress = (patch) => this.#set({ download: { model: id, state: 'downloading', fraction: 0, received: 0, total: 0, ...patch } });
    progress({ state: 'starting' });
    (async () => {
      try {
        await this.#ensureServer();
        await this.client.pull(
          id,
          (p) => {
            const seconds = Math.max((Date.now() - started) / 1000, 1);
            progress({ fraction: p.fraction, received: p.completed, total: p.total, bytesPerSecond: p.completed / seconds });
          },
          { signal: controller.signal }
        );
        this.#set({ download: { model: id, state: 'done', fraction: 1 }, progress: null });
        this.log(`Downloaded ${id}`);
      } catch (error) {
        const cancelled = controller.signal.aborted;
        if (!cancelled) this.log(`Download of ${id} failed: ${error.message}`);
        this.#set({ download: { model: id, state: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : error.message }, progress: null });
      } finally {
        this.manual = null;
        if (!this.auto) this.#set(this.#standby());
      }
    })();
    return { started: true };
  }

  cancelDownload() {
    if (!this.manual) return { cancelled: false };
    this.manual.controller.abort();
    return { cancelled: true };
  }

  async deleteModel(model) {
    const id = this.#checkName(model);
    if (this.manual && sameModel(this.manual.model, id)) throw this.#busyError();
    if (!(await this.client.version())) {
      throw Object.assign(new Error('Start the local AI engine first: models are deleted through it.'), { status: 409 });
    }
    if (!(await this.client.has(id))) throw Object.assign(new Error(`${id} is not installed.`), { status: 404 });
    await this.client.unload(id);
    try {
      await this.client.removeStrict(id);
    } catch (error) {
      throw Object.assign(new Error(`${id} could not be deleted: ${error.message}`), { status: 502 });
    }
    if (await this.client.has(id)) throw Object.assign(new Error(`${id} could not be deleted.`), { status: 502 });
    // Remembered, so the automatic setup never puts it back without being asked.
    this.state.declined = [...(this.state.declined || []).filter((d) => !sameModel(d, id)), id];
    this.#save();
    for (const kind of ['text', 'embedding']) {
      if (this.status.models[kind] && sameModel(this.status.models[kind].id || '', id)) this.#setModel(kind, { state: 'removed' });
    }
    this.log(`Deleted ${id}`);
    return { deleted: id };
  }

  /** Runs the model once and reports whether it answers and how fast. */
  async tryModel(model) {
    const id = this.#checkName(model);
    if (!(await this.client.version())) {
      throw Object.assign(new Error('Start the local AI engine first.'), { status: 409 });
    }
    const started = Date.now();
    try {
      if (/embed/i.test(id) || sameModel(id, this.state.plan?.embeddingModel || '')) {
        const vectors = await this.client.embed(id, ['AgencyOS test']);
        if (!vectors[0]?.length) return { ok: false, error: `${id} did not return an embedding.` };
        return { ok: true, kind: 'embedding', dimensions: vectors[0].length, seconds: (Date.now() - started) / 1000 };
      }
      const result = await this.client.generate(id, 'Reply with the single word OK.', { options: { num_predict: 24 }, timeoutMs: 180000 });
      return {
        ok: true,
        kind: 'text',
        sample: String(result.response || '').trim().slice(0, 120),
        tokensPerSecond: Math.round(tokensPerSecond(result) * 10) / 10,
        seconds: Math.round(((Date.now() - started) / 1000) * 10) / 10,
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.status));
  }
}

function pickAiEnv(env) {
  const out = {};
  for (const k of ['AGENCYOS_AI', 'AGENCYOS_TEXT_MODEL', 'AGENCYOS_EMBEDDING_MODEL']) if (env[k]) out[k] = env[k];
  return out;
}

export function summarizeHardware(hw) {
  const gpu = (hw.gpus || []).filter((g) => g.vendor !== 'virtual').sort((a, b) => (b.vramGB || 0) - (a.vramGB || 0))[0];
  return {
    os: hw.osName,
    arch: hw.arch,
    cpu: hw.cpu?.name || null,
    threads: hw.cpu?.threads || null,
    ramGB: hw.ramGB,
    gpu: gpu ? `${gpu.name}${gpu.vramGB ? ` (${gpu.vramGB} GB)` : ''}` : null,
    freeDiskGB: hw.disk?.freeGB ?? null,
  };
}
