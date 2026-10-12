// Resumable download with progress and an optional SHA-256 check. Used for the Ollama
// runtime (about 1.4 GB), which is fetched on the first run, not shipped in the installer.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { sleep } from './net.mjs';

const STALL_MS = 60_000;

export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return hash.digest('hex');
}

/** Parses "bytes 100-199/1000" (a 206 response) or returns null. */
export function parseContentRange(value) {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(value || '').trim());
  return m ? { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) } : null;
}

async function attempt(url, part, { onProgress, fetchImpl }) {
  const existing = fs.existsSync(part) ? (await fsp.stat(part)).size : 0;
  const controller = new AbortController();
  let stall = setTimeout(() => controller.abort(), STALL_MS);
  const poke = () => {
    clearTimeout(stall);
    stall = setTimeout(() => controller.abort(), STALL_MS);
  };
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: existing ? { Range: `bytes=${existing}-` } : {},
    });
    if (res.status === 416) return { complete: true }; // already have every byte
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} for ${url}`);

    const range = res.status === 206 ? parseContentRange(res.headers.get('content-range')) : null;
    const resuming = res.status === 206 && range && range.start === existing;
    const base = resuming ? existing : 0;
    const total = resuming
      ? range.total
      : Number(res.headers.get('content-length')) || null;
    const out = fs.createWriteStream(part, { flags: resuming ? 'a' : 'w' });

    let received = base;
    const started = Date.now();
    let lastReport = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
      received += chunk.length;
      poke();
      const now = Date.now();
      if (onProgress && now - lastReport > 400) {
        lastReport = now;
        const seconds = Math.max((now - started) / 1000, 0.001);
        onProgress({ received, total, bytesPerSecond: (received - base) / seconds });
      }
    });
    await new Promise((resolve, reject) => {
      body.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      body.pipe(out);
    });
    onProgress?.({ received, total, bytesPerSecond: 0 });
    if (total && received !== total) throw new Error(`Short download: ${received} of ${total} bytes`);
    return { complete: true };
  } finally {
    clearTimeout(stall);
  }
}

/**
 * Downloads `url` to `dest`, resuming a previous `.part` file, retrying with backoff.
 * Throws if the SHA-256 does not match `sha256` (the bad file is deleted).
 */
export async function download(url, dest, { onProgress, sha256, retries = 6, fetchImpl = fetch, backoffMs = (i) => Math.min(2000 * 2 ** i, 30_000) } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let lastError;
  for (let i = 0; i <= retries; i += 1) {
    try {
      await attempt(url, part, { onProgress, fetchImpl });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await sleep(backoffMs(i));
    }
  }
  if (lastError) throw lastError;

  if (sha256) {
    const actual = await sha256File(part);
    if (actual.toLowerCase() !== String(sha256).toLowerCase().replace(/^sha256:/, '')) {
      await fsp.rm(part, { force: true });
      throw new Error(`Checksum mismatch for ${path.basename(dest)} (expected ${sha256}, got ${actual})`);
    }
  }
  await fsp.rm(dest, { force: true });
  await fsp.rename(part, dest);
  return dest;
}
