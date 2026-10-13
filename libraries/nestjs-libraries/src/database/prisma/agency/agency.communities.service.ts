import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CommunityRelation,
  CommunityStage,
  Prisma,
  TelegramUserAccount,
} from '@prisma/client';
import { AgencyAccessService, AgencyActor } from './agency.access.service';
import {
  AgencyCommunitiesRepository,
  CommunityFilters,
  CommunityMetadata,
} from './agency.communities.repository';
import {
  AgencyTelegramUsersService,
  AccountPermission,
  TelegramAccountUnusableException,
} from './agency.telegram.users.service';
import { AgencyPublishingService } from './agency.publishing.service';
import { AgencyRepository } from './agency.repository';
import {
  TelegramUserGateway,
  TelegramUserGatewayError,
  UserGatewayCommunity,
  UserGatewayRelation,
} from '@gitroom/nestjs-libraries/integrations/telegram/telegram.user.gateway';

const MAX_IMPORT_REFS = 50;
const MAX_REFRESH_IDS = 20;
const REFRESH_CHUNK = 20;
const MESSAGE_VIEWS_PER_MINUTE = 10;
/** How long a person's advertising review is trusted before it has to be looked at again. */
const AUTHORIZATION_DAYS = 90;

/** The only moves a community can make. Anything else is refused, whatever the caller asks for. */
const MOVES: Record<CommunityStage, CommunityStage[]> = {
  // A person may join straight from the directory: the join itself carries their reason.
  DISCOVERED: [
    'REVIEW_REQUIRED',
    'JOIN_REQUEST_PENDING',
    'JOINED',
    'NOT_ELIGIBLE',
    'BLOCKED',
  ],
  REVIEW_REQUIRED: [
    'DISCOVERED',
    'JOIN_REQUEST_PENDING',
    'JOINED',
    'NOT_ELIGIBLE',
    'BLOCKED',
  ],
  JOIN_REQUEST_PENDING: [
    'JOINED',
    'REVIEW_REQUIRED',
    'NOT_ELIGIBLE',
    'BLOCKED',
  ],
  JOINED: ['ADVERTISING_ALLOWED', 'REVIEW_REQUIRED', 'NOT_ELIGIBLE', 'BLOCKED'],
  ADVERTISING_ALLOWED: [
    'PUBLISHING_AUTHORIZED',
    'JOINED',
    'REVIEW_REQUIRED', // the account left
    'NOT_ELIGIBLE',
    'BLOCKED',
  ],
  PUBLISHING_AUTHORIZED: [
    'ADVERTISING_ALLOWED',
    'JOINED',
    'REVIEW_REQUIRED', // the account left
    'NOT_ELIGIBLE',
    'BLOCKED',
  ],
  NOT_ELIGIBLE: ['REVIEW_REQUIRED'],
  BLOCKED: ['REVIEW_REQUIRED'],
};

/** `ok` false carries `reason`; `ok` true carries `kind` and, for a public name, `username`. */
export interface ParsedRef {
  ok: boolean;
  kind?: 'username' | 'invite';
  username?: string;
  ref?: string;
  input?: string;
  reason?: string;
}

const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

/**
 * The agency's research directory of public Telegram communities, and the workflow that takes one
 * from "found" to "authorized to advertise in": every step is a deliberate action by a named person
 * through an account that was given that permission. Nothing here reads a member list, a phone
 * number or a private chat, and nothing joins, posts or switches accounts by itself.
 */
@Injectable()
export class AgencyCommunitiesService {
  private readonly logger = new Logger(AgencyCommunitiesService.name);
  private readonly viewLog = new Map<string, number[]>();

  constructor(
    private readonly repo: AgencyCommunitiesRepository,
    private readonly accounts: AgencyTelegramUsersService,
    private readonly access: AgencyAccessService,
    private readonly publishing: AgencyPublishingService,
    private readonly agencyRepo: AgencyRepository,
    private readonly gateway: TelegramUserGateway
  ) {}

  // ==========================================
  // LINKS AND NAMES (checked here, before Telegram is asked anything)
  // ==========================================
  static parseRef(input: string): ParsedRef {
    const text = (input ?? '').trim();
    if (!text) return { ok: false, input: text, reason: 'Empty' };
    const bare = text.replace(/^@/, '');
    if (!/[/:.]/.test(bare)) {
      return USERNAME.test(bare)
        ? { ok: true, kind: 'username', username: bare, ref: `@${bare}` }
        : {
            ok: false,
            input: text,
            reason:
              'A public name has 4 to 32 letters, digits or underscores and starts with a letter',
          };
    }
    let url: URL;
    try {
      url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      return { ok: false, input: text, reason: 'Not a link or a public name' };
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['t.me', 'telegram.me', 'telegram.dog'].includes(host)) {
      return { ok: false, input: text, reason: 'Only t.me links are accepted' };
    }
    const [first, second] = url.pathname.split('/').filter(Boolean);
    if (!first)
      return { ok: false, input: text, reason: 'The link names no community' };
    if (first.startsWith('+') || first.toLowerCase() === 'joinchat') {
      return {
        ok: true,
        kind: 'invite',
        ref: `https://t.me/${
          first.startsWith('+') ? first : `joinchat/${second ?? ''}`
        }`,
      };
    }
    if (first.toLowerCase() === 'c' || first.toLowerCase() === 's') {
      return {
        ok: false,
        input: text,
        reason:
          'That is a link to a single message; use the community’s own link',
      };
    }
    return USERNAME.test(first)
      ? { ok: true, kind: 'username', username: first, ref: `@${first}` }
      : {
          ok: false,
          input: text,
          reason: 'That link does not name a public community',
        };
  }

  /** Checks a pasted list without asking Telegram: what would be looked up, and what cannot be. */
  validateLinks(actor: AgencyActor, refs: string[]) {
    this.access.assert(actor, 'research:read');
    const seen = new Set<string>();
    return (refs ?? []).slice(0, 200).map((raw) => {
      const parsed = AgencyCommunitiesService.parseRef(raw);
      if (parsed.ok && parsed.kind === 'username') {
        const key = parsed.username!.toLowerCase();
        const duplicate = seen.has(key);
        seen.add(key);
        return {
          input: raw,
          ok: !duplicate,
          username: parsed.username,
          reason: duplicate ? 'Listed twice' : null,
        };
      }
      if (parsed.ok) {
        return {
          input: raw,
          ok: false,
          username: null,
          reason:
            'A private invite link has nothing public to look up. Use the community’s public name if it has one.',
        };
      }
      return { input: raw, ok: false, username: null, reason: parsed.reason };
    });
  }

