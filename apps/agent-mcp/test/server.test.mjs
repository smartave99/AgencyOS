// node --test apps/agent-mcp/test/*.test.mjs
//
// Runs the real server as a child process, speaking JSON-RPC over its standard input and output, against
// a small fake AgencyOS gateway on the loopback interface.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  isLoopbackHost,
  readSettings,
  SUPPORTED_PROTOCOLS,
} from '../server.mjs';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const TOKEN = `agt_${'k'.repeat(20)}SECRETSECRETSECRET`;

const TOOLS = [
  {
    name: 'list_clients',
    scope: 'READ',
    description: 'Clients (up to 25).',
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string', maxLength: 500 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'create_client',
    scope: 'DRAFT',
    description: 'Add a client. This only proposes the change.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

/** A stand-in for AgencyOS: answers however the test says, and remembers what it was asked. */
async function fakeGateway(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(entry);
      const answer = await respond(entry);
      res.writeHead(answer.status ?? 200, {
        'content-type': 'application/json',
        ...(answer.headers ?? {}),
      });
      res.end(answer.raw ?? JSON.stringify(answer.json ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, server };
}

const standard = (entry) => {
  if (entry.method === 'GET' && entry.url.endsWith('/agent-gateway/tools')) {
    return { json: { scope: 'DRAFT', tools: TOOLS } };
  }
  if (entry.method === 'POST' && entry.url.endsWith('/agent-gateway/call')) {
    return {
      json: {
        tool: entry.body.tool,
        result: [{ name: 'Acme', echoed: entry.body.args }],
      },
    };
  }
  return { status: 404, json: { message: 'Cannot GET' } };
};

/** Starts the server and gives the test a way to talk to it. */
function start(env, { cwdEnv = true } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...(cwdEnv ? { PATH: process.env.PATH } : {}), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  const waiting = new Map();
  const answers = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => (err += c));
  child.stdout.on('data', (c) => {
    out += c;
    let at;
    while ((at = out.indexOf('\n', scanned)) >= 0) {
      const line = out.slice(scanned, at);
      scanned = at + 1;
      if (!line) continue;
      const message = JSON.parse(line); // anything else on stdout fails the test right here
      answers.push(message);
      const first = Array.isArray(message) ? message[0] : message;
      const hold = waiting.get(first?.id ?? null);
      if (hold) {
        waiting.delete(first?.id ?? null);
        hold(message);
      }
    }
  });
  let scanned = 0;
  const exited = new Promise((resolve) =>
    child.on('close', (code) => resolve(code))
  );
  cleanup.push(async () => {
    child.kill();
    await exited;
  });

  const api = {
    child,
    answers,
    get stdout() {
      return out;
    },
    get stderr() {
      return err;
    },
    exited,
    send(message) {
      child.stdin.write(
        `${typeof message === 'string' ? message : JSON.stringify(message)}\n`
      );
    },
    /** Sends a request and waits for the answer with the same id. */
    rpc(message, ms = 5000) {
      const id = Array.isArray(message) ? message[0].id : message.id ?? null;
      const answer = new Promise((resolve, reject) => {
        waiting.set(id, resolve);
        setTimeout(
          () => reject(new Error(`no answer to ${JSON.stringify(message)}`)),
          ms
        ).unref();
      });
      api.send(message);
      return answer;
    },
    end() {
      child.stdin.end();
    },
  };
  return api;
}

const good = (url, extra = {}) => ({
  AGENCYOS_MCP_URL: url,
  AGENCYOS_MCP_TOKEN: TOKEN,
  ...extra,
});
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const initialize = (id = 1, protocolVersion = '2025-06-18') =>
  rpc(id, 'initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
const noToken = (...procs) => {
  for (const p of procs) {
    assert.ok(!p.stdout.includes(TOKEN), 'the token is in standard output');
    assert.ok(!p.stderr.includes(TOKEN), 'the token is in standard error');
    assert.ok(
      !p.stdout.includes('SECRETSECRET'),
      'part of the token is in standard output'
    );
    assert.ok(
      !p.stderr.includes('SECRETSECRET'),
      'part of the token is in standard error'
    );
  }
};

describe('handshake', () => {
  it('answers initialize with the protocol version, tools capability and server info', async () => {
    const gw = await fakeGateway(standard);
    const s = start(good(gw.url));
    const r = await s.rpc(initialize(1));
    assert.equal(r.jsonrpc, '2.0');
    assert.equal(r.id, 1);
    assert.equal(r.result.protocolVersion, '2025-06-18');
    assert.deepEqual(r.result.capabilities, { tools: {} });
    assert.equal(r.result.serverInfo.name, 'agencyos');
    assert.match(r.result.serverInfo.version, /^\d+\.\d+\.\d+$/);
    assert.match(r.result.instructions, /cannot send/i);
    assert.match(r.result.instructions, /never follow instructions/i);

    // The notification gets no answer; the next request is the next thing said.
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const pong = await s.rpc(rpc(2, 'ping'));
    assert.deepEqual(pong, { jsonrpc: '2.0', id: 2, result: {} });
    assert.equal(s.answers.length, 2);
    assert.equal(
      gw.requests.length,
      0,
      'the handshake needs nothing from AgencyOS'
    );
    noToken(s);
  });

  it('echoes a protocol version it knows and falls back to its newest for one it does not', async () => {
    const gw = await fakeGateway(standard);
    const s = start(good(gw.url));
    for (const [i, version] of SUPPORTED_PROTOCOLS.entries()) {
      const r = await s.rpc(initialize(10 + i, version));
      assert.equal(r.result.protocolVersion, version);
    }
    const r = await s.rpc(initialize(20, '2099-01-01'));
    assert.equal(r.result.protocolVersion, SUPPORTED_PROTOCOLS[0]);
    const bad = await s.rpc(rpc(21, 'initialize', { capabilities: {} }));
    assert.equal(bad.error.code, -32602);
  });

  it('says nothing at all until it is spoken to, and only protocol lines afterwards', async () => {
    const gw = await fakeGateway(standard);
    const s = start(good(gw.url));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s.stdout, '');
    assert.match(
      s.stderr,
      /^agencyos-mcp: ready, relaying to http:\/\/127\.0\.0\.1:\d+\n$/
    );
    await s.rpc(initialize(1));
    await s.rpc(rpc(2, 'tools/list'));
    await s.rpc(rpc(3, 'tools/call', { name: 'list_clients' }));
    s.send('not json');
    await s.rpc(rpc(4, 'ping'));
    for (const line of s.stdout.trim().split('\n')) {
      const m = JSON.parse(line);
      assert.equal(m.jsonrpc, '2.0');
    }
    noToken(s);
  });
});

describe('tools', () => {
  it('lists what the gateway allows, with its descriptions and JSON Schemas, and adds nothing', async () => {
    const gw = await fakeGateway((entry) =>
      entry.method === 'GET'
        ? {
            json: {
              scope: 'READ',
              tools: [
                ...TOOLS.slice(0, 1),
                { name: 5, inputSchema: {} }, // damaged entries are skipped
                { name: 'no_schema' },
              ],
            },
          }
        : standard(entry)
    );
    const s = start(good(gw.url));
    await s.rpc(initialize());
    const r = await s.rpc(rpc(2, 'tools/list'));
    assert.deepEqual(r.result.tools, [
      {
        name: 'list_clients',
        description: 'Clients (up to 25).',
        inputSchema: TOOLS[0].inputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
    ]);
    assert.equal(gw.requests[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(gw.requests[0].url, '/agent-gateway/tools');

    const empty = await fakeGateway(() => ({ json: { tools: [] } }));
    const s2 = start(good(empty.url));
    assert.deepEqual((await s2.rpc(rpc(1, 'tools/list'))).result.tools, []);
    noToken(s, s2);
  });

  it('passes a call on and returns the result as JSON text', async () => {
    const gw = await fakeGateway(standard);
    const s = start(good(gw.url));
    await s.rpc(initialize());
    const r = await s.rpc(
      rpc(2, 'tools/call', {
        name: 'list_clients',
        arguments: { search: 'ac' },
      })
    );
    assert.equal(r.result.isError, false);
    assert.equal(r.result.content[0].type, 'text');
    assert.deepEqual(JSON.parse(r.result.content[0].text), [
      { name: 'Acme', echoed: { search: 'ac' } },
    ]);
    const sent = gw.requests[0];
    assert.equal(sent.method, 'POST');
    assert.equal(sent.url, '/agent-gateway/call');
    assert.equal(sent.headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(sent.body, {
      tool: 'list_clients',
      args: { search: 'ac' },
    });

    // No arguments at all is an empty object.
    await s.rpc(rpc(3, 'tools/call', { name: 'list_clients' }));
    assert.deepEqual(gw.requests[1].body, { tool: 'list_clients', args: {} });
    noToken(s);
  });

  it('only ever talks to the configured address, including a path prefix', async () => {
    const gw = await fakeGateway(standard);
    const s = start(good(`${gw.url}/api/`));
    await s.rpc(rpc(1, 'tools/list'));
    assert.equal(gw.requests[0].url, '/api/agent-gateway/tools');
  });

  it('keeps working for several calls at once', async () => {
    const gw = await fakeGateway(async (entry) => {
      await new Promise((r) => setTimeout(r, 50));
      return standard(entry);
    });
    const s = start(good(gw.url));
    const all = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        s.rpc(
          rpc(i, 'tools/call', {
            name: 'list_clients',
            arguments: { search: String(i) },
          })
        )
      )
    );
    assert.deepEqual(
      all.map((r) => JSON.parse(r.result.content[0].text)[0].echoed.search),
      ['1', '2', '3', '4', '5']
    );
  });

  it('finishes what it is doing when the agent closes its input, then exits cleanly', async () => {
    const gw = await fakeGateway(async (entry) => {
      await new Promise((r) => setTimeout(r, 200));
      return standard(entry);
    });
    const s = start(good(gw.url));
    const answer = s.rpc(rpc(1, 'tools/call', { name: 'list_clients' }));
    s.end();
    assert.equal((await answer).result.isError, false);
    assert.equal(await s.exited, 0);
  });
});

describe('errors', () => {
  const run = async (
    answer,
    params = { name: 'create_client', arguments: { name: 'X' } }
  ) => {
    const gw = await fakeGateway(() => answer);
    const s = start(good(gw.url));
    const r = await s.rpc(rpc(1, 'tools/call', params));
    noToken(s);
    return r;
  };

  it('shows the gateway’s own words for a refused or invalid call, as a tool error the model can read', async () => {
    const invalid = await run({
      status: 400,
      json: { statusCode: 400, message: '“name” is required' },
    });
    assert.equal(invalid.result.isError, true);
    assert.equal(invalid.result.content[0].text, '“name” is required');

    const several = await run({
      status: 400,
      json: { message: ['a is wrong', 'b is wrong'] },
    });
    assert.equal(several.result.content[0].text, 'a is wrong. b is wrong');

    const scope = await run({
      status: 403,
      json: { error: 'scope_denied', message: 'This token can only read.' },
    });
    assert.equal(scope.result.isError, true);
    assert.equal(scope.result.content[0].text, 'This token can only read.');

    const missing = await run({
      status: 404,
      json: { message: 'Proposal not found' },
    });
    assert.equal(missing.result.isError, true);
    assert.equal(missing.result.content[0].text, 'Proposal not found');

    const limited = await run({
      status: 429,
      json: {
        message:
          'Too many calls from this token (limit 60 a minute). Try again in 12 s.',
      },
    });
    assert.equal(limited.result.isError, true);
    assert.match(limited.result.content[0].text, /Try again in 12 s/);

    const broken = await run({
      status: 500,
      json: { message: 'The tool failed' },
    });
    assert.equal(broken.result.isError, true);
    assert.match(
      broken.result.content[0].text,
      /AgencyOS had a problem: The tool failed/
    );

    const html = await run({ status: 502, raw: '<html>Bad gateway</html>' });
    assert.equal(html.result.isError, true);
    assert.match(html.result.content[0].text, /HTTP 502/);
  });

  it('answers a tool the gateway does not know as a protocol error', async () => {
    const r = await run(
      {
        status: 404,
        json: {
          error: 'unknown_tool',
          message: 'There is no tool called “send_campaign”',
        },
      },
      { name: 'send_campaign', arguments: {} }
    );
    assert.equal(r.error.code, -32602);
    assert.equal(r.error.message, 'Unknown tool: send_campaign');
  });

  it('explains a refused token without ever printing it', async () => {
    const gw = await fakeGateway(() => ({
      status: 401,
      json: { message: 'That token was revoked' },
    }));
    const s = start(good(gw.url));
    const call = await s.rpc(rpc(1, 'tools/call', { name: 'list_clients' }));
    assert.equal(call.result.isError, true);
    assert.match(
      call.result.content[0].text,
      /refused the agent token \(That token was revoked\)/
    );
    assert.match(call.result.content[0].text, /Agent integrations/);
    const list = await s.rpc(rpc(2, 'tools/list'));
    assert.equal(list.error.code, -32603);
    assert.match(list.error.message, /refused the agent token/);
    noToken(s);
  });

  it('says plainly when AgencyOS is not running', async () => {
    const gw = await fakeGateway(standard);
    const dead = gw.url;
    await new Promise((r) => gw.server.close(r)); // nothing listens there any more
    cleanup.pop();
    const s = start(good(dead));
    const call = await s.rpc(rpc(1, 'tools/call', { name: 'list_clients' }));
    assert.equal(call.result.isError, true);
    assert.match(
      call.result.content[0].text,
      /Could not reach AgencyOS at http:\/\/127\.0\.0\.1:\d+/
    );
    assert.match(call.result.content[0].text, /Is AgencyOS running/);
    const list = await s.rpc(rpc(2, 'tools/list'));
    assert.equal(list.error.code, -32603);
    noToken(s);
  });

  it('never follows a redirect, so the token goes nowhere else', async () => {
    const elsewhere = await fakeGateway(standard);
    const gw = await fakeGateway(() => ({
      status: 302,
      headers: { location: `${elsewhere.url}/agent-gateway/tools` },
    }));
    const s = start(good(gw.url));
    const call = await s.rpc(rpc(1, 'tools/call', { name: 'list_clients' }));
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /redirect/);
    assert.equal(elsewhere.requests.length, 0);
    noToken(s);
  });
});

describe('malformed JSON-RPC', () => {
  it('answers each kind of mistake with the right error and keeps going', async () => {
    const gw = await fakeGateway(standard);
    const s = start(good(gw.url));

    s.send('{ this is not json');
    s.send('{"jsonrpc":"2.0","id":3,"method":"nope"}');
    s.send('[]');
    s.send('"just a string"');
    s.send('42');
    s.send('{"jsonrpc":"1.0","id":4,"method":"ping"}');
    s.send('{"jsonrpc":"2.0","id":5}');
    s.send('{"jsonrpc":"2.0","id":null,"method":"ping"}');
    s.send('{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}');
    s.send('{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{}}');
    s.send(
      '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_clients","arguments":[1]}}'
    );
    const last = await s.rpc(rpc(99, 'ping'));
    assert.deepEqual(last.result, {});
    // Calls take a few more steps than a ping, so their answers can land just after it.
    for (let i = 0; i < 100 && s.answers.length < 12; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(s.answers.length, 12);

    const byId = (id) =>
      s.answers.filter((m) => !Array.isArray(m) && m.id === id);
    const codeOf = (m) => m.error?.code;
    assert.equal(codeOf(s.answers[0]), -32700); // not JSON
    assert.equal(s.answers[0].id, null);
    assert.equal(codeOf(byId(3)[0]), -32601); // unknown method
    const invalid = s.answers.filter((m) => m.error?.code === -32600);
    // [], "just a string", 42, jsonrpc 1.0, no method, null id, object id
    assert.equal(invalid.length, 7);
    assert.ok(invalid.some((m) => m.id === 4));
    assert.ok(invalid.some((m) => m.id === 5));
    assert.equal(codeOf(byId(6)[0]), -32602);
    assert.equal(codeOf(byId(7)[0]), -32602);
    assert.equal(gw.requests.length, 0, 'nothing malformed reaches AgencyOS');
    noToken(s);
  });

  it('answers a batch with a batch, and leaves notifications out of it', async () => {
    const gw = await fakeGateway(standard);
    const s = start(good(gw.url));
    const r = await s.rpc([
      rpc(10, 'ping'),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      rpc(11, 'ping'),
    ]);
    assert.ok(Array.isArray(r));
    assert.deepEqual(r.map((m) => m.id).sort(), [10, 11]);
  });

  it('does not answer notifications or answers to things it never asked', async () => {
    const gw = await fakeGateway(standard);
    const s = start(good(gw.url));
    s.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 1 },
    });
    s.send({ jsonrpc: '2.0', method: 'whatever/else' });
    s.send({ jsonrpc: '2.0', id: 5, result: {} });
    await s.rpc(rpc(2, 'ping'));
    assert.equal(s.answers.length, 1);
  });

  it('offers nothing it does not have', async () => {
    const gw = await fakeGateway(standard);
    const s = start(good(gw.url));
    for (const [i, method] of [
      'resources/list',
      'prompts/list',
      'logging/setLevel',
      'completion/complete',
      'tools/run',
    ].entries()) {
      const r = await s.rpc(rpc(i + 1, method));
      assert.equal(r.error.code, -32601, method);
    }
  });
});

describe('settings', () => {
  it('refuses to start without both settings, says so on standard error and writes nothing to standard output', async () => {
    for (const env of [
      {},
      { AGENCYOS_MCP_URL: 'http://127.0.0.1:3000' },
      { AGENCYOS_MCP_TOKEN: TOKEN },
      { AGENCYOS_MCP_URL: '  ', AGENCYOS_MCP_TOKEN: '' },
    ]) {
      const s = start(env);
      assert.equal(await s.exited, 2, JSON.stringify(env));
      assert.equal(s.stdout, '');
      assert.match(s.stderr, /^agencyos-mcp: .*must be set/);
      noToken(s);
    }
    const onlyToken = start({ AGENCYOS_MCP_TOKEN: TOKEN });
    await onlyToken.exited;
    assert.match(onlyToken.stderr, /AGENCYOS_MCP_URL must be set/);
    assert.doesNotMatch(onlyToken.stderr, /AGENCYOS_MCP_TOKEN/);
  });

  it('refuses a token that is not one, without repeating what was given', async () => {
    for (const bad of [
      '<paste the token shown once>',
      'sk-proj-REALLY-SECRET-VALUE-0123456789',
      'agt_short',
    ]) {
      const s = start({
        AGENCYOS_MCP_URL: 'http://127.0.0.1:3000',
        AGENCYOS_MCP_TOKEN: bad,
      });
      assert.equal(await s.exited, 2);
      assert.equal(s.stdout, '');
      assert.match(s.stderr, /does not look like an AgencyOS agent token/);
      assert.ok(!s.stderr.includes(bad), 'the value was echoed');
    }
  });

  it('refuses any host that is not this computer unless told otherwise', async () => {
    for (const url of [
      'http://example.com:3000',
      'https://agencyos.example.org',
      'http://192.168.1.20:3000',
      'http://10.0.0.5:3000',
      'http://127.0.0.1.evil.example:3000',
      'http://[2001:db8::1]:3000',
      'http://0.0.0.0:3000',
    ]) {
      const s = start(good(url));
      assert.equal(await s.exited, 2, url);
      assert.equal(s.stdout, '', url);
      assert.match(s.stderr, /Refusing to talk to/, url);
      assert.match(s.stderr, /AGENCYOS_MCP_ALLOW_REMOTE=1/);
      noToken(s);
    }
  });

  it('starts for this computer however it is spelled, and for another host only with the explicit setting', async () => {
    for (const url of [
      'http://127.0.0.1:3000',
      'http://localhost:3000',
      'http://127.0.0.2:3000',
      'http://[::1]:3000',
      'https://127.0.0.1:3443/api',
    ]) {
      const s = start(good(url));
      assert.deepEqual((await s.rpc(rpc(1, 'ping'))).result, {}, url);
    }
    const remote = start(
      good('http://192.0.2.1:3000', { AGENCYOS_MCP_ALLOW_REMOTE: '1' })
    );
    assert.deepEqual((await remote.rpc(rpc(1, 'ping'))).result, {});
    // Only the exact value 1 counts.
    const maybe = start(
      good('http://192.0.2.1:3000', { AGENCYOS_MCP_ALLOW_REMOTE: 'true' })
    );
    assert.equal(await maybe.exited, 2);
  });

  it('refuses addresses that are not plain web addresses', async () => {
    for (const url of [
      'not a url',
      'ftp://127.0.0.1:21',
      'file:///etc/passwd',
      'http://user:pass@127.0.0.1:3000',
    ]) {
      const s = start(good(url));
      assert.equal(await s.exited, 2, url);
      assert.equal(s.stdout, '');
      assert.ok(!s.stderr.includes('pass@'));
    }
  });

  it('checks settings the same way when called as a library', () => {
    assert.equal(readSettings({}).ok, false);
    const ok = readSettings({
      AGENCYOS_MCP_URL: 'http://localhost:3000/',
      AGENCYOS_MCP_TOKEN: TOKEN,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.base, 'http://localhost:3000');
    assert.equal(ok.origin, 'http://localhost:3000');
    for (const [host, loopback] of [
      ['localhost', true],
      ['LOCALHOST', true],
      ['127.0.0.1', true],
      ['127.255.255.254', true],
      ['[::1]', true],
      ['128.0.0.1', false],
      ['127.0.0.1.example.com', false],
      ['localhost.example.com', false],
      ['example.com', false],
      ['0.0.0.0', false],
    ]) {
      assert.equal(isLoopbackHost(host), loopback, host);
    }
  });
});
