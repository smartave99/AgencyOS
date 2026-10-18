/**
 * Shared harness for the integration specs. Everything except Telegram and
 * notifications is the real code running against a real PostgreSQL database
 * (AGENCYOS_TEST_DATABASE_URL). Integration specs skip themselves when it is unset.
 */
import { randomBytes } from 'crypto';
import { AgencyRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AgencyRepository } from './agency.repository';
import { AgencyAccessRepository } from './agency.access.repository';
import { AgencyAccessService, AgencyActor } from './agency.access.service';
import { AgencyPublishingRepository } from './agency.publishing.repository';
import { AgencyPublishingService } from './agency.publishing.service';
import { AgencyTelegramService } from './agency.telegram.service';
import { AgencyTelegramBotsService } from './agency.telegram.bots.service';
import { AgencyTelegramUsersRepository } from './agency.telegram.users.repository';
import { AgencyTelegramUsersService } from './agency.telegram.users.service';
import { AgencyTelegramOverviewService } from './agency.telegram.overview.service';
import { AgencyCommunitiesRepository } from './agency.communities.repository';
import { AgencyCommunitiesService } from './agency.communities.service';
import { AgencyService, CampaignInput } from './agency.service';
import { AgencyPortalService } from './agency.portal.service';
import { AgencyCrmRepository } from './agency.crm.repository';
import { AgencyCrmService } from './agency.crm.service';
import { AgencyLeadsRepository } from './agency.leads.repository';
import { AgencyLeadsService } from './agency.leads.service';
import { AgencyWhatsappRepository } from './agency.whatsapp.repository';
import { AgencyWhatsappService } from './agency.whatsapp.service';
import { AgencyWhatsappOutreachService } from './agency.whatsapp.outreach.service';
import { DisabledWhatsappBusinessProvider } from '@gitroom/nestjs-libraries/integrations/whatsapp/whatsapp.business.provider';
import { AgencyPlatformsService } from './agency.platforms.service';
import { AgencyAiRepository } from './agency.ai.repository';
import { AgencyAiGatewayService } from './agency.ai.gateway.service';
import { AgencyAiService } from './agency.ai.service';
import { AgencyAiToolsService } from './agency.ai.tools.service';
import { AgencyAiDiscoveryService } from './agency.ai.discovery.service';
import { AgencyAiAgentService } from './agency.ai.agent.service';
import { AgencyAgentGatewayRepository } from './agency.agent.gateway.repository';
import { AgencyAgentGatewayService } from './agency.agent.gateway.service';
import {
  TelegramUserGateway,
  TelegramUserGatewayError,
  UserGatewayCanPost,
  UserGatewayCommunity,
  UserGatewayErrorCode,
  UserGatewayMe,
  UserGatewayRelation,
} from '@gitroom/nestjs-libraries/integrations/telegram/telegram.user.gateway';
import {
  BotPermissions,
  TelegramAd,
  TelegramChatInfo,
  TelegramGateway,
  TelegramGatewayError,
  TelegramInboundUpdate,
  TelegramSendResult,
} from '@gitroom/nestjs-libraries/integrations/telegram/telegram.gateway';

export const TEST_DB_URL = process.env.AGENCYOS_TEST_DATABASE_URL;
export const describeDb = TEST_DB_URL ? describe : describe.skip;

const OK_PERMS: BotPermissions = {
  isAdmin: true,
  canPostMessages: true,
  canDeleteMessages: false,
  canInviteUsers: false,
};

/** A scripted stand-in for Telegram: records what would have been sent and can be told to fail. */
export class FakeTelegramGateway extends TelegramGateway {
  sent: Array<{ chatId: string; ad: TelegramAd; messageId: string }> = [];
  notices: Array<{ chatId: string; text: string }> = [];
  perms = new Map<string, BotPermissions>();
  admins = new Map<string, Set<number>>();
  sendErrors = new Map<string, TelegramGatewayError[]>();
  permErrors = new Map<string, TelegramGatewayError>();
  sendDelayMs = 0;
  private nextId = 1000;
  // Bots connected in the app: bound(token) hands out one fake per token, each with its own log.
  readonly bots = new Map<string, FakeTelegramGateway>();
  rejectedTokens = new Set<string>();
  private fakeToken: string | null = null;
  private parent: FakeTelegramGateway | null = null;

