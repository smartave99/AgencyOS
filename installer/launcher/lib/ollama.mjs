// Everything that talks to Ollama or to the Ollama model registry, plus installing the
// Ollama runtime itself. The runtime is downloaded on the first run (it is ~1.4 GB because
// it carries GPU libraries) rather than shipped in the installer.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { download } from './download.mjs';
import { sleep } from './net.mjs';

const REGISTRY = 'https://registry.ollama.ai';

/** "gemma3:1b" -> {name:"gemma3", tag:"1b"}; "embeddinggemma" -> latest; "user/model:tag" is kept. */
export function parseModelName(model) {
  const [name, tag] = String(model).split(':');
  return { name, tag: tag || 'latest' };
}

export const sameModel = (a, b) => {
  const x = parseModelName(a);
  const y = parseModelName(b);
  return x.name === y.name && x.tag === y.tag;
};

/**
 * Asks the public registry whether a tag exists and how many bytes it is.
 * Returns { exists: false } for a 404 and { exists: null } when the registry cannot be reached
 * (offline), so callers can tell "gone" from "unknown".
 */
export async function registryInfo(model, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const { name, tag } = parseModelName(model);
  const repo = name.includes('/') ? name : `library/${name}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${REGISTRY}/v2/${repo}/manifests/${tag}`, {
      headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' },
      signal: controller.signal,
    });
    if (res.status === 404) return { exists: false };
    if (!res.ok) return { exists: null };
    const manifest = await res.json();
    const bytes = (manifest.layers || []).reduce((n, l) => n + (Number(l.size) || 0), 0);
    return { exists: true, bytes, sizeGB: Math.round((bytes / 1024 ** 3) * 100) / 100 };
  } catch {
    return { exists: null };
  } finally {
    clearTimeout(timer);
  }
}

export class OllamaClient {
  constructor({ host, fetchImpl = fetch }) {
    this.host = host.replace(/\/+$/, '');
    this.fetch = fetchImpl;
  }

  async json(pathname, { method = 'GET', body, timeoutMs = 15000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetch(`${this.host}${pathname}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      if (!res.ok) throw new Error(data?.error || `Ollama answered ${res.status}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async version() {
    try {
      return (await this.json('/api/version', { timeoutMs: 2500 }))?.version || null;
    } catch {
      return null;
    }
  }

  async installedModels() {
    const data = await this.json('/api/tags');
    return (data?.models || []).map((m) => m.name || m.model);
  }

  async has(model) {
    try {
      return (await this.installedModels()).some((m) => sameModel(m, model));
    } catch {
      return false;
    }
  }

  /** Streams a pull. onProgress({status, completed, total, fraction}). Throws on failure. */
  async pull(model, onProgress, { signal } = {}) {
    const res = await this.fetch(`${this.host}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama could not pull ${model}: ${text.slice(0, 200) || res.status}`);
    }
    const layers = new Map();
    const decoder = new TextDecoder();
    let buffer = '';
    let success = false;
    const handle = (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.error) throw new Error(msg.error);
      if (msg.digest && msg.total) layers.set(msg.digest, { total: msg.total, completed: msg.completed || 0 });
      if (msg.status === 'success') success = true;
      let total = 0;
      let completed = 0;
      for (const l of layers.values()) {
        total += l.total;
        completed += l.completed;
      }
      onProgress?.({ status: msg.status, completed, total, fraction: total ? completed / total : 0 });
    };
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(handle);
    }
    handle(buffer);
    if (!success) throw new Error(`The download of ${model} ended before it finished.`);
  }

  /** @returns {Promise<number[][]>} */
  async embed(model, input, { timeoutMs = 120000 } = {}) {
    const data = await this.json('/api/embed', { method: 'POST', body: { model, input }, timeoutMs });
    return data?.embeddings || [];
  }

  async generate(model, prompt, { options, format, timeoutMs = 300000 } = {}) {
    return this.json('/api/generate', {
      method: 'POST',
      body: { model, prompt, stream: false, think: false, ...(format ? { format } : {}), ...(options ? { options } : {}) },
      timeoutMs,
    });
  }

  async remove(model) {
    try {
      await this.json('/api/delete', { method: 'DELETE', body: { model }, timeoutMs: 30000 });
    } catch {
      /* best effort: a model that cannot be deleted only costs disk space */
    }
  }

  async unload(model) {
    try {
      await this.json('/api/generate', { method: 'POST', body: { model, keep_alive: 0 }, timeoutMs: 8000 });
    } catch {
      /* best effort */
    }
  }
}

