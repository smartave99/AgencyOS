#!/usr/bin/env node
// Installs the built installer on THIS Windows machine the way a person would, starts the
// desktop app, and checks that the product really works. Run in CI after the installer is built:
//
//   node installer/windows/smoke-test.mjs --installer AgencyOS-Setup-1.0.0.exe --artifacts out [--skip-ai]
//
// Every step either passes or fails the whole run; nothing is skipped silently.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const installer = path.resolve(option('--installer', ''));
const artifacts = path.resolve(option('--artifacts', 'smoke-artifacts'));
const installDir = path.resolve(option('--dir', path.join(process.env.RUNNER_TEMP || process.env.TEMP || '.', 'AgencyOS-install')));
const skipAi = args.includes('--skip-ai');
const aiMinutes = Number(option('--ai-minutes', '30'));
const cdpPort = 9222;

if (process.platform !== 'win32') {
  console.error('The smoke test installs a Windows program and must run on Windows.');
  process.exit(2);
}
fs.mkdirSync(artifacts, { recursive: true });

const dataDir = path.join(process.env.LOCALAPPDATA, 'AgencyOS');
const exe = path.join(installDir, 'AgencyOS.exe');
const nodeExe = path.join(installDir, 'runtime', 'node', 'node.exe');
const launcher = path.join(installDir, 'launcher', 'agencyos.mjs');
const report = { startedAt: new Date().toISOString(), steps: [], facts: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.random().toString(36).slice(2, 8);

async function step(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`\n=== ${name}\n`);
  try {
    const result = await fn();
    const seconds = Math.round((Date.now() - t0) / 1000);
    report.steps.push({ name, ok: true, seconds });
    console.log(`PASS  ${name} (${seconds}s)`);
    return result;
  } catch (error) {
    report.steps.push({ name, ok: false, seconds: Math.round((Date.now() - t0) / 1000), error: String(error.stack || error) });
    console.error(`FAIL  ${name}: ${error.message}`);
    throw error;
  }
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

async function waitFor(label, check, { timeoutMs, intervalMs = 2000, onTick }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (let n = 0; ; n += 1) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
    if (onTick && n % 8 === 7) onTick();
    await sleep(intervalMs);
  }
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}
function ps(command) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 60000 });
  return `${r.stdout || ''}`.trim();
}

let ui = null;
function launchApp() {
  const log = fs.openSync(path.join(artifacts, 'electron.log'), 'a');
  // A hosted runner has no GPU, so skip the GPU probe that can stall there.
  const flags = [`--remote-debugging-port=${cdpPort}`, '--disable-gpu'];
  ui = spawn(exe, flags, { detached: true, stdio: ['ignore', log, log], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } });
  ui.unref();
  return ui;
}
function killApp() {
  spawnSync('taskkill', ['/IM', 'AgencyOS.exe', '/F'], { encoding: 'utf8' });
}
async function statusPort() {
  const info = await waitFor('the supervisor to report its status port', () => {
    const f = path.join(dataDir, 'run', 'supervisor.json');
    return fs.existsSync(f) ? readJson(f) : null;
  }, { timeoutMs: 180000 });
  return info.statusPort;
}
async function untilReady(port, minutes) {
  const printServices = (s) => console.log('   ' + s.services.map((x) => `${x.name}:${x.state}`).join('  '));
  let latest;
  await waitFor('every required service to be running', async () => {
    const r = await getJson(`http://127.0.0.1:${port}/api/status`);
    latest = r.json;
    if (latest?.attention) throw new Error(`a service failed: ${JSON.stringify(latest.services.filter((s) => s.state === 'failed'))}`);
    return latest?.ready;
  }, { timeoutMs: minutes * 60000, intervalMs: 3000, onTick: () => latest && printServices(latest) });
  printServices(latest);
  return latest;
}