  override isConfigured() {
    return true;
  }
  override bound(token: string): TelegramGateway {
    let bot = this.bots.get(token);
    if (!bot) {
      bot = new FakeTelegramGateway();
      bot.fakeToken = token;
      bot.parent = this;
      this.bots.set(token, bot);
    }
    return bot;
  }
  override async getBotInfo() {
    if (this.fakeToken) {
      if (this.parent?.rejectedTokens.has(this.fakeToken)) {
        throw new TelegramGatewayError(
          'UNCONFIGURED',
          'Telegram bot token was rejected'
        );
      }
      const id = Number(this.fakeToken.split(':')[0]);
      return { id, username: `bot_${id}` };
    }
    return { id: 1, username: 'agencyos_test_bot' };
  }
  override async getChat(ref: string): Promise<TelegramChatInfo> {
    return {
      id: ref.startsWith('@') ? '-1009999999' : ref,
      type: 'channel',
      title: `Chat ${ref}`,
    };
  }
  override async getBotPermissions(chatId: string): Promise<BotPermissions> {
    const err = this.permErrors.get(chatId);
    if (err) throw err;
    return this.perms.get(chatId) ?? OK_PERMS;
  }
  override async isChatAdmin(chatId: string, userId: number) {
    return this.admins.get(chatId)?.has(userId) ?? false;
  }
  override async sendNotice(chatId: string, text: string) {
    this.notices.push({ chatId, text });
  }
  override async getUpdates(): Promise<TelegramInboundUpdate[]> {
    return [];
  }
  override async sendAd(
    chatId: string,
    ad: TelegramAd
  ): Promise<TelegramSendResult> {
    this.validateAd(ad);
    if (this.sendDelayMs)
      await new Promise((r) => setTimeout(r, this.sendDelayMs));
    const queued = this.sendErrors.get(chatId);
    if (queued?.length) {
      throw queued.length > 1 ? queued.shift()! : queued[0]; // last error repeats forever
    }
    const messageId = String(this.nextId++);
    this.sent.push({ chatId, ad, messageId });
    return {
      primaryMessageId: messageId,
      messageIds: [messageId],
      releaseUrl: `https://t.me/c/${chatId.replace('-100', '')}/${messageId}`,
    };
  }

  sentTo(chatId: string) {
    return this.sent.filter((s) => s.chatId === chatId);
  }
  failSendsTo(chatId: string, error: TelegramGatewayError) {
    this.sendErrors.set(chatId, [error]);
  }
  clearFailures(chatId: string) {
    this.sendErrors.delete(chatId);
  }
  makeAdmin(chatId: string, userId: number) {
    this.admins.set(chatId, (this.admins.get(chatId) ?? new Set()).add(userId));
  }
}

/** One public community in the fake Telegram's world, with who belongs to it. */
export interface FakeCommunity {
  community: UserGatewayCommunity;
  owner?: string; // session
  admins: Set<string>;
  members: Set<string>;
  pending: Set<string>;
  joinRequests: Array<{
    userId: string;
    username: string | null;
    date: string;
    bio: string | null;
  }>;
  messages: Array<{ id: string; date: string; text: string }>;
  canWrite: boolean;
}

/**
 * A scripted stand-in for the Telegram worker: it speaks the same contract (docs/TELEGRAM_WORKER_CONTRACT.md)
 * over an in-memory world, can be told to fail, and keeps a log of every request so tests can prove what
 * was never asked for. It proves our code against our idea of Telegram, not against Telegram.
 */
export class FakeTelegramUserGateway extends TelegramUserGateway {
  calls: Array<{ path: string; body: any }> = [];
  errors = new Map<string, TelegramUserGatewayError[]>();
  /** Failures that happen once and then clear: the next request goes through. */
  once = new Map<string, TelegramUserGatewayError[]>();
  people = new Map<
    string,
    UserGatewayMe & { phone: string; password?: string }
  >();
  logins = new Map<
    string,
    { phone: string; code: string; passwordOk: boolean }
  >();
  sessions = new Map<string, string>(); // session -> person id
  revoked = new Set<string>();
  world = new Map<string, FakeCommunity>(); // lower-case username -> community
  sent: Array<{ ref: string; session: string; ad: any }> = [];
  code = '12345';
  private n = 1;