  // ==========================================
  // HELPERS
  // ==========================================
  private fields(c: UserGatewayCommunity): CommunityMetadata {
    return {
      telegramId: c.telegramId,
      kind: c.kind,
      username: c.username ? c.username.replace(/^@/, '') : null,
      title: c.title,
      description: c.description,
      memberCount: c.memberCount,
      verified: c.verified,
      scam: c.scam,
      fake: c.fake,
      joinRequestRequired: c.joinRequestRequired,
      slowModeSeconds: c.slowModeSeconds,
    };
  }

  private diff(
    before: Record<string, unknown>,
    after: Record<string, unknown>
  ): Record<string, [unknown, unknown]> {
    const changes: Record<string, [unknown, unknown]> = {};
    for (const key of Object.keys(after)) {
      if (
        JSON.stringify(before[key] ?? null) !==
        JSON.stringify(after[key] ?? null)
      ) {
        changes[key] = [before[key] ?? null, after[key] ?? null];
      }
    }
    return changes;
  }

  private async require(orgId: string, id: string) {
    const row = await this.repo.get(orgId, id);
    if (!row) throw new NotFoundException('Community not found');
    return row;
  }

  /** Runs one worker call for an account and turns what goes wrong into words and a recorded account state. */
  private async asAccount<T>(
    orgId: string,
    accountId: string,
    need: AccountPermission,
    run: (
      creds: Awaited<
        ReturnType<AgencyTelegramUsersService['credentialsFor']>
      >['creds']
    ) => Promise<T>
  ): Promise<T> {
    const { creds } = await this.accounts.credentialsFor(
      orgId,
      accountId,
      need
    );
    try {
      return await run(creds);
    } catch (err) {
      if (err instanceof TelegramUserGatewayError) {
        if (
          ['SESSION_INVALID', 'ACCOUNT_RESTRICTED', 'RATE_LIMITED'].includes(
            err.code
          )
        ) {
          await this.accounts.recordFailure(orgId, accountId, err);
        }
        throw AgencyTelegramUsersService.httpError(err);
      }
      throw err;
    }
  }

  private async move(
    orgId: string,
    actor: Pick<AgencyActor, 'userId' | 'role'> | null,
    community: { id: string; stage: CommunityStage; title: string },
    to: CommunityStage,
    reason: string,
    extra: Prisma.CommunityUncheckedUpdateManyInput = {}
  ) {
    if (community.stage !== to && !MOVES[community.stage].includes(to)) {
      throw new ConflictException(
        `A community cannot go from ${community.stage} to ${to} directly`
      );
    }
    await this.repo.update(orgId, community.id, {
      stage: to,
      stageReason: reason.slice(0, 300),
      ...extra,
    });
    await this.repo.addHistory(orgId, community.id, {
      kind: 'STAGE',
      summary: reason,
      fromStage: community.stage,
      toStage: to,
      actorUserId: actor?.userId ?? null,
    });
    await this.access.audit(actor ? { ...actor, orgId } : null, {
      orgId,
      action: `community.${to.toLowerCase()}`,
      entityType: 'Community',
      entityId: community.id,
      summary: `${community.title}: ${reason}`,
    });
  }

  private relationOf(r: UserGatewayRelation): CommunityRelation {
    return r as CommunityRelation;
  }

  // ==========================================
  // RESEARCH: search, import, refresh
  // ==========================================
  /** Telegram's own public search. Results are shown, not saved: saving fetches each one afresh. */
  async search(
    actor: AgencyActor,
    input: { accountId: string; query: string; limit?: number }
  ) {
    this.access.assert(actor, 'research:run');
    const query = (input.query ?? '').trim();
    if (query.length < 2 || query.length > 100) {
      throw new BadRequestException('Search for 2 to 100 characters');
    }
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const { results } = await this.asAccount(
      actor.orgId,
      input.accountId,
      'canResearch',
      (creds) => this.gateway.searchCommunities(creds, query, limit)
    );
    const known = await this.repo.list(actor.orgId, { limit: 500 });
    const byId = new Map(
      known.filter((k) => k.telegramId).map((k) => [k.telegramId!, k])
    );
    const byName = new Map(
      known.filter((k) => k.username).map((k) => [k.username!.toLowerCase(), k])
    );
    await this.access.audit(actor, {
      action: 'research.searched',
      entityType: 'Community',
      summary: `Searched public communities for “${query.slice(0, 60)}”`,
    });
    return {
      query,
      results: results.map((c) => {
        const saved =
          byId.get(c.telegramId) ??
          (c.username ? byName.get(c.username.toLowerCase()) : undefined);
        return {
          ...this.fields(c),
          link: c.username
            ? `https://t.me/${c.username.replace(/^@/, '')}`
            : null,
          saved: saved ? { id: saved.id, stage: saved.stage } : null,
        };
      }),
    };
  }

