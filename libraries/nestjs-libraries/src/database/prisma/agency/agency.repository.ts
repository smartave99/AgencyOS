import { Injectable } from '@nestjs/common';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  CampaignStatus,
  DestinationAuthStatus,
  PostingJobStatus,
  Prisma,
  TelegramBotStatus,
  TelegramBotStrategy,
} from '@prisma/client';

export interface CreateClientParams {
  name: string;
  email?: string;
  phone?: string;
  companyName?: string;
  industry?: string;
  website?: string;
  notes?: string;
  assignedSalesUserId?: string;
}

export interface UpdateClientParams {
  name?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  industry?: string;
  website?: string;
  status?: string;
  notes?: string;
  assignedSalesUserId?: string;
}

export interface VariantParams {
  label: string;
  contentTitle?: string | null;
  contentBody: string;
  contentMedia?: string | null;
  ctaLink?: string | null;
  ctaText?: string | null;
}

export interface AdTemplateParams {
  name: string;
  contentTitle?: string | null;
  contentBody: string;
  contentMedia?: string | null;
  ctaLink?: string | null;
  ctaText?: string | null;
}

export interface CreateCampaignParams {
  customerId: string;
  name: string;
  description?: string;
  objective?: string;
  budget?: number;
  startDate?: Date;
  endDate?: Date;
  timezone?: string;
  postingFrequency?: string;
  postingWindows?: string;
  contentTitle?: string;
  contentBody: string;
  contentMedia?: string;
  ctaLink?: string;
  ctaText?: string;
  telegramChannelLink?: string;
  internalNotes?: string;
  requiresClientApproval?: boolean;
  scheduleKind?: string;
  intervalMinutes?: number | null;
  occurrences?: number | null;
  variants?: VariantParams[];
  createdById: string;
  destinations?: Array<{
    destinationType: 'TELEGRAM' | 'SOCIAL';
    telegramDestinationId?: string;
    integrationId?: string;
    customSettings?: string;
    scheduledAt?: Date;
  }>;
}

export interface UpdateCampaignParams {
  name?: string;
  description?: string;
  objective?: string;
  budget?: number;
  startDate?: Date;
  endDate?: Date;
  timezone?: string;
  postingFrequency?: string;
  postingWindows?: string;
  contentTitle?: string;
  contentBody?: string;
  contentMedia?: string;
  ctaLink?: string;
  ctaText?: string;
  telegramChannelLink?: string;
  internalNotes?: string;
  requiresClientApproval?: boolean;
  scheduleKind?: string;
  intervalMinutes?: number | null;
  occurrences?: number | null;
  variants?: VariantParams[];
}

export interface CreateTelegramDestinationParams {
  chatId: string;
  title: string;
  type?: string;
  botId?: string | null;
  botUsername?: string;
  canPostMessages?: boolean;
  canDeleteMessages?: boolean;
  canInviteUsers?: boolean;
  permittedCategories?: string;
  postingFrequencyRules?: string;
  allowedPostingWindows?: string;
  timezone?: string;
  ownerName?: string;
  ownerContact?: string;
  verificationCodeHash: string;
  verificationExpiresAt: Date;
}

export interface DestinationAuthorizationUpdate {
  authorizationStatus: DestinationAuthStatus;
  verificationCodeHash?: string | null;
  verificationExpiresAt?: Date | null;
  consentGrantedAt?: Date | null;
  consentExpiresAt?: Date | null;
  consentedByTelegramId?: string | null;
  consentedByName?: string | null;
  consentRevokedAt?: Date | null;
  revokedReason?: string | null;
  lastError?: string | null;
  canPostMessages?: boolean;
  canDeleteMessages?: boolean;
  canInviteUsers?: boolean;
  title?: string;
  type?: string;
}

@Injectable()
export class AgencyRepository {
  constructor(private prisma: PrismaService) {}

