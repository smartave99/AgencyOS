import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { hostname } from 'os';
import {
  CampaignStatus,
  DestinationAuthStatus,
  PostingJobStatus,
  Prisma,
} from '@prisma/client';
import { AgencyRepository } from './agency.repository';
import {
  AgencyPublishingRepository,
  NewPostingJob,
} from './agency.publishing.repository';
import { AgencyAccessService, AgencyActor } from './agency.access.service';
import {
  AgencyTelegramBotsService,
  BotHandle,
  BotPick,
} from './agency.telegram.bots.service';
import {
  AgencyTelegramUsersService,
  TelegramAccountUnusableException,
} from './agency.telegram.users.service';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import {
  TelegramUserGateway,
  TelegramUserGatewayError,
} from '@gitroom/nestjs-libraries/integrations/telegram/telegram.user.gateway';
import {
  CAPTION_LIMIT,
  MESSAGE_LIMIT,
  TelegramAd,
  TelegramGateway,
  TelegramGatewayError,
} from '@gitroom/nestjs-libraries/integrations/telegram/telegram.gateway';

/** One extra version of an ad ("B", "C", "D"); the campaign's own content is "A". */
export interface VariantFields {
  label: string;
  contentTitle: string | null;
  contentBody: string;
  contentMedia: string | null;
  ctaLink: string | null;
  ctaText: string | null;
}

interface CampaignForJobs {
  id: string;
  orgId: string;
  revision: number;
  startDate: Date | null;
  endDate: Date | null;
  contentTitle: string | null;
  contentBody: string;
  contentMedia: string | null;
  ctaLink: string | null;
  ctaText: string | null;
  telegramChannelLink: string | null;
  approvedContentHash: string | null;
  scheduleKind?: string;
  intervalMinutes?: number | null;
  occurrences?: number | null;
  variants?: VariantFields[];
  destinations: Array<{
    id: string;
    destinationType: string;
    telegramDestinationId: string | null;
    integrationId: string | null;
    scheduledAt: Date | null;
    telegramDestination?: {
      id: string;
      title: string;
      authorizationStatus: DestinationAuthStatus;
      consentExpiresAt: Date | null;
      canPostMessages: boolean;
    } | null;
  }>;
}

interface PostingWindow {
  days?: number[];
  start: string;
  end: string;
}

interface FrequencyRules {
  maxPerDay?: number;
  minIntervalMinutes?: number;
}

const ACTIVE_CAMPAIGN_STATES: CampaignStatus[] = [
  CampaignStatus.SCHEDULED,
  CampaignStatus.PUBLISHING,
];
const RECONCILABLE_STATES: CampaignStatus[] = [
  CampaignStatus.SCHEDULED,
  CampaignStatus.PUBLISHING,
  CampaignStatus.PARTIALLY_FAILED,
  CampaignStatus.FAILED,
];