  override isConfigured() {
    return true;
  }
  protected override async getHealth() {
    return { ok: true, version: 'test', telethon: 'fake', uptimeSeconds: 1 };
  }

  /** A person who can sign in with this phone number. */
  person(
    phone: string,
    opts: { id?: string; username?: string; password?: string } = {}
  ) {
    const id = opts.id ?? String(900000 + this.n++);
    const me = {
      id,
      username: opts.username ?? `person${id}`,
      firstName: 'Sam',
      lastName: 'Seller',
      premium: false,
      phoneMasked: `${phone.slice(0, 3)}•••••${phone.slice(-4)}`,
      phone,
      password: opts.password,
    };
    this.people.set(phone, me);
    return me;
  }

  community(
    username: string,
    over: Partial<UserGatewayCommunity> = {},
    extra: Partial<Omit<FakeCommunity, 'community'>> = {}
  ): FakeCommunity {
    const id = String(1000000 + this.n++);
    const entry: FakeCommunity = {
      community: {
        telegramId: id,
        kind: 'SUPERGROUP',
        title: `Community ${username}`,
        username,
        link: `https://t.me/${username}`,
        description: `About ${username}`,
        memberCount: 1200,
        verified: false,
        scam: false,
        fake: false,
        joinRequestRequired: false,
        slowModeSeconds: null,
        hasLinkedChat: false,
        restrictionReasons: [],
        ...over,
      },
      admins: new Set(),
      members: new Set(),
      pending: new Set(),
      joinRequests: [],
      messages: [],
      canWrite: true,
      ...extra,
    };
    this.world.set(username.toLowerCase(), entry);
    return entry;
  }

  fail(path: string, ...errors: TelegramUserGatewayError[]) {
    this.errors.set(path, errors);
  }
  failOnce(path: string, ...errors: TelegramUserGatewayError[]) {
    this.once.set(path, errors);
  }
  err(
    code: UserGatewayErrorCode,
    message = code as string,
    retryAfter?: number
  ) {
    return new TelegramUserGatewayError(code, message, retryAfter);
  }
  asked(path: string) {
    return this.calls.filter((c) => c.path === path);
  }

