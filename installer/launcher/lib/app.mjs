// Wires everything together: the long-running process that owns Postgres, Redis, Temporal,
// the three Node apps and the local AI manager, and serves the status page.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolvePaths } from './paths.mjs';
import { loadOrCreateSecrets, readEnvFile, setEnvKey } from './envfile.mjs';
import { tcpOpen, portFree, findFreePort } from './net.mjs';
import { Supervisor, cleanupStale } from './supervisor.mjs';
import { buildServices, DEFAULT_PORTS } from './services.mjs';
import { AiManager } from './ai.mjs';
import { createStatusServer } from './status-server.mjs';

export const EXPECTED_IMAGES = ['node', 'redis-server', 'temporal', 'ollama', 'llama-server', 'postgres'];

export function createLogger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (message) => {
    const line = `${new Date().toISOString()} ${message}`;
    try {
      fs.appendFileSync(file, `${line}\n`);
    } catch {
      /* logging must never take the app down */
    }
    console.log(line);
  };
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Keeps each service on the port it used last (a running Postgres cannot change port) and moves
 * to the next free one only when something else has taken it.
 */
export async function resolvePorts(paths, { isFree = portFree, open = tcpOpen, defaults = DEFAULT_PORTS } = {}) {
  const file = path.join(paths.data.config, 'ports.json');
  const saved = readJson(file, {});
  const ports = {};
  const postgresRunning = fs.existsSync(path.join(paths.data.pg, 'postmaster.pid'));
  for (const [name, def] of Object.entries(defaults)) {
    const want = Number.isInteger(saved[name]) ? saved[name] : def;
    if (name === 'ollama' && (await open('127.0.0.1', want))) {
      ports[name] = want; // someone's Ollama is already there: use it instead of starting a second one
    } else if (name === 'postgres' && postgresRunning && (await open('127.0.0.1', want))) {
      ports[name] = want; // our own database from a previous run
    } else if (await isFree(want)) {
      ports[name] = want;
    } else {
      ports[name] = await findFreePort(want + 1);
    }
  }
  await fsp.mkdir(paths.data.config, { recursive: true });
  await fsp.writeFile(file, JSON.stringify(ports, null, 2));
  return ports;
}

export function readSupervisorInfo(paths) {
  return readJson(paths.data.supervisorInfo);
}

