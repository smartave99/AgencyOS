// Definitions of every process AgencyOS runs on a laptop. The supervisor knows nothing about
// Postgres or Next.js; it only follows the contract each entry satisfies:
//
//   name, label, required, dependsOn, readyTimeoutMs
//   prepare(report)   optional one-time work before the first start (e.g. initdb)
//   spawn()           returns { command, args, cwd, env }  -> a supervised child process
//                     or { daemon: true } after starting something that detaches (pg_ctl)
//   isReady()         true once it accepts work
//   afterReady()      optional (e.g. create the database)
//   stop()            optional custom shutdown (pg_ctl stop)

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { tcpOpen, httpGet } from './net.mjs';

export const PG_USER = 'agencyos';
export const PG_DB = 'agencyos';

export const DEFAULT_PORTS = {
  status: 4999,
  frontend: 4200,
  backend: 3000,
  orchestrator: 3002,
  postgres: 54329,
  redis: 6390,
  temporal: 7233,
  ollama: 11434,
};

export function databaseUrl(secrets, port) {
  return `postgresql://${PG_USER}:${encodeURIComponent(secrets.dbPassword)}@127.0.0.1:${port}/${PG_DB}?schema=public`;
}

/** Environment shared by backend, orchestrator and frontend. user.env wins over everything. */
export function buildAppEnv({ paths, ports, secrets, userEnv = {}, aiEnv = {}, base = process.env }) {
  const frontendUrl = `http://localhost:${ports.frontend}`;
  const backendUrl = `http://localhost:${ports.backend}`;
  return {
    ...base,
    NODE_ENV: 'production',
    // Stay on this computer: nothing listens on the network, so no firewall prompt appears.
    BACKEND_BIND_HOST: '127.0.0.1',
    ORCHESTRATOR_BIND_HOST: '127.0.0.1',
    HOSTNAME: '127.0.0.1',
    DATABASE_URL: databaseUrl(secrets, ports.postgres),
    REDIS_URL: `redis://127.0.0.1:${ports.redis}`,
    TEMPORAL_ADDRESS: `127.0.0.1:${ports.temporal}`,
    JWT_SECRET: secrets.jwtSecret,
    FRONTEND_URL: frontendUrl,
    MAIN_URL: frontendUrl,
    NEXT_PUBLIC_BACKEND_URL: backendUrl,
    BACKEND_INTERNAL_URL: `http://127.0.0.1:${ports.backend}`,
    // Plain http on localhost: browsers refuse "Secure" cookies there.
    NOT_SECURED: 'true',
    IS_GENERAL: 'true',
    STORAGE_PROVIDER: 'local',
    UPLOAD_DIRECTORY: paths.data.uploads,
    NEXT_PUBLIC_UPLOAD_DIRECTORY: paths.data.uploads,
    NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY: '/uploads',
    AGENCY_SCHEDULER_ENABLED: 'true',
    NEXT_TELEMETRY_DISABLED: '1',
    CHECKPOINT_DISABLE: '1',
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
    ...aiEnv,
    ...userEnv,
  };
}

export async function redisPing(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let data = '';
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('error', () => done(false));
    socket.once('connect', () => socket.write('PING\r\n'));
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n')) done(data.startsWith('+PONG'));
    });
  });
}

function runToEnd(command, args, { env, cwd, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    child.on('error', (error) => resolve({ code: -1, output: error.message }));
    child.on('close', (code) => resolve({ code, output: out }));
    child.stdin.end(input || '');
  });
}

