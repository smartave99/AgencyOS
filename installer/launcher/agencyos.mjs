#!/usr/bin/env node
// AgencyOS launcher. Run with the Node that ships next to it:
//
//   agencyos start [--background]   make sure AgencyOS is running and open it (default); --background
//                                   only starts the services (the desktop app uses this)
//   agencyos run                    run the supervisor in this window (used by `start`)
//   agencyos stop                   stop everything, including the database
//   agencyos status                 print what is running as JSON
//   agencyos open                   open the app in the browser
//   agencyos doctor                 print this computer's details and the AI models it would get
//   agencyos logs <service>         print the end of a service log
//   agencyos prepare [--skip=ollama,antigravity]
//                                   what the installer runs: downloads the local AI engine and installs
//                                   Antigravity so a new computer needs nothing more; never fails setup

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from './lib/paths.mjs';
import { assertLocationsAvailable } from './lib/storage.mjs';
import { startLauncher, readSupervisorInfo, readJson, createLogger } from './lib/app.mjs';
import { prepareComputer } from './lib/prepare.mjs';
import { loadOrCreateSecrets } from './lib/envfile.mjs';
import { httpGet, waitFor } from './lib/net.mjs';
import { isAlive, killTree, cleanupStale, tailFile } from './lib/supervisor.mjs';
import { EXPECTED_IMAGES } from './lib/app.mjs';
import { detectHardware } from './lib/hardware.mjs';
import { selectModels } from './lib/models.mjs';
import { readEnvFile } from './lib/envfile.mjs';

const launcherDir = path.dirname(fileURLToPath(import.meta.url));
const paths = resolvePaths({ launcherDir });
const [command = 'start', ...rest] = process.argv.slice(2);

/** The installed product is a desktop app (AgencyOS.exe); a browser is only the fallback for development. */
function openDesktopApp() {
  const exe = path.join(paths.installRoot, `AgencyOS${paths.exe}`);
  if (process.platform !== 'win32' || !fs.existsSync(exe)) return false;
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: paths.installRoot });
  child.on('error', () => {});
  child.unref();
  return true;
}

function openBrowser(url) {
  const opts = { detached: true, stdio: 'ignore', windowsHide: true };
  const child =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', 'start', '', url], opts)
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], opts);
  child.on('error', () => {});
  child.unref();
}

async function statusOf(info) {
  if (!info || !isAlive(info.pid)) return null;
  const res = await httpGet(`http://127.0.0.1:${info.statusPort}/api/status`, { timeoutMs: 2500 });
  if (!res || res.status !== 200) return null;
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

async function ensureRunning() {
  const running = readSupervisorInfo(paths);
  if (await statusOf(running)) return running;

  assertLocationsAvailable(paths);
  fs.mkdirSync(paths.data.logs, { recursive: true });
  const out = fs.openSync(path.join(paths.data.logs, 'launcher.log'), 'a');
  const child = spawn(process.execPath, [path.join(launcherDir, 'agencyos.mjs'), 'run'], {
    cwd: paths.installRoot,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  fs.closeSync(out);
  // If the supervisor exits straight away, say why now instead of waiting for the timeout.
  const exited = new Promise((resolve) => child.once('exit', () => resolve(false)));
  const info = await Promise.race([
    waitFor(
      async () => {
        const i = readSupervisorInfo(paths);
        return i && i.pid === child.pid && (await statusOf(i)) ? i : false;
      },
      { timeoutMs: 45000, intervalMs: 300 }
    ),
    exited,
  ]);
  if (!info) {
    const logFile = path.join(paths.data.logs, 'launcher.log');
    const reason = tailFile(logFile, 6).trim();
    throw new Error(`AgencyOS did not start.${reason ? `\n${reason}` : ''}\nSee ${logFile}`);
  }
  return info;
}

async function stop() {
  const info = readSupervisorInfo(paths);
  const secrets = loadOrCreateSecrets(paths.data.secrets);
  if (info && isAlive(info.pid)) {
    await fetch(`http://127.0.0.1:${info.statusPort}/api/shutdown`, {
      method: 'POST',
      headers: { 'X-AgencyOS-Token': secrets.adminToken, 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => {});
    const gone = await waitFor(() => !isAlive(info.pid), { timeoutMs: 60000, intervalMs: 300 });
    if (!gone) await killTree(info.pid);
  }
  // Whatever a crashed supervisor left behind, then the database in case it outlived everything.
  await cleanupStale({ runDir: paths.data.run, expectedImages: EXPECTED_IMAGES });
  const pgCtl = path.join(paths.runtime.postgresBin, `pg_ctl${paths.exe}`);
  if (fs.existsSync(path.join(paths.data.pg, 'postmaster.pid')) && fs.existsSync(pgCtl)) {
    await new Promise((resolve) =>
      spawn(pgCtl, ['-D', paths.data.pg, '-m', 'fast', '-w', '-t', '60', 'stop'], { windowsHide: true, stdio: 'ignore' }).on('exit', resolve).on('error', resolve)
    );
  }
}

try {
  switch (command) {
    case 'run':
      await startLauncher({ launcherDir });
      break; // stays alive on the status server and children
    case 'start': {
      const info = await ensureRunning();
      console.log(`AgencyOS is running. Status: http://127.0.0.1:${info.statusPort}/`);
      if (!rest.includes('--background') && !openDesktopApp()) openBrowser(`http://127.0.0.1:${info.statusPort}/?open=1`);
      process.exit(0);
      break;
    }
    case 'open': {
      const info = readSupervisorInfo(paths);
      const status = await statusOf(info);
      if (!openDesktopApp()) openBrowser(status?.ready ? status.url : `http://127.0.0.1:${(info || (await ensureRunning())).statusPort}/?open=1`);
      process.exit(0);
      break;
    }
    case 'stop':
      await stop();
      console.log('AgencyOS stopped.');
      process.exit(0);
      break;
    case 'status': {
      const status = await statusOf(readSupervisorInfo(paths));
      console.log(status ? JSON.stringify(status, null, 2) : JSON.stringify({ running: false }));
      process.exit(status ? 0 : 1);
      break;
    }
    case 'logs': {
      const name = rest[0] || 'supervisor';
      console.log(tailFile(path.join(paths.data.logs, `${name}.log`), 300));
      process.exit(0);
      break;
    }
    case 'prepare': {
      const skip = rest.filter((a) => a.startsWith('--skip=')).flatMap((a) => a.slice('--skip='.length).split(',')).filter(Boolean);
      const log = createLogger(path.join(paths.data.logs, 'prepare.log'));
      log(`Preparing this computer (data: ${paths.data.root}, AI: ${paths.data.ollamaRoot})`);
      const result = await prepareComputer({ paths, manifest: readJson(paths.runtime.manifest, {}), log, skip });
      console.log(JSON.stringify(result, null, 2));
      process.exit(0); // setup goes on whatever happened: each part says so itself and is offered again later
      break;
    }
    case 'doctor': {
      const hw = await detectHardware({ dataDir: paths.data.ollamaModels });
      const plan = selectModels(hw, { env: readEnvFile(paths.data.userEnv), runtimePresent: fs.existsSync(path.join(paths.data.ollamaApp, paths.exe ? 'ollama.exe' : 'ollama')) });
      console.log(JSON.stringify({ paths: { install: paths.installRoot, data: paths.data.root, ai: paths.data.ollamaRoot, pointer: paths.locations.file }, manifest: readJson(paths.runtime.manifest), hardware: hw, aiPlan: plan, node: process.version }, null, 2));
      process.exit(0);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
