import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  AgencyAiGatewayService,
  AiProviderError,
} from './agency.ai.gateway.service';

const ACTOR = { orgId: 'org-1', userId: 'u-1', role: 'AGENCY_OWNER' } as any;
const realFetch = global.fetch;
const realEnv = { ...process.env };

const build = () => {
  let row: any = null;
  const repo = {
    get: async () => row,
    save: async (_org: string, data: any) => {
      row = { ...row, ...data };
      return row;
    },
  } as any;
  const access = { assert: jest.fn(), audit: jest.fn() } as any;
  return { gateway: new AgencyAiGatewayService(repo, access), access };
};

const json = (body: unknown, ok = true, status = 200) =>
  ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any);

const ask = (gateway: AgencyAiGatewayService, provider?: any) =>
  gateway.complete('org-1', {
    provider,
    messages: [{ role: 'user', content: 'hi' }],
  });

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';
  process.env.AGENCYOS_LOCAL = 'true';
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  global.fetch = realFetch;
  process.env = { ...realEnv };
});

describe('AgencyAiGatewayService - saved settings', () => {
  it('seals keys so they can be opened again, only with the same secret', () => {
    const { gateway } = build();
    const sealed = gateway.seal('sk-test-123');
    expect(sealed).not.toContain('sk-test-123');
    expect(gateway.open(sealed)).toBe('sk-test-123');
    // Same text twice gives different values: a random IV is used each time.
    expect(gateway.seal('sk-test-123')).not.toBe(sealed);

    const tampered = sealed.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect(gateway.open(tampered)).toBeNull();
    process.env.JWT_SECRET = 'another-install-another-install-xx';
    expect(gateway.open(sealed)).toBeNull();
  });

  it('never returns a saved key, only that one exists', async () => {
    const { gateway, access } = build();
    const view = await gateway.updateSettings(ACTOR, {
      activeProvider: 'anthropic',
      thinking: 'high',
      providers: {
        anthropic: { apiKey: 'sk-ant-secret', model: 'claude-sonnet-5-5' },
      },
    });
    expect(JSON.stringify(view)).not.toContain('sk-ant-secret');
    const anthropic = view.providers.find((p) => p.id === 'anthropic')!;
    expect(anthropic).toMatchObject({
      hasKey: true,
      keySource: 'saved',
      model: 'claude-sonnet-5-5',
    });
    expect(view.activeProvider).toBe('anthropic');
    expect(access.assert).toHaveBeenCalledWith(ACTOR, 'ai:configure');
    // The audit trail records what changed, never the key.
    expect(JSON.stringify(access.audit.mock.calls)).not.toContain('sk-ant');

    const cleared = await gateway.updateSettings(ACTOR, {
      providers: { anthropic: { apiKey: '' } },
    });
    expect(cleared.providers.find((p) => p.id === 'anthropic')!.hasKey).toBe(
      false
    );
  });

  it('refuses values that would be unsafe or meaningless', async () => {
    const { gateway } = build();
    const rejects = (dto: any) =>
      expect(gateway.updateSettings(ACTOR, dto)).rejects.toThrow();
    await rejects({ providers: { local: { model: 'x; rm -rf /' } } });
    await rejects({ providers: { nope: { model: 'x' } } });
    await rejects({ providers: { anthropic: { baseUrl: 'http://evil' } } });
    await rejects({ providers: { local: { baseUrl: 'ftp://host' } } });
    await rejects({ providers: { local: { baseUrl: 'http://u:p@host' } } });
    await rejects({ providers: { local: { apiKey: 'abc' } } });
    await rejects({ providers: { openai: { apiKey: 'has space' } } });
    await rejects({ activeProvider: 'openai', thinking: 'max' });
  });

  it('keeps command-line tools to the desktop app', async () => {
    process.env.AGENCYOS_LOCAL = 'false';
    const { gateway } = build();
    await expect(
      gateway.updateSettings(ACTOR, { activeProvider: 'claude-cli' })
    ).rejects.toThrow(/desktop app/);
    const view = await gateway.getSettings(ACTOR);
    expect(view.providers.find((p) => p.id === 'codex-cli')!.selectable).toBe(
      false
    );
    await expect(ask(gateway, 'codex-cli')).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('uses a key from the environment when none is saved', async () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    const { gateway } = build();
    const view = await gateway.getSettings(ACTOR);
    expect(view.providers.find((p) => p.id === 'openai')).toMatchObject({
      hasKey: true,
      keySource: 'environment',
    });
  });
});

describe('AgencyAiGatewayService - API providers', () => {
  const setup = async (provider: any, extra: any = {}) => {
    const built = build();
    await built.gateway.updateSettings(ACTOR, {
      activeProvider: provider,
      ...extra,
    });
    return built.gateway;
  };

  it('Anthropic: sends the key as a header and a thinking budget for the level', async () => {
    const gateway = await setup('anthropic', {
      thinking: 'medium',
      providers: {
        anthropic: { apiKey: 'sk-ant', model: 'claude-sonnet-5-5' },
      },
    });
    const fetchMock = jest.fn().mockResolvedValue(
      json({
        content: [
          { type: 'thinking', thinking: '...' },
          { type: 'text', text: 'ready' },
        ],
      })
    );
    global.fetch = fetchMock as any;
    const result = await ask(gateway);
    expect(result.text).toBe('ready');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant');
    const body = JSON.parse(init.body);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(body.max_tokens).toBeGreaterThan(8192);
    expect(body.model).toBe('claude-sonnet-5-5');
  });

  it('retries without thinking when the model does not accept the level, and says so', async () => {
    const gateway = await setup('anthropic', {
      thinking: 'high',
      providers: { anthropic: { apiKey: 'sk-ant' } },
    });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        json({ error: 'thinking not supported' }, false, 400)
      )
      .mockResolvedValueOnce(json({ content: [{ type: 'text', text: 'ok' }] }));
    global.fetch = fetchMock as any;
    const result = await ask(gateway);
    expect(result.text).toBe('ok');
    expect(
      JSON.parse(fetchMock.mock.calls[1][1].body).thinking
    ).toBeUndefined();
    expect(result.notes.join(' ')).toMatch(/without it/);
  });

  it('OpenAI: reasoning effort only goes to reasoning models', async () => {
    const reply = json({ choices: [{ message: { content: 'ok' } }] });
    const gateway = await setup('openai', {
      thinking: 'low',
      providers: { openai: { apiKey: 'sk-oa', model: 'gpt-5' } },
    });
    let fetchMock = jest.fn().mockResolvedValue(reply);
    global.fetch = fetchMock as any;
    await ask(gateway);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reasoning_effort).toBe(
      'low'
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer sk-oa'
    );

    await gateway.updateSettings(ACTOR, {
      providers: { openai: { model: 'gpt-4o-mini' } },
    });
    fetchMock = jest.fn().mockResolvedValue(reply);
    global.fetch = fetchMock as any;
    await ask(gateway);
    expect(
      JSON.parse(fetchMock.mock.calls[0][1].body).reasoning_effort
    ).toBeUndefined();
  });

  it('Gemini: key in a header (not the address) and a thinking budget', async () => {
    const gateway = await setup('gemini', {
      thinking: 'off',
      providers: { gemini: { apiKey: 'g-key', model: 'gemini-2.5-flash' } },
    });
    const fetchMock = jest.fn().mockResolvedValue(
      json({
        candidates: [
          {
            content: {
              parts: [{ thought: true, text: 'hmm' }, { text: 'ready' }],
            },
          },
        ],
      })
    );
    global.fetch = fetchMock as any;
    const result = await ask(gateway);
    expect(result.text).toBe('ready');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain('g-key');
    expect(init.headers['x-goog-api-key']).toBe('g-key');
    expect(
      JSON.parse(init.body).generationConfig.thinkingConfig.thinkingBudget
    ).toBe(0);
  });

  it('Local model: on/off thinking, and a level for gpt-oss', async () => {
    const reply = json({ message: { content: 'ok' } });
    let gateway = await setup('local', { thinking: 'off' });
    let fetchMock = jest.fn().mockResolvedValue(reply);
    global.fetch = fetchMock as any;
    await ask(gateway);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).think).toBe(false);

    gateway = await setup('local', {
      thinking: 'high',
      providers: { local: { model: 'gpt-oss:20b' } },
    });
    fetchMock = jest.fn().mockResolvedValue(reply);
    global.fetch = fetchMock as any;
    await ask(gateway);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).think).toBe('high');

    gateway = await setup('local', { thinking: 'auto' });
    fetchMock = jest.fn().mockResolvedValue(reply);
    global.fetch = fetchMock as any;
    await ask(gateway);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).think).toBeUndefined();
  });

  it('turns failures into advice, without leaking the key', async () => {
    const gateway = await setup('openai', {
      providers: { openai: { apiKey: 'sk-leaky', model: 'gpt-5' } },
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue(json({ error: 'bad sk-leaky' }, false, 401)) as any;
    const error = await ask(gateway).catch((e) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.code).toBe('rejected_key');
    expect(error.message).not.toContain('sk-leaky');

    global.fetch = jest.fn().mockResolvedValue(json({}, false, 429)) as any;
    expect((await ask(gateway).catch((e) => e)).code).toBe('rate_limited');
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as any;
    expect((await ask(gateway).catch((e) => e)).code).toBe('unreachable');
  });

  it('asks for a key before calling a provider that needs one', async () => {
    const gateway = await setup('anthropic');
    global.fetch = jest.fn() as any;
    expect((await ask(gateway).catch((e) => e)).code).toBe('rejected_key');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('the Test button reports failure instead of throwing', async () => {
    const gateway = await setup('local');
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as any;
    const result = await gateway.test(ACTOR);
    expect(result).toMatchObject({ ok: false, code: 'unreachable' });
    global.fetch = jest
      .fn()
      .mockResolvedValue(json({ message: { content: 'ready' } })) as any;
    expect(await gateway.test(ACTOR)).toMatchObject({
      ok: true,
      sample: 'ready',
    });
  });

  it('reads JSON out of replies with fences or chatter', () => {
    const { gateway } = build();
    expect(gateway.parseJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(gateway.parseJson('no json here')).toBeNull();
    expect(gateway.parseJson('{broken')).toBeNull();
  });
});

describe('AgencyAiGatewayService - command-line providers', () => {
  const gateway = () => build().gateway;

  it('builds a fixed, tool-free command for each program', () => {
    const g = gateway();
    expect(
      g.buildCliCommand('claude-cli', {
        model: 'opus',
        thinking: 'high',
        prompt: 'P',
      })
    ).toEqual({
      args: [
        '-p',
        '--output-format',
        'text',
        '--no-session-persistence',
        '--tools',
        '',
        '--model',
        'opus',
        '--effort',
        'high',
      ],
      env: {},
      stdin: 'P',
    });
    expect(
      g.buildCliCommand('claude-cli', {
        model: null,
        thinking: 'off',
        prompt: 'P',
      }).env
    ).toEqual({ MAX_THINKING_TOKENS: '0' });
    expect(
      g.buildCliCommand('codex-cli', {
        model: 'gpt-5',
        thinking: 'medium',
        prompt: 'P',
      })
    ).toEqual({
      args: [
        'exec',
        '--skip-git-repo-check',
        '--ephemeral',
        '--sandbox',
        'read-only',
        '--model',
        'gpt-5',
        '-c',
        'model_reasoning_effort=medium',
        '-',
      ],
      env: {},
      stdin: 'P',
    });
    const agy = g.buildCliCommand('antigravity-cli', {
      model: null,
      thinking: 'low',
      prompt: 'P',
    });
    expect(agy.args).toEqual([
      '--print',
      '--output-format',
      'text',
      '--effort',
      'low',
    ]);
    expect(agy.stdin).toBeUndefined();
  });

  const onPosix = process.platform === 'win32' ? describe.skip : describe;
  onPosix('with a stand-in program on the PATH', () => {
    let dir: string;
    const install = async (name: string, script: string) => {
      const file = path.join(dir, name);
      await fs.writeFile(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    };
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agencyos-cli-'));
      process.env.PATH = `${dir}${path.delimiter}${realEnv.PATH}`;
    });
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    const use = async (provider: string) => {
      const { gateway: g } = build();
      await g.updateSettings(ACTOR, { activeProvider: provider as any });
      return g;
    };

    it('sends the prompt on stdin, keeps secrets out, and returns the reply', async () => {
      process.env.DATABASE_URL = 'postgres://secret';
      await install(
        'claude',
        'echo "args:$*"; echo "db:${DATABASE_URL:-none} jwt:${JWT_SECRET:-none}"; echo "cwd:$(pwd)"; echo "stdin:$(cat)"'
      );
      const g = await use('claude-cli');
      const result = await g.complete('org-1', {
        system: 'SYS',
        messages: [{ role: 'user', content: 'Hello there' }],
      });
      expect(result.text).toContain('args:-p --output-format text');
      expect(result.text).toContain('db:none jwt:none');
      expect(result.text).toContain('agencyos-ai');
      expect(result.text).toContain('stdin:SYS');
      expect(result.text).toContain('Hello there');
    });

    it('explains a missing program, a signed-out program and a crash', async () => {
      const g = await use('codex-cli').catch((e) => e);
      // Not installed
      const missing = await g
        .complete('org-1', {
          messages: [{ role: 'user', content: 'x' }],
        })
        .catch((e: any) => e);
      expect(missing.code).toBe('not_installed');

      await install(
        'codex',
        'echo "Error: not logged in, run codex login" >&2; exit 1'
      );
      const signedOut = await g
        .complete('org-1', {
          messages: [{ role: 'user', content: 'x' }],
        })
        .catch((e: any) => e);
      expect(signedOut.code).toBe('not_signed_in');

      await install('codex', 'echo "boom" >&2; exit 3');
      const crashed = await g
        .complete('org-1', {
          messages: [{ role: 'user', content: 'x' }],
        })
        .catch((e: any) => e);
      expect(crashed.code).toBe('bad_reply');
      expect(crashed.message).toContain('code 3');
    });

    it('stops a program that does not answer', async () => {
      await install('claude', 'sleep 5');
      const g = await use('claude-cli');
      const error = await g
        .complete('org-1', {
          messages: [{ role: 'user', content: 'x' }],
          timeoutMs: 300,
        })
        .catch((e: any) => e);
      expect(error.code).toBe('timeout');
    });

    it('detects installed programs and their version', async () => {
      await install('claude', 'echo "9.9.9 (Claude Code)"');
      const g = gateway();
      const status = await g.status(ACTOR);
      expect(status.find((s) => s.id === 'claude-cli')).toMatchObject({
        ready: true,
        version: '9.9.9 (Claude Code)',
      });
      expect(status.find((s) => s.id === 'codex-cli')).toMatchObject({
        ready: false,
        detail: 'Not installed.',
      });
    });
  });
});
