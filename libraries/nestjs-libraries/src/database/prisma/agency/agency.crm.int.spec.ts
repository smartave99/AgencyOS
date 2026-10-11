import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { agencyValidationPipe } from '@gitroom/nestjs-libraries/dtos/agency/agency.pipe';
import {
  CreateDealDto,
  MoveDealDto,
} from '@gitroom/nestjs-libraries/dtos/agency/crm.dto';
import {
  buildHarness,
  describeDb,
  Harness,
  seedTenant,
  Tenant,
} from './agency.test.support';

describeDb('CRM deal pipeline (real database)', () => {
  let h: Harness;
  let t: Tenant;
  let other: Tenant;

  beforeAll(async () => {
    h = await buildHarness();
  });
  afterAll(async () => {
    await h.prisma.$disconnect();
  });
  beforeEach(async () => {
    t = await seedTenant(h, 'crm');
    other = await seedTenant(h, 'crm-other');
  });

  const deal = (actor: Tenant['sales'], over: Partial<CreateDealDto> = {}) =>
    h.crm.createDeal(actor, {
      contactName: 'Priya Nair',
      companyName: 'Nair Foods',
      contactEmail: 'priya@nairfoods.test',
      value: 2500,
      ...over,
    });

  it('creates a deal owned by its creator, starting at PROSPECT, and audits it', async () => {
    const d = await deal(t.sales);
    expect(d).toMatchObject({
      stage: 'PROSPECT',
      ownerUserId: t.userIds.sales,
      currency: 'USD',
      companyName: 'Nair Foods',
    });
    expect(Number(d.value)).toBe(2500);
    expect(
      await h.prisma.auditEvent.count({
        where: { entityId: d.id, action: 'deal.created' },
      })
    ).toBe(1);
  });

  it('validates input: contact required, email shape, non-negative value, 3-letter currency', async () => {
    const pipe = (body: object) =>
      agencyValidationPipe.transform(body, {
        type: 'body',
        metatype: CreateDealDto,
      });
    await expect(pipe({})).rejects.toBeDefined();
    await expect(
      pipe({ contactName: 'A', contactEmail: 'not-an-email' })
    ).rejects.toBeDefined();
    await expect(pipe({ contactName: 'A', value: -5 })).rejects.toBeDefined();
    await expect(
      pipe({ contactName: 'A', currency: 'DOLLARS' })
    ).rejects.toBeDefined();
    await expect(
      pipe({ contactName: 'A', contactEmail: '' })
    ).resolves.toBeDefined(); // cleared field = none
    await expect(
      pipe({ contactName: 'A', ownerUserId: 'x', orgId: 'smuggled' })
    ).resolves.toEqual({ contactName: 'A', ownerUserId: 'x' });
  });

  describe('who sees what', () => {
    it('a sales executive sees and edits only their own deals; managers and owners see all', async () => {
      const mine = await deal(t.sales, { companyName: 'Mine' });
      const theirs = await deal(t.salesManager, { companyName: 'Theirs' });

      const executiveView = await h.crm.listDeals(t.sales);
      expect(executiveView.map((d) => d.companyName)).toEqual(['Mine']);
      await expect(
        h.crm.updateDeal(t.sales, theirs.id, { notes: 'peek' })
      ).rejects.toThrow(NotFoundException);
      await expect(
        h.crm.moveStage(t.sales, theirs.id, 'CONTACTED')
      ).rejects.toThrow(NotFoundException);
      await expect(h.crm.convertToClient(t.sales, theirs.id)).rejects.toThrow(
        NotFoundException
      );
      await expect(h.crm.deleteDeal(t.sales, mine.id)).rejects.toThrow(
        ForbiddenException
      ); // delete is manager-level

      expect(
        (await h.crm.listDeals(t.salesManager)).map((d) => d.companyName).sort()
      ).toEqual(['Mine', 'Theirs']);
      expect((await h.crm.listDeals(t.owner)).length).toBe(2);
    });

    it('executives cannot hand deals to others; managers can, but only to workspace members', async () => {
      await expect(
        deal(t.sales, { ownerUserId: t.userIds.manager })
      ).rejects.toThrow(/Only a sales manager/);
      const assigned = await deal(t.salesManager, {
        ownerUserId: t.userIds.sales,
      });
      expect(assigned.ownerUserId).toBe(t.userIds.sales);
      expect((await h.crm.listDeals(t.sales)).map((d) => d.id)).toContain(
        assigned.id
      );
      await expect(
        deal(t.salesManager, { ownerUserId: other.userIds.sales })
      ).rejects.toThrow(/not a member/);
    });

    it('analysts, campaign managers and client users have no access to the pipeline', async () => {
      for (const actor of [t.analyst, t.manager, t.client]) {
        await expect(h.crm.listDeals(actor)).rejects.toThrow(
          ForbiddenException
        );
        await expect(deal(actor)).rejects.toThrow(ForbiddenException);
        await expect(h.crm.summary(actor)).rejects.toThrow(ForbiddenException);
      }
    });

    it('another agency sees none of it and cannot touch it', async () => {
      const d = await deal(t.owner);
      expect(await h.crm.listDeals(other.owner)).toEqual([]);
      await expect(
        h.crm.updateDeal(other.owner, d.id, { notes: 'x' })
      ).rejects.toThrow(NotFoundException);
      await expect(h.crm.moveStage(other.owner, d.id, 'WON')).rejects.toThrow(
        NotFoundException
      );
      await expect(h.crm.deleteDeal(other.owner, d.id)).rejects.toThrow(
        NotFoundException
      );
      await expect(h.crm.convertToClient(other.owner, d.id)).rejects.toThrow(
        NotFoundException
      );
      expect(
        await h.prisma.deal.findUniqueOrThrow({ where: { id: d.id } })
      ).toMatchObject({ stage: 'PROSPECT', deletedAt: null });
    });
  });

  describe('stages', () => {
    it('moves between stages, recording when; LOST needs a reason, which is dropped if the deal is revived', async () => {
      const d = await deal(t.sales);
      const moved = await h.crm.moveStage(t.sales, d.id, 'PROPOSAL_SENT');
      expect(moved!.stage).toBe('PROPOSAL_SENT');
      expect(moved!.stageChangedAt.getTime()).toBeGreaterThanOrEqual(
        d.stageChangedAt.getTime()
      );

      await expect(h.crm.moveStage(t.sales, d.id, 'LOST')).rejects.toThrow(
        /why the deal was lost/
      );
      expect(
        (await h.crm.moveStage(t.sales, d.id, 'LOST', 'Budget cut'))!.lostReason
      ).toBe('Budget cut');
      const revived = await h.crm.moveStage(t.sales, d.id, 'CONTACTED');
      expect(revived).toMatchObject({ stage: 'CONTACTED', lostReason: null });
      expect(
        agencyValidationPipe.transform(
          { stage: 'ARCHIVED' },
          { type: 'body', metatype: MoveDealDto }
        )
      ).rejects.toBeDefined();
      const trail = await h.prisma.auditEvent.findMany({
        where: { entityId: d.id, action: 'deal.stage_changed' },
        orderBy: { createdAt: 'asc' },
      });
      expect(trail.map((a) => a.summary)).toEqual([
        'PROSPECT → PROPOSAL_SENT',
        'PROPOSAL_SENT → LOST',
        'LOST → CONTACTED',
      ]);
    });

    it('a move based on a stale view is rejected, so nothing is silently overwritten', async () => {
      const d = await deal(t.salesManager);
      const stale = await h.crm
        .listDeals(t.salesManager)
        .then((rows) => rows.find((r) => r.id === d.id)!);
      await h.crm.moveStage(t.owner, d.id, 'CONTACTED'); // someone else moves it first

      // The second person's request was prepared from the old PROSPECT view.
      const repo = (h.crm as any).crm;
      const spy = jest.spyOn(repo, 'getDeal').mockResolvedValueOnce(stale);
      await expect(
        h.crm.moveStage(t.salesManager, d.id, 'PROPOSAL_SENT')
      ).rejects.toThrow(ConflictException);
      spy.mockRestore();
      expect(
        (await h.prisma.deal.findUniqueOrThrow({ where: { id: d.id } })).stage
      ).toBe('CONTACTED');
    });

    it('the stage write itself is guarded on the stage that was read', async () => {
      const d = await deal(t.salesManager);
      const repo = (h.crm as any).crm;
      expect(
        await repo.setStage(t.orgId, d.id, 'PROSPECT', 'CONTACTED', null)
      ).toBe(true);
      expect(await repo.setStage(t.orgId, d.id, 'PROSPECT', 'WON', null)).toBe(
        false
      );
      expect(
        (await h.prisma.deal.findUniqueOrThrow({ where: { id: d.id } })).stage
      ).toBe('CONTACTED');
    });
  });

  describe('converting a won deal into a client', () => {
    it('creates one client carrying the contact details and owner, and refuses a second conversion', async () => {
      const d = await deal(t.sales, {
        companyName: 'Nair Foods',
        notes: 'wants Friday posts',
      });
      const { client, deal: linked } = await h.crm.convertToClient(
        t.sales,
        d.id
      );
      expect(client).toMatchObject({
        name: 'Nair Foods',
        email: 'priya@nairfoods.test',
        assignedSalesUserId: t.userIds.sales,
      });
      expect(linked!.customerId).toBe(client.id);
      await expect(h.crm.convertToClient(t.sales, d.id)).rejects.toThrow(
        ConflictException
      );
      expect(
        await h.prisma.customer.count({
          where: { orgId: t.orgId, name: 'Nair Foods' },
        })
      ).toBe(1);
      // and the new client is usable straight away for a campaign
      const c = await h.agency.createCampaign(t.sales, {
        customerId: client.id,
        name: 'First campaign',
        contentBody: 'Hello',
      });
      expect(c.status).toBe('DRAFT');
    });

    it('two simultaneous conversions create exactly one client link', async () => {
      const d = await deal(t.salesManager, { companyName: 'Race Co' });
      const results = await Promise.allSettled([
        h.crm.convertToClient(t.owner, d.id),
        h.crm.convertToClient(t.salesManager, d.id),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const row = await h.prisma.deal.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect(row.customerId).not.toBeNull();
    });
  });

  describe('summary', () => {
    it('reports stored counts and sums per stage, never mixing currencies, scoped to the viewer', async () => {
      const a = await deal(t.sales, { value: 1000 });
      await deal(t.sales, { value: 500 });
      await deal(t.salesManager, { value: 700, currency: 'eur' });
      const won = await deal(t.salesManager, { value: 9000 });
      await h.crm.moveStage(t.salesManager, won.id, 'WON');
      await h.crm.moveStage(t.sales, a.id, 'CONTACTED');

      const forManager = await h.crm.summary(t.salesManager);
      const stage = (s: string) =>
        forManager.stages.find((x) => x.stage === s)!;
      expect(stage('PROSPECT')).toMatchObject({
        count: 2,
        totals: { USD: 500, EUR: 700 },
      });
      expect(stage('CONTACTED')).toMatchObject({
        count: 1,
        totals: { USD: 1000 },
      });
      expect(stage('WON')).toMatchObject({ count: 1, totals: { USD: 9000 } });
      expect(stage('LOST')).toMatchObject({ count: 0, totals: {} });

      const forExecutive = await h.crm.summary(t.sales);
      expect(forExecutive.stages.reduce((n, s) => n + s.count, 0)).toBe(2); // only her two deals
    });
  });

  it('deleting is a soft delete by a manager, audited, and the deal disappears from the pipeline', async () => {
    const d = await deal(t.sales);
    await h.crm.deleteDeal(t.salesManager, d.id);
    expect(await h.crm.listDeals(t.owner)).toEqual([]);
    expect(
      (await h.prisma.deal.findUniqueOrThrow({ where: { id: d.id } })).deletedAt
    ).not.toBeNull();
    expect(
      await h.prisma.auditEvent.count({
        where: { entityId: d.id, action: 'deal.deleted' },
      })
    ).toBe(1);
  });
});