function listeners() {
  const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout || '';
  return out
    .split(/\r?\n/)
    .map((l) => /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(l))
    .filter(Boolean)
    .map((m) => ({ host: m[1], port: Number(m[2]), pid: Number(m[3]) }));
}

function collectLogs() {
  try {
    const dest = path.join(artifacts, 'agencyos-data-logs');
    fs.cpSync(path.join(dataDir, 'logs'), dest, { recursive: true });
    for (const f of ['ai-state.json', 'ports.json']) {
      const src = path.join(dataDir, 'config', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(artifacts, f));
    }
  } catch (error) {
    console.log(`(no data logs to collect: ${error.message})`);
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(artifacts, 'smoke-report.json'), JSON.stringify(report, null, 2));
}

/** Minimal Chrome DevTools Protocol client over Node's built-in WebSocket. */
async function cdp(wsUrl, calls) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('could not connect to the app window'));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    return await calls(send);
  } finally {
    ws.close();
  }
}

async function main() {
  let user;
  let port;

  await step('install silently, per user, no administrator prompt', async () => {
    assert(fs.existsSync(installer), `installer not found: ${installer}`);
    fs.rmSync(installDir, { recursive: true, force: true });
    const t0 = Date.now();
    const r = spawnSync(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', `/DIR=${installDir}`, `/LOG=${path.join(artifacts, 'installer.log')}`], { encoding: 'utf8', timeout: 25 * 60000 });
    assert(r.status === 0, `installer exited with ${r.status} ${r.error?.message || ''}`);
    report.facts.installSeconds = Math.round((Date.now() - t0) / 1000);
    for (const f of ['AgencyOS.exe', 'runtime/node/node.exe', 'runtime/postgres/bin/postgres.exe', 'runtime/postgres/bin/pg_ctl.exe', 'runtime/redis/redis-server.exe', 'runtime/temporal/temporal.exe', 'runtime/vc/vcruntime140.dll', 'launcher/agencyos.mjs', 'app/backend/dist/apps/backend/src/main.js', 'app/frontend/apps/frontend/server.js', 'app/prisma/schema.prisma', 'runtime-manifest.json', 'THIRD_PARTY_NOTICES.txt', 'unins000.exe']) {
      assert(fs.existsSync(path.join(installDir, f)), `missing after install: ${f}`);
    }
    const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'AgencyOS.lnk');
    assert(fs.existsSync(startMenu), 'no Start menu shortcut');
    // A first install records where the data lives, so the app and the uninstaller agree on it.
    assert(fs.existsSync(path.join(dataDir, 'locations.json')), 'the installer did not record the data location');
    const run = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'AgencyOS'], { encoding: 'utf8' });
    assert(run.status === 0 && /--hidden/.test(run.stdout), 'start-at-sign-in entry was not created');
    report.facts.manifest = readJson(path.join(installDir, 'runtime-manifest.json')).runtimes;
    console.log(`   installed in ${report.facts.installSeconds}s`);
  });

  await step('start the desktop app: services come up on a machine that has nothing installed', async () => {
    launchApp();
    port = await statusPort();
    const t0 = Date.now();
    const status = await untilReady(port, 12);
    report.facts.firstStartSeconds = Math.round((Date.now() - t0) / 1000);
    report.facts.services = status.services.map((s) => `${s.name}:${s.state}`);
    for (const s of status.services.filter((x) => x.required)) assert(['ready', 'done'].includes(s.state), `${s.name} is ${s.state}`);
  });

  await step('nothing listens on the network, only on this computer', async () => {
    const ours = new Set([3000, 3002, 4200, 4999, 6390, 7233, 54329]);
    const exposed = listeners().filter((l) => ours.has(l.port) && !/^(127\.0\.0\.1|\[?::1\]?)$/.test(l.host));
    assert(exposed.length === 0, `listening beyond loopback: ${JSON.stringify(exposed)}`);
    const seen = listeners().filter((l) => ours.has(l.port)).map((l) => l.port);
    for (const need of [3000, 4200, 4999, 6390, 7233, 54329]) assert(seen.includes(need), `nothing is listening on ${need}`);
  });

  await step('it is a real desktop app: its own window, no browser, no Node access from the page', async () => {
    const targets = await waitFor('the app window to show the application', async () => {
      const r = await getJson(`http://127.0.0.1:${cdpPort}/json/list`);
      const page = (r.json || []).find((t) => t.type === 'page' && /^http:\/\/localhost:4200\//.test(t.url));
      return page || null;
    }, { timeoutMs: 180000 });
    await cdp(targets.webSocketDebuggerUrl, async (send) => {
      const evalExpr = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      assert((await evalExpr('document.title')) !== undefined, 'cannot read the page');
      assert((await evalExpr('typeof window.require')) === 'undefined', 'the page has Node access');
      assert((await evalExpr('typeof process')) === 'undefined', 'the page can see the process object');
      const ua = await evalExpr('navigator.userAgent');
      report.facts.userAgent = ua;
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(artifacts, 'app-window.png'), Buffer.from(shot.data, 'base64'));
      report.facts.windowUrl = await evalExpr('location.href');
    });
    const procs = ps("Get-Process AgencyOS -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { '{0}|{1}' -f $_.Id, $_.MainWindowTitle }");
    report.facts.mainProcess = procs;
    const browsers = ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|msedge|firefox|brave|opera|iexplore)\\.exe$' -and $_.CommandLine -match 'localhost:4200|127\\.0\\.0\\.1:4999' } | ForEach-Object { $_.Name }");
    assert(browsers === '', `a web browser was opened for AgencyOS: ${browsers}`);
  });

  user = await step('the product works: sign up, sign in, and use the agency features through the real server', async () => {
    const api = 'http://127.0.0.1:3000';
    const email = `smoke-${rnd()}@example.com`;
    const password = 'Smoke-Test-123!';
    const reg = await fetch(`${api}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'LOCAL', email, password, company: 'Smoke Agency' }) });
    assert(reg.status === 200, `register -> ${reg.status} ${await reg.text()}`);
    const auth = reg.headers.get('auth');
    assert(auth, 'register returned no session');
    const h = { auth, 'content-type': 'application/json' };
    const self = await getJson(`${api}/user/self`, h);
    assert(self.status === 200 && self.json?.email === email, `user/self -> ${self.status}`);
    const orgs = await getJson(`${api}/user/organizations`, h);
    assert(orgs.status === 200, `organizations -> ${orgs.status}`);
    const me = await getJson(`${api}/agency/me`, h);
    assert(me.status === 200, `agency/me -> ${me.status} ${JSON.stringify(me.json)}`);
    const created = await fetch(`${api}/agency/clients`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'Smoke Client', email: 'client@example.com', industry: 'Bakery' }) });
    assert(created.status === 201 || created.status === 200, `create client -> ${created.status} ${await created.text()}`);
    const clients = await getJson(`${api}/agency/clients`, h);
    assert(clients.status === 200 && JSON.stringify(clients.json).includes('Smoke Client'), 'the new client is not listed');
    const dash = await getJson(`${api}/agency/dashboard`, h);
    assert(dash.status === 200, `dashboard -> ${dash.status}`);
    const sys = await getJson(`${api}/agency/dashboard`, h);
    report.facts.dashboardKeys = Object.keys(sys.json || {}).slice(0, 12);
    const page = await fetch('http://localhost:4200/agency/dashboard', { headers: { cookie: `auth=${auth}` }, redirect: 'manual' });
    assert(page.status === 200, `the app's dashboard page -> ${page.status}`);
    const login = await fetch('http://localhost:4200/auth/login');
    assert(login.status === 200 && /<html/i.test(await login.text()), 'login page did not render');
    return { email, password, auth };
  });

  if (!skipAi) {
    await step('local AI picks models for this hardware and downloads them automatically', async () => {
      let ai;
      await waitFor('local AI to finish setting up', async () => {
        const r = await getJson(`http://127.0.0.1:${port}/api/status`);
        ai = r.json?.ai;
        return ai && ['ready', 'off'].includes(ai.phase); // an 'error' phase is retried by the app itself
      }, {
        timeoutMs: aiMinutes * 60000,
        intervalMs: 5000,
        onTick: () => console.log(`   ai: ${ai?.phase} ${ai?.message || ''} ${ai?.progress ? Math.round((ai.progress.fraction || 0) * 100) + '%' : ''}`),
      });
      report.facts.ai = ai;
      console.log(`   tier=${ai.tier} (${ai.label}); models=${JSON.stringify(ai.models)}; benchmark=${JSON.stringify(ai.benchmark)}`);
      console.log(`   hardware: ${JSON.stringify(ai.hardware)}`);
      for (const reason of ai.reasons || []) console.log(`   reason: ${reason}`);
      assert(ai.phase === 'ready', `AI ended in phase ${ai.phase}: ${ai.message}`);
      assert(ai.models.embedding?.state === 'ready' && ai.models.embedding.id === 'embeddinggemma', `embedding model: ${JSON.stringify(ai.models.embedding)}`);
      assert(ai.models.embedding.dimensions === 768, 'EmbeddingGemma should produce 768-dimension vectors');
      assert(ai.models.text?.state === 'ready', `text model: ${JSON.stringify(ai.models.text)}`);
      assert(ai.benchmark?.tokensPerSecond > 0, 'no speed measurement');
      assert(ai.hardware?.ramGB > 0, 'hardware was not detected');
    });

    await step('the embedding model answers, and the product uses the local model for ad copy', async () => {
      const ollamaPort = readJson(path.join(dataDir, 'config', 'ports.json')).ollama;
      const emb = await fetch(`http://127.0.0.1:${ollamaPort}/api/embed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'embeddinggemma', input: ['campaign for a neighbourhood bakery'] }) });
      const body = await emb.json();
      assert(emb.ok && body.embeddings?.[0]?.length === 768, `embed -> ${emb.status}`);
      const h = { auth: user.auth, 'content-type': 'application/json' };
      const t0 = Date.now();
      const res = await fetch('http://127.0.0.1:3000/agency/ai/generate-copy', { method: 'POST', headers: h, body: JSON.stringify({ brief: 'Spring sale at a neighbourhood bakery, fresh bread every morning', clientName: 'Smoke Client', tone: 'DIRECT_RESPONSE', channelType: 'TELEGRAM' }), signal: AbortSignal.timeout(180000) });
      const copy = await res.json();
      report.facts.copy = { ...copy, seconds: Math.round((Date.now() - t0) / 1000) };
      console.log(`   copy via ${copy.providerUsed} in ${report.facts.copy.seconds}s: ${JSON.stringify(copy.headlines)}`);
      assert(res.status === 201 || res.status === 200, `generate-copy -> ${res.status}`);
      assert(copy.providerUsed === 'ollama', `ad copy came from "${copy.providerUsed}", not the local model`);
      assert(Array.isArray(copy.headlines) && copy.headlines.length >= 1, 'no headlines returned');
    });
  }

  await step('quit and start again: services stop cleanly, data and AI models are kept', async () => {
    killApp();
    await sleep(1500);
    const stop = spawnSync(nodeExe, [launcher, 'stop'], { encoding: 'utf8', timeout: 180000 });
    assert(stop.status === 0, `stop exited ${stop.status}: ${stop.stdout}${stop.stderr}`);
    await sleep(2000);
    const left = listeners().filter((l) => [3000, 4200, 4999, 6390, 7233, 54329].includes(l.port));
    assert(left.length === 0, `still listening after stop: ${JSON.stringify(left)}`);
    const leftovers = ps("Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like '" + installDir.replace(/'/g, "''") + "*' } | ForEach-Object { $_.Name }");
    assert(leftovers === '', `processes still running from the install folder: ${leftovers}`);
    launchApp();
    const t0 = Date.now();
    const p = await statusPort();
    await untilReady(p, 10);
    report.facts.restartSeconds = Math.round((Date.now() - t0) / 1000);
    const login = await fetch('http://127.0.0.1:3000/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'LOCAL', email: user.email, password: user.password }) });
    assert(login.status === 200 && login.headers.get('auth'), `sign-in after restart -> ${login.status}`);
    if (!skipAi) {
      const st = await waitFor('AI to be ready again without downloading', async () => {
        const json = (await getJson(`http://127.0.0.1:${p}/api/status`)).json;
        return json?.ai?.phase === 'ready' ? json : null;
      }, { timeoutMs: 5 * 60000 });
      assert(st.ai.models.embedding?.state === 'ready', 'embedding model was not kept');
      assert(st.ai.models.text?.state === 'ready', 'text model was not kept');
    }
  });

  await step('uninstall removes the program, the shortcuts and (when asked) the data', async () => {
    collectLogs(); // the purge below deletes the data folder, logs included
    killApp();
    await sleep(1500);
    const r = spawnSync(path.join(installDir, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/PURGEDATA=1', `/LOG=${path.join(artifacts, 'uninstall.log')}`], { encoding: 'utf8', timeout: 10 * 60000 });
    assert(r.status === 0, `uninstaller exited ${r.status}`);
    await waitFor('the install folder to be removed', () => !fs.existsSync(path.join(installDir, 'AgencyOS.exe')), { timeoutMs: 120000 });
    // The silent uninstaller hands over to a second process that removes the data folder last.
    await waitFor('the data folder to be purged', () => !fs.existsSync(dataDir), { timeoutMs: 90000 }).catch(() => {});
    if (fs.existsSync(dataDir)) {
      const left = spawnSync('cmd', ['/c', 'dir', '/s', '/b', dataDir], { encoding: 'utf8' }).stdout || '';
      const procs = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout || '';
      console.log(`left in the data folder (first 40):\n${left.split(/\r?\n/).slice(0, 40).join('\n')}\nprocesses:\n${procs.split(/\r?\n/).filter((l) => /postgres|redis|temporal|ollama|llama|node|agencyos/i.test(l)).join('\n')}`);
    }
    assert(!fs.existsSync(dataDir), 'the data folder is still there after a purge');
    assert(spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'AgencyOS'], { encoding: 'utf8' }).status !== 0, 'the start-at-sign-in entry was not removed');
  });
}

