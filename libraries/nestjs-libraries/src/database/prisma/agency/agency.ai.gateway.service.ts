import { HttpException, Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { AgencyAiRepository } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.ai.repository';
import {
  AgencyAccessService,
  AgencyActor,
} from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import {
  AI_PROVIDER_IDS,
  AI_TASKS,
  AiProviderId,
  AiTask,
  MODEL_NAME,
  THINKING_LEVELS,
  ThinkingLevel,
  UpdateAiSettingsDto,
} from '@gitroom/nestjs-libraries/dtos/agency/ai.settings.dto';

export type ProviderKind = 'local' | 'cli' | 'api';

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  system?: string;
  messages: AiMessage[];
  /** Ask for a JSON object; a schema lets providers that support one enforce it. */
  json?: Record<string, unknown> | true;
  maxTokens?: number;
  /** Used when the thinking level is "auto", for jobs that do not need reasoning. */
  thinkingWhenAuto?: ThinkingLevel;
  /** Ask a specific provider instead of the active one (the Test button). */
  provider?: AiProviderId;
  /** Which job this is, so it can use the model and thinking level chosen for it. */
  task?: AiTask;
  timeoutMs?: number;
}

export interface AiResult {
  text: string;
  provider: AiProviderId;
  model: string | null;
  ms: number;
  notes: string[];
}

/** One model a provider offers, with the thinking levels it supports when the provider says so. */
export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
  /** Levels this model accepts; absent when the provider does not say. */
  thinkingLevels?: ThinkingLevel[];
  isDefault?: boolean;
}

export interface ModelList {
  models: ModelInfo[];
  /** True when the list came from the provider itself rather than from AgencyOS's own suggestions. */
  live: boolean;
  note?: string;
}

/** The two ends of a short JSON-lines conversation with one of the tools. */
export interface ConverseIo {
  send(message: unknown): void;
  /** The next message the program sends that satisfies `match`. */
  next(match: (message: any) => boolean): Promise<any>;
}

export type AiErrorCode =
  | 'not_installed'
  | 'not_signed_in'
  | 'rejected_key'
  | 'unreachable'
  | 'model_missing'
  | 'rate_limited'
  | 'timeout'
  | 'busy'
  | 'unavailable'
  | 'bad_reply';

/** A provider problem the person can act on; the message says what to do. */
export class AiProviderError extends Error {
  constructor(public readonly code: AiErrorCode, message: string) {
    super(message);
  }
}

interface ProviderSpec {
  id: AiProviderId;
  label: string;
  kind: ProviderKind;
  summary: string;
  setup: string;
  binary?: string;
  needsKey: boolean;
  keyOptional?: boolean;
  baseUrl?: { value: string; editable: boolean };
  thinking: ThinkingLevel[];
  models: string[];
  experimental?: boolean;
}

interface StoredEntry {
  model?: string;
  baseUrl?: string;
  /** AES-256-GCM, see seal(). */
  apiKey?: string;
}
type StoredProviders = Partial<Record<AiProviderId, StoredEntry>>;
interface StoredTask {
  provider?: AiProviderId;
  model?: string;
  thinking?: ThinkingLevel;
}
type StoredTasks = Partial<Record<AiTask, StoredTask>>;

interface Resolved {
  spec: ProviderSpec;
  model: string | null;
  baseUrl: string;
  apiKey: string | null;
  thinking: ThinkingLevel;
}

export interface ProviderView {
  id: AiProviderId;
  label: string;
  kind: ProviderKind;
  summary: string;
  setup: string;
  experimental: boolean;
  needsKey: boolean;
  keyOptional: boolean;
  baseUrlEditable: boolean;
  thinkingLevels: ThinkingLevel[];
  suggestedModels: string[];
  model: string | null;
  baseUrl: string;
  hasKey: boolean;
  keySource: 'saved' | 'environment' | null;
  /** False for providers that cannot work here, e.g. command-line tools off the desktop app. */
  selectable: boolean;
  /** Why it cannot be used here, in words for the person. */
  unavailable: string | null;
}

export interface AiSettingsView {
  localMode: boolean;
  activeProvider: AiProviderId;
  thinking: ThinkingLevel;
  providers: ProviderView[];
  /** What each job uses instead of the default; a missing field means "same as the default". */
  tasks: Record<
    AiTask,
    {
      provider: AiProviderId | null;
      model: string | null;
      thinking: ThinkingLevel | null;
    }
  >;
}

export interface ProviderStatus {
  id: AiProviderId;
  /** local: server answered. cli: program found. api: a key is saved. */
  ready: boolean;
  detail: string;
  version?: string;
  models?: string[];
}

const CLI_SAFE_ARG = /^[A-Za-z0-9._:/=+-]*$/;
const CLI_CONCURRENCY = 2;
const DEFAULT_API_TIMEOUT_MS = 90_000;
const DEFAULT_CLI_TIMEOUT_MS = 120_000;
const MAX_CLI_OUTPUT = 1_000_000;
const ENV_NEVER_SHARED = [
  'JWT_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'AGENCYOS_LOCAL_KEY',
  'TEMPORAL_ADDRESS',
];

@Injectable()
export class AgencyAiGatewayService {
  private readonly logger = new Logger(AgencyAiGatewayService.name);
  private cliInFlight = 0;
  /** Tools being updated right now: the program must not be started or replaced under a run. */
  private readonly updating = new Set<AiProviderId>();

  constructor(
    private readonly repo: AgencyAiRepository,
    private readonly access: AgencyAccessService
  ) {}

  // ==========================================
  // CATALOG
  // ==========================================
  private get isLocalMode() {
    return process.env.AGENCYOS_LOCAL === 'true';
  }

  /**
   * Why a provider cannot be used here, or null. Command-line tools exist only on the
   * person's own computer. On a server, text only leaves for an outside AI service when the
   * operator has allowed it (AGENCY_ALLOW_EXTERNAL_AI=true); in the desktop app the person
   * is the operator, and choosing the provider and saving a key is the opt-in.
   */
  private unavailable(spec: ProviderSpec): string | null {
    if (this.isLocalMode) return null;
    if (spec.kind === 'cli')
      return 'Only available in the AgencyOS desktop app.';
    if (
      spec.kind === 'api' &&
      process.env.AGENCY_ALLOW_EXTERNAL_AI !== 'true'
    ) {
      return 'Switched off on this server. An administrator can allow outside AI services with AGENCY_ALLOW_EXTERNAL_AI=true.';
    }
    return null;
  }

