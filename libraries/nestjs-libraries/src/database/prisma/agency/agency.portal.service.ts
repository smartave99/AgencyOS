import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CampaignStatus } from '@prisma/client';
import { AgencyRepository } from './agency.repository';
import { AgencyAccessService, AgencyActor } from './agency.access.service';

export interface ClientPortalOverview {
  client: {
    id: string;
    name: string;
    companyName: string;
    email?: string;
    phone?: string;
    accountRep?: { name: string; email: string };
  };
  viewer: { isClient: boolean; canReview: boolean };
  metrics: {
    totalCampaigns: number;
    activeCampaigns: number;
    scheduledCampaigns: number;
    completedCampaigns: number;
    totalLinkClicks: number;
    totalLeads: number;
    successfulPublications: number;
  };
  campaigns: {
    id: string;
    name: string;
    objective: string;
    status: CampaignStatus;
    startDate?: Date;
    endDate?: Date;
    contentTitle?: string;
    contentBody?: string;
    contentMedia?: string[];
    ctaLink?: string;
    ctaText?: string;
    telegramChannelLink?: string;
    totalClicks: number;
    leadsCount: number;
    destinationsCount: number;
    awaitingClientApproval: boolean;
    clientApprovedAt?: Date;
  }[];
}

const AWAITING_REVIEW: CampaignStatus[] = [
  CampaignStatus.SUBMITTED,
  CampaignStatus.UNDER_REVIEW,
];

@Injectable()
export class AgencyPortalService {
  constructor(
    private readonly repository: AgencyRepository,
    private readonly access: AgencyAccessService
  ) {}

  /**
   * Client-safe view of one customer. A CLIENT user is pinned to their own customer
   * and can never name another; staff may preview any client but cannot act as one.
   * Internal notes, budgets, other clients and the sales rep's CRM data are never
   * selected here, so they cannot leak by accident.
   */
  async getClientPortalData(
    actor: AgencyActor,
    requestedCustomerId?: string
  ): Promise<ClientPortalOverview> {
    this.access.assert(actor, 'portal:view');
    const isClient = this.access.isClient(actor);
    const customerId = isClient ? actor.customerId : requestedCustomerId;
    if (!customerId) {
      throw new BadRequestException('Choose a client to preview');
    }
    this.access.assertCustomerScope(actor, customerId);

    const client = await this.repository.getClientById(actor.orgId, customerId);
    if (!client) throw new NotFoundException('Client not found');
    const campaigns = await this.repository.getPortalCampaigns(
      actor.orgId,
      customerId
    );

    let totalLinkClicks = 0;
    let totalLeads = 0;
    let successfulPublications = 0;
    let activeCount = 0;
    let scheduledCount = 0;
    let completedCount = 0;

    const formatted = campaigns.map((camp) => {
      if (camp.status === CampaignStatus.PUBLISHING) activeCount++;
      if (camp.status === CampaignStatus.SCHEDULED) scheduledCount++;
      if (camp.status === CampaignStatus.COMPLETED) completedCount++;

      const clicks = camp.trackingLinks.reduce(
        (sum, l) => sum + l.totalClicks,
        0
      );
      totalLinkClicks += clicks;
      totalLeads += camp._count.leads;
      successfulPublications += camp.postingJobs.filter(
        (j) => j.status === 'SUCCEEDED'
      ).length;

      let media: string[] = [];
      try {
        if (camp.contentMedia) {
          const parsed = JSON.parse(camp.contentMedia);
          media = (Array.isArray(parsed) ? parsed : [parsed])
            .map((m) => (typeof m === 'string' ? m : m?.path || m?.url))
            .filter(Boolean);
        }
      } catch {
        media = [];
      }
      return {
        id: camp.id,
        name: camp.name,
        objective: camp.objective,
        status: camp.status,
        startDate: camp.startDate || undefined,
        endDate: camp.endDate || undefined,
        contentTitle: camp.contentTitle || undefined,
        contentBody: camp.contentBody || undefined,
        contentMedia: media,
        ctaLink: camp.ctaLink || undefined,
        ctaText: camp.ctaText || undefined,
        telegramChannelLink: camp.telegramChannelLink || undefined,
        totalClicks: clicks,
        leadsCount: camp._count.leads,
        destinationsCount: camp._count.destinations,
        awaitingClientApproval:
          camp.requiresClientApproval &&
          !camp.clientApprovedAt &&
          AWAITING_REVIEW.includes(camp.status),
        clientApprovedAt: camp.clientApprovedAt || undefined,
      };
    });

    return {
      client: {
        id: client.id,
        name: client.name,
        companyName: client.companyName || client.name,
        email: client.email || undefined,
        phone: client.phone || undefined,
        accountRep: client.assignedSalesUser
          ? {
              name: client.assignedSalesUser.name || 'Account Executive',
              email: client.assignedSalesUser.email,
            }
          : undefined,
      },
      viewer: { isClient, canReview: this.access.can(actor, 'portal:review') },
      metrics: {
        totalCampaigns: campaigns.length,
        activeCampaigns: activeCount,
        scheduledCampaigns: scheduledCount,
        completedCampaigns: completedCount,
        totalLinkClicks,
        totalLeads,
        successfulPublications,
      },
      campaigns: formatted,
    };
  }

  /**
   * Only a real CLIENT user, for their own customer, can review. Approval records the
   * client's sign-off on this exact content; it does not publish and does not replace
   * the agency's own approval. Requesting changes sends the campaign back to the team.
   */
  async clientReviewCampaign(
    actor: AgencyActor,
    campaignId: string,
    action: 'APPROVE' | 'REQUEST_CHANGES',
    feedback?: string
  ) {
    this.access.assert(actor, 'portal:review');
    const campaign = await this.repository.getCampaignById(
      actor.orgId,
      campaignId
    );
    if (!campaign || campaign.customerId !== actor.customerId) {
      throw new NotFoundException('Campaign not found');
    }
    if (!AWAITING_REVIEW.includes(campaign.status)) {
      throw new BadRequestException(
        `Campaign is ${campaign.status} and not awaiting review`
      );
    }

    if (action === 'APPROVE') {
      const ok = await this.repository.recordClientApproval(
        actor.orgId,
        campaignId,
        actor.userId
      );
      if (!ok)
        throw new BadRequestException('Campaign is no longer awaiting review');
      await this.access.audit(actor, {
        action: 'campaign.client_approved',
        entityType: 'Campaign',
        entityId: campaignId,
        summary: feedback?.slice(0, 200),
      });
      return {
        campaignId,
        status: campaign.status,
        message:
          'Thanks. Your approval is recorded and the agency can now finalize the campaign.',
      };
    }

    if (!feedback?.trim()) {
      throw new BadRequestException(
        'Tell us what to change so the team can fix it'
      );
    }
    const ok = await this.repository.clientRequestChanges(
      actor.orgId,
      campaignId
    );
    if (!ok)
      throw new BadRequestException('Campaign is no longer awaiting review');
    await this.access.audit(actor, {
      action: 'campaign.client_changes_requested',
      entityType: 'Campaign',
      entityId: campaignId,
      summary: feedback.slice(0, 200),
    });
    return {
      campaignId,
      status: CampaignStatus.CHANGES_REQUESTED,
      message: 'Feedback sent to the agency team.',
    };
  }
}
