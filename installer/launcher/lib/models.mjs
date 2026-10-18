// Chooses which local AI models to install for the machine in front of us.
//
// Two jobs, both optional for the product (the app falls back to keyword search and
// template copy when no model answers):
//   * embeddings for the knowledge base  -> EmbeddingGemma (Google), with smaller fallbacks
//   * copy suggestions                   -> Qwen 3.5 (2B, 4B or 9B by memory and processor), Gemma 4 for graphics cards
//                                            that hold it, and the small Gemma 3 where little memory is left
//
// The sizes below were read from registry.ollama.ai (download size of the tag, Q4_K_M unless
// stated). They are used for planning only: the real size is read from the registry again
// before anything is downloaded, and a tag that no longer exists falls through to the next
// candidate. Nothing here is a promise about speed; installer/launcher/lib/ai.mjs measures
// the real generation speed afterwards and steps down a tier if the machine is too slow.

/** RAM kept for Windows, the browser and the AgencyOS services (Postgres, Redis, Temporal, 3 Node processes). */
export const STACK_RESERVE_GB = 5.5;

/** Weights are loaded into memory plus a context cache and buffers. */
const runtimeNeedGB = (downloadGB) => Math.round((downloadGB * 1.1 + 0.8) * 10) / 10;

export const EMBEDDING_MODELS = [
  { id: 'embeddinggemma', label: 'EmbeddingGemma 300M', downloadGB: 0.58, minRamGB: 6, dims: 768 },
  { id: 'nomic-embed-text', label: 'Nomic Embed Text', downloadGB: 0.26, minRamGB: 4, dims: 768 },
  { id: 'all-minilm', label: 'all-MiniLM', downloadGB: 0.04, minRamGB: 3, dims: 384 },
];

/**
 * Best first. `gpu.minVramGB` applies to an NVIDIA card; `cpu` applies when running on the
 * processor. A tier without `cpu` is never chosen without a suitable GPU: a dense model that
 * large is unusably slow on a laptop processor.
 */
export const TEXT_TIERS = [
  {
    tier: 'ultra',
    label: 'Maximum quality',
    candidates: [{ id: 'gemma4:31b', downloadGB: 18.99 }, { id: 'gemma4:26b', downloadGB: 17.44 }],
    gpu: { minVramGB: 24 },
    minTokensPerSecond: 6,
  },
  {
    tier: 'max',
    label: 'High quality (large)',
    candidates: [{ id: 'gemma4:26b', downloadGB: 17.44 }, { id: 'gemma4:12b', downloadGB: 7.47 }],
    gpu: { minVramGB: 20 },
    minTokensPerSecond: 6,
  },
  {
    tier: 'high',
    label: 'High quality',
    candidates: [{ id: 'gemma4:12b', downloadGB: 7.47 }, { id: 'gemma4:e4b', downloadGB: 6.13 }],
    gpu: { minVramGB: 10 },
    minTokensPerSecond: 6,
  },
  {
    // For computers with plenty of memory and no strong graphics card: Qwen 3.5 9B.
    tier: 'advanced',
    label: 'Advanced',
    candidates: [{ id: 'qwen3.5:9b', downloadGB: 6.6 }, { id: 'gemma4:e4b', downloadGB: 6.13 }, { id: 'gemma4:e2b', downloadGB: 4.27 }],
    gpu: { minVramGB: 9 },
    cpu: { minRamGB: 24, minThreads: 12 },
    minTokensPerSecond: 4,
  },
  {
    // What an 8 GB graphics card can hold completely.
    tier: 'plus',
    label: 'Enhanced',
    candidates: [{ id: 'gemma4:e4b', downloadGB: 6.13 }, { id: 'gemma4:e2b', downloadGB: 4.27 }],
    gpu: { minVramGB: 8 },
    minTokensPerSecond: 5,
  },
  {
    // The default for an ordinary laptop: Qwen 3.5 4B.
    tier: 'standard',
    label: 'Balanced',
    candidates: [
      { id: 'qwen3.5:4b', downloadGB: 3.1 },
      { id: 'gemma4:e2b', downloadGB: 4.27 },
      { id: 'gemma3:4b', downloadGB: 3.12 },
    ],
    gpu: { minVramGB: 6 },
    cpu: { minRamGB: 12, minThreads: 6 },
    minTokensPerSecond: 4,
  },
  {
    // Fewer processor threads or less memory than Balanced wants: Qwen 3.5 2B.
    tier: 'compact',
    label: 'Compact',
    candidates: [{ id: 'qwen3.5:2b', downloadGB: 2.5 }, { id: 'gemma3:1b', downloadGB: 0.75 }, { id: 'llama3.2:1b', downloadGB: 1.23 }],
    cpu: { minRamGB: 10, minThreads: 4 },
    minTokensPerSecond: 3,
  },
  {
    tier: 'light',
    label: 'Light',
    candidates: [{ id: 'gemma3:1b', downloadGB: 0.75 }, { id: 'llama3.2:1b', downloadGB: 1.23 }],
    gpu: { minVramGB: 4 },
    cpu: { minRamGB: 8, minThreads: 2 },
    minTokensPerSecond: 3,
  },
];