  private catalog(): ProviderSpec[] {
    const ollama =
      process.env.OLLAMA_HOST ||
      process.env.OLLAMA_URL ||
      'http://localhost:11434';
    return [
      {
        id: 'local',
        label: 'Local model (Ollama)',
        kind: 'local',
        summary:
          'Runs on this computer. Private, free and works offline; speed depends on your hardware.',
        setup:
          'AgencyOS installs Ollama and a small model for you. To use another model, pull it in Ollama and pick it here.',
        needsKey: false,
        baseUrl: { value: ollama, editable: true },
        thinking: ['auto', 'off', 'low', 'medium', 'high'],
        models: [],
      },
      {
        id: 'claude-cli',
        label: 'Claude Code',
        kind: 'cli',
        summary:
          'Uses the Claude Code program on this computer, with your own Claude sign-in.',
        setup:
          'Install Claude Code, open a terminal, run “claude” once and sign in. AgencyOS then uses that sign-in.',
        binary: 'claude',
        needsKey: false,
        thinking: ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'],
        models: ['sonnet', 'opus', 'haiku'],
      },
      {
        id: 'codex-cli',
        label: 'Codex CLI',
        kind: 'cli',
        summary:
          'Uses the OpenAI Codex program on this computer, with your own ChatGPT or API sign-in.',
        setup:
          'Install the Codex CLI, run “codex” once in a terminal and sign in. Leave the model empty to use Codex’s own default.',
        binary: 'codex',
        needsKey: false,
        thinking: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
        models: [],
      },
      {
        id: 'antigravity-cli',
        label: 'Antigravity CLI',
        kind: 'cli',
        summary:
          'Uses the Google Antigravity program (agy) on this computer, with your own Google sign-in.',
        setup:
          'Install Antigravity, run “agy” once in a terminal and sign in, then press Test. Support is experimental: it depends on the version you have installed.',
        binary: 'agy',
        needsKey: false,
        thinking: ['auto', 'low', 'medium', 'high'],
        models: [],
        experimental: true,
      },
      {
        id: 'anthropic',
        label: 'Anthropic API',
        kind: 'api',
        summary:
          'Claude models over the Anthropic API, billed to your API key.',
        setup: 'Create an API key in the Anthropic Console and paste it here.',
        needsKey: true,
        baseUrl: { value: 'https://api.anthropic.com', editable: false },
        thinking: ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'],
        models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
      },
      {
        id: 'openai',
        label: 'OpenAI API',
        kind: 'api',
        summary: 'GPT models over the OpenAI API, billed to your API key.',
        setup: 'Create an API key on the OpenAI platform and paste it here.',
        needsKey: true,
        baseUrl: { value: 'https://api.openai.com/v1', editable: false },
        thinking: ['auto', 'low', 'medium', 'high'],
        models: ['gpt-4o-mini', 'gpt-5', 'gpt-5-mini'],
      },
      {
        id: 'gemini',
        label: 'Google Gemini API',
        kind: 'api',
        summary:
          'Gemini models over the Google AI API, billed to your API key.',
        setup: 'Create an API key in Google AI Studio and paste it here.',
        needsKey: true,
        baseUrl: {
          value: 'https://generativelanguage.googleapis.com',
          editable: false,
        },
        thinking: ['auto', 'off', 'low', 'medium', 'high'],
        models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
      },
      {
        id: 'openai-compatible',
        label: 'Other OpenAI-compatible API',
        kind: 'api',
        summary:
          'Any service that speaks the OpenAI chat API: LM Studio, OpenRouter, a company gateway.',
        setup:
          'Enter the service address (for example http://localhost:1234/v1), a model name and, if it needs one, a key.',
        needsKey: false,
        keyOptional: true,
        baseUrl: { value: 'http://localhost:1234/v1', editable: true },
        thinking: ['auto'],
        models: [],
      },
    ];
  }

  private spec(id: AiProviderId): ProviderSpec {
    const spec = this.catalog().find((s) => s.id === id);
    if (!spec) throw new HttpException('Unknown AI provider', 400);
    return spec;
  }

