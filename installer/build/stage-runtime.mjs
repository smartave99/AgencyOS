#!/usr/bin/env node
// Downloads and unpacks the third-party runtimes that make AgencyOS run on a computer with
// nothing installed, into <out>/runtime, and records exactly what was shipped.
//
//   runtime/node/node.exe           Node.js (the LTS line named in runtimes.json)
//   runtime/postgres/{bin,lib,share}  PostgreSQL 16 (initdb, pg_ctl, postgres)
//   runtime/redis/                  Redis for Windows
//   runtime/temporal/temporal.exe   Temporal dev server (what the platform needs to start)
//   runtime/python/                 CPython plus the worker's pinned packages (runs only the Telegram account worker)
//   runtime/vc/                     Visual C++ runtime DLLs, so no system install is needed
//
// Ollama (about 1.4 GB because of its GPU libraries) is NOT shipped; its download address and
// checksum are recorded in runtime-manifest.json and the launcher fetches it on the first run.
//
// Runs on a Windows machine (it executes what it unpacks, to prove it starts):
//   node installer/build/stage-runtime.mjs --out <stage> --version 1.0.0

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const out = path.resolve(option('--out', path.join(root, 'installer', 'dist', 'stage')));
const appVersion = option('--version', '0.0.0-dev');
const cache = path.resolve(option('--cache', path.join(root, 'installer', 'dist', 'downloads')));
const pins = JSON.parse(fs.readFileSync(path.join(root, 'installer', 'runtimes.json'), 'utf8'));
const runtimeDir = path.join(out, 'runtime');

const log = (...m) => console.log('[stage-runtime]', ...m);
const die = (message) => {
  console.error(`[stage-runtime] ERROR: ${message}`);
  process.exit(1);
};
if (process.platform !== 'win32') die('this script stages Windows binaries and must run on Windows');

const GH_HEADERS = {
  'User-Agent': 'agencyos-installer',
  Accept: 'application/vnd.github+json',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

async function retry(label, fn, attempts = 4) {
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      log(`${label}: attempt ${i} failed: ${error.message}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw last;
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function download(url, name) {
  await fsp.mkdir(cache, { recursive: true });
  const file = path.join(cache, name);
  await retry(`download ${name}`, async () => {
    const res = await fetch(url, { headers: { 'User-Agent': 'agencyos-installer' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    const hash = crypto.createHash('sha256');
    const sink = fs.createWriteStream(file);
    let bytes = 0;
    for await (const chunk of res.body) {
      hash.update(chunk);
      bytes += chunk.length;
      if (!sink.write(chunk)) await new Promise((r) => sink.once('drain', r));
    }
    await new Promise((resolve, reject) => sink.end((e) => (e ? reject(e) : resolve())));
    download.last = { sha256: hash.digest('hex'), bytes };
  });
  return { file, ...download.last };
}

function verifyDigest(what, actual, expected) {
  if (!expected) {
    log(`${what}: no published checksum to compare (sha256 ${actual})`);
    return false;
  }
  const want = expected.replace(/^sha256:/i, '').toLowerCase();
  if (want.length === 64 && want !== actual) die(`${what}: checksum mismatch (expected ${want}, got ${actual})`);
  return true;
}

function untar(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const r = spawnSync('tar', ['-xf', archive, '-C', dest], { encoding: 'utf8' });
  if (r.status !== 0) die(`could not unpack ${path.basename(archive)}: ${r.stderr || r.stdout}`);
}

const tmp = path.join(out, '.tmp-runtime');
const tools = {};
function check(name, exe, argv) {
  const r = spawnSync(exe, argv, { encoding: 'utf8', timeout: 30000 });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/)[0];
  if (r.status !== 0 && !text) die(`${name} did not run (exit ${r.status}, ${r.error?.message || 'no output'})`);
  log(`${name}: ${text}`);
  return text;
}

async function releaseAsset(repo, tag, assetName) {
  const rel = await retry(`release ${repo}@${tag}`, () => fetchJson(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, GH_HEADERS));
  const asset = (rel.assets || []).find((a) => a.name === assetName);
  if (!asset) die(`${repo}@${tag} has no asset named ${assetName}`);
  return { url: asset.browser_download_url, digest: asset.digest || null, size: asset.size, name: asset.name, tag: rel.tag_name, license: rel.license };
}

// ---- main ------------------------------------------------------------------------------------
fs.rmSync(runtimeDir, { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(runtimeDir, { recursive: true });

// 1. Node.js -------------------------------------------------------------------------------------
{
  const dir = `latest-v${pins.node.major}.x`;
  const sums = await retry('node checksums', async () => {
    const res = await fetch(`https://nodejs.org/dist/${dir}/SHASUMS256.txt`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  });
  const line = sums.split('\n').find((l) => /node-v[\d.]+-win-x64\.zip$/.test(l.trim()));
  if (!line) die('could not find the Windows x64 zip in the Node.js checksum list');
  const [sha, name] = line.trim().split(/\s+/);
  const version = /node-(v[\d.]+)-/.exec(name)[1];
  const dl = await download(`https://nodejs.org/dist/${dir}/${name}`, name);
  verifyDigest('node', dl.sha256, sha);
  untar(dl.file, path.join(tmp, 'node'));
  const src = path.join(tmp, 'node', name.replace(/\.zip$/, ''));
  const dest = path.join(runtimeDir, 'node');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(src, 'node.exe'), path.join(dest, 'node.exe'));
  for (const f of ['LICENSE']) if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dest, f));
  tools.node = { version, source: `https://nodejs.org/dist/${dir}/${name}`, sha256: dl.sha256, license: 'MIT' };
}

