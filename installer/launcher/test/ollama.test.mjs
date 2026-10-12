import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseModelName, sameModel, registryInfo, OllamaClient, OllamaRuntime, tokensPerSecond, folderPrunePlan } from '../lib/ollama.mjs';
import { download, parseContentRange, sha256File } from '../lib/download.mjs';

const ndjson = (objects, { split = 1 } = {}) => {
  const text = objects.map((o) => JSON.stringify(o)).join('\n') + '\n';
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.length / split);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
};

describe('model names', () => {
  it('parses names and compares them with the default tag', () => {
    assert.deepEqual(parseModelName('gemma3:1b'), { name: 'gemma3', tag: '1b' });
    assert.deepEqual(parseModelName('embeddinggemma'), { name: 'embeddinggemma', tag: 'latest' });
    assert.equal(sameModel('embeddinggemma', 'embeddinggemma:latest'), true);
    assert.equal(sameModel('gemma3:1b', 'gemma3:4b'), false);
  });
});

describe('registryInfo', () => {
  const manifest = { layers: [{ size: 1024 ** 3 }, { size: 512 * 1024 ** 2 }] };
  it('sums layer sizes and reports existence', async () => {
    let url;
    const info = await registryInfo('gemma4:e2b', { fetchImpl: async (u) => { url = u; return new Response(JSON.stringify(manifest)); } });
    assert.equal(url, 'https://registry.ollama.ai/v2/library/gemma4/manifests/e2b');
    assert.deepEqual(info, { exists: true, bytes: 1.5 * 1024 ** 3, sizeGB: 1.5 });
  });
  it('tells a removed tag (404) apart from being offline', async () => {
    assert.deepEqual(await registryInfo('nope', { fetchImpl: async () => new Response('', { status: 404 }) }), { exists: false });
    assert.deepEqual(await registryInfo('x', { fetchImpl: async () => { throw new Error('ENOTFOUND'); } }), { exists: null });
    assert.deepEqual(await registryInfo('x', { fetchImpl: async () => new Response('', { status: 503 }) }), { exists: null });
  });
  it('uses the namespace of a user model', async () => {
    let url;
    await registryInfo('someone/model:q4', { fetchImpl: async (u) => { url = u; return new Response(JSON.stringify(manifest)); } });
    assert.match(url, /\/v2\/someone\/model\/manifests\/q4$/);
  });
});

describe('OllamaClient', () => {
  const client = (handler) => new OllamaClient({ host: 'http://127.0.0.1:11434/', fetchImpl: handler });

  it('pull aggregates progress across layers and succeeds on "success"', async () => {
    const events = [];
    const c = client(async () => new Response(ndjson([
      { status: 'pulling manifest' },
      { status: 'pulling a', digest: 'a', total: 100, completed: 10 },
      { status: 'pulling b', digest: 'b', total: 300, completed: 0 },
      { status: 'pulling a', digest: 'a', total: 100, completed: 100 },
      { status: 'pulling b', digest: 'b', total: 300, completed: 150 },
      { status: 'verifying sha256 digest' },
      { status: 'success' },
    ], { split: 5 })));
    await c.pull('m', (p) => events.push(p));
    const last = events.at(-1);
    assert.equal(last.status, 'success');
    assert.equal(last.total, 400);
    assert.equal(last.completed, 250);
    assert.ok(events.some((e) => e.fraction > 0 && e.fraction < 1));
  });

  it('pull throws the server error, and when the stream ends without success', async () => {
    await assert.rejects(client(async () => new Response(ndjson([{ error: 'pull model manifest: file does not exist' }]))).pull('m'), /file does not exist/);
    await assert.rejects(client(async () => new Response(ndjson([{ status: 'pulling manifest' }]))).pull('m'), /ended before it finished/);
    await assert.rejects(client(async () => new Response('boom', { status: 500 })).pull('m'), /could not pull m/);
  });

  it('has() recognises a model with or without the default tag, and is false when Ollama is down', async () => {
    const up = client(async () => new Response(JSON.stringify({ models: [{ name: 'embeddinggemma:latest' }, { name: 'gemma3:1b' }] })));
    assert.equal(await up.has('embeddinggemma'), true);
    assert.equal(await up.has('gemma3:1b'), true);
    assert.equal(await up.has('gemma3:4b'), false);
    assert.equal(await client(async () => { throw new Error('refused'); }).has('x'), false);
  });

  it('version() is null when nothing answers', async () => {
    assert.equal(await client(async () => { throw new Error('refused'); }).version(), null);
    assert.equal(await client(async () => new Response(JSON.stringify({ version: '0.40.3' }))).version(), '0.40.3');
  });

  it('generate asks for no thinking and json when requested; embed returns the vectors', async () => {
    let body;
    const c = client(async (url, init) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify(url.endsWith('/api/embed') ? { embeddings: [[0.1, 0.2]] } : { response: '{}' }));
    });
    await c.generate('m', 'hi', { format: 'json', options: { num_predict: 8 } });
    assert.equal(body.think, false);
    assert.equal(body.format, 'json');
    assert.equal(body.stream, false);
    assert.deepEqual(await c.embed('m', ['x']), [[0.1, 0.2]]);
  });

  it('turns an API error into an exception with the server message', async () => {
    await assert.rejects(client(async () => new Response(JSON.stringify({ error: 'model not found' }), { status: 404 })).embed('m', ['x']), /model not found/);
  });
});

describe('measuring speed', () => {
  it('tokensPerSecond uses eval_count over eval_duration (nanoseconds)', () => {
    assert.equal(tokensPerSecond({ eval_count: 50, eval_duration: 5e9 }), 10);
    assert.equal(tokensPerSecond({}), 0);
    assert.equal(tokensPerSecond({ eval_count: 0, eval_duration: 1 }), 0);
  });
});

