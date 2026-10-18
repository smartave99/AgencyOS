import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { AgentProposalStatus, AgentScope, Prisma } from '@prisma/client';
import {
  AgencyAccessService,
  AgencyActor,
  AgencyPermission,
} from './agency.access.service';
import { AgencyAccessRepository } from './agency.access.repository';
import { AgencyAgentGatewayRepository } from './agency.agent.gateway.repository';
import {
  AgencyAiAgentService,
  ArgSpec,
  cleanToolArgs,
} from './agency.ai.agent.service';
import { AiProviderError } from './agency.ai.gateway.service';
import { AgencyCommunitiesService } from './agency.communities.service';
import { AgencyTelegramUsersService } from './agency.telegram.users.service';
import {
  AGENT_TOKEN_DEFAULT_DAYS,
  CreateAgentTokenDto,
} from '@gitroom/nestjs-libraries/dtos/agency/agent.integrations.dto';

/** The key is `agt_` and 32 random bytes in base64url (43 characters). Only its SHA-256 is stored. */
const TOKEN_PREFIX = 'agt_';
const BEARER = /^Bearer\s+(agt_[A-Za-z0-9_-]{43})$/i;
const MAX_ACTIVE_TOKENS = 10;
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_TOKEN = 20;
const MAX_PENDING_PER_ORG = 50;
const CALLS_PER_MINUTE = 60;
const MAX_RESULT_CHARS = 200_000;
const MCP_PLACEHOLDER = '<paste the token shown once>';

/**
 * The outside agent's whole vocabulary. These names are the contract: a tool exists for an agent only if
 * it is listed here, whatever else the in-app agent can do. Nothing here sends, schedules, approves,
 * joins, authorizes, deletes, reads a secret or changes who may do what, and there is no scope that
 * would allow it. A test pins this list.
 */
const READ_FROM_AGENT = [
  'dashboard',
  'list_clients',
  'list_campaigns',
  'get_campaign',
  'list_destinations',
  'list_approvals',
  'get_report',
  'list_deals',
  'suggest_copy',
] as const;
const DRAFT_FROM_AGENT = [
  'create_client',
  'create_campaign_draft',
  'update_campaign_draft',
  'set_campaign_destinations',
  'submit_campaign_for_review',
] as const;

/**
 * Fields the agent is not given even though the person's own screens show them: contact details of an
 * agency's clients and prospects. The tools it needs do not need them.
 */
const OMITTED_FIELDS: Record<string, string[]> = {
  list_clients: ['email'],
  list_deals: ['contact'],
};

/** A safety net under the per-tool field lists: whatever a tool returns, keys like these never leave. */
const SECRET_KEY =
  /^(sealed|session|sessionString|apiHash|apiId|apiKey|password|secret|token|tokenHash|accessToken|refreshToken|authorization|cookie|jwt|phone|phoneNumber)$/i;

export type AgentToolScope = 'READ' | 'DRAFT';

/** A tool as the agent sees it (and as the page lists it). */
export interface AgentToolView {
  name: string;
  scope: AgentToolScope;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
}

/** Who is calling: a key, the agency it belongs to, and the person whose permissions cap it. */
export interface AgentPrincipal {
  tokenId: string;
  orgId: string;
  scope: AgentScope;
  label: string;
  actor: AgencyActor;
}

interface GatewayTool {
  name: string;
  scope: AgentToolScope;
  permission: AgencyPermission;
  description: string;
  args: Record<string, ArgSpec>;
  /** Present on the few tools the gateway answers itself; the rest are the in-app agent's. */
  run?: (
    principal: AgentPrincipal,
    args: Record<string, any>
  ) => Promise<unknown>;
}

/** At most `limit` calls per key in any window; in this process's memory, which is enough for one computer. */
export class CallLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit = CALLS_PER_MINUTE,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now
  ) {}

  /** 0 when the call may go ahead; otherwise how many seconds to wait. */
  hit(key: string): number {
    const at = this.now();
    const recent = (this.hits.get(key) ?? []).filter(
      (t) => at - t < this.windowMs
    );
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0] + this.windowMs - at) / 1000));
    }
    recent.push(at);
    this.hits.set(key, recent);
    if (this.hits.size > 1000) {
      for (const [k, v] of this.hits) {
        if (!v.some((t) => at - t < this.windowMs)) this.hits.delete(k);
      }
    }
    return 0;
  }
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Same arguments in any key order compare equal. */
const canonical = (args: unknown) =>
  JSON.stringify(
    Object.entries((args ?? {}) as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : 1
    )
  );