// 2. PostgreSQL ----------------------------------------------------------------------------------
{
  const v = pins.postgres.maven;
  const jar = `embedded-postgres-binaries-windows-amd64-${v}.jar`;
  const url = `${pins.postgres.mavenBase}/${v}/${jar}`;
  let source = url;
  try {
    const dl = await download(url, jar);
    const sha1 = (await retry('postgres sha1', async () => {
      const res = await fetch(`${url}.sha1`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.text()).trim().split(/\s+/)[0];
    })).toLowerCase();
    const actual1 = crypto.createHash('sha1').update(fs.readFileSync(dl.file)).digest('hex');
    if (actual1 !== sha1) die(`postgres: SHA-1 mismatch (expected ${sha1}, got ${actual1})`);
    untar(dl.file, path.join(tmp, 'pg-jar'));
    const txz = fs.readdirSync(path.join(tmp, 'pg-jar')).find((f) => f.endsWith('.txz'));
    if (!txz) die('the PostgreSQL archive contains no .txz payload');
    untar(path.join(tmp, 'pg-jar', txz), path.join(runtimeDir, 'postgres'));
    tools.postgres = { version: v, source, sha256: dl.sha256, license: 'PostgreSQL License' };
  } catch (error) {
    log(`Maven Central build failed (${error.message}); falling back to the EnterpriseDB zip`);
    source = pins.postgres.fallbackZip;
    const dl = await download(source, 'postgresql-binaries.zip');
    untar(dl.file, path.join(tmp, 'pg-edb'));
    const base = path.join(tmp, 'pg-edb', 'pgsql');
    fs.mkdirSync(path.join(runtimeDir, 'postgres'), { recursive: true });
    for (const d of ['bin', 'lib', 'share']) fs.cpSync(path.join(base, d), path.join(runtimeDir, 'postgres', d), { recursive: true });
    tools.postgres = { version: '16.9 (EnterpriseDB)', source, sha256: dl.sha256, license: 'PostgreSQL License' };
  }
  const bin = path.join(runtimeDir, 'postgres', 'bin');
  // pgAdmin's GUI libraries ride along in some builds; the server never loads them.
  for (const f of fs.readdirSync(bin)) if (/^wx.*\.dll$|^testplug\.dll$|^pgAdmin/i.test(f)) fs.rmSync(path.join(bin, f), { force: true });
  for (const need of ['initdb.exe', 'pg_ctl.exe', 'postgres.exe']) if (!fs.existsSync(path.join(bin, need))) die(`PostgreSQL is missing ${need}`);
}

// 3. Redis ---------------------------------------------------------------------------------------
{
  const a = await releaseAsset(pins.redis.repo, pins.redis.tag, pins.redis.asset);
  const dl = await download(a.url, a.name);
  verifyDigest('redis', dl.sha256, a.digest);
  untar(dl.file, path.join(tmp, 'redis'));
  const src = path.join(tmp, 'redis', fs.readdirSync(path.join(tmp, 'redis'))[0]);
  const dest = path.join(runtimeDir, 'redis');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (/\.(exe|dll)$/i.test(f) && !/benchmark|sentinel|check-aof|check-rdb/i.test(f)) fs.copyFileSync(path.join(src, f), path.join(dest, f));
  }
  tools.redis = { version: a.tag, source: a.url, sha256: dl.sha256, license: 'RSALv2 / SSPLv1 / AGPLv3 (Redis 8)' };
}

