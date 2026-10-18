import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv, updateEnvText, setEnvKey, loadOrCreateSecrets, readEnvFile } from '../lib/envfile.mjs';
import { resolvePaths, defaultDataRoot } from '../lib/paths.mjs';
import { resolvePorts } from '../lib/app.mjs';
import { DEFAULT_PORTS, buildAppEnv, buildServices, databaseUrl } from '../lib/services.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agencyos-env-'));

describe('env files', () => {
  it('parses comments, quotes and blanks', () => {
    assert.deepEqual(parseEnv('# c\nA=1\nB="two words"\nC=\'x\'\n\nbad line\n1X=no\nD=a=b'), { A: '1', B: 'two words', C: 'x', D: 'a=b' });
  });

  it('sets, replaces and removes one key without touching the rest', () => {
    let t = '# my notes\nA=1\nB=2\n';
    t = updateEnvText(t, 'B', '3');
    assert.equal(t, '# my notes\nA=1\nB=3\n');
    t = updateEnvText(t, 'C', 'has space');
    assert.match(t, /C="has space"/);
    t = updateEnvText(t, 'A', null);
    assert.equal(t.includes('A=1'), false);
    assert.match(t, /# my notes/);
  });

  it('refuses names and values that could inject another variable', () => {
    assert.throws(() => updateEnvText('', 'A B', 'x'));
    assert.throws(() => updateEnvText('', 'A', 'x\nEVIL=1'));
  });

  it('round-trips through a file', () => {
    const dir = tmp();
    const f = path.join(dir, 'user.env');
    setEnvKey(f, 'AGENCY_TELEGRAM_BOT_TOKEN', '123456:abc_DEF-ghi');
    assert.equal(readEnvFile(f).AGENCY_TELEGRAM_BOT_TOKEN, '123456:abc_DEF-ghi');
    setEnvKey(f, 'AGENCY_TELEGRAM_BOT_TOKEN', '');
    assert.deepEqual(readEnvFile(f), {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('secrets', () => {
  it('are created once and then reused', () => {
    const dir = tmp();
    const f = path.join(dir, 'config', 'secrets.json');
    const first = loadOrCreateSecrets(f);
    assert.equal(first.jwtSecret.length, 96);
    assert.ok(first.dbPassword.length >= 32);
    assert.ok(first.workerToken.length >= 32, 'the Telegram worker token is long enough for the worker to accept it');
    assert.deepEqual(loadOrCreateSecrets(f), first);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('are different on every install', () => {
    const dir = tmp();
    const a = loadOrCreateSecrets(path.join(dir, 'a.json'));
    const b = loadOrCreateSecrets(path.join(dir, 'b.json'));
    assert.notEqual(a.jwtSecret, b.jwtSecret);
    assert.notEqual(a.dbPassword, b.dbPassword);
    assert.notEqual(a.workerToken, b.workerToken);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('paths', () => {
  it('keeps data outside the install folder', () => {
    const p = resolvePaths({ launcherDir: 'C:\\Users\\Ana\\AppData\\Local\\Programs\\AgencyOS\\launcher', env: { LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local' }, platform: 'win32' });
    assert.equal(p.installRoot, 'C:\\Users\\Ana\\AppData\\Local\\Programs\\AgencyOS');
    assert.equal(p.dataRoot, 'C:\\Users\\Ana\\AppData\\Local\\AgencyOS');
    assert.equal(p.runtime.temporal, 'C:\\Users\\Ana\\AppData\\Local\\Programs\\AgencyOS\\runtime\\temporal\\temporal.exe');
    assert.ok(!p.data.pg.startsWith(p.installRoot));
  });

  it('can be redirected for tests and portable use', () => {
    const p = resolvePaths({ launcherDir: '/x/launcher', env: { AGENCYOS_HOME: '/opt/ag', AGENCYOS_DATA: '/var/ag' }, platform: 'linux' });
    assert.equal(p.installRoot, '/opt/ag');
    assert.equal(p.data.root, '/var/ag');
    assert.equal(defaultDataRoot({}, 'linux', '/home/u'), '/home/u/.local/share/agencyos');
  });
});

describe('ports', () => {
  const paths = () => {
    const dir = tmp();
    return resolvePaths({ launcherDir: path.join(dir, 'i', 'launcher'), env: { AGENCYOS_DATA: path.join(dir, 'd') }, platform: process.platform });
  };

  it('uses the defaults when they are free and remembers them', async () => {
    const p = paths();
    const ports = await resolvePorts(p, { isFree: async () => true, open: async () => false });
    assert.deepEqual(ports, DEFAULT_PORTS);
    const again = await resolvePorts(p, { isFree: async () => true, open: async () => false });
    assert.deepEqual(again, ports);
  });

  it('moves a service to the next free port when something else holds its port', async () => {
    const p = paths();
    const taken = new Set([4200, 3000]);
    const ports = await resolvePorts(p, { isFree: async (n) => !taken.has(n), open: async () => false });
    assert.equal(ports.frontend, 4201);
    assert.equal(ports.backend, 3001);
    assert.equal(ports.postgres, DEFAULT_PORTS.postgres);
  });

  it('reuses an Ollama that is already running instead of starting a second one', async () => {
    const p = paths();
    const ports = await resolvePorts(p, { isFree: async (n) => n !== 11434, open: async (_h, n) => n === 11434 });
    assert.equal(ports.ollama, 11434);
  });
});

describe('application environment', () => {
  const p = resolvePaths({ launcherDir: '/i/launcher', env: { AGENCYOS_DATA: '/d' }, platform: 'linux' });
  const secrets = { jwtSecret: 'j', dbPassword: 'p@ss/word', adminToken: 't', workerToken: 'w-0123456789abcdef' };
  const ports = { ...DEFAULT_PORTS };

  it('binds to loopback and points every URL at the chosen ports', () => {
    const e = buildAppEnv({ paths: p, ports, secrets, base: {} });
    assert.equal(e.BACKEND_BIND_HOST, '127.0.0.1');
    assert.equal(e.FRONTEND_URL, 'http://localhost:4200');
    assert.equal(e.NEXT_PUBLIC_BACKEND_URL, 'http://localhost:3000');
    assert.equal(e.BACKEND_INTERNAL_URL, 'http://127.0.0.1:3000');
    assert.equal(e.TEMPORAL_ADDRESS, '127.0.0.1:7233');
    assert.equal(e.REDIS_URL, 'redis://127.0.0.1:6390');
    assert.equal(e.STORAGE_PROVIDER, 'local');
    assert.equal(e.UPLOAD_DIRECTORY, '/d/uploads');
    assert.equal(e.AGENCY_SCHEDULER_ENABLED, 'true');
  });

  it('gives the launcher token to the app server only, never to the other services', () => {
    const services = buildServices({ paths: p, ports, secrets });
    const env = (name) => services.find((s) => s.name === name).spawn().env;
    assert.equal(env('frontend').AGENCYOS_STATUS_TOKEN, 't');
    assert.equal(env('backend').AGENCYOS_STATUS_TOKEN, undefined);
    assert.equal(env('orchestrator').AGENCYOS_STATUS_TOKEN, undefined);
  });

  it('tells the server where the Telegram account worker is and how to call it', () => {
    const e = buildAppEnv({ paths: p, ports, secrets, base: {} });
    assert.equal(e.AGENCYOS_TELEGRAM_WORKER_URL, `http://127.0.0.1:${DEFAULT_PORTS.telegramWorker}`);
    assert.equal(e.AGENCYOS_TELEGRAM_WORKER_TOKEN, 'w-0123456789abcdef');
  });

  it('starts the worker with its own Python, on loopback, with a token and only the uploads folder for media', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agencyos-worker-'));
    const wp = resolvePaths({ launcherDir: path.join(root, 'install', 'launcher'), env: { AGENCYOS_DATA: path.join(root, 'data') }, platform: 'linux' });
    const worker = buildServices({ paths: wp, ports, secrets }).find((s) => s.name === 'telegram-worker');
    assert.equal(worker.required, false, 'a missing worker must not stop AgencyOS from starting');
    assert.throws(() => worker.spawn(), /not part of this copy/);
    fs.mkdirSync(path.dirname(wp.runtime.python), { recursive: true });
    fs.writeFileSync(wp.runtime.python, '');
    const spec = worker.spawn();
    assert.equal(spec.command, wp.runtime.python);
    assert.deepEqual(spec.args, ['-E', '-s', '-m', 'agencyos_telegram', '--port', String(DEFAULT_PORTS.telegramWorker)]);
    assert.equal(spec.cwd, wp.app.telegramWorker);
    assert.equal(spec.env.AGENCYOS_WORKER_TOKEN, 'w-0123456789abcdef');
    assert.equal(spec.env.AGENCYOS_MEDIA_ROOT, wp.data.uploads);
    assert.equal(spec.env.DATABASE_URL, undefined, 'the worker never receives the database address');
    assert.equal(spec.env.JWT_SECRET, undefined);
  });

  it('url-encodes the database password', () => {
    assert.match(databaseUrl(secrets, 54329), /agencyos:p%40ss%2Fword@127\.0\.0\.1:54329\/agencyos/);
  });

  it('lets the person override anything in user.env, and carries the AI model names', () => {
    const e = buildAppEnv({ paths: p, ports, secrets, base: {}, aiEnv: { AI_MODEL: 'gemma4:e2b', EMBEDDING_MODEL: 'embeddinggemma' }, userEnv: { AGENCY_TELEGRAM_BOT_TOKEN: '1:x', AGENCY_SCHEDULER_ENABLED: 'false' } });
    assert.equal(e.AI_MODEL, 'gemma4:e2b');
    assert.equal(e.EMBEDDING_MODEL, 'embeddinggemma');
    assert.equal(e.AGENCY_TELEGRAM_BOT_TOKEN, '1:x');
    assert.equal(e.AGENCY_SCHEDULER_ENABLED, 'false');
  });
});