  private relationFor(
    entry: FakeCommunity,
    session: string
  ): UserGatewayRelation {
    if (entry.owner === session) return 'OWNED';
    if (entry.admins.has(session)) return 'ADMINISTERED';
    if (entry.members.has(session)) return 'MEMBER';
    return 'PUBLIC_NOT_JOINED';
  }
  private canPostFor(
    entry: FakeCommunity,
    session: string
  ): UserGatewayCanPost | null {
    const relation = this.relationFor(entry, session);
    if (relation === 'PUBLIC_NOT_JOINED') return null;
    const admin = relation === 'OWNED' || relation === 'ADMINISTERED';
    return {
      sendMessages: admin || entry.canWrite,
      sendMedia: admin || entry.canWrite,
      isAdmin: admin,
      postMessagesInChannel: admin,
      slowModeSeconds: entry.community.slowModeSeconds,
    };
  }
  private find(ref: string) {
    const name = ref
      .replace(/^https?:\/\/t\.me\//i, '')
      .replace(/^@/, '')
      .toLowerCase();
    const entry = this.world.get(name);
    if (!entry) throw this.err('NOT_FOUND', 'No such community');
    return entry;
  }
  private who(body: any) {
    const session = body?.account?.session;
    if (!session || !this.sessions.has(session) || this.revoked.has(session)) {
      throw this.err('SESSION_INVALID', 'The session is not authorized');
    }
    return session as string;
  }

  protected override async post<T>(
    path: string,
    body: Record<string, unknown>
  ): Promise<T> {
    this.calls.push({ path, body: JSON.parse(JSON.stringify(body)) });
    const first = this.once.get(path);
    if (first?.length) throw first.shift()!;
    const queued = this.errors.get(path);
    if (queued?.length) throw queued.length > 1 ? queued.shift()! : queued[0];
    const result: any = this.handle(path, body as any);
    return { ok: true, ...result } as T;
  }

  private handle(path: string, body: any): any {
    switch (path) {
      case '/v1/login/start': {
        const person = this.people.get(body.phone);
        if (!person) throw this.err('PHONE_INVALID');
        const loginId = `login-${this.n++}`;
        this.logins.set(loginId, {
          phone: body.phone,
          code: this.code,
          passwordOk: !person.password,
        });
        return { loginId, codeDelivery: 'app', timeoutSeconds: 600 };
      }
      case '/v1/login/code': {
        const login = this.logins.get(body.loginId);
        if (!login) throw this.err('LOGIN_NOT_FOUND');
        if (body.code !== login.code) throw this.err('CODE_INVALID');
        const person = this.people.get(login.phone)!;
        if (person.password && !login.passwordOk)
          return { status: 'password_required' };
        return this.authorize(person, body.loginId);
      }
      case '/v1/login/password': {
        const login = this.logins.get(body.loginId);
        if (!login) throw this.err('LOGIN_NOT_FOUND');
        const person = this.people.get(login.phone)!;
        if (body.password !== person.password)
          throw this.err('PASSWORD_INVALID');
        return this.authorize(person, body.loginId);
      }
      case '/v1/login/cancel':
        this.logins.delete(body.loginId);
        return { cancelled: true };
      case '/v1/account/status': {
        const session = body.account?.session;
        const id = this.sessions.get(session);
        if (!id || this.revoked.has(session)) return { authorized: false };
        return { authorized: true, me: this.meOf(id) };
      }
      case '/v1/account/logout':
        this.revoked.add(this.who(body));
        return { loggedOut: true };
    }
    const session = this.who(body);
    switch (path) {
      case '/v1/communities/search': {
        const q = String(body.query).toLowerCase();
        const results = [...this.world.values()]
          .filter(
            (e) =>
              e.community.title.toLowerCase().includes(q) ||
              (e.community.username ?? '').toLowerCase().includes(q)
          )
          .slice(0, body.limit)
          .map((e) => e.community);
        return { results };
      }
      case '/v1/communities/resolve': {
        const e = this.find(body.ref);
        return {
          community: e.community,
          relation: this.relationFor(e, session),
          canPost: this.canPostFor(e, session),
        };
      }
      case '/v1/communities/refresh':
        return {
          results: (body.refs as string[]).map((ref) => {
            try {
              const e = this.find(ref);
              return {
                ref,
                ok: true,
                community: e.community,
                relation: this.relationFor(e, session),
              };
            } catch (err) {
              const g = err as TelegramUserGatewayError;
              return {
                ref,
                ok: false,
                error: { code: g.code, message: g.message },
              };
            }
          }),
        };
      case '/v1/communities/messages':
        return { messages: this.find(body.ref).messages.slice(0, body.limit) };
      case '/v1/communities/mine':
        return {
          communities: [...this.world.values()]
            .filter((e) => this.relationFor(e, session) !== 'PUBLIC_NOT_JOINED')
            .map((e) => ({
              community: e.community,
              relation: this.relationFor(e, session),
            })),
        };
      case '/v1/communities/permissions': {
        const e = this.find(body.ref);
        return {
          relation: this.relationFor(e, session),
          canPost: this.canPostFor(e, session),
        };
      }
      case '/v1/communities/join': {
        const e = this.find(body.ref);
        if (e.community.joinRequestRequired) {
          e.pending.add(session);
          return { status: 'JOIN_REQUEST_PENDING', community: e.community };
        }
        e.members.add(session);
        return { status: 'JOINED', community: e.community };
      }
      case '/v1/communities/leave': {
        const e = this.find(body.ref);
        e.members.delete(session);
        return { left: true };
      }
      case '/v1/communities/create': {
        const username = body.username ?? `created${this.n}`;
        const e = this.community(username, {
          title: body.title,
          description: body.about ?? null,
          kind: body.kind === 'channel' ? 'BROADCAST_CHANNEL' : 'SUPERGROUP',
          memberCount: 1,
        });
        e.owner = session;
        return {
          community: e.community,
          inviteLink: `https://t.me/+invite${this.n}`,
        };
      }
      case '/v1/communities/update': {
        const e = this.find(body.ref);
        if (
          this.relationFor(e, session) !== 'OWNED' &&
          this.relationFor(e, session) !== 'ADMINISTERED'
        ) {
          throw this.err('FORBIDDEN');
        }
        if (body.title) e.community.title = body.title;
        if (body.about !== undefined) e.community.description = body.about;
        return { community: e.community };
      }
      case '/v1/communities/invite-link': {
        const e = this.find(body.ref);
        if (this.relationFor(e, session) === 'PUBLIC_NOT_JOINED')
          throw this.err('FORBIDDEN');
        return { link: `https://t.me/+${e.community.telegramId}` };
      }
      case '/v1/communities/join-requests': {
        const e = this.find(body.ref);
        if (!['OWNED', 'ADMINISTERED'].includes(this.relationFor(e, session)))
          throw this.err('FORBIDDEN');
        return { requests: e.joinRequests.slice(0, body.limit) };
      }
      case '/v1/communities/join-requests/decide': {
        const e = this.find(body.ref);
        if (!['OWNED', 'ADMINISTERED'].includes(this.relationFor(e, session)))
          throw this.err('FORBIDDEN');
        e.joinRequests = e.joinRequests.filter((r) => r.userId !== body.userId);
        return { decided: true };
      }
      case '/v1/messages/send': {
        const e = this.find(body.ref);
        const can = this.canPostFor(e, session);
        if (!can?.sendMessages)
          throw this.err('FORBIDDEN', 'Writing is not allowed');
        this.sent.push({ ref: body.ref, session, ad: body.ad });
        const id = String(5000 + this.sent.length);
        return {
          messageIds: [id],
          primaryMessageId: id,
          releaseUrl: e.community.username
            ? `https://t.me/${e.community.username}/${id}`
            : null,
        };
      }
    }
    throw this.err('UNSUPPORTED', `No such endpoint ${path}`);
  }

  private meOf(id: string): UserGatewayMe {
    const person = [...this.people.values()].find((p) => p.id === id)!;
    const { phone: _phone, password: _password, ...me } = person;
    return me;
  }
  private authorize(
    person: UserGatewayMe & { phone: string },
    loginId: string
  ) {
    this.logins.delete(loginId);
    const session = `session-${this.n++}-${person.id}`;
    this.sessions.set(session, person.id);
    return { status: 'authorized', session, me: this.meOf(person.id) };
  }
}

export interface Harness {
  prisma: PrismaService;
  gateway: FakeTelegramGateway;
  notifications: { inAppNotification: jest.Mock };
  agencyRepo: AgencyRepository;
  accessRepo: AgencyAccessRepository;
  jobsRepo: AgencyPublishingRepository;
  access: AgencyAccessService;
  publishing: AgencyPublishingService;
  telegram: AgencyTelegramService;
  bots: AgencyTelegramBotsService;
  userGateway: FakeTelegramUserGateway;
  users: AgencyTelegramUsersService;
  overview: AgencyTelegramOverviewService;
  communities: AgencyCommunitiesService;
  agency: AgencyService;
  portal: AgencyPortalService;
  crm: AgencyCrmService;
  leads: AgencyLeadsService;
  whatsapp: AgencyWhatsappService;
  whatsappOutreach: AgencyWhatsappOutreachService;
  platforms: AgencyPlatformsService;
  aiGateway: AgencyAiGatewayService;
  ai: AgencyAiService;
  aiTools: AgencyAiToolsService;
  aiDiscovery: AgencyAiDiscoveryService;
  aiAgent: AgencyAiAgentService;
  agents: AgencyAgentGatewayService;
}

export async function buildHarness(): Promise<Harness> {
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.AGENCY_SEND_DELAY_MS = '0';
  process.env.AGENCY_JOB_BACKOFF_SECONDS = '60';
  process.env.AGENCY_JOB_MAX_ATTEMPTS = '3';
  // The "server bot": chats registered without choosing one use it, as before bots could be added.
  process.env.AGENCY_TELEGRAM_BOT_TOKEN =
    '100000:server-bot-token-for-tests-0123456789';
  process.env.JWT_SECRET ||= 'test-secret-for-sealing-bot-tokens';
  const prisma = new PrismaService();
  await prisma.$connect();
  const gateway = new FakeTelegramGateway();
  const notifications = {
    inAppNotification: jest.fn().mockResolvedValue(undefined),
  };
  const agencyRepo = new AgencyRepository(prisma);
  const accessRepo = new AgencyAccessRepository(prisma);
  const jobsRepo = new AgencyPublishingRepository(prisma);
  const access = new AgencyAccessService(accessRepo, agencyRepo);
  const bots = new AgencyTelegramBotsService(
    agencyRepo,
    jobsRepo,
    access,
    gateway
  );
  const userGateway = new FakeTelegramUserGateway();
  const users = new AgencyTelegramUsersService(
    new AgencyTelegramUsersRepository(prisma),
    access,
    userGateway
  );
  const overview = new AgencyTelegramOverviewService(access, bots, users);
  const publishing = new AgencyPublishingService(
    agencyRepo,
    jobsRepo,
    gateway,
    access,
    notifications as any,
    bots,
    users,
    userGateway
  );
  const communities = new AgencyCommunitiesService(
    new AgencyCommunitiesRepository(prisma),
    users,
    access,
    publishing,
    agencyRepo,
    userGateway
  );
  const leads = new AgencyLeadsService(
    new AgencyLeadsRepository(prisma),
    agencyRepo,
    access,
    bots
  );
  const whatsappRepo = new AgencyWhatsappRepository(prisma);
  const whatsapp = new AgencyWhatsappService(
    whatsappRepo,
    access,
    new DisabledWhatsappBusinessProvider()
  );
  const telegram = new AgencyTelegramService(
    agencyRepo,
    jobsRepo,
    publishing,
    access,
    bots,
    leads
  );
  const agency = new AgencyService(agencyRepo, jobsRepo, publishing, access);
  const portal = new AgencyPortalService(agencyRepo, access, publishing);
  const platforms = new AgencyPlatformsService(agencyRepo, access);
  const crm = new AgencyCrmService(
    new AgencyCrmRepository(prisma),
    agencyRepo,
    access
  );
  const aiGateway = new AgencyAiGatewayService(
    new AgencyAiRepository(prisma),
    access
  );
  const ai = new AgencyAiService(aiGateway);
  const whatsappOutreach = new AgencyWhatsappOutreachService(
    whatsappRepo,
    agencyRepo,
    access,
    aiGateway
  );
  const aiTools = new AgencyAiToolsService(
    new AgencyAiRepository(prisma),
    aiGateway,
    access
  );
  const aiDiscovery = new AgencyAiDiscoveryService(aiGateway, access);
  const aiAgent = new AgencyAiAgentService(
    aiGateway,
    access,
    agency,
    telegram,
    crm,
    ai
  );
  const agents = new AgencyAgentGatewayService(
    new AgencyAgentGatewayRepository(prisma),
    access,
    accessRepo,
    aiAgent,
    communities,
    users
  );
  return {
    prisma,
    gateway,
    notifications,
    agencyRepo,
    accessRepo,
    jobsRepo,
    access,
    publishing,
    telegram,
    bots,
    userGateway,
    users,
    overview,
    communities,
    agency,
    portal,
    platforms,
    crm,
    leads,
    whatsapp,
    whatsappOutreach,
    aiGateway,
    ai,
    aiTools,
    aiDiscovery,
    aiAgent,
    agents,
  };
}

const rid = () => randomBytes(4).toString('hex');

export interface Tenant {
  orgId: string;
  customerId: string;
  owner: AgencyActor;
  manager: AgencyActor;
  sales: AgencyActor;
  salesManager: AgencyActor;
  analyst: AgencyActor;
  client: AgencyActor;
  userIds: {
    owner: string;
    manager: string;
    sales: string;
    salesManager: string;
    analyst: string;
    client: string;
  };
}

/** One agency with a user per role and one client. Unique ids per call keep tests independent. */
export async function seedTenant(
  h: Harness,
  label = 'agency'
): Promise<Tenant> {
  const org = await h.prisma.organization.create({
    data: { name: `${label}-${rid()}` },
  });
  const customer = await h.prisma.customer.create({
    data: { orgId: org.id, name: `Client ${rid()}`, companyName: 'Acme Ltd' },
  });

  const mk = async (
    name: string,
    orgRole: 'SUPERADMIN' | 'ADMIN' | 'USER',
    agencyRole?: AgencyRole,
    customerId?: string
  ) => {
    const user = await h.prisma.user.create({
      data: {
        email: `${name}-${rid()}@test.local`,
        providerName: 'LOCAL',
        name,
        activated: true,
        timezone: 0,
      } as Prisma.UserUncheckedCreateInput,
    });
    await h.prisma.userOrganization.create({
      data: { userId: user.id, organizationId: org.id, role: orgRole },
    });
    if (agencyRole)
      await h.accessRepo.upsertMember(
        org.id,
        user.id,
        agencyRole,
        customerId ?? null
      );
    const actor = await h.access.resolveActor(org, user, orgRole);
    return { user, actor };
  };

  const owner = await mk('owner', 'SUPERADMIN');
  const manager = await mk('manager', 'ADMIN', AgencyRole.CAMPAIGN_MANAGER); // explicit role beats the ADMIN fallback
  const sales = await mk('sales', 'USER');
  const salesManager = await mk('salesmgr', 'USER', AgencyRole.SALES_MANAGER);
  const analyst = await mk('analyst', 'USER', AgencyRole.ANALYST);
  const client = await mk('client', 'USER', AgencyRole.CLIENT, customer.id);
  return {
    orgId: org.id,
    customerId: customer.id,
    owner: owner.actor,
    manager: manager.actor,
    sales: sales.actor,
    salesManager: salesManager.actor,
    analyst: analyst.actor,
    client: client.actor,
    userIds: {
      owner: owner.user.id,
      manager: manager.user.id,
      sales: sales.user.id,
      salesManager: salesManager.user.id,
      analyst: analyst.user.id,
      client: client.user.id,
    },
  };
}

/** A destination that has completed the admin-consent flow. */
export async function activeDestination(
  h: Harness,
  orgId: string,
  opts: Partial<Prisma.TelegramDestinationUncheckedCreateInput> = {}
) {
  const n = Math.floor(Math.random() * 1e9);
  return h.prisma.telegramDestination.create({
    data: {
      orgId,
      chatId: `-100${n}`,
      title: `Channel ${rid()}`,
      type: 'channel',
      authorizationStatus: 'ACTIVE',
      isAuthorized: true,
      canPostMessages: true,
      consentGrantedAt: new Date(),
      consentExpiresAt: new Date(Date.now() + 365 * 86400000),
      consentedByName: 'Test Admin',
      ...opts,
    },
  });
}

export async function draftCampaign(
  h: Harness,
  t: Tenant,
  destinationIds: string[],
  overrides: Partial<CampaignInput> = {}
) {
  return h.agency.createCampaign(t.sales, {
    customerId: t.customerId,
    name: `Campaign ${rid()}`,
    contentTitle: 'Launch offer',
    contentBody: 'Fresh fruit delivered daily. <b>Order today</b> & save.',
    ctaLink: 'https://example.com/offer',
    ctaText: 'Order now',
    startDate: new Date(Date.now() - 60_000),
    destinations: destinationIds.map((id) => ({
      destinationType: 'TELEGRAM' as const,
      telegramDestinationId: id,
    })),
    ...overrides,
  });
}

/** sales submits → manager approves. Returns the approved campaign id. */
export async function approvedCampaign(
  h: Harness,
  t: Tenant,
  destinationIds: string[],
  overrides: Partial<CampaignInput> = {}
) {
  const c = await draftCampaign(h, t, destinationIds, overrides);
  const approval = await h.agency.submitForApproval(
    t.sales,
    c.id,
    'please review'
  );
  await h.agency.reviewCampaign(
    t.manager,
    approval.id,
    'APPROVE',
    'looks good'
  );
  return c.id;
}

export async function scheduledCampaign(
  h: Harness,
  t: Tenant,
  destinationIds: string[],
  overrides: Partial<CampaignInput> = {}
) {
  const id = await approvedCampaign(h, t, destinationIds, overrides);
  await h.agency.scheduleCampaign(t.manager, id);
  return id;
}

export async function campaignStatus(h: Harness, id: string) {
  return (await h.prisma.campaign.findUniqueOrThrow({ where: { id } })).status;
}

export async function jobsOf(h: Harness, campaignId: string) {
  return h.prisma.postingJob.findMany({
    where: { campaignId },
    orderBy: { createdAt: 'asc' },
  });
}

/** Makes every queued job of a campaign due now, as if its wait elapsed. */
export async function makeJobsDue(h: Harness, campaignId: string) {
  await h.prisma.postingJob.updateMany({
    where: { campaignId, status: 'PENDING' },
    data: { nextAttemptAt: new Date(Date.now() - 1000) },
  });
}

export const gatewayError = (
  kind: ConstructorParameters<typeof TelegramGatewayError>[0],
  message = kind as string,
  retryAfter?: number
) => new TelegramGatewayError(kind, message, retryAfter);

/** Waits for fire-and-forget dispatches (kicked by publish/retry) to finish. */
export async function settle(h: Harness, campaignId: string, timeoutMs = 3000) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + timeoutMs;
  // 1. wait for any in-flight send (a fire-and-forget dispatch may own it) to finish
  while (Date.now() < deadline) {
    if (
      (await h.prisma.postingJob.count({
        where: { campaignId, status: 'SENDING' },
      })) === 0
    )
      break;
    await sleep(25);
  }
  // 2. a job is marked done a moment before its campaign is reconciled; PUBLISHING with
  //    nothing left to send is that in-between state, so give the reconcile a short window
  const reconcileDeadline = Math.min(deadline, Date.now() + 500);
  while (Date.now() < reconcileDeadline) {
    const [campaign, open] = await Promise.all([
      h.prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { status: true },
      }),
      h.prisma.postingJob.count({
        where: { campaignId, status: { in: ['PENDING', 'SENDING'] } },
      }),
    ]);
    if (!(campaign?.status === 'PUBLISHING' && open === 0)) return;
    await sleep(25);
  }
}