// 4. Temporal ------------------------------------------------------------------------------------
{
  const a = await releaseAsset(pins.temporal.repo, pins.temporal.tag, pins.temporal.asset);
  const dl = await download(a.url, a.name);
  verifyDigest('temporal', dl.sha256, a.digest);
  untar(dl.file, path.join(tmp, 'temporal'));
  const dest = path.join(runtimeDir, 'temporal');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(tmp, 'temporal', 'temporal.exe'), path.join(dest, 'temporal.exe'));
  if (fs.existsSync(path.join(tmp, 'temporal', 'LICENSE'))) fs.copyFileSync(path.join(tmp, 'temporal', 'LICENSE'), path.join(dest, 'LICENSE'));
  tools.temporal = { version: a.tag, source: a.url, sha256: dl.sha256, license: 'MIT' };
}

// 5. Visual C++ runtime, so a brand-new Windows needs no separate install ------------------------
{
  const dest = path.join(runtimeDir, 'vc');
  fs.mkdirSync(dest, { recursive: true });
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const copied = [];
  for (const dll of pins.vcRuntimeDlls) {
    const from = path.join(system32, dll);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(dest, dll));
      copied.push(dll);
    }
  }
  for (const need of ['vcruntime140.dll', 'msvcp140.dll']) if (!copied.includes(need)) die(`${need} was not found in ${system32}`);
  // Next to postgres.exe too: Windows looks in the program's own folder first.
  for (const dll of copied) fs.copyFileSync(path.join(dest, dll), path.join(runtimeDir, 'postgres', 'bin', dll));
  tools.vcRuntime = { files: copied, license: 'Microsoft Visual C++ Redistributable (app-local deployment)' };
}

