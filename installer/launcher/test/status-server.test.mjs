import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStatusServer, tokenMatches, hostAllowed } from '../lib/status-server.mjs';
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
    for (const p of ['/api/restart', '/api/shutdown', '/api/telegram', '/api/ai/retry']) {
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

  it('unknown routes are 404 and shutdown is acknowledged before it runs', async () => {
    assert.equal((await request(port, { path: '/nope', headers: auth })).status, 404);
    const r = await request(port, { method: 'POST', path: '/api/shutdown', headers: auth, body: {} });
    assert.equal(r.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(calls.some(([c]) => c === 'shutdown'));
  });
});

describe('status page and token comparison', () => {
  it('escapes the token it embeds and never uses innerHTML for dynamic values', () => {
    const html = renderStatusPage({ token: '"><script>alert(1)</script>', version: '1.0<b>' });
    assert.equal(html.includes('<script>alert(1)'), false);
    assert.equal(/innerHTML/.test(html), false);
    assert.match(html, /v1\.0b/);
  });

  it('tokenMatches is exact and length-safe', () => {
    assert.equal(tokenMatches('abc', 'abc'), true);
    assert.equal(tokenMatches('abc', 'abd'), false);
    assert.equal(tokenMatches('abc', 'abcd'), false);
    assert.equal(tokenMatches('', ''), false);
    assert.equal(tokenMatches('abc', undefined), false);
  });
});