  /** The same path for "save this search result" and "import these links": Telegram is asked about each. */
  async importRefs(
    actor: AgencyActor,
    input: {
      accountId: string;
      refs: string[];
      tags?: string[];
      category?: string;
      language?: string;
      source?: string;
    }
  ) {
    this.access.assert(actor, 'research:run');
    if (!input.refs?.length)
      throw new BadRequestException('Add at least one link or name');
    if (input.refs.length > MAX_IMPORT_REFS) {
      throw new BadRequestException(
        `Import at most ${MAX_IMPORT_REFS} communities at a time`
      );
    }
    const seen = new Set<string>();
    const wanted: Array<{ input: string; username: string; ref: string }> = [];
    const failed: Array<{ input: string; code: string; message: string }> = [];
    for (const raw of input.refs) {
      const parsed = AgencyCommunitiesService.parseRef(raw);
      if (!parsed.ok) {
        failed.push({
          input: raw,
          code: 'INVALID_REF',
          message: parsed.reason,
        });
      } else if (parsed.kind === 'invite') {
        failed.push({
          input: raw,
          code: 'PRIVATE',
          message: 'A private invite link has nothing public to save',
        });
      } else if (seen.has(parsed.username!.toLowerCase())) {
        failed.push({ input: raw, code: 'DUPLICATE', message: 'Listed twice' });
      } else {
        seen.add(parsed.username!.toLowerCase());
        wanted.push({
          input: raw,
          username: parsed.username!,
          ref: parsed.ref!,
        });
      }
    }
    const tags = this.cleanTags(input.tags);
    const created: string[] = [];
    const updated: string[] = [];
    let retryAfterSeconds: number | undefined;

    for (
      let i = 0;
      i < wanted.length && retryAfterSeconds === undefined;
      i += REFRESH_CHUNK
    ) {
      const chunk = wanted.slice(i, i + REFRESH_CHUNK);
      let results;
      try {
        results = (
          await this.asAccount(
            actor.orgId,
            input.accountId,
            'canResearch',
            (creds) =>
              this.gateway.refreshCommunities(
                creds,
                chunk.map((c) => c.ref)
              )
          )
        ).results;
      } catch (err) {
        if (err instanceof HttpException && err.getStatus() === 429) {
          retryAfterSeconds = 60;
          for (const c of chunk) {
            failed.push({
              input: c.input,
              code: 'RATE_LIMITED',
              message: 'Telegram asked to wait; try again later',
            });
          }
          break;
        }
        throw err;
      }
      const byName = new Map(chunk.map((c) => [c.username.toLowerCase(), c]));
      for (const result of results) {
        const source = byName.get(result.ref.replace(/^@/, '').toLowerCase());
        if (!source) continue;
        if (!result.ok || !result.community) {
          const code = result.error?.code ?? 'UNKNOWN';
          failed.push({
            input: source.input,
            code,
            message:
              result.error?.message ?? 'Telegram did not return this community',
          });
          if (code === 'RATE_LIMITED') retryAfterSeconds = 60;
          continue;
        }
        const out = await this.upsert(
          actor.orgId,
          actor,
          result.community,
          result.relation ?? 'PUBLIC_NOT_JOINED',
          {
            tags,
            category: input.category?.trim() || undefined,
            language: input.language?.trim() || undefined,
            source: input.source?.trim() || 'import',
            accountId: input.accountId,
          }
        );
        (out.created ? created : updated).push(out.id);
      }
    }
    await this.access.audit(actor, {
      action: 'research.imported',
      entityType: 'Community',
      summary: `${created.length} added, ${updated.length} refreshed, ${failed.length} not saved`,
    });
    return {
      created: created.length,
      updated: updated.length,
      failed,
      retryAfterSeconds: retryAfterSeconds ?? null,
    };
  }

  private cleanTags(tags?: string[]) {
    return [
      ...new Set(
        (tags ?? [])
          .map((t) => t.trim().toLowerCase().slice(0, 30))
          .filter(Boolean)
      ),
    ].slice(0, 20);
  }

  /** Writes what Telegram returned. A number Telegram did not return stays empty; nothing is estimated. */
  private async upsert(
    orgId: string,
    actor: Pick<AgencyActor, 'userId' | 'role'> | null,
    c: UserGatewayCommunity,
    relation: UserGatewayRelation,
    opts: {
      tags?: string[];
      category?: string;
      language?: string;
      source?: string;
      accountId: string;
    }
  ) {
    const meta = this.fields(c);
    const existing = await this.repo.findExisting(orgId, {
      telegramId: meta.telegramId,
      username: meta.username,
    });
    if (!existing) {
      const row = await this.repo.create(orgId, {
        ...meta,
        relation: this.relationOf(relation),
        tags: opts.tags ?? [],
        category: opts.category ?? null,
        language: opts.language ?? null,
        source: opts.source ?? null,
        createdById: actor?.userId ?? null,
        lastRefreshedAt: new Date(),
      });
      await this.repo.addHistory(orgId, row.id, {
        kind: 'CREATED',
        summary: `Added from ${opts.source ?? 'research'}`,
        toStage: 'DISCOVERED',
        actorUserId: actor?.userId ?? null,
      });
      return { id: row.id, created: true, changes: {} };
    }
    const changes = this.diff(
      existing as unknown as Record<string, unknown>,
      meta as unknown as Record<string, unknown>
    );
    const lookedUpByOperator =
      !existing.operatingAccountId ||
      existing.operatingAccountId === opts.accountId;
    await this.repo.update(orgId, existing.id, {
      ...meta,
      available: true,
      lastErrorCode: null,
      lastRefreshedAt: new Date(),
      ...(lookedUpByOperator ? { relation: this.relationOf(relation) } : {}),
      ...(opts.tags?.length
        ? { tags: [...new Set([...existing.tags, ...opts.tags])].slice(0, 20) }
        : {}),
      ...(opts.category && !existing.category
        ? { category: opts.category }
        : {}),
      ...(opts.language && !existing.language
        ? { language: opts.language }
        : {}),
    });
    if (Object.keys(changes).length) {
      await this.repo.addHistory(orgId, existing.id, {
        kind: 'REFRESH',
        summary: `Telegram now shows: ${Object.keys(changes).join(
          ', '
        )} changed`,
        changes: changes as unknown as Prisma.InputJsonValue,
        actorUserId: actor?.userId ?? null,
      });
    }
    await this.reconcile(orgId, actor, existing, relation, opts.accountId);
    return { id: existing.id, created: false, changes };
  }

  /** What a fresh look at a community means for where the agency is with it. */
  private async reconcile(
    orgId: string,
    actor: Pick<AgencyActor, 'userId' | 'role'> | null,
    community: {
      id: string;
      stage: CommunityStage;
      title: string;
      operatingAccountId: string | null;
    },
    relation: UserGatewayRelation,
    accountId: string
  ) {
    if (
      community.stage === 'JOIN_REQUEST_PENDING' &&
      ['MEMBER', 'ADMINISTERED', 'OWNED'].includes(relation) &&
      community.operatingAccountId === accountId
    ) {
      await this.move(
        orgId,
        actor,
        community,
        'JOINED',
        'The join request was accepted',
        {
          relation: this.relationOf(relation),
        }
      );
      return;
    }
    if (
      ['JOINED', 'ADVERTISING_ALLOWED', 'PUBLISHING_AUTHORIZED'].includes(
        community.stage
      ) &&
      ['RESTRICTED', 'UNAVAILABLE'].includes(relation) &&
      community.operatingAccountId === accountId
    ) {
      await this.block(
        orgId,
        actor,
        community,
        `Telegram now shows this community as ${relation.toLowerCase()} for the account`
      );
    }
  }

