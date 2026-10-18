import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectModels,
  memoryBudget,
  lowerTier,
  judgeSpeed,
  STACK_RESERVE_GB,
  TEXT_TIERS,
  EMBEDDING_MODELS,
} from '../lib/models.mjs';

const machine = ({ ram = 16, threads = 8, gpus = [], free = 100 } = {}) => ({
  ramGB: ram,
  cpu: { threads },
  gpus,
  disk: { freeGB: free },
});
const nvidia = (vramGB, name = 'NVIDIA GeForce RTX') => ({ vendor: 'nvidia', name, vramGB });
const textId = (plan) => plan.text?.candidates[0].id ?? null;
const embedId = (plan) => plan.embedding?.[0].id ?? null;

describe('model selection by hardware', () => {
  it('GitHub-sized runner (16 GB, 4 threads, no GPU) gets Qwen 3.5 2B and EmbeddingGemma', () => {
    const plan = selectModels(machine({ ram: 16, threads: 4 }));
    assert.equal(plan.tier, 'compact');
    assert.equal(textId(plan), 'qwen3.5:2b');
    assert.equal(embedId(plan), 'embeddinggemma');
    assert.equal(plan.acceleration, 'cpu');
  });

  it('8 GB laptop stays on the light tier, with the small Gemma 3 that fits beside the rest of AgencyOS', () => {
    const plan = selectModels(machine({ ram: 8, threads: 8 }));
    assert.equal(plan.tier, 'light');
    assert.equal(textId(plan), 'gemma3:1b');
  });

  it('a 12 GB laptop with 4 threads gets the compact Qwen 3.5 2B, not the 4B it would swap', () => {
    const plan = selectModels(machine({ ram: 12, threads: 4 }));
    assert.equal(plan.tier, 'compact');
    assert.equal(textId(plan), 'qwen3.5:2b');
  });

  it('a mainstream 16 GB, 8-thread laptop without a GPU gets Qwen 3.5 4B, the default', () => {
    const plan = selectModels(machine({ ram: 16, threads: 8 }));
    assert.equal(plan.tier, 'standard');
    assert.equal(textId(plan), 'qwen3.5:4b');
    assert.deepEqual(plan.text.candidates.slice(1).map((c) => c.id), ['gemma4:e2b', 'gemma3:4b']);
  });

  it('a 32 GB, 16-thread workstation without a GPU gets Qwen 3.5 9B, never a dense 12B+', () => {
    const plan = selectModels(machine({ ram: 32, threads: 16 }));
    assert.equal(plan.tier, 'advanced');
    assert.equal(textId(plan), 'qwen3.5:9b');
  });

  it('a 128 GB CPU-only machine is still capped (large dense models are unusably slow on a CPU)', () => {
    const plan = selectModels(machine({ ram: 128, threads: 32 }));
    assert.equal(plan.tier, 'advanced');
  });

  it('a 24 GB laptop with few threads is not given the 9B model it cannot run comfortably', () => {
    assert.equal(selectModels(machine({ ram: 24, threads: 8 })).tier, 'standard');
  });

  it('uses video memory when an NVIDIA card is present', () => {
    assert.equal(selectModels(machine({ gpus: [nvidia(8)] })).tier, 'plus');
    assert.equal(selectModels(machine({ gpus: [nvidia(12)] })).tier, 'high');
    assert.equal(textId(selectModels(machine({ gpus: [nvidia(16)] }))), 'gemma4:12b');
    assert.equal(textId(selectModels(machine({ gpus: [nvidia(24)], ram: 64 }))), 'gemma4:31b');
    assert.equal(selectModels(machine({ gpus: [nvidia(8)] })).acceleration, 'gpu');
  });

  it('a small NVIDIA card falls back to the CPU rules for the tier it cannot hold', () => {
    const plan = selectModels(machine({ ram: 16, threads: 8, gpus: [nvidia(4)] }));
    assert.equal(plan.tier, 'standard');
  });

  it('a 6 GB NVIDIA card holds Qwen 3.5 4B', () => {
    const plan = selectModels(machine({ ram: 16, threads: 4, gpus: [nvidia(6)] }));
    assert.equal(plan.tier, 'standard');
    assert.equal(textId(plan), 'qwen3.5:4b');
    assert.equal(plan.acceleration, 'gpu');
  });

  it('does not count AMD, Intel or integrated graphics as acceleration', () => {
    const gpus = [{ vendor: 'amd', name: 'Radeon', vramGB: 16 }, { vendor: 'intel', name: 'Iris', vramGB: 1 }];
    const budget = memoryBudget(machine({ ram: 16, gpus }));
    assert.equal(budget.mode, 'cpu');
    assert.equal(budget.budgetGB, 16 - STACK_RESERVE_GB);
  });

  it('with 6-7 GB it installs only the embedding model', () => {
    const plan = selectModels(machine({ ram: 6, threads: 4 }));
    assert.equal(plan.tier, 'minimal');
    assert.equal(plan.text, null);
    assert.equal(embedId(plan), 'embeddinggemma');
  });

  it('with 4-5 GB it falls back to a smaller embedding model', () => {
    const plan = selectModels(machine({ ram: 4, threads: 2 }));
    assert.equal(plan.tier, 'minimal');
    assert.equal(embedId(plan), 'nomic-embed-text');
  });

  it('below 4 GB it installs nothing and says why', () => {
    const plan = selectModels(machine({ ram: 3 }));
    assert.equal(plan.tier, 'none');
    assert.equal(plan.embedding, null);
    assert.match(plan.reasons[0], /3 GB/);
  });
});