export async function startLauncher({ launcherDir, env = process.env, onExit = (code) => process.exit(code) }) {
  const paths = resolvePaths({ launcherDir, env });
  for (const dir of [paths.data.root, paths.data.logs, paths.data.run, paths.data.config, paths.data.uploads]) {
    await fsp.mkdir(dir, { recursive: true });
  }
  const log = createLogger(path.join(paths.data.logs, 'supervisor.log'));
  const manifest = readJson(paths.runtime.manifest, {});
  const version = manifest.appVersion || 'dev';
  log(`AgencyOS ${version} starting (install: ${paths.installRoot}, data: ${paths.data.root})`);

  await cleanupStale({ runDir: paths.data.run, expectedImages: EXPECTED_IMAGES, log });

  const secrets = loadOrCreateSecrets(paths.data.secrets);
  const userEnv = () => readEnvFile(paths.data.userEnv);
  const ports = await resolvePorts(paths);
  const appUrl = `http://localhost:${ports.frontend}`;

  let supervisor = null;
  const ai = new AiManager({
    paths,
    hostEnv: env,
    userEnv,
    ollamaHost: `http://127.0.0.1:${ports.ollama}`,
    runtimeManifest: manifest.ollama || null,
    log,
    startOllama: async () => {
      await supervisor.start('ollama');
    },
  });

  const getStatus = () => ({
    app: 'AgencyOS',
    version,
    ready: !!supervisor && supervisor.isReady(),
    attention: !!supervisor && supervisor.hasFailed(),
    url: appUrl,
    services: supervisor ? supervisor.snapshot().filter((s) => s.state !== 'idle') : [],
    ai: ai.snapshot(),
    telegram: { configured: !!userEnv().AGENCY_TELEGRAM_BOT_TOKEN },
    dataDir: paths.data.root,
    logsDir: paths.data.logs,
    ports,
    pid: process.pid,
  });

  let shuttingDown = false;
  let statusServer;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down');
    ai.stop();
    await supervisor?.stopAll().catch((e) => log(`stopAll: ${e.message}`));
    await statusServer?.close().catch(() => {});
    await fsp.rm(paths.data.supervisorInfo, { force: true });
    log('Stopped');
    onExit(code);
  };

  const restartAll = async () => {
    await supervisor.stopAll();
    supervisor.shuttingDown = false;
    await supervisor.startAll();
  };

  let aiRunning = false;
  const runAi = () => {
    if (aiRunning) return;
    aiRunning = true;
    ai.run()
      .catch((e) => log(`AI: ${e.message}`))
      .finally(() => {
        aiRunning = false;
      });
  };
  ai.on('models-changed', () => {
    log('AI models changed; restarting the server so it uses them');
    supervisor?.restart('backend').catch(() => {});
  });

  const statusPort = await findFreePort(ports.status);
  statusServer = createStatusServer({
    port: statusPort,
    token: secrets.adminToken,
    version,
    getStatus,
    tail: (name) => {
      if (name === 'supervisor') return fs.readFileSync(path.join(paths.data.logs, 'supervisor.log'), 'utf8').split('\n').slice(-400).join('\n');
      try {
        supervisor.get(name);
      } catch {
        return null;
      }
      return supervisor.tail(name, 400);
    },
    actions: {
      restart: async (service) => {
        if (!supervisor) return;
        if (service) await supervisor.restart(service);
        else await restartAll();
      },
      shutdown: () => shutdown(0),
      retryAi: runAi,
      setTelegramToken: async (token) => {
        setEnvKey(paths.data.userEnv, 'AGENCY_TELEGRAM_BOT_TOKEN', token);
        log(token ? 'Telegram bot token saved' : 'Telegram bot token removed');
        await supervisor?.restart('backend');
      },
    },
  });
  await statusServer.listen();
  await fsp.writeFile(
    paths.data.supervisorInfo,
    JSON.stringify({ pid: process.pid, statusPort, startedAt: new Date().toISOString(), version, url: appUrl })
  );
  log(`Status page: http://127.0.0.1:${statusPort}/`);

  // Choosing the AI models reads the hardware and asks the model registry, which can take a few
  // seconds; the status page is already up while that happens.
  await ai.planModels().catch((error) => log(`AI planning failed: ${error.message}`));

  const ctx = {
    paths,
    ports,
    secrets,
    log,
    ramGB: ai.hw?.ramGB,
    userEnv,
    aiEnv: () => ai.appEnv(),
    ollama: { runtime: ai.runtime, client: ai.client, hw: () => ai.hw },
  };
  supervisor = new Supervisor({
    services: buildServices(ctx),
    logsDir: paths.data.logs,
    runDir: paths.data.run,
    log,
    expectedImages: EXPECTED_IMAGES,
  });

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(0));
  process.on('uncaughtException', (error) => log(`uncaughtException: ${error.stack || error.message}`));
  process.on('unhandledRejection', (error) => log(`unhandledRejection: ${error?.stack || error}`));

  const starting = supervisor.startAll();
  // The AI engine and models are downloaded after the app is up so the first start is not slowed
  // down, but never later than two minutes in even if one service is struggling.
  await Promise.race([starting, new Promise((resolve) => setTimeout(resolve, 120000))]);
  if (ai.runtime.installed) supervisor.start('ollama').catch((e) => log(`ollama: ${e.message}`));
  runAi();
  await starting;
  log(supervisor.isReady() ? `AgencyOS is ready at ${appUrl}` : 'AgencyOS started with problems; see the status page');

  return { paths, ports, statusPort, supervisor, ai, shutdown, getStatus };
}