  /** A community the account can no longer use: posting there stops, and a person decides what next. */
  private async block(
    orgId: string,
    actor: Pick<AgencyActor, 'userId' | 'role'> | null,
    community: { id: string; stage: CommunityStage; title: string },
    reason: string
  ) {
    const fresh = await this.repo.get(orgId, community.id);
    for (const dest of fresh?.destinations ?? []) {
      if (dest.authorizationStatus === 'ACTIVE') {
        await this.publishing
          .handleDestinationUnavailable(orgId, dest.id, 'DISCONNECTED', reason)
          .catch((e) =>
            this.logger.warn(`Could not pause ${dest.id}: ${e?.message}`)
          );
      }
    }
    await this.move(orgId, actor, community, 'BLOCKED', reason);
  }

  /** A fresh look at saved communities, a few at a time, through an account allowed to research. */
  async refresh(
    actor: AgencyActor,
    input: { accountId: string; ids: string[] }
  ) {
    this.access.assert(actor, 'research:run');
    const ids = [...new Set(input.ids ?? [])];
    if (!ids.length)
      throw new BadRequestException('Choose the communities to refresh');
    if (ids.length > MAX_REFRESH_IDS) {
      throw new BadRequestException(
        `Refresh at most ${MAX_REFRESH_IDS} at a time`
      );
    }
    const rows = [];
    for (const id of ids) rows.push(await this.require(actor.orgId, id));
    return this.refreshRows(actor.orgId, actor, input.accountId, rows);
  }

  private async refreshRows(
    orgId: string,
    actor: Pick<AgencyActor, 'userId' | 'role'> | null,
    accountId: string,
    rows: Array<{
      id: string;
      username: string | null;
      stage: CommunityStage;
      title: string;
      operatingAccountId: string | null;
    }>
  ) {
    const withName = rows.filter((r) => r.username);
    const skipped = rows.filter((r) => !r.username).map((r) => r.id);
    let results: Awaited<
      ReturnType<TelegramUserGateway['refreshCommunities']>
    >['results'] = [];
    let waitSeconds: number | null = null;
    if (withName.length) {
      try {
        results = (
          await this.asAccount(orgId, accountId, 'canResearch', (creds) =>
            this.gateway.refreshCommunities(
              creds,
              withName.map((r) => `@${r.username}`)
            )
          )
        ).results;
      } catch (err) {
        if (err instanceof HttpException && err.getStatus() === 429) {
          waitSeconds = 60;
        } else {
          throw err;
        }
      }
    }
    let refreshed = 0;
    let changed = 0;
    const problems: Array<{ id: string; title: string; code: string }> = [];
    const byName = new Map(withName.map((r) => [r.username!.toLowerCase(), r]));
    for (const result of results) {
      const row = byName.get(result.ref.replace(/^@/, '').toLowerCase());
      if (!row) continue;
      if (result.ok && result.community) {
        const out = await this.upsert(
          orgId,
          actor,
          result.community,
          result.relation ?? 'PUBLIC_NOT_JOINED',
          { accountId }
        );
        refreshed += 1;
        if (Object.keys(out.changes).length) changed += 1;
        continue;
      }
      const code = result.error?.code ?? 'UNKNOWN';
      if (code === 'RATE_LIMITED') {
        waitSeconds = 60;
        continue;
      }
      problems.push({ id: row.id, title: row.title, code });
      const gone = code === 'NOT_FOUND' || code === 'PRIVATE';
      await this.repo.update(orgId, row.id, {
        lastErrorCode: code,
        lastRefreshedAt: new Date(),
        ...(gone ? { available: false } : {}),
      });
      await this.repo.addHistory(orgId, row.id, {
        kind: 'AVAILABILITY',
        summary: gone
          ? 'Telegram no longer shows this community publicly'
          : `Lookup failed (${code})`,
        actorUserId: actor?.userId ?? null,
      });
      if (gone) {
        await this.reconcile(orgId, actor, row, 'UNAVAILABLE', accountId);
      }
    }
    return {
      refreshed,
      changed,
      problems,
      skippedWithoutName: skipped.length,
      retryAfterSeconds: waitSeconds,
    };
  }

  /**
   * A bounded, quiet refresh for communities not looked at in a while, through the one account the
   * agency connected first for research. If that account is limited, paused or signed out the run
   * simply ends: no other account is tried, and nothing is retried until the next run.
   */
  async refreshDue(
    options: { olderThanDays?: number; perAgency?: number } = {}
  ) {
    const olderThan = new Date(
      Date.now() - (options.olderThanDays ?? 7) * 86_400_000
    );
    let total = 0;
    for (const orgId of await this.repo.orgsWithCommunities()) {
      const accountId = await this.accounts.firstResearchAccountId(orgId);
      if (!accountId) continue;
      const due = await this.repo.dueForRefresh(
        orgId,
        olderThan,
        Math.min(options.perAgency ?? 10, MAX_REFRESH_IDS)
      );
      if (!due.length) continue;
      try {
        const out = await this.refreshRows(orgId, null, accountId, due);
        total += out.refreshed;
      } catch (err) {
        this.logger.warn(
          `Community refresh for ${orgId} stopped: ${(err as Error).message}`
        );
      }
    }
    return total;
  }

  /** A person reading the latest public messages of a public community. Not stored, not sent to a model. */
  async publicMessages(actor: AgencyActor, id: string, accountId: string) {
    this.access.assert(actor, 'research:run');
    const community = await this.require(actor.orgId, id);
    if (!community.username) {
      throw new BadRequestException(
        'Only communities with a public name can be read here'
      );
    }
    const now = Date.now();
    const recent = (this.viewLog.get(actor.orgId) ?? []).filter(
      (t) => now - t < 60_000
    );
    if (recent.length >= MESSAGE_VIEWS_PER_MINUTE) {
      throw new HttpException(
        'Slow down: read a few communities a minute',
        429
      );
    }
    this.viewLog.set(actor.orgId, [...recent, now]);
    const { messages } = await this.asAccount(
      actor.orgId,
      accountId,
      'canResearch',
      (creds) =>
        this.gateway.communityMessages(creds, `@${community.username}`, 20)
    );
    await this.access.audit(actor, {
      action: 'research.messages_viewed',
      entityType: 'Community',
      entityId: id,
      summary: `Read recent public messages of ${community.title}`,
    });
    return { messages };
  }

  // ==========================================
  // THE DIRECTORY
  // ==========================================
  async list(actor: AgencyActor, filters: CommunityFilters = {}) {
    this.access.assert(actor, 'research:read');
    return this.repo.list(actor.orgId, filters);
  }

