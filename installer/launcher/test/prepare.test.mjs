import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareComputer } from '../lib/prepare.mjs';
import { CliTools } from '../lib/cli-tools.mjs';

let dir;
let paths;
const lines = [];

const runtime = ({ installed = false, fail = null } = {}) => {
  const r = {
    installed,
    version: installed ? 'v0.40.3' : null,
    calls: [],
    async install(hw, { onProgress }) {
      r.calls.push(hw);
      if (fail) throw new Error(fail);
      onProgress({ received: 100, total: 1000 });
      onProgress({ received: 560, total: 1000 });
      onProgress({ received: 1000, total: 1000 });
      r.installed = true;
      r.version = 'v0.40.3';
    },
  };
  return r;
};

const cli = (over = {}) => {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  return new CliTools({
    env: { PATH: bin, HOME: dir },
    platform: 'linux',
    extraDirs: [bin],
    install: async (id) => {
      fs.writeFileSync(path.join(bin, id === 'antigravity' ? 'agy' : id), '#!/bin/sh\necho "agy 1.4.0"\n', { mode: 0o755 });
    },
    ...over,
  });
};

const prepare = (over = {}) =>
  prepareComputer({
    paths,
    manifest: { ollama: { version: 'v0.40.3' } },
    log: () => {},
    say: (l) => lines.push(l),
    detect: async () => ({ platform: 'win32', gpus: [] }),
    tools: cli(),
    ...over,
  });

describe('preparing a new computer', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agencyos-prep-'));
    paths = { data: { ollamaApp: path.join(dir, 'ollama', 'app'), ollamaModels: path.join(dir, 'ollama', 'models'), config: path.join(dir, 'config') } };
    lines.length = 0;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('downloads the engine and installs Antigravity, saying how far it is, and records the result', async () => {
    const r = runtime();
    const result = await prepare({ makeRuntime: () => r });
    assert.deepEqual(result.ollama, { ok: true, version: 'v0.40.3' });
    assert.equal(result.antigravity.ok, true);
    assert.equal(r.calls.length, 1);
    assert.ok(lines.some((l) => /Downloading the local AI engine/.test(l)));
    assert.ok(lines.some((l) => /Local AI engine: 50% \(0 of 0 MB\)|Local AI engine: 55%/.test(l)));
    assert.ok(lines.some((l) => /Local AI engine: 100%/.test(l)));
    const saved = JSON.parse(fs.readFileSync(path.join(paths.data.config, 'prepare.json'), 'utf8'));
    assert.equal(saved.ollama.ok, true);
    assert.equal(saved.antigravity.ok, true);
  });

  it('downloads nothing that is already there', async () => {
    const r = runtime({ installed: true });
    const tools = cli();
    await tools.installImpl('antigravity');
    const result = await prepare({ makeRuntime: () => r, tools });
    assert.equal(r.calls.length, 0);
    assert.equal(result.ollama.already, true);
    assert.equal(result.antigravity.already, true);
  });

  it('never stops the installation: a failed download is reported and the other part still runs', async () => {
    const result = await prepare({ makeRuntime: () => runtime({ fail: 'checksum mismatch' }) });
    assert.equal(result.ollama.ok, false);
    assert.match(result.ollama.error, /checksum mismatch/);
    assert.equal(result.antigravity.ok, true);
    assert.ok(lines.some((l) => /could not be downloaded now.*Settings/.test(l)));
  });

  it('reports Antigravity’s installer failing without throwing', async () => {
    const tools = cli({ install: async () => Promise.reject(new Error('The Antigravity CLI installer stopped: 403')) });
    const result = await prepare({ makeRuntime: () => runtime(), tools });
    assert.equal(result.ollama.ok, true);
    assert.equal(result.antigravity.ok, false);
    assert.match(result.antigravity.error, /installer stopped: 403/);
  });

  it('leaves out the parts it is told to skip', async () => {
    const r = runtime();
    const result = await prepare({ makeRuntime: () => r, skip: ['ollama', 'antigravity'] });
    assert.deepEqual(result.ollama, { ok: true, skipped: true });
    assert.deepEqual(result.antigravity, { ok: true, skipped: true });
    assert.equal(r.calls.length, 0);
  });
});