const envInt = (name: string, fallback: number) => {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

@Injectable()
export class AgencyPublishingService {
  private readonly logger = new Logger(AgencyPublishingService.name);
  private readonly workerId = `${hostname()}:${process.pid}:${randomBytes(
    3
  ).toString('hex')}`;

  constructor(
    private readonly agencyRepo: AgencyRepository,
    private readonly jobs: AgencyPublishingRepository,
    private readonly gateway: TelegramGateway,
    private readonly access: AgencyAccessService,
    private readonly notifications: NotificationService,
    private readonly bots: AgencyTelegramBotsService,
    private readonly users: AgencyTelegramUsersService,
    private readonly userGateway: TelegramUserGateway
  ) {}

  private get leaseMs() {
    return envInt('AGENCY_JOB_LEASE_SECONDS', 120) * 1000;
  }
  private get maxAttempts() {
    return Math.max(1, envInt('AGENCY_JOB_MAX_ATTEMPTS', 5));
  }
  private get backoffSeconds() {
    return Math.max(1, envInt('AGENCY_JOB_BACKOFF_SECONDS', 60));
  }
  private get sendDelayMs() {
    return envInt('AGENCY_SEND_DELAY_MS', 1100);
  }

  // ==========================================
  // SYSTEM STATUS (what the dashboard may truthfully claim)
  // ==========================================
  static readonly DISPATCHER_HEARTBEAT = 'agency-dispatcher';

  /** Called by the scheduler loop on every pass, even when idle. */
  async heartbeat(intervalMs: number) {
    await this.jobs.recordHeartbeat(
      AgencyPublishingService.DISPATCHER_HEARTBEAT,
      this.workerId,
      Math.max(intervalMs * 3, 45_000)
    );
  }

  async getSystemStatus() {
    const connection = await this.bots.connection();
    const [dispatcher, pollers] = await Promise.all([
      this.jobs.getHeartbeat(AgencyPublishingService.DISPATCHER_HEARTBEAT),
      Promise.all(
        connection.handles.map((bot) =>
          this.jobs.getHeartbeat(AgencyTelegramBotsService.leaseName(bot))
        )
      ),
    ]);
    const webhook = !!(
      process.env.AGENCY_TELEGRAM_WEBHOOK_URL &&
      process.env.AGENCY_TELEGRAM_WEBHOOK_SECRET
    );
    // Online only counts for the bots that should be listening; one that is not is not hidden by another.
    const polling = pollers.length > 0 && pollers.every((p) => p.online);
    return {
      dispatcher: {
        online: dispatcher.online,
        lastSeenAt: dispatcher.lastSeenAt,
      },
      telegram: {
        configured: connection.configured,
        bots: connection.count,
        // Whether a chat admin's /authorize can actually reach us right now.
        listening: connection.configured && (webhook || polling),
        updates: webhook ? 'webhook' : polling ? 'polling' : 'off',
      },
    };
  }

  // ==========================================
  // CONTENT INTEGRITY
  // ==========================================
  /**
   * Fingerprint of everything a reviewer approves. Captured at approval and re-checked
   * at send time, so content edited after approval can never be published unreviewed.
   */
  computeContentHash(c: {
    contentTitle: string | null;
    contentBody: string;
    contentMedia: string | null;
    ctaLink: string | null;
    ctaText: string | null;
    telegramChannelLink: string | null;
    variants?: VariantFields[];
  }): string {
    const parts: unknown[] = [
      c.contentTitle ?? '',
      c.contentBody,
      c.contentMedia ?? '',
      c.ctaLink ?? '',
      c.ctaText ?? '',
      c.telegramChannelLink ?? '',
    ];
    // Every extra version is part of what a reviewer approves. A campaign without any hashes exactly
    // as it always did, so earlier approvals stay valid.
    if (c.variants?.length) {
      parts.push(
        [...c.variants]
          .sort((a, b) => a.label.localeCompare(b.label))
          .map((v) => [
            v.label,
            v.contentTitle ?? '',
            v.contentBody,
            v.contentMedia ?? '',
            v.ctaLink ?? '',
            v.ctaText ?? '',
          ])
      );
    }
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }

  /** The content one post carries: the campaign's own ("A"), or the extra version its job was given. */
  contentFor(
    c: {
      contentTitle: string | null;
      contentBody: string;
      contentMedia: string | null;
      ctaLink: string | null;
      ctaText: string | null;
      telegramChannelLink: string | null;
      variants?: VariantFields[];
    },
    label?: string | null
  ) {
    const variant = label ? c.variants?.find((v) => v.label === label) : null;
    return variant
      ? {
          contentTitle: variant.contentTitle,
          contentBody: variant.contentBody,
          contentMedia: variant.contentMedia,
          ctaLink: variant.ctaLink,
          ctaText: variant.ctaText,
          telegramChannelLink: c.telegramChannelLink,
        }
      : c;
  }

  buildAd(c: {
    contentTitle: string | null;
    contentBody: string;
    contentMedia: string | null;
    ctaLink: string | null;
    ctaText: string | null;
    telegramChannelLink: string | null;
  }): TelegramAd {
    let media: string[] = [];
    if (c.contentMedia) {
      try {
        const parsed = JSON.parse(c.contentMedia);
        media = Array.isArray(parsed)
          ? parsed
              .map((m) => (typeof m === 'string' ? m : m?.path || m?.url))
              .filter(Boolean)
          : [String(parsed)];
      } catch {
        media = [c.contentMedia];
      }
    }
    return {
      title: c.contentTitle,
      body: c.contentBody,
      ctaText: c.ctaText,
      ctaLink: c.ctaLink,
      channelLink: c.telegramChannelLink,
      media,
    };
  }

  /**
   * Exactly what Telegram would receive for this content, plus anything that would stop
   * it, so the composer's preview can never drift from what is actually sent.
   */
  previewAd(ad: TelegramAd) {
    const html = this.gateway.renderAdHtml(ad);
    const visibleLength = this.gateway.visibleLength(html);
    const media = ad.media?.length ?? 0;
    let problem: string | null = null;
    try {
      this.gateway.validateAd(ad);
    } catch (err: any) {
      problem = err?.message ?? 'This content cannot be sent to Telegram';
    }
    const format =
      media === 0
        ? 'TEXT'
        : media === 1
        ? visibleLength <= CAPTION_LIMIT
          ? 'MEDIA_WITH_CAPTION'
          : 'MEDIA_THEN_TEXT'
        : visibleLength <= CAPTION_LIMIT
        ? 'ALBUM_WITH_CAPTION'
        : 'ALBUM_THEN_TEXT';
    return {
      html,
      visibleLength,
      format,
      limits: { message: MESSAGE_LIMIT, caption: CAPTION_LIMIT },
      problem: ad.body?.trim() ? problem : null,
    };
  }

  // ==========================================
  // PRE-FLIGHT VALIDATION (fail early, with reasons a human can act on)
  // ==========================================
  /** Review-time check: is this something a reviewer can meaningfully approve? */
  assertReadyForReview(campaign: CampaignForJobs): void {
    this.throwIfProblems(this.collectProblems(campaign, false));
  }

  /** Publish-time check: approved, unchanged, and every destination currently authorized. */
  validateForPublishing(campaign: CampaignForJobs): void {
    this.throwIfProblems(this.collectProblems(campaign, true));
  }

  private throwIfProblems(problems: string[]) {
    if (problems.length) {
      throw new BadRequestException(
        `Campaign cannot proceed: ${[...new Set(problems)].join('; ')}`
      );
    }
  }

  private collectProblems(
    campaign: CampaignForJobs,
    forPublish: boolean
  ): string[] {
    const problems: string[] = [];
    if (!campaign.destinations?.length) {
      problems.push('Campaign has no target destinations');
    }
    if (
      forPublish &&
      (!campaign.approvedContentHash ||
        campaign.approvedContentHash !== this.computeContentHash(campaign))
    ) {
      problems.push('Campaign content does not match what was approved');
    }
    const now = new Date();
    for (const dest of campaign.destinations || []) {
      if (dest.destinationType !== 'TELEGRAM') {
        problems.push(
          'Only Telegram destinations can be dispatched right now; remove social destinations or schedule them in Launches'
        );
        continue;
      }
      const tg = dest.telegramDestination;
      if (!tg) {
        problems.push(
          'A Telegram destination on this campaign no longer exists'
        );
        continue;
      }
      if (!forPublish) continue;
      if (tg.authorizationStatus !== DestinationAuthStatus.ACTIVE) {
        problems.push(
          `"${tg.title}" is not authorized for posting (${tg.authorizationStatus})`
        );
      } else if (tg.consentExpiresAt && tg.consentExpiresAt <= now) {
        problems.push(`"${tg.title}" consent has expired`);
      } else if (!tg.canPostMessages) {
        problems.push(`"${tg.title}" bot lacks permission to post`);
      }
    }
    try {
      this.gateway.validateAd(this.buildAd(campaign));
    } catch (err: any) {
      problems.push(err?.message || 'Advertisement is not valid for Telegram');
    }
    if (
      forPublish &&
      campaign.scheduleKind === 'DRIP' &&
      campaign.endDate &&
      campaign.destinations.length > 1
    ) {
      const last =
        (campaign.startDate ?? now).getTime() +
        (campaign.destinations.length - 1) *
          (campaign.intervalMinutes ?? 0) *
          60_000;
      if (last > campaign.endDate.getTime()) {
        problems.push(
          'The drip would reach past the end date: shorten the gap, choose fewer chats, or move the end date'
        );
      }
    }
    for (const variant of campaign.variants ?? []) {
      try {
        this.gateway.validateAd(
          this.buildAd(this.contentFor(campaign, variant.label))
        );
      } catch (err: any) {
        problems.push(
          `Version ${variant.label}: ${
            err?.message || 'not valid for Telegram'
          }`
        );
      }
    }
    return problems;
  }

  // ==========================================
  // JOB CREATION
  // ==========================================
  /**
   * One job per destination per campaign revision. Re-running this (a double click,
   * a retried request) creates nothing new: the unique idempotency key absorbs it.
   */
  async createJobsForCampaign(
    campaign: CampaignForJobs,
    runAt?: Date
  ): Promise<number> {
    const now = new Date();
    const contentHash = this.computeContentHash(campaign);
    const kind = campaign.scheduleKind ?? 'ONCE';
    const step = (campaign.intervalMinutes ?? 0) * 60_000;
    const rounds = kind === 'REPEAT' ? campaign.occurrences ?? 1 : 1;
    // Versions take turns across chats and, on a single chat, across repeats: A, B, C... A, B, C...
    const labels = [
      'A',
      ...(campaign.variants ?? []).map((v) => v.label).sort(),
    ];
    // A stable order, so the same chat always gets the same version first.
    const destinations = [...campaign.destinations].sort((a, b) =>
      a.id.localeCompare(b.id)
    );

    const rows: NewPostingJob[] = [];
    destinations.forEach((d, index) => {
      const own = runAt ?? d.scheduledAt;
      const first =
        own ??
        new Date(
          (campaign.startDate ?? now).getTime() +
            (kind === 'DRIP' ? index * step : 0)
        );
      for (let round = 0; round < rounds; round++) {
        const at = new Date(
          first.getTime() + (kind === 'REPEAT' ? round * step : 0)
        );
        // Repeats stop at the end date; a drip that would run past it is refused below.
        if (round > 0 && campaign.endDate && at > campaign.endDate) break;
        const label = labels[(index + round) % labels.length];
        const base = `camp_${campaign.id}_r${campaign.revision}_dest_${d.id}`;
        rows.push({
          orgId: campaign.orgId,
          campaignId: campaign.id,
          campaignDestinationId: d.id,
          telegramDestinationId: d.telegramDestinationId,
          integrationId: d.integrationId,
          destinationType: d.destinationType,
          // The first post keeps the key every campaign has always had, so nothing is sent twice
          // by a campaign scheduled before schedules existed.
          idempotencyKey: round === 0 ? base : `${base}_o${round}`,
          scheduledFor: at,
          contentHash,
          maxAttempts: this.maxAttempts,
          variantLabel: label === 'A' ? null : label,
          occurrence: round,
        });
      }
    });
    if (
      kind === 'DRIP' &&
      campaign.endDate &&
      rows.some((r) => r.scheduledFor > campaign.endDate!)
    ) {
      throw new BadRequestException(
        'The drip would reach past the campaign’s end date. Shorten the gap, choose fewer chats, or move the end date.'
      );
    }
    return this.jobs.createJobsIfAbsent(rows);
  }

  // ==========================================
  // DISPATCH LOOP
  // ==========================================
  /** Processes up to `limit` due jobs. Safe to run in several processes at once. */
  async dispatchDue(limit = 25): Promise<number> {
    await this.recoverStaleLeases();
    const now = new Date();
    const due = await this.jobs.findDueJobs(now, limit);
    let processed = 0;
    for (const { id } of due) {
      const claimed = await this.jobs.claimJob(
        id,
        new Date(),
        new Date(Date.now() + this.leaseMs),
        this.workerId
      );
      if (!claimed) continue; // another worker owns it
      processed++;
      try {
        await this.executeClaimedJob(id);
      } catch (err: any) {
        // A bug must not strand the job in SENDING with the lease running.
        this.logger.error(`Job ${id} crashed: ${err?.stack || err?.message}`);
        await this.jobs.markTerminal(
          id,
          'UNCERTAIN',
          'WORKER_ERROR',
          `Unexpected error while sending: ${err?.message || 'unknown'}`
        );
      }
      if (this.sendDelayMs > 0) await this.sleep(this.sendDelayMs);
    }
    return processed;
  }

  private async recoverStaleLeases() {
    const flipped = await this.jobs.expireStaleLeases(new Date());
    for (const job of flipped) {
      await this.reconcileCampaign(job.orgId, job.campaignId);
      await this.notify(
        job.orgId,
        'Publishing outcome unknown',
        'A publishing worker stopped mid-send. Check the destination before retrying the job so the ad is not posted twice.'
      );
    }
  }

  private async executeClaimedJob(jobId: string) {
    const job = await this.jobs.getJobForExecution(jobId);
    if (!job) return;
    const { campaign } = job;
    const orgId = job.orgId;
    const attempt = job.attempts;
    const now = new Date();
    const finishReconcile = () => this.reconcileCampaign(orgId, campaign.id);

    // --- Campaign state is re-read at send time: cancel/pause/delete always win.
    if (
      campaign.deletedAt ||
      !ACTIVE_CAMPAIGN_STATES.includes(campaign.status)
    ) {
      if (campaign.status === CampaignStatus.PAUSED) {
        await this.jobs.deferWithoutAttempt(
          jobId,
          new Date(Date.now() + 60_000),
          'Campaign paused'
        );
      } else {
        await this.jobs.markTerminal(
          jobId,
          'CANCELLED',
          'CAMPAIGN_NOT_ACTIVE',
          `Campaign is ${campaign.deletedAt ? 'deleted' : campaign.status}`
        );
      }
      return;
    }
    if (campaign.endDate && now > campaign.endDate) {
      await this.jobs.markTerminal(
        jobId,
        'DEAD',
        'CAMPAIGN_ENDED',
        'Campaign end date passed before this post was sent'
      );
      await finishReconcile();
      return;
    }

    // --- Content must still be exactly what was approved.
    const currentHash = this.computeContentHash(campaign);
    if (
      !campaign.approvedContentHash ||
      currentHash !== campaign.approvedContentHash ||
      job.contentHash !== currentHash
    ) {
      await this.jobs.markTerminal(
        jobId,
        'BLOCKED',
        'CONTENT_CHANGED',
        'Campaign content changed after approval; it must be re-approved'
      );
      await this.flagCampaign(
        orgId,
        campaign.id,
        'Content changed after approval'
      );
      await this.access.audit(null, {
        orgId,
        action: 'job.blocked',
        entityType: 'PostingJob',
        entityId: jobId,
        summary: 'Content changed after approval',
      });
      await finishReconcile();
      return;
    }

    // --- Only Telegram is dispatchable today. Never report an unsent ad as sent.
    const dest = job.telegramDestination;
    if (job.destinationType !== 'TELEGRAM' || !dest || dest.deletedAt) {
      await this.jobs.markTerminal(
        jobId,
        'DEAD',
        'UNSUPPORTED_DESTINATION',
        'Destination type is not dispatchable or no longer exists'
      );
      await this.recordEvent(
        job,
        'FAILED',
        'Destination type is not dispatchable or no longer exists',
        attempt
      );
      await finishReconcile();
      return;
    }

    // --- Authorization is checked on every send, not just at scheduling.
    if (
      dest.authorizationStatus === DestinationAuthStatus.ACTIVE &&
      dest.consentExpiresAt &&
      dest.consentExpiresAt <= now
    ) {
      await this.handleDestinationUnavailable(
        orgId,
        dest.id,
        DestinationAuthStatus.EXPIRED,
        'Posting consent expired'
      );
    }
    const freshStatus = (
      await this.agencyRepo.getTelegramDestinationById(orgId, dest.id)
    )?.authorizationStatus;
    if (freshStatus !== DestinationAuthStatus.ACTIVE) {
      await this.jobs.markTerminal(
        jobId,
        'BLOCKED',
        'DESTINATION_NOT_AUTHORIZED',
        `Destination is ${
          freshStatus ?? 'missing'
        }; posting requires active authorization`
      );
      await this.recordEvent(
        job,
        'SKIPPED',
        `Destination is ${freshStatus ?? 'missing'}`,
        attempt
      );
      await finishReconcile();
      return;
    }

    // --- Posting windows and frequency caps.
    const deferral = await this.computePacingDeferral(
      dest,
      campaign.postingWindows,
      campaign.timezone,
      now
    );
    if (deferral) {
      await this.jobs.deferWithoutAttempt(
        jobId,
        deferral.nextAt,
        deferral.reason
      );
      return;
    }

    // --- A chat served by a Telegram user account has its own checks and its own error handling. A bot
    // is never swapped in for it, and another account never takes over.
    if (dest.senderKind === 'USER_ACCOUNT') {
      await this.sendViaUserAccount(job, attempt);
      await finishReconcile();
      return;
    }

    // --- Which bot posts, and it must still be able to post right now. A chat's backup bots only
    // count while the chat's administrator keeps them as administrators; the main bot losing its
    // right ends posting for the chat, whatever backups it has.
    const skipped = new Set<string>();
    const mainKey = AgencyTelegramBotsService.keyOf(dest.botId);
    let pick: BotPick;
    for (;;) {
      try {
        pick = await this.bots.pick(orgId, dest, skipped);
        const perms = await pick.bot.gateway.getBotPermissions(dest.chatId);
        if (perms.isAdmin && perms.canPostMessages) break;
        if (pick.key === mainKey) {
          await this.handleDestinationUnavailable(
            orgId,
            dest.id,
            DestinationAuthStatus.DISCONNECTED,
            'Bot is no longer an administrator with permission to post'
          );
          await this.jobs.markTerminal(
            jobId,
            'BLOCKED',
            'PERMISSION_LOST',
            'Bot lost posting permission'
          );
          await this.recordEvent(
            job,
            'FAILED',
            'Bot lost posting permission',
            attempt
          );
          await finishReconcile();
          return;
        }
        // A backup that is no longer an administrator simply leaves the rotation.
        skipped.add(pick.key);
        await this.dropBackup(orgId, dest, pick);
      } catch (err) {
        await this.handleSendError(job, attempt, err);
        await finishReconcile();
        return;
      }
    }

    // --- Send.
    try {
      const result = await pick.bot.gateway.sendAd(
        dest.chatId,
        this.buildAd(this.contentFor(campaign, job.variantLabel))
      );
      const botName = pick.bot.username || pick.bot.label;
      const stored = await this.jobs.markSucceeded(jobId, {
        externalMessageId: result.primaryMessageId,
        releaseUrl: result.releaseUrl,
        receipt: {
          messageIds: result.messageIds,
          sentAt: new Date().toISOString(),
          bot: { key: pick.key, username: botName },
        },
      });
      if (!stored) {
        this.logger.error(
          `Job ${jobId} was sent (message ${result.primaryMessageId}) but its state changed mid-send; recording receipt anyway`
        );
      }
      await this.recordEvent(
        job,
        'SUCCESS',
        undefined,
        attempt,
        result.primaryMessageId,
        result.releaseUrl,
        botName
      );
      await this.agencyRepo.recordDestinationSuccess(
        orgId,
        dest.id,
        new Date(),
        pick.key
      );
      await this.logBotSwitch(orgId, dest, pick, campaign, jobId);
    } catch (err) {
      await this.noteBotRateLimit(pick.bot, err);
      await this.handleSendError(job, attempt, err);
    }
    await finishReconcile();
  }

  /** Remember that Telegram slowed this bot down, for the screens. It changes nothing about who sends. */
  private async noteBotRateLimit(bot: BotHandle, rawErr: unknown) {
    try {
      const err =
        rawErr instanceof TelegramGatewayError
          ? rawErr
          : this.gateway.classify(rawErr);
      if (err.kind === 'RATE_LIMITED') {
        await this.bots.noteRateLimited(bot, err.retryAfterSeconds);
      }
    } catch (e) {
      this.logger.warn(
        `Could not record the rate limit of a bot: ${(e as Error).message}`
      );
    }
  }

  /**
   * One post through a Telegram user account. Before anything is sent: the community must still be
   * authorized for advertising by a person, and the account must be in good standing and allowed to
   * publish. Whatever goes wrong afterwards stops this chat; nothing is rerouted or retried as
   * another identity, and a send whose outcome is unknown is never repeated by itself.
   */
  private async sendViaUserAccount(
    job: NonNullable<
      Awaited<ReturnType<AgencyPublishingRepository['getJobForExecution']>>
    >,
    attempt: number
  ) {
    const { campaign } = job;
    const orgId = job.orgId;
    const dest = job.telegramDestination!;

    const community = dest.communityId
      ? await this.jobs.getCommunityForSend(dest.communityId)
      : null;
    if (
      !community ||
      community.stage !== 'PUBLISHING_AUTHORIZED' ||
      community.adReview !== 'ALLOWED' ||
      !community.username
    ) {
      await this.stopUserDestination(
        job,
        attempt,
        'COMMUNITY_NOT_AUTHORIZED',
        'This community is no longer authorized for advertising'
      );
      return;
    }
    if (!dest.userAccountId) {
      await this.stopUserDestination(
        job,
        attempt,
        'ACCOUNT_MISSING',
        'No account is assigned to post here'
      );
      return;
    }

    let creds;
    let accountLabel: string;
    try {
      const got = await this.users.credentialsFor(
        orgId,
        dest.userAccountId,
        'canPublish'
      );
      creds = got.creds;
      accountLabel = got.account.label;
    } catch (err) {
      if (err instanceof TelegramAccountUnusableException) {
        if (err.reason === 'RATE_LIMITED' || err.reason === 'PAUSED') {
          // Not a failure: wait for the limit to pass, or for a person to resume the account.
          await this.jobs.deferWithoutAttempt(
            job.id,
            err.retryAt ?? new Date(Date.now() + 5 * 60_000),
            err.message
          );
          return;
        }
        await this.stopUserDestination(
          job,
          attempt,
          `ACCOUNT_${err.reason}`,
          err.message
        );
        return;
      }
      throw err;
    }

    let workerAd;
    try {
      workerAd = this.userGateway.buildWorkerAd(
        this.buildAd(this.contentFor(campaign, job.variantLabel)),
        this.gateway
      );
    } catch (err) {
      const message =
        (err as Error).message || 'The ad cannot be sent from a user account';
      await this.jobs.markTerminal(job.id, 'DEAD', 'BAD_REQUEST', message);
      await this.recordEvent(job, 'FAILED', message, attempt);
      return;
    }

    try {
      const result = await this.userGateway.sendMessage(
        creds,
        `@${community.username}`,
        workerAd
      );
      await this.jobs.markSucceeded(job.id, {
        externalMessageId: result.primaryMessageId,
        releaseUrl: result.releaseUrl ?? undefined,
        receipt: {
          messageIds: result.messageIds,
          sentAt: new Date().toISOString(),
          account: { id: dest.userAccountId, label: accountLabel },
        },
      });
      await this.recordEvent(
        job,
        'SUCCESS',
        undefined,
        attempt,
        result.primaryMessageId,
        result.releaseUrl ?? undefined,
        accountLabel
      );
      await this.agencyRepo.recordDestinationSuccess(
        orgId,
        dest.id,
        new Date()
      );
    } catch (err) {
      await this.handleUserSendError(job, attempt, err, accountLabel);
    }
  }

  /** The chat stops, its queued posts pause with the reason, and a person decides what happens next. */
  private async stopUserDestination(
    job: NonNullable<
      Awaited<ReturnType<AgencyPublishingRepository['getJobForExecution']>>
    >,
    attempt: number,
    code: string,
    message: string
  ) {
    await this.jobs.markTerminal(job.id, 'BLOCKED', code, message);
    await this.recordEvent(job, 'SKIPPED', message, attempt);
    await this.handleDestinationUnavailable(
      job.orgId,
      job.telegramDestination!.id,
      'DISCONNECTED',
      message
    );
  }

  private async handleUserSendError(
    job: NonNullable<
      Awaited<ReturnType<AgencyPublishingRepository['getJobForExecution']>>
    >,
    attempt: number,
    rawErr: unknown,
    accountLabel: string
  ) {
    const orgId = job.orgId;
    const dest = job.telegramDestination!;
    const err =
      rawErr instanceof TelegramUserGatewayError
        ? rawErr
        : new TelegramUserGatewayError(
            'UNKNOWN',
            (rawErr as Error)?.message ?? 'Unknown error'
          );
    await this.recordEvent(
      job,
      'FAILED',
      `${err.code}: ${err.message}`,
      attempt
    );
    await this.agencyRepo.recordDestinationError(
      orgId,
      dest.id,
      `${err.code}: ${err.message}`
    );

    switch (err.code) {
      case 'OUTCOME_UNKNOWN':
      case 'WORKER_PROTOCOL':
      case 'UNKNOWN':
        // The post may be live. It is not sent again until a person has looked.
        await this.jobs.markTerminal(
          job.id,
          'UNCERTAIN',
          'OUTCOME_UNKNOWN',
          `${accountLabel}: the result of this send is not known (${err.message}); check the community before retrying`
        );
        await this.notify(
          orgId,
          'Publishing outcome unknown',
          `"${dest.title}": check the community before this ad is sent again.`
        );
        return;
      case 'ACCOUNT_RESTRICTED':
      case 'SESSION_INVALID':
        // Telegram limited, or ended the login of, this account. It is paused and shown; no other
        // account is used in its place.
        if (dest.userAccountId) {
          await this.users.recordFailure(orgId, dest.userAccountId, err);
        }
        await this.stopUserDestination(
          job,
          attempt,
          `ACCOUNT_${err.code}`,
          `${accountLabel}: ${err.message}`
        );
        return;
      case 'FORBIDDEN':
      case 'NOT_FOUND':
      case 'PRIVATE':
        await this.stopUserDestination(job, attempt, err.code, err.message);
        if (dest.communityId) {
          await this.jobs.blockCommunity(
            orgId,
            dest.communityId,
            `Telegram refused posting here: ${err.message}`.slice(0, 280)
          );
        }
        return;
      case 'BAD_REQUEST':
      case 'INVALID_REF':
      case 'UNSUPPORTED':
        await this.jobs.markTerminal(job.id, 'DEAD', err.code, err.message);
        await this.notify(
          orgId,
          'Ad rejected by Telegram',
          `"${dest.title}": ${err.message}`
        );
        return;
      default: {
        // RATE_LIMITED, NETWORK, WORKER_UNAVAILABLE, WORKER_AUTH: nothing was sent, so waiting is safe.
        if (err.code === 'RATE_LIMITED' && dest.userAccountId) {
          await this.users.recordFailure(orgId, dest.userAccountId, err);
        }
        if (attempt >= job.maxAttempts) {
          await this.jobs.markTerminal(
            job.id,
            'DEAD',
            err.code,
            `Gave up after ${attempt} attempts: ${err.message}`
          );
          await this.notify(
            orgId,
            'Publishing failed permanently',
            `"${dest.title}": gave up after ${attempt} attempts (${err.message}). It is in the dead-letter queue.`
          );
          return;
        }
        const waitSeconds =
          err.code === 'RATE_LIMITED' && err.retryAfterSeconds
            ? err.retryAfterSeconds + 1
            : this.backoffSeconds * 2 ** (attempt - 1) +
              Math.floor(Math.random() * 10);
        await this.jobs.releaseForRetry(
          job.id,
          new Date(Date.now() + waitSeconds * 1000),
          err.code,
          err.message
        );
      }
    }
  }

  /** Every change of the bot that posts in a chat is recorded: when, why, and for which campaign. */
  private async logBotSwitch(
    orgId: string,
    dest: { id: string; botId: string | null; lastBotId: string | null },
    pick: BotPick,
    campaign: { id: string; name: string },
    jobId: string
  ) {
    const before =
      dest.lastBotId ?? AgencyTelegramBotsService.keyOf(dest.botId);
    if (pick.key === before) return;
    const why: Record<BotPick['reason'], string> = {
      MAIN: 'back to the main bot',
      MAIN_UNAVAILABLE: `the main bot cannot be used (${
        pick.detail ?? 'unavailable'
      })`,
      ROUND_ROBIN: 'the chat’s bots take turns',
      LEAST_USED: 'it sent the fewest posts in the last 24 hours',
    };
    await this.access.audit(null, {
      orgId,
      action: 'destination.bot_switched',
      entityType: 'TelegramDestination',
      entityId: dest.id,
      summary: `Posted through ${pick.bot.label} (was ${before}): ${
        why[pick.reason]
      }; campaign “${campaign.name}”`,
      metadata: {
        reason: pick.reason,
        from: before,
        to: pick.key,
        campaignId: campaign.id,
        jobId,
      } as Prisma.InputJsonValue,
    });
  }

  private async dropBackup(
    orgId: string,
    dest: { id: string; backupBotIds: string[] },
    pick: BotPick
  ) {
    await this.agencyRepo.updateDestinationBots(orgId, dest.id, {
      backupBotIds: dest.backupBotIds.filter((k) => k !== pick.key),
    });
    await this.access.audit(null, {
      orgId,
      action: 'destination.backup_bot_dropped',
      entityType: 'TelegramDestination',
      entityId: dest.id,
      summary: `${pick.bot.label} is no longer an administrator of the chat and was taken off its backup list`,
    });
  }

  private async handleSendError(
    job: NonNullable<
      Awaited<ReturnType<AgencyPublishingRepository['getJobForExecution']>>
    >,
    attempt: number,
    rawErr: unknown
  ) {
    const err =
      rawErr instanceof TelegramGatewayError
        ? rawErr
        : this.gateway.classify(rawErr);
    const orgId = job.orgId;
    const dest = job.telegramDestination!;
    await this.recordEvent(
      job,
      'FAILED',
      `${err.kind}: ${err.message}`,
      attempt
    );
    await this.agencyRepo.recordDestinationError(
      orgId,
      dest.id,
      `${err.kind}: ${err.message}`
    );

    if (err.partialMessageIds.length > 0) {
      await this.jobs.markTerminal(
        job.id,
        'UNCERTAIN',
        'PARTIAL_SEND',
        `Part of the ad was posted before an error (${err.message}); verify the destination before retrying`,
        { messageIds: err.partialMessageIds }
      );
      await this.notify(
        orgId,
        'Ad partially posted',
        `"${dest.title}": ${err.message}. Part of the ad is live; review before retrying.`
      );
      return;
    }

    switch (err.kind) {
      case 'FORBIDDEN':
      case 'CHAT_NOT_FOUND':
      case 'CHAT_MIGRATED':
        await this.handleDestinationUnavailable(
          orgId,
          dest.id,
          DestinationAuthStatus.DISCONNECTED,
          `${err.kind}: ${err.message}`
        );
        await this.jobs.markTerminal(job.id, 'BLOCKED', err.kind, err.message);
        return;
      case 'UNCONFIGURED':
        await this.jobs.markTerminal(
          job.id,
          'BLOCKED',
          'UNCONFIGURED',
          err.message
        );
        await this.flagCampaign(
          orgId,
          job.campaignId,
          'Telegram bot is not configured'
        );
        await this.notify(
          orgId,
          'Telegram bot not available',
          `Posting to "${dest.title}" is paused: ${err.message}`
        );
        return;
      case 'BAD_REQUEST':
        await this.jobs.markTerminal(
          job.id,
          'DEAD',
          'BAD_REQUEST',
          err.message
        );
        await this.notify(
          orgId,
          'Ad rejected by Telegram',
          `"${dest.title}": ${err.message}`
        );
        return;
      default: {
        // RATE_LIMITED, NETWORK, UNKNOWN: retry with exponential backoff.
        if (attempt >= job.maxAttempts) {
          await this.jobs.markTerminal(
            job.id,
            'DEAD',
            err.kind,
            `Gave up after ${attempt} attempts: ${err.message}`
          );
          await this.notify(
            orgId,
            'Publishing failed permanently',
            `"${dest.title}": gave up after ${attempt} attempts (${err.message}). It is in the dead-letter queue.`
          );
          return;
        }
        const waitSeconds =
          err.kind === 'RATE_LIMITED' && err.retryAfterSeconds
            ? err.retryAfterSeconds + 1
            : this.backoffSeconds * 2 ** (attempt - 1) +
              Math.floor(Math.random() * 10);
        await this.jobs.releaseForRetry(
          job.id,
          new Date(Date.now() + waitSeconds * 1000),
          err.kind,
          err.message
        );
      }
    }
  }

  // ==========================================
  // DESTINATION AVAILABILITY
  // ==========================================
  /**
   * Single place that takes a destination out of service: records why, blocks its
   * queued jobs, flags the affected campaigns and tells the agency. Re-authorization
   * later unblocks them (see unblockForDestination).
   */
  async handleDestinationUnavailable(
    orgId: string,
    destinationId: string,
    status: 'DISCONNECTED' | 'REVOKED' | 'EXPIRED' | 'SUSPENDED',
    reason: string,
    actor?: AgencyActor
  ) {
    const dest = await this.agencyRepo.getTelegramDestinationById(
      orgId,
      destinationId
    );
    if (!dest) throw new NotFoundException('Destination not found');
    await this.agencyRepo.setDestinationAuthorization(orgId, destinationId, {
      authorizationStatus: DestinationAuthStatus[status],
      lastError: reason,
      revokedReason: reason,
      ...(status === 'REVOKED' ? { consentRevokedAt: new Date() } : {}),
    });
    const blocked = await this.jobs.blockPendingJobsForDestination(
      destinationId,
      `DESTINATION_${status}`,
      reason
    );
    const campaignIds = [...new Set(blocked.map((b) => b.campaignId))];
    for (const campaignId of campaignIds) {
      await this.flagCampaign(
        orgId,
        campaignId,
        `"${dest.title}" is ${status.toLowerCase()}: ${reason}`
      );
      await this.reconcileCampaign(orgId, campaignId);
    }
    await this.access.audit(actor ?? null, {
      orgId,
      action: `destination.${status.toLowerCase()}`,
      entityType: 'TelegramDestination',
      entityId: destinationId,
      summary: reason,
      metadata: { blockedJobs: blocked.length } as Prisma.InputJsonValue,
    });
    await this.notify(
      orgId,
      `Destination ${status.toLowerCase()}`,
      `"${dest.title}" is ${status.toLowerCase()} (${reason}). ${
        blocked.length
      } queued post(s) were paused.`
    );
    return { blockedJobs: blocked.length, campaignIds };
  }

  /** After a destination is authorized again, its paused jobs go back in the queue. */
  async unblockForDestination(orgId: string, destinationId: string) {
    const affected = await this.jobs.unblockJobsForDestination(destinationId);
    for (const campaignId of [...new Set(affected.map((a) => a.campaignId))]) {
      await this.clearAttentionIfResolved(orgId, campaignId);
      await this.reconcileCampaign(orgId, campaignId);
    }
    return affected.length;
  }

  // ==========================================
  // CAMPAIGN STATE DERIVED FROM JOB OUTCOMES
  // ==========================================
  /**
   * The campaign's status is a consequence of its jobs, never an assertion: all
   * delivered → COMPLETED, some delivered → PARTIALLY_FAILED, none → FAILED.
   */
  async reconcileCampaign(orgId: string, campaignId: string) {
    const campaign = await this.jobs.getCampaignStatus(campaignId);
    if (
      !campaign ||
      campaign.orgId !== orgId ||
      !RECONCILABLE_STATES.includes(campaign.status)
    ) {
      return;
    }
    const c = await this.jobs.getJobStatusCounts(campaignId);
    const active = c.PENDING + c.SENDING;
    const failed = c.DEAD + c.UNCERTAIN;
    const blocked = c.BLOCKED;
    const delivered = c.SUCCEEDED;
    if (delivered + failed + blocked + active === 0) return;

    let next: CampaignStatus | null = null;
    if (active > 0) {
      // Queued work exists, so the campaign must be in a state the dispatcher serves.
      // This also revives a FAILED/PARTIALLY_FAILED campaign whose paused jobs were
      // just resumed. It stays SCHEDULED only while nothing has happened yet.
      const untouched =
        campaign.status === CampaignStatus.SCHEDULED &&
        delivered + failed + blocked + c.SENDING === 0;
      if (!untouched) next = CampaignStatus.PUBLISHING;
    } else if (failed + blocked === 0) {
      if (delivered > 0) next = CampaignStatus.COMPLETED;
    } else {
      next =
        delivered > 0 ? CampaignStatus.PARTIALLY_FAILED : CampaignStatus.FAILED;
    }
    const needsAttention = failed + blocked > 0;
    if (!next && needsAttention === campaign.requiresAttention) return;

    const target = next ?? campaign.status;
    const changed = await this.jobs.transitionCampaign(
      orgId,
      campaignId,
      RECONCILABLE_STATES,
      {
        status: target,
        requiresAttention: needsAttention,
        ...(needsAttention
          ? {
              attentionReason: `${failed} failed and ${blocked} paused of ${
                delivered + failed + blocked + active
              } posts`,
            }
          : { attentionReason: null }),
      }
    );
    if (changed && target !== campaign.status) {
      await this.access.audit(null, {
        orgId,
        action: 'campaign.status_derived',
        entityType: 'Campaign',
        entityId: campaignId,
        summary: `${campaign.status} → ${target}`,
        metadata: { counts: c } as unknown as Prisma.InputJsonValue,
      });
      if (
        target === CampaignStatus.COMPLETED ||
        target === CampaignStatus.PARTIALLY_FAILED ||
        target === CampaignStatus.FAILED
      ) {
        await this.notify(
          orgId,
          `Campaign ${target.toLowerCase().replace('_', ' ')}`,
          `"${campaign.name}": ${delivered} delivered, ${failed} failed, ${blocked} paused.`
        );
      }
    }
  }

  private async flagCampaign(
    orgId: string,
    campaignId: string,
    reason: string
  ) {
    await this.jobs.transitionCampaign(
      orgId,
      campaignId,
      Object.values(CampaignStatus),
      { requiresAttention: true, attentionReason: reason.slice(0, 300) }
    );
  }

  private async clearAttentionIfResolved(orgId: string, campaignId: string) {
    const c = await this.jobs.getJobStatusCounts(campaignId);
    if (c.BLOCKED + c.DEAD + c.UNCERTAIN === 0) {
      await this.jobs.transitionCampaign(
        orgId,
        campaignId,
        Object.values(CampaignStatus),
        {
          requiresAttention: false,
          attentionReason: null,
        }
      );
    }
  }

  // ==========================================
  // OPERATOR ACTIONS
  // ==========================================
  /** Retry dead jobs (fresh attempt budget) and resume paused ones whose destination is healthy again. */
  async retryCampaign(actor: AgencyActor, campaignId: string) {
    const campaign = await this.agencyRepo.getCampaignById(
      actor.orgId,
      campaignId
    );
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (
      campaign.status !== CampaignStatus.FAILED &&
      campaign.status !== CampaignStatus.PARTIALLY_FAILED
    ) {
      throw new BadRequestException(
        `Only failed campaigns can be retried (current: ${campaign.status})`
      );
    }
    const revived = await this.jobs.requeueDeadJobsForCampaign(campaignId);
    const jobs = await this.jobs.getJobsForCampaign(actor.orgId, campaignId);
    let resumed = 0;
    for (const j of jobs.filter((x) => x.status === PostingJobStatus.BLOCKED)) {
      if (
        j.telegramDestination?.authorizationStatus ===
        DestinationAuthStatus.ACTIVE
      ) {
        resumed += await this.unblockSingle(j.id);
      }
    }
    if (revived + resumed === 0) {
      throw new BadRequestException(
        'Nothing to retry: failed or paused posts need their destination re-authorized first'
      );
    }
    await this.jobs.transitionCampaign(
      actor.orgId,
      campaignId,
      RECONCILABLE_STATES,
      { status: CampaignStatus.PUBLISHING }
    );
    await this.clearAttentionIfResolved(actor.orgId, campaignId);
    await this.access.audit(actor, {
      action: 'campaign.retry',
      entityType: 'Campaign',
      entityId: campaignId,
      summary: `Retried ${revived} failed and resumed ${resumed} paused posts`,
    });
    return { revived, resumed };
  }

  private async unblockSingle(jobId: string) {
    const job = await this.jobs.getJobForExecution(jobId);
    if (!job?.telegramDestinationId) return 0;
    const affected = await this.jobs.unblockJobsForDestination(
      job.telegramDestinationId
    );
    return affected.length;
  }

  /**
   * An UNCERTAIN job means we cannot know if the ad went out. A human checks the
   * destination and tells us, so we neither double-post nor falsely claim success.
   */
  async resolveUncertainJob(
    actor: AgencyActor,
    jobId: string,
    outcome: 'POSTED' | 'NOT_POSTED',
    note?: string
  ) {
    const job = await this.jobs.getJobForExecution(jobId);
    if (!job || job.orgId !== actor.orgId)
      throw new NotFoundException('Job not found');
    if (job.status !== PostingJobStatus.UNCERTAIN) {
      throw new BadRequestException(
        'Only jobs with an unknown outcome can be resolved manually'
      );
    }
    if (outcome === 'POSTED') {
      await this.jobs.markManuallyResolved(
        jobId,
        PostingJobStatus.SUCCEEDED,
        note
      );
    } else {
      await this.jobs.markManuallyResolved(
        jobId,
        PostingJobStatus.PENDING,
        note
      );
    }
    await this.access.audit(actor, {
      action: 'job.resolved_manually',
      entityType: 'PostingJob',
      entityId: jobId,
      summary: `Marked ${outcome}`,
      metadata: { note: note ?? null } as Prisma.InputJsonValue,
    });
    await this.jobs.transitionCampaign(
      actor.orgId,
      job.campaignId,
      RECONCILABLE_STATES,
      { status: CampaignStatus.PUBLISHING }
    );
    await this.reconcileCampaign(actor.orgId, job.campaignId);
    return { jobId, outcome };
  }

  async cancelOpenJobs(campaignId: string, reason: string) {
    return this.jobs.cancelOpenJobsForCampaign(
      campaignId,
      'CAMPAIGN_CANCELLED',
      reason
    );
  }

  async rescheduleOpenJobsNow(campaignId: string) {
    return this.jobs.rescheduleOpenJobs(campaignId, new Date());
  }

  async getJobs(orgId: string, campaignId: string) {
    return this.jobs.getJobsForCampaign(orgId, campaignId);
  }

  // ==========================================
  // PACING: posting windows + frequency caps
  // ==========================================
  private async computePacingDeferral(
    dest: {
      id: string;
      timezone: string;
      allowedPostingWindows: string | null;
      postingFrequencyRules: string | null;
    },
    campaignWindows: string | null,
    campaignTimezone: string,
    now: Date
  ): Promise<{ nextAt: Date; reason: string } | null> {
    const destWindows = this.parseWindows(dest.allowedPostingWindows);
    const campWindows = this.parseWindows(campaignWindows);
    const allowedAt = (d: Date) =>
      this.inWindows(d, destWindows, dest.timezone) &&
      this.inWindows(d, campWindows, campaignTimezone);

    if (!allowedAt(now)) {
      const step = 15 * 60 * 1000;
      for (let i = 1; i <= 8 * 96; i++) {
        const candidate = new Date(now.getTime() + i * step);
        if (allowedAt(candidate)) {
          return {
            nextAt: candidate,
            reason: 'Outside allowed posting window',
          };
        }
      }
      return {
        nextAt: new Date(now.getTime() + 24 * 3600 * 1000),
        reason: 'No posting window within 8 days',
      };
    }

    const rules = this.parseRules(dest.postingFrequencyRules);
    if (rules.minIntervalMinutes) {
      const last = await this.jobs.getLastSucceededAt(dest.id);
      if (last) {
        const earliest = new Date(
          last.getTime() + rules.minIntervalMinutes * 60_000
        );
        if (earliest > now)
          return {
            nextAt: earliest,
            reason: 'Minimum interval between posts not reached',
          };
      }
    }
    if (rules.maxPerDay) {
      const since = new Date(now.getTime() - 24 * 3600 * 1000);
      const recent = await this.jobs.getRecentSuccessTimes(dest.id, since);
      if (recent.length >= rules.maxPerDay) {
        const frees = new Date(
          recent[rules.maxPerDay - 1].getTime() + 24 * 3600 * 1000
        );
        return {
          nextAt: frees,
          reason: `Daily limit of ${rules.maxPerDay} posts reached`,
        };
      }
    }
    return null;
  }

  private parseWindows(raw: string | null | undefined): PostingWindow[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter(
            (w) =>
              /^\d{2}:\d{2}$/.test(w?.start) && /^\d{2}:\d{2}$/.test(w?.end)
          )
        : [];
    } catch {
      return [];
    }
  }

  private parseRules(raw: string | null | undefined): FrequencyRules {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return {
        maxPerDay:
          Number(parsed?.maxPerDay) > 0 ? Number(parsed.maxPerDay) : undefined,
        minIntervalMinutes:
          Number(parsed?.minIntervalMinutes) > 0
            ? Number(parsed.minIntervalMinutes)
            : undefined,
      };
    } catch {
      return {};
    }
  }

  /** An empty window list means "no restriction". Windows are evaluated in `timeZone`. */
  private inWindows(
    at: Date,
    windows: PostingWindow[],
    timeZone: string
  ): boolean {
    if (windows.length === 0) return true;
    const { day, minutes } = this.localParts(at, timeZone);
    return windows.some((w) => {
      const [sh, sm] = w.start.split(':').map(Number);
      const [eh, em] = w.end.split(':').map(Number);
      const start = sh * 60 + sm;
      const end = eh * 60 + em;
      const dayOk = !w.days?.length || w.days.includes(day);
      return dayOk && minutes >= start && minutes < end;
    });
  }

  private localParts(
    at: Date,
    timeZone: string
  ): { day: number; minutes: number } {
    let parts: Intl.DateTimeFormatPart[];
    try {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(at);
    } catch {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(at);
    }
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '0';
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
      get('weekday')
    );
    return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
  }

  // ==========================================
  // HELPERS
  // ==========================================
  private async recordEvent(
    job: {
      id: string;
      orgId: string;
      campaignId: string;
      telegramDestinationId: string | null;
      idempotencyKey: string;
    },
    status: 'SUCCESS' | 'FAILED' | 'SKIPPED',
    errorMessage: string | undefined,
    attempt: number,
    externalMessageId?: string,
    releaseUrl?: string,
    botUsername?: string
  ) {
    await this.agencyRepo.recordPublishingEvent({
      campaignId: job.campaignId,
      telegramDestinationId: job.telegramDestinationId ?? undefined,
      externalMessageId,
      releaseUrl,
      botUsername,
      status,
      errorMessage,
      idempotencyKey: job.idempotencyKey,
      postingJobId: job.id,
      attempt,
    });
  }

  private async notify(orgId: string, subject: string, message: string) {
    try {
      await this.notifications.inAppNotification(
        orgId,
        subject,
        message,
        false,
        false,
        'fail'
      );
    } catch (err: any) {
      this.logger.warn(
        `Notification "${subject}" could not be delivered: ${err?.message}`
      );
    }
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
