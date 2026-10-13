import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { createStatusServer, tokenMatches, hostAllowed, storageRequest } from '../lib/status-server.mjs';
import { StorageError } from '../lib/storage.mjs';
import { renderStatusPage } from '../lib/status-page.mjs';
import { findFreePort } from '../lib/net.mjs';

const TOKEN = 'abc123-token';

/** node:http lets us set Host exactly, which fetch() does not. */
function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

describe('status server', () => {
  let port;
  let handle;
  const calls = [];
  before(async () => {
    port = await findFreePort(45100);
    handle = createStatusServer({
      port,
      token: TOKEN,
      version: '1.2.3',
      getStatus: () => ({ ready: true, services: [] }),
      tail: (name) => (name === 'backend' ? 'log line' : null),
      actions: {
        restart: async (s) => calls.push(['restart', s]),
        shutdown: () => calls.push(['shutdown']),
        retryAi: () => calls.push(['retryAi']),
        setTelegramToken: async (t) => calls.push(['telegram', t]),
        checkStorage: async (r) => {
          calls.push(['checkStorage', r]);
          return { ok: false, errors: { dataRoot: 'No.' }, changes: false, jobs: [] };
        },
        moveStorage: async (r) => {
          calls.push(['moveStorage', r]);
          if (r.dataRoot === '/bad') throw new StorageError('That folder already has files in it.', { dataRoot: 'That folder already has files in it.' });
        },
        cleanupStorage: async () => {
          calls.push(['cleanupStorage']);
          return { removed: 1 };
        },
        aiModels: async () => ({ auto: false, engine: { installed: false, running: false }, installed: [] }),
        aiSetAuto: (enabled) => {
          calls.push(['aiSetAuto', enabled]);
          return { auto: enabled };
        },
        aiDownload: (model) => {
          calls.push(['aiDownload', model]);
          return { started: true };
        },
        aiCancel: () => {
          calls.push(['aiCancel']);
          return { cancelled: true };
        },
        aiDelete: async (model) => {
          calls.push(['aiDelete', model]);
          if (model === 'gone:1b') throw Object.assign(new Error('gone:1b is not installed.'), { status: 404 });
          return { deleted: model };
        },
        aiEngine: (action) => {
          calls.push(['aiEngine', action]);
          if (action === 'explode') throw Object.assign(new Error('Unknown engine action'), { status: 400 });
          return { started: true };
        },
        aiTry: async (model) => ({ ok: true, kind: 'text', model }),
        cliTools: async () => ({ tools: [{ id: 'claude', installed: false }], task: null }),
        cliInstall: (tool) => {
          calls.push(['cliInstall', tool]);
          return { started: true };
        },
        cliLogin: (tool) => {
          calls.push(['cliLogin', tool]);
          if (tool === 'codex') throw Object.assign(new Error('Codex CLI: Downloading… Wait for it to finish, or cancel it.'), { status: 409 });
          return { started: true };
        },
        cliCancel: () => {
          calls.push(['cliCancel']);
          return { cancelled: true };
        },
        cliCheck: async (tool) => ({ signedIn: tool === 'claude' }),
        cliSignOut: async (tool) => {
          calls.push(['cliSignOut', tool]);
          return { signedOut: true };
        },
      },
    });
    await handle.listen();
  });
  after(() => handle.close());
  const auth = { 'X-AgencyOS-Token': TOKEN, 'Content-Type': 'application/json' };

  it('serves the page and read-only status without a token', async () => {
    const page = await request(port, { path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /agencyos-token" content="abc123-token"/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(JSON.parse((await request(port, { path: '/api/status' })).body).ready, true);
    assert.equal((await request(port, { path: '/health' })).body, 'ok');
  });

  it('rejects requests whose Host header is not this loopback address (DNS rebinding)', async () => {
    const r = await request(port, { path: '/api/status', headers: { Host: 'evil.example.com' } });
    assert.equal(r.status, 421);
    assert.equal(hostAllowed('localhost:1', 1), true);
    assert.equal(hostAllowed('127.0.0.1.evil.com:1', 1), false);
  });

  it('refuses every state change and the logs without the token', async () => {
    for (const p of ['/api/restart', '/api/shutdown', '/api/telegram', '/api/ai/retry', '/api/storage/check', '/api/storage/move', '/api/storage/cleanup']) {
      const r = await request(port, { method: 'POST', path: p, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 403, p);
    }
    assert.equal((await request(port, { path: '/api/logs/backend' })).status, 403);
    assert.equal((await request(port, { method: 'POST', path: '/api/restart', headers: { ...auth, 'X-AgencyOS-Token': 'wrong' }, body: '{}' })).status, 403);
    assert.deepEqual(calls, []);
  });

  it('runs actions with the token', async () => {
    assert.equal((await request(port, { method: 'POST', path: '/api/restart', headers: auth, body: { service: 'backend' } })).status, 202);
    assert.equal((await request(port, { method: 'POST', path: '/api/ai/retry', headers: auth, body: {} })).status, 202);
    assert.deepEqual(calls.slice(0, 2), [['restart', 'backend'], ['retryAi']]);
    const logs = await request(port, { path: '/api/logs/backend', headers: auth });
    assert.equal(logs.body, 'log line');
    assert.equal((await request(port, { path: '/api/logs/nope', headers: auth })).status, 404);
  });

  it('local AI by hand: needs the token, checks the model name, and passes the request on', async () => {
    const before = calls.length;
    for (const p of ['/api/ai/auto', '/api/ai/pull', '/api/ai/cancel', '/api/ai/delete', '/api/ai/engine', '/api/ai/try']) {
      const r = await request(port, { method: 'POST', path: p, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 403, p);
    }
    assert.equal((await request(port, { path: '/api/ai/models' })).status, 403);
    assert.equal(calls.length, before);

    assert.equal(JSON.parse((await request(port, { path: '/api/ai/models', headers: auth })).body).auto, false);
    assert.equal((await request(port, { method: 'POST', path: '/api/ai/auto', headers: auth, body: { enabled: true } })).status, 200);
    assert.equal((await request(port, { method: 'POST', path: '/api/ai/auto', headers: auth, body: { enabled: 'yes' } })).status, 200); // only true turns it on
    assert.deepEqual(calls.slice(before), [['aiSetAuto', true], ['aiSetAuto', false]]);

    const pulled = await request(port, { method: 'POST', path: '/api/ai/pull', headers: auth, body: { model: ' gemma3:4b ' } });
    assert.equal(pulled.status, 202);
    assert.deepEqual(calls.at(-1), ['aiDownload', 'gemma3:4b']);
    for (const model of ['', 'a b', 'x;rm -rf /', '../../etc/passwd', 'x'.repeat(300), undefined, 42, ['gemma3:4b']]) {
      for (const p of ['/api/ai/pull', '/api/ai/delete', '/api/ai/try']) {
        const r = await request(port, { method: 'POST', path: p, headers: auth, body: { model } });
        assert.equal(r.status, 400, `${p} ${JSON.stringify(model)}`);
      }
    }
    assert.equal((await request(port, { method: 'POST', path: '/api/ai/delete', headers: auth, body: { model: 'gemma3:4b' } })).status, 200);
    const missing = await request(port, { method: 'POST', path: '/api/ai/delete', headers: auth, body: { model: 'gone:1b' } });
    assert.equal(missing.status, 404);
    assert.match(JSON.parse(missing.body).error, /not installed/);
    assert.equal((await request(port, { method: 'POST', path: '/api/ai/engine', headers: auth, body: { action: 'start' } })).status, 202);
    assert.equal((await request(port, { method: 'POST', path: '/api/ai/engine', headers: auth, body: { action: 'explode' } })).status, 400);
    assert.equal(JSON.parse((await request(port, { method: 'POST', path: '/api/ai/try', headers: auth, body: { model: 'gemma3:4b' } })).body).ok, true);
    assert.equal((await request(port, { method: 'POST', path: '/api/ai/cancel', headers: auth, body: {} })).status, 200);
  });

  it('validates the Telegram token shape and never echoes it back', async () => {
    const bad = await request(port, { method: 'POST', path: '/api/telegram', headers: auth, body: { token: 'hello' } });
    assert.equal(bad.status, 400);
    const good = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    const ok = await request(port, { method: 'POST', path: '/api/telegram', headers: auth, body: { token: good } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.includes('AAH'), false);
    assert.deepEqual(JSON.parse(ok.body), { ok: true, configured: true });
    const cleared = await request(port, { method: 'POST', path: '/api/telegram', headers: auth, body: { token: '' } });
    assert.deepEqual(JSON.parse(cleared.body), { ok: true, configured: false });
    assert.deepEqual(calls.filter(([c]) => c === 'telegram'), [['telegram', good], ['telegram', null]]);
  });

  it('rejects malformed and oversized bodies', async () => {
    assert.equal((await request(port, { method: 'POST', path: '/api/restart', headers: auth, body: '{not json' })).status, 400);
    assert.equal((await request(port, { method: 'POST', path: '/api/restart', headers: auth, body: 'x'.repeat(40000) })).status, 413);
  });

  it('checks, moves and cleans up storage only with the token, and reports a bad folder with its field', async () => {
    const check = await request(port, { method: 'POST', path: '/api/storage/check', headers: auth, body: { dataRoot: ' D:\\AgencyOS ', junk: 1 } });
    assert.equal(check.status, 200);
    assert.deepEqual(JSON.parse(check.body).errors, { dataRoot: 'No.' });
    assert.deepEqual(calls.find(([c]) => c === 'checkStorage')[1], { dataRoot: 'D:\\AgencyOS' });

    const bad = await request(port, { method: 'POST', path: '/api/storage/move', headers: auth, body: { dataRoot: '/bad' } });
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).fields.dataRoot, 'That folder already has files in it.');

    assert.equal((await request(port, { method: 'POST', path: '/api/storage/move', headers: auth, body: { dataRoot: '/ok' } })).status, 202);
    const clean = await request(port, { method: 'POST', path: '/api/storage/cleanup', headers: auth, body: {} });
    assert.deepEqual(JSON.parse(clean.body), { ok: true, removed: 1 });
  });

  it('unknown routes are 404 and shutdown is acknowledged before it runs', async () => {
    assert.equal((await request(port, { path: '/nope', headers: auth })).status, 404);
    const r = await request(port, { method: 'POST', path: '/api/shutdown', headers: auth, body: {} });
    assert.equal(r.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(calls.some(([c]) => c === 'shutdown'));
  });

  it('downloads, signs in and signs out of the command-line tools only for the three it knows, and only with the token', async () => {
    assert.equal((await request(port, { path: '/api/cli/tools' })).status, 403);
    const list = await request(port, { path: '/api/cli/tools', headers: auth });
    assert.equal(JSON.parse(list.body).tools[0].id, 'claude');

    calls.length = 0;
    for (const path of ['install', 'login', 'check', 'signout']) {
      assert.equal((await request(port, { method: 'POST', path: `/api/cli/${path}`, body: { tool: 'claude' } })).status, 403, `${path} needs the token`);
    }
    assert.equal(calls.length, 0);

    const install = await request(port, { method: 'POST', path: '/api/cli/install', headers: auth, body: { tool: 'claude' } });
    assert.equal(install.status, 202);
    assert.equal((await request(port, { method: 'POST', path: '/api/cli/login', headers: auth, body: { tool: 'antigravity' } })).status, 202);
    assert.equal(JSON.parse((await request(port, { method: 'POST', path: '/api/cli/check', headers: auth, body: { tool: 'claude' } })).body).signedIn, true);
    assert.equal((await request(port, { method: 'POST', path: '/api/cli/signout', headers: auth, body: { tool: 'codex' } })).status, 200);
    assert.equal(JSON.parse((await request(port, { method: 'POST', path: '/api/cli/cancel', headers: auth, body: {} })).body).cancelled, true);
    assert.deepEqual(calls.map((c) => c.join(':')), ['cliInstall:claude', 'cliLogin:antigravity', 'cliSignOut:codex', 'cliCancel']);

    // anything else is refused before it reaches the manager: a path, a command, nothing at all
    for (const tool of ['../../evil', 'claude; calc', '', undefined, 7]) {
      const res = await request(port, { method: 'POST', path: '/api/cli/install', headers: auth, body: { tool } });
      assert.equal(res.status, 400, JSON.stringify(tool));
    }
    // a busy manager answers 409 with its own words
    const busy = await request(port, { method: 'POST', path: '/api/cli/login', headers: auth, body: { tool: 'codex' } });
    assert.equal(busy.status, 409);
    assert.match(JSON.parse(busy.body).error, /Wait for it to finish/);
  });
});

describe('status page and token comparison', () => {
  it('escapes the token it embeds and never uses innerHTML for dynamic values', () => {
    const html = renderStatusPage({ token: '"><script>alert(1)</script>', version: '1.0<b>' });
    assert.equal(html.includes('<script>alert(1)'), false);
    assert.equal(/innerHTML/.test(html), false);
    assert.match(html, /v1\.0b/);
  });

  it('the page script is valid JavaScript and has every element it talks to', () => {
    const html = renderStatusPage({ token: 'abc', version: '1.0.0' });
    const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
    assert.doesNotThrow(() => new vm.Script(script));
    for (const id of ['st-open', 'st-form', 'st-data-in', 'st-ai-in', 'st-keep', 'st-go', 'st-cancel', 'st-clean', 'st-progress', 'st-fill', 'st-left-list', 'st-fail']) {
      assert.ok(html.includes(`id="${id}"`), id);
    }
    assert.match(html, /Delete the old copy/);
  });

  it('turns a storage form into a request: blank means unchanged, the checkbox keeps AI with the data', () => {
    assert.deepEqual(storageRequest({}), {});
    assert.deepEqual(storageRequest({ dataRoot: '  /d  ', aiRoot: ' /ai ' }), { dataRoot: '/d', aiRoot: '/ai' });
    assert.deepEqual(storageRequest({ dataRoot: '/d', aiRoot: '/ai', keepWithData: true }), { dataRoot: '/d', aiRoot: null });
    assert.deepEqual(storageRequest({ dataRoot: 42, aiRoot: {} }), {});
  });

  it('tokenMatches is exact and length-safe', () => {
    assert.equal(tokenMatches('abc', 'abc'), true);
    assert.equal(tokenMatches('abc', 'abd'), false);
    assert.equal(tokenMatches('abc', 'abcd'), false);
    assert.equal(tokenMatches('', ''), false);
    assert.equal(tokenMatches('abc', undefined), false);
  });
});