/**
 * The dispatcher is global by design (it serves every tenant), so each test starts
 * from an empty queue instead of inheriting work left over by earlier tests.
 */
export async function clearQueue(h: Harness) {
  await h.prisma.postingJob.updateMany({
    where: { status: { in: ['PENDING', 'SENDING', 'BLOCKED'] } },
    data: { status: 'CANCELLED' },
  });
}

/** A Telegram user account signed in through the (fake) worker, with the permissions an owner grants. */
export async function connectAccount(
  h: Harness,
  t: Tenant,
  opts: {
    username?: string;
    password?: string;
    grants?: Partial<
      Record<'canResearch' | 'canJoin' | 'canPublish' | 'canManage', boolean>
    >;
    label?: string;
  } = {}
) {
  const phone = `+49151${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
  h.userGateway.person(phone, {
    username: opts.username,
    password: opts.password,
  });
  const start = await h.users.startLogin(t.owner, {
    label: opts.label,
    apiId: 123456,
    apiHash: 'a1'.repeat(16),
    phone,
  });
  let res: any = await h.users.submitCode(
    t.owner,
    start.loginId,
    h.userGateway.code
  );
  if (res.status === 'password_required') {
    res = await h.users.submitPassword(t.owner, start.loginId, opts.password!);
  }
  let account = res.account;
  if (opts.grants && Object.keys(opts.grants).length) {
    account = await h.users.update(t.owner, account.id, opts.grants);
  }
  return account as Awaited<ReturnType<Harness['users']['list']>>[number];
}