describe('Ollama runtime', () => {
  it('drops the GPU libraries nobody can use, and keeps them for an NVIDIA machine', () => {
    assert.deepEqual(folderPrunePlan({ gpus: [] }), ['cuda_v12', 'cuda_v13']);
    assert.deepEqual(folderPrunePlan({ gpus: [{ vendor: 'amd' }] }), ['cuda_v12', 'cuda_v13']);
    assert.deepEqual(folderPrunePlan({ gpus: [{ vendor: 'nvidia' }] }), []);
  });

  it('picks the matching build for x64 and Windows on ARM, preferring the manifest (with checksum)', () => {
    const manifest = { version: 'v0.40.3', assets: { 'win32-x64': { url: 'https://x/amd64.zip', sha256: 'aa' }, 'win32-arm64': { url: 'https://x/arm64.zip', sha256: 'bb' } } };
    const x64 = new OllamaRuntime({ dir: '/o', platform: 'win32', arch: 'x64', manifest });
    assert.deepEqual(x64.asset(), { url: 'https://x/amd64.zip', sha256: 'aa', version: 'v0.40.3' });
    const arm = new OllamaRuntime({ dir: '/o', platform: 'win32', arch: 'x64', hostArch: 'arm64', manifest });
    assert.equal(arm.asset().url, 'https://x/arm64.zip');
    const bare = new OllamaRuntime({ dir: '/o', platform: 'win32', arch: 'x64' });
    assert.match(bare.asset().url, /ollama-windows-amd64\.zip$/);
    assert.equal(new OllamaRuntime({ dir: '/o', platform: 'linux', arch: 'x64' }).asset(), null);
  });

  it('keeps models in the data folder and limits parallel loads on a small machine', () => {
    const r = new OllamaRuntime({ dir: '/o', platform: 'win32' });
    const env = r.serveEnv({ host: '127.0.0.1:11434', modelsDir: 'D:\\models', hw: { ramGB: 8 } });
    assert.equal(env.OLLAMA_MODELS, 'D:\\models');
    assert.equal(env.OLLAMA_HOST, '127.0.0.1:11434');
    assert.equal(env.OLLAMA_MAX_LOADED_MODELS, '1');
    assert.equal(r.serveEnv({ host: 'h', modelsDir: 'm', hw: { ramGB: 32 } }).OLLAMA_MAX_LOADED_MODELS, '2');
  });
});

describe('download', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agencyos-dl-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const payload = Buffer.from('x'.repeat(10000) + 'y'.repeat(10000));
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  const bodyOf = (buf) => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(buf)); c.close(); } });

  it('parses Content-Range', () => {
    assert.deepEqual(parseContentRange('bytes 100-199/1000'), { start: 100, end: 199, total: 1000 });
    assert.equal(parseContentRange('nonsense'), null);
  });

  it('downloads, reports progress, verifies the checksum and moves the file into place', async () => {
    const progress = [];
    const dest = path.join(dir, 'a', 'file.zip');
    await download('http://x/f', dest, {
      sha256: digest,
      onProgress: (p) => progress.push(p),
      fetchImpl: async () => new Response(bodyOf(payload), { headers: { 'content-length': String(payload.length) } }),
    });
    assert.equal(await sha256File(dest), digest);
    assert.equal(fs.existsSync(`${dest}.part`), false);
    assert.equal(progress.at(-1).received, payload.length);
  });

  it('resumes a partial file with a Range request', async () => {
    const dest = path.join(dir, 'f.zip');
    fs.writeFileSync(`${dest}.part`, payload.subarray(0, 12000));
    let range;
    await download('http://x/f', dest, {
      sha256: digest,
      fetchImpl: async (_u, init) => {
        range = init.headers.Range;
        return new Response(bodyOf(payload.subarray(12000)), { status: 206, headers: { 'content-range': `bytes 12000-19999/${payload.length}` } });
      },
    });
    assert.equal(range, 'bytes=12000-');
    assert.equal(await sha256File(dest), digest);
  });

  it('starts over when the server ignores the Range header', async () => {
    const dest = path.join(dir, 'f.zip');
    fs.writeFileSync(`${dest}.part`, Buffer.from('stale-junk'));
    await download('http://x/f', dest, {
      sha256: digest,
      fetchImpl: async () => new Response(bodyOf(payload), { status: 200, headers: { 'content-length': String(payload.length) } }),
    });
    assert.equal(await sha256File(dest), digest);
  });

  it('retries after a network failure', async () => {
    const dest = path.join(dir, 'f.zip');
    let calls = 0;
    await download('http://x/f', dest, {
      sha256: digest,
      backoffMs: () => 1,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error('connection reset');
        return new Response(bodyOf(payload), { headers: { 'content-length': String(payload.length) } });
      },
    });
    assert.equal(calls, 2);
    assert.equal(await sha256File(dest), digest);
  });

  it('deletes a download whose checksum is wrong instead of installing it', async () => {
    const dest = path.join(dir, 'f.zip');
    await assert.rejects(
      download('http://x/f', dest, {
        sha256: '0'.repeat(64),
        fetchImpl: async () => new Response(bodyOf(payload), { headers: { 'content-length': String(payload.length) } }),
      }),
      /Checksum mismatch/
    );
    assert.equal(fs.existsSync(dest), false);
    assert.equal(fs.existsSync(`${dest}.part`), false);
  });

  it('gives up with the last error after the retries are used', async () => {
    await assert.rejects(download('http://x/f', path.join(dir, 'f.zip'), { retries: 1, backoffMs: () => 1, fetchImpl: async () => { throw new Error('offline'); } }), /offline/);
  });
});