  async get(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'research:read');
    const community = await this.require(actor.orgId, id);
    return { community, history: await this.repo.history(actor.orgId, id) };
  }

  async update(
    actor: AgencyActor,
    id: string,
    input: {
      tags?: string[];
      category?: string;
      language?: string;
      notes?: string;
      bookmarked?: boolean;
    }
  ) {
    this.access.assert(actor, 'research:run');
    const before = await this.require(actor.orgId, id);
    const data: Prisma.CommunityUncheckedUpdateManyInput = {};
    if (input.tags !== undefined) data.tags = this.cleanTags(input.tags);
    if (input.category !== undefined)
      data.category = input.category.trim() || null;
    if (input.language !== undefined)
      data.language = input.language.trim() || null;
    if (input.notes !== undefined) data.notes = input.notes.trim() || null;
    if (input.bookmarked !== undefined) data.bookmarked = input.bookmarked;
    const fresh = await this.repo.update(actor.orgId, id, data);
    const changes = this.diff(
      before as unknown as Record<string, unknown>,
      data as Record<string, unknown>
    );
    if (Object.keys(changes).length) {
      await this.repo.addHistory(actor.orgId, id, {
        kind: 'LABELS',
        summary: `Updated ${Object.keys(changes).join(', ')}`,
        changes: changes as unknown as Prisma.InputJsonValue,
        actorUserId: actor.userId,
      });
    }
    return fresh;
  }

  async remove(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'research:run');
    const community = await this.require(actor.orgId, id);
    if (
      [
        'JOINED',
        'JOIN_REQUEST_PENDING',
        'ADVERTISING_ALLOWED',
        'PUBLISHING_AUTHORIZED',
      ].includes(community.stage)
    ) {
      throw new BadRequestException(
        'An account is joined to this community. Leave it, or withdraw its authorization, before removing it from the directory.'
      );
    }
    await this.repo.remove(actor.orgId, id);
    await this.access.audit(actor, {
      action: 'community.removed',
      entityType: 'Community',
      entityId: id,
      summary: community.title,
    });
    return { removed: true };
  }

  /** Metadata only, one row per community: nothing about any person is ever in it. */
  async exportRows(actor: AgencyActor, filters: CommunityFilters = {}) {
    this.access.assert(actor, 'research:read');
    const rows = await this.repo.list(actor.orgId, { ...filters, limit: 500 });
    return rows.map((c) => ({
      title: c.title,
      username: c.username ?? '',
      link: c.username ? `https://t.me/${c.username}` : '',
      kind: c.kind ?? '',
      members: c.memberCount ?? '',
      description: c.description ?? '',
      category: c.category ?? '',
      language: c.language ?? '',
      tags: c.tags.join('; '),
      stage: c.stage,
      relation: c.relation,
      available: c.available ? 'yes' : 'no',
      lastRefreshed: c.lastRefreshedAt ? c.lastRefreshedAt.toISOString() : '',
    }));
  }

  /** The same rows as the JSON export, as CSV. A cell that starts like a formula is defused. */
  async exportCsv(actor: AgencyActor, filters: CommunityFilters = {}) {
    const rows = await this.exportRows(actor, filters);
    const cell = (value: string | number) => {
      let text = String(value ?? '');
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const head = [
      'title',
      'username',
      'link',
      'kind',
      'members',
      'description',
      'category',
      'language',
      'tags',
      'stage',
      'relation',
      'available',
      'lastRefreshed',
    ] as const;
    return [
      head.join(','),
      ...rows.map((r) => head.map((k) => cell(r[k])).join(',')),
    ].join('\n');
  }

  /** Likely repeats the unique keys cannot catch: the same title written the same way. */
  async duplicates(actor: AgencyActor) {
    this.access.assert(actor, 'research:read');
    const rows = await this.repo.list(actor.orgId, { limit: 500 });
    const groups = new Map<string, typeof rows>();
    for (const c of rows) {
      const key = c.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    return [...groups.values()]
      .filter((g) => g.length > 1)
      .map((g) =>
        g.map((c) => ({
          id: c.id,
          title: c.title,
          username: c.username,
          stage: c.stage,
        }))
      );
  }

  // ==========================================
  // THE STEPS TO AN AUTHORIZED DESTINATION
  // ==========================================
  async flagForReview(actor: AgencyActor, id: string, reason: string) {
    this.access.assert(actor, 'community:manage');
    const community = await this.require(actor.orgId, id);
    await this.move(
      actor.orgId,
      actor,
      community,
      'REVIEW_REQUIRED',
      reason?.trim() || 'Marked for review'
    );
    return this.require(actor.orgId, id);
  }

  /** One join, one person's decision, one account that was allowed to join. */
  async join(
    actor: AgencyActor,
    id: string,
    input: { accountId: string; reason: string; confirmed: boolean }
  ) {
    this.access.assert(actor, 'community:manage');
    if (input.confirmed !== true) {
      throw new BadRequestException(
        'Confirm that you are choosing to join this community'
      );
    }
    const reason = (input.reason ?? '').trim();
    if (reason.length < 5) {
      throw new BadRequestException(
        'Say why this community is worth joining (a few words)'
      );
    }
    const community = await this.require(actor.orgId, id);
    if (!['DISCOVERED', 'REVIEW_REQUIRED'].includes(community.stage)) {
      throw new ConflictException(
        community.stage === 'NOT_ELIGIBLE' || community.stage === 'BLOCKED'
          ? 'This community was marked not eligible or blocked. Reopen it for review first.'
          : 'An account is already joined, or has asked to join, this community.'
      );
    }
    if (!community.username) {
      throw new BadRequestException(
        'Only communities with a public name can be joined from here'
      );
    }
    const dailyCap = Number(process.env.AGENCY_JOIN_DAILY_CAP) || 20;
    const used = await this.repo.joinsSince(
      actor.orgId,
      input.accountId,
      new Date(Date.now() - 86_400_000)
    );
    if (used >= dailyCap) {
      throw new HttpException(
        `This account already joined ${used} communities in the last day. Wait, or choose a smaller number.`,
        429
      );
    }
    const joined = await this.asAccount(
      actor.orgId,
      input.accountId,
      'canJoin',
      (creds) => this.gateway.joinCommunity(creds, `@${community.username}`)
    );
    const pending = joined.status === 'JOIN_REQUEST_PENDING';
    const meta = this.fields(joined.community);
    await this.repo.update(actor.orgId, id, {
      ...meta,
      operatingAccountId: input.accountId,
      relation: pending ? 'PUBLIC_NOT_JOINED' : 'MEMBER',
      available: true,
      lastRefreshedAt: new Date(),
    });
    await this.repo.addHistory(actor.orgId, id, {
      kind: 'JOIN',
      summary: `${pending ? 'Asked to join' : 'Joined'}: ${reason}`,
      actorUserId: actor.userId,
    });
    await this.move(
      actor.orgId,
      actor,
      community,
      pending ? 'JOIN_REQUEST_PENDING' : 'JOINED',
      pending
        ? 'Join request sent; waiting for the community’s administrators'
        : `Joined: ${reason}`
    );
    return this.require(actor.orgId, id);
  }

  async leave(actor: AgencyActor, id: string, accountId: string) {
    this.access.assert(actor, 'community:manage');
    const community = await this.require(actor.orgId, id);
    if (!community.username) {
      throw new BadRequestException(
        'Only communities with a public name can be left from here'
      );
    }
    if (
      community.operatingAccountId &&
      community.operatingAccountId !== accountId
    ) {
      throw new BadRequestException(
        'Another account is joined to this community'
      );
    }
    await this.asAccount(actor.orgId, accountId, 'canJoin', (creds) =>
      this.gateway.leaveCommunity(creds, `@${community.username}`)
    );
    for (const dest of community.destinations) {
      if (dest.authorizationStatus === 'ACTIVE') {
        await this.publishing.handleDestinationUnavailable(
          actor.orgId,
          dest.id,
          'REVOKED',
          'The account left the community',
          actor
        );
      }
    }
    // The review of the rules was made from inside, as a member: leaving ends it.
    await this.repo.update(actor.orgId, id, {
      relation: 'PUBLIC_NOT_JOINED',
      operatingAccountId: null,
      adReview: 'NOT_REVIEWED',
    });
    await this.move(
      actor.orgId,
      actor,
      community,
      'REVIEW_REQUIRED',
      'The account left the community'
    );
    return this.require(actor.orgId, id);
  }

  /** Is the join request still waiting, or was it accepted? Asks Telegram about the one account. */
  async checkMembership(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'community:manage');
    const community = await this.require(actor.orgId, id);
    if (!community.operatingAccountId || !community.username) {
      throw new BadRequestException(
        'No account has asked to join this community'
      );
    }
    const resolved = await this.asAccount(
      actor.orgId,
      community.operatingAccountId,
      'canJoin',
      (creds) => this.gateway.resolveCommunity(creds, `@${community.username}`)
    );
    await this.upsert(
      actor.orgId,
      actor,
      resolved.community,
      resolved.relation,
      { accountId: community.operatingAccountId }
    );
    return this.require(actor.orgId, id);
  }

  /** A person read the community's rules and decided. Both answers are kept, with the evidence. */
  async reviewAdvertising(
    actor: AgencyActor,
    id: string,
    input: {
      decision: 'ALLOWED' | 'NOT_ALLOWED';
      note: string;
      evidenceUrl?: string;
      rulesRead?: boolean;
      advertisingPermitted?: boolean;
    }
  ) {
    this.access.assert(actor, 'community:manage');
    const community = await this.require(actor.orgId, id);
    const note = (input.note ?? '').trim();
    if (note.length < 10) {
      throw new BadRequestException(
        'Write down what the rules say about advertising (at least a sentence)'
      );
    }
    let evidence: string | null = null;
    if (input.evidenceUrl?.trim()) {
      try {
        const url = new URL(input.evidenceUrl.trim());
        if (!['http:', 'https:'].includes(url.protocol))
          throw new Error('scheme');
        evidence = url.toString();
      } catch {
        throw new BadRequestException(
          'The evidence link must start with https://'
        );
      }
    }
    if (input.decision === 'ALLOWED') {
      if (!input.rulesRead || !input.advertisingPermitted) {
        throw new BadRequestException(
          'Confirm that you read the community’s rules and that they allow advertising'
        );
      }
      if (community.scam || community.fake) {
        throw new BadRequestException(
          'Telegram marks this community as a scam or fake. It cannot be approved.'
        );
      }
      if (
        !['JOINED', 'ADVERTISING_ALLOWED', 'PUBLISHING_AUTHORIZED'].includes(
          community.stage
        )
      ) {
        throw new ConflictException(
          'Join the community first: the rules are read from inside it'
        );
      }
    }
    const reviewer = await this.repo.userName(actor.userId);
    await this.repo.update(actor.orgId, id, {
      adReview: input.decision,
      adReviewNote: note,
      adReviewEvidenceUrl: evidence,
      adReviewedById: actor.userId,
      adReviewedAt: new Date(),
    });
    await this.repo.addHistory(actor.orgId, id, {
      kind: 'REVIEW',
      summary: `Advertising ${
        input.decision === 'ALLOWED' ? 'allowed' : 'not allowed'
      } (${reviewer ?? 'a team member'}): ${note.slice(0, 200)}`,
      actorUserId: actor.userId,
    });
    const refreshed = await this.require(actor.orgId, id);
    if (input.decision === 'ALLOWED') {
      if (refreshed.stage === 'JOINED') {
        await this.move(
          actor.orgId,
          actor,
          refreshed,
          'ADVERTISING_ALLOWED',
          `Advertising allowed: ${note.slice(0, 120)}`
        );
      }
    } else if (refreshed.stage !== 'NOT_ELIGIBLE') {
      // Whatever the stage, "not allowed" ends posting there.
      for (const dest of refreshed.destinations) {
        if (dest.authorizationStatus === 'ACTIVE') {
          await this.publishing.handleDestinationUnavailable(
            actor.orgId,
            dest.id,
            'REVOKED',
            'Advertising is not allowed in this community',
            actor
          );
        }
      }
      await this.move(
        actor.orgId,
        actor,
        refreshed,
        'NOT_ELIGIBLE',
        `Advertising not allowed: ${note.slice(0, 120)}`
      );
    }
    return this.require(actor.orgId, id);
  }

  /** Registers the community as a place campaigns can post, through one account that may publish. */
  async authorize(actor: AgencyActor, id: string, accountId: string) {
    this.access.assert(actor, 'community:manage');
    const community = await this.require(actor.orgId, id);
    if (community.stage !== 'ADVERTISING_ALLOWED') {
      throw new ConflictException(
        'A person has to record that advertising is allowed here first (Review advertising rules)'
      );
    }
    if (!community.username || !community.telegramId || !community.kind) {
      throw new BadRequestException(
        'Only communities with a public name can receive posts from a user account'
      );
    }
    if (community.adReview !== 'ALLOWED') {
      throw new ConflictException(
        'The advertising review is not recorded as allowed'
      );
    }
    if (
      community.operatingAccountId &&
      community.operatingAccountId !== accountId
    ) {
      throw new BadRequestException(
        'Another account is joined to this community. Posting goes through that account.'
      );
    }
    const { account } = await this.accounts.credentialsFor(
      actor.orgId,
      accountId,
      'canPublish'
    );
    const perms = await this.asAccount(
      actor.orgId,
      accountId,
      'canPublish',
      (creds) =>
        this.gateway.communityPermissions(creds, `@${community.username}`)
    );
    const canPost = perms.canPost;
    const mayPost =
      !!canPost &&
      (community.kind === 'BROADCAST_CHANNEL' || community.kind === 'CHANNEL'
        ? canPost.postMessagesInChannel || canPost.isAdmin
        : canPost.sendMessages);
    if (
      !['MEMBER', 'ADMINISTERED', 'OWNED'].includes(perms.relation) ||
      !mayPost
    ) {
      throw new ConflictException(
        `${account.label} cannot post in this community right now. It has to be a member who is allowed to write there.`
      );
    }
    const chatId = AgencyCommunitiesService.chatIdOf(
      community.kind,
      community.telegramId
    );
    const existing = await this.repo.destinationForChat(actor.orgId, chatId);
    if (existing && existing.communityId !== community.id) {
      throw new ConflictException(
        'This chat is already registered with a bot. Use that registration, or remove it first.'
      );
    }
    const reviewer =
      (await this.repo.userName(actor.userId)) ?? 'a team member';
    const now = new Date();
    const consentExpiresAt = new Date(
      now.getTime() + AUTHORIZATION_DAYS * 86_400_000
    );
    let destinationId: string;
    if (existing) {
      destinationId = existing.id;
      await this.agencyRepo.setDestinationAuthorization(
        actor.orgId,
        existing.id,
        {
          authorizationStatus: 'ACTIVE',
          consentGrantedAt: now,
          consentExpiresAt,
          consentedByName: `Advertising review by ${reviewer}`,
          revokedReason: null,
          lastError: null,
        }
      );
      await this.publishing.unblockForDestination(actor.orgId, existing.id);
    } else {
      const created = await this.repo.createUserDestination(actor.orgId, {
        chatId,
        title: community.title,
        type:
          community.kind === 'GROUP'
            ? 'group'
            : community.kind === 'SUPERGROUP'
            ? 'supergroup'
            : 'channel',
        senderKind: 'USER_ACCOUNT',
        userAccountId: accountId,
        communityId: community.id,
        authorizationStatus: 'ACTIVE',
        isAuthorized: true,
        canPostMessages: true,
        consentGrantedAt: now,
        consentExpiresAt,
        consentedByName: `Advertising review by ${reviewer}`,
        ownerName: community.username ? `@${community.username}` : null,
      });
      destinationId = created.id;
    }
    await this.repo.update(actor.orgId, id, {
      operatingAccountId: accountId,
      relation: this.relationOf(perms.relation),
    });
    await this.move(
      actor.orgId,
      actor,
      community,
      'PUBLISHING_AUTHORIZED',
      `Authorized for posting through ${account.label}`
    );
    await this.repo.addHistory(actor.orgId, id, {
      kind: 'AUTHORIZED',
      summary: `Registered as a place to post through ${
        account.label
      } until ${consentExpiresAt.toISOString().slice(0, 10)}`,
      actorUserId: actor.userId,
    });
    return { community: await this.require(actor.orgId, id), destinationId };
  }

  /** Takes the community off the places campaigns can post. Queued posts there pause. */
  async withdraw(actor: AgencyActor, id: string, reason: string) {
    this.access.assert(actor, 'community:manage');
    const community = await this.require(actor.orgId, id);
    if (community.stage !== 'PUBLISHING_AUTHORIZED') {
      throw new BadRequestException(
        'This community is not authorized for posting'
      );
    }
    for (const dest of community.destinations) {
      if (dest.authorizationStatus === 'ACTIVE') {
        await this.publishing.handleDestinationUnavailable(
          actor.orgId,
          dest.id,
          'REVOKED',
          reason?.trim() || 'Withdrawn by a person',
          actor
        );
      }
    }
    await this.move(
      actor.orgId,
      actor,
      community,
      'ADVERTISING_ALLOWED',
      reason?.trim() || 'Authorization withdrawn'
    );
    return this.require(actor.orgId, id);
  }

  async reopen(actor: AgencyActor, id: string, reason: string) {
    this.access.assert(actor, 'community:manage');
    const community = await this.require(actor.orgId, id);
    if (!['NOT_ELIGIBLE', 'BLOCKED'].includes(community.stage)) {
      throw new BadRequestException(
        'Only a community marked not eligible or blocked can be reopened'
      );
    }
    await this.move(
      actor.orgId,
      actor,
      community,
      'REVIEW_REQUIRED',
      reason?.trim() || 'Reopened for review'
    );
    return this.require(actor.orgId, id);
  }

  async markNotEligible(actor: AgencyActor, id: string, reason: string) {
    this.access.assert(actor, 'community:manage');
    const community = await this.require(actor.orgId, id);
    for (const dest of community.destinations) {
      if (dest.authorizationStatus === 'ACTIVE') {
        await this.publishing.handleDestinationUnavailable(
          actor.orgId,
          dest.id,
          'REVOKED',
          reason?.trim() || 'Marked not eligible',
          actor
        );
      }
    }
    await this.move(
      actor.orgId,
      actor,
      community,
      'NOT_ELIGIBLE',
      reason?.trim() || 'Marked not eligible'
    );
    return this.require(actor.orgId, id);
  }

  /** The id the Bot API and the rest of AgencyOS use for the same chat. */
  static chatIdOf(kind: string, telegramId: string) {
    return kind === 'GROUP' ? `-${telegramId}` : `-100${telegramId}`;
  }

  // ==========================================
  // COMMUNITIES THE AGENCY RUNS: create, edit, invite, review join requests
  // ==========================================
  async createCommunity(
    actor: AgencyActor,
    input: {
      accountId: string;
      kind: 'group' | 'channel';
      title: string;
      about?: string;
      username?: string;
    }
  ) {
    this.access.assert(actor, 'community:manage');
    const title = (input.title ?? '').trim();
    if (title.length < 1 || title.length > 128) {
      throw new BadRequestException(
        'Give the community a name of up to 128 characters'
      );
    }
    if (input.username && !USERNAME.test(input.username.replace(/^@/, ''))) {
      throw new BadRequestException(
        'A public name has 4 to 32 letters, digits or underscores'
      );
    }
    const made = await this.asAccount(
      actor.orgId,
      input.accountId,
      'canManage',
      (creds) =>
        this.gateway.createCommunity(creds, {
          kind: input.kind,
          title,
          about: input.about?.trim() || undefined,
          username: input.username?.replace(/^@/, '') || undefined,
        })
    );
    const meta = this.fields(made.community);
    const row = await this.repo.create(actor.orgId, {
      ...meta,
      relation: 'OWNED',
      stage: 'JOINED',
      stageReason: 'Created by this agency',
      operatingAccountId: input.accountId,
      source: 'created',
      createdById: actor.userId,
      lastRefreshedAt: new Date(),
    });
    await this.repo.addHistory(actor.orgId, row.id, {
      kind: 'CREATED',
      summary: `Created ${input.kind} “${title}”`,
      toStage: 'JOINED',
      actorUserId: actor.userId,
    });
    await this.access.audit(actor, {
      action: 'community.created',
      entityType: 'Community',
      entityId: row.id,
      summary: title,
    });
    return { community: row, inviteLink: made.inviteLink ?? null };
  }

  private async administered(actor: AgencyActor, id: string) {
    const community = await this.require(actor.orgId, id);
    if (
      !community.operatingAccountId ||
      !['OWNED', 'ADMINISTERED'].includes(community.relation)
    ) {
      throw new BadRequestException(
        'Only communities this agency owns or administers can be managed here'
      );
    }
    return community;
  }

  /** The ref the worker takes for a community: its public name (there is no way to address a private one). */
  private refOf(c: { username: string | null }) {
    if (!c.username) {
      throw new BadRequestException(
        'Only communities with a public name can be managed from here'
      );
    }
    return `@${c.username}`;
  }

  async updateCommunity(
    actor: AgencyActor,
    id: string,
    input: { title?: string; about?: string }
  ) {
    this.access.assert(actor, 'community:manage');
    const community = await this.administered(actor, id);
    if (input.title === undefined && input.about === undefined) {
      throw new BadRequestException('Nothing to change');
    }
    const updated = await this.asAccount(
      actor.orgId,
      community.operatingAccountId!,
      'canManage',
      (creds) =>
        this.gateway.updateCommunity(creds, this.refOf(community), {
          title: input.title?.trim() || undefined,
          about: input.about === undefined ? undefined : input.about.trim(),
        })
    );
    await this.upsert(
      actor.orgId,
      actor,
      updated.community,
      community.relation as UserGatewayRelation,
      {
        accountId: community.operatingAccountId!,
      }
    );
    await this.access.audit(actor, {
      action: 'community.updated',
      entityType: 'Community',
      entityId: id,
      summary: community.title,
    });
    return this.require(actor.orgId, id);
  }

  async inviteLink(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'community:manage');
    const community = await this.administered(actor, id);
    const { link } = await this.asAccount(
      actor.orgId,
      community.operatingAccountId!,
      'canManage',
      (creds) => this.gateway.inviteLink(creds, this.refOf(community))
    );
    await this.access.audit(actor, {
      action: 'community.invite_link_read',
      entityType: 'Community',
      entityId: id,
      summary: community.title,
    });
    return { link };
  }

  /** Who has asked to join a community this agency administers: what Telegram shows its administrators, not stored. */
  async joinRequests(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'community:manage');
    const community = await this.administered(actor, id);
    const { requests } = await this.asAccount(
      actor.orgId,
      community.operatingAccountId!,
      'canManage',
      (creds) => this.gateway.joinRequests(creds, this.refOf(community), 50)
    );
    await this.access.audit(actor, {
      action: 'community.join_requests_viewed',
      entityType: 'Community',
      entityId: id,
      summary: `${requests.length} request(s) of ${community.title}`,
    });
    return { requests };
  }

  /** One person's request, one decision. There is no way to approve or decline a list. */
  async decideJoinRequest(
    actor: AgencyActor,
    id: string,
    input: { userId: string; approve: boolean }
  ) {
    this.access.assert(actor, 'community:manage');
    if (!/^\d{1,20}$/.test(input.userId ?? '')) {
      throw new BadRequestException('Choose one request');
    }
    const community = await this.administered(actor, id);
    await this.asAccount(
      actor.orgId,
      community.operatingAccountId!,
      'canManage',
      (creds) =>
        this.gateway.decideJoinRequest(
          creds,
          this.refOf(community),
          input.userId,
          input.approve === true
        )
    );
    await this.repo.addHistory(actor.orgId, id, {
      kind: 'JOIN_REQUEST',
      summary: `A join request was ${input.approve ? 'approved' : 'declined'}`,
      actorUserId: actor.userId,
    });
    await this.access.audit(actor, {
      action: input.approve
        ? 'community.join_request_approved'
        : 'community.join_request_declined',
      entityType: 'Community',
      entityId: id,
      summary: community.title,
    });
    return { decided: true };
  }

  /** The communities the account already runs or belongs to, brought into the directory. */
  async syncMine(actor: AgencyActor, accountId: string) {
    this.access.assert(actor, 'community:manage');
    const { communities } = await this.asAccount(
      actor.orgId,
      accountId,
      'canManage',
      (creds) => this.gateway.myCommunities(creds, 200)
    );
    let added = 0;
    let updated = 0;
    for (const { community, relation } of communities) {
      if (!['OWNED', 'ADMINISTERED'].includes(relation)) continue;
      const out = await this.upsert(actor.orgId, actor, community, relation, {
        accountId,
        source: 'account',
      });
      const row = await this.repo.get(actor.orgId, out.id);
      if (row && ['DISCOVERED', 'REVIEW_REQUIRED'].includes(row.stage)) {
        await this.repo.update(actor.orgId, row.id, {
          operatingAccountId: accountId,
        });
        await this.move(
          actor.orgId,
          actor,
          row,
          'JOINED',
          'This account runs the community'
        );
      }
      out.created ? (added += 1) : (updated += 1);
    }
    return { added, updated };
  }
}