export function buildServices(ctx) {
  const { paths, ports, secrets, platform = process.platform, node = process.execPath, log = () => {} } = ctx;
  const exe = paths.exe;
  const pgBin = (name) => path.join(paths.runtime.postgresBin, `${name}${exe}`);
  const requireFromApp = createRequire(path.join(paths.app.root, 'noop.js'));
  const vcDir = path.join(paths.runtime.root, 'vc');
  const withVc = (env) => ({ ...env, PATH: [vcDir, paths.runtime.postgresBin, env.PATH || process.env.PATH || ''].join(path.delimiter) });
  const appEnv = () => buildAppEnv({ paths, ports, secrets, userEnv: ctx.userEnv?.() || {}, aiEnv: ctx.aiEnv?.() || {} });

  const pgDirReady = () => fs.existsSync(path.join(paths.data.pg, 'PG_VERSION'));

  const pgCtl = (args) => runToEnd(pgBin('pg_ctl'), args, { env: withVc(process.env) });

  async function initCluster(report) {
    report('Creating the local database (first run only)');
    await fsp.mkdir(paths.data.run, { recursive: true });
    const pwfile = path.join(paths.data.run, 'pg-init.pw');
    await fsp.writeFile(pwfile, secrets.dbPassword, { mode: 0o600 });
    const base = ['-D', paths.data.pg, '-U', PG_USER, '-A', 'scram-sha-256', '--pwfile', pwfile, '-E', 'UTF8'];
    try {
      // Unicode (ICU) collation sorts names the way people expect; plain C would put "Zoe" before "alice".
      let r = await runToEnd(pgBin('initdb'), [...base, '--locale-provider=icu', '--icu-locale=und', '--locale=C'], { env: withVc(process.env) });
      if (r.code !== 0) {
        log(`initdb with ICU failed (${r.output.trim().split('\n').pop()}); retrying with the C locale`);
        await fsp.rm(paths.data.pg, { recursive: true, force: true });
        r = await runToEnd(pgBin('initdb'), [...base, '--locale=C'], { env: withVc(process.env) });
      }
      if (r.code !== 0) throw new Error(`initdb failed: ${r.output.trim().slice(-600)}`);
      const conf = path.join(paths.data.pg, 'postgresql.conf');
      const shared = (ctx.ramGB || 8) >= 16 ? '256MB' : '128MB';
      await fsp.appendFile(
        conf,
        `\n# AgencyOS\nlisten_addresses = '127.0.0.1'\nmax_connections = 100\nshared_buffers = ${shared}\ntimezone = 'UTC'\nlog_timezone = 'UTC'\nlog_min_messages = warning\n`
      );
    } finally {
      await fsp.rm(pwfile, { force: true });
    }
  }

  async function ensureDatabase() {
    const { Client } = requireFromApp('pg');
    const client = new Client({ host: '127.0.0.1', port: ports.postgres, user: PG_USER, password: secrets.dbPassword, database: 'postgres' });
    await client.connect();
    try {
      const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [PG_DB]);
      if (!found.rowCount) await client.query(`CREATE DATABASE ${PG_DB}`);
    } finally {
      await client.end();
    }
  }

  /** Pin Prisma's migration engine to the copy we ship so it never tries to download one. */
  const schemaEngineEnv = () => {
    const dir = path.join(paths.app.nodeModules, '@prisma', 'engines');
    try {
      const found = fs.readdirSync(dir).find((f) => f.startsWith('schema-engine-') && !f.endsWith('.map'));
      return found ? { PRISMA_SCHEMA_ENGINE_BINARY: path.join(dir, found) } : {};
    } catch {
      return {};
    }
  };

  const nodeService = (name, label, entry, cwd, extraEnv = {}) => ({
    name,
    label,
    spawn: () => ({ command: node, args: ['--experimental-require-module', entry], cwd, env: { ...appEnv(), ...extraEnv } }),
  });

  return [
    {
      name: 'postgres',
      label: 'Database',
      required: true,
      dependsOn: [],
      readyTimeoutMs: 120000,
      async prepare(report) {
        await fsp.mkdir(paths.data.root, { recursive: true });
        if (!pgDirReady()) await initCluster(report);
      },
      async spawn() {
        const opts = `-p ${ports.postgres} -c listen_addresses=127.0.0.1`;
        const r = await pgCtl(['-D', paths.data.pg, '-l', path.join(paths.data.logs, 'postgres.log'), '-o', opts, '-w', '-t', '90', 'start']);
        if (r.code !== 0 && !(await tcpOpen('127.0.0.1', ports.postgres))) {
          throw new Error(`The database did not start: ${r.output.trim().slice(-500)}`);
        }
        return { daemon: true };
      },
      isReady: () => tcpOpen('127.0.0.1', ports.postgres),
      afterReady: ensureDatabase,
      async stop() {
        await pgCtl(['-D', paths.data.pg, '-m', 'fast', '-w', '-t', '60', 'stop']);
      },
    },
    {
      name: 'redis',
      label: 'Cache',
      required: true,
      dependsOn: [],
      readyTimeoutMs: 30000,
      async prepare() {
        await fsp.mkdir(paths.data.redis, { recursive: true });
      },
      spawn: () => ({
        command: paths.runtime.redis,
        args: [
          '--port', String(ports.redis),
          '--bind', '127.0.0.1',
          '--save', '',
          '--appendonly', 'no',
          '--maxmemory', '256mb',
          '--maxmemory-policy', 'allkeys-lru',
          '--loglevel', 'warning',
          '--protected-mode', 'yes',
          '--dir', paths.data.redis,
        ],
        cwd: paths.data.redis,
        env: process.env,
      }),
      isReady: () => redisPing(ports.redis),
    },
    {
      name: 'temporal',
      label: 'Workflow engine',
      required: true,
      dependsOn: [],
      readyTimeoutMs: 60000,
      async prepare() {
        await fsp.mkdir(paths.data.temporal, { recursive: true });
      },
      spawn: () => ({
        command: paths.runtime.temporal,
        args: [
          'server', 'start-dev',
          '--ip', '127.0.0.1',
          '--port', String(ports.temporal),
          '--headless',
          '--db-filename', paths.data.temporalDb,
          '--log-level', 'warn',
        ],
        cwd: paths.data.temporal,
        env: process.env,
      }),
      isReady: () => tcpOpen('127.0.0.1', ports.temporal),
    },
    {
      name: 'migrate',
      label: 'Database updates',
      required: true,
      oneShot: true,
      dependsOn: ['postgres'],
      readyTimeoutMs: 300000,
      spawn: () => ({
        command: node,
        args: [paths.app.prismaCli, 'migrate', 'deploy', '--schema', paths.app.prismaSchema],
        cwd: paths.app.root,
        env: { ...appEnv(), ...schemaEngineEnv() },
      }),
    },
    {
      ...nodeService('backend', 'AgencyOS server', paths.app.backendMain, path.dirname(paths.app.backendMain), {
        PORT: String(ports.backend),
      }),
      required: true,
      dependsOn: ['postgres', 'redis', 'temporal', 'migrate'],
      readyTimeoutMs: 180000,
      isReady: async () => !!(await httpGet(`http://127.0.0.1:${ports.backend}/`)),
    },
    {
      ...nodeService('orchestrator', 'Background workflows', paths.app.orchestratorMain, path.dirname(paths.app.orchestratorMain), {
        ORCHESTRATOR_PORT: String(ports.orchestrator),
      }),
      required: false,
      dependsOn: ['postgres', 'redis', 'temporal', 'migrate'],
      readyTimeoutMs: 180000,
      isReady: async () => (await httpGet(`http://127.0.0.1:${ports.orchestrator}/health/status`))?.status === 200,
    },
    {
      ...nodeService('frontend', 'AgencyOS app', paths.app.frontendServer, path.dirname(paths.app.frontendServer), {
        PORT: String(ports.frontend),
      }),
      required: true,
      dependsOn: [],
      readyTimeoutMs: 120000,
      isReady: async () => {
        const res = await httpGet(`http://127.0.0.1:${ports.frontend}/`);
        return !!res && res.status < 500;
      },
    },
    {
      name: 'ollama',
      label: 'Local AI engine',
      required: false,
      optionalStart: true, // started by the AI manager once the runtime exists
      dependsOn: [],
      readyTimeoutMs: 90000,
      spawn: () => ({
        command: ctx.ollama.runtime.exe,
        args: ['serve'],
        cwd: path.dirname(ctx.ollama.runtime.exe),
        env: withVc({
          ...process.env,
          ...ctx.ollama.runtime.serveEnv({
            host: `127.0.0.1:${ports.ollama}`,
            modelsDir: paths.data.ollamaModels,
            hw: ctx.ollama.hw?.(),
          }),
        }),
      }),
      isReady: async () => !!(await ctx.ollama.client.version()),
    },
  ];
}