const text = (value: unknown, max = 300) => {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** Where the MCP server file is on this computer: the installed copy, or the one in the source tree. */
export function findMcpServer(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
  startDir: string = __dirname
): { path: string; found: boolean } {
  if (env.AGENCYOS_MCP_SERVER) {
    const path = resolve(env.AGENCYOS_MCP_SERVER);
    return { path, found: fileExists(path) };
  }
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    for (const candidate of [
      join(dir, 'agent-mcp', 'server.mjs'),
      join(dir, 'apps', 'agent-mcp', 'server.mjs'),
    ]) {
      if (fileExists(candidate)) return { path: candidate, found: true };
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const home = env.AGENCYOS_HOME
    ? join(resolve(env.AGENCYOS_HOME), 'app', 'agent-mcp', 'server.mjs')
    : resolve('apps', 'agent-mcp', 'server.mjs');
  return { path: home, found: false };
}

/**
 * Lets an outside AI agent (any MCP client) work with AgencyOS without being able to do anything that
 * reaches the outside world. It can look (READ) and prepare drafts (DRAFT). A draft is only a proposal: a
 * person approves it in the app, and it then runs as that person, once. There is no tool to send,
 * schedule, approve, join, authorize, delete or change who may do what, and no scope that would allow
 * one. AgencyOS works exactly the same when no agent is connected; the agent is never a scheduler.
 */
@Injectable()
export class AgencyAgentGatewayService {
  private readonly logger = new Logger(AgencyAgentGatewayService.name);
  private readonly limiter = new CallLimiter();
  private readonly catalogue: GatewayTool[];

  constructor(
    private readonly repo: AgencyAgentGatewayRepository,
    private readonly access: AgencyAccessService,
    private readonly accessRepo: AgencyAccessRepository,
    private readonly agent: AgencyAiAgentService,
    private readonly communities: AgencyCommunitiesService,
    private readonly accounts: AgencyTelegramUsersService
  ) {
    this.catalogue = this.buildCatalogue();
  }

  // ==========================================
  // THE TOOLS
  // ==========================================
  private buildCatalogue(): GatewayTool[] {
    const fromAgent = (name: string, scope: AgentToolScope): GatewayTool => {
      const tool = this.agent.describeTool(name);
      if (!tool || tool.kind !== (scope === 'READ' ? 'read' : 'change')) {
        throw new Error(`The in-app agent has no ${scope} tool “${name}”`);
      }
      return {
        name,
        scope,
        permission: tool.permission,
        description: tool.description,
        args: tool.args,
      };
    };

    return [
      ...READ_FROM_AGENT.map((name) => fromAgent(name, 'READ')),
      {
        name: 'list_communities',
        scope: 'READ',
        permission: 'research:read',
        description:
          'The agency’s directory of public Telegram communities: title, @username, member count, labels and where the agency is with each (stage). Only what the directory holds; no messages and no people.',
        args: {
          search: {
            type: 'string',
            description: 'A word in the title or @username',
            max: 100,
          },
          stage: {
            type: 'string',
            description: 'Only communities at this stage',
            enum: [
              'DISCOVERED',
              'REVIEW_REQUIRED',
              'JOIN_REQUEST_PENDING',
              'JOINED',
              'ADVERTISING_ALLOWED',
              'PUBLISHING_AUTHORIZED',
              'NOT_ELIGIBLE',
              'BLOCKED',
            ],
          },
          category: {
            type: 'string',
            description: 'Only this label',
            max: 100,
          },
          limit: {
            type: 'number',
            description: 'How many to return (1 to 50, default 25)',
          },
        },
        run: async (principal, a) => {
          const needle = String(a.search ?? '')
            .toLowerCase()
            .replace(/^@/, '');
          const rows = await this.communities.list(principal.actor, {
            stage: a.stage || undefined,
            category: a.category || undefined,
            sort: 'title',
            limit: 500,
          });
          const limit = Math.min(Math.max(Math.trunc(a.limit) || 25, 1), 50);
          return rows
            .filter(
              (c) =>
                !needle ||
                c.title.toLowerCase().includes(needle) ||
                (c.username ?? '').toLowerCase().includes(needle)
            )
            .slice(0, limit)
            .map((c) => this.communityView(c));
        },
      },
      {
        name: 'get_community',
        scope: 'READ',
        permission: 'research:read',
        description:
          'One community from the directory (the same fields as list_communities).',
        args: {
          id: {
            type: 'string',
            required: true,
            description: 'The community id (from list_communities)',
          },
        },
        run: async (principal, a) =>
          this.communityView(
            (await this.communities.get(principal.actor, a.id)).community
          ),
      },
      {
        name: 'list_telegram_accounts',
        scope: 'READ',
        permission: 'userAccount:read',
        description:
          'The Telegram accounts the agency has connected and how healthy each is: label, status, what each is allowed to do, and the masked phone number. No ids and no credentials.',
        args: {},
        run: async (principal) =>
          (await this.accounts.list(principal.actor)).map((account) => ({
            label: account.label,
            status: account.status,
            statusReason: account.statusReason,
            rateLimitedUntil: account.rateLimitedUntil,
            permissions: account.permissions,
            phoneMasked: account.phoneMasked,
            lastCheckedAt: account.lastCheckedAt,
            lastErrorCode: account.lastErrorCode,
          })),
      },
      {
        name: 'get_proposal',
        scope: 'READ',
        permission: 'ai:configure',
        description:
          'Where a proposal you made stands: pending_approval, approved (with what happened), declined or expired.',
        args: {
          id: {
            type: 'string',
            required: true,
            description: 'The proposalId a change tool returned',
          },
        },
        run: async (principal, a) => {
          await this.repo.expireStale(principal.orgId, new Date());
          const row = await this.repo.getProposalForToken(
            principal.orgId,
            principal.tokenId,
            a.id
          );
          if (!row) throw new NotFoundException('Proposal not found');
          return {
            id: row.id,
            tool: row.tool,
            summary: row.summary,
            status: row.status,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            decidedAt: row.decidedAt,
            outcome: row.outcome,
          };
        },
      },
      ...DRAFT_FROM_AGENT.map((name) => fromAgent(name, 'DRAFT')),
    ];
  }

  /** Only what the directory holds and Telegram published: no description, notes, ids or accounts. */
  private communityView(c: {
    id: string;
    title: string;
    username: string | null;
    kind: string | null;
    memberCount: number | null;
    verified: boolean;
    scam: boolean;
    fake: boolean;
    joinRequestRequired: boolean;
    slowModeSeconds: number | null;
    language: string | null;
    category: string | null;
    tags: string[];
    bookmarked: boolean;
    stage: string;
    relation: string;
    available: boolean;
    adReview: string;
    lastRefreshedAt: Date | null;
  }) {
    return {
      id: c.id,
      title: c.title,
      username: c.username ? `@${c.username}` : null,
      kind: c.kind,
      members: c.memberCount,
      verified: c.verified,
      scam: c.scam,
      fake: c.fake,
      joinRequestRequired: c.joinRequestRequired,
      slowModeSeconds: c.slowModeSeconds,
      language: c.language,
      category: c.category,
      tags: c.tags,
      bookmarked: c.bookmarked,
      stage: c.stage,
      relation: c.relation,
      available: c.available,
      advertisingReview: c.adReview,
      lastRefreshedAt: c.lastRefreshedAt,
    };
  }

  private toolView(tool: GatewayTool): AgentToolView {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, spec] of Object.entries(tool.args)) {
      properties[key] = {
        type: spec.type,
        description: spec.description,
        ...(spec.enum ? { enum: spec.enum } : {}),
        ...(spec.type === 'string' ? { maxLength: spec.max ?? 500 } : {}),
      };
      if (spec.required) required.push(key);
    }
    return {
      name: tool.name,
      scope: tool.scope,
      description:
        tool.scope === 'DRAFT'
          ? `${tool.description} This only proposes the change: nothing happens until a person approves it in AgencyOS (Agent integrations). Check it with get_proposal.`
          : tool.description,
      inputSchema: {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: tool.scope === 'READ',
        destructiveHint: false,
      },
    };
  }

  // ==========================================
  // TOKENS (made and revoked by owners and admins)
  // ==========================================
  private tokenState(row: { revokedAt: Date | null; expiresAt: Date | null }) {
    if (row.revokedAt) return 'REVOKED' as const;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now())
      return 'EXPIRED' as const;
    return 'ACTIVE' as const;
  }

  private presentToken(row: {
    id: string;
    label: string;
    scope: AgentScope;
    prefix: string;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: row.id,
      label: row.label,
      scope: row.scope,
      // Enough to tell keys apart; the key itself cannot be recovered from what is stored.
      preview: `${row.prefix}…`,
      state: this.tokenState(row),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
    };
  }

  async listTokens(actor: AgencyActor) {
    this.access.assert(actor, 'ai:configure');
    return (await this.repo.listTokens(actor.orgId)).map((row) =>
      this.presentToken(row)
    );
  }

  /** Makes a key. The key is in the answer once and nowhere else: only its hash is kept. */
  async createToken(actor: AgencyActor, dto: CreateAgentTokenDto) {
    this.access.assert(actor, 'ai:configure');
    const label = dto.label.trim();
    if (!label) throw new BadRequestException('Give the token a name.');
    const full = () =>
      new ConflictException(
        `You already have ${MAX_ACTIVE_TOKENS} tokens that work. Revoke one you no longer use first.`
      );
    const now = new Date();
    if (
      (await this.repo.countActiveTokens(actor.orgId, now)) >= MAX_ACTIVE_TOKENS
    )
      throw full();

    const days = dto.expiresInDays ?? AGENT_TOKEN_DEFAULT_DAYS;
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const row = await this.repo.createToken({
      orgId: actor.orgId,
      label,
      scope: dto.scope,
      tokenHash: sha256(token),
      prefix: token.slice(0, 8),
      createdById: actor.userId,
      expiresAt: days > 0 ? new Date(now.getTime() + days * 86_400_000) : null,
    });
    // Two people pressing Create together could both have passed the check above. If that happened and
    // this key is over the limit, it goes before anyone has seen it.
    if (
      (await this.repo.countActiveTokens(actor.orgId, now)) > MAX_ACTIVE_TOKENS
    ) {
      await this.repo.deleteUnusedToken(actor.orgId, row.id);
      throw full();
    }
    await this.access.audit(actor, {
      action: 'agent.token_created',
      entityType: 'AgentToken',
      entityId: row.id,
      summary: `${label} (${dto.scope})`,
      metadata: {
        scope: dto.scope,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      },
    });
    return { ...this.presentToken(row), token };
  }

  async revokeToken(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'ai:configure');
    const row = await this.repo.getToken(actor.orgId, id);
    if (!row) throw new NotFoundException('Token not found');
    const now = new Date();
    if (await this.repo.revokeToken(actor.orgId, id, actor.userId, now)) {
      await this.repo.withdrawForToken(id, now);
      await this.access.audit(actor, {
        action: 'agent.token_revoked',
        entityType: 'AgentToken',
        entityId: id,
        summary: `${row.label} (${row.scope})`,
      });
    }
    return this.presentToken(
      (await this.repo.getToken(actor.orgId, id)) ?? row
    );
  }

  // ==========================================
  // WHO IS CALLING (the gateway's only way in)
  // ==========================================
  /**
   * Turns an Authorization header into a caller, or refuses. A key works only here, only while it is not
   * revoked or expired, and only while the person who made it is still an owner or admin: it never has
   * more power than that person has today.
   */
  async authenticate(header: string | undefined): Promise<AgentPrincipal> {
    const match = BEARER.exec((header ?? '').trim());
    if (!match) {
      throw new UnauthorizedException(
        'Send the agent token as “Authorization: Bearer agt_…”'
      );
    }
    const row = await this.repo.findTokenByHash(sha256(match[1]));
    if (!row) throw new UnauthorizedException('That token is not valid');
    if (row.revokedAt)
      throw new UnauthorizedException('That token was revoked');
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now())
      throw new UnauthorizedException('That token has expired');

    const wait = this.limiter.hit(row.id);
    if (wait > 0) {
      throw new HttpException(
        {
          statusCode: 429,
          message: `Too many calls from this token (limit ${CALLS_PER_MINUTE} a minute). Try again in ${wait} s.`,
          retryAfterSeconds: wait,
        },
        429
      );
    }

    const member = await this.repo.memberContext(row.orgId, row.createdById);
    if (!member) {
      throw new UnauthorizedException(
        'The person who made this token is no longer in the workspace'
      );
    }
    const actor = await this.access.resolveActor(
      { id: row.orgId },
      member.user,
      member.role
    );
    if (!this.access.can(actor, 'ai:configure')) {
      throw new ForbiddenException(
        'The person who made this token can no longer manage agent integrations'
      );
    }
    await this.repo.touchToken(row.id, new Date());
    return {
      tokenId: row.id,
      orgId: row.orgId,
      scope: row.scope,
      label: row.label,
      actor,
    };
  }

  // ==========================================
  // WHAT THE AGENT CAN DO
  // ==========================================
  health(principal: AgentPrincipal) {
    return {
      ok: true,
      label: principal.label,
      scope: principal.scope,
      tools: this.visible(principal).length,
    };
  }

  /** A READ key sees only reading tools; a DRAFT key also sees the ones that propose changes. */
  private visible(principal: AgentPrincipal) {
    return this.catalogue.filter(
      (tool) => tool.scope === 'READ' || principal.scope === 'DRAFT'
    );
  }

  tools(principal: AgentPrincipal) {
    return {
      scope: principal.scope,
      tools: this.visible(principal).map((tool) => this.toolView(tool)),
    };
  }

  /** Every tool the gateway can ever offer, for the settings page and the tests. */
  allTools(): AgentToolView[] {
    return this.catalogue.map((tool) => this.toolView(tool));
  }

  async call(principal: AgentPrincipal, name: string, rawArgs: unknown) {
    const tool = this.catalogue.find((t) => t.name === name);
    if (!tool) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'unknown_tool',
        message: `There is no tool called “${text(name, 60)}”`,
      });
    }
    if (tool.scope === 'DRAFT' && principal.scope !== 'DRAFT') {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'scope_denied',
        message:
          'This token can only read. Make a token with the Draft scope to let an agent propose changes.',
      });
    }
    // The key never outranks the person behind it.
    this.access.assert(principal.actor, tool.permission);
    try {
      return tool.scope === 'DRAFT'
        ? await this.propose(principal, tool, rawArgs)
        : await this.read(principal, tool, rawArgs);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof AiProviderError) {
        throw new HttpException(error.message, 502);
      }
      this.logger.error(
        `Agent tool ${name} failed: ${(error as Error)?.message}`
      );
      throw new InternalServerErrorException('The tool failed');
    }
  }

  private async read(
    principal: AgentPrincipal,
    tool: GatewayTool,
    rawArgs: unknown
  ) {
    let data: unknown;
    if (tool.run) {
      const cleaned = cleanToolArgs(tool.args, rawArgs);
      if ('error' in cleaned) throw new BadRequestException(cleaned.error);
      data = await tool.run(principal, cleaned.args);
    } else {
      data = await this.agent.runRead(principal.actor, tool.name, rawArgs);
    }
    return this.safe(tool.name, data);
  }

  /** Plain JSON, without fields the agent is not given and without anything secret-shaped. */
  private safe(tool: string, data: unknown): unknown {
    const omit = new Set(OMITTED_FIELDS[tool] ?? []);
    const clean = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(clean);
      if (
        value &&
        typeof value === 'object' &&
        !(value instanceof Date) &&
        typeof (value as { toJSON?: unknown }).toJSON !== 'function'
      ) {
        return Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !SECRET_KEY.test(key) && !omit.has(key))
            .map(([key, v]) => [key, clean(v)])
        );
      }
      return value;
    };
    const json = JSON.stringify(clean(data ?? null));
    if (json.length > MAX_RESULT_CHARS) {
      throw new BadRequestException(
        'That answer is too large. Ask for less (a filter or a smaller limit).'
      );
    }
    return JSON.parse(json);
  }

  // ==========================================
  // PROPOSALS (a change waits for a person)
  // ==========================================
  private async propose(
    principal: AgentPrincipal,
    tool: GatewayTool,
    rawArgs: unknown
  ) {
    const { args, summary } = await this.agent.prepareChange(
      principal.actor,
      tool.name,
      rawArgs
    );
    const now = new Date();
    await this.repo.expireStale(principal.orgId, now);

    const waiting = await this.repo.pendingForToken(principal.tokenId);
    const same = waiting.find(
      (p) => p.tool === tool.name && canonical(p.args) === canonical(args)
    );
    if (same) {
      return {
        status: 'pending_approval',
        proposalId: same.id,
        message:
          'This is already waiting for a person to approve it in AgencyOS (Agent integrations).',
      };
    }
    if (waiting.length >= MAX_PENDING_PER_TOKEN) {
      throw new HttpException(
        `${MAX_PENDING_PER_TOKEN} of your proposals are already waiting for a person. Ask them to approve or decline some first.`,
        429
      );
    }
    if (
      (await this.repo.countPending(principal.orgId)) >= MAX_PENDING_PER_ORG
    ) {
      throw new HttpException(
        'Too many proposals are waiting for a person to decide. Try again later.',
        429
      );
    }

    const row = await this.repo.createProposal({
      orgId: principal.orgId,
      tokenId: principal.tokenId,
      tool: tool.name,
      args: args as Prisma.InputJsonValue,
      summary: text(summary, 500),
      expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS),
    });
    await this.auditAgent(principal, {
      action: 'agent.proposal_created',
      entityId: row.id,
      summary: row.summary,
      metadata: { tool: tool.name },
    });
    return {
      status: 'pending_approval',
      proposalId: row.id,
      message:
        'Nothing has changed. A person has to approve this in AgencyOS (Agent integrations) within 24 hours. Use get_proposal to see what they decided.',
    };
  }

  private present(
    row: NonNullable<
      Awaited<ReturnType<AgencyAgentGatewayRepository['getProposal']>>
    >
  ) {
    return {
      id: row.id,
      tool: row.tool,
      args: row.args,
      summary: row.summary,
      status: row.status,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      decidedAt: row.decidedAt,
      outcome: row.outcome,
      from: row.token,
    };
  }

  async listProposals(actor: AgencyActor, status?: string) {
    this.access.assert(actor, 'ai:configure');
    await this.repo.expireStale(actor.orgId, new Date());
    const wanted = ['PENDING', 'APPROVED', 'DECLINED', 'EXPIRED'].includes(
      status ?? ''
    )
      ? (status as AgentProposalStatus)
      : undefined;
    return (await this.repo.listProposals(actor.orgId, wanted)).map((row) =>
      this.present(row)
    );
  }

  private async requireProposal(actor: AgencyActor, id: string) {
    await this.repo.expireStale(actor.orgId, new Date());
    const row = await this.repo.getProposal(actor.orgId, id);
    if (!row) throw new NotFoundException('Proposal not found');
    if (row.status !== 'PENDING') {
      throw new ConflictException(
        row.status === 'EXPIRED'
          ? 'This proposal expired before anyone decided.'
          : `This proposal was already ${row.status.toLowerCase()}.`
      );
    }
    return row;
  }

  /**
   * A person approves: the change runs now, as them and with their permissions, and only if this is the
   * one call that moved the proposal out of PENDING. If it then fails, it stays approved with the
   * reason; it is never run a second time.
   */
  async approve(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'ai:configure');
    const proposal = await this.requireProposal(actor, id);
    const tool = this.catalogue.find(
      (t) => t.name === proposal.tool && t.scope === 'DRAFT'
    );
    if (!tool) {
      throw new BadRequestException(
        'This proposal names a change that agents can no longer make.'
      );
    }
    // The approver's permission is checked now, not when the agent asked.
    this.access.assert(actor, tool.permission);
    const moved = await this.repo.decide(
      actor.orgId,
      id,
      'APPROVED',
      actor.userId,
      new Date()
    );
    if (!moved) {
      throw new ConflictException('Someone decided this a moment ago.');
    }

    let outcome: Prisma.InputJsonValue;
    try {
      const done = await this.agent.act(actor, {
        tool: proposal.tool,
        args: proposal.args as Record<string, unknown>,
      });
      outcome = done.ok
        ? { ok: true, result: this.parse(done.result) as Prisma.InputJsonValue }
        : { ok: false, error: this.errorOf(done.result) };
    } catch (error) {
      outcome = { ok: false, error: this.errorOf((error as Error)?.message) };
    }
    await this.repo.saveOutcome(actor.orgId, id, outcome);
    await this.access.audit(actor, {
      action: 'agent.proposal_approved',
      entityType: 'AgentProposal',
      entityId: id,
      summary: proposal.summary,
      metadata: {
        tool: proposal.tool,
        tokenId: proposal.token.id,
        tokenLabel: proposal.token.label,
        ok: (outcome as { ok: boolean }).ok,
      },
    });
    return this.present((await this.repo.getProposal(actor.orgId, id))!);
  }

  async decline(actor: AgencyActor, id: string, reason?: string) {
    this.access.assert(actor, 'ai:configure');
    const proposal = await this.requireProposal(actor, id);
    const why = reason?.trim();
    const moved = await this.repo.decide(
      actor.orgId,
      id,
      'DECLINED',
      actor.userId,
      new Date(),
      { ok: false, error: why ? `Declined: ${why}` : 'Declined by a person.' }
    );
    if (!moved) {
      throw new ConflictException('Someone decided this a moment ago.');
    }
    await this.access.audit(actor, {
      action: 'agent.proposal_declined',
      entityType: 'AgentProposal',
      entityId: id,
      summary: proposal.summary,
      metadata: {
        tool: proposal.tool,
        tokenId: proposal.token.id,
        tokenLabel: proposal.token.label,
      },
    });
    return this.present((await this.repo.getProposal(actor.orgId, id))!);
  }

  private parse(result: string): unknown {
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }

  private errorOf(result: string): string {
    const parsed = this.parse(result) as { error?: string } | string;
    return text(
      typeof parsed === 'object' && parsed?.error ? parsed.error : parsed,
      300
    );
  }

  /** The agent is not a person, so its events carry the role AGENT and name the key. */
  private async auditAgent(
    principal: AgentPrincipal,
    entry: {
      action: string;
      entityId: string;
      summary: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    try {
      await this.accessRepo.createAuditEvent({
        orgId: principal.orgId,
        actorUserId: null,
        actorRole: 'AGENT',
        action: entry.action,
        entityType: 'AgentProposal',
        entityId: entry.entityId,
        summary: entry.summary,
        metadata: {
          ...entry.metadata,
          tokenId: principal.tokenId,
          tokenLabel: principal.label,
        } as Prisma.InputJsonValue,
      });
    } catch (error) {
      this.logger.error(
        `Failed to write audit event ${entry.action}: ${
          (error as Error)?.message
        }`
      );
    }
  }

  // ==========================================
  // THE PAGE: how to connect an agent
  // ==========================================
  /**
   * What the person copies into their agent's settings. It holds a placeholder instead of a key: the key
   * is shown once when it is made and is not kept anywhere that could show it again.
   *
   * The file name and layout are the common MCP-client convention. They have NOT been checked against
   * Antigravity's own documentation or an installed Antigravity.
   */
  config(actor: AgencyActor) {
    this.access.assert(actor, 'ai:configure');
    const server = findMcpServer();
    const url = `http://127.0.0.1:${process.env.PORT || 3000}`;
    const file = {
      mcpServers: {
        agencyos: {
          command: 'node',
          args: [server.path],
          env: {
            AGENCYOS_MCP_URL: url,
            AGENCYOS_MCP_TOKEN: MCP_PLACEHOLDER,
          },
        },
      },
    };
    return {
      url,
      serverPath: server.path,
      serverFound: server.found,
      placeholder: MCP_PLACEHOLDER,
      fileName: '.agents/mcp_config.json',
      configText: JSON.stringify(file, null, 2),
      genericCommand: `node ${JSON.stringify(server.path)}`,
      environment: {
        AGENCYOS_MCP_URL: url,
        AGENCYOS_MCP_TOKEN: MCP_PLACEHOLDER,
      },
      verifiedWithAntigravity: false,
      limits: {
        activeTokens: MAX_ACTIVE_TOKENS,
        callsPerMinute: CALLS_PER_MINUTE,
        proposalHours: PROPOSAL_TTL_MS / 3_600_000,
        defaultTokenDays: AGENT_TOKEN_DEFAULT_DAYS,
      },
      tools: this.allTools().map(({ name, scope, description }) => ({
        name,
        scope,
        description,
      })),
    };
  }
}
