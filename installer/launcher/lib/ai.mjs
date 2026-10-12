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
import { selectModels, lowerTier, judgeSpeed } from './models.mjs';
import { OllamaClient, OllamaRuntime, registryInfo, tokensPerSecond, waitForOllama } from './ollama.mjs';
import { sleep } from './net.mjs';

const RETRY_MS = 5 * 60 * 1000;

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
    this.log = log;
    this.detect = detect;
    this.registry = registry;
    this.client = makeClient(ollamaHost);
    this.runtime = makeRuntime({ dir: paths.data.ollamaApp, manifest: runtimeManifest, log });
    this.sleep = sleepFn;
    this.hw = null;
    this.plan = null;
    this.state = this.#load();
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
    };
    this.stopped = false;
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
    while (!this.stopped) {
      try {
        const outcome = await this.#once();
        if (outcome === 'retry-now') continue; // stepped down a tier: set up the lighter model straight away
        return outcome;
      } catch (error) {
        this.log(`AI setup: ${error.message}`);
        this.#set({
          phase: error.network ? 'waiting-network' : 'error',
          message: error.network
            ? 'Waiting for an internet connection to download the AI models. AgencyOS works without them meanwhile.'
            : `AI setup stopped: ${error.message}`,
          progress: null,
        });
      }
      await this.sleep(RETRY_MS);
    }
    return 'stopped';
  }

  async #once() {
    if (!this.plan) await this.planModels();
    const plan = this.plan;
    if (plan.tier === 'none' || (!plan.embeddingModel && !plan.textModel)) {
      this.#set({ phase: 'off', message: plan.reasons.at(-1) || 'Local AI is off', progress: null });
      return 'off';
    }

    await this.#ensureServer();

    if (plan.embeddingModel) await this.#ensureModel('embedding', plan.embeddingModel);
    if (plan.textModel) {
      await this.#ensureModel('text', plan.textModel);
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

  async #ensureModel(kind, id) {
    if (await this.client.has(id)) {
      this.#setModel(kind, { state: 'ready', id });
      return;
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
      error.network = /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|timeout|network|dial tcp|no such host|i\/o/i.test(error.message);
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
