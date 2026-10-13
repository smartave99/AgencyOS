import { createHash } from 'crypto';
import {
  activeDestination,
  approvedCampaign,
  buildHarness,
  clearQueue,
  describeDb,
  draftCampaign,
  Harness,
  jobsOf,
  scheduledCampaign,
  seedTenant,
  settle,
  Tenant,
} from './agency.test.support';

const MINUTE = 60_000;

describeDb('Ad versions and schedules (real database, fake Telegram)', () => {
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
  });

  const destinations = async (n: number) => {
    const list = [];
    for (let i = 0; i < n; i++) list.push(await activeDestination(h, t.orgId));
    return list;
  };

  describe('versions of an ad', () => {
    it('are labelled B, C, D in the order given and the campaign’s own text stays A', async () => {
      const [d] = await destinations(1);
      const c = await draftCampaign(h, t, [d.id], {
        variants: [
          { contentBody: 'Version B text' },
          { contentBody: 'Version C text', contentTitle: 'C headline' },
        ],
      });
      const stored = await h.prisma.campaignVariant.findMany({
        where: { campaignId: c.id },
        orderBy: { label: 'asc' },
      });
      expect(stored.map((v) => v.label)).toEqual(['B', 'C']);
      expect(stored[1].contentTitle).toBe('C headline');
    });

    it('are limited to three, need text, and take only http(s) links', async () => {
      const [d] = await destinations(1);
      const four = Array.from({ length: 4 }, (_, i) => ({
        contentBody: `Version ${i}`,
      }));
      await expect(
        draftCampaign(h, t, [d.id], { variants: four })
      ).rejects.toThrow(/at most 4 versions/);
      await expect(
        draftCampaign(h, t, [d.id], { variants: [{ contentBody: '   ' }] })
      ).rejects.toThrow(/Version B needs some ad text/);
      await expect(
        draftCampaign(h, t, [d.id], {
          variants: [{ contentBody: 'ok', ctaLink: 'javascript:alert(1)' }],
        })
      ).rejects.toThrow(/Version B's link/);
    });

    it('can be replaced when the draft is edited, and are copied when the campaign is duplicated', async () => {
      const [d] = await destinations(1);
      const c = await draftCampaign(h, t, [d.id], {
        variants: [{ contentBody: 'First B' }],
        scheduleKind: 'REPEAT',
        intervalMinutes: 120,
        occurrences: 3,
      });
      await h.agency.updateCampaign(t.sales, c.id, {
        variants: [{ contentBody: 'Second B' }, { contentBody: 'Second C' }],
      });
      const after = await h.prisma.campaignVariant.findMany({
        where: { campaignId: c.id },
        orderBy: { label: 'asc' },
      });
      expect(after.map((v) => v.contentBody)).toEqual(['Second B', 'Second C']);

      const copy = await h.agency.duplicateCampaign(t.sales, c.id);
      const copied = await h.prisma.campaignVariant.findMany({
        where: { campaignId: copy.id },
        orderBy: { label: 'asc' },
      });
      expect(copied.map((v) => v.contentBody)).toEqual([
        'Second B',
        'Second C',
      ]);
      expect(copy).toMatchObject({
        scheduleKind: 'REPEAT',
        intervalMinutes: 120,
        occurrences: 3,
      });
    });

    it('must each fit Telegram, and a reviewer is told which version does not', async () => {
      const [d] = await destinations(1);
      const c = await draftCampaign(h, t, [d.id], {
        variants: [{ contentBody: 'x'.repeat(5000) }],
      });
      await expect(
        h.agency.submitForApproval(t.sales, c.id, 'please review')
      ).rejects.toThrow(/Version B/);
    });

    it('are part of what is approved: a campaign without versions hashes exactly as before', async () => {
      const [d] = await destinations(1);
      const id = await approvedCampaign(h, t, [d.id]);
      const c = await h.prisma.campaign.findUniqueOrThrow({ where: { id } });
      const legacy = createHash('sha256')
        .update(
          JSON.stringify([
            c.contentTitle ?? '',
            c.contentBody,
            c.contentMedia ?? '',
            c.ctaLink ?? '',
            c.ctaText ?? '',
            c.telegramChannelLink ?? '',
          ])
        )
        .digest('hex');
      expect(c.approvedContentHash).toBe(legacy);
    });

    it('cannot be changed in the database after approval and still be sent', async () => {
      const [d] = await destinations(2);
      const id = await scheduledCampaign(h, t, [d.id], {
        variants: [{ contentBody: 'Approved B' }],
      });
      await h.prisma.campaignVariant.updateMany({
        where: { campaignId: id, label: 'B' },
        data: { contentBody: 'Sneaky edit after approval' },
      });
      await h.publishing.dispatchDue();
      await settle(h, id);
      expect(h.gateway.sent).toHaveLength(0);
      const [job] = await jobsOf(h, id);
      expect(job.status).not.toBe('SUCCEEDED');
    });
  });

  describe('taking turns across chats', () => {
    it('gives each chat one version, A then B then A, and sends that version’s words', async () => {
      const dests = await destinations(3);
      const id = await scheduledCampaign(
        h,
        t,
        dests.map((d) => d.id),
        {
          contentBody: 'Words of version A',
          variants: [{ contentBody: 'Words of version B' }],
        }
      );
      const jobs = await jobsOf(h, id);
      expect(jobs).toHaveLength(3);
      const byLabel = jobs.map((j) => j.variantLabel ?? 'A').sort();
      expect(byLabel).toEqual(['A', 'A', 'B']);

      await h.publishing.dispatchDue();
      await settle(h, id);
      expect(h.gateway.sent).toHaveLength(3);
      const sentWords = h.gateway.sent.map((s) =>
        s.ad.body.includes('version B') ? 'B' : 'A'
      );
      expect(sentWords.sort()).toEqual(['A', 'A', 'B']);
      // every job sent exactly its own version
      for (const job of await jobsOf(h, id)) {
        const sent = h.gateway.sent.find(
          (s) => s.messageId === job.externalMessageId
        )!;
        expect(sent.ad.body.includes('version B')).toBe(
          job.variantLabel === 'B'
        );
      }
    });

    it('is stable: scheduling again creates no new jobs', async () => {
      const dests = await destinations(2);
      const id = await approvedCampaign(
        h,
        t,
        dests.map((d) => d.id),
        { variants: [{ contentBody: 'B words' }] }
      );
      const campaign = await h.agencyRepo.getCampaignById(t.orgId, id);
      await h.publishing.createJobsForCampaign(campaign as any);
      const first = await jobsOf(h, id);
      await h.publishing.createJobsForCampaign(campaign as any);
      expect(await jobsOf(h, id)).toHaveLength(first.length);
    });
  });

  describe('repeating', () => {
    it('queues one post per time for each chat, the first keeping the key every campaign has had', async () => {
      const [d] = await destinations(1);
      const start = new Date(Date.now() + 10 * MINUTE);
      const id = await scheduledCampaign(h, t, [d.id], {
        startDate: start,
        scheduleKind: 'REPEAT',
        intervalMinutes: 180,
        occurrences: 3,
      });
      const jobs = (await jobsOf(h, id)).sort(
        (a, b) => a.occurrence - b.occurrence
      );
      expect(jobs.map((j) => j.occurrence)).toEqual([0, 1, 2]);
      expect(jobs[0].idempotencyKey).toMatch(/_dest_[^_]+$/);
      expect(jobs[1].idempotencyKey).toBe(`${jobs[0].idempotencyKey}_o1`);
      expect(jobs[2].idempotencyKey).toBe(`${jobs[0].idempotencyKey}_o2`);
      expect(
        jobs[1].scheduledFor.getTime() - jobs[0].scheduledFor.getTime()
      ).toBe(180 * MINUTE);
      expect(
        jobs[2].scheduledFor.getTime() - jobs[1].scheduledFor.getTime()
      ).toBe(180 * MINUTE);
    });

    it('stops at the end date', async () => {
      const [d] = await destinations(1);
      const start = new Date(Date.now() + 10 * MINUTE);
      const id = await scheduledCampaign(h, t, [d.id], {
        startDate: start,
        endDate: new Date(start.getTime() + 150 * MINUTE),
        scheduleKind: 'REPEAT',
        intervalMinutes: 60,
        occurrences: 10,
      });
      // at 0, 60 and 120 minutes; 180 is past the end
      expect(await jobsOf(h, id)).toHaveLength(3);
    });

    it('takes versions in turn on a single chat', async () => {
      const [d] = await destinations(1);
      const id = await scheduledCampaign(h, t, [d.id], {
        startDate: new Date(Date.now() + 10 * MINUTE),
        scheduleKind: 'REPEAT',
        intervalMinutes: 60,
        occurrences: 3,
        variants: [{ contentBody: 'B words' }],
      });
      const labels = (await jobsOf(h, id))
        .sort((a, b) => a.occurrence - b.occurrence)
        .map((j) => j.variantLabel ?? 'A');
      expect(labels).toEqual(['A', 'B', 'A']);
    });

    it('waits for its time: only the first post goes out now, the rest stay queued', async () => {
      const [d] = await destinations(1);
      const id = await scheduledCampaign(h, t, [d.id], {
        startDate: new Date(Date.now() - MINUTE),
        scheduleKind: 'REPEAT',
        intervalMinutes: 60,
        occurrences: 3,
      });
      await h.publishing.dispatchDue();
      await settle(h, id);
      expect(h.gateway.sent).toHaveLength(1);
      const jobs = await jobsOf(h, id);
      expect(jobs.filter((j) => j.status === 'SUCCEEDED')).toHaveLength(1);
      expect(jobs.filter((j) => j.status === 'PENDING')).toHaveLength(2);
      // the campaign is not complete while posts are still waiting
      const campaign = await h.prisma.campaign.findUniqueOrThrow({
        where: { id },
      });
      expect(campaign.status).not.toBe('COMPLETED');
      // a later post sends when its time comes
      await h.prisma.postingJob.updateMany({
        where: { campaignId: id, status: 'PENDING', occurrence: 1 },
        data: {
          scheduledFor: new Date(Date.now() - 1000),
          nextAttemptAt: new Date(Date.now() - 1000),
        },
      });
      await h.publishing.dispatchDue();
      await settle(h, id);
      expect(h.gateway.sent).toHaveLength(2);
    });

    it('needs at least an hour between posts and between 2 and 60 times', async () => {
      const [d] = await destinations(1);
      await expect(
        draftCampaign(h, t, [d.id], {
          scheduleKind: 'REPEAT',
          intervalMinutes: 30,
          occurrences: 3,
        })
      ).rejects.toThrow(/at least an hour/);
      await expect(
        draftCampaign(h, t, [d.id], {
          scheduleKind: 'REPEAT',
          intervalMinutes: 60,
          occurrences: 1,
        })
      ).rejects.toThrow(/between 2 and 60 times/);
      await expect(
        draftCampaign(h, t, [d.id], { scheduleKind: 'REPEAT' })
      ).rejects.toThrow(/at least an hour/);
    });
  });

  describe('dripping', () => {
    it('starts the chats one after another, the gap apart', async () => {
      const dests = await destinations(3);
      const start = new Date(Date.now() + 30 * MINUTE);
      const id = await scheduledCampaign(
        h,
        t,
        dests.map((d) => d.id),
        { startDate: start, scheduleKind: 'DRIP', intervalMinutes: 15 }
      );
      const times = (await jobsOf(h, id))
        .map((j) => j.scheduledFor.getTime() - start.getTime())
        .sort((a, b) => a - b);
      expect(times).toEqual([0, 15 * MINUTE, 30 * MINUTE]);
    });

    it('is refused when the last chat would start after the end date', async () => {
      const dests = await destinations(3);
      const start = new Date(Date.now() + 30 * MINUTE);
      const id = await approvedCampaign(
        h,
        t,
        dests.map((d) => d.id),
        {
          startDate: start,
          endDate: new Date(start.getTime() + 20 * MINUTE),
          scheduleKind: 'DRIP',
          intervalMinutes: 15,
        }
      );
      await expect(h.agency.scheduleCampaign(t.manager, id)).rejects.toThrow(
        /drip would reach past the end date/
      );
      expect(await jobsOf(h, id)).toHaveLength(0);
    });

    it('needs a gap of a minute to a week', async () => {
      const [d] = await destinations(1);
      await expect(
        draftCampaign(h, t, [d.id], { scheduleKind: 'DRIP' })
      ).rejects.toThrow(/between 1 minute and 1 week/);
      await expect(
        draftCampaign(h, t, [d.id], {
          scheduleKind: 'DRIP',
          intervalMinutes: 20000,
        })
      ).rejects.toThrow(/between 1 minute and 1 week/);
    });
  });

  it('the report compares versions of an ad inside one campaign, and only there', async () => {
    const dests = await destinations(2);
    const compared = await draftCampaign(h, t, [dests[0].id, dests[1].id], {
      name: 'Compared',
      variants: [{ contentBody: 'B words' }],
    });
    const single = await draftCampaign(h, t, [dests[0].id], {
      name: 'Single',
    });
    const job = (
      campaignId: string,
      destinationId: string,
      status: 'SUCCEEDED' | 'DEAD',
      variantLabel: string | null,
      key: string
    ) =>
      h.prisma.postingJob.create({
        data: {
          orgId: t.orgId,
          campaignId,
          telegramDestinationId: destinationId,
          destinationType: 'TELEGRAM',
          idempotencyKey: `variant-report-${key}`,
          status,
          variantLabel,
          scheduledFor: new Date('2026-05-10T12:00:00Z'),
          nextAttemptAt: new Date('2026-05-10T12:00:00Z'),
          contentHash: 'h',
          completedAt: new Date('2026-05-10T12:00:00Z'),
        },
      });
    await job(compared.id, dests[0].id, 'SUCCEEDED', null, `${t.orgId}-1`);
    await job(compared.id, dests[1].id, 'DEAD', 'B', `${t.orgId}-2`);
    await job(compared.id, dests[0].id, 'SUCCEEDED', 'B', `${t.orgId}-3`);
    await job(single.id, dests[0].id, 'SUCCEEDED', null, `${t.orgId}-4`);

    const report = await h.agency.getPublishingReport(t.manager, {
      from: '2026-05-01',
      to: '2026-05-31',
    });
    expect(
      report.variants.map((v) => [
        v.campaignName,
        v.label,
        v.delivered,
        v.failed,
      ])
    ).toEqual([
      ['Compared', 'A', 1, 0],
      ['Compared', 'B', 1, 1],
    ]);
    expect(report.variants.find((v) => v.label === 'B')?.deliveryRate).toBe(50);
    expect(report.notes.join(' ')).toMatch(/not per version/);
  });

  it('a campaign set to post once forgets any gap or count left from an earlier choice', async () => {
    const [d] = await destinations(1);
    const c = await draftCampaign(h, t, [d.id], {
      scheduleKind: 'REPEAT',
      intervalMinutes: 60,
      occurrences: 4,
    });
    const back = await h.agency.updateCampaign(t.sales, c.id, {
      scheduleKind: 'ONCE',
    });
    expect(back).toMatchObject({
      scheduleKind: 'ONCE',
      intervalMinutes: null,
      occurrences: null,
    });
  });
});