/** On failure, put what a person debugging would ask for straight into the CI log. */
function dumpDiagnostics() {
  try {
    const logs = path.join(dataDir, 'logs');
    for (const f of fs.existsSync(logs) ? fs.readdirSync(logs).sort() : []) {
      if (!f.endsWith('.log')) continue;
      const lines = fs.readFileSync(path.join(logs, f), 'utf8').split(/\r?\n/);
      console.log(`\n----- ${f} (last 60 of ${lines.length} lines) -----\n${lines.slice(-60).join('\n')}`);
      const ai = lines.filter((l) => /Ollama|AgencyAiService/.test(l));
      if (ai.length) console.log(`\n----- ${f}: lines about the local model -----\n${ai.slice(-20).join('\n')}`);
    }
    const tasks = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout || '';
    console.log('\n----- processes of interest -----\n' + tasks.split(/\r?\n/).filter((l) => /AgencyOS|node|postgres|redis|temporal|ollama|llama/i.test(l)).join('\n'));
  } catch (error) {
    console.log(`(diagnostics failed: ${error.message})`);
  }
}

let failed = false;
try {
  await main();
} catch {
  failed = true;
  dumpDiagnostics();
} finally {
  killApp();
  collectLogs();
}
console.log(`\n${report.steps.filter((s) => s.ok).length}/${report.steps.length} steps passed`);
console.log(JSON.stringify(report.facts, null, 2));
process.exit(failed ? 1 : 0);
