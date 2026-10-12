import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PostingJobStatus } from '@prisma/client';
import {
  activeDestination,
  buildHarness,
  describeDb,
  draftCampaign,
  Harness,
  seedTenant,
  Tenant,
} from './agency.test.support';

describeDb('publishing report (real database)', () => {
  let h: Harness;
  let t: Tenant;
  let n = 0;

  beforeAll(async () => {
    h = await buildHarness();
  });
  afterAll(async () => {
    await h.prisma.$disconnect();
  });
  beforeEach(async () => {
    t = await seedTenant(h, 'reports');
  });

  const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

  /** One stored job, exactly as the dispatcher would have left it. */
  const job = (
    campaignId: string,
    destinationId: string,
    status: PostingJobStatus,
    due: string
  ) =>
    h.prisma.postingJob.create({
      data: {
        orgId: t.orgId,
        campaignId,
        telegramDestinationId: destinationId,
        destinationType: 'TELEGRAM',
        idempotencyKey: `report-${Date.now()}-${n++}`,
        status,
        scheduledFor: day(due),
        nextAttemptAt: day(due),
        contentHash: 'h',
        completedAt:
          status === 'SUCCEEDED' || status === 'DEAD' ? day(due) : null,
      },
    });

  const world = async () => {
    const d1 = await activeDestination(h, t.orgId, { title: 'Alpha' });
    const d2 = await activeDestination(h, t.orgId, { title: 'Beta' });
    const c1 = await draftCampaign(h, t, [d1.id, d2.id], { name: 'Spring' });
    const c2 = await draftCampaign(h, t, [d1.id], { name: 'Summer' });
    return { d1, d2, c1, c2 };
  };

  it('counts exactly what was stored, per campaign, destination and day', async () => {
    const { d1, d2, c1, c2 } = await world();
    await job(c1.id, d1.id, 'SUCCEEDED', '2026-03-10');
    await job(c1.id, d2.id, 'SUCCEEDED', '2026-03-10');
    await job(c1.id, d2.id, 'DEAD', '2026-03-11');
    await job(c2.id, d1.id, 'SUCCEEDED', '2026-03-12');
    await job(c2.id, d1.id, 'BLOCKED', '2026-03-12');
    await job(c2.id, d1.id, 'PENDING', '2026-03-13');
    await job(c2.id, d1.id, 'UNCERTAIN', '2026-03-13');

    const r = await h.agency.getPublishingReport(t.analyst, {
      from: '2026-03-01',
      to: '2026-03-31',
    });
    expect(r.totals).toMatchObject({
      delivered: 3,
      failed: 1,
      paused: 1,
      queued: 1,
      uncertain: 1,
      deliveryRate: 75, // 3 / (3 + 1): only resolved posts count
    });
    const spring = r.campaigns.find((c) => c.name === 'Spring')!;
    expect(spring).toMatchObject({
      delivered: 2,
      failed: 1,
      deliveryRate: 66.7,
    });
    const summer = r.campaigns.find((c) => c.name === 'Summer')!;
    expect(summer).toMatchObject({
      delivered: 1,
      paused: 1,
      queued: 1,
      uncertain: 1,
    });
    const alpha = r.destinations.find((d) => d.title === 'Alpha')!;
    expect(alpha).toMatchObject({
      delivered: 2,
      paused: 1,
      queued: 1,
      uncertain: 1,
    });
    expect(r.daily).toHaveLength(31); // quiet days are present, not skipped
    expect(r.daily.find((x) => x.date === '2026-03-10')).toMatchObject({
      delivered: 2,
    });
    expect(r.daily.find((x) => x.date === '2026-03-11')).toMatchObject({
      failed: 1,
    });
    expect(r.daily.find((x) => x.date === '2026-03-20')).toMatchObject({
      delivered: 0,
      failed: 0,
      other: 0,
    });
    expect(r.range).toMatchObject({
      from: '2026-03-01',
      to: '2026-03-31',
      timezone: 'UTC',
    });
  });

  it('only counts posts due inside the period', async () => {
    const { d1, c1 } = await world();
    await job(c1.id, d1.id, 'SUCCEEDED', '2026-02-28');
    await job(c1.id, d1.id, 'SUCCEEDED', '2026-03-01'); // first day, included
    await job(c1.id, d1.id, 'SUCCEEDED', '2026-03-31'); // last day, included
    await job(c1.id, d1.id, 'SUCCEEDED', '2026-04-01');
    const r = await h.agency.getPublishingReport(t.manager, {
      from: '2026-03-01',
      to: '2026-03-31',
    });
    expect(r.totals.delivered).toBe(2);
  });

  it('has no rate, and invents nothing, when nothing has happened', async () => {
    await world();
    const r = await h.agency.getPublishingReport(t.manager, {
      from: '2026-03-01',
      to: '2026-03-31',
    });
    expect(r.totals).toMatchObject({
      delivered: 0,
      failed: 0,
      deliveryRate: null,
      trackedClicks: 0,
    });
    expect(r.campaigns).toEqual([]);
    expect(r.destinations).toEqual([]);
    // The report never carries impressions, views, reach or similar engagement figures.
    const keys = (v: unknown): string[] =>
      v && typeof v === 'object'
        ? Object.entries(v as object).flatMap(([k, x]) => [k, ...keys(x)])
        : [];
    expect(
      keys({
        totals: r.totals,
        campaigns: r.campaigns,
        destinations: r.destinations,
        daily: r.daily,
      })
    ).not.toEqual(expect.arrayContaining(['impressions']));
    expect(keys(r).join(' ')).not.toMatch(
      /impression|reach|views|engagement|ctr/i
    );
  });

  it('delivery rate stays empty while posts are only queued or paused', async () => {
    const { d1, c1 } = await world();
    await job(c1.id, d1.id, 'PENDING', '2026-03-10');
    await job(c1.id, d1.id, 'BLOCKED', '2026-03-10');
    const r = await h.agency.getPublishingReport(t.manager, {
      from: '2026-03-01',
      to: '2026-03-31',
    });
    expect(r.totals.deliveryRate).toBeNull();
    expect(r.campaigns[0].deliveryRate).toBeNull();
  });

  it('counts only real tracked clicks that fall inside the period', async () => {
    const { c1, c2 } = await world();
    const link = await h.agency.createTrackingLink(t.sales, c1.id, {
      destinationUrl: 'https://example.com/a',
    });
    const other = await h.agency.createTrackingLink(t.sales, c2.id, {
      destinationUrl: 'https://example.com/b',
    });
    const click = (trackingLinkId: string, at: string) =>
      h.prisma.linkClickEvent.create({
        data: { trackingLinkId, clickedAt: day(at) },
      });
    await click(link.id, '2026-03-05');
    await click(link.id, '2026-03-06');
    await click(link.id, '2026-04-20'); // outside the period
    await click(other.id, '2026-03-07');
    // Campaigns appear in the report because they had posts due in the period.
    const { d1 } = await world();
    await job(c1.id, d1.id, 'SUCCEEDED', '2026-03-05');
    await job(c2.id, d1.id, 'SUCCEEDED', '2026-03-05');

    const r = await h.agency.getPublishingReport(t.manager, {
      from: '2026-03-01',
      to: '2026-03-31',
    });
    expect(r.totals.trackedClicks).toBe(3);
    expect(r.campaigns.find((c) => c.name === 'Spring')!.trackedClicks).toBe(2);
    expect(r.campaigns.find((c) => c.name === 'Summer')!.trackedClicks).toBe(1);
  });

  it('can be limited to one client, and never reaches into another agency', async () => {
    const { d1, c1 } = await world();
    await job(c1.id, d1.id, 'SUCCEEDED', '2026-03-10');
    const second = await h.prisma.customer.create({
      data: { orgId: t.orgId, name: 'Second client' },
    });
    const c3 = await draftCampaign(h, t, [d1.id], {
      name: 'Other client work',
      customerId: second.id,
    });
    await job(c3.id, d1.id, 'DEAD', '2026-03-10');

    const range = { from: '2026-03-01', to: '2026-03-31' };
    const mine = await h.agency.getPublishingReport(t.manager, {
      ...range,
      customerId: t.customerId,
    });
    expect(mine.totals).toMatchObject({ delivered: 1, failed: 0 });
    const theirs = await h.agency.getPublishingReport(t.manager, {
      ...range,
      customerId: second.id,
    });
    expect(theirs.totals).toMatchObject({ delivered: 0, failed: 1 });

    const stranger = await seedTenant(h, 'reports-stranger');
    const nothing = await h.agency.getPublishingReport(stranger.manager, range);
    expect(nothing.totals.delivered).toBe(0);
    await expect(
      h.agency.getPublishingReport(stranger.manager, {
        ...range,
        customerId: t.customerId,
      })
    ).rejects.toThrow(NotFoundException);
  });

  it('is for staff only and validates the period', async () => {
    await expect(h.agency.getPublishingReport(t.client, {})).rejects.toThrow(
      ForbiddenException
    );
    await expect(
      h.agency.getPublishingReport(t.manager, { from: 'yesterday' })
    ).rejects.toThrow(BadRequestException);
    await expect(
      h.agency.getPublishingReport(t.manager, {
        from: '2026-04-01',
        to: '2026-03-01',
      })
    ).rejects.toThrow(/not be after/);
    await expect(
      h.agency.getPublishingReport(t.manager, {
        from: '2024-01-01',
        to: '2026-03-01',
      })
    ).rejects.toThrow(/one year/);
    const defaults = await h.agency.getPublishingReport(t.manager, {});
    expect(defaults.daily).toHaveLength(30); // the last 30 days by default
  });
});
