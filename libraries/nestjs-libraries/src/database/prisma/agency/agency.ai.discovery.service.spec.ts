import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { AgencyAiGatewayService } from './agency.ai.gateway.service';
import { AgencyAiDiscoveryService } from './agency.ai.discovery.service';

const ACTOR = { orgId: 'org-1', userId: 'u-1', role: 'AGENCY_OWNER' } as any;
const realEnv = { ...process.env };
const realFetch = global.fetch;

const build = () => {
  const repo = { get: async () => null, save: async () => null } as any;
  const access = { assert: jest.fn(), audit: jest.fn() } as any;
  const gateway = new AgencyAiGatewayService(repo, access);
  return { gateway, discovery: new AgencyAiDiscoveryService(gateway, access) };
};

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';
  process.env.AGENCYOS_LOCAL = 'true';
});
afterEach(() => {
  process.env = { ...realEnv };
  global.fetch = realFetch;
});

describe('Local models report whether they can think', () => {
  it('reads each installed model’s capabilities from Ollama', async () => {
    global.fetch = jest.fn(async (url: any, init: any) => {
      if (String(url).endsWith('/api/tags')) {
        return {
          ok: true,
          json: async () => ({
            models: [
              { name: 'qwen3:8b' },
              { name: 'gemma3:1b' },
              { name: 'gpt-oss:20b' },
            ],
          }),
        } as any;
      }
      const model = JSON.parse(init.body).model;
      const capabilities =
        model === 'gemma3:1b' ? ['completion'] : ['completion', 'thinking'];
      return { ok: true, json: async () => ({ capabilities }) } as any;
    }) as any;
    const { discovery } = build();
    const list = await discovery.models(ACTOR, 'local');
    expect(list.live).toBe(true);
    const by = (id: string) => list.models.find((m) => m.id === id)!;
    expect(by('gemma3:1b').thinkingLevels).toEqual(['auto']);
    expect(by('qwen3:8b').thinkingLevels).toEqual([
      'auto',
      'off',
      'low',
      'medium',
      'high',
    ]);
    expect(by('gpt-oss:20b').thinkingLevels).toEqual([
      'auto',
      'low',
      'medium',
      'high',
    ]);
  });
});

const onPosix = process.platform === 'win32' ? describe.skip : describe;
onPosix('Command-line tools report their own models', () => {
  let dir: string;
  const install = (name: string, script: string) =>
    fs.writeFile(path.join(dir, name), `#!/bin/sh\n${script}\n`, {
      mode: 0o755,
    });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agencyos-disc-'));
    process.env.PATH = `${dir}${path.delimiter}${realEnv.PATH}`;
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('Claude Code: models and the effort levels each supports, from its own reply', async () => {
    const models = JSON.stringify([
      {
        value: 'default',
        displayName: 'Default (recommended)',
        description: 'Sonnet',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        value: 'haiku',
        displayName: 'Haiku',
        description: 'Fast',
        supportsEffort: false,
      },
      {
        value: 'fable',
        displayName: 'Fable',
        supportedEffortLevels: ['low', 'banana', 'high'],
        supportsEffort: true,
      },
    ]);
    await install(
      'claude',
      `read line
echo '{"type":"control_response","response":{"subtype":"success","request_id":"agencyos-models","response":{"models":${models}}}}'
cat >/dev/null`
    );
    const { discovery } = build();
    const list = await discovery.models(ACTOR, 'claude-cli');
    expect(list.live).toBe(true);
    const by = (id: string) => list.models.find((m) => m.id === id)!;
    expect(by('default')).toMatchObject({
      label: 'Default (recommended)',
      isDefault: true,
    });
    expect(by('default').thinkingLevels).toEqual([
      'auto',
      'off',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    // A model without effort support still has the on/off switch; unknown levels are dropped.
    expect(by('haiku').thinkingLevels).toEqual(['auto', 'off']);
    expect(by('fable').thinkingLevels).toEqual(['auto', 'off', 'low', 'high']);
  });

  it('Codex: asks the app-server for model/list', async () => {
    await install(
      'codex',
      `[ "$1" = "app-server" ] || exit 9
read a; echo '{"id":1,"result":{"userAgent":"codex"}}'
read b
read c; echo '{"id":2,"result":{"data":[{"id":"gpt-x","model":"gpt-x","displayName":"GPT X","isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"},{"reasoningEffort":"xhigh"}]},{"id":"hidden","hidden":true}]}}'
cat >/dev/null`
    );
    const { discovery } = build();
    const list = await discovery.models(ACTOR, 'codex-cli');
    expect(list.live).toBe(true);
    expect(list.models).toHaveLength(1);
    expect(list.models[0]).toMatchObject({
      id: 'gpt-x',
      label: 'GPT X',
      isDefault: true,
    });
    expect(list.models[0].thinkingLevels).toEqual([
      'auto',
      'low',
      'high',
      'xhigh',
    ]);
  });

  it('Antigravity: reads `agy models` forgivingly', async () => {
    await install(
      'agy',
      `[ "$1" = "models" ] || exit 9
printf 'Available models:\\n  * gemini-3.1-pro-high (default)\\n  * gemini-3.6-flash-low\\n  * claude-sonnet-4.6\\n- gemini-3.6-flash-low\\n'`
    );
    const { discovery } = build();
    const list = await discovery.models(ACTOR, 'antigravity-cli');
    expect(list.live).toBe(true);
    expect(list.models.map((m) => m.id)).toEqual([
      'gemini-3.1-pro-high',
      'gemini-3.6-flash-low',
      'claude-sonnet-4.6',
    ]);
    expect(list.models[0]).toMatchObject({
      isDefault: true,
      thinkingLevels: ['auto'],
    });
    expect(list.models[2].thinkingLevels).toEqual([
      'auto',
      'low',
      'medium',
      'high',
    ]);
  });

  it('falls back to suggestions, and says why, when the tool cannot answer', async () => {
    const { discovery } = build();
    // Nothing installed under these names on the PATH of this test.
    jest
      .spyOn((discovery as any).gateway, 'findBinary')
      .mockResolvedValue(null);
    const list = await discovery.models(ACTOR, 'claude-cli');
    expect(list.live).toBe(false);
    expect(list.note).toMatch(/not installed/);
    expect(list.models.length).toBeGreaterThan(0);

    await install('agy', 'echo "nothing useful here"');
    (discovery as any).gateway.findBinary.mockRestore();
    const agy = await discovery.models(ACTOR, 'antigravity-cli');
    expect(agy.live).toBe(false);
    expect(agy.note).toMatch(/Type a model name/);
  });

  it('keeps the answer for ten minutes unless asked to look again', async () => {
    await install(
      'agy',
      `echo run >> "${dir}/runs"; echo gemini-3.6-flash-low`
    );
    const { discovery } = build();
    await discovery.models(ACTOR, 'antigravity-cli');
    await discovery.models(ACTOR, 'antigravity-cli');
    expect(
      (await fs.readFile(`${dir}/runs`, 'utf8')).trim().split('\n')
    ).toHaveLength(1);
    await discovery.models(ACTOR, 'antigravity-cli', true);
    expect(
      (await fs.readFile(`${dir}/runs`, 'utf8')).trim().split('\n')
    ).toHaveLength(2);
  });

  it('stays out of the desktop-only tools on a server', async () => {
    process.env.AGENCYOS_LOCAL = 'false';
    const { discovery } = build();
    const list = await discovery.models(ACTOR, 'claude-cli');
    expect(list.live).toBe(false);
    expect(list.note).toMatch(/desktop app/);
  });
});