const TIER_ORDER = ['none', 'minimal', ...TEXT_TIERS.map((t) => t.tier).reverse()];

/** Where model weights would live: the best NVIDIA card, otherwise system memory. */
export function memoryBudget(hw) {
  const nvidia = (hw.gpus || [])
    .filter((g) => g.vendor === 'nvidia' && (g.vramGB || 0) >= 4)
    .sort((a, b) => b.vramGB - a.vramGB)[0];
  if (nvidia) {
    return { mode: 'gpu', gpu: nvidia, budgetGB: Math.max(0, Math.round((nvidia.vramGB - 0.5) * 10) / 10) };
  }
  const ram = hw.ramGB || 0;
  return { mode: 'cpu', gpu: null, budgetGB: Math.max(0, Math.round((ram - STACK_RESERVE_GB) * 10) / 10) };
}

function pickEmbedding(hw, forced) {
  const ram = hw.ramGB || 0;
  const usable = EMBEDDING_MODELS.filter((m) => ram >= m.minRamGB);
  const list = forced
    ? [{ id: forced, label: forced, downloadGB: 0.6, forced: true }, ...usable.filter((m) => m.id !== forced)]
    : usable;
  return list.length ? list : null;
}

function tierFits(t, hw, budget) {
  const need = runtimeNeedGB(t.candidates[0].downloadGB);
  const threads = hw.cpu?.threads || 0;
  if (budget.mode === 'gpu' && t.gpu && budget.gpu.vramGB >= t.gpu.minVramGB && need <= budget.budgetGB) return true;
  // A tier that needs a GPU is skipped on a processor; lower tiers also run on a weaker GPU
  // by spilling to system memory, so the processor rules apply to them as well.
  if (t.cpu) {
    return (hw.ramGB || 0) >= t.cpu.minRamGB && threads >= t.cpu.minThreads && need <= Math.max(0, (hw.ramGB || 0) - STACK_RESERVE_GB);
  }
  return false;
}

const sumDownload = (list) => (list || []).slice(0, 1).reduce((n, m) => n + m.downloadGB, 0);

/**
 * @param hw        result of detectHardware()
 * @param opts.env  AGENCYOS_AI=off|auto, AGENCYOS_TEXT_MODEL, AGENCYOS_EMBEDDING_MODEL
 * @param opts.runtimePresent  the Ollama runtime is already on disk (no 1.5 GB download needed)
 * @param opts.maxTier  never choose a tier above this one (used after a slow benchmark)
 */
