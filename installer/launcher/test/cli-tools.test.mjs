import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliTools, CliToolError, TOOL_IDS } from '../lib/cli-tools.mjs';

/** Stand-in programs written as shell scripts, so the manager runs real processes without the real tools. */
let dir;
let bin;
let state; // a file the stand-ins use as "the saved sign-in"

const write = (name, body) => {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
};

const claude = ({ loginLines = 'echo "Opening https://claude.ai/oauth/authorize?code=1 in your browser"', loginExit = 0, loginDelay = '0.3' } = {}) =>
  write(
    'claude',
    `case "$1 $2" in
  "--version "*) echo "2.1.99 (Claude Code)";;
  "auth status") [ -f "${state}" ] && exit 0 || exit 1;;
  "auth login") ${loginLines}; sleep ${loginDelay}; if [ ${loginExit} -eq 0 ]; then touch "${state}"; fi; exit ${loginExit};;
  "auth logout") rm -f "${state}"; exit 0;;
  *) case "$1" in --version) echo "2.1.99 (Claude Code)";; *) exit 2;; esac;;
esac`
  );

const tools = (over = {}) =>
  new CliTools({
    env: { ...process.env, HOME: dir, USERPROFILE: dir, PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin` },
    platform: 'linux',
    extraDirs: [bin],
    pollMs: 40,
    install: async (id) => {
      if (id === 'claude') claude();
    },
    ...over,
  });

const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('timed out waiting');
};

describe('command-line tools', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agencyos-cli-'));
    bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    state = path.join(dir, 'signed-in');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists the three tools, none installed on a clean computer', async () => {
    const snap = await tools().snapshot();
    assert.deepEqual(snap.tools.map((t) => t.id), TOOL_IDS);
    assert.ok(snap.tools.every((t) => t.installed === false && t.signedIn === false && t.version === null));
    assert.equal(snap.task, null);
  });

  it('downloads a tool only when asked, and then shows its version', async () => {
    const t = tools();
    assert.deepEqual(t.startInstall('claude'), { started: true });
    assert.equal((await t.snapshot()).task.state, 'working');
    await until(async () => (await t.snapshot()).task.state === 'done');
    const snap = await t.snapshot();
    const entry = snap.tools.find((x) => x.id === 'claude');
    assert.equal(entry.installed, true);
    assert.equal(entry.version, '2.1.99 (Claude Code)');
    assert.equal(entry.path, path.join(bin, 'claude'));
    assert.match(snap.task.message, /2\.1\.99/);
  });

  it('does one thing at a time', async () => {
    const t = tools({ install: async () => new Promise((r) => setTimeout(r, 300)) });
    t.startInstall('claude');
    assert.throws(() => t.startInstall('codex'), (e) => e instanceof CliToolError && e.status === 409 && /Wait/.test(e.message));
    assert.throws(() => t.startLogin('claude'), (e) => e.status === 409);
  });

  it('says plainly when an installer stops, or finishes without leaving the program', async () => {
    const stops = tools({ install: async () => Promise.reject(new Error('The Claude Code installer stopped: 403')) });
    stops.startInstall('claude');
    await until(async () => (await stops.snapshot()).task.state === 'failed');
    assert.match((await stops.snapshot()).task.error, /installer stopped: 403/);

    const missing = tools({ install: async () => {} });
    missing.startInstall('codex');
    await until(async () => (await missing.snapshot()).task.state === 'failed');
    assert.match((await missing.snapshot()).task.error, /could not be found afterwards/);
  });

  it('refuses unknown tools, and downloads off Windows unless a test installer is given', async () => {
    const t = tools();
    assert.throws(() => t.startInstall('rm -rf'), (e) => e.status === 400);
    assert.throws(() => t.startLogin('nope'), (e) => e.status === 400);
    await assert.rejects(t.signOut('nope'), (e) => e.status === 400);
    const real = new CliTools({ platform: 'linux', env: { PATH: bin } });
    assert.throws(() => real.startInstall('claude'), (e) => /only in the Windows app/.test(e.message));
  });

  it('asks the program whether it is signed in, by its exit code', async () => {
    claude();
    const t = tools();
    assert.equal(await t.check('claude'), false);
    fs.writeFileSync(state, '1');
    assert.equal(await t.check('claude'), true);
    write('codex', 'exit 7');
    assert.equal(await t.check('codex'), null); // neither yes nor no: not guessed
    assert.equal(await t.check('antigravity'), null); // not installed
    const snap = await t.snapshot();
    assert.equal(snap.tools.find((x) => x.id === 'claude').signedIn, true);
    assert.equal(snap.tools.find((x) => x.id === 'codex').signedIn, null);
  });

  it('signs in through the browser: the program opens the page, AgencyOS notices, nothing is typed', async () => {
    claude();
    const t = tools();
    t.startLogin('claude');
    const waiting = await until(async () => {
      const s = (await t.snapshot()).task;
      return s.state === 'waiting' && s.url ? s : null;
    });
    assert.equal(waiting.url, 'https://claude.ai/oauth/authorize?code=1');
    assert.match(waiting.message, /browser/);
    await until(async () => (await t.snapshot()).task.state === 'done');
    const snap = await t.snapshot();
    assert.equal(snap.tools.find((x) => x.id === 'claude').signedIn, true);
    assert.equal(snap.task.url, null);
  });

  it('shows a sign-in link only when it points at that vendor’s own site', async () => {
    claude({ loginLines: 'echo "Go to https://evil.example.com/claude.ai/login"; echo "or https://claude.ai.evil.example/x"' });
    const t = tools();
    t.startLogin('claude');
    await until(async () => (await t.snapshot()).task.state === 'done');
    assert.equal((await t.snapshot()).task.url, null);
  });

  it('reports a sign-in that fails to start, and one that ends without signing in', async () => {
    claude({ loginExit: 1, loginLines: 'echo "network unreachable" >&2' });
    const t = tools();
    t.startLogin('claude');
    await until(async () => (await t.snapshot()).task.state === 'failed');
    assert.match((await t.snapshot()).task.error, /could not start the sign-in.*network unreachable/);
  });

  it('lets the person cancel a sign-in they no longer want', async () => {
    claude({ loginDelay: '30' });
    const t = tools();
    t.startLogin('claude');
    await until(async () => (await t.snapshot()).task.state === 'waiting');
    assert.deepEqual(t.cancel(), { cancelled: true });
    assert.equal((await t.snapshot()).task.state, 'cancelled');
    assert.deepEqual(t.cancel(), { cancelled: false });
    // and a new one can start straight away
    t.startLogin('claude');
  });

  it('asks for a download first when the tool is missing', async () => {
    const t = tools();
    t.startLogin('claude');
    await until(async () => (await t.snapshot()).task.state === 'failed');
    assert.match((await t.snapshot()).task.error, /not installed yet\. Download it first/);
  });

  it('Antigravity signs in through a window nobody sees, noticed by asking it for one word', async () => {
    write(
      'agy',
      `case "$1" in
  --version) echo "agy 1.4.0";;
  -p) if [ -f "${state}" ]; then echo OK; exit 0; else echo "authentication required: sign in with Google" >&2; exit 1; fi;;
  *) exit 2;;
esac`
    );
    const opened = [];
    const t = tools({
      startWindow: async (file) => {
        opened.push(file);
        setTimeout(() => fs.writeFileSync(state, '1'), 200); // the person finishes in the browser
        return 4242;
      },
    });
    assert.equal(await t.check('antigravity'), false);
    t.startLogin('antigravity');
    await until(async () => (await t.snapshot()).task.state === 'done');
    assert.deepEqual(opened, [path.join(bin, 'agy')]);
    assert.equal((await t.snapshot()).tools.find((x) => x.id === 'antigravity').signedIn, true);
  });

  it('signs out of Claude Code and Codex, and says Antigravity has to be left from its own menu', async () => {
    claude();
    fs.writeFileSync(state, '1');
    const t = tools();
    assert.deepEqual(await t.signOut('claude'), { signedOut: true });
    assert.equal(fs.existsSync(state), false);
    assert.equal((await t.snapshot()).tools.find((x) => x.id === 'claude').signedIn, false);
    await assert.rejects(t.signOut('antigravity'), (e) => e.status === 400 && /cannot be signed out from here/.test(e.message));
    await assert.rejects(t.signOut('codex'), (e) => e.status === 404);
  });
});
