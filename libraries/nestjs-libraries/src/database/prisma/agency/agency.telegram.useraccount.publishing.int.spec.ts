import { randomBytes } from 'crypto';
import {
  approvedCampaign,
  buildHarness,
  campaignStatus,
  clearQueue,
  connectAccount,
  describeDb,
  Harness,
  jobsOf,
  scheduledCampaign,
  seedTenant,
  settle,
  Tenant,
} from './agency.test.support';

const name = () => `shop_${randomBytes(3).toString('hex')}`;

describeDb(
  'Publishing through a Telegram user account (real database, fake worker)',
  () => {
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
      t = await seedTenant(h, 'useraccount');
      h.gateway.sent = [];
      h.userGateway.sent = [];
      h.userGateway.calls = [];
      h.userGateway.errors.clear();
      h.userGateway.once.clear();
    });

    /** A community walked all the way to “authorized to post”, the way a person would. */
    const authorized = async (accountId?: string) => {
      const account =
        accountId ??
        (
          await connectAccount(h, t, {
            grants: { canJoin: true, canPublish: true, canManage: true },
          })
        ).id;
      const username = name();
      const entry = h.userGateway.community(username);
      await h.communities.importRefs(t.manager, {
        accountId: account,
        refs: [`@${username}`],
      });
      const row = await h.prisma.community.findFirstOrThrow({
        where: { orgId: t.orgId, username },
      });
      await h.communities.join(t.manager, row.id, {
        accountId: account,
        reason: 'A good fit for us',
        confirmed: true,
      });
      await h.communities.reviewAdvertising(t.manager, row.id, {
        decision: 'ALLOWED',
        note: 'The pinned rules allow one promotion a week.',
        rulesRead: true,
        advertisingPermitted: true,
      });
      const out = await h.communities.authorize(t.manager, row.id, account);
      return {
        account,
        entry,
        row,
        username,
        destinationId: out.destinationId,
      };
    };
    const destStatus = async (id: string) =>
      (await h.prisma.telegramDestination.findUniqueOrThrow({ where: { id } }))
        .authorizationStatus;
    const accountStatus = async (id: string) =>
      (await h.users.list(t.owner)).find((a) => a.id === id)!.status;

    it('delivers through the account, never through a bot, and records which account posted', async () => {
      const x = await authorized();
      const id = await scheduledCampaign(h, t, [x.destinationId], {
        contentBody: 'Fresh <b>sourdough</b> every morning.',
        variants: [{ contentBody: 'Warm bread, baked at dawn.' }],
      });
      await h.publishing.dispatchDue();
      await settle(h, id);

      const [job] = await jobsOf(h, id);
      expect(job.status).toBe('SUCCEEDED');
      expect(h.gateway.sent).toHaveLength(0);
      expect(h.userGateway.sent).toHaveLength(1);
      expect(h.userGateway.sent[0].ref).toBe(`@${x.username}`);
      expect(h.userGateway.sent[0].ad.html).toContain('<b>sourdough</b>');
      expect(job.externalMessageId).toBe('5001');
      expect(job.releaseUrl).toBe(`https://t.me/${x.username}/5001`);
      expect((job.receipt as any).account).toMatchObject({ id: x.account });
      expect(await campaignStatus(h, id)).toBe('COMPLETED');
      const event = await h.prisma.publishingEvent.findFirstOrThrow({
        where: { campaignId: id },
      });
      expect(event).toMatchObject({
        status: 'SUCCESS',
        externalMessageId: '5001',
      });
      expect(
        (
          await h.prisma.telegramDestination.findUniqueOrThrow({
            where: { id: x.destinationId },
          })
        ).lastSuccessfulPostAt
      ).not.toBeNull();
    });

    it('waits out Telegram’s limit: the post is retried later, the account is marked, nothing else posts in its place', async () => {
      const x = await authorized();
      const y = await authorized(); // a second, healthy account with its own community
      const id = await scheduledCampaign(h, t, [
        x.destinationId,
        y.destinationId,
      ]);
      h.userGateway.failOnce(
        '/v1/messages/send',
        h.userGateway.err('RATE_LIMITED', 'flood', 90)
      );
      await h.publishing.dispatchDue();
      await settle(h, id);

      const jobs = await jobsOf(h, id);
      const waiting = jobs.filter((j) => j.status === 'PENDING');
      expect(waiting).toHaveLength(1);
      expect(waiting[0].nextAttemptAt.getTime()).toBeGreaterThan(
        Date.now() + 60_000
      );
      expect(waiting[0].lastErrorCode).toBe('RATE_LIMITED');
      expect(jobs.filter((j) => j.status === 'SUCCEEDED')).toHaveLength(1);
      // The account behind the waiting post is the limited one; the other stayed healthy and was not given the post.
      const waitingDest = waiting[0].telegramDestinationId;
      const limitedOne = [x, y].find((c) => c.destinationId === waitingDest)!;
      const healthyOne = [x, y].find((c) => c.destinationId !== waitingDest)!;
      expect(await accountStatus(limitedOne.account)).toBe('RATE_LIMITED');
      expect(await accountStatus(healthyOne.account)).toBe('ACTIVE');
      expect(h.userGateway.sent).toHaveLength(1);
      expect(h.userGateway.sent[0].ref).toBe(`@${healthyOne.username}`);
      // While it is limited the post is only deferred, and Telegram is not asked again.
      h.userGateway.calls = [];
      await h.prisma.postingJob.updateMany({
        where: { id: waiting[0].id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      await h.publishing.dispatchDue();
      await settle(h, id);
      expect(h.userGateway.asked('/v1/messages/send')).toHaveLength(0);
      expect(
        (await jobsOf(h, id)).find((j) => j.id === waiting[0].id)!.status
      ).toBe('PENDING');
    });

    it('a restriction stops that chat and that account only, queued posts there pause, and no other identity posts', async () => {
      const x = await authorized();
      const spare = await connectAccount(h, t, {
        grants: { canPublish: true },
      });
      // The spare account is even a member of the same community: it still is not used.
      const session = [...h.userGateway.sessions.keys()].pop()!;
      x.entry.members.add(session);
      const id = await scheduledCampaign(h, t, [x.destinationId], {
        scheduleKind: 'REPEAT',
        intervalMinutes: 60,
        occurrences: 3,
      });
      h.userGateway.fail(
        '/v1/messages/send',
        h.userGateway.err('ACCOUNT_RESTRICTED', 'PeerFlood')
      );
      await h.publishing.dispatchDue();
      await settle(h, id);

      expect(await accountStatus(x.account)).toBe('RESTRICTED');
      expect(await accountStatus(spare.id)).toBe('ACTIVE');
      expect(await destStatus(x.destinationId)).toBe('DISCONNECTED');
      const jobs = await jobsOf(h, id);
      expect(jobs.every((j) => j.status === 'BLOCKED')).toBe(true);
      expect(jobs.map((j) => j.lastErrorCode)).toContain(
        'ACCOUNT_ACCOUNT_RESTRICTED'
      );
      expect(h.userGateway.sent).toHaveLength(0);
      // And nothing retries it by itself.
      h.userGateway.errors.clear();
      await h.publishing.dispatchDue();
      expect(h.userGateway.sent).toHaveLength(0);
      expect((await h.users.events(t.owner, x.account))[0]).toMatchObject({
        kind: 'RESTRICTED',
      });
    });

    it('an ended login stops the chat and asks for a new sign-in', async () => {
      const x = await authorized();
      const id = await scheduledCampaign(h, t, [x.destinationId]);
      for (const [s] of h.userGateway.sessions) h.userGateway.revoked.add(s);
      await h.publishing.dispatchDue();
      await settle(h, id);
      expect(await accountStatus(x.account)).toBe('SESSION_INVALID');
      expect((await jobsOf(h, id))[0]).toMatchObject({
        status: 'BLOCKED',
        lastErrorCode: 'ACCOUNT_SESSION_INVALID',
      });
      expect(await destStatus(x.destinationId)).toBe('DISCONNECTED');
    });

    it('a send whose result is unknown is never repeated by itself', async () => {
      const x = await authorized();
      const id = await scheduledCampaign(h, t, [x.destinationId]);
      h.userGateway.failOnce(
        '/v1/messages/send',
        h.userGateway.err('OUTCOME_UNKNOWN', 'connection dropped after send')
      );
      await h.publishing.dispatchDue();
      await settle(h, id);
      expect((await jobsOf(h, id))[0]).toMatchObject({
        status: 'UNCERTAIN',
        lastErrorCode: 'OUTCOME_UNKNOWN',
      });
      await h.publishing.dispatchDue();
      await h.publishing.dispatchDue();
      expect(h.userGateway.sent).toHaveLength(0);
      expect(h.userGateway.asked('/v1/messages/send')).toHaveLength(1);
    });

    it('a refusal at the chat disconnects it and blocks the community until a person reopens it', async () => {
      const x = await authorized();
      const id = await scheduledCampaign(h, t, [x.destinationId]);
      h.userGateway.failOnce(
        '/v1/messages/send',
        h.userGateway.err('FORBIDDEN', 'banned in channel')
      );
      await h.publishing.dispatchDue();
      await settle(h, id);
      expect(await destStatus(x.destinationId)).toBe('DISCONNECTED');
      expect(
        (
          await h.prisma.community.findUniqueOrThrow({
            where: { id: x.row.id },
          })
        ).stage
      ).toBe('BLOCKED');
      expect((await jobsOf(h, id))[0].status).toBe('BLOCKED');
    });

    it('a paused account holds its posts until it is resumed, then they go out', async () => {
      const x = await authorized();
      const id = await scheduledCampaign(h, t, [x.destinationId]);
      await h.users.pause(t.owner, x.account);
      await h.publishing.dispatchDue();
      await settle(h, id);
      expect(h.userGateway.sent).toHaveLength(0);
      expect((await jobsOf(h, id))[0].status).toBe('PENDING');
      await h.users.resume(t.owner, x.account);
      await h.prisma.postingJob.updateMany({
        where: { campaignId: id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      await h.publishing.dispatchDue();
      await settle(h, id);
      expect(h.userGateway.sent).toHaveLength(1);
      expect((await jobsOf(h, id))[0].status).toBe('SUCCEEDED');
    });

    it('is checked at send time: authorization withdrawn, or the account’s permission taken away, after scheduling', async () => {
      const a = await authorized();
      const idA = await scheduledCampaign(h, t, [a.destinationId]);
      await h.communities.withdraw(t.manager, a.row.id, 'Pausing outreach');
      await h.publishing.dispatchDue();
      await settle(h, idA);
      expect(h.userGateway.sent).toHaveLength(0);
      expect((await jobsOf(h, idA))[0].status).toBe('BLOCKED');

      const b = await authorized();
      const idB = await scheduledCampaign(h, t, [b.destinationId]);
      await h.users.update(t.owner, b.account, { canPublish: false });
      await h.publishing.dispatchDue();
      await settle(h, idB);
      expect(h.userGateway.sent).toHaveLength(0);
      expect((await jobsOf(h, idB))[0]).toMatchObject({
        status: 'BLOCKED',
        lastErrorCode: 'ACCOUNT_NOT_PERMITTED',
      });
    });

    it('puts paused posts back in the queue when a person authorizes the chat again', async () => {
      const x = await authorized();
      const id = await scheduledCampaign(h, t, [x.destinationId]);
      await h.communities.withdraw(t.manager, x.row.id, 'Pausing outreach');
      expect((await jobsOf(h, id))[0].status).toBe('BLOCKED');
      await h.communities.authorize(t.manager, x.row.id, x.account);
      expect((await jobsOf(h, id))[0].status).toBe('PENDING');
      await h.prisma.postingJob.updateMany({
        where: { campaignId: id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      await h.publishing.dispatchDue();
      await settle(h, id);
      expect(h.userGateway.sent).toHaveLength(1);
    });

    it('refuses what an account cannot send, and says why, instead of posting something different', async () => {
      const x = await authorized();
      const id = await scheduledCampaign(h, t, [x.destinationId], {
        contentMedia: JSON.stringify(['https://example.com/pic.jpg']),
      });
      await h.publishing.dispatchDue();
      await settle(h, id);
      const [job] = await jobsOf(h, id);
      expect(job).toMatchObject({
        status: 'DEAD',
        lastErrorCode: 'BAD_REQUEST',
      });
      expect(job.lastError).toMatch(/uploaded to AgencyOS/);
      expect(h.userGateway.sent).toHaveLength(0);
    });

    it('retries a connection problem with backoff, because nothing was sent', async () => {
      const x = await authorized();
      const id = await scheduledCampaign(h, t, [x.destinationId]);
      h.userGateway.failOnce(
        '/v1/messages/send',
        h.userGateway.err('NETWORK', 'unreachable')
      );
      await h.publishing.dispatchDue();
      await settle(h, id);
      const [job] = await jobsOf(h, id);
      expect(job.status).toBe('PENDING');
      expect(job.attempts).toBe(1);
      await h.prisma.postingJob.updateMany({
        where: { campaignId: id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      await h.publishing.dispatchDue();
      await settle(h, id);
      expect((await jobsOf(h, id))[0].status).toBe('SUCCEEDED');
      expect(h.userGateway.sent).toHaveLength(1);
    });

    it('a campaign still needs approval and unchanged content, exactly as for bots', async () => {
      const x = await authorized();
      const id = await approvedCampaign(h, t, [x.destinationId]);
      await h.prisma.campaign.update({
        where: { id },
        data: { contentBody: 'Sneaky change after approval' },
      });
      await expect(h.agency.scheduleCampaign(t.manager, id)).rejects.toThrow(
        /does not match what was approved/
      );
      expect(h.userGateway.sent).toHaveLength(0);
    });
  }
);
