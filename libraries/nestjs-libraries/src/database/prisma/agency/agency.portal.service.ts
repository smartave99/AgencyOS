import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { AgencyRepository } from './agency.repository';
import { CampaignStatus } from '@prisma/client';

export interface ClientPortalOverview {
  client: {
    id: string;
    name: string;
    companyName: string;
    email?: string;
    phone?: string;
    accountRep?: { name: string; email: string };
  };
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
  }[];
}

@Injectable()
export class AgencyPortalService {
  constructor(private readonly repository: AgencyRepository) {}

  /**
   * Secure, isolated client portal view.
   * Excludes internal agency margins, other clients, and internal CRM sales notes.
   */
  async getClientPortalData(orgId: string, customerId: string): Promise<ClientPortalOverview> {
    const client = await this.repository.getClientById(orgId, customerId);
    if (!client) {
      throw new NotFoundException(`Client ${customerId} not found`);
    }

    const allCampaigns = await this.repository.getCampaigns(orgId, { customerId });

    let totalLinkClicks = 0;
    let totalLeads = 0;
    let successfulPublications = 0;
    let activeCount = 0;
    let scheduledCount = 0;
    let completedCount = 0;

    const formattedCampaigns = [];

    for (const camp of allCampaigns) {
      if (camp.status === CampaignStatus.PUBLISHING) activeCount++;
      if (camp.status === CampaignStatus.SCHEDULED) scheduledCount++;
      if (camp.status === CampaignStatus.COMPLETED) completedCount++;

      // Retrieve full campaign detail to fetch exact link clicks and publishing stats
      const fullCamp = await this.repository.getCampaignById(orgId, camp.id);
      let clicksForCamp = 0;
      if (fullCamp?.trackingLinks) {
        for (const link of fullCamp.trackingLinks) {
          clicksForCamp += link.totalClicks;
        }
      }
      totalLinkClicks += clicksForCamp;

      const leadsForCamp = fullCamp?.leads?.length || camp._count.leads;
      totalLeads += leadsForCamp;

      const pubEvents = fullCamp?.publishingEvents || [];
      for (const ev of pubEvents) {
        if (ev.status === 'SUCCESS') successfulPublications++;
      }

      let parsedMedia: string[] = [];
      try {
        if (camp.contentMedia) {
          parsedMedia = JSON.parse(camp.contentMedia);
        }
      } catch {
        parsedMedia = [];
      }

      formattedCampaigns.push({
        id: camp.id,
        name: camp.name,
        objective: camp.objective,
        status: camp.status,
        startDate: camp.startDate || undefined,
        endDate: camp.endDate || undefined,
        contentTitle: camp.contentTitle || undefined,
        contentBody: camp.contentBody || undefined,
        contentMedia: parsedMedia,
        ctaLink: camp.ctaLink || undefined,
        ctaText: camp.ctaText || undefined,
        telegramChannelLink: camp.telegramChannelLink || undefined,
        totalClicks: clicksForCamp,
        leadsCount: leadsForCamp,
        destinationsCount: camp.destinations?.length || 0,
      });
    }

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
      metrics: {
        totalCampaigns: allCampaigns.length,
        activeCampaigns: activeCount,
        scheduledCampaigns: scheduledCount,
        completedCampaigns: completedCount,
        totalLinkClicks,
        totalLeads,
        successfulPublications,
      },
      campaigns: formattedCampaigns,
    };
  }

  /**
   * Client creative review action: Approve or Request Changes
   */
  async clientReviewCampaign(
    orgId: string,
    customerId: string,
    campaignId: string,
    action: 'APPROVE' | 'REQUEST_CHANGES',
    feedback?: string
  ) {
    const campaign = await this.repository.getCampaignById(orgId, campaignId);
    if (!campaign || campaign.customerId !== customerId) {
      throw new NotFoundException(`Campaign ${campaignId} not found for this client`);
    }

    if (campaign.status !== CampaignStatus.SUBMITTED && campaign.status !== CampaignStatus.UNDER_REVIEW) {
      throw new BadRequestException(`Campaign is in ${campaign.status} status and not awaiting client review`);
    }

    const newCampaignStatus =
      action === 'APPROVE' ? CampaignStatus.APPROVED : CampaignStatus.CHANGES_REQUESTED;
    const approvalDecision =
      action === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';

    await this.repository.updateCampaign(orgId, campaignId, {
      status: newCampaignStatus,
    });

    const approvals = await this.repository.getApprovals(orgId, 'PENDING');
    const matchingApproval = approvals.find((a) => a.campaignId === campaignId);

    if (matchingApproval) {
      await this.repository.reviewApprovalRequest(
        matchingApproval.id,
        campaign.createdById,
        approvalDecision,
        feedback ? `[Client Feedback] ${feedback}` : `[Client Review] ${action}`
      );
    }

    return {
      campaignId,
      status: newCampaignStatus,
      message:
        action === 'APPROVE'
          ? 'Campaign creative approved by client.'
          : 'Feedback recorded for agency team.',
    };
  }
}