/** Tokens per second from an Ollama /api/generate response (durations are nanoseconds). */
export function tokensPerSecond(response) {
  const count = Number(response?.eval_count);
  const ns = Number(response?.eval_duration);
  if (!Number.isFinite(count) || !Number.isFinite(ns) || count <= 0 || ns <= 0) return 0;
  return count / (ns / 1e9);
}

/** Folders of GPU libraries that are only useful with the matching hardware. */
export function folderPrunePlan(hw) {
  const hasNvidia = (hw.gpus || []).some((g) => g.vendor === 'nvidia');
  return hasNvidia ? [] : ['cuda_v12', 'cuda_v13'];
}

function run(file, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited ${code}: ${err.slice(-400)}`))));
  });
}

export async function extractZip(zip, destination, platform = process.platform) {
  await fsp.mkdir(destination, { recursive: true });
  if (platform === 'win32') {
    // bsdtar ships with Windows 10 1803+ and reads zip files; much faster than Expand-Archive.
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    try {
      await run(tar, ['-xf', zip, '-C', destination]);
      return;
    } catch (error) {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      await run(ps, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`,
      ]).catch(() => {
        throw error;
      });
      return;
    }
  }
  await run('unzip', ['-q', '-o', zip, '-d', destination]);
}

export class OllamaRuntime {
  /**
   * @param manifest   the "ollama" section of runtime-manifest.json: { version, assets: { 'win32-x64': { url, sha256 } } }
   */
  constructor({ dir, platform = process.platform, arch = process.arch, hostArch, manifest = null, log = () => {} }) {
    this.dir = dir; // data/ollama/app
    this.platform = platform;
    this.arch = hostArch || arch;
    this.manifest = manifest;
    this.log = log;
  }

  get exe() {
    return path.join(this.dir, this.platform === 'win32' ? 'ollama.exe' : 'ollama');
  }

  get installed() {
    return fs.existsSync(this.exe);
  }

  get version() {
    try {
      return fs.readFileSync(path.join(this.dir, 'VERSION'), 'utf8').trim();
    } catch {
      return null;
    }
  }

  asset() {
    const key = `${this.platform}-${this.arch === 'arm64' ? 'arm64' : 'x64'}`;
    const fromManifest = this.manifest?.assets?.[key];
    if (fromManifest) return { ...fromManifest, version: this.manifest.version };
    if (this.platform !== 'win32') return null;
    const file = this.arch === 'arm64' ? 'ollama-windows-arm64.zip' : 'ollama-windows-amd64.zip';
    return { url: `https://github.com/ollama/ollama/releases/latest/download/${file}`, sha256: null, version: 'latest' };
  }

  async install(hw, { onProgress } = {}) {
    const asset = this.asset();
    if (!asset) throw new Error(`No Ollama download is defined for ${this.platform}-${this.arch}.`);
    const work = path.join(path.dirname(this.dir), 'download');
    const zip = path.join(work, 'ollama.zip');
    await download(asset.url, zip, { sha256: asset.sha256, onProgress });
    const staging = `${this.dir}.new`;
    await fsp.rm(staging, { recursive: true, force: true });
    await extractZip(zip, staging, this.platform);
    for (const name of folderPrunePlan(hw)) {
      await fsp.rm(path.join(staging, 'lib', 'ollama', name), { recursive: true, force: true });
    }
    await fsp.writeFile(path.join(staging, 'VERSION'), `${asset.version}\n`);
    await fsp.rm(this.dir, { recursive: true, force: true });
    await fsp.rename(staging, this.dir);
    await fsp.rm(work, { recursive: true, force: true });
    this.log(`Ollama ${asset.version} installed`);
  }

  /** Environment for `ollama serve`. Models live in the data folder, never in the install folder. */
  serveEnv({ host, modelsDir, hw, extraPath = [] }) {
    const small = (hw?.ramGB ?? 16) < 12;
    return {
      OLLAMA_HOST: host,
      OLLAMA_MODELS: modelsDir,
      OLLAMA_KEEP_ALIVE: '10m',
      OLLAMA_MAX_LOADED_MODELS: small ? '1' : '2',
      OLLAMA_NUM_PARALLEL: '1',
      OLLAMA_NOHISTORY: '1',
      ...(extraPath.length ? { PATH: [...extraPath, process.env.PATH || ''].join(path.delimiter) } : {}),
    };
  }
}

/** Waits for the daemon to answer, up to timeoutMs. */
export async function waitForOllama(client, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.version()) return true;
    await sleep(500);
  }
  return false;
}
