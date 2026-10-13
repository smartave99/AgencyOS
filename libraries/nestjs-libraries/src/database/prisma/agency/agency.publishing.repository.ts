import { Injectable } from '@nestjs/common';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { CampaignStatus, Prisma, PostingJobStatus } from '@prisma/client';

export interface NewPostingJob {
  orgId: string;
  campaignId: string;
  campaignDestinationId: string | null;
  telegramDestinationId: string | null;
  integrationId: string | null;
  destinationType: string;
  idempotencyKey: string;
  scheduledFor: Date;
  contentHash: string;
  maxAttempts: number;
  variantLabel?: string | null;
  occurrence?: number;
}

const OPEN_JOB_STATUSES: PostingJobStatus[] = [
  PostingJobStatus.PENDING,
  PostingJobStatus.BLOCKED,
];

/** A report's daily chart reads at most this many jobs; beyond it the chart says so. */
export const REPORT_SERIES_CAP = 50000;

@Injectable()
export class AgencyPublishingRepository {
  constructor(private prisma: PrismaService) {}

  // ==========================================
  // JOB CREATION (idempotent through the unique idempotencyKey)
  // ==========================================
  async createJobsIfAbsent(jobs: NewPostingJob[]): Promise<number> {
    if (jobs.length === 0) return 0;
    const res = await this.prisma.postingJob.createMany({
      data: jobs.map((j) => ({
        ...j,
        nextAttemptAt: j.scheduledFor,
        status: PostingJobStatus.PENDING,
      })),
      skipDuplicates: true,
    });
    return res.count;
  }

