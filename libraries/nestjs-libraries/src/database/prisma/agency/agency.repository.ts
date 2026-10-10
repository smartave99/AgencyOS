import { Injectable } from '@nestjs/common';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { CampaignStatus, Prisma } from '@prisma/client';

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
  createdById: string;
  destinations?: Array<{
    destinationType: 'TELEGRAM' | 'SOCIAL';
    telegramDestinationId?: string;
    integrationId?: string;
    customSettings?: string;
  }>;
}

export interface UpdateCampaignParams {
  name?: string;
  description?: string;
  objective?: string;
  budget?: number;
  status?: CampaignStatus;
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
}

export interface CreateTelegramDestinationParams {
  chatId: string;
  title: string;
  type?: string;
  botUsername?: string;
  canPostMessages?: boolean;
  canDeleteMessages?: boolean;
  canInviteUsers?: boolean;
  permittedCategories?: string;
  postingFrequencyRules?: string;
  allowedPostingWindows?: string;
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
          select: { id: true, name: true, type: true, picture: true, disabled: true },
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
    return this.prisma.customer.update({
      where: { id },
      data: {
        ...(params.name ? { name: params.name } : {}),
        ...(params.email !== undefined ? { email: params.email } : {}),
        ...(params.phone !== undefined ? { phone: params.phone } : {}),
        ...(params.companyName !== undefined ? { companyName: params.companyName } : {}),
        ...(params.industry !== undefined ? { industry: params.industry } : {}),
        ...(params.website !== undefined ? { website: params.website } : {}),
        ...(params.status !== undefined ? { status: params.status } : {}),
        ...(params.notes !== undefined ? { notes: params.notes } : {}),
        ...(params.assignedSalesUserId !== undefined ? { assignedSalesUserId: params.assignedSalesUserId } : {}),
      },
      include: {
        assignedSalesUser: {
          select: { id: true, name: true, email: true },
        },
      },
    });
  }

  async deleteClient(orgId: string, id: string) {
    return this.prisma.customer.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // ==========================================
  // CAMPAIGNS
  // ==========================================
  async getCampaigns(orgId: string, filters?: { status?: CampaignStatus; customerId?: string; search?: string }) {
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
                { contentTitle: { contains: filters.search, mode: 'insensitive' } },
                { contentBody: { contains: filters.search, mode: 'insensitive' } },
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
              select: { id: true, title: true, chatId: true, type: true, isAuthorized: true },
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
            telegramDestination: { select: { id: true, title: true, type: true } },
            integration: { select: { id: true, name: true, type: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        leads: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
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
        budget: params.budget !== undefined ? new Prisma.Decimal(params.budget) : null,
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
        createdById: params.createdById,
        ...(params.destinations && params.destinations.length > 0
          ? {
              destinations: {
                create: params.destinations.map((d) => ({
                  destinationType: d.destinationType,
                  telegramDestinationId: d.telegramDestinationId,
                  integrationId: d.integrationId,
                  customSettings: d.customSettings,
                })),
              },
            }
          : {}),
      },
      include: {
        customer: true,
        destinations: {
          include: {
            telegramDestination: true,
            integration: true,
          },
        },
      },
    });
  }

  async updateCampaign(orgId: string, id: string, params: UpdateCampaignParams) {
    return this.prisma.campaign.update({
      where: { id },
      data: {
        ...(params.name ? { name: params.name } : {}),
        ...(params.description !== undefined ? { description: params.description } : {}),
        ...(params.objective ? { objective: params.objective } : {}),
        ...(params.budget !== undefined ? { budget: params.budget !== null ? new Prisma.Decimal(params.budget) : null } : {}),
        ...(params.status ? { status: params.status } : {}),
        ...(params.startDate !== undefined ? { startDate: params.startDate } : {}),
        ...(params.endDate !== undefined ? { endDate: params.endDate } : {}),
        ...(params.timezone ? { timezone: params.timezone } : {}),
        ...(params.postingFrequency !== undefined ? { postingFrequency: params.postingFrequency } : {}),
        ...(params.postingWindows !== undefined ? { postingWindows: params.postingWindows } : {}),
        ...(params.contentTitle !== undefined ? { contentTitle: params.contentTitle } : {}),
        ...(params.contentBody ? { contentBody: params.contentBody } : {}),
        ...(params.contentMedia !== undefined ? { contentMedia: params.contentMedia } : {}),
        ...(params.ctaLink !== undefined ? { ctaLink: params.ctaLink } : {}),
        ...(params.ctaText !== undefined ? { ctaText: params.ctaText } : {}),
        ...(params.telegramChannelLink !== undefined ? { telegramChannelLink: params.telegramChannelLink } : {}),
        ...(params.internalNotes !== undefined ? { internalNotes: params.internalNotes } : {}),
      },
      include: {
        customer: true,
        destinations: true,
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
    }>
  ) {
    await this.prisma.campaignDestination.deleteMany({
      where: { campaignId },
    });

    if (destinations.length > 0) {
      await this.prisma.campaignDestination.createMany({
        data: destinations.map((d) => ({
          campaignId,
          destinationType: d.destinationType,
          telegramDestinationId: d.telegramDestinationId,
          integrationId: d.integrationId,
          customSettings: d.customSettings,
        })),
      });
    }

    return this.prisma.campaignDestination.findMany({
      where: { campaignId },
      include: { telegramDestination: true, integration: true },
    });
  }

  async deleteCampaign(orgId: string, id: string) {
    return this.prisma.campaign.update({
      where: { id },
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
                telegramDestination: { select: { id: true, title: true, type: true } },
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

  async createApprovalRequest(campaignId: string, submittedByUserId: string, notes?: string) {
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
    notes?: string
  ) {
    return this.prisma.approvalRequest.update({
      where: { id: approvalId },
      data: {
        status: decision,
        reviewedByUserId,
        reviewNotes: notes,
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

  async createTelegramDestination(orgId: string, params: CreateTelegramDestinationParams) {
    return this.prisma.telegramDestination.create({
      data: {
        orgId,
        chatId: params.chatId,
        title: params.title,
        type: params.type || 'channel',
        botUsername: params.botUsername,
        canPostMessages: params.canPostMessages ?? true,
        canDeleteMessages: params.canDeleteMessages ?? false,
        canInviteUsers: params.canInviteUsers ?? false,
        permittedCategories: params.permittedCategories,
        postingFrequencyRules: params.postingFrequencyRules,
        allowedPostingWindows: params.allowedPostingWindows,
        isAuthorized: true,
        lastVerifiedAt: new Date(),
      },
    });
  }

  async updateTelegramDestination(orgId: string, id: string, params: Partial<CreateTelegramDestinationParams & { isAuthorized?: boolean; lastError?: string }>) {
    return this.prisma.telegramDestination.update({
      where: { id },
      data: {
        ...(params.title ? { title: params.title } : {}),
        ...(params.type ? { type: params.type } : {}),
        ...(params.canPostMessages !== undefined ? { canPostMessages: params.canPostMessages } : {}),
        ...(params.canDeleteMessages !== undefined ? { canDeleteMessages: params.canDeleteMessages } : {}),
        ...(params.canInviteUsers !== undefined ? { canInviteUsers: params.canInviteUsers } : {}),
        ...(params.isAuthorized !== undefined ? { isAuthorized: params.isAuthorized } : {}),
        ...(params.lastError !== undefined ? { lastError: params.lastError } : {}),
        lastVerifiedAt: new Date(),
      },
    });
  }

  async deleteTelegramDestination(orgId: string, id: string) {
    return this.prisma.telegramDestination.update({
      where: { id },
      data: { deletedAt: new Date() },
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
        executedAt: new Date(),
      },
    });
  }

  async getPublishingEventByIdempotencyKey(idempotencyKey: string) {
    return this.prisma.publishingEvent.findFirst({
      where: { idempotencyKey },
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
      connectedSocialCount,
      publishingStats,
      recentCampaigns,
      recentEvents,
    ] = await Promise.all([
      this.prisma.customer.count({
        where: { orgId, deletedAt: null, status: 'ACTIVE' },
      }),
      this.prisma.campaign.count({
        where: { orgId, deletedAt: null, status: { in: [CampaignStatus.APPROVED, CampaignStatus.SCHEDULED, CampaignStatus.PUBLISHING] } },
      }),
      this.prisma.campaign.count({
        where: { orgId, deletedAt: null },
      }),
      this.prisma.approvalRequest.count({
        where: { campaign: { orgId, deletedAt: null }, status: 'PENDING' },
      }),
      this.prisma.telegramDestination.count({
        where: { orgId, deletedAt: null, isAuthorized: true },
      }),
      this.prisma.integration.count({
        where: { organizationId: orgId, deletedAt: null, disabled: false },
      }),
      this.prisma.publishingEvent.groupBy({
        by: ['status'],
        where: { campaign: { orgId, deletedAt: null } },
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
    ]);

    const successfulPosts = publishingStats.find((s) => s.status === 'SUCCESS')?._count?.status || 0;
    const failedPosts = publishingStats.find((s) => s.status === 'FAILED')?._count?.status || 0;
    const totalPosts = successfulPosts + failedPosts;
    const deliveryRate = totalPosts > 0 ? Math.round((successfulPosts / totalPosts) * 100) : 100;

    return {
      activeClientsCount,
      activeCampaignsCount,
      totalCampaignsCount,
      pendingApprovalsCount,
      telegramDestinationsCount,
      connectedSocialCount,
      successfulPosts,
      failedPosts,
      deliveryRate,
      recentCampaigns,
      recentEvents,
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
  async createAgencyInvoice(orgId: string, params: {
    customerId: string;
    invoiceNumber: string;
    amount: number;
    currency?: string;
    dueDate?: Date;
    items?: string;
    notes?: string;
  }) {
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
        customer: { select: { id: true, name: true, companyName: true, email: true } },
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
        customer: { select: { id: true, name: true, companyName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateAgencyInvoiceStatus(orgId: string, id: string, status: string, paidAt?: Date) {
    return this.prisma.agencyInvoice.update({
      where: { id },
      data: {
        status,
        ...(paidAt ? { paidAt } : {}),
      },
      include: {
        customer: { select: { id: true, name: true, companyName: true, email: true } },
      },
    });
  }

  // ==========================================
  // SCHEDULED CAMPAIGNS FOR AUTONOMOUS DISPATCH
  // ==========================================
  async getScheduledCampaignsReadyToPublish() {
    return this.prisma.campaign.findMany({
      where: {
        status: CampaignStatus.SCHEDULED,
        deletedAt: null,
        startDate: {
          lte: new Date(),
        },
      },
      include: {
        destinations: {
          include: {
            telegramDestination: true,
            integration: true,
          },
        },
      },
    });
  }
}
