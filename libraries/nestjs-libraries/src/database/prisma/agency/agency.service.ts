import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { AgencyRole, CampaignStatus, PostingJobStatus } from '@prisma/client';
import {
  AgencyRepository,
  CreateClientParams,
  UpdateClientParams,
} from './agency.repository';
import { AgencyPublishingRepository } from './agency.publishing.repository';
import { AgencyPublishingService } from './agency.publishing.service';
import { AgencyAccessService, AgencyActor } from './agency.access.service';

type DestinationInput = {
  destinationType: 'TELEGRAM' | 'SOCIAL';
  telegramDestinationId?: string;
  integrationId?: string;
  customSettings?: string;
  scheduledAt?: Date;
};

export interface CampaignInput {
  customerId?: string;
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
  destinations?: DestinationInput[];
}

const EDITABLE: CampaignStatus[] = [
  CampaignStatus.DRAFT,
  CampaignStatus.CHANGES_REQUESTED,
];
const AWAITING_REVIEW: CampaignStatus[] = [
  CampaignStatus.SUBMITTED,
  CampaignStatus.UNDER_REVIEW,
];
const CANCELLABLE: CampaignStatus[] = [
  CampaignStatus.DRAFT,
  CampaignStatus.CHANGES_REQUESTED,
  CampaignStatus.SUBMITTED,
  CampaignStatus.UNDER_REVIEW,
  CampaignStatus.APPROVED,
  CampaignStatus.SCHEDULED,
  CampaignStatus.PUBLISHING,
  CampaignStatus.PAUSED,
  CampaignStatus.FAILED,
  CampaignStatus.PARTIALLY_FAILED,
];
const REOPENABLE: CampaignStatus[] = [
  CampaignStatus.APPROVED,
  CampaignStatus.SCHEDULED,
  CampaignStatus.PAUSED,
  CampaignStatus.FAILED,
  CampaignStatus.PARTIALLY_FAILED,
];
const ARCHIVABLE: CampaignStatus[] = [
  CampaignStatus.COMPLETED,
  CampaignStatus.CANCELLED,
  CampaignStatus.FAILED,
  CampaignStatus.PARTIALLY_FAILED,
];

@Injectable()
export class AgencyService {
  private readonly logger = new Logger(AgencyService.name);

  constructor(
    private readonly agencyRepo: AgencyRepository,
    private readonly jobsRepo: AgencyPublishingRepository,
    private readonly publishing: AgencyPublishingService,
    private readonly access: AgencyAccessService
  ) {}

  // ==========================================
  // CLIENTS
  // ==========================================
  async getClients(actor: AgencyActor, search?: string) {
    this.access.assert(actor, 'client:read');
    return this.agencyRepo.getClients(actor.orgId, search);
  }

