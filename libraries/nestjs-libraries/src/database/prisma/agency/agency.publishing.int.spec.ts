import { BadRequestException } from '@nestjs/common';
import {
  activeDestination,
  approvedCampaign,
  buildHarness,
  campaignStatus,
  clearQueue,
  describeDb,
  draftCampaign,
  gatewayError,
  Harness,
  jobsOf,
  makeJobsDue,
  scheduledCampaign,
  seedTenant,
  settle,
  Tenant,
} from './agency.test.support';

describeDb('Publishing pipeline (real database, fake Telegram)', () => {
  let h: Harness;
  let t: Tenant;

  beforeAll(async () => {
    h = await buildHarness();
  });
  afterAll(async () => {
    await h.prisma.$disconnect();
  });
  beforeEach(async () => {
    await clearQueue(h);
    t = await seedTenant(h);
    h.gateway.sent = [];
    h.gateway.sendErrors.clear();
    h.gateway.permErrors.clear();
    h.notifications.inAppNotification.mockClear();
  });

  // ---------------------------------------------------------------- scenario 1, 2, 5
  describe('happy path: draft → review → schedule → publish', () => {
    it('1. a sales executive can create a draft campaign', async () => {
      const dest = await activeDestination(h, t.orgId);
      const c = await draftCampaign(h, t, [dest.id]);
      expect(c.status).toBe('DRAFT');
      expect(c.createdById).toBe(t.userIds.sales);
    });

    it('2a. a manager can approve, which records the approved content hash', async () => {
      const dest = await activeDestination(h, t.orgId);
      const id = await approvedCampaign(h, t, [dest.id]);
      const c = await h.prisma.campaign.findUniqueOrThrow({ where: { id } });
      expect(c.status).toBe('APPROVED');
      expect(c.approvedContentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(c.approvedByUserId).toBe(t.userIds.manager);
    });

    it('2b. a manager can reject; changes must be explained and the campaign returns to the author', async () => {
      const dest = await activeDestination(h, t.orgId);
      const c = await draftCampaign(h, t, [dest.id]);
      const approval = await h.agency.submitForApproval(t.sales, c.id);
      await expect(
        h.agency.reviewCampaign(t.manager, approval.id, 'REJECT')
      ).rejects.toThrow(/Explain what needs to change/);
      await h.agency.reviewCampaign(
        t.manager,
        approval.id,
        'REJECT',
        'Headline is misleading'
      );
      expect(await campaignStatus(h, c.id)).toBe('CHANGES_REQUESTED');
      // and it is editable again
      await h.agency.updateCampaign(t.sales, c.id, {
        contentTitle: 'Honest headline',
      });
    });

    it('5. approved content can be scheduled and is delivered with its receipt recorded', async () => {
      const dest = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [dest.id]);
      expect(await campaignStatus(h, id)).toBe('SCHEDULED');

      const sent = await h.publishing.dispatchDue();
      expect(sent).toBe(1);
      const [job] = await jobsOf(h, id);
      expect(job.status).toBe('SUCCEEDED');
      expect(job.externalMessageId).toBe(h.gateway.sent[0].messageId);
      expect(job.releaseUrl).toContain('t.me');
      expect(await campaignStatus(h, id)).toBe('COMPLETED');

      const events = await h.prisma.publishingEvent.findMany({
        where: { campaignId: id },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        status: 'SUCCESS',
        externalMessageId: job.externalMessageId,
        postingJobId: job.id,
        attempt: 1,
      });
      const refreshed = await h.prisma.telegramDestination.findUniqueOrThrow({
        where: { id: dest.id },
      });
      expect(refreshed.lastSuccessfulPostAt).not.toBeNull();
    });

    it('the delivered ad is escaped Telegram HTML with the sender-approved formatting kept', async () => {
      const dest = await activeDestination(h, t.orgId);
      await scheduledCampaign(h, t, [dest.id], {
        contentBody: '<b>Big</b> sale <script>alert(1)</script> 5 < 6',
      });
      await h.publishing.dispatchDue();
      const html = h.gateway.renderAdHtml(h.gateway.sent[0].ad);
      expect(html).toContain('<b>Big</b>');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('a future start date is not dispatched early', async () => {
      const dest = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [dest.id], {
        startDate: new Date(Date.now() + 3600_000),
      });
      expect(await h.publishing.dispatchDue()).toBe(0);
      expect(h.gateway.sent).toHaveLength(0);
      expect((await jobsOf(h, id))[0].status).toBe('PENDING');
    });
  });

  // ---------------------------------------------------------------- scenario 3
  describe('3. an unapproved campaign cannot publish', () => {
    it('refuses to schedule or publish a DRAFT / SUBMITTED campaign', async () => {
      const dest = await activeDestination(h, t.orgId);
      const draft = await draftCampaign(h, t, [dest.id]);
      await expect(
        h.agency.scheduleCampaign(t.manager, draft.id)
      ).rejects.toThrow(/Only APPROVED/);
      await expect(
        h.agency.publishCampaignNow(t.owner, draft.id)
      ).rejects.toThrow(/Only APPROVED or SCHEDULED/);
      await h.agency.submitForApproval(t.sales, draft.id);
      await expect(
        h.agency.publishCampaignNow(t.owner, draft.id)
      ).rejects.toThrow(/Only APPROVED or SCHEDULED/);
      expect(h.gateway.sent).toHaveLength(0);
    });

    it('even if the database is tampered with, an unapproved campaign is never sent', async () => {
      const dest = await activeDestination(h, t.orgId);
      const c = await draftCampaign(h, t, [dest.id]);
      // Simulate a bypass: jobs exist and the status was forced, but no approval hash.
      const full = await h.agencyRepo.getCampaignById(t.orgId, c.id);
      await h.publishing.createJobsForCampaign(full!);
      await h.prisma.campaign.update({
        where: { id: c.id },
        data: { status: 'SCHEDULED' },
      });
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(0);
      expect((await jobsOf(h, c.id))[0]).toMatchObject({
        status: 'BLOCKED',
        lastErrorCode: 'CONTENT_CHANGED',
      });
    });

    it('content edited after approval cannot be sent', async () => {
      const dest = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [dest.id]);
      await h.prisma.campaign.update({
        where: { id },
        data: { contentBody: 'Sneaky swapped text' },
      });
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(0);
      const [job] = await jobsOf(h, id);
      expect(job).toMatchObject({
        status: 'BLOCKED',
        lastErrorCode: 'CONTENT_CHANGED',
      });
      expect(
        (await h.prisma.campaign.findUniqueOrThrow({ where: { id } }))
          .requiresAttention
      ).toBe(true);
    });

    it('a submitted or approved campaign cannot be edited; reopening voids the approval', async () => {
      const dest = await activeDestination(h, t.orgId);
      const id = await approvedCampaign(h, t, [dest.id]);
      await expect(
        h.agency.updateCampaign(t.sales, id, { contentBody: 'changed' })
      ).rejects.toThrow(/Reopen it/);
      await expect(
        h.agency.updateCampaignDestinations(t.sales, id, [])
      ).rejects.toThrow(/Reopen it/);
      await h.agency.reopenCampaign(t.manager, id);
      const c = await h.prisma.campaign.findUniqueOrThrow({ where: { id } });
      expect(c).toMatchObject({
        status: 'DRAFT',
        approvedContentHash: null,
        revision: 2,
      });
      await h.agency.updateCampaign(t.sales, id, { contentBody: 'changed' });
    });
  });

  // ---------------------------------------------------------------- scenario 4
  describe('4. an unauthorized Telegram destination cannot receive posts', () => {
    it('refuses to schedule to a destination that has not been authorized by a chat admin', async () => {
      const pending = await activeDestination(h, t.orgId, {
        authorizationStatus: 'PENDING_VERIFICATION',
        isAuthorized: false,
        consentGrantedAt: null,
        consentExpiresAt: null,
      });
      const id = await approvedCampaign(h, t, [pending.id]); // drafting/approving is allowed
      await expect(h.agency.scheduleCampaign(t.manager, id)).rejects.toThrow(
        /not authorized for posting \(PENDING_VERIFICATION\)/
      );
      await expect(h.agency.publishCampaignNow(t.owner, id)).rejects.toThrow(
        BadRequestException
      );
      expect(h.gateway.sent).toHaveLength(0);
    });

    it('a job that reaches a non-authorized destination is blocked at send time', async () => {
      const dest = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [dest.id]);
      await h.prisma.telegramDestination.update({
        where: { id: dest.id },
        data: {
          authorizationStatus: 'PENDING_VERIFICATION',
          isAuthorized: false,
        },
      });
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(0);
      expect((await jobsOf(h, id))[0]).toMatchObject({
        status: 'BLOCKED',
        lastErrorCode: 'DESTINATION_NOT_AUTHORIZED',
      });
    });

    it('a new destination can never start out authorized', async () => {
      const reg = await h.telegram.registerDestination(t.manager, {
        chatId: '-1001112223334',
      });
      expect(reg.destination).toMatchObject({
        authorizationStatus: 'PENDING_VERIFICATION',
        isAuthorized: false,
      });
      expect(reg.verificationCode).toMatch(/^AOS-[A-Z0-9]{8}$/);
      expect(JSON.stringify(reg.destination)).not.toContain(
        'verificationCodeHash'
      );
    });
  });

  // ---------------------------------------------------------------- scenario 6
  describe('6. duplicate job execution does not duplicate advertisements', () => {
    it('three dispatchers racing over the same queue send each ad exactly once', async () => {
      const dests = await Promise.all(
        [1, 2, 3, 4].map(() => activeDestination(h, t.orgId))
      );
      const id = await scheduledCampaign(
        h,
        t,
        dests.map((d) => d.id)
      );
      h.gateway.sendDelayMs = 40; // widen the race window

      const results = await Promise.all([
        h.publishing.dispatchDue(),
        h.publishing.dispatchDue(),
        h.publishing.dispatchDue(),
      ]);
      h.gateway.sendDelayMs = 0;

      expect(results.reduce((a, b) => a + b, 0)).toBe(4); // 4 jobs claimed in total, never twice
      expect(h.gateway.sent).toHaveLength(4);
      expect(new Set(h.gateway.sent.map((s) => s.chatId)).size).toBe(4);
      const jobs = await jobsOf(h, id);
      expect(
        jobs.every((j) => j.status === 'SUCCEEDED' && j.attempts === 1)
      ).toBe(true);
      expect(await campaignStatus(h, id)).toBe('COMPLETED');
    });

    it('re-running scheduling or job creation is absorbed by the idempotency key', async () => {
      const dest = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [dest.id]);
      const full = await h.agencyRepo.getCampaignById(t.orgId, id);
      expect(await h.publishing.createJobsForCampaign(full!)).toBe(0);
      await expect(h.agency.scheduleCampaign(t.manager, id)).rejects.toThrow(
        /Only APPROVED/
      );
      expect(await jobsOf(h, id)).toHaveLength(1);
    });

    it('a finished job is never sent again, even if dispatched repeatedly', async () => {
      const dest = await activeDestination(h, t.orgId);
      await scheduledCampaign(h, t, [dest.id]);
      await h.publishing.dispatchDue();
      await h.publishing.dispatchDue();
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(1);
    });

    it('a worker that crashed mid-send leaves an UNCERTAIN job that is not auto-resent', async () => {
      const dest = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [dest.id]);
      const [job] = await jobsOf(h, id);
      // Simulate: claimed, then the process died; lease expired.
      await h.prisma.postingJob.update({
        where: { id: job.id },
        data: {
          status: 'SENDING',
          attempts: 1,
          lockedUntil: new Date(Date.now() - 1000),
          lockedBy: 'dead-worker',
        },
      });
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(0);
      expect((await jobsOf(h, id))[0]).toMatchObject({
        status: 'UNCERTAIN',
        lastErrorCode: 'LEASE_EXPIRED',
      });
      expect(await campaignStatus(h, id)).toBe('FAILED');

      // A human checked the channel and found it was NOT posted → it is queued again.
      await h.agency.resolveUncertainJob(
        t.manager,
        job.id,
        'NOT_POSTED',
        'checked channel, nothing there'
      );
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(1);
      expect(await campaignStatus(h, id)).toBe('COMPLETED');
    });
  });

  // ---------------------------------------------------------------- scenario 7
  describe('7. a failed destination does not mark everything successful', () => {
    it('one rejected destination yields PARTIALLY_FAILED with honest counts', async () => {
      const [good1, bad, good2] = await Promise.all([
        activeDestination(h, t.orgId),
        activeDestination(h, t.orgId),
        activeDestination(h, t.orgId),
      ]);
      const id = await scheduledCampaign(h, t, [good1.id, bad.id, good2.id]);
      h.gateway.failSendsTo(
        bad.chatId,
        gatewayError('BAD_REQUEST', 'Bad Request: wrong file identifier')
      );
      await h.publishing.dispatchDue();

      const byDest = Object.fromEntries(
        (await jobsOf(h, id)).map((j) => [j.telegramDestinationId, j.status])
      );
      expect(byDest).toEqual({
        [good1.id]: 'SUCCEEDED',
        [bad.id]: 'DEAD',
        [good2.id]: 'SUCCEEDED',
      });
      const c = await h.prisma.campaign.findUniqueOrThrow({ where: { id } });
      expect(c.status).toBe('PARTIALLY_FAILED');
      expect(c.requiresAttention).toBe(true);

      const dash = await h.agency.getDashboard(t.owner);
      expect(dash).toMatchObject({
        successfulPosts: 2,
        failedPosts: 1,
        deliveryRate: 67,
        campaignsNeedingAttention: 1,
      });
      expect(h.notifications.inAppNotification).toHaveBeenCalled();
    });

    it('when every destination fails the campaign is FAILED, not COMPLETED', async () => {
      const d = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [d.id]);
      h.gateway.failSendsTo(d.chatId, gatewayError('BAD_REQUEST'));
      await h.publishing.dispatchDue();
      expect(await campaignStatus(h, id)).toBe('FAILED');
    });

    it('a campaign with only social destinations is refused instead of being silently "completed"', async () => {
      const integration = await h.prisma.integration.create({
        data: {
          organizationId: t.orgId,
          internalId: 'x1',
          name: 'X acct',
          providerIdentifier: 'x',
          type: 'social',
          token: 'SECRET',
        },
      });
      const c = await draftCampaign(h, t, [], {
        destinations: [
          { destinationType: 'SOCIAL', integrationId: integration.id },
        ],
      });
      await expect(h.agency.submitForApproval(t.sales, c.id)).rejects.toThrow(
        /Only Telegram destinations can be dispatched/
      );
      expect(await campaignStatus(h, c.id)).toBe('DRAFT');
    });

    it('an ad too long for Telegram is rejected before review, with the limit named', async () => {
      const d = await activeDestination(h, t.orgId);
      const c = await draftCampaign(h, t, [d.id], {
        contentBody: 'x'.repeat(4500),
      });
      await expect(h.agency.submitForApproval(t.sales, c.id)).rejects.toThrow(
        /4096/
      );
    });
  });

  // ---------------------------------------------------------------- retries
  describe('retry with exponential backoff and a dead-letter state', () => {
    it('a transient error is retried later, then succeeds', async () => {
      const d = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [d.id]);
      h.gateway.failSendsTo(d.chatId, gatewayError('NETWORK', 'ECONNRESET'));
      await h.publishing.dispatchDue();

      let [job] = await jobsOf(h, id);
      expect(job).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastErrorCode: 'NETWORK',
      });
      expect(job.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 50_000); // ≈ 60s backoff, not immediate
      expect(await h.publishing.dispatchDue()).toBe(0); // not due yet

      h.gateway.clearFailures(d.chatId);
      await makeJobsDue(h, id);
      await h.publishing.dispatchDue();
      [job] = await jobsOf(h, id);
      expect(job).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
      expect(await campaignStatus(h, id)).toBe('COMPLETED');
      const events = await h.prisma.publishingEvent.findMany({
        where: { campaignId: id },
        orderBy: { createdAt: 'asc' },
      });
      expect(events.map((e) => e.status)).toEqual(['FAILED', 'SUCCESS']);
    });

    it("backoff doubles per attempt and Telegram's retry_after is honoured", async () => {
      const d = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [d.id]);
      h.gateway.failSendsTo(
        d.chatId,
        gatewayError('RATE_LIMITED', 'Too Many Requests', 300)
      );
      await h.publishing.dispatchDue();
      let [job] = await jobsOf(h, id);
      expect(job.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 295_000);

      h.gateway.failSendsTo(d.chatId, gatewayError('NETWORK'));
      await makeJobsDue(h, id);
      await h.publishing.dispatchDue();
      [job] = await jobsOf(h, id);
      expect(job.attempts).toBe(2);
      expect(job.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 115_000); // 60s * 2^(2-1)
    });

    it('after the maximum attempts the job is dead-lettered and the team is alerted', async () => {
      const d = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [d.id]);
      h.gateway.failSendsTo(d.chatId, gatewayError('NETWORK', 'timeout'));
      for (let i = 0; i < 3; i++) {
        await makeJobsDue(h, id);
        await h.publishing.dispatchDue();
      }
      const [job] = await jobsOf(h, id);
      expect(job).toMatchObject({ status: 'DEAD', attempts: 3 });
      expect(await campaignStatus(h, id)).toBe('FAILED');
      expect(
        h.notifications.inAppNotification.mock.calls.some((c) =>
          /permanently/i.test(c[1])
        )
      ).toBe(true);

      // An operator can retry with a fresh budget once the cause is fixed.
      h.gateway.clearFailures(d.chatId);
      await h.agency.retryCampaign(t.manager, id);
      await h.publishing.dispatchDue();
      await settle(h, id);
      expect((await jobsOf(h, id))[0].status).toBe('SUCCEEDED');
      expect(await campaignStatus(h, id)).toBe('COMPLETED');
    });

    it('with no bot token configured, nothing is faked: the job is blocked, not "sent"', async () => {
      const d = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [d.id]);
      h.gateway.failSendsTo(
        d.chatId,
        gatewayError('UNCONFIGURED', 'Telegram bot is not configured')
      );
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(0);
      const [job] = await jobsOf(h, id);
      expect(job).toMatchObject({
        status: 'BLOCKED',
        lastErrorCode: 'UNCONFIGURED',
        externalMessageId: null,
      });
      expect(
        await h.prisma.publishingEvent.count({
          where: { campaignId: id, status: 'SUCCESS' },
        })
      ).toBe(0);
    });
  });

  // ---------------------------------------------------------------- scenario 8
  describe('8. a disconnected destination pauses affected jobs', () => {
    it("the bot being removed blocks that destination's other queued jobs and flags the campaigns", async () => {
      const lost = await activeDestination(h, t.orgId);
      const other = await activeDestination(h, t.orgId);
      const c1 = await scheduledCampaign(h, t, [lost.id, other.id]);
      const c2 = await scheduledCampaign(h, t, [lost.id], {
        startDate: new Date(Date.now() + 3600_000),
      });

      h.gateway.failSendsTo(
        lost.chatId,
        gatewayError(
          'FORBIDDEN',
          'Forbidden: bot was kicked from the channel chat'
        )
      );
      await h.publishing.dispatchDue();

      const dest = await h.prisma.telegramDestination.findUniqueOrThrow({
        where: { id: lost.id },
      });
      expect(dest).toMatchObject({
        authorizationStatus: 'DISCONNECTED',
        isAuthorized: false,
      });
      const j1 = await jobsOf(h, c1);
      expect(j1.find((j) => j.telegramDestinationId === lost.id)!.status).toBe(
        'BLOCKED'
      );
      expect(j1.find((j) => j.telegramDestinationId === other.id)!.status).toBe(
        'SUCCEEDED'
      );
      expect((await jobsOf(h, c2))[0].status).toBe('BLOCKED'); // the future job was paused too
      expect(
        (await h.prisma.campaign.findUniqueOrThrow({ where: { id: c2 } }))
          .requiresAttention
      ).toBe(true);
      expect(await campaignStatus(h, c1)).toBe('PARTIALLY_FAILED');
      expect(h.notifications.inAppNotification).toHaveBeenCalledWith(
        t.orgId,
        expect.stringMatching(/disconnected/i),
        expect.any(String),
        false,
        false,
        'fail'
      );
      const audit = await h.prisma.auditEvent.findMany({
        where: { orgId: t.orgId, action: 'destination.disconnected' },
      });
      expect(audit).toHaveLength(1);
    });

    it('permission loss found by the pre-send check also blocks without sending', async () => {
      const d = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [d.id]);
      h.gateway.perms.set(d.chatId, {
        isAdmin: false,
        canPostMessages: false,
        canDeleteMessages: false,
        canInviteUsers: false,
      });
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(0);
      expect(
        (
          await h.prisma.telegramDestination.findUniqueOrThrow({
            where: { id: d.id },
          })
        ).authorizationStatus
      ).toBe('DISCONNECTED');
      expect((await jobsOf(h, id))[0].status).toBe('BLOCKED');
    });

    it('after the admin re-authorizes, blocked jobs resume and deliver', async () => {
      const d = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [d.id]);
      h.gateway.failSendsTo(
        d.chatId,
        gatewayError('FORBIDDEN', 'bot was kicked')
      );
      await h.publishing.dispatchDue();
      h.gateway.clearFailures(d.chatId);

      const { verificationCode } = await h.telegram.restartVerification(
        t.manager,
        d.id
      );
      h.gateway.makeAdmin(d.chatId, 777);
      await h.telegram.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: Number(d.chatId), type: 'channel', title: 'C' },
          from: { id: 777, is_bot: false, first_name: 'Ada' },
          text: `/authorize ${verificationCode}`,
        } as any,
      });
      expect(
        (
          await h.prisma.telegramDestination.findUniqueOrThrow({
            where: { id: d.id },
          })
        ).authorizationStatus
      ).toBe('ACTIVE');
      expect((await jobsOf(h, id))[0].status).toBe('PENDING');

      await h.publishing.dispatchDue();
      expect((await jobsOf(h, id))[0].status).toBe('SUCCEEDED');
      expect(await campaignStatus(h, id)).toBe('COMPLETED');
      expect(
        (await h.prisma.campaign.findUniqueOrThrow({ where: { id } }))
          .requiresAttention
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------- scenario 12
  describe('12. a cancelled campaign does not continue publishing', () => {
    it('cancelling before the start time cancels every queued job', async () => {
      const dests = await Promise.all([
        activeDestination(h, t.orgId),
        activeDestination(h, t.orgId),
      ]);
      const id = await scheduledCampaign(
        h,
        t,
        dests.map((d) => d.id),
        { startDate: new Date(Date.now() + 1000) }
      );
      await h.agency.cancelCampaign(t.manager, id, 'client withdrew');
      await h.prisma.postingJob.updateMany({
        where: { campaignId: id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(0);
      expect((await jobsOf(h, id)).every((j) => j.status === 'CANCELLED')).toBe(
        true
      );
      expect(await campaignStatus(h, id)).toBe('CANCELLED');
    });

    it('cancelling midway stops the remaining destinations', async () => {
      const dests = await Promise.all(
        [1, 2, 3].map(() => activeDestination(h, t.orgId))
      );
      const id = await scheduledCampaign(
        h,
        t,
        dests.map((d) => d.id)
      );
      // Cancel as soon as the first send happens.
      const original = h.gateway.sendAd.bind(h.gateway);
      let cancelled = false;
      jest.spyOn(h.gateway, 'sendAd').mockImplementation(async (chatId, ad) => {
        const res = await original(chatId, ad);
        if (!cancelled) {
          cancelled = true;
          await h.agency.cancelCampaign(t.manager, id);
        }
        return res;
      });
      await h.publishing.dispatchDue();
      jest.restoreAllMocks();
      expect(h.gateway.sent).toHaveLength(1);
      const statuses = (await jobsOf(h, id)).map((j) => j.status).sort();
      expect(statuses).toEqual(['CANCELLED', 'CANCELLED', 'SUCCEEDED']);
      expect(await campaignStatus(h, id)).toBe('CANCELLED');
    });

    it('a paused campaign sends nothing, and resumes cleanly', async () => {
      const d = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [d.id]);
      await h.agency.pauseCampaign(t.manager, id);
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(0);
      await h.agency.resumeCampaign(t.manager, id);
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(1);
    });

    it('a campaign past its end date is not sent late', async () => {
      const d = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [d.id], {
        startDate: new Date(Date.now() - 7200_000),
        endDate: new Date(Date.now() - 3600_000),
      });
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(0);
      expect((await jobsOf(h, id))[0]).toMatchObject({
        status: 'DEAD',
        lastErrorCode: 'CAMPAIGN_ENDED',
      });
    });
  });

  // ---------------------------------------------------------------- scenario 13
  describe('13. revoked destination permission prevents future publishing', () => {
    it("a chat admin's /revoke stops queued posts and refuses new scheduling", async () => {
      const d = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [d.id], {
        startDate: new Date(Date.now() + 3600_000),
      });
      h.gateway.makeAdmin(d.chatId, 42);
      await h.telegram.handleUpdate({
        update_id: 2,
        message: {
          message_id: 2,
          date: 0,
          chat: { id: Number(d.chatId), type: 'supergroup' },
          from: { id: 42, is_bot: false, first_name: 'Admin' },
          text: '/revoke',
        } as any,
      });
      const dest = await h.prisma.telegramDestination.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect(dest).toMatchObject({
        authorizationStatus: 'REVOKED',
        isAuthorized: false,
      });
      expect(dest.consentRevokedAt).not.toBeNull();
      expect((await jobsOf(h, id))[0].status).toBe('BLOCKED');

      await makeDue(h, id);
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(0);

      const fresh = await approvedCampaign(h, t, [d.id]);
      await expect(h.agency.scheduleCampaign(t.manager, fresh)).rejects.toThrow(
        /not authorized for posting \(REVOKED\)/
      );
    });

    it('staff revoking a destination has the same effect', async () => {
      const d = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [d.id]);
      await h.telegram.revoke(t.manager, d.id, 'client asked us to stop');
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(0);
      expect((await jobsOf(h, id))[0].status).toBe('BLOCKED');
    });

    it('expired consent stops posting by itself', async () => {
      const d = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [d.id]);
      await h.prisma.telegramDestination.update({
        where: { id: d.id },
        data: { consentExpiresAt: new Date(Date.now() - 1000) },
      });
      expect(await h.telegram.expireConsents()).toBeGreaterThanOrEqual(1);
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(0);
      expect(
        (
          await h.prisma.telegramDestination.findUniqueOrThrow({
            where: { id: d.id },
          })
        ).authorizationStatus
      ).toBe('EXPIRED');
      expect((await jobsOf(h, id))[0].status).toBe('BLOCKED');
    });
  });

  // ---------------------------------------------------------------- pacing
  describe('posting windows and frequency caps', () => {
    it("defers (without spending an attempt) when outside the destination's window", async () => {
      const now = new Date();
      const outside = (now.getUTCHours() + 6) % 24;
      const pad = (n: number) => String(n).padStart(2, '0');
      const d = await activeDestination(h, t.orgId, {
        timezone: 'UTC',
        allowedPostingWindows: JSON.stringify([
          { start: `${pad(outside)}:00`, end: `${pad(outside)}:30` },
        ]),
      });
      const id = await scheduledCampaign(h, t, [d.id]);
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(0);
      const [job] = await jobsOf(h, id);
      expect(job).toMatchObject({
        status: 'PENDING',
        attempts: 0,
        lastErrorCode: 'DEFERRED',
      });
      expect(job.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('enforces the minimum interval between posts to the same destination', async () => {
      const d = await activeDestination(h, t.orgId, {
        postingFrequencyRules: JSON.stringify({ minIntervalMinutes: 120 }),
      });
      await scheduledCampaign(h, t, [d.id]);
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(1);
      const second = await scheduledCampaign(h, t, [d.id]);
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(1); // second one waits
      expect((await jobsOf(h, second))[0]).toMatchObject({
        status: 'PENDING',
        attempts: 0,
      });
    });

    it('enforces a rolling daily cap', async () => {
      const d = await activeDestination(h, t.orgId, {
        postingFrequencyRules: JSON.stringify({ maxPerDay: 2 }),
      });
      for (let i = 0; i < 3; i++) await scheduledCampaign(h, t, [d.id]);
      await h.publishing.dispatchDue();
      expect(h.gateway.sent).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------- scenario 11
  describe('11. AI failure does not stop scheduling or publishing', () => {
    it('the whole publish path works while every AI endpoint is unreachable', async () => {
      const realFetch = global.fetch;
      global.fetch = jest
        .fn()
        .mockRejectedValue(
          new Error('connect ECONNREFUSED 127.0.0.1:11434')
        ) as any;
      try {
        const copy = await h.ai.generateCopy(t.orgId, {
          brief: 'Fresh fruit delivery for offices',
          clientName: 'Acme',
        } as any);
        expect(copy.providerUsed).toBe('heuristic_engine'); // honest label: template output, not a model

        const d = await activeDestination(h, t.orgId);
        const id = await scheduledCampaign(h, t, [d.id], {
          contentBody: copy.bodyVariants[0],
        });
        await h.publishing.dispatchDue();
        expect(await campaignStatus(h, id)).toBe('COMPLETED');
      } finally {
        global.fetch = realFetch;
      }
    });
  });

  describe('composer preview shows exactly what would be sent', () => {
    it('renders the real message, names the delivery format, and explains what would block it', async () => {
      const ad = {
        contentTitle: 'Spring sale',
        contentBody: '<b>Fresh</b> fruit <script>x</script>',
        ctaLink: 'https://example.com/',
        ctaText: 'Order',
        media: ['https://example.com/a.jpg'],
      };
      const ok = h.agency.previewAd(t.sales, ad);
      expect(ok).toMatchObject({ format: 'MEDIA_WITH_CAPTION', problem: null });
      expect(ok.html).toBe(
        h.gateway.renderAdHtml({
          title: ad.contentTitle,
          body: ad.contentBody,
          ctaLink: ad.ctaLink,
          ctaText: ad.ctaText,
        })
      );
      expect(ok.html).not.toContain('<script>');

      const long = h.agency.previewAd(t.sales, {
        ...ad,
        contentBody: 'x'.repeat(1500),
      });
      expect(long.format).toBe('MEDIA_THEN_TEXT');
      expect(long.problem).toBeNull();

      const tooLong = h.agency.previewAd(t.sales, {
        ...ad,
        contentBody: 'x'.repeat(5000),
      });
      expect(tooLong.problem).toMatch(/4096/);

      expect(
        h.agency.previewAd(t.sales, { contentBody: '' }).problem
      ).toBeNull(); // nothing typed yet
      expect(
        h.agency.previewAd(t.sales, {
          contentBody: 'hi',
          media: ['https://x.test/a.jpg', 'https://x.test/b.pdf'],
        }).problem
      ).toMatch(/Only images and videos/);
    });

    it('is for authors only', () => {
      expect(() => h.agency.previewAd(t.analyst, { contentBody: 'x' })).toThrow(
        /not allowed/
      );
      expect(() => h.agency.previewAd(t.client, { contentBody: 'x' })).toThrow(
        /not allowed/
      );
    });
  });

  describe('system status shown on the dashboard is real', () => {
    it('the dispatcher is offline until it beats, online after, and offline again once its lease lapses', async () => {
      await h.prisma.leaderLease.deleteMany({
        where: {
          name: { in: ['agency-dispatcher', 'agency-telegram-updates'] },
        },
      });
      let status = (await h.agency.getDashboard(t.owner)).system;
      expect(status.dispatcher.online).toBe(false);
      expect(status.telegram).toMatchObject({
        configured: true,
        listening: false,
        updates: 'off',
      });

      await h.publishing.heartbeat(15000);
      status = (await h.agency.getDashboard(t.owner)).system;
      expect(status.dispatcher.online).toBe(true);
      expect(status.dispatcher.lastSeenAt).not.toBeNull();

      await h.prisma.leaderLease.update({
        where: { name: 'agency-dispatcher' },
        data: { leaseUntil: new Date(Date.now() - 1000) },
      });
      expect(
        (await h.agency.getDashboard(t.owner)).system.dispatcher.online
      ).toBe(false);
    });

    it('a live Telegram update listener is reported, and so is a webhook', async () => {
      await h.prisma.leaderLease.upsert({
        where: { name: 'agency-telegram-updates' },
        create: {
          name: 'agency-telegram-updates',
          holder: 'test',
          leaseUntil: new Date(Date.now() + 60000),
        },
        update: { holder: 'test', leaseUntil: new Date(Date.now() + 60000) },
      });
      expect(
        (await h.agency.getDashboard(t.owner)).system.telegram
      ).toMatchObject({ listening: true, updates: 'polling' });
      process.env.AGENCY_TELEGRAM_WEBHOOK_URL = 'https://example.com/hook';
      process.env.AGENCY_TELEGRAM_WEBHOOK_SECRET = 's';
      expect(
        (await h.agency.getDashboard(t.owner)).system.telegram
      ).toMatchObject({ listening: true, updates: 'webhook' });
      delete process.env.AGENCY_TELEGRAM_WEBHOOK_URL;
      delete process.env.AGENCY_TELEGRAM_WEBHOOK_SECRET;
    });
  });

  const makeDue = (hh: Harness, id: string) =>
    hh.prisma.postingJob.updateMany({
      where: { campaignId: id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
});