// 6. Python, for the Telegram user-account worker --------------------------------------------------
// The interpreter is the PSF's own Windows build (NuGet package, checksum pinned in runtimes.json). The worker's
// packages come from the hash-pinned list next to its source; pip is used here and then removed, so nothing on
// the person's computer can install anything into it later.
{
  const v = pins.python;
  const dl = await download(v.url, `python.${v.version}.nupkg`);
  verifyDigest('python', dl.sha256, v.sha256);
  if (dl.sha256 !== v.sha256.toLowerCase()) die(`python: checksum mismatch (expected ${v.sha256}, got ${dl.sha256})`);
  untar(dl.file, path.join(tmp, 'python'));
  const dest = path.join(runtimeDir, 'python');
  fs.cpSync(path.join(tmp, 'python', 'tools'), dest, { recursive: true });
  const exe = path.join(dest, 'python.exe');
  if (!fs.existsSync(exe)) die('the Python package has no tools/python.exe');
  const site = path.join(dest, 'Lib', 'site-packages');
  const lock = path.join(out, 'app', 'telegram-worker', 'requirements.lock.txt');
  if (!fs.existsSync(lock)) die(`${lock} is missing: run stage-app.mjs first`);

  const python = (argv, opts = {}) => spawnSync(exe, ['-E', '-s', ...argv], { encoding: 'utf8', timeout: 600000, ...opts });
  await retry('install the worker packages', async () => {
    const r = python(['-m', 'pip', 'install', '--require-hashes', '--no-deps', '--disable-pip-version-check', '--no-warn-script-location', '--target', site, '-r', lock]);
    if (r.status !== 0) throw new Error(`pip exited ${r.status}: ${`${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).slice(-8).join(' | ')}`);
  }, 3);

  // pip and its tools have done their job; the installed copy of Python cannot install anything.
  for (const entry of fs.readdirSync(site)) if (/^(pip|setuptools|pkg_resources|_distutils_hack|wheel)(-.*)?$/i.test(entry)) fs.rmSync(path.join(site, entry), { recursive: true, force: true });
  for (const rel of v.prune) fs.rmSync(path.join(dest, ...rel.split('/')), { recursive: true, force: true });
  const compiled = python(['-m', 'compileall', '-q', '-j', '0', site]);
  if (compiled.status !== 0) log(`compileall: ${`${compiled.stdout}${compiled.stderr}`.trim().split(/\r?\n/).pop()}`);

  const installed = python(['-c', 'import sys, ssl, sqlite3, asyncio, telethon, rsa, pyasn1, pyaes; print(sys.version.split()[0], telethon.__version__)']);
  if (installed.status !== 0) die(`the packaged Python cannot import the worker's packages: ${`${installed.stdout}${installed.stderr}`.trim().slice(-600)}`);
  log(`python: ${installed.stdout.trim()}`);
  tools.python = { version: v.version, source: v.url, sha256: dl.sha256, license: 'Python Software Foundation License 2.0' };
  tools.pythonPackages = [
    { name: 'telethon', version: '1.45.0', license: 'MIT' },
    { name: 'pyaes', version: '1.6.1', license: 'MIT' },
    { name: 'rsa', version: '4.9.1', license: 'Apache-2.0' },
    { name: 'pyasn1', version: '0.6.4', license: 'BSD-2-Clause' },
  ];
}

// 7. Ollama: only recorded ----------------------------------------------------------------------
{
  const assets = {};
  for (const [key, name] of Object.entries(pins.ollama.assets)) {
    const a = await releaseAsset(pins.ollama.repo, pins.ollama.tag, name);
    assets[key] = { url: a.url, sha256: a.digest ? a.digest.replace(/^sha256:/i, '') : null, size: a.size };
  }
  tools.ollama = { version: pins.ollama.tag, assets, license: 'MIT' };
}


// The worker as it will be installed: its own Python, its packages, its source from the staged app. The in-memory
// backend never talks to Telegram, so this proves the process starts and answers, not that Telegram accepts it.
async function proveWorker() {
  const cwd = path.join(out, 'app', 'telegram-worker');
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', AGENCYOS_WORKER_TOKEN: crypto.randomBytes(16).toString('hex') };
  const child = spawn(path.join(runtimeDir, 'python', 'python.exe'), ['-E', '-s', '-m', 'agencyos_telegram', '--port', '0', '--backend', 'memory'], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', (d) => (text += d));
  child.stderr.on('data', (d) => (text += d));
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no start within 30 seconds: ${text.slice(-500)}`)), 30000);
      const look = setInterval(() => {
        const m = /"port"\s*:\s*(\d+)/.exec(text);
        if (m) {
          clearTimeout(timer);
          clearInterval(look);
          resolve(Number(m[1]));
        }
      }, 100);
      child.once('exit', (code) => reject(new Error(`exited ${code}: ${text.slice(-500)}`)));
    });
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (!res.ok) throw new Error(`/health answered ${res.status}`);
    log(`telegram worker: ${JSON.stringify(await res.json()).slice(0, 160)}`);
  } catch (error) {
    die(`the Telegram worker does not start from the staged layout: ${error.message}`);
  } finally {
    child.kill();
  }
}

// ---- prove it all starts ---------------------------------------------------------------------
log('checking that each runtime starts…');
check('node', path.join(runtimeDir, 'node', 'node.exe'), ['--version']);
check('postgres', path.join(runtimeDir, 'postgres', 'bin', 'postgres.exe'), ['--version']);
check('redis', path.join(runtimeDir, 'redis', 'redis-server.exe'), ['--version']);
check('temporal', path.join(runtimeDir, 'temporal', 'temporal.exe'), ['--version']);
check('python', path.join(runtimeDir, 'python', 'python.exe'), ['--version']);
await proveWorker();

fs.rmSync(tmp, { recursive: true, force: true });

// ---- manifest and notices --------------------------------------------------------------------
const manifestFile = path.join(out, 'runtime-manifest.json');
let manifest = {};
try {
  manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
} catch {
  /* first writer */
}
fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, appVersion, builtAt: new Date().toISOString(), runtimes: tools, ollama: tools.ollama }, null, 2));

const notices = [
  `AgencyOS ${appVersion} — third-party software shipped with this installer`,
  '',
  'AgencyOS is proprietary software of NextGen OS (see LICENSE.txt). It runs these programs, which keep their own licenses:',
  '',
  ...Object.entries(tools)
    .filter(([k]) => k !== 'ollama' && k !== 'vcRuntime' && k !== 'pythonPackages')
    .map(([k, t]) => `  ${k.padEnd(10)} ${String(t.version).padEnd(18)} ${t.license}\n             ${t.source}`),
  `  python pkgs ${tools.pythonPackages.map((p) => `${p.name} ${p.version} (${p.license})`).join(', ')}`,
  `  vc runtime  Microsoft Visual C++ runtime DLLs (${tools.vcRuntime.files.length} files), redistributed app-locally under Microsoft's terms`,
  '',
  `Downloaded on first run, not shipped: Ollama ${pins.ollama.tag} (MIT) and the AI models you are offered (Gemma: Google's Gemma terms; others under their own licenses).`,
  '',
].join('\n');
fs.writeFileSync(path.join(out, 'THIRD_PARTY_NOTICES.txt'), notices);
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE.txt'));
log(`runtimes staged in ${runtimeDir}`);