  // ==========================================
  // CLIENTS (Extended Customer Domain)
  // ==========================================
  async getClients(orgId: string, search?: string) {
    return this.prisma.customer.findMany({
      where: {
        orgId,
        deletedAt: null,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { companyName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        assignedSalesUser: {
          select: { id: true, name: true, email: true },
        },
        _count: {
          select: { campaigns: true, integrations: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getClientById(orgId: string, id: string) {
    return this.prisma.customer.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        assignedSalesUser: {
          select: { id: true, name: true, email: true },
        },
        campaigns: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        integrations: {
          where: { deletedAt: null },
          select: {
            id: true,
            name: true,
            type: true,
            picture: true,
            disabled: true,
          },
        },
      },
    });
  }

  async createClient(orgId: string, params: CreateClientParams) {
    return this.prisma.customer.create({
      data: {
        orgId,
        name: params.name,
        email: params.email,
        phone: params.phone,
        companyName: params.companyName,
        industry: params.industry,
        website: params.website,
        notes: params.notes,
        assignedSalesUserId: params.assignedSalesUserId,
      },
      include: {
        assignedSalesUser: {
          select: { id: true, name: true, email: true },
        },
      },
    });
  }

  async updateClient(orgId: string, id: string, params: UpdateClientParams) {
    await this.prisma.customer.updateMany({
      where: { id, orgId, deletedAt: null },
      data: {
        ...(params.name ? { name: params.name } : {}),
        ...(params.email !== undefined ? { email: params.email } : {}),
        ...(params.phone !== undefined ? { phone: params.phone } : {}),
        ...(params.companyName !== undefined
          ? { companyName: params.companyName }
          : {}),
        ...(params.industry !== undefined ? { industry: params.industry } : {}),
        ...(params.website !== undefined ? { website: params.website } : {}),
        ...(params.status !== undefined ? { status: params.status } : {}),
        ...(params.notes !== undefined ? { notes: params.notes } : {}),
        ...(params.assignedSalesUserId !== undefined
          ? { assignedSalesUserId: params.assignedSalesUserId }
          : {}),
      },
    });
    return this.getClientById(orgId, id);
  }

  async deleteClient(orgId: string, id: string) {
    return this.prisma.customer.updateMany({
      where: { id, orgId },
      data: { deletedAt: new Date() },
    });
  }

  // ---- ad templates (content only) ------------------------------------------------------

  async getTemplates(orgId: string) {
    return this.prisma.adTemplate.findMany({
      where: { orgId },
      orderBy: { name: 'asc' },
    });
  }

  async getTemplateById(orgId: string, id: string) {
    return this.prisma.adTemplate.findFirst({ where: { id, orgId } });
  }

  async findTemplateByName(orgId: string, name: string) {
    return this.prisma.adTemplate.findFirst({
      where: { orgId, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
  }

  async createTemplate(
    orgId: string,
    createdById: string,
    params: AdTemplateParams
  ) {
    return this.prisma.adTemplate.create({
      data: { orgId, createdById, ...params },
    });
  }

  async updateTemplate(
    orgId: string,
    id: string,
    params: Partial<AdTemplateParams>
  ) {
    await this.prisma.adTemplate.updateMany({
      where: { id, orgId },
      data: params,
    });
    return this.getTemplateById(orgId, id);
  }

  async deleteTemplate(orgId: string, id: string) {
    return this.prisma.adTemplate.deleteMany({ where: { id, orgId } });
  }

  async getOrganizationName(orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    });
    return org?.name ?? 'your agency';
  }

  /** Users that may be assigned work: active members of this organization only. */
  async isActiveOrgMember(orgId: string, userId: string) {
    const membership = await this.prisma.userOrganization.findFirst({
      where: { organizationId: orgId, userId, disabled: false },
      select: { id: true },
    });
    return !!membership;
  }

  // ==========================================
  // CAMPAIGNS
  // ==========================================
  async getCampaigns(
    orgId: string,
    filters?: { status?: CampaignStatus; customerId?: string; search?: string }
  ) {
    return this.prisma.campaign.findMany({
      where: {
        orgId,
        deletedAt: null,
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.customerId ? { customerId: filters.customerId } : {}),
        ...(filters?.search
          ? {
              OR: [
                { name: { contains: filters.search, mode: 'insensitive' } },
                {
                  contentTitle: {
                    contains: filters.search,
                    mode: 'insensitive',
                  },
                },
                {
                  contentBody: {
                    contains: filters.search,
                    mode: 'insensitive',
                  },
                },
              ],
            }
          : {}),
      },
      include: {
        customer: {
          select: { id: true, name: true, companyName: true },
        },
        createdBy: {
          select: { id: true, name: true, email: true },
        },
        destinations: {
          include: {
            telegramDestination: {
              select: {
                id: true,
                title: true,
                chatId: true,
                type: true,
                isAuthorized: true,
              },
            },
            integration: {
              select: { id: true, name: true, type: true, picture: true },
            },
          },
        },
        _count: {
          select: { publishingEvents: true, leads: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getCampaignById(orgId: string, id: string) {
    return this.prisma.campaign.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        customer: true,
        createdBy: {
          select: { id: true, name: true, email: true },
        },
        destinations: {
          include: {
            telegramDestination: true,
            integration: true,
          },
        },
        approvals: {
          include: {
            submittedByUser: { select: { id: true, name: true, email: true } },
            reviewedByUser: { select: { id: true, name: true, email: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        publishingEvents: {
          include: {
            telegramDestination: {
              select: { id: true, title: true, type: true },
            },
            integration: { select: { id: true, name: true, type: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        // Never the lead rows: they hold people's names and usernames, which only those who work the
        // sales side may read (see AgencyLeadsService); a campaign's page needs only how many there are.
        _count: { select: { leads: true } },
        variants: { orderBy: { label: 'asc' } },
        trackingLinks: true,
      },
    });
  }

  async createCampaign(orgId: string, params: CreateCampaignParams) {
    return this.prisma.campaign.create({
      data: {
        orgId,
        customerId: params.customerId,
        name: params.name,
        description: params.description,
        objective: params.objective || 'BRAND_AWARENESS',
        status: CampaignStatus.DRAFT,
        budget:
          params.budget !== undefined
            ? new Prisma.Decimal(params.budget)
            : null,
        startDate: params.startDate,
        endDate: params.endDate,
        timezone: params.timezone || 'UTC',
        postingFrequency: params.postingFrequency,
        postingWindows: params.postingWindows,
        contentTitle: params.contentTitle,
        contentBody: params.contentBody,
        contentMedia: params.contentMedia,
        ctaLink: params.ctaLink,
        ctaText: params.ctaText,
        telegramChannelLink: params.telegramChannelLink,
        internalNotes: params.internalNotes,
        requiresClientApproval: params.requiresClientApproval ?? false,
        scheduleKind: params.scheduleKind ?? 'ONCE',
        intervalMinutes: params.intervalMinutes ?? null,
        occurrences: params.occurrences ?? null,
        createdById: params.createdById,
        ...(params.variants && params.variants.length > 0
          ? { variants: { create: params.variants } }
          : {}),
        ...(params.destinations && params.destinations.length > 0
          ? {
              destinations: {
                create: params.destinations.map((d) => ({
                  destinationType: d.destinationType,
                  telegramDestinationId: d.telegramDestinationId,
                  integrationId: d.integrationId,
                  customSettings: d.customSettings,
                  scheduledAt: d.scheduledAt,
                })),
              },
            }
          : {}),
      },
      include: {
        customer: true,
        variants: { orderBy: { label: 'asc' } },
        destinations: {
          include: {
            telegramDestination: true,
            integration: true,
          },
        },
      },
    });
  }

  async updateCampaign(
    orgId: string,
    id: string,
    params: UpdateCampaignParams
  ) {
    await this.prisma.campaign.updateMany({
      where: { id, orgId, deletedAt: null },
      data: {
        ...(params.name ? { name: params.name } : {}),
        ...(params.description !== undefined
          ? { description: params.description }
          : {}),
        ...(params.objective ? { objective: params.objective } : {}),
        ...(params.budget !== undefined
          ? {
              budget:
                params.budget !== null
                  ? new Prisma.Decimal(params.budget)
                  : null,
            }
          : {}),
        ...(params.startDate !== undefined
          ? { startDate: params.startDate }
          : {}),
        ...(params.endDate !== undefined ? { endDate: params.endDate } : {}),
        ...(params.timezone ? { timezone: params.timezone } : {}),
        ...(params.postingFrequency !== undefined
          ? { postingFrequency: params.postingFrequency }
          : {}),
        ...(params.postingWindows !== undefined
          ? { postingWindows: params.postingWindows }
          : {}),
        ...(params.contentTitle !== undefined
          ? { contentTitle: params.contentTitle }
          : {}),
        ...(params.contentBody ? { contentBody: params.contentBody } : {}),
        ...(params.contentMedia !== undefined
          ? { contentMedia: params.contentMedia }
          : {}),
        ...(params.ctaLink !== undefined ? { ctaLink: params.ctaLink } : {}),
        ...(params.ctaText !== undefined ? { ctaText: params.ctaText } : {}),
        ...(params.telegramChannelLink !== undefined
          ? { telegramChannelLink: params.telegramChannelLink }
          : {}),
        ...(params.internalNotes !== undefined
          ? { internalNotes: params.internalNotes }
          : {}),
        ...(params.requiresClientApproval !== undefined
          ? { requiresClientApproval: params.requiresClientApproval }
          : {}),
        ...(params.scheduleKind !== undefined
          ? { scheduleKind: params.scheduleKind }
          : {}),
        ...(params.intervalMinutes !== undefined
          ? { intervalMinutes: params.intervalMinutes }
          : {}),
        ...(params.occurrences !== undefined
          ? { occurrences: params.occurrences }
          : {}),
      },
    });
    if (params.variants !== undefined) {
      // The set is replaced as a whole, only while the campaign can still be edited.
      await this.prisma.$transaction([
        this.prisma.campaignVariant.deleteMany({ where: { campaignId: id } }),
        this.prisma.campaignVariant.createMany({
          data: params.variants.map((v) => ({ ...v, campaignId: id })),
        }),
      ]);
    }
    return this.prisma.campaign.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        customer: true,
        destinations: true,
        variants: { orderBy: { label: 'asc' } },
      },
    });
  }

  async updateCampaignDestinations(
    campaignId: string,
    destinations: Array<{
      destinationType: 'TELEGRAM' | 'SOCIAL';
      telegramDestinationId?: string;
      integrationId?: string;
      customSettings?: string;
      scheduledAt?: Date;
    }>
  ) {
    await this.prisma.$transaction([
      this.prisma.campaignDestination.deleteMany({ where: { campaignId } }),
      this.prisma.campaignDestination.createMany({
        data: destinations.map((d) => ({
          campaignId,
          destinationType: d.destinationType,
          telegramDestinationId: d.telegramDestinationId,
          integrationId: d.integrationId,
          customSettings: d.customSettings,
          scheduledAt: d.scheduledAt,
        })),
      }),
    ]);

    return this.prisma.campaignDestination.findMany({
      where: { campaignId },
      include: { telegramDestination: true, integration: true },
    });
  }

  async deleteCampaign(orgId: string, id: string) {
    return this.prisma.campaign.updateMany({
      where: { id, orgId },
      data: { deletedAt: new Date() },
    });
  }

  // ==========================================
  // APPROVALS
  // ==========================================
  async getApprovals(orgId: string, status?: string) {
    return this.prisma.approvalRequest.findMany({
      where: {
        campaign: { orgId, deletedAt: null },
        ...(status ? { status } : {}),
      },
      include: {
        campaign: {
          include: {
            customer: { select: { id: true, name: true, companyName: true } },
            destinations: {
              include: {
                telegramDestination: {
                  select: { id: true, title: true, type: true },
                },
                integration: { select: { id: true, name: true, type: true } },
              },
            },
          },
        },
        submittedByUser: { select: { id: true, name: true, email: true } },
        reviewedByUser: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createApprovalRequest(
    campaignId: string,
    submittedByUserId: string,
    notes?: string
  ) {
    return this.prisma.approvalRequest.create({
      data: {
        campaignId,
        submittedByUserId,
        status: 'PENDING',
        submissionNotes: notes,
      },
      include: {
        submittedByUser: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async reviewApprovalRequest(
    approvalId: string,
    reviewedByUserId: string,
    decision: 'APPROVED' | 'CHANGES_REQUESTED',
    notes?: string,
    selfApproved = false
  ) {
    return this.prisma.approvalRequest.update({
      where: { id: approvalId },
      data: {
        status: decision,
        reviewedByUserId,
        reviewNotes: notes,
        selfApproved,
        reviewedAt: new Date(),
      },
      include: {
        campaign: true,
        reviewedByUser: { select: { id: true, name: true, email: true } },
      },
    });
  }

  // ==========================================
  // TELEGRAM DESTINATIONS
  // ==========================================
  async getTelegramDestinations(orgId: string) {
    return this.prisma.telegramDestination.findMany({
      where: { orgId, deletedAt: null },
      include: {
        _count: {
          select: { campaignDestinations: true, publishingEvents: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getTelegramDestinationById(orgId: string, id: string) {
    return this.prisma.telegramDestination.findFirst({
      where: { id, orgId, deletedAt: null },
    });
  }

  /** Destinations in this org matching the given IDs, used to validate references. */
  async getTelegramDestinationsByIds(orgId: string, ids: string[]) {
    return this.prisma.telegramDestination.findMany({
      where: { orgId, id: { in: ids }, deletedAt: null },
    });
  }

  async getTelegramDestinationByChat(orgId: string, chatId: string) {
    return this.prisma.telegramDestination.findFirst({
      where: { orgId, chatId, deletedAt: null },
    });
  }

  /** Every tenant's registration of a chat. Used only by inbound Telegram updates. */
  async getTelegramDestinationsByChatAcrossOrgs(chatId: string) {
    return this.prisma.telegramDestination.findMany({
      where: { chatId, deletedAt: null },
    });
  }

  /** `botId` is the bot that received the command (null: the server's bot); no other bot can authorize a chat. */
  async getDestinationsPendingVerification(
    chatId: string,
    now: Date,
    botId: string | null
  ) {
    return this.prisma.telegramDestination.findMany({
      where: {
        chatId,
        botId,
        deletedAt: null,
        authorizationStatus: DestinationAuthStatus.PENDING_VERIFICATION,
        verificationExpiresAt: { gt: now },
      },
    });
  }

  /** The chats one bot serves, for when that bot is told it lost its place in a chat. */
  async getTelegramDestinationsOfBotByChat(
    chatId: string,
    botId: string | null
  ) {
    return this.prisma.telegramDestination.findMany({
      where: { chatId, botId, deletedAt: null },
    });
  }

  async getDestinationsWithExpiredConsent(now: Date) {
    return this.prisma.telegramDestination.findMany({
      where: {
        deletedAt: null,
        authorizationStatus: DestinationAuthStatus.ACTIVE,
        consentExpiresAt: { lte: now },
      },
      select: { id: true, orgId: true, title: true },
    });
  }

  async createTelegramDestination(
    orgId: string,
    params: CreateTelegramDestinationParams
  ) {
    return this.prisma.telegramDestination.create({
      data: {
        orgId,
        chatId: params.chatId,
        title: params.title,
        type: params.type || 'channel',
        botId: params.botId ?? null,
        botUsername: params.botUsername,
        canPostMessages: params.canPostMessages ?? false,
        canDeleteMessages: params.canDeleteMessages ?? false,
        canInviteUsers: params.canInviteUsers ?? false,
        permittedCategories: params.permittedCategories,
        postingFrequencyRules: params.postingFrequencyRules,
        allowedPostingWindows: params.allowedPostingWindows,
        timezone: params.timezone || 'UTC',
        ownerName: params.ownerName,
        ownerContact: params.ownerContact,
        // A new destination can never post: consent is only granted once a chat
        // administrator proves control (see AgencyTelegramService).
        isAuthorized: false,
        authorizationStatus: DestinationAuthStatus.PENDING_VERIFICATION,
        verificationCodeHash: params.verificationCodeHash,
        verificationExpiresAt: params.verificationExpiresAt,
      },
    });
  }

  async updateTelegramDestinationSettings(
    orgId: string,
    id: string,
    params: {
      permittedCategories?: string | null;
      postingFrequencyRules?: string | null;
      allowedPostingWindows?: string | null;
      timezone?: string;
      ownerName?: string | null;
      ownerContact?: string | null;
    }
  ) {
    await this.prisma.telegramDestination.updateMany({
      where: { id, orgId, deletedAt: null },
      data: params,
    });
    return this.getTelegramDestinationById(orgId, id);
  }

  /**
   * The only writer of authorization state. Keeps the deprecated isAuthorized column
   * in lock-step so the two can never disagree.
   */
  async setDestinationAuthorization(
    orgId: string,
    id: string,
    update: DestinationAuthorizationUpdate
  ) {
    await this.prisma.telegramDestination.updateMany({
      where: { id, orgId, deletedAt: null },
      data: {
        ...update,
        isAuthorized:
          update.authorizationStatus === DestinationAuthStatus.ACTIVE,
        lastVerifiedAt: new Date(),
      },
    });
    return this.getTelegramDestinationById(orgId, id);
  }

  /** Replaces an @username reference with the canonical numeric chat id once Telegram tells us. */
  async setDestinationChatId(orgId: string, id: string, chatId: string) {
    await this.prisma.telegramDestination.updateMany({
      where: { id, orgId },
      data: { chatId },
    });
  }

  /** `botKey` is the bot that sent it ("server" for the server's bot), so a change of bot can be told. */
  async recordDestinationSuccess(
    orgId: string,
    id: string,
    at: Date,
    botKey?: string
  ) {
    await this.prisma.telegramDestination.updateMany({
      where: { id, orgId },
      data: {
        lastSuccessfulPostAt: at,
        lastError: null,
        ...(botKey ? { lastBotId: botKey } : {}),
      },
    });
  }

  async updateDestinationBots(
    orgId: string,
    id: string,
    data: {
      botId?: string | null;
      botUsername?: string | null;
      backupBotIds?: string[];
      botStrategy?: TelegramBotStrategy;
    }
  ) {
    await this.prisma.telegramDestination.updateMany({
      where: { id, orgId, deletedAt: null },
      data,
    });
    return this.getTelegramDestinationById(orgId, id);
  }

  /** A bot that is gone must not stay on any chat's list of backups. */
  async removeBotFromBackups(orgId: string, botId: string) {
    const rows = await this.prisma.telegramDestination.findMany({
      where: { orgId, deletedAt: null, backupBotIds: { has: botId } },
      select: { id: true, backupBotIds: true },
    });
    for (const row of rows) {
      await this.prisma.telegramDestination.update({
        where: { id: row.id },
        data: { backupBotIds: row.backupBotIds.filter((x) => x !== botId) },
      });
    }
    return rows.length;
  }

  async recordDestinationError(orgId: string, id: string, message: string) {
    await this.prisma.telegramDestination.updateMany({
      where: { id, orgId },
      data: { lastError: message.slice(0, 500) },
    });
  }

  async deleteTelegramDestination(orgId: string, id: string) {
    return this.prisma.telegramDestination.updateMany({
      where: { id, orgId },
      data: {
        deletedAt: new Date(),
        isAuthorized: false,
        authorizationStatus: DestinationAuthStatus.REVOKED,
        consentRevokedAt: new Date(),
        revokedReason: 'Destination removed',
      },
    });
  }

  // ==========================================
  // TELEGRAM BOTS
  // ==========================================
  // The sealed token is selected only by the *WithToken readers, which are for the services that
  // have to talk as the bot; every list that reaches a controller leaves it out.
  private static readonly BOT_VIEW = {
    id: true,
    orgId: true,
    label: true,
    telegramBotId: true,
    username: true,
    status: true,
    lastError: true,
    lastCheckedAt: true,
    createdAt: true,
  } satisfies Prisma.TelegramBotSelect;

  async getTelegramBots(orgId: string) {
    const rows = await this.prisma.telegramBot.findMany({
      where: { orgId, deletedAt: null },
      select: {
        ...AgencyRepository.BOT_VIEW,
        _count: { select: { destinations: { where: { deletedAt: null } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(({ _count, ...bot }) => ({
      ...bot,
      destinationCount: _count.destinations,
    }));
  }

  async getTelegramBotWithToken(orgId: string, id: string) {
    return this.prisma.telegramBot.findFirst({
      where: { id, orgId, deletedAt: null },
    });
  }

  /** Used by the sender and the pollers, which know a destination's bot id but not who owns it. */
  async getTelegramBotByIdWithToken(id: string) {
    return this.prisma.telegramBot.findUnique({ where: { id } });
  }

  /** Every enabled bot of every agency: the update pollers' work list. */
  async getPollableTelegramBots() {
    return this.prisma.telegramBot.findMany({
      where: { deletedAt: null, status: TelegramBotStatus.ACTIVE },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findTelegramBotByTokenHash(tokenHash: string) {
    return this.prisma.telegramBot.findFirst({
      where: { tokenHash, deletedAt: null },
      select: { id: true, orgId: true, label: true },
    });
  }

  async createTelegramBot(
    orgId: string,
    params: {
      label: string;
      tokenSealed: string;
      tokenHash: string;
      telegramBotId: string;
      username: string;
    }
  ) {
    return this.prisma.telegramBot.create({
      data: { orgId, ...params, lastCheckedAt: new Date() },
      select: AgencyRepository.BOT_VIEW,
    });
  }

  async updateTelegramBot(
    orgId: string,
    id: string,
    data: {
      label?: string;
      status?: TelegramBotStatus;
      lastError?: string | null;
      lastCheckedAt?: Date;
      username?: string;
    }
  ) {
    await this.prisma.telegramBot.updateMany({
      where: { id, orgId, deletedAt: null },
      data,
    });
  }

  /** The token is wiped, not just hidden: a removed bot cannot be used again, only connected anew. */
  async deleteTelegramBot(orgId: string, id: string) {
    await this.prisma.telegramBot.updateMany({
      where: { id, orgId, deletedAt: null },
      data: {
        deletedAt: new Date(),
        status: TelegramBotStatus.DISABLED,
        tokenSealed: '',
        tokenHash: '',
      },
    });
  }

  async getDestinationsOfBot(orgId: string, botId: string) {
    return this.prisma.telegramDestination.findMany({
      where: { orgId, botId, deletedAt: null },
      select: { id: true, title: true, authorizationStatus: true },
    });
  }

  /** Integrations in this org matching the given IDs, used to validate references. */
  async getIntegrationsByIds(orgId: string, ids: string[]) {
    return this.prisma.integration.findMany({
      where: { organizationId: orgId, id: { in: ids }, deletedAt: null },
      select: {
        id: true,
        name: true,
        providerIdentifier: true,
        disabled: true,
        refreshNeeded: true,
      },
    });
  }

  // ==========================================
  // PUBLISHING EVENTS (Receipts & Logs)
  // ==========================================
  async recordPublishingEvent(params: {
    campaignId: string;
    telegramDestinationId?: string;
    integrationId?: string;
    externalMessageId?: string;
    releaseUrl?: string;
    status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
    errorMessage?: string;
    idempotencyKey?: string;
    postingJobId?: string;
    attempt?: number;
    botUsername?: string;
  }) {
    return this.prisma.publishingEvent.create({
      data: {
        campaignId: params.campaignId,
        telegramDestinationId: params.telegramDestinationId,
        integrationId: params.integrationId,
        externalMessageId: params.externalMessageId,
        releaseUrl: params.releaseUrl,
        status: params.status,
        errorMessage: params.errorMessage,
        idempotencyKey: params.idempotencyKey,
        postingJobId: params.postingJobId,
        attempt: params.attempt,
        botUsername: params.botUsername,
        executedAt: new Date(),
      },
    });
  }

  async getPublishingEvents(orgId: string, campaignId?: string) {
    return this.prisma.publishingEvent.findMany({
      where: {
        campaign: { orgId, deletedAt: null },
        ...(campaignId ? { campaignId } : {}),
      },
      include: {
        campaign: { select: { id: true, name: true } },
        telegramDestination: { select: { id: true, title: true, type: true } },
        integration: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // ==========================================
  // DASHBOARD AGGREGATED METRICS
  // ==========================================
  async getDashboardMetrics(orgId: string) {
    const [
      activeClientsCount,
      activeCampaignsCount,
      totalCampaignsCount,
      pendingApprovalsCount,
      telegramDestinationsCount,
      destinationsNeedingAttention,
      campaignsNeedingAttention,
      connectedSocialCount,
      jobStats,
      recentCampaigns,
      recentEvents,
      liveJobs,
      botRows,
      chatRows,
      rateLimitedRows,
    ] = await Promise.all([
      this.prisma.customer.count({
        where: { orgId, deletedAt: null, status: 'ACTIVE' },
      }),
      this.prisma.campaign.count({
        where: {
          orgId,
          deletedAt: null,
          status: {
            in: [
              CampaignStatus.APPROVED,
              CampaignStatus.SCHEDULED,
              CampaignStatus.PUBLISHING,
            ],
          },
        },
      }),
      this.prisma.campaign.count({
        where: { orgId, deletedAt: null },
      }),
      this.prisma.approvalRequest.count({
        where: { campaign: { orgId, deletedAt: null }, status: 'PENDING' },
      }),
      this.prisma.telegramDestination.count({
        where: {
          orgId,
          deletedAt: null,
          authorizationStatus: DestinationAuthStatus.ACTIVE,
        },
      }),
      this.prisma.telegramDestination.count({
        where: {
          orgId,
          deletedAt: null,
          authorizationStatus: {
            in: [
              DestinationAuthStatus.DISCONNECTED,
              DestinationAuthStatus.REVOKED,
              DestinationAuthStatus.EXPIRED,
              DestinationAuthStatus.SUSPENDED,
            ],
          },
        },
      }),
      this.prisma.campaign.count({
        where: { orgId, deletedAt: null, requiresAttention: true },
      }),
      this.prisma.integration.count({
        where: { organizationId: orgId, deletedAt: null, disabled: false },
      }),
      this.prisma.postingJob.groupBy({
        by: ['status'],
        where: { orgId, campaign: { deletedAt: null } },
        _count: { status: true },
      }),
      this.prisma.campaign.findMany({
        where: { orgId, deletedAt: null },
        include: {
          customer: { select: { name: true, companyName: true } },
          _count: { select: { destinations: true, publishingEvents: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.prisma.publishingEvent.findMany({
        where: { campaign: { orgId, deletedAt: null } },
        include: {
          campaign: { select: { name: true } },
          telegramDestination: { select: { title: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
      // The jobs that are doing something or need someone: most urgent first below.
      this.prisma.postingJob.findMany({
        where: {
          orgId,
          campaign: { deletedAt: null },
          status: {
            in: [
              PostingJobStatus.SENDING,
              PostingJobStatus.UNCERTAIN,
              PostingJobStatus.DEAD,
              PostingJobStatus.BLOCKED,
              PostingJobStatus.PENDING,
            ],
          },
        },
        select: {
          id: true,
          status: true,
          attempts: true,
          maxAttempts: true,
          nextAttemptAt: true,
          lastError: true,
          lastErrorCode: true,
          campaign: { select: { id: true, name: true } },
          telegramDestination: { select: { id: true, title: true } },
        },
        orderBy: { nextAttemptAt: 'asc' },
        take: 60,
      }),
      this.prisma.telegramBot.findMany({
        where: { orgId, deletedAt: null },
        select: {
          id: true,
          label: true,
          username: true,
          status: true,
          lastError: true,
          lastCheckedAt: true,
          _count: {
            select: { destinations: { where: { deletedAt: null } } },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.telegramDestination.groupBy({
        by: ['authorizationStatus'],
        where: { orgId, deletedAt: null },
        _count: { authorizationStatus: true },
      }),
      // Telegram asked a bot to slow down: those posts wait for the time it named.
      this.prisma.postingJob.findMany({
        where: {
          orgId,
          status: PostingJobStatus.PENDING,
          lastErrorCode: 'RATE_LIMITED',
          nextAttemptAt: { gt: new Date() },
        },
        select: { telegramDestinationId: true },
        distinct: ['telegramDestinationId'],
      }),
    ]);

    const urgency: Record<string, number> = {
      SENDING: 0,
      UNCERTAIN: 1,
      DEAD: 2,
      BLOCKED: 3,
      PENDING: 4,
    };
    const queue = liveJobs
      .sort(
        (a, b) =>
          urgency[a.status] - urgency[b.status] ||
          a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime()
      )
      .slice(0, 8);
    const chats = Object.fromEntries(
      chatRows.map((row) => [
        row.authorizationStatus,
        row._count.authorizationStatus,
      ])
    );

    const jobCount = (...statuses: string[]) =>
      jobStats
        .filter((j) => statuses.includes(j.status))
        .reduce((sum, j) => sum + j._count.status, 0);
    const successfulPosts = jobCount('SUCCEEDED');
    const failedPosts = jobCount('DEAD', 'UNCERTAIN');
    const blockedPosts = jobCount('BLOCKED');
    const queuedPosts = jobCount('PENDING', 'SENDING');
    const settled = successfulPosts + failedPosts;
    // null (not 100) when nothing has been attempted: no data is not a perfect score.
    const deliveryRate =
      settled > 0 ? Math.round((successfulPosts / settled) * 100) : null;

    return {
      activeClientsCount,
      activeCampaignsCount,
      totalCampaignsCount,
      pendingApprovalsCount,
      telegramDestinationsCount,
      destinationsNeedingAttention,
      campaignsNeedingAttention,
      connectedSocialCount,
      successfulPosts,
      failedPosts,
      blockedPosts,
      queuedPosts,
      runningPosts: jobCount('SENDING'),
      deliveryRate,
      recentCampaigns,
      recentEvents,
      queue,
      health: {
        bots: botRows.map(({ _count, ...bot }) => ({
          ...bot,
          chats: _count.destinations,
        })),
        chats,
        rateLimitedChats: rateLimitedRows.length,
      },
    };
  }

  // ==========================================
  // TRACKING LINKS & CLICK ATTRIBUTION
  // ==========================================
  async createTrackingLink(params: {
    campaignId: string;
    shortCode: string;
    destinationUrl: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
  }) {
    return this.prisma.trackingLink.create({
      data: params,
    });
  }

  async getTrackingLinkByCode(shortCode: string) {
    return this.prisma.trackingLink.findUnique({
      where: { shortCode },
      include: {
        campaign: { select: { id: true, orgId: true, name: true } },
      },
    });
  }

  async recordLinkClick(params: {
    trackingLinkId: string;
    ipHash?: string;
    userAgent?: string;
    referer?: string;
  }) {
    await this.prisma.$transaction([
      this.prisma.linkClickEvent.create({
        data: {
          trackingLinkId: params.trackingLinkId,
          ipHash: params.ipHash,
          userAgent: params.userAgent,
          referer: params.referer,
        },
      }),
      this.prisma.trackingLink.update({
        where: { id: params.trackingLinkId },
        data: { totalClicks: { increment: 1 } },
      }),
    ]);
  }

  async getCampaignTrackingLinks(campaignId: string) {
    return this.prisma.trackingLink.findMany({
      where: { campaignId },
      include: {
        _count: { select: { clicks: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ==========================================
  // AGENCY INVOICING & BILLING
  // ==========================================
  async createAgencyInvoice(
    orgId: string,
    params: {
      customerId: string;
      invoiceNumber: string;
      amount: number;
      currency?: string;
      dueDate?: Date;
      items?: string;
      notes?: string;
    }
  ) {
    return this.prisma.agencyInvoice.create({
      data: {
        orgId,
        customerId: params.customerId,
        invoiceNumber: params.invoiceNumber,
        amount: params.amount,
        currency: params.currency || 'USD',
        dueDate: params.dueDate,
        items: params.items,
        notes: params.notes,
        status: 'DRAFT',
      },
      include: {
        customer: {
          select: { id: true, name: true, companyName: true, email: true },
        },
      },
    });
  }

  async getAgencyInvoices(orgId: string, status?: string) {
    return this.prisma.agencyInvoice.findMany({
      where: {
        orgId,
        ...(status ? { status } : {}),
      },
      include: {
        customer: {
          select: { id: true, name: true, companyName: true, email: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateAgencyInvoiceStatus(
    orgId: string,
    id: string,
    status: string,
    paidAt?: Date
  ) {
    await this.prisma.agencyInvoice.updateMany({
      where: { id, orgId },
      data: {
        status,
        ...(paidAt ? { paidAt } : {}),
      },
    });
    return this.prisma.agencyInvoice.findFirst({
      where: { id, orgId },
      include: {
        customer: {
          select: { id: true, name: true, companyName: true, email: true },
        },
      },
    });
  }

  // ==========================================
  // MODULE E: DISCUSSION & KNOWLEDGE REPOSITORY
  // ==========================================
  async createKnowledgeDocument(
    orgId: string,
    data: {
      title: string;
      content: string;
      category?: string;
      source?: string;
      telegramDestId?: string;
      sentimentScore?: number;
      tags?: string;
      embedding?: string;
    }
  ) {
    return this.prisma.agencyKnowledgeDocument.create({
      data: {
        orgId,
        title: data.title,
        content: data.content,
        category: data.category || 'DISCUSSION',
        source: data.source,
        telegramDestId: data.telegramDestId,
        sentimentScore: data.sentimentScore ?? 0.0,
        tags: data.tags,
        embedding: data.embedding,
      },
    });
  }

  async getKnowledgeDocuments(orgId: string, category?: string, limit = 50) {
    return this.prisma.agencyKnowledgeDocument.findMany({
      where: {
        orgId,
        ...(category ? { category } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getKnowledgeDocumentById(orgId: string, id: string) {
    return this.prisma.agencyKnowledgeDocument.findFirst({
      where: { id, orgId },
    });
  }

  async deleteKnowledgeDocument(orgId: string, id: string) {
    return this.prisma.agencyKnowledgeDocument.deleteMany({
      where: { id, orgId },
    });
  }

  async updateKnowledgeEmbedding(orgId: string, id: string, embedding: string) {
    return this.prisma.agencyKnowledgeDocument.updateMany({
      where: { id, orgId },
      data: { embedding },
    });
  }

  async purgeKnowledge(orgId: string, category?: string, before?: Date) {
    return this.prisma.agencyKnowledgeDocument.deleteMany({
      where: {
        orgId,
        ...(category ? { category } : {}),
        ...(before ? { createdAt: { lt: before } } : {}),
      },
    });
  }

  async getAllKnowledgeDocumentsForSearch(orgId: string, category?: string) {
    return this.prisma.agencyKnowledgeDocument.findMany({
      where: {
        orgId,
        ...(category ? { category } : {}),
      },
      select: {
        id: true,
        title: true,
        content: true,
        category: true,
        source: true,
        sentimentScore: true,
        tags: true,
        embedding: true,
        createdAt: true,
      },
    });
  }

  // ==========================================
  // MODULE G & H: CONNECTED INTEGRATIONS MANAGEMENT
  // ==========================================
  // Selected explicitly so OAuth tokens are never loaded into agency code paths.
  private readonly integrationSafeSelect = {
    id: true,
    name: true,
    customName: true,
    picture: true,
    providerIdentifier: true,
    type: true,
    profile: true,
    disabled: true,
    refreshNeeded: true,
    tokenExpiration: true,
    customerId: true,
    createdAt: true,
  } as const;

  async getConnectedIntegrations(orgId: string) {
    return this.prisma.integration.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
      },
      select: {
        ...this.integrationSafeSelect,
        customer: {
          select: { id: true, name: true, companyName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getIntegrationById(orgId: string, id: string) {
    return this.prisma.integration.findFirst({
      where: {
        id,
        organizationId: orgId,
        deletedAt: null,
      },
      select: {
        ...this.integrationSafeSelect,
        customer: {
          select: { id: true, name: true, companyName: true },
        },
      },
    });
  }

  async updateIntegrationCustomer(
    orgId: string,
    id: string,
    customerId: string | null
  ) {
    await this.prisma.integration.updateMany({
      where: { id, organizationId: orgId },
      data: { customerId },
    });
    return this.getIntegrationById(orgId, id);
  }

  // ==========================================
  // WORKFLOW (atomic status + approval-record changes)
  // ==========================================
  async getApprovalById(orgId: string, id: string) {
    return this.prisma.approvalRequest.findFirst({
      where: { id, campaign: { orgId, deletedAt: null } },
      include: { campaign: true },
    });
  }

  /** DRAFT/CHANGES_REQUESTED → SUBMITTED and the approval request, as one unit. */
  async submitForReview(
    orgId: string,
    campaignId: string,
    userId: string,
    notes?: string
  ) {
    return this.prisma.$transaction(async (tx) => {
      const moved = await tx.campaign.updateMany({
        where: {
          id: campaignId,
          orgId,
          deletedAt: null,
          status: {
            in: [CampaignStatus.DRAFT, CampaignStatus.CHANGES_REQUESTED],
          },
        },
        data: {
          status: CampaignStatus.SUBMITTED,
          requiresAttention: false,
          attentionReason: null,
        },
      });
      if (moved.count !== 1) return null;
      await tx.approvalRequest.updateMany({
        where: { campaignId, status: 'PENDING' },
        data: { status: 'WITHDRAWN', reviewedAt: new Date() },
      });
      return tx.approvalRequest.create({
        data: {
          campaignId,
          submittedByUserId: userId,
          status: 'PENDING',
          submissionNotes: notes,
        },
        include: {
          submittedByUser: { select: { id: true, name: true, email: true } },
        },
      });
    });
  }

  /**
   * Records a reviewer's decision and moves the campaign in the same transaction. If
   * two reviewers race, or the campaign is no longer awaiting review, exactly one
   * wins and the other gets null.
   */
  async decideApproval(params: {
    orgId: string;
    approvalId: string;
    campaignId: string;
    reviewerUserId: string;
    decision: 'APPROVED' | 'CHANGES_REQUESTED';
    notes?: string;
    selfApproved: boolean;
    contentHash?: string;
  }) {
    const approved = params.decision === 'APPROVED';
    return this.prisma
      .$transaction(async (tx) => {
        const moved = await tx.campaign.updateMany({
          where: {
            id: params.campaignId,
            orgId: params.orgId,
            deletedAt: null,
            status: {
              in: [CampaignStatus.SUBMITTED, CampaignStatus.UNDER_REVIEW],
            },
          },
          data: approved
            ? {
                status: CampaignStatus.APPROVED,
                approvedContentHash: params.contentHash,
                approvedAt: new Date(),
                approvedByUserId: params.reviewerUserId,
              }
            : {
                status: CampaignStatus.CHANGES_REQUESTED,
                approvedContentHash: null,
                approvedAt: null,
                approvedByUserId: null,
                clientApprovedAt: null,
                clientApprovedByUserId: null,
              },
        });
        if (moved.count !== 1) return null;
        const resolved = await tx.approvalRequest.updateMany({
          where: { id: params.approvalId, status: 'PENDING' },
          data: {
            status: params.decision,
            reviewedByUserId: params.reviewerUserId,
            reviewNotes: params.notes,
            selfApproved: params.selfApproved,
            reviewedAt: new Date(),
          },
        });
        if (resolved.count !== 1) {
          throw new Error('APPROVAL_ALREADY_RESOLVED');
        }
        return tx.approvalRequest.findUnique({
          where: { id: params.approvalId },
          include: {
            campaign: true,
            reviewedByUser: { select: { id: true, name: true, email: true } },
          },
        });
      })
      .catch((err) => {
        if (err?.message === 'APPROVAL_ALREADY_RESOLVED') return null;
        throw err;
      });
  }

  async withdrawPendingApprovals(campaignId: string) {
    return this.prisma.approvalRequest.updateMany({
      where: { campaignId, status: 'PENDING' },
      data: { status: 'WITHDRAWN', reviewedAt: new Date() },
    });
  }

  /** Back to an editable draft: approval evidence and client sign-off no longer apply. */
  async resetToDraft(
    orgId: string,
    campaignId: string,
    from: CampaignStatus[]
  ) {
    const res = await this.prisma.campaign.updateMany({
      where: { id: campaignId, orgId, deletedAt: null, status: { in: from } },
      data: {
        status: CampaignStatus.DRAFT,
        revision: { increment: 1 },
        approvedContentHash: null,
        approvedAt: null,
        approvedByUserId: null,
        clientApprovedAt: null,
        clientApprovedByUserId: null,
        requiresAttention: false,
        attentionReason: null,
      },
    });
    return res.count === 1;
  }

  async recordClientApproval(
    orgId: string,
    campaignId: string,
    userId: string
  ) {
    const res = await this.prisma.campaign.updateMany({
      where: {
        id: campaignId,
        orgId,
        deletedAt: null,
        status: { in: [CampaignStatus.SUBMITTED, CampaignStatus.UNDER_REVIEW] },
      },
      data: { clientApprovedAt: new Date(), clientApprovedByUserId: userId },
    });
    return res.count === 1;
  }

  async clientRequestChanges(orgId: string, campaignId: string) {
    return this.prisma.$transaction(async (tx) => {
      const moved = await tx.campaign.updateMany({
        where: {
          id: campaignId,
          orgId,
          deletedAt: null,
          status: {
            in: [CampaignStatus.SUBMITTED, CampaignStatus.UNDER_REVIEW],
          },
        },
        data: {
          status: CampaignStatus.CHANGES_REQUESTED,
          clientApprovedAt: null,
          clientApprovedByUserId: null,
        },
      });
      if (moved.count !== 1) return false;
      await tx.approvalRequest.updateMany({
        where: { campaignId, status: 'PENDING' },
        data: { status: 'CHANGES_REQUESTED', reviewedAt: new Date() },
      });
      return true;
    });
  }

  async archiveOrCancel(
    orgId: string,
    campaignId: string,
    from: CampaignStatus[],
    to: CampaignStatus
  ) {
    const res = await this.prisma.campaign.updateMany({
      where: { id: campaignId, orgId, deletedAt: null, status: { in: from } },
      data: {
        status: to,
        ...(to === CampaignStatus.CANCELLED
          ? { requiresAttention: false, attentionReason: null }
          : {}),
      },
    });
    return res.count === 1;
  }

  async countLiveCampaignsForClient(orgId: string, customerId: string) {
    return this.prisma.campaign.count({
      where: {
        orgId,
        customerId,
        deletedAt: null,
        status: {
          in: [
            CampaignStatus.SCHEDULED,
            CampaignStatus.PUBLISHING,
            CampaignStatus.PAUSED,
          ],
        },
      },
    });
  }

  // ==========================================
  // INVOICES
  // ==========================================
  async getLastInvoiceNumber(orgId: string, prefix: string) {
    const last = await this.prisma.agencyInvoice.findFirst({
      where: { orgId, invoiceNumber: { startsWith: prefix } },
      orderBy: { invoiceNumber: 'desc' },
      select: { invoiceNumber: true },
    });
    return last?.invoiceNumber ?? null;
  }

  // ==========================================
  // CLIENT PORTAL (client-safe projection only)
  // ==========================================
  async getPortalCampaigns(orgId: string, customerId: string) {
    return this.prisma.campaign.findMany({
      where: {
        orgId,
        customerId,
        deletedAt: null,
        // Work in progress is the agency's own; a client sees an ad once it is submitted.
        status: { notIn: [CampaignStatus.DRAFT, CampaignStatus.ARCHIVED] },
      },
      select: {
        id: true,
        name: true,
        objective: true,
        status: true,
        startDate: true,
        endDate: true,
        contentTitle: true,
        contentBody: true,
        contentMedia: true,
        ctaLink: true,
        ctaText: true,
        telegramChannelLink: true,
        requiresClientApproval: true,
        clientApprovedAt: true,
        trackingLinks: { select: { totalClicks: true } },
        postingJobs: { select: { status: true } },
        _count: { select: { destinations: true, leads: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