  async getJobsForCampaign(orgId: string, campaignId: string) {
    return this.prisma.postingJob.findMany({
      where: { orgId, campaignId },
      include: {
        telegramDestination: {
          select: {
            id: true,
            title: true,
            type: true,
            authorizationStatus: true,
          },
        },
        integration: {
          select: { id: true, name: true, providerIdentifier: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getJobStatusCounts(campaignId: string) {
    const rows = await this.prisma.postingJob.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: { status: true },
    });
    const counts = {} as Record<PostingJobStatus, number>;
    for (const s of Object.values(PostingJobStatus)) counts[s] = 0;
    for (const r of rows) counts[r.status] = r._count.status;
    return counts;
  }

  // ==========================================
  // DISPATCH
  // ==========================================
  async findDueJobs(now: Date, limit: number) {
    return this.prisma.postingJob.findMany({
      where: {
        status: PostingJobStatus.PENDING,
        nextAttemptAt: { lte: now },
        campaign: {
          deletedAt: null,
          status: { in: [CampaignStatus.SCHEDULED, CampaignStatus.PUBLISHING] },
        },
      },
      select: { id: true },
      orderBy: { nextAttemptAt: 'asc' },
      take: limit,
    });
  }

  /** Atomically takes the job. Only one worker can ever observe count === 1. */
  async claimJob(id: string, now: Date, leaseUntil: Date, workerId: string) {
    const res = await this.prisma.postingJob.updateMany({
      where: {
        id,
        status: PostingJobStatus.PENDING,
        nextAttemptAt: { lte: now },
      },
      data: {
        status: PostingJobStatus.SENDING,
        lockedUntil: leaseUntil,
        lockedBy: workerId,
        attempts: { increment: 1 },
      },
    });
    return res.count === 1;
  }

  async getJobForExecution(id: string) {
    return this.prisma.postingJob.findUnique({
      where: { id },
      include: {
        campaign: {
          select: {
            id: true,
            orgId: true,
            name: true,
            status: true,
            deletedAt: true,
            endDate: true,
            revision: true,
            contentTitle: true,
            contentBody: true,
            contentMedia: true,
            ctaLink: true,
            ctaText: true,
            telegramChannelLink: true,
            approvedContentHash: true,
            postingWindows: true,
            timezone: true,
            variants: {
              select: {
                label: true,
                contentTitle: true,
                contentBody: true,
                contentMedia: true,
                ctaLink: true,
                ctaText: true,
              },
              orderBy: { label: 'asc' },
            },
          },
        },
        telegramDestination: true,
        integration: {
          select: { id: true, disabled: true, refreshNeeded: true },
        },
      },
    });
  }

  private async finish(
    id: string,
    from: PostingJobStatus,
    data: Prisma.PostingJobUpdateManyMutationInput
  ) {
    const res = await this.prisma.postingJob.updateMany({
      where: { id, status: from },
      data: { lockedUntil: null, lockedBy: null, ...data },
    });
    return res.count === 1;
  }

  markSucceeded(
    id: string,
    result: {
      externalMessageId: string;
      releaseUrl?: string;
      receipt: Prisma.InputJsonValue;
    }
  ) {
    return this.finish(id, PostingJobStatus.SENDING, {
      status: PostingJobStatus.SUCCEEDED,
      externalMessageId: result.externalMessageId,
      releaseUrl: result.releaseUrl,
      receipt: result.receipt,
      lastError: null,
      lastErrorCode: null,
      completedAt: new Date(),
    });
  }

  releaseForRetry(
    id: string,
    nextAttemptAt: Date,
    code: string,
    message: string
  ) {
    return this.finish(id, PostingJobStatus.SENDING, {
      status: PostingJobStatus.PENDING,
      nextAttemptAt,
      lastError: message.slice(0, 500),
      lastErrorCode: code,
    });
  }

  /** Not a failure: the job waits for its posting window, so the attempt is refunded. */
  async deferWithoutAttempt(id: string, nextAttemptAt: Date, note: string) {
    const res = await this.prisma.postingJob.updateMany({
      where: { id, status: PostingJobStatus.SENDING },
      data: {
        status: PostingJobStatus.PENDING,
        nextAttemptAt,
        attempts: { decrement: 1 },
        lockedUntil: null,
        lockedBy: null,
        lastError: note,
        lastErrorCode: 'DEFERRED',
      },
    });
    return res.count === 1;
  }

  markTerminal(
    id: string,
    status: 'BLOCKED' | 'DEAD' | 'UNCERTAIN' | 'CANCELLED',
    code: string,
    message: string,
    receipt?: Prisma.InputJsonValue
  ) {
    return this.finish(id, PostingJobStatus.SENDING, {
      status: PostingJobStatus[status],
      lastError: message.slice(0, 500),
      lastErrorCode: code,
      ...(receipt !== undefined ? { receipt } : {}),
      ...(status === 'BLOCKED' ? {} : { completedAt: new Date() }),
    });
  }

  /** Jobs whose worker vanished mid-send: the real outcome is unknown. */
  async expireStaleLeases(now: Date) {
    const stale = await this.prisma.postingJob.findMany({
      where: { status: PostingJobStatus.SENDING, lockedUntil: { lt: now } },
      select: { id: true, orgId: true, campaignId: true },
    });
    const flipped: typeof stale = [];
    for (const job of stale) {
      const res = await this.prisma.postingJob.updateMany({
        where: {
          id: job.id,
          status: PostingJobStatus.SENDING,
          lockedUntil: { lt: now },
        },
        data: {
          status: PostingJobStatus.UNCERTAIN,
          lockedUntil: null,
          lockedBy: null,
          completedAt: now,
          lastErrorCode: 'LEASE_EXPIRED',
          lastError:
            'Worker stopped while sending; the ad may or may not have been posted. Check the destination before retrying.',
        },
      });
      if (res.count === 1) flipped.push(job);
    }
    return flipped;
  }

  // ==========================================
  // BULK TRANSITIONS
  // ==========================================
  async blockPendingJobsForDestination(
    telegramDestinationId: string,
    code: string,
    message: string
  ) {
    const affected = await this.prisma.postingJob.findMany({
      where: { telegramDestinationId, status: PostingJobStatus.PENDING },
      select: { id: true, campaignId: true, orgId: true },
    });
    if (affected.length === 0) return [];
    await this.prisma.postingJob.updateMany({
      where: {
        id: { in: affected.map((a) => a.id) },
        status: PostingJobStatus.PENDING,
      },
      data: {
        status: PostingJobStatus.BLOCKED,
        lastErrorCode: code,
        lastError: message.slice(0, 500),
      },
    });
    return affected;
  }

  async unblockJobsForDestination(telegramDestinationId: string) {
    const affected = await this.prisma.postingJob.findMany({
      where: { telegramDestinationId, status: PostingJobStatus.BLOCKED },
      select: { id: true, campaignId: true },
    });
    if (affected.length === 0) return [];
    await this.prisma.postingJob.updateMany({
      where: {
        id: { in: affected.map((a) => a.id) },
        status: PostingJobStatus.BLOCKED,
      },
      data: {
        status: PostingJobStatus.PENDING,
        nextAttemptAt: new Date(),
        lastError: null,
        lastErrorCode: null,
      },
    });
    return affected;
  }

  async unblockJobsForCampaign(campaignId: string) {
    const res = await this.prisma.postingJob.updateMany({
      where: { campaignId, status: PostingJobStatus.BLOCKED },
      data: {
        status: PostingJobStatus.PENDING,
        nextAttemptAt: new Date(),
        lastError: null,
        lastErrorCode: null,
      },
    });
    return res.count;
  }

  /** Re-queues dead jobs for an explicit operator retry with a fresh attempt budget. */
  async requeueDeadJobsForCampaign(campaignId: string) {
    const res = await this.prisma.postingJob.updateMany({
      where: { campaignId, status: PostingJobStatus.DEAD },
      data: {
        status: PostingJobStatus.PENDING,
        attempts: 0,
        nextAttemptAt: new Date(),
        completedAt: null,
        lastError: null,
        lastErrorCode: null,
      },
    });
    return res.count;
  }

  /** Human-confirmed resolution of a job whose outcome was unknown. */
  async markManuallyResolved(
    id: string,
    status: 'SUCCEEDED' | 'PENDING',
    note?: string
  ) {
    const res = await this.prisma.postingJob.updateMany({
      where: { id, status: PostingJobStatus.UNCERTAIN },
      data: {
        status: PostingJobStatus[status],
        lastErrorCode: 'MANUAL',
        lastError: note
          ? `Resolved manually: ${note}`.slice(0, 500)
          : 'Resolved manually',
        ...(status === 'SUCCEEDED'
          ? { completedAt: new Date() }
          : { completedAt: null, attempts: 0, nextAttemptAt: new Date() }),
      },
    });
    return res.count === 1;
  }

  async rescheduleOpenJobs(campaignId: string, at: Date) {
    const res = await this.prisma.postingJob.updateMany({
      where: { campaignId, status: PostingJobStatus.PENDING },
      data: { scheduledFor: at, nextAttemptAt: at },
    });
    return res.count;
  }

  async cancelOpenJobsForCampaign(
    campaignId: string,
    code: string,
    message: string
  ) {
    const res = await this.prisma.postingJob.updateMany({
      where: { campaignId, status: { in: OPEN_JOB_STATUSES } },
      data: {
        status: PostingJobStatus.CANCELLED,
        completedAt: new Date(),
        lastErrorCode: code,
        lastError: message,
      },
    });
    return res.count;
  }

  // ==========================================
  // CAMPAIGN STATE (guarded writes)
  // ==========================================
  async transitionCampaign(
    orgId: string,
    campaignId: string,
    from: CampaignStatus[],
    data: Prisma.CampaignUpdateManyMutationInput
  ) {
    const res = await this.prisma.campaign.updateMany({
      where: { id: campaignId, orgId, status: { in: from } },
      data,
    });
    return res.count === 1;
  }

  async getCampaignStatus(campaignId: string) {
    return this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        orgId: true,
        status: true,
        name: true,
        requiresAttention: true,
      },
    });
  }

  // ==========================================
  // DESTINATION PACING INPUTS
  // ==========================================
  /** Completion times of recent successful posts, newest first (for pacing rules). */
  async getRecentSuccessTimes(telegramDestinationId: string, since: Date) {
    const rows = await this.prisma.postingJob.findMany({
      where: {
        telegramDestinationId,
        status: PostingJobStatus.SUCCEEDED,
        completedAt: { gte: since },
      },
      select: { completedAt: true },
      orderBy: { completedAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => r.completedAt!).filter(Boolean);
  }

  async getLastSucceededAt(telegramDestinationId: string) {
    const last = await this.prisma.postingJob.findFirst({
      where: { telegramDestinationId, status: PostingJobStatus.SUCCEEDED },
      orderBy: { completedAt: 'desc' },
      select: { completedAt: true },
    });
    return last?.completedAt ?? null;
  }

  // ==========================================
  // REPORTING
  // ==========================================
  async getOrgJobStats(orgId: string) {
    const rows = await this.prisma.postingJob.groupBy({
      by: ['status'],
      where: { orgId, campaign: { deletedAt: null } },
      _count: { status: true },
    });
    const counts = {} as Record<PostingJobStatus, number>;
    for (const s of Object.values(PostingJobStatus)) counts[s] = 0;
    for (const r of rows) counts[r.status] = r._count.status;
    return counts;
  }

  /**
   * Everything a publishing report needs, straight from stored send results. Jobs are
   * selected by the day they were due (`scheduledFor`), counts are exact (grouped in the
   * database), and nothing here is estimated.
   */
  async getReportData(
    orgId: string,
    range: { from: Date; to: Date },
    customerId?: string
  ) {
    const campaign = {
      deletedAt: null,
      ...(customerId ? { customerId } : {}),
    };
    const where = {
      orgId,
      scheduledFor: { gte: range.from, lt: range.to },
      campaign,
    };
    const [
      byCampaign,
      byDestination,
      lastByCampaign,
      lastByDestination,
      series,
      byVariant,
    ] = await Promise.all([
      this.prisma.postingJob.groupBy({
        by: ['campaignId', 'status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.postingJob.groupBy({
        by: ['telegramDestinationId', 'status'],
        where: { ...where, telegramDestinationId: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.postingJob.groupBy({
        by: ['campaignId'],
        where: { ...where, status: PostingJobStatus.SUCCEEDED },
        _max: { completedAt: true },
      }),
      this.prisma.postingJob.groupBy({
        by: ['telegramDestinationId'],
        where: {
          ...where,
          status: PostingJobStatus.SUCCEEDED,
          telegramDestinationId: { not: null },
        },
        _max: { completedAt: true },
      }),
      this.prisma.postingJob.findMany({
        where,
        select: { scheduledFor: true, status: true },
        orderBy: { scheduledFor: 'asc' },
        take: REPORT_SERIES_CAP + 1,
      }),
      this.prisma.postingJob.groupBy({
        by: ['campaignId', 'variantLabel', 'status'],
        where,
        _count: { _all: true },
      }),
    ]);

    const campaignIds = [...new Set(byCampaign.map((r) => r.campaignId))];
    const destinationIds = [
      ...new Set(
        byDestination
          .map((r) => r.telegramDestinationId)
          .filter((id): id is string => !!id)
      ),
    ];
    const [campaigns, destinations, links] = await Promise.all([
      this.prisma.campaign.findMany({
        where: { id: { in: campaignIds }, orgId },
        select: {
          id: true,
          name: true,
          status: true,
          customer: { select: { id: true, name: true, companyName: true } },
        },
      }),
      this.prisma.telegramDestination.findMany({
        where: { id: { in: destinationIds }, orgId },
        select: { id: true, title: true },
      }),
      this.prisma.trackingLink.findMany({
        where: { campaign: { orgId, ...campaign } },
        select: {
          campaignId: true,
          _count: {
            select: {
              clicks: {
                where: { clickedAt: { gte: range.from, lt: range.to } },
              },
            },
          },
        },
      }),
    ]);

    return {
      byCampaign,
      byDestination,
      byVariant,
      lastByCampaign,
      lastByDestination,
      series: series.slice(0, REPORT_SERIES_CAP),
      seriesTruncated: series.length > REPORT_SERIES_CAP,
      campaigns,
      destinations,
      links,
    };
  }

  /** What a send through a user account needs to know about the community behind its destination. */
  async getCommunityForSend(id: string) {
    return this.prisma.community.findUnique({
      where: { id },
      select: {
        id: true,
        stage: true,
        adReview: true,
        username: true,
        title: true,
        operatingAccountId: true,
      },
    });
  }

  /** Telegram refused the account here: the community stops being a place to post until a person reopens it. */
  async blockCommunity(orgId: string, id: string, reason: string) {
    const community = await this.prisma.community.findFirst({
      where: { id, orgId },
      select: { stage: true },
    });
    if (!community || community.stage === 'BLOCKED') return;
    await this.prisma.community.updateMany({
      where: { id, orgId },
      data: { stage: 'BLOCKED', stageReason: reason.slice(0, 300) },
    });
    await this.prisma.communityHistory.create({
      data: {
        orgId,
        communityId: id,
        kind: 'STAGE',
        summary: reason.slice(0, 500),
        fromStage: community.stage,
        toStage: 'BLOCKED',
      },
    });
  }

  async listJobs(
    orgId: string,
    filters: { campaignId?: string; status?: PostingJobStatus; limit?: number }
  ) {
    return this.prisma.postingJob.findMany({
      where: {
        orgId,
        ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      include: {
        campaign: { select: { id: true, name: true } },
        telegramDestination: { select: { id: true, title: true, type: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.limit ?? 100, 300),
    });
  }

  // ==========================================
  // LEADER LEASE (so only one process polls Telegram updates)
  // ==========================================
  async acquireLease(
    name: string,
    holder: string,
    ttlMs: number
  ): Promise<boolean> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + ttlMs);
    const renewed = await this.prisma.leaderLease.updateMany({
      where: { name, OR: [{ holder }, { leaseUntil: { lt: now } }] },
      data: { holder, leaseUntil },
    });
    if (renewed.count === 1) return true;
    try {
      await this.prisma.leaderLease.create({
        data: { name, holder, leaseUntil },
      });
      return true;
    } catch {
      // Someone else created or still holds the lease.
      return false;
    }
  }

  /** How many posts each bot delivered to a chat since `since`, for sharing the load fairly. */
  async countSendsByBot(destinationId: string, since: Date) {
    const rows = await this.prisma.postingJob.findMany({
      where: {
        telegramDestinationId: destinationId,
        status: PostingJobStatus.SUCCEEDED,
        completedAt: { gte: since },
      },
      select: { receipt: true },
    });
    const counts = new Map<string, number>();
    for (const { receipt } of rows) {
      const key = (receipt as { bot?: { key?: string } } | null)?.bot?.key;
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  /** Liveness signal: any process may renew it; "online" means the lease has not lapsed. */
  async recordHeartbeat(name: string, holder: string, ttlMs: number) {
    const leaseUntil = new Date(Date.now() + ttlMs);
    await this.prisma.leaderLease.upsert({
      where: { name },
      create: { name, holder, leaseUntil },
      update: { holder, leaseUntil },
    });
  }

  async getHeartbeat(name: string) {
    const row = await this.prisma.leaderLease.findUnique({ where: { name } });
    return row
      ? {
          online: row.leaseUntil > new Date(),
          lastSeenAt: row.updatedAt,
          holder: row.holder,
        }
      : { online: false, lastSeenAt: null, holder: null };
  }
}
