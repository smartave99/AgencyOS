import { Injectable, Logger } from '@nestjs/common';
import {
  AgencyAccessService,
  AgencyActor,
} from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import {
  AgencyAiGatewayService,
  AiProviderError,
  ModelInfo,
  ModelList,
} from '@gitroom/nestjs-libraries/database/prisma/agency/agency.ai.gateway.service';
import {
  AiProviderId,
  THINKING_LEVELS,
  ThinkingLevel,
} from '@gitroom/nestjs-libraries/dtos/agency/ai.settings.dto';

const CACHE_MS = 10 * 60_000;
const ASK_TIMEOUT_MS = 30_000;

/** The effort names a tool reports, narrowed to the ones AgencyOS knows how to pass back. */
const knownLevels = (names: unknown[]): ThinkingLevel[] =>
  [...new Set(names)]
    .filter(
      (n): n is ThinkingLevel =>
        typeof n === 'string' &&
        n !== 'auto' &&
        n !== 'off' &&
        (THINKING_LEVELS as readonly string[]).includes(n)
    )
    .sort(
      (a, b) =>
        (THINKING_LEVELS as readonly string[]).indexOf(a) -
        (THINKING_LEVELS as readonly string[]).indexOf(b)
    );

/**
 * Asks each command-line tool which models it offers and how hard each can think, so the lists
 * come from the tool itself and follow its updates. Claude Code and Codex answer over their own
 * protocols; Antigravity has a `models` command. Anything else falls back to suggestions, and the
 * reason is shown.
 */
@Injectable()
export class AgencyAiDiscoveryService {
  private readonly logger = new Logger(AgencyAiDiscoveryService.name);
  private readonly cache = new Map<
    AiProviderId,
    { at: number; value: ModelList }
  >();

  constructor(
    private readonly gateway: AgencyAiGatewayService,
    private readonly access: AgencyAccessService
  ) {}

  async models(
    actor: AgencyActor,
    id: AiProviderId,
    refresh = false
  ): Promise<ModelList> {
    this.access.assert(actor, 'ai:use');
    const tool = this.gateway.cliTools().find((t) => t.id === id);
    if (!tool) return this.gateway.listModels(actor, id);

    const suggestions = async (note: string): Promise<ModelList> => ({
      ...(await this.gateway
        .listModels(actor, id)
        .catch(() => ({ models: [], live: false }))),
      live: false,
      note,
    });
    if (process.env.AGENCYOS_LOCAL !== 'true') {
      return suggestions('Only available in the AgencyOS desktop app.');
    }

    const cached = this.cache.get(id);
    if (!refresh && cached && Date.now() - cached.at < CACHE_MS) {
      return cached.value;
    }
    try {
      const models =
        id === 'claude-cli'
          ? await this.claude()
          : id === 'codex-cli'
          ? await this.codex()
          : await this.antigravity();
      if (!models.length) {
        return suggestions(
          `${tool.binary} answered, but not with a list AgencyOS understands. Type a model name instead.`
        );
      }
      const value: ModelList = { models, live: true };
      this.cache.set(id, { at: Date.now(), value });
      return value;
    } catch (error) {
      this.logger.warn(
        `${id}: model discovery failed: ${(error as Error).message}`
      );
      return suggestions(
        error instanceof AiProviderError
          ? error.message
          : `Could not ask ${tool.binary} for its models.`
      );
    }
  }

  /** Claude Code's own initialize reply lists its models and the effort levels each supports. */
  private async claude(): Promise<ModelInfo[]> {
    const reply = await this.gateway.converse(
      'claude-cli',
      [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--tools',
        '',
      ],
      ASK_TIMEOUT_MS,
      async (io) => {
        io.send({
          type: 'control_request',
          request_id: 'agencyos-models',
          request: { subtype: 'initialize' },
        });
        return io.next(
          (m) =>
            m?.type === 'control_response' &&
            m.response?.request_id === 'agencyos-models'
        );
      }
    );
    const list = reply?.response?.response?.models;
    if (!Array.isArray(list)) return [];
    return list
      .filter((m: any) => typeof m?.value === 'string' && m.value)
      .map((m: any) => ({
        id: m.value,
        label: m.displayName || m.value,
        description:
          typeof m.description === 'string' ? m.description : undefined,
        isDefault: m.value === 'default',
        // Effort is chosen with --effort; "off" is a separate switch that works on any model.
        thinkingLevels: [
          'auto',
          'off',
          ...(m.supportsEffort === false
            ? []
            : knownLevels(m.supportedEffortLevels ?? [])),
        ] as ThinkingLevel[],
      }));
  }

  /** Codex's app-server answers model/list with each model's supported reasoning efforts. */
  private async codex(): Promise<ModelInfo[]> {
    const reply = await this.gateway.converse(
      'codex-cli',
      ['app-server'],
      ASK_TIMEOUT_MS,
      async (io) => {
        io.send({
          method: 'initialize',
          id: 1,
          params: {
            clientInfo: {
              name: 'agencyos',
              title: 'AgencyOS',
              version: '1.2.0',
            },
          },
        });
        await io.next((m) => m?.id === 1);
        io.send({ method: 'initialized', params: {} });
        io.send({ method: 'model/list', id: 2, params: {} });
        return io.next((m) => m?.id === 2);
      }
    );
    const data = reply?.result?.data ?? reply?.result?.models;
    if (!Array.isArray(data)) return [];
    return data
      .filter((m: any) => !m?.hidden)
      .map((m: any) => {
        const id = String(m?.model ?? m?.id ?? '');
        const efforts = (m?.supportedReasoningEfforts ?? []).map((e: any) =>
          typeof e === 'string' ? e : e?.reasoningEffort ?? e?.effort
        );
        return {
          id,
          label: m?.displayName || id,
          description:
            typeof m?.description === 'string' ? m.description : undefined,
          isDefault: !!m?.isDefault,
          thinkingLevels: ['auto', ...knownLevels(efforts)] as ThinkingLevel[],
        };
      })
      .filter((m: ModelInfo) => m.id);
  }

  /** `agy models` prints the model names the signed-in account can use. */
  private async antigravity(): Promise<ModelInfo[]> {
    const text = await this.gateway.runTool(
      'antigravity-cli',
      ['models'],
      ASK_TIMEOUT_MS
    );
    return this.parseAntigravityModels(text);
  }

  /**
   * The output format is not documented, so this reads it forgivingly: the first word of each
   * line that looks like a model name. A name that ends in -low, -medium or -high already carries
   * its effort, so it offers no separate thinking choice.
   */
  parseAntigravityModels(text: string): ModelInfo[] {
    const skip = new Set([
      'model',
      'models',
      'name',
      'id',
      'available',
      'default',
    ]);
    const seen = new Set<string>();
    const out: ModelInfo[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/^[\s*>•·-]+/, '').trim();
      const word = line.split(/\s+/)[0]?.replace(/[,:;]+$/, '');
      if (
        !word ||
        skip.has(word.toLowerCase()) ||
        !/^[a-z0-9][a-z0-9._:-]{2,}$/i.test(word) ||
        !/[-.\d]/.test(word) ||
        seen.has(word)
      ) {
        continue;
      }
      seen.add(word);
      const carriesEffort = /-(minimal|low|medium|high)$/i.test(word);
      out.push({
        id: word,
        label: word,
        isDefault: /\(default\)|\bdefault\b/i.test(line),
        thinkingLevels: carriesEffort
          ? ['auto']
          : ['auto', 'low', 'medium', 'high'],
      });
    }
    return out;
  }
}