export function selectModels(hw, { env = {}, runtimePresent = false, maxTier = null } = {}) {
  const reasons = [];
  const budget = memoryBudget(hw);
  const ram = hw.ramGB || 0;
  const free = hw.disk?.freeGB;
  const diskKnown = typeof free === 'number';
  const base = { acceleration: budget.mode, budgetGB: budget.budgetGB, gpu: budget.gpu };

  const off = String(env.AGENCYOS_AI || '').toLowerCase();
  if (off === 'off' || off === 'false' || off === '0') {
    return { ...base, tier: 'none', label: 'Off', embedding: null, text: null, downloadGB: 0, reasons: ['Local AI is switched off (AGENCYOS_AI=off).'] };
  }
  if (ram < 4) {
    return { ...base, tier: 'none', label: 'Off', embedding: null, text: null, downloadGB: 0, reasons: [`Only ${ram} GB of memory: local AI is skipped so the rest of AgencyOS stays fast. Keyword search and template copy are used instead.`] };
  }

  const runtimeGB = runtimePresent ? 0 : 3.5; // zip + extracted files exist side by side briefly
  const MARGIN_GB = 2;
  const fitsDisk = (gb) => !diskKnown || free >= gb + runtimeGB + MARGIN_GB;

  const embedding = pickEmbedding(hw, env.AGENCYOS_EMBEDDING_MODEL);
  const embeddingGB = sumDownload(embedding);

  // A forced text model bypasses the hardware rules; it is still downloaded and measured.
  if (env.AGENCYOS_TEXT_MODEL) {
    const forced = { id: env.AGENCYOS_TEXT_MODEL, downloadGB: 0 };
    reasons.push(`Text model set by you: ${forced.id}.`);
    return { ...base, tier: 'custom', label: 'Chosen by you', embedding, text: { tier: 'custom', candidates: [forced], minTokensPerSecond: 0 }, downloadGB: embeddingGB, reasons };
  }

  const ceiling = maxTier ? TIER_ORDER.indexOf(maxTier) : TIER_ORDER.length;
  let chosen = null;
  for (const t of TEXT_TIERS) {
    if (TIER_ORDER.indexOf(t.tier) > ceiling) continue;
    if (!tierFits(t, hw, budget)) continue;
    if (!fitsDisk(embeddingGB + t.candidates[0].downloadGB)) {
      reasons.push(`Not enough free disk space for the "${t.label}" model (${t.candidates[0].downloadGB.toFixed(1)} GB); trying a smaller one.`);
      continue;
    }
    chosen = t;
    break;
  }

  if (chosen) {
    const where = budget.mode === 'gpu' ? `${budget.gpu.name} (${budget.gpu.vramGB} GB video memory)` : `${ram} GB memory, ${hw.cpu?.threads || '?'} processor threads`;
    reasons.push(`${chosen.label} text model ${chosen.candidates[0].id} fits ${where}.`);
    return {
      ...base,
      tier: chosen.tier,
      label: chosen.label,
      embedding,
      text: chosen,
      downloadGB: Math.round((embeddingGB + chosen.candidates[0].downloadGB) * 100) / 100,
      reasons,
    };
  }

  // No text model fits: embeddings only (a few hundred MB) if there is room for them.
  if (embedding && fitsDisk(embeddingGB)) {
    reasons.push(
      budget.mode === 'cpu' && ram < 8
        ? `With ${ram} GB of memory only the small embedding model is installed; copy suggestions use templates.`
        : 'No text model fits this machine comfortably; only the embedding model is installed.'
    );
    return { ...base, tier: 'minimal', label: 'Search only', embedding, text: null, downloadGB: embeddingGB, reasons };
  }

  reasons.push('Not enough free disk space for any local model; AgencyOS works without AI.');
  return { ...base, tier: 'none', label: 'Off', embedding: null, text: null, downloadGB: 0, reasons };
}

/** The tier directly below `tier` (used when the measured speed is too low), or null. */
export function lowerTier(tier) {
  const i = TIER_ORDER.indexOf(tier);
  return i > 1 ? TIER_ORDER[i - 1] : i === 1 ? 'none' : null;
}

/**
 * Decide, from a measured generation speed, whether to keep the model.
 * @returns {{ keep: boolean, reason: string }}
 */
export function judgeSpeed(plan, tokensPerSecond) {
  const min = plan?.text?.minTokensPerSecond ?? 0;
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) {
    return { keep: false, reason: 'The model produced no measurable output.' };
  }
  if (tokensPerSecond < min) {
    return { keep: false, reason: `Measured ${tokensPerSecond.toFixed(1)} tokens/s, below the ${min} tokens/s this tier needs to feel responsive.` };
  }
  return { keep: true, reason: `Measured ${tokensPerSecond.toFixed(1)} tokens/s.` };
}
