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
import { AgencyService, CampaignInput } from './agency.service';
import { AgencyPortalService } from './agency.portal.service';
import { AgencyCrmRepository } from './agency.crm.repository';
import { AgencyCrmService } from './agency.crm.service';
import { AgencyPlatformsService } from './agency.platforms.service';
import { AgencyAiRepository } from './agency.ai.repository';
import { AgencyAiGatewayService } from './agency.ai.gateway.service';
import { AgencyAiService } from './agency.ai.service';
import { AgencyAiToolsService } from './agency.ai.tools.service';
import { AgencyAiDiscoveryService } from './agency.ai.discovery.service';
import { AgencyAiAgentService } from './agency.ai.agent.service';
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
  agency: AgencyService;
  portal: AgencyPortalService;
  crm: AgencyCrmService;
  platforms: AgencyPlatformsService;
  aiGateway: AgencyAiGatewayService;
  ai: AgencyAiService;
  aiTools: AgencyAiToolsService;
  aiDiscovery: AgencyAiDiscoveryService;
  aiAgent: AgencyAiAgentService;
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
  const publishing = new AgencyPublishingService(
    agencyRepo,
    jobsRepo,
    gateway,
    access,
    notifications as any,
    bots
  );
  const telegram = new AgencyTelegramService(
    agencyRepo,
    jobsRepo,
    publishing,
    access,
    bots
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
    agency,
    portal,
    platforms,
    crm,
    aiGateway,
    ai,
    aiTools,
    aiDiscovery,
    aiAgent,
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