  async getClientById(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'client:read');
    return this.requireClient(actor.orgId, id);
  }

  async createClient(actor: AgencyActor, params: CreateClientParams) {
    this.access.assert(actor, 'client:write');
    if (!params.name || params.name.trim().length === 0) {
      throw new BadRequestException('Client name is required');
    }
    await this.assertAssignable(actor.orgId, params.assignedSalesUserId);
    const client = await this.agencyRepo.createClient(actor.orgId, {
      name: params.name.trim(),
      email: params.email,
      phone: params.phone,
      companyName: params.companyName,
      industry: params.industry,
      website: params.website,
      notes: params.notes,
      assignedSalesUserId: params.assignedSalesUserId,
    });
    await this.access.audit(actor, {
      action: 'client.created',
      entityType: 'Customer',
      entityId: client.id,
      summary: client.name,
    });
    return client;
  }

  async updateClient(
    actor: AgencyActor,
    id: string,
    params: UpdateClientParams
  ) {
    this.access.assert(actor, 'client:write');
    await this.requireClient(actor.orgId, id);
    await this.assertAssignable(actor.orgId, params.assignedSalesUserId);
    const updated = await this.agencyRepo.updateClient(actor.orgId, id, {
      name: params.name,
      email: params.email,
      phone: params.phone,
      companyName: params.companyName,
      industry: params.industry,
      website: params.website,
      status: params.status,
      notes: params.notes,
      assignedSalesUserId: params.assignedSalesUserId,
    });
    await this.access.audit(actor, {
      action: 'client.updated',
      entityType: 'Customer',
      entityId: id,
    });
    return updated;
  }

  async deleteClient(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'client:delete');
    await this.requireClient(actor.orgId, id);
    if (
      (await this.agencyRepo.countLiveCampaignsForClient(actor.orgId, id)) > 0
    ) {
      throw new BadRequestException(
        'This client has campaigns that are scheduled or publishing; cancel them first'
      );
    }
    await this.agencyRepo.deleteClient(actor.orgId, id);
    await this.access.audit(actor, {
      action: 'client.deleted',
      entityType: 'Customer',
      entityId: id,
    });
    return { deleted: true };
  }

  // ==========================================
  // CAMPAIGNS
  // ==========================================
  async getCampaigns(
    actor: AgencyActor,
    filters?: { status?: CampaignStatus; customerId?: string; search?: string }
  ) {
    this.access.assert(actor, 'campaign:read');
    if (
      filters?.status &&
      !Object.values(CampaignStatus).includes(filters.status)
    ) {
      throw new BadRequestException(`Unknown status "${filters.status}"`);
    }
    return this.agencyRepo.getCampaigns(actor.orgId, filters);
  }

  async getCampaignById(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'campaign:read');
    const campaign = await this.requireCampaign(actor.orgId, id);
    const postingJobs = await this.publishing.getJobs(actor.orgId, id);
    return { ...campaign, postingJobs };
  }

  async createCampaign(actor: AgencyActor, input: CampaignInput) {
    this.access.assert(actor, 'campaign:write');
    if (!input.name?.trim())
      throw new BadRequestException('Campaign name is required');
    if (!input.customerId)
      throw new BadRequestException('Customer / Client ID is required');
    if (!input.contentBody?.trim())
      throw new BadRequestException('Campaign promotional content is required');
    this.assertDates(input.startDate, input.endDate);
    this.assertTimezone(input.timezone);

    await this.requireClient(actor.orgId, input.customerId);
    if (input.destinations?.length) {
      await this.assertDestinationRefs(actor.orgId, input.destinations);
    }
    const campaign = await this.agencyRepo.createCampaign(actor.orgId, {
      customerId: input.customerId,
      name: input.name.trim(),
      description: input.description,
      objective: input.objective,
      budget: input.budget,
      startDate: input.startDate,
      endDate: input.endDate,
      timezone: input.timezone,
      postingFrequency: input.postingFrequency,
      postingWindows: input.postingWindows,
      contentTitle: input.contentTitle,
      contentBody: input.contentBody,
      contentMedia: input.contentMedia,
      ctaLink: input.ctaLink,
      ctaText: input.ctaText,
      telegramChannelLink: input.telegramChannelLink,
      internalNotes: input.internalNotes,
      requiresClientApproval: input.requiresClientApproval,
      createdById: actor.userId,
      destinations: input.destinations,
    });
    await this.access.audit(actor, {
      action: 'campaign.created',
      entityType: 'Campaign',
      entityId: campaign.id,
      summary: campaign.name,
    });
    return campaign;
  }

  /** Live preview for the composer: the real rendering, never a lookalike. */
  previewAd(
    actor: AgencyActor,
    input: {
      contentTitle?: string;
      contentBody?: string;
      ctaLink?: string;
      ctaText?: string;
      telegramChannelLink?: string;
      media?: string[];
    }
  ) {
    this.access.assert(actor, 'campaign:write');
    return this.publishing.previewAd({
      title: input.contentTitle,
      body: input.contentBody ?? '',
      ctaLink: input.ctaLink,
      ctaText: input.ctaText,
      channelLink: input.telegramChannelLink,
      media: input.media ?? [],
    });
  }

  async updateCampaign(actor: AgencyActor, id: string, input: CampaignInput) {
    this.access.assert(actor, 'campaign:write');
    const campaign = await this.requireCampaign(actor.orgId, id);
    const onlyNotes = Object.keys(input).every(
      (k) =>
        (input as Record<string, unknown>)[k] === undefined ||
        k === 'internalNotes'
    );
    // Content is frozen once submitted: what was reviewed is what is published. Use
    // "reopen" to edit; that voids the approval.
    if (!EDITABLE.includes(campaign.status) && !onlyNotes) {
      throw new BadRequestException(
        `A ${campaign.status} campaign can't be edited. Reopen it to make changes; that voids any approval.`
      );
    }
    this.assertDates(
      input.startDate ?? campaign.startDate ?? undefined,
      input.endDate ?? campaign.endDate ?? undefined
    );
    this.assertTimezone(input.timezone);
    return this.agencyRepo.updateCampaign(actor.orgId, id, {
      name: input.name,
      description: input.description,
      objective: input.objective,
      budget: input.budget,
      startDate: input.startDate,
      endDate: input.endDate,
      timezone: input.timezone,
      postingFrequency: input.postingFrequency,
      postingWindows: input.postingWindows,
      contentTitle: input.contentTitle,
      contentBody: input.contentBody,
      contentMedia: input.contentMedia,
      ctaLink: input.ctaLink,
      ctaText: input.ctaText,
      telegramChannelLink: input.telegramChannelLink,
      internalNotes: input.internalNotes,
      requiresClientApproval: input.requiresClientApproval,
    });
  }

  async updateCampaignDestinations(
    actor: AgencyActor,
    campaignId: string,
    destinations: DestinationInput[]
  ) {
    this.access.assert(actor, 'campaign:write');
    const campaign = await this.requireCampaign(actor.orgId, campaignId);
    if (!EDITABLE.includes(campaign.status)) {
      throw new BadRequestException(
        `Destinations can't change while the campaign is ${campaign.status}. Reopen it first.`
      );
    }
    await this.assertDestinationRefs(actor.orgId, destinations);
    const result = await this.agencyRepo.updateCampaignDestinations(
      campaignId,
      destinations
    );
    await this.access.audit(actor, {
      action: 'campaign.destinations_updated',
      entityType: 'Campaign',
      entityId: campaignId,
      summary: `${destinations.length} destination(s)`,
    });
    return result;
  }

  async duplicateCampaign(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'campaign:write');
    const src = await this.requireCampaign(actor.orgId, id);
    const copy = await this.agencyRepo.createCampaign(actor.orgId, {
      customerId: src.customerId,
      name: `${src.name} (copy)`.slice(0, 200),
      description: src.description ?? undefined,
      objective: src.objective,
      budget: src.budget ? Number(src.budget) : undefined,
      timezone: src.timezone,
      postingFrequency: src.postingFrequency ?? undefined,
      postingWindows: src.postingWindows ?? undefined,
      contentTitle: src.contentTitle ?? undefined,
      contentBody: src.contentBody,
      contentMedia: src.contentMedia ?? undefined,
      ctaLink: src.ctaLink ?? undefined,
      ctaText: src.ctaText ?? undefined,
      telegramChannelLink: src.telegramChannelLink ?? undefined,
      requiresClientApproval: src.requiresClientApproval,
      createdById: actor.userId,
      destinations: src.destinations.map((d) => ({
        destinationType: d.destinationType as 'TELEGRAM' | 'SOCIAL',
        telegramDestinationId: d.telegramDestinationId ?? undefined,
        integrationId: d.integrationId ?? undefined,
        customSettings: d.customSettings ?? undefined,
      })),
    });
    await this.access.audit(actor, {
      action: 'campaign.duplicated',
      entityType: 'Campaign',
      entityId: copy.id,
      summary: `From ${id}`,
    });
    return copy;
  }

  async deleteCampaign(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'campaign:delete');
    const campaign = await this.requireCampaign(actor.orgId, id);
    if (
      campaign.status === CampaignStatus.SCHEDULED ||
      campaign.status === CampaignStatus.PUBLISHING
    ) {
      throw new BadRequestException('Cancel the campaign before deleting it');
    }
    await this.publishing.cancelOpenJobs(id, 'Campaign deleted');
    await this.agencyRepo.withdrawPendingApprovals(id);
    await this.agencyRepo.deleteCampaign(actor.orgId, id);
    await this.access.audit(actor, {
      action: 'campaign.deleted',
      entityType: 'Campaign',
      entityId: id,
      summary: campaign.name,
    });
    return { deleted: true };
  }

  // ==========================================
  // WORKFLOW & APPROVALS
  // ==========================================
  async submitForApproval(
    actor: AgencyActor,
    campaignId: string,
    notes?: string
  ) {
    this.access.assert(actor, 'campaign:write');
    const campaign = await this.requireCampaign(actor.orgId, campaignId);
    if (!EDITABLE.includes(campaign.status)) {
      throw new BadRequestException(
        `Only campaigns in DRAFT or CHANGES_REQUESTED status can be submitted (Current: ${campaign.status})`
      );
    }
    this.publishing.assertReadyForReview(campaign);
    const approval = await this.agencyRepo.submitForReview(
      actor.orgId,
      campaignId,
      actor.userId,
      notes
    );
    if (!approval) {
      throw new ConflictException(
        'The campaign changed while submitting; reload and try again'
      );
    }
    await this.access.audit(actor, {
      action: 'campaign.submitted',
      entityType: 'Campaign',
      entityId: campaignId,
    });
    return approval;
  }

  async getApprovals(actor: AgencyActor, status?: string) {
    this.access.assert(actor, 'campaign:read');
    return this.agencyRepo.getApprovals(actor.orgId, status);
  }

  async reviewCampaign(
    actor: AgencyActor,
    approvalId: string,
    decision: 'APPROVE' | 'REJECT',
    notes?: string
  ) {
    this.access.assert(actor, 'campaign:approve');
    const approval = await this.agencyRepo.getApprovalById(
      actor.orgId,
      approvalId
    );
    if (!approval)
      throw new NotFoundException(`Approval request ${approvalId} not found`);
    if (approval.status !== 'PENDING') {
      throw new BadRequestException(
        `Approval request is already resolved (${approval.status})`
      );
    }
    const campaign = approval.campaign;
    if (!AWAITING_REVIEW.includes(campaign.status)) {
      throw new BadRequestException(
        `Campaign is ${campaign.status} and not awaiting review`
      );
    }

    // Four-eyes: authors don't approve their own work. Owners/admins may, but it is
    // recorded on the approval so the audit trail shows it.
    const isAuthor = approval.submittedByUserId === actor.userId;
    const selfApproved = isAuthor && decision === 'APPROVE';
    if (
      selfApproved &&
      actor.role !== AgencyRole.AGENCY_OWNER &&
      actor.role !== AgencyRole.AGENCY_ADMIN
    ) {
      throw new ForbiddenException(
        'A different reviewer must approve a campaign you submitted'
      );
    }
    if (decision === 'REJECT' && !notes?.trim()) {
      throw new BadRequestException(
        'Explain what needs to change so the submitter can fix it'
      );
    }

    let contentHash: string | undefined;
    if (decision === 'APPROVE') {
      if (campaign.requiresClientApproval && !campaign.clientApprovedAt) {
        throw new BadRequestException(
          'The client has not approved this creative yet'
        );
      }
      const full = await this.requireCampaign(actor.orgId, campaign.id);
      this.publishing.assertReadyForReview(full);
      contentHash = this.publishing.computeContentHash(full);
    }

    const resolved = await this.agencyRepo.decideApproval({
      orgId: actor.orgId,
      approvalId,
      campaignId: campaign.id,
      reviewerUserId: actor.userId,
      decision: decision === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED',
      notes,
      selfApproved,
      contentHash,
    });
    if (!resolved) {
      throw new ConflictException('Someone else already decided this request');
    }
    await this.access.audit(actor, {
      action:
        decision === 'APPROVE'
          ? 'campaign.approved'
          : 'campaign.changes_requested',
      entityType: 'Campaign',
      entityId: campaign.id,
      summary: selfApproved
        ? 'Self-approved by owner/admin'
        : notes?.slice(0, 200),
    });
    return resolved;
  }

  async scheduleCampaign(actor: AgencyActor, campaignId: string) {
    this.access.assert(actor, 'campaign:schedule');
    const campaign = await this.requireCampaign(actor.orgId, campaignId);
    if (campaign.status !== CampaignStatus.APPROVED) {
      throw new BadRequestException(
        `Only APPROVED campaigns can be scheduled for publishing. Current status: ${campaign.status}`
      );
    }
    if (!campaign.startDate) {
      throw new BadRequestException(
        'Campaign start date is required to schedule'
      );
    }
    this.publishing.validateForPublishing(campaign);

    // Jobs first (idempotent, inert while the campaign is not SCHEDULED), then the
    // guarded status flip that makes them eligible.
    await this.publishing.createJobsForCampaign(campaign);
    const moved = await this.jobsRepo.transitionCampaign(
      actor.orgId,
      campaignId,
      [CampaignStatus.APPROVED],
      {
        status: CampaignStatus.SCHEDULED,
      }
    );
    if (!moved) {
      throw new ConflictException(
        'The campaign changed while scheduling; reload and try again'
      );
    }
    await this.access.audit(actor, {
      action: 'campaign.scheduled',
      entityType: 'Campaign',
      entityId: campaignId,
      summary: campaign.startDate.toISOString(),
    });
    return this.requireCampaign(actor.orgId, campaignId);
  }

  /** Queues the sends for immediate pickup by the dispatcher; it does not block on Telegram. */
  async publishCampaignNow(actor: AgencyActor, campaignId: string) {
    this.access.assert(actor, 'campaign:publish');
    const campaign = await this.requireCampaign(actor.orgId, campaignId);
    if (
      campaign.status !== CampaignStatus.APPROVED &&
      campaign.status !== CampaignStatus.SCHEDULED
    ) {
      throw new BadRequestException(
        `Only APPROVED or SCHEDULED campaigns can be published. Current status: ${campaign.status}`
      );
    }
    this.publishing.validateForPublishing(campaign);
    await this.publishing.createJobsForCampaign(campaign, new Date());
    await this.publishing.rescheduleOpenJobsNow(campaignId);
    const moved = await this.jobsRepo.transitionCampaign(
      actor.orgId,
      campaignId,
      [CampaignStatus.APPROVED, CampaignStatus.SCHEDULED],
      { status: CampaignStatus.PUBLISHING }
    );
    if (!moved) {
      throw new ConflictException(
        'The campaign changed while publishing; reload and try again'
      );
    }
    await this.access.audit(actor, {
      action: 'campaign.publish_requested',
      entityType: 'Campaign',
      entityId: campaignId,
    });
    // Wake the dispatcher so the operator doesn't wait for the next poll. Safe to
    // lose: the scheduler tick would pick the same jobs up.
    this.publishing
      .dispatchDue()
      .catch((err) =>
        this.logger.warn(`Immediate dispatch failed: ${err?.message}`)
      );
    return this.requireCampaign(actor.orgId, campaignId);
  }

  async pauseCampaign(actor: AgencyActor, campaignId: string) {
    this.access.assert(actor, 'campaign:control');
    await this.requireCampaign(actor.orgId, campaignId);
    const moved = await this.jobsRepo.transitionCampaign(
      actor.orgId,
      campaignId,
      [CampaignStatus.SCHEDULED, CampaignStatus.PUBLISHING],
      { status: CampaignStatus.PAUSED }
    );
    if (!moved)
      throw new BadRequestException(
        'Only scheduled or publishing campaigns can be paused'
      );
    await this.access.audit(actor, {
      action: 'campaign.paused',
      entityType: 'Campaign',
      entityId: campaignId,
    });
    return this.requireCampaign(actor.orgId, campaignId);
  }

  async resumeCampaign(actor: AgencyActor, campaignId: string) {
    this.access.assert(actor, 'campaign:control');
    await this.requireCampaign(actor.orgId, campaignId);
    const counts = await this.jobsRepo.getJobStatusCounts(campaignId);
    const started =
      counts.SUCCEEDED + counts.DEAD + counts.UNCERTAIN + counts.SENDING > 0;
    const moved = await this.jobsRepo.transitionCampaign(
      actor.orgId,
      campaignId,
      [CampaignStatus.PAUSED],
      {
        status: started ? CampaignStatus.PUBLISHING : CampaignStatus.SCHEDULED,
      }
    );
    if (!moved)
      throw new BadRequestException('Only paused campaigns can be resumed');
    await this.access.audit(actor, {
      action: 'campaign.resumed',
      entityType: 'Campaign',
      entityId: campaignId,
    });
    await this.publishing.reconcileCampaign(actor.orgId, campaignId);
    return this.requireCampaign(actor.orgId, campaignId);
  }

  async cancelCampaign(
    actor: AgencyActor,
    campaignId: string,
    reason?: string
  ) {
    this.access.assert(actor, 'campaign:control');
    await this.requireCampaign(actor.orgId, campaignId);
    // Flip the status first: the dispatcher re-checks it before every send, so no new
    // sends start from this moment. Only a send already in flight cannot be recalled.
    const moved = await this.agencyRepo.archiveOrCancel(
      actor.orgId,
      campaignId,
      CANCELLABLE,
      CampaignStatus.CANCELLED
    );
    if (!moved)
      throw new BadRequestException('This campaign can no longer be cancelled');
    const cancelled = await this.publishing.cancelOpenJobs(
      campaignId,
      reason || 'Campaign cancelled'
    );
    await this.agencyRepo.withdrawPendingApprovals(campaignId);
    await this.access.audit(actor, {
      action: 'campaign.cancelled',
      entityType: 'Campaign',
      entityId: campaignId,
      summary: `${cancelled} queued post(s) cancelled${
        reason ? `: ${reason}` : ''
      }`,
    });
    return this.requireCampaign(actor.orgId, campaignId);
  }

  /** Returns an approved/scheduled/failed campaign to DRAFT so it can be edited. This voids the approval. */
  async reopenCampaign(actor: AgencyActor, campaignId: string) {
    this.access.assert(actor, 'campaign:control');
    const campaign = await this.requireCampaign(actor.orgId, campaignId);
    if (!REOPENABLE.includes(campaign.status)) {
      throw new BadRequestException(
        campaign.status === CampaignStatus.PUBLISHING
          ? 'Pause or cancel the campaign before reopening it'
          : `A ${campaign.status} campaign can't be reopened`
      );
    }
    await this.publishing.cancelOpenJobs(
      campaignId,
      'Campaign reopened for editing'
    );
    const moved = await this.agencyRepo.resetToDraft(
      actor.orgId,
      campaignId,
      REOPENABLE
    );
    if (!moved)
      throw new ConflictException('The campaign changed; reload and try again');
    await this.access.audit(actor, {
      action: 'campaign.reopened',
      entityType: 'Campaign',
      entityId: campaignId,
      summary: 'Approval voided',
    });
    return this.requireCampaign(actor.orgId, campaignId);
  }

  async archiveCampaign(actor: AgencyActor, campaignId: string) {
    this.access.assert(actor, 'campaign:control');
    await this.requireCampaign(actor.orgId, campaignId);
    const moved = await this.agencyRepo.archiveOrCancel(
      actor.orgId,
      campaignId,
      ARCHIVABLE,
      CampaignStatus.ARCHIVED
    );
    if (!moved)
      throw new BadRequestException('Only finished campaigns can be archived');
    await this.access.audit(actor, {
      action: 'campaign.archived',
      entityType: 'Campaign',
      entityId: campaignId,
    });
    return this.requireCampaign(actor.orgId, campaignId);
  }

  async retryCampaign(actor: AgencyActor, campaignId: string) {
    this.access.assert(actor, 'campaign:control');
    await this.requireCampaign(actor.orgId, campaignId);
    const result = await this.publishing.retryCampaign(actor, campaignId);
    this.publishing
      .dispatchDue()
      .catch((err) =>
        this.logger.warn(`Immediate dispatch failed: ${err?.message}`)
      );
    return result;
  }

  async resolveUncertainJob(
    actor: AgencyActor,
    jobId: string,
    outcome: 'POSTED' | 'NOT_POSTED',
    note?: string
  ) {
    this.access.assert(actor, 'campaign:control');
    return this.publishing.resolveUncertainJob(actor, jobId, outcome, note);
  }

  /** The publishing queue across all campaigns, for the live queue view. */
  async listJobs(
    actor: AgencyActor,
    filters: { status?: PostingJobStatus; campaignId?: string; limit?: number }
  ) {
    this.access.assert(actor, 'campaign:read');
    if (
      filters.status &&
      !Object.values(PostingJobStatus).includes(filters.status)
    ) {
      throw new BadRequestException(`Unknown job status "${filters.status}"`);
    }
    const [jobs, counts] = await Promise.all([
      this.jobsRepo.listJobs(actor.orgId, filters),
      this.jobsRepo.getOrgJobStats(actor.orgId),
    ]);
    return { counts, jobs };
  }

  async getCampaignJobs(actor: AgencyActor, campaignId: string) {
    this.access.assert(actor, 'campaign:read');
    await this.requireCampaign(actor.orgId, campaignId);
    return this.publishing.getJobs(actor.orgId, campaignId);
  }

  // ==========================================
  // EXECUTIVE DASHBOARD & LOGS
  // ==========================================
  async getDashboard(actor: AgencyActor) {
    this.access.assert(actor, 'dashboard:read');
    const [metrics, system] = await Promise.all([
      this.agencyRepo.getDashboardMetrics(actor.orgId),
      this.publishing.getSystemStatus(),
    ]);
    return { ...metrics, system };
  }

  async getPublishingEvents(actor: AgencyActor, campaignId?: string) {
    this.access.assert(actor, 'campaign:read');
    return this.agencyRepo.getPublishingEvents(actor.orgId, campaignId);
  }

  // ==========================================
  // TRACKING LINKS & CLICK ATTRIBUTION (Module F)
  // ==========================================
  async createTrackingLink(
    actor: AgencyActor,
    campaignId: string,
    params: {
      destinationUrl: string;
      utmSource?: string;
      utmMedium?: string;
      utmCampaign?: string;
    }
  ) {
    this.access.assert(actor, 'campaign:write');
    await this.requireCampaign(actor.orgId, campaignId);
    const destinationUrl = this.assertHttpUrl(params.destinationUrl);
    const shortCode = randomBytes(5).toString('hex');
    return this.agencyRepo.createTrackingLink({
      campaignId,
      shortCode,
      destinationUrl,
      utmSource: params.utmSource,
      utmMedium: params.utmMedium,
      utmCampaign: params.utmCampaign,
    });
  }

  async getCampaignTrackingLinks(actor: AgencyActor, campaignId: string) {
    this.access.assert(actor, 'analytics:read');
    await this.requireCampaign(actor.orgId, campaignId);
    return this.agencyRepo.getCampaignTrackingLinks(campaignId);
  }

  // Link previewers (Telegram, WhatsApp, Slack, Facebook, ...) fetch every link that
  // is posted. Counting them would report clicks no human made.
  private static readonly PREVIEW_BOTS =
    /telegrambot|whatsapp|facebookexternalhit|twitterbot|slackbot|discordbot|linkedinbot|googlebot|bingbot|bot\b|crawler|spider|preview/i;

  /** Public endpoint: resolves a short code and records one anonymous click. */
  async resolveTrackingLinkAndRecordClick(
    shortCode: string,
    clientIp?: string,
    userAgent?: string,
    referer?: string
  ): Promise<string> {
    const link = await this.agencyRepo.getTrackingLinkByCode(shortCode);
    if (!link) {
      throw new NotFoundException(`Tracking link ${shortCode} not found`);
    }
    const target = this.safeRedirectTarget(link);
    if (!target) {
      throw new NotFoundException('Tracking link has an invalid destination');
    }
    const isPreviewBot =
      !!userAgent && AgencyService.PREVIEW_BOTS.test(userAgent);
    if (!isPreviewBot) {
      // Salted hash: counts unique visitors without storing a raw IP.
      const salt = process.env.JWT_SECRET || 'agencyos';
      const ipHash = clientIp
        ? createHash('sha256')
            .update(`${salt}:${clientIp}`)
            .digest('hex')
            .substring(0, 16)
        : undefined;
      this.agencyRepo
        .recordLinkClick({
          trackingLinkId: link.id,
          ipHash,
          userAgent: userAgent?.substring(0, 255),
          referer: referer?.substring(0, 255),
        })
        .catch((err) =>
          this.logger.error(`Failed to log link click: ${err?.message}`)
        );
    }
    return target;
  }

  private safeRedirectTarget(link: {
    destinationUrl: string;
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
  }): string | null {
    try {
      const url = new URL(link.destinationUrl);
      // Redirecting to javascript:/data: URLs would turn this endpoint into an XSS vector.
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      if (link.utmSource && !url.searchParams.has('utm_source'))
        url.searchParams.set('utm_source', link.utmSource);
      if (link.utmMedium && !url.searchParams.has('utm_medium'))
        url.searchParams.set('utm_medium', link.utmMedium);
      if (link.utmCampaign && !url.searchParams.has('utm_campaign'))
        url.searchParams.set('utm_campaign', link.utmCampaign);
      return url.toString();
    } catch {
      return null;
    }
  }

  // ==========================================
  // CLIENT REPORTING & CSV EXPORT (Module K)
  // ==========================================
  async generateCampaignCsvReport(
    actor: AgencyActor,
    campaignId: string
  ): Promise<string> {
    this.access.assert(actor, 'analytics:read');
    const campaign = await this.requireCampaign(actor.orgId, campaignId);
    const jobs = await this.publishing.getJobs(actor.orgId, campaignId);
    const links = await this.agencyRepo.getCampaignTrackingLinks(campaignId);

    const count = (s: PostingJobStatus) =>
      jobs.filter((j) => j.status === s).length;
    const totalClicks = links.reduce((sum, l) => sum + (l.totalClicks || 0), 0);
    const row = (...cells: Array<string | number | null | undefined>) =>
      cells.map((c) => this.csvCell(c)).join(',');

    const lines: string[] = [
      row('AgencyOS Campaign Delivery & Performance Report'),
      row('Campaign ID', campaign.id),
      row('Campaign Name', campaign.name),
      row('Client', campaign.customer?.companyName || campaign.customer?.name),
      row('Status', campaign.status),
      row('Start Date', campaign.startDate?.toISOString()),
      row('End Date', campaign.endDate?.toISOString()),
      row('Budget', campaign.budget ? `${campaign.budget} USD` : ''),
      row('Total Destinations', campaign.destinations.length),
      row('Delivered', count(PostingJobStatus.SUCCEEDED)),
      row(
        'Failed',
        count(PostingJobStatus.DEAD) + count(PostingJobStatus.UNCERTAIN)
      ),
      row('Paused / blocked', count(PostingJobStatus.BLOCKED)),
      row(
        'Queued',
        count(PostingJobStatus.PENDING) + count(PostingJobStatus.SENDING)
      ),
      row('Tracked link clicks', totalClicks),
      '',
      row('Delivery receipts'),
      row(
        'Job ID',
        'Destination',
        'Status',
        'Attempts',
        'Message ID',
        'Link',
        'Completed At',
        'Last error'
      ),
      ...jobs.map((j) =>
        row(
          j.id,
          j.telegramDestination?.title || j.integration?.name || 'Unknown',
          j.status,
          j.attempts,
          j.externalMessageId,
          j.releaseUrl,
          j.completedAt?.toISOString(),
          j.lastError
        )
      ),
    ];
    if (links.length > 0) {
      lines.push(
        '',
        row('Tracking links'),
        row(
          'Short code',
          'Destination URL',
          'UTM source',
          'UTM medium',
          'UTM campaign',
          'Clicks'
        )
      );
      for (const l of links) {
        lines.push(
          row(
            l.shortCode,
            l.destinationUrl,
            l.utmSource,
            l.utmMedium,
            l.utmCampaign,
            l.totalClicks
          )
        );
      }
    }
    return lines.join('\n');
  }

  /** RFC 4180 quoting plus neutralising spreadsheet formula injection (=, +, -, @). */
  private csvCell(value: string | number | null | undefined): string {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  // ==========================================
  // AGENCY BILLING & INVOICES (Module M)
  // ==========================================
  async createInvoice(
    actor: AgencyActor,
    params: {
      customerId: string;
      amount: number;
      currency?: string;
      dueDate?: Date;
      items?: string;
      notes?: string;
    }
  ) {
    this.access.assert(actor, 'billing:write');
    if (!(params.amount > 0))
      throw new BadRequestException('Invoice amount must be greater than zero');
    if (params.currency && !/^[A-Za-z]{3}$/.test(params.currency)) {
      throw new BadRequestException('Currency must be a 3-letter code');
    }
    await this.requireClient(actor.orgId, params.customerId);

    const year = new Date().getUTCFullYear();
    const prefix = `INV-${year}-`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.agencyRepo.getLastInvoiceNumber(
        actor.orgId,
        prefix
      );
      const next =
        (last ? Number.parseInt(last.slice(prefix.length), 10) : 0) + 1;
      try {
        const invoice = await this.agencyRepo.createAgencyInvoice(actor.orgId, {
          customerId: params.customerId,
          invoiceNumber: `${prefix}${String(next).padStart(4, '0')}`,
          amount: params.amount,
          currency: params.currency?.toUpperCase(),
          dueDate: params.dueDate,
          items: params.items,
          notes: params.notes,
        });
        await this.access.audit(actor, {
          action: 'invoice.created',
          entityType: 'AgencyInvoice',
          entityId: invoice.id,
          summary: invoice.invoiceNumber,
        });
        return invoice;
      } catch (err: any) {
        if (err?.code !== 'P2002') throw err; // only a number collision is retried
      }
    }
    throw new ConflictException(
      'Could not allocate an invoice number; try again'
    );
  }

  async getInvoices(actor: AgencyActor, status?: string) {
    this.access.assert(actor, 'billing:read');
    return this.agencyRepo.getAgencyInvoices(actor.orgId, status);
  }

  async markInvoicePaid(actor: AgencyActor, invoiceId: string) {
    this.access.assert(actor, 'billing:write');
    const invoices = await this.agencyRepo.getAgencyInvoices(actor.orgId);
    const invoice = invoices.find((i) => i.id === invoiceId);
    if (!invoice) throw new NotFoundException(`Invoice ${invoiceId} not found`);
    if (invoice.status === 'PAID') return invoice;
    const paid = await this.agencyRepo.updateAgencyInvoiceStatus(
      actor.orgId,
      invoiceId,
      'PAID',
      new Date()
    );
    await this.access.audit(actor, {
      action: 'invoice.paid',
      entityType: 'AgencyInvoice',
      entityId: invoiceId,
      summary: invoice.invoiceNumber,
    });
    return paid;
  }

  // ==========================================
  // VALIDATION HELPERS
  // ==========================================
  private async requireClient(orgId: string, id: string) {
    const client = await this.agencyRepo.getClientById(orgId, id);
    if (!client) throw new NotFoundException(`Client with ID ${id} not found`);
    return client;
  }

  private async requireCampaign(orgId: string, id: string) {
    const campaign = await this.agencyRepo.getCampaignById(orgId, id);
    if (!campaign)
      throw new NotFoundException(`Campaign with ID ${id} not found`);
    return campaign;
  }

  private async assertAssignable(orgId: string, userId?: string) {
    if (userId && !(await this.agencyRepo.isActiveOrgMember(orgId, userId))) {
      throw new BadRequestException(
        'The assigned salesperson is not a member of this workspace'
      );
    }
  }

  /**
   * Every destination must belong to the caller's organization. Without this, a
   * campaign could be pointed at another tenant's Telegram chat or social account.
   */
  private async assertDestinationRefs(
    orgId: string,
    destinations: DestinationInput[]
  ) {
    const tgIds = destinations
      .filter((d) => d.destinationType === 'TELEGRAM')
      .map((d) => d.telegramDestinationId);
    const socialIds = destinations
      .filter((d) => d.destinationType === 'SOCIAL')
      .map((d) => d.integrationId);
    if (tgIds.some((id) => !id))
      throw new BadRequestException(
        'Telegram destinations need a telegramDestinationId'
      );
    if (socialIds.some((id) => !id))
      throw new BadRequestException(
        'Social destinations need an integrationId'
      );
    const uniqueTg = [...new Set(tgIds as string[])];
    const uniqueSocial = [...new Set(socialIds as string[])];
    if (
      uniqueTg.length !== tgIds.length ||
      uniqueSocial.length !== socialIds.length
    ) {
      throw new BadRequestException(
        'A destination can only be added to a campaign once'
      );
    }
    if (uniqueTg.length) {
      const found = await this.agencyRepo.getTelegramDestinationsByIds(
        orgId,
        uniqueTg
      );
      if (found.length !== uniqueTg.length)
        throw new NotFoundException(
          'One or more Telegram destinations were not found'
        );
    }
    if (uniqueSocial.length) {
      const found = await this.agencyRepo.getIntegrationsByIds(
        orgId,
        uniqueSocial
      );
      if (found.length !== uniqueSocial.length)
        throw new NotFoundException(
          'One or more social accounts were not found'
        );
    }
  }

  private assertDates(start?: Date | null, end?: Date | null) {
    if (start && end && end <= start) {
      throw new BadRequestException('End date must be after the start date');
    }
  }

  private assertTimezone(tz?: string) {
    if (!tz) return;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      throw new BadRequestException(`Unknown time zone "${tz}"`);
    }
  }

  private assertHttpUrl(value: string): string {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:')
        return url.toString();
    } catch {
      // handled below
    }
    throw new BadRequestException(
      'Destination URL must be a valid http(s) link'
    );
  }
}