describe('disk space', () => {
  it('steps down to a smaller model when the larger one does not fit with the runtime and a margin', () => {
    // standard = 0.58 + 3.1, runtime 3.5, margin 2 -> needs 9.2 GB
    const roomy = selectModels(machine({ ram: 16, threads: 8, free: 11 }));
    assert.equal(roomy.tier, 'standard');
    const tight = selectModels(machine({ ram: 16, threads: 8, free: 8 }));
    assert.equal(tight.tier, 'light');
    assert.ok(tight.reasons.some((r) => /disk space/.test(r)));
  });

  it('needs less room once the runtime is already installed', () => {
    const plan = selectModels(machine({ ram: 16, threads: 8, free: 8 }), { runtimePresent: true });
    assert.equal(plan.tier, 'standard');
  });

  it('installs nothing when no model fits the disk', () => {
    const plan = selectModels(machine({ free: 3 }));
    assert.equal(plan.tier, 'none');
    assert.match(plan.reasons.at(-1), /disk space/);
  });

  it('does not block on an unreadable disk', () => {
    const hw = machine({ ram: 16, threads: 8 });
    hw.disk.freeGB = null;
    assert.equal(selectModels(hw).tier, 'standard');
  });
});

describe('overrides and ceilings', () => {
  it('AGENCYOS_AI=off disables everything', () => {
    const plan = selectModels(machine(), { env: { AGENCYOS_AI: 'off' } });
    assert.equal(plan.tier, 'none');
  });

  it('a person-chosen text model is honoured and flagged', () => {
    const plan = selectModels(machine({ ram: 8 }), { env: { AGENCYOS_TEXT_MODEL: 'qwen3:8b' } });
    assert.equal(plan.tier, 'custom');
    assert.equal(textId(plan), 'qwen3:8b');
    assert.equal(plan.text.minTokensPerSecond, 0);
  });

  it('a person-chosen embedding model goes first, with the defaults behind it', () => {
    const plan = selectModels(machine(), { env: { AGENCYOS_EMBEDDING_MODEL: 'mxbai-embed-large' } });
    assert.equal(embedId(plan), 'mxbai-embed-large');
    assert.ok(plan.embedding.some((m) => m.id === 'embeddinggemma'));
  });

  it('maxTier caps the choice (used after a slow benchmark)', () => {
    const hw = machine({ gpus: [nvidia(16)] });
    assert.equal(selectModels(hw).tier, 'high');
    assert.equal(selectModels(hw, { maxTier: 'standard' }).tier, 'standard');
    assert.equal(selectModels(hw, { maxTier: 'minimal' }).tier, 'minimal');
  });
});

describe('catalog integrity', () => {
  it('every tier lists a fallback chain and sensible thresholds', () => {
    for (const t of TEXT_TIERS) {
      assert.ok(t.candidates.length >= 1, t.tier);
      assert.ok(t.minTokensPerSecond > 0, t.tier);
      assert.ok(t.gpu || t.cpu, `${t.tier} must be reachable on some hardware`);
    }
  });
  it('tiers are ordered best to worst by download size of the first candidate (within the same family generation)', () => {
    const sizes = TEXT_TIERS.map((t) => t.candidates[0].downloadGB);
    for (let i = 1; i < sizes.length; i += 1) assert.ok(sizes[i] <= sizes[i - 1] + 0.001, TEXT_TIERS[i].tier);
  });
  it('EmbeddingGemma is the first-choice embedding model', () => {
    assert.equal(EMBEDDING_MODELS[0].id, 'embeddinggemma');
  });
});

describe('stepping down', () => {
  it('lowerTier walks down to none', () => {
    assert.equal(lowerTier('ultra'), 'max');
    assert.equal(lowerTier('advanced'), 'plus');
    assert.equal(lowerTier('standard'), 'compact');
    assert.equal(lowerTier('compact'), 'light');
    assert.equal(lowerTier('light'), 'minimal');
    assert.equal(lowerTier('minimal'), 'none');
    assert.equal(lowerTier('none'), null);
    assert.equal(lowerTier('custom'), null);
  });

  it('judgeSpeed keeps a model that meets its tier threshold and rejects one that does not', () => {
    const plan = selectModels(machine({ ram: 16, threads: 8 }));
    assert.equal(judgeSpeed(plan, 12.5).keep, true);
    const slow = judgeSpeed(plan, 1.2);
    assert.equal(slow.keep, false);
    assert.match(slow.reason, /1\.2 tokens\/s/);
    assert.equal(judgeSpeed(plan, 0).keep, false);
    assert.equal(judgeSpeed(plan, NaN).keep, false);
  });

  it('a custom model is never rejected for being slow', () => {
    const plan = selectModels(machine(), { env: { AGENCYOS_TEXT_MODEL: 'x' } });
    assert.equal(judgeSpeed(plan, 0.3).keep, true);
  });
});