  // ==========================================
  // SECRETS (AES-256-GCM, key derived from the install's JWT_SECRET)
  // ==========================================
  private secretKey(): Buffer {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new HttpException('The server has no secret to protect keys', 500);
    }
    return Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(secret),
        Buffer.from('agencyos-ai-keys'),
        Buffer.from('api-key-v1'),
        32
      )
    );
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.secretKey(), iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      body.toString('base64'),
    ].join('.');
  }

  open(sealed: string): string | null {
    try {
      const [version, iv, tag, body] = sealed.split('.');
      if (version !== 'v1') return null;
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.secretKey(),
        Buffer.from(iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(body, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // A different install secret or a damaged value: ask for the key again.
      return null;
    }
  }

  // ==========================================
  // SETTINGS
  // ==========================================
  private async load(orgId: string) {
    const row = await this.repo.get(orgId);
    const providers = (
      row?.providers && typeof row.providers === 'object' ? row.providers : {}
    ) as StoredProviders;
    const active = AI_PROVIDER_IDS.includes(row?.activeProvider as AiProviderId)
      ? (row!.activeProvider as AiProviderId)
      : 'local';
    const thinking = THINKING_LEVELS.includes(row?.thinking as ThinkingLevel)
      ? (row!.thinking as ThinkingLevel)
      : 'auto';
    const rawTasks = (
      row?.tasks && typeof row.tasks === 'object' ? row.tasks : {}
    ) as StoredTasks;
    return { exists: !!row, active, thinking, providers, tasks: rawTasks };
  }

  private envKey(id: AiProviderId): string | null {
    const names: Partial<Record<AiProviderId, string[]>> = {
      openai: ['OPENAI_API_KEY'],
      anthropic: ['ANTHROPIC_API_KEY'],
      gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    };
    for (const name of names[id] ?? []) {
      if (process.env[name]) return process.env[name]!;
    }
    return null;
  }

  private keyFor(id: AiProviderId, entry?: StoredEntry) {
    const saved = entry?.apiKey ? this.open(entry.apiKey) : null;
    if (saved) return { key: saved, source: 'saved' as const };
    const env = this.envKey(id);
    return env
      ? { key: env, source: 'environment' as const }
      : { key: null, source: null };
  }

  private defaultModel(id: AiProviderId): string | null {
    if (id === 'local') {
      return process.env.AI_MODEL || process.env.OLLAMA_MODEL || 'qwen2.5:3b';
    }
    if (id === 'openai') return process.env.OPENAI_MODEL || 'gpt-4o-mini';
    return this.spec(id).models[0] && this.spec(id).kind === 'api'
      ? this.spec(id).models[0]
      : null;
  }

  async getSettings(actor: AgencyActor): Promise<AiSettingsView> {
    this.access.assert(actor, 'ai:use');
    const cfg = await this.load(actor.orgId);
    return {
      localMode: this.isLocalMode,
      activeProvider: cfg.active,
      thinking: cfg.thinking,
      tasks: Object.fromEntries(
        AI_TASKS.map((task) => [
          task,
          {
            provider: cfg.tasks[task]?.provider ?? null,
            model: cfg.tasks[task]?.model ?? null,
            thinking: cfg.tasks[task]?.thinking ?? null,
          },
        ])
      ) as AiSettingsView['tasks'],
      providers: this.catalog().map((spec) => {
        const entry = cfg.providers[spec.id];
        const { key, source } = this.keyFor(spec.id, entry);
        return {
          id: spec.id,
          label: spec.label,
          kind: spec.kind,
          summary: spec.summary,
          setup: spec.setup,
          experimental: !!spec.experimental,
          needsKey: spec.needsKey,
          keyOptional: !!spec.keyOptional,
          baseUrlEditable: !!spec.baseUrl?.editable,
          thinkingLevels: spec.thinking,
          suggestedModels: spec.models,
          model: entry?.model ?? null,
          baseUrl: entry?.baseUrl || spec.baseUrl?.value || '',
          hasKey: !!key,
          keySource: source,
          selectable: !this.unavailable(spec),
          unavailable: this.unavailable(spec),
        };
      }),
    };
  }

  async updateSettings(
    actor: AgencyActor,
    dto: UpdateAiSettingsDto
  ): Promise<AiSettingsView> {
    this.access.assert(actor, 'ai:configure');
    const cfg = await this.load(actor.orgId);
    const providers: StoredProviders = { ...cfg.providers };

    for (const [rawId, input] of Object.entries(dto.providers ?? {})) {
      if (!AI_PROVIDER_IDS.includes(rawId as AiProviderId)) {
        throw new HttpException(`Unknown AI provider “${rawId}”`, 400);
      }
      const id = rawId as AiProviderId;
      const spec = this.spec(id);
      const entry: StoredEntry = { ...(providers[id] ?? {}) };
      if (input?.model !== undefined) {
        const model = String(input.model).trim();
        if (model && !MODEL_NAME.test(model)) {
          throw new HttpException(
            'Model names use letters, digits and . _ : / - only',
            400
          );
        }
        if (model) entry.model = model;
        else delete entry.model;
      }
      if (input?.baseUrl !== undefined) {
        const url = String(input.baseUrl).trim();
        if (url && !spec.baseUrl?.editable) {
          throw new HttpException(`${spec.label} has a fixed address`, 400);
        }
        if (url) entry.baseUrl = this.checkUrl(url);
        else delete entry.baseUrl;
      }
      if (input?.apiKey !== undefined) {
        const key = String(input.apiKey).trim();
        if (key && !spec.needsKey && !spec.keyOptional) {
          throw new HttpException(`${spec.label} does not use an API key`, 400);
        }
        if (/\s/.test(key) || key.length > 600) {
          throw new HttpException('That does not look like an API key', 400);
        }
        if (key) entry.apiKey = this.seal(key);
        else delete entry.apiKey;
      }
      providers[id] = entry;
    }

    const active = dto.activeProvider ?? cfg.active;
    const activeSpec = this.spec(active);
    const blocked = this.unavailable(activeSpec);
    if (blocked) throw new HttpException(blocked, 400);
    const thinking = dto.thinking ?? cfg.thinking;
    if (!activeSpec.thinking.includes(thinking)) {
      throw new HttpException(
        `${activeSpec.label} does not support the “${thinking}” thinking level`,
        400
      );
    }

    const tasks = this.mergeTasks(cfg.tasks, dto.tasks);

    await this.repo.save(actor.orgId, {
      activeProvider: active,
      thinking,
      providers: providers as any,
      tasks: tasks as any,
    });
    await this.access.audit(actor, {
      action: 'ai.settings_updated',
      entityType: 'AgencyAiConfig',
      summary: `${activeSpec.label}, thinking ${thinking}`,
      metadata: {
        activeProvider: active,
        thinking,
        providersChanged: Object.keys(dto.providers ?? {}),
        tasksChanged: Object.keys(dto.tasks ?? {}),
      },
    });
    return this.getSettings(actor);
  }

  /** Applies the per-job choices from a settings update, refusing anything that cannot work. */
  private mergeTasks(
    current: StoredTasks,
    input: UpdateAiSettingsDto['tasks']
  ): StoredTasks {
    const out: StoredTasks = { ...current };
    for (const [rawTask, value] of Object.entries(input ?? {})) {
      if (!AI_TASKS.includes(rawTask as AiTask)) {
        throw new HttpException(`Unknown job “${rawTask}”`, 400);
      }
      const task = rawTask as AiTask;
      if (value === null) {
        delete out[task];
        continue;
      }
      const next: StoredTask = { ...(out[task] ?? {}) };
      if (value.provider !== undefined) {
        const provider = String(value.provider);
        if (!provider) {
          delete next.provider;
        } else {
          if (!AI_PROVIDER_IDS.includes(provider as AiProviderId)) {
            throw new HttpException(`Unknown AI provider “${provider}”`, 400);
          }
          const blocked = this.unavailable(this.spec(provider as AiProviderId));
          if (blocked) throw new HttpException(blocked, 400);
          next.provider = provider as AiProviderId;
        }
      }
      if (value.model !== undefined) {
        const model = String(value.model).trim();
        if (model && !MODEL_NAME.test(model)) {
          throw new HttpException(
            'Model names use letters, digits and . _ : / - only',
            400
          );
        }
        if (model) next.model = model;
        else delete next.model;
      }
      if (value.thinking !== undefined) {
        const thinking = String(value.thinking);
        if (!thinking) {
          delete next.thinking;
        } else if (!THINKING_LEVELS.includes(thinking as ThinkingLevel)) {
          throw new HttpException(`Unknown thinking level “${thinking}”`, 400);
        } else {
          next.thinking = thinking as ThinkingLevel;
        }
      }
      if (Object.keys(next).length) out[task] = next;
      else delete out[task];
    }
    return out;
  }

  private checkUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new HttpException('That address is not a valid web address', 400);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username) {
      throw new HttpException('Use an http or https address', 400);
    }
    return value.replace(/\/+$/, '');
  }

  /**
   * Which provider, model and thinking level answers. An explicit provider (the Test button) wins;
   * otherwise the job's own choice; otherwise the default. Whatever a job does not set follows
   * the provider it ends up using.
   */
  private async resolve(
    orgId: string,
    override?: AiProviderId,
    task?: AiTask
  ): Promise<Resolved> {
    const cfg = await this.load(orgId);
    const own = task && !override ? cfg.tasks[task] : undefined;
    const id = override ?? own?.provider ?? cfg.active;
    const spec = this.spec(id);
    const blocked = this.unavailable(spec);
    if (blocked) throw new AiProviderError('unavailable', blocked);
    const entry = cfg.providers[id];
    const { key } = this.keyFor(id, entry);
    const wanted = own?.thinking ?? (id === cfg.active ? cfg.thinking : 'auto');
    return {
      spec,
      model: own?.model || entry?.model || this.defaultModel(id),
      baseUrl: entry?.baseUrl || spec.baseUrl?.value || '',
      apiKey: key,
      thinking: spec.thinking.includes(wanted) ? wanted : 'auto',
    };
  }

  // ==========================================
  // ASKING A MODEL
  // ==========================================
  async complete(orgId: string, req: AiRequest): Promise<AiResult> {
    const started = Date.now();
    const resolved = await this.resolve(orgId, req.provider, req.task);
    const notes: string[] = [];
    const thinking =
      resolved.thinking === 'auto' && req.thinkingWhenAuto
        ? req.thinkingWhenAuto
        : resolved.thinking;
    const withThinking = { ...resolved, thinking };

    let text: string;
    switch (resolved.spec.kind) {
      case 'cli':
        text = await this.askCli(withThinking, req);
        break;
      default:
        text = await this.askApi(withThinking, req, notes);
    }
    return {
      text: text.trim(),
      provider: resolved.spec.id,
      model: resolved.model,
      ms: Date.now() - started,
      notes,
    };
  }

  /** The Test button: one tiny question, with the failure reason spelled out. */
  async test(actor: AgencyActor, provider?: AiProviderId, task?: AiTask) {
    this.access.assert(actor, 'ai:use');
    const started = Date.now();
    try {
      const result = await this.complete(actor.orgId, {
        provider,
        task,
        system: 'You are a connection test. Answer in one short sentence.',
        messages: [
          { role: 'user', content: 'Reply with the single word: ready' },
        ],
        maxTokens: 64,
        thinkingWhenAuto: 'off',
        timeoutMs: 60_000,
      });
      return {
        ok: true as const,
        provider: result.provider,
        model: result.model,
        ms: result.ms,
        sample: result.text.slice(0, 200),
        notes: result.notes,
      };
    } catch (error) {
      return {
        ok: false as const,
        provider: provider ?? (await this.load(actor.orgId)).active,
        ms: Date.now() - started,
        code: error instanceof AiProviderError ? error.code : 'unavailable',
        error: error instanceof Error ? error.message : 'The test failed',
      };
    }
  }

  // ==========================================
  // API AND LOCAL-SERVER PROVIDERS
  // ==========================================
  private timeout(req: AiRequest) {
    return (
      req.timeoutMs ||
      Number.parseInt(process.env.AGENCY_AI_TIMEOUT_MS || '', 10) ||
      DEFAULT_API_TIMEOUT_MS
    );
  }

  private async askApi(
    r: Resolved,
    req: AiRequest,
    notes: string[]
  ): Promise<string> {
    if (r.spec.needsKey && !r.apiKey) {
      throw new AiProviderError(
        'rejected_key',
        `Add your ${r.spec.label} key in Settings → AI and Copilot.`
      );
    }
    const attempt = (thinking: ThinkingLevel) => this.sendApi(r, req, thinking);
    try {
      return await attempt(r.thinking);
    } catch (error) {
      // A model that does not know the thinking setting answers 400; it still can answer.
      if (
        error instanceof AiProviderError &&
        error.code === 'bad_reply' &&
        /HTTP 400/.test(error.message) &&
        r.thinking !== 'auto' &&
        r.thinking !== 'off'
      ) {
        notes.push(
          `This model did not accept the “${r.thinking}” thinking level, so it answered without it.`
        );
        return attempt('auto');
      }
      throw error;
    }
  }

  private async sendApi(
    r: Resolved,
    req: AiRequest,
    thinking: ThinkingLevel
  ): Promise<string> {
    const timeoutMs = this.timeout(req);
    switch (r.spec.id) {
      case 'local':
        return this.askOllama(r, req, thinking, timeoutMs);
      case 'anthropic':
        return this.askAnthropic(r, req, thinking, timeoutMs);
      case 'gemini':
        return this.askGemini(r, req, thinking, timeoutMs);
      default:
        return this.askOpenAiStyle(r, req, thinking, timeoutMs);
    }
  }

  private async http(
    r: Resolved,
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown },
    timeoutMs: number
  ): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: init.method ?? 'POST',
        headers: { 'Content-Type': 'application/json', ...init.headers },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw this.httpError(r, res.status, await res.text().catch(() => ''));
      }
      return await res.json();
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if ((error as Error)?.name === 'AbortError') {
        throw new AiProviderError(
          'timeout',
          `${r.spec.label} did not answer within ${Math.round(
            timeoutMs / 1000
          )} seconds.`
        );
      }
      throw new AiProviderError(
        'unreachable',
        r.spec.id === 'local'
          ? `Ollama is not running at ${r.baseUrl}. Start Ollama (it starts with AgencyOS) and try again.`
          : `Could not reach ${r.spec.label} at ${r.baseUrl}. Check the address and your connection.`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private httpError(r: Resolved, status: number, body: string) {
    const scrub = (text: string) =>
      r.apiKey ? text.split(r.apiKey).join('***') : text;
    const excerpt = scrub(body).replace(/\s+/g, ' ').slice(0, 200);
    if (status === 401 || status === 403) {
      return new AiProviderError(
        'rejected_key',
        `${r.spec.label} rejected the key. Check it in Settings → AI and Copilot.`
      );
    }
    if (status === 404) {
      return new AiProviderError(
        'model_missing',
        r.spec.id === 'local'
          ? `The model “${r.model}” is not installed in Ollama. Pull it, or pick an installed one in Settings.`
          : `${r.spec.label} does not know the model “${r.model}”. Pick another in Settings.`
      );
    }
    if (status === 429) {
      return new AiProviderError(
        'rate_limited',
        `${r.spec.label} is rate limiting requests. Try again in a minute.`
      );
    }
    return new AiProviderError(
      'bad_reply',
      `${r.spec.label} answered HTTP ${status}${excerpt ? `: ${excerpt}` : ''}`
    );
  }

  private budgetFor(level: ThinkingLevel) {
    return {
      low: 2048,
      medium: 8192,
      high: 16384,
      xhigh: 24576,
      max: 32000,
    }[level as 'low' | 'medium' | 'high' | 'xhigh' | 'max'];
  }

  private async askOllama(
    r: Resolved,
    req: AiRequest,
    thinking: ThinkingLevel,
    timeoutMs: number
  ) {
    const body: Record<string, unknown> = {
      model: r.model,
      stream: false,
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        ...req.messages,
      ],
      options: {
        temperature: 0.7,
        ...(req.maxTokens ? { num_predict: req.maxTokens } : {}),
      },
    };
    if (req.json) body.format = req.json === true ? 'json' : req.json;
    if (thinking === 'off') body.think = false;
    else if (thinking !== 'auto') {
      // gpt-oss takes a level; other thinking models take on/off.
      body.think = /gpt-oss/i.test(r.model ?? '') ? thinking : true;
    }
    const data = await this.http(
      r,
      `${r.baseUrl}/api/chat`,
      { body },
      timeoutMs
    );
    return this.text(r, data?.message?.content);
  }

  private async askAnthropic(
    r: Resolved,
    req: AiRequest,
    thinking: ThinkingLevel,
    timeoutMs: number
  ) {
    const budget = this.budgetFor(thinking);
    const maxTokens = (req.maxTokens ?? 4096) + (budget ?? 0);
    const body: Record<string, unknown> = {
      model: r.model,
      max_tokens: maxTokens,
      messages: req.messages,
      ...(req.system ? { system: req.system } : {}),
      ...(budget
        ? { thinking: { type: 'enabled', budget_tokens: budget } }
        : {}),
    };
    const data = await this.http(
      r,
      `${r.baseUrl}/v1/messages`,
      {
        headers: {
          'x-api-key': r.apiKey!,
          'anthropic-version': '2023-06-01',
        },
        body,
      },
      timeoutMs
    );
    const text = (data?.content ?? [])
      .filter((block: any) => block?.type === 'text')
      .map((block: any) => block.text)
      .join('');
    return this.text(r, text);
  }

  private async askOpenAiStyle(
    r: Resolved,
    req: AiRequest,
    thinking: ThinkingLevel,
    timeoutMs: number
  ) {
    const reasoning =
      r.spec.id === 'openai' &&
      ['low', 'medium', 'high'].includes(thinking) &&
      /^(o\d|gpt-5)/i.test(r.model ?? '');
    const body: Record<string, unknown> = {
      model: r.model,
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        ...req.messages,
      ],
      ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      ...(reasoning ? { reasoning_effort: thinking } : {}),
    };
    const data = await this.http(
      r,
      `${r.baseUrl}/chat/completions`,
      {
        headers: r.apiKey ? { Authorization: `Bearer ${r.apiKey}` } : {},
        body,
      },
      timeoutMs
    );
    return this.text(r, data?.choices?.[0]?.message?.content);
  }

  private async askGemini(
    r: Resolved,
    req: AiRequest,
    thinking: ThinkingLevel,
    timeoutMs: number
  ) {
    const budget =
      thinking === 'off'
        ? 0
        : {
            low: 1024,
            medium: 8192,
            high: 24576,
            xhigh: 24576,
            max: 32768,
          }[thinking as 'low' | 'medium' | 'high' | 'xhigh' | 'max'];
    const body: Record<string, unknown> = {
      contents: req.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      ...(req.system
        ? { systemInstruction: { parts: [{ text: req.system }] } }
        : {}),
      generationConfig: {
        ...(req.json ? { responseMimeType: 'application/json' } : {}),
        ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
        ...(budget !== undefined
          ? { thinkingConfig: { thinkingBudget: budget } }
          : {}),
      },
    };
    const data = await this.http(
      r,
      `${r.baseUrl}/v1beta/models/${encodeURIComponent(
        r.model ?? ''
      )}:generateContent`,
      { headers: { 'x-goog-api-key': r.apiKey! }, body },
      timeoutMs
    );
    const text = (data?.candidates?.[0]?.content?.parts ?? [])
      .filter((part: any) => !part?.thought)
      .map((part: any) => part?.text ?? '')
      .join('');
    return this.text(r, text);
  }

  private text(r: Resolved, value: unknown): string {
    if (typeof value === 'string' && value.trim()) return value;
    throw new AiProviderError(
      'bad_reply',
      `${r.spec.label} answered with an empty reply.`
    );
  }

  /** Pulls a JSON object out of a reply, tolerating code fences and chatter around it. */
  parseJson(text: string): any | null {
    const cleaned = text.replace(/```(?:json)?/gi, '');
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  // ==========================================
  // COMMAND-LINE PROVIDERS
  // ==========================================
  /**
   * How each program is called. Programs are fixed names, never a shell string; the
   * prompt travels on stdin (or, for Antigravity, as one argument) and the program runs in
   * an empty scratch folder with its tools switched off, so a model reply cannot touch files.
   */
  buildCliCommand(
    id: AiProviderId,
    options: { model: string | null; thinking: ThinkingLevel; prompt: string }
  ): { args: string[]; env: Record<string, string>; stdin?: string } {
    const { model, thinking, prompt } = options;
    const args: string[] = [];
    const env: Record<string, string> = {};
    if (id === 'claude-cli') {
      args.push('-p', '--output-format', 'text', '--no-session-persistence');
      args.push('--tools', '');
      if (model && model !== 'default') args.push('--model', model);
      if (thinking === 'off') env.MAX_THINKING_TOKENS = '0';
      else if (thinking !== 'auto') args.push('--effort', thinking);
      return { args, env, stdin: prompt };
    }
    if (id === 'codex-cli') {
      args.push('exec', '--skip-git-repo-check', '--ephemeral');
      args.push('--sandbox', 'read-only');
      if (model) args.push('--model', model);
      if (thinking !== 'auto' && thinking !== 'off') {
        args.push('-c', `model_reasoning_effort=${thinking}`);
      }
      args.push('-');
      return { args, env, stdin: prompt };
    }
    if (id === 'antigravity-cli') {
      args.push('--print', '--output-format', 'text');
      if (model) args.push('--model', model);
      if (thinking !== 'auto' && thinking !== 'off') {
        args.push('--effort', thinking);
      }
      return { args, env, stdin: undefined };
    }
    throw new HttpException('Not a command-line provider', 400);
  }

  private flatten(req: AiRequest): string {
    const lines: string[] = [];
    if (req.system) lines.push(req.system.trim(), '');
    if (req.messages.length === 1) {
      lines.push(req.messages[0].content);
    } else {
      lines.push('Conversation so far:');
      for (const message of req.messages) {
        lines.push(
          `${message.role === 'user' ? 'User' : 'Assistant'}: ${
            message.content
          }`
        );
      }
      lines.push('', 'Write only the Assistant’s next reply.');
    }
    if (req.json) {
      lines.push('', 'Reply with a single JSON object only, no other text.');
    }
    return lines.join('\n');
  }

  private async askCli(r: Resolved, req: AiRequest): Promise<string> {
    const prompt = this.flatten(req);
    const command = this.buildCliCommand(r.spec.id, {
      model: r.model,
      thinking: r.thinking,
      prompt,
    });
    if (this.updating.has(r.spec.id)) {
      throw new AiProviderError(
        'busy',
        `${r.spec.label} is being updated. Try again in a minute.`
      );
    }
    if (this.cliInFlight >= CLI_CONCURRENCY) {
      throw new AiProviderError(
        'busy',
        'Another request to a command-line tool is still running. Try again in a moment.'
      );
    }
    this.cliInFlight += 1;
    try {
      const out = await this.runCli(r.spec, command.args, {
        stdin: command.stdin,
        // Antigravity takes the prompt as an argument; keep it within a command line's limits.
        promptArg:
          r.spec.id === 'antigravity-cli' ? prompt.slice(0, 20_000) : undefined,
        env: command.env,
        timeoutMs:
          req.timeoutMs ||
          Number.parseInt(process.env.AGENCY_AI_CLI_TIMEOUT_MS || '', 10) ||
          DEFAULT_CLI_TIMEOUT_MS,
      });
      return this.text(r, out);
    } finally {
      this.cliInFlight -= 1;
    }
  }

  async findBinary(name: string): Promise<string | null> {
    const win = process.platform === 'win32';
    const home = os.homedir();
    const dirs = [
      ...(process.env.PATH || '').split(path.delimiter),
      path.join(home, '.local', 'bin'),
      path.join(home, '.claude', 'local'),
      path.join(home, '.npm-global', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
      ...(win && process.env.APPDATA
        ? [path.join(process.env.APPDATA, 'npm')]
        : []),
    ].filter(Boolean);
    const names = win ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
    for (const dir of dirs) {
      for (const candidate of names) {
        const full = path.join(dir, candidate);
        try {
          if ((await fs.stat(full)).isFile()) return full;
        } catch {
          /* not here */
        }
      }
    }
    return null;
  }

  private stopTree(pid?: number) {
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch {
      /* already gone */
    }
  }

  /**
   * Everything that has to be right before one of the tools is started: the program is found by
   * its fixed name, every argument is checked, it runs in an empty scratch folder, and the
   * secrets AgencyOS itself holds are removed from its environment.
   */
  private async prepareLaunch(
    spec: ProviderSpec,
    args: string[],
    options: { promptArg?: string; env?: Record<string, string> }
  ) {
    const binary = await this.findBinary(spec.binary!);
    if (!binary) {
      throw new AiProviderError(
        'not_installed',
        `${spec.label} is not installed (the “${spec.binary}” program was not found). ${spec.setup}`
      );
    }
    const cmdShim =
      process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
    if (args.some((a) => !CLI_SAFE_ARG.test(a))) {
      throw new HttpException('Unsafe command-line argument refused', 400);
    }
    if (cmdShim && options.promptArg !== undefined) {
      throw new AiProviderError(
        'unavailable',
        'This Antigravity install is a .cmd script, which cannot carry a prompt safely. Install the native agy program.'
      );
    }

    const scratch = path.join(os.tmpdir(), 'agencyos-ai');
    await fs.mkdir(scratch, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      NO_COLOR: '1',
      CI: '1',
    };
    for (const name of ENV_NEVER_SHARED) delete env[name];

    const quote = (a: string) => (a === '' ? '""' : a);
    const [file, fileArgs, verbatim] = cmdShim
      ? [
          process.env.ComSpec || 'cmd.exe',
          // With /s, cmd.exe drops the first and the last quote of the line, so the whole
          // command is wrapped in one more pair to keep the program's own quotes.
          ['/d', '/s', '/c', `""${binary}" ${args.map(quote).join(' ')}"`],
          true,
        ]
      : [
          binary,
          options.promptArg !== undefined ? [...args, options.promptArg] : args,
          false,
        ];

    return {
      file: file as string,
      fileArgs: fileArgs as string[],
      verbatim: verbatim as boolean,
      env,
      scratch,
    };
  }

  private startProcess(launch: {
    file: string;
    fileArgs: string[];
    verbatim: boolean;
    env: NodeJS.ProcessEnv;
    scratch: string;
  }) {
    return spawn(launch.file, launch.fileArgs, {
      cwd: launch.scratch,
      env: launch.env,
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatim,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so a timeout can stop the program and anything it started.
      detached: process.platform !== 'win32',
    });
  }

  private async runCli(
    spec: ProviderSpec,
    args: string[],
    options: {
      stdin?: string;
      /** One free-text argument appended after the checked ones. */
      promptArg?: string;
      /** Accept a clean exit with no output (an updater that says nothing). */
      acceptEmpty?: boolean;
      env?: Record<string, string>;
      timeoutMs: number;
    }
  ): Promise<string> {
    const launch = await this.prepareLaunch(spec, args, options);

    const started = Date.now();
    return new Promise<string>((resolve, reject) => {
      const child = this.startProcess(launch);
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        this.stopTree(child.pid);
        finish(() =>
          reject(
            new AiProviderError(
              'timeout',
              `${spec.label} did not answer within ${Math.round(
                options.timeoutMs / 1000
              )} seconds.${
                spec.experimental
                  ? ' Some versions of this tool hang when started by another program.'
                  : ''
              }`
            )
          )
        );
      }, options.timeoutMs);
      child.stdout.on('data', (chunk) => {
        if (stdout.length < MAX_CLI_OUTPUT) stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_CLI_OUTPUT) stderr += chunk;
      });
      child.on('error', (error) =>
        finish(() =>
          reject(
            new AiProviderError(
              'unavailable',
              `${spec.label} could not be started: ${error.message}`
            )
          )
        )
      );
      child.on('close', (code) =>
        finish(() => {
          this.logger.log(
            `${spec.id} finished with code ${code} in ${
              Date.now() - started
            } ms`
          );
          if (code === 0 && (stdout.trim() || options.acceptEmpty)) {
            return resolve(stdout.trim() || stderr);
          }
          const tail = (stderr || stdout)
            .trim()
            .split('\n')
            .slice(-4)
            .join(' ');
          const signedOut =
            /log ?in|sign ?in|authenticat|not logged|api key|unauthori[sz]ed|credential/i.test(
              tail
            );
          reject(
            signedOut
              ? new AiProviderError(
                  'not_signed_in',
                  `${spec.label} is not signed in. Open a terminal, run “${spec.binary}” once and sign in.`
                )
              : new AiProviderError(
                  'bad_reply',
                  `${spec.label} stopped with code ${code}${
                    tail ? `: ${tail.slice(0, 300)}` : ''
                  }`
                )
          );
        })
      );
      if (options.stdin !== undefined) child.stdin.write(options.stdin);
      child.stdin.end();
    });
  }

  /** The command-line tools this computer could have, for the updater and the settings page. */
  cliTools() {
    return this.catalog()
      .filter((spec) => spec.kind === 'cli')
      .map((spec) => ({
        id: spec.id,
        label: spec.label,
        binary: spec.binary!,
      }));
  }

  activeCliRuns() {
    return this.cliInFlight;
  }

  /** While true, new requests to that tool wait; an update replaces its program file. */
  setUpdating(id: AiProviderId, value: boolean) {
    if (value) this.updating.add(id);
    else this.updating.delete(id);
  }

  /** Runs one of the tool's own fixed commands (for example its updater). */
  runTool(
    id: AiProviderId,
    args: string[],
    timeoutMs: number
  ): Promise<string> {
    return this.runCli(this.spec(id), args, { timeoutMs, acceptEmpty: true });
  }

  /**
   * A short two-way conversation (JSON lines in, JSON lines out) with one of the tools' own
   * programs, used to ask it which models it offers. The program is started under the same rules
   * as every other run and is always stopped afterwards.
   */
  async converse<T>(
    id: AiProviderId,
    args: string[],
    timeoutMs: number,
    talk: (io: ConverseIo) => Promise<T>
  ): Promise<T> {
    const spec = this.spec(id);
    const launch = await this.prepareLaunch(spec, args, {});
    const child = this.startProcess(launch);
    type Waiter = {
      match: (m: any) => boolean;
      resolve: (m: any) => void;
      reject: (e: Error) => void;
    };
    const waiting: Waiter[] = [];
    const early: any[] = [];
    let failure: Error | null = null;
    const fail = (error: Error) => {
      failure = failure ?? error;
      for (const w of waiting.splice(0)) w.reject(failure);
    };
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const at = waiting.findIndex((w) => w.match(message));
        if (at >= 0) waiting.splice(at, 1)[0].resolve(message);
        else if (early.length < 200) early.push(message);
      }
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (error) =>
      fail(
        new AiProviderError(
          'unavailable',
          `${spec.label} could not be started: ${error.message}`
        )
      )
    );
    child.on('close', () =>
      fail(
        new AiProviderError(
          'bad_reply',
          `${spec.label} stopped before it answered.`
        )
      )
    );
    const timer = setTimeout(() => {
      this.stopTree(child.pid);
      fail(
        new AiProviderError(
          'timeout',
          `${spec.label} did not answer within ${Math.round(
            timeoutMs / 1000
          )} seconds.`
        )
      );
    }, timeoutMs);

    const io: ConverseIo = {
      send: (message) => {
        if (!failure) child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      next: (match) => {
        const at = early.findIndex(match);
        if (at >= 0) return Promise.resolve(early.splice(at, 1)[0]);
        if (failure) return Promise.reject(failure);
        return new Promise((resolve, reject) =>
          waiting.push({ match, resolve, reject })
        );
      },
    };
    try {
      return await talk(io);
    } finally {
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      this.stopTree(child.pid);
    }
  }

  /** The first line of `--version`, or undefined when the tool is missing or silent. */
  async toolVersion(id: AiProviderId): Promise<string | undefined> {
    return this.runTool(id, ['--version'], 8000).then(
      (out) => out.trim().split('\n')[0].slice(0, 80) || undefined,
      () => undefined
    );
  }

  // ==========================================
  // DETECTION AND MODEL LISTS
  // ==========================================
  async status(actor: AgencyActor): Promise<ProviderStatus[]> {
    this.access.assert(actor, 'ai:use');
    const cfg = await this.load(actor.orgId);
    return Promise.all(
      this.catalog().map(async (spec): Promise<ProviderStatus> => {
        const entry = cfg.providers[spec.id];
        if (spec.kind === 'api') {
          const { key } = this.keyFor(spec.id, entry);
          return {
            id: spec.id,
            ready: spec.keyOptional ? !!entry?.baseUrl : !!key,
            detail: key
              ? 'A key is saved.'
              : spec.keyOptional
              ? entry?.baseUrl
                ? 'Address saved.'
                : 'Enter the service address.'
              : 'No key saved yet.',
          };
        }
        if (spec.kind === 'cli') {
          if (!this.isLocalMode) {
            return {
              id: spec.id,
              ready: false,
              detail: 'Only available in the AgencyOS desktop app.',
            };
          }
          const found = await this.findBinary(spec.binary!);
          if (!found) {
            return { id: spec.id, ready: false, detail: 'Not installed.' };
          }
          const version = await this.toolVersion(spec.id);
          return { id: spec.id, ready: true, detail: 'Installed.', version };
        }
        try {
          const models = await this.listLocalModels(
            entry?.baseUrl || spec.baseUrl!.value
          );
          return {
            id: spec.id,
            ready: true,
            detail: models.length
              ? `${models.length} model${
                  models.length === 1 ? '' : 's'
                } installed.`
              : 'Running, but no model is installed yet.',
            models,
          };
        } catch {
          return {
            id: spec.id,
            ready: false,
            detail: 'Ollama is not answering.',
          };
        }
      })
    );
  }

  private async listLocalModels(baseUrl: string): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl}/api/tags`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      return (data?.models ?? []).map((m: any) => m.name).filter(Boolean);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Whether an installed model can think, as Ollama itself reports it. Unknown stays undefined. */
  private async localThinkingLevels(
    baseUrl: string,
    model: string
  ): Promise<ThinkingLevel[] | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const data = await res.json();
      if (!Array.isArray(data?.capabilities)) return undefined;
      if (!data.capabilities.includes('thinking')) return ['auto'];
      return /gpt-oss/i.test(model)
        ? ['auto', 'low', 'medium', 'high']
        : ['auto', 'off', 'low', 'medium', 'high'];
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private asInfo(ids: string[], levels?: ThinkingLevel[]): ModelInfo[] {
    return ids.map((id) => ({ id, label: id, thinkingLevels: levels }));
  }

  /** Live models for a provider (installed models, the API account's models), so lists never go stale. */
  async listModels(actor: AgencyActor, id: AiProviderId): Promise<ModelList> {
    this.access.assert(actor, 'ai:use');
    const r = await this.resolve(actor.orgId, id);
    const fallback = { models: this.asInfo(r.spec.models), live: false };
    try {
      if (r.spec.id === 'local') {
        const names = await this.listLocalModels(r.baseUrl);
        const models = await Promise.all(
          names.slice(0, 40).map(async (name) => ({
            id: name,
            label: name,
            thinkingLevels: await this.localThinkingLevels(r.baseUrl, name),
          }))
        );
        return { models, live: true };
      }
      if (r.spec.kind !== 'api') return fallback;
      if (r.spec.needsKey && !r.apiKey) {
        return { ...fallback, note: 'Save a key to load the live model list.' };
      }
      if (r.spec.id === 'anthropic') {
        const data = await this.http(
          r,
          `${r.baseUrl}/v1/models?limit=100`,
          {
            method: 'GET',
            headers: {
              'x-api-key': r.apiKey!,
              'anthropic-version': '2023-06-01',
            },
          },
          15_000
        );
        return {
          models: (data?.data ?? []).map((m: any) => ({
            id: m.id,
            label: m.display_name || m.id,
          })),
          live: true,
        };
      }
      if (r.spec.id === 'gemini') {
        const data = await this.http(
          r,
          `${r.baseUrl}/v1beta/models?pageSize=100`,
          { method: 'GET', headers: { 'x-goog-api-key': r.apiKey! } },
          15_000
        );
        return {
          models: (data?.models ?? [])
            .filter((m: any) =>
              (m.supportedGenerationMethods ?? []).includes('generateContent')
            )
            .map((m: any) => ({
              id: String(m.name).replace(/^models\//, ''),
              label: m.displayName || String(m.name).replace(/^models\//, ''),
              // Gemini says which models think; those that do not have no level to choose.
              thinkingLevels:
                m.thinking === false
                  ? (['auto'] as ThinkingLevel[])
                  : undefined,
            })),
          live: true,
        };
      }
      const data = await this.http(
        r,
        `${r.baseUrl}/models`,
        {
          method: 'GET',
          headers: r.apiKey ? { Authorization: `Bearer ${r.apiKey}` } : {},
        },
        15_000
      );
      return {
        models: this.asInfo((data?.data ?? []).map((m: any) => m.id)),
        live: true,
      };
    } catch (error) {
      return {
        ...fallback,
        note:
          error instanceof AiProviderError
            ? error.message
            : r.spec.id === 'local'
            ? 'Ollama is not answering, so the installed models cannot be listed.'
            : 'Could not load the live model list.',
      };
    }
  }
}
