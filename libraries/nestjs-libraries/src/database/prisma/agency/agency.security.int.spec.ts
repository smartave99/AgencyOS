import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AgencyRole } from '@prisma/client';
import { agencyValidationPipe } from '@gitroom/nestjs-libraries/dtos/agency/agency.pipe';
import { UpdateCampaignDto } from '@gitroom/nestjs-libraries/dtos/agency/campaign.dto';
import { IngestDocumentDto } from '@gitroom/nestjs-libraries/dtos/agency/intelligence.dto';
import { AGENCY_PERMISSIONS } from './agency.access.service';
import { AgencyIntelligenceService } from './agency.intelligence.service';
import {
  activeDestination,
  approvedCampaign,
  buildHarness,
  clearQueue,
  describeDb,
  draftCampaign,
  gatewayError,
  Harness,
  scheduledCampaign,
  seedTenant,
  Tenant,
} from './agency.test.support';

describe('permission matrix (no database needed)', () => {
  const roles = Object.values(AgencyRole);
  const holders = (p: keyof typeof AGENCY_PERMISSIONS) => AGENCY_PERMISSIONS[p];

  it('a CLIENT can only use the portal; no staff role can act as a client', () => {
    for (const [perm, allowed] of Object.entries(AGENCY_PERMISSIONS)) {
      if (perm.startsWith('portal:')) continue;
      expect(allowed).not.toContain(AgencyRole.CLIENT);
    }
    expect(holders('portal:review')).toEqual([AgencyRole.CLIENT]);
  });

  it('authors can write but only a smaller set can approve; sales executives and editors cannot', () => {
    expect(holders('campaign:approve')).not.toContain(
      AgencyRole.SALES_EXECUTIVE
    );
    expect(holders('campaign:approve')).not.toContain(
      AgencyRole.CONTENT_EDITOR
    );
    expect(holders('campaign:approve')).not.toContain(AgencyRole.ANALYST);
    expect(holders('campaign:write')).toContain(AgencyRole.SALES_EXECUTIVE);
  });

  it('WhatsApp: all staff may read, those who contact customers may work, fewer may erase, only admins configure, clients get nothing', () => {
    expect(holders('whatsapp:read')).toEqual(
      expect.arrayContaining([AgencyRole.ANALYST, AgencyRole.SALES_EXECUTIVE])
    );
    expect(holders('whatsapp:write')).toEqual(
      expect.arrayContaining([
        AgencyRole.SALES_EXECUTIVE,
        AgencyRole.SALES_MANAGER,
        AgencyRole.CAMPAIGN_MANAGER,
      ])
    );
    expect(holders('whatsapp:write')).not.toContain(AgencyRole.ANALYST);
    expect(holders('whatsapp:delete')).toEqual([
      AgencyRole.AGENCY_OWNER,
      AgencyRole.AGENCY_ADMIN,
      AgencyRole.SALES_MANAGER,
    ]);
    expect(holders('whatsapp:manage')).toEqual([
      AgencyRole.AGENCY_OWNER,
      AgencyRole.AGENCY_ADMIN,
    ]);
    for (const p of Object.keys(AGENCY_PERMISSIONS)) {
      if (p.startsWith('whatsapp:')) {
        expect(
          AGENCY_PERMISSIONS[p as keyof typeof AGENCY_PERMISSIONS]
        ).not.toContain(AgencyRole.CLIENT);
      }
    }
  });

  it('analysts are read-only', () => {
    for (const [perm, allowed] of Object.entries(AGENCY_PERMISSIONS)) {
      if (allowed.includes(AgencyRole.ANALYST)) {
        expect(perm).toMatch(/:(read|use|view)$/);
      }
    }
  });

  it('every permission is granted to at least one role, and the owner holds every staff permission', () => {
    for (const [perm, allowed] of Object.entries(AGENCY_PERMISSIONS)) {
      expect(allowed.length).toBeGreaterThan(0);
      if (perm !== 'portal:review')
        expect(allowed).toContain(AgencyRole.AGENCY_OWNER);
    }
    expect(roles).toHaveLength(8);
  });

  it('the validation pipe strips fields a client tries to smuggle in (status cannot be set through the update DTO)', async () => {
    const out = await agencyValidationPipe.transform(
      {
        name: 'ok',
        status: 'APPROVED',
        orgId: 'someone-else',
        approvedContentHash: 'x',
      },
      { type: 'body', metatype: UpdateCampaignDto }
    );
    expect(out).toEqual({ name: 'ok' });
  });

  it('URLs in the campaign DTO must be http(s): javascript: and data: links are rejected', async () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://x.test/a',
    ]) {
      await expect(
        agencyValidationPipe.transform(
          { ctaLink: bad },
          { type: 'body', metatype: UpdateCampaignDto }
        )
      ).rejects.toBeDefined();
    }
    await expect(
      agencyValidationPipe.transform(
        { ctaLink: 'https://example.com/x' },
        { type: 'body', metatype: UpdateCampaignDto }
      )
    ).resolves.toEqual({ ctaLink: 'https://example.com/x' });
  });

  it('discussion ingestion requires the authorization attestation', async () => {
    await expect(
      agencyValidationPipe.transform(
        { title: 't', content: 'c' },
        { type: 'body', metatype: IngestDocumentDto }
      )
    ).rejects.toBeDefined();
  });
});

describeDb('security and tenancy (real database)', () => {
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
    await clearQueue(h);
    t = await seedTenant(h, 'tenantA');
    other = await seedTenant(h, 'tenantB');
    h.gateway.sent = [];
    h.gateway.sendErrors.clear();
  });

  // ---------------------------------------------------------------- scenario 9
  describe("9. one agency cannot access another agency's data", () => {
    it("cannot read, change, cancel or export another tenant's campaign", async () => {
      const d = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [d.id]);
      await expect(h.agency.getCampaignById(other.owner, id)).rejects.toThrow(
        NotFoundException
      );
      await expect(
        h.agency.updateCampaign(other.owner, id, { name: 'hijacked' })
      ).rejects.toThrow(NotFoundException);
      await expect(h.agency.cancelCampaign(other.owner, id)).rejects.toThrow(
        NotFoundException
      );
      await expect(h.agency.pauseCampaign(other.owner, id)).rejects.toThrow(
        NotFoundException
      );
      await expect(h.agency.deleteCampaign(other.owner, id)).rejects.toThrow(
        NotFoundException
      );
      await expect(
        h.agency.generateCampaignCsvReport(other.owner, id)
      ).rejects.toThrow(NotFoundException);
      await expect(h.agency.getCampaignJobs(other.owner, id)).rejects.toThrow(
        NotFoundException
      );
      await expect(
        h.agency.createTrackingLink(other.owner, id, {
          destinationUrl: 'https://x.test',
        })
      ).rejects.toThrow(NotFoundException);
      expect(
        (await h.agency.getCampaigns(other.owner)).map((c) => c.id)
      ).not.toContain(id);
      expect(
        (await h.prisma.campaign.findUniqueOrThrow({ where: { id } })).name
      ).not.toBe('hijacked');
    });

    it("cannot decide another tenant's approval request", async () => {
      const d = await activeDestination(h, t.orgId);
      const c = await draftCampaign(h, t, [d.id]);
      const approval = await h.agency.submitForApproval(t.sales, c.id);
      await expect(
        h.agency.reviewCampaign(other.owner, approval.id, 'APPROVE')
      ).rejects.toThrow(NotFoundException);
      expect(await h.agency.getApprovals(other.owner)).toHaveLength(0);
    });

    it("cannot attach another tenant's client, Telegram destination or social account to a campaign", async () => {
      const foreignDest = await activeDestination(h, other.orgId);
      const own = await activeDestination(h, t.orgId);
      await expect(
        draftCampaign(h, other, [], { customerId: t.customerId })
      ).rejects.toThrow(NotFoundException);
      await expect(draftCampaign(h, t, [foreignDest.id])).rejects.toThrow(
        NotFoundException
      );

      const mine = await draftCampaign(h, t, [own.id]);
      await expect(
        h.agency.updateCampaignDestinations(t.sales, mine.id, [
          {
            destinationType: 'TELEGRAM',
            telegramDestinationId: foreignDest.id,
          },
        ])
      ).rejects.toThrow(NotFoundException);

      const foreignIntegration = await h.prisma.integration.create({
        data: {
          organizationId: other.orgId,
          internalId: 'f1',
          name: 'Foreign',
          providerIdentifier: 'x',
          type: 'social',
          token: 'SECRET-TOKEN',
        },
      });
      await expect(
        h.agency.updateCampaignDestinations(t.sales, mine.id, [
          { destinationType: 'SOCIAL', integrationId: foreignIntegration.id },
        ])
      ).rejects.toThrow(NotFoundException);
      await expect(
        h.platforms.assignAccountClient(
          t.manager,
          foreignIntegration.id,
          t.customerId
        )
      ).rejects.toThrow(NotFoundException);
    });

    it("cannot manage another tenant's Telegram destination", async () => {
      const foreign = await activeDestination(h, t.orgId);
      await expect(
        h.telegram.revoke(other.manager, foreign.id)
      ).rejects.toThrow(NotFoundException);
      await expect(
        h.telegram.suspend(other.manager, foreign.id)
      ).rejects.toThrow(NotFoundException);
      await expect(
        h.telegram.restartVerification(other.manager, foreign.id)
      ).rejects.toThrow(NotFoundException);
      await expect(
        h.telegram.refreshHealth(other.manager, foreign.id)
      ).rejects.toThrow(NotFoundException);
      await expect(
        h.telegram.remove(other.manager, foreign.id)
      ).rejects.toThrow(NotFoundException);
      expect(await h.telegram.listDestinations(other.owner)).toHaveLength(0);
      expect(
        (
          await h.prisma.telegramDestination.findUniqueOrThrow({
            where: { id: foreign.id },
          })
        ).authorizationStatus
      ).toBe('ACTIVE');
    });

    it("cannot see or bill another tenant's clients, jobs, portal or users", async () => {
      await expect(
        h.agency.getClientById(other.owner, t.customerId)
      ).rejects.toThrow(NotFoundException);
      await expect(
        h.agency.createInvoice(other.owner, {
          customerId: t.customerId,
          amount: 10,
        })
      ).rejects.toThrow(NotFoundException);
      await expect(
        h.portal.getClientPortalData(other.owner, t.customerId)
      ).rejects.toThrow(NotFoundException);
      await expect(
        h.access.setRole(other.owner, t.userIds.sales, AgencyRole.ANALYST)
      ).rejects.toThrow(NotFoundException);
      expect(
        (await h.agency.getClients(other.owner)).map((c) => c.id)
      ).not.toContain(t.customerId);
    });

    it('repository writes are org-scoped even if a service check were missed (defence in depth)', async () => {
      const d = await activeDestination(h, t.orgId);
      const c = await draftCampaign(h, t, [d.id]);
      const inv = await h.agency.createInvoice(t.owner, {
        customerId: t.customerId,
        amount: 50,
      });

      await h.agencyRepo.updateCampaign(other.orgId, c.id, { name: 'hacked' });
      await h.agencyRepo.deleteCampaign(other.orgId, c.id);
      await h.agencyRepo.updateClient(other.orgId, t.customerId, {
        name: 'hacked',
      });
      await h.agencyRepo.deleteClient(other.orgId, t.customerId);
      await h.agencyRepo.deleteTelegramDestination(other.orgId, d.id);
      await h.agencyRepo.updateAgencyInvoiceStatus(
        other.orgId,
        inv.id,
        'PAID',
        new Date()
      );
      await h.agencyRepo.setDestinationAuthorization(other.orgId, d.id, {
        authorizationStatus: 'REVOKED',
      });

      expect(
        await h.prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })
      ).toMatchObject({ deletedAt: null });
      expect(
        (await h.prisma.campaign.findUniqueOrThrow({ where: { id: c.id } }))
          .name
      ).not.toBe('hacked');
      const client = await h.prisma.customer.findUniqueOrThrow({
        where: { id: t.customerId },
      });
      expect(client.deletedAt).toBeNull();
      expect(client.name).not.toBe('hacked');
      expect(
        await h.prisma.telegramDestination.findUniqueOrThrow({
          where: { id: d.id },
        })
      ).toMatchObject({ deletedAt: null, authorizationStatus: 'ACTIVE' });
      expect(
        (
          await h.prisma.agencyInvoice.findUniqueOrThrow({
            where: { id: inv.id },
          })
        ).status
      ).not.toBe('PAID');
    });

    it("two agencies can register the same chat independently; neither gets the other's consent", async () => {
      const a = await h.telegram.registerDestination(t.manager, {
        chatId: '-1005550001',
      });
      const b = await h.telegram.registerDestination(other.manager, {
        chatId: '-1005550001',
      });
      expect(a.verificationCode).not.toBe(b.verificationCode);
      h.gateway.makeAdmin('-1005550001', 9);
      await h.telegram.handleUpdate({
        update_id: 5,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: -1005550001, type: 'channel', title: 'Shared' },
          from: { id: 9, is_bot: false, first_name: 'Admin' },
          text: `/authorize ${a.verificationCode}`,
        } as any,
      });
      const rows = await h.prisma.telegramDestination.findMany({
        where: { chatId: '-1005550001' },
      });
      expect(rows.find((r) => r.orgId === t.orgId)!.authorizationStatus).toBe(
        'ACTIVE'
      );
      expect(
        rows.find((r) => r.orgId === other.orgId)!.authorizationStatus
      ).toBe('PENDING_VERIFICATION');
    });

    it('intelligence data does not cross tenants', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockRejectedValue(new Error('no ollama')) as any;
      try {
        const intel = new AgencyIntelligenceService(h.agencyRepo, h.access);
        await intel.ingestDocument(t.owner, {
          title: 'Pricing questions',
          content: 'customers keep asking about pricing and delivery fees',
          authorizationConfirmed: true,
        } as any);
        const mine = await intel.searchKnowledge(t.owner, {
          query: 'pricing delivery',
        } as any);
        const theirs = await intel.searchKnowledge(other.owner, {
          query: 'pricing delivery',
        } as any);
        expect(mine.results.length).toBe(1);
        expect(theirs.results).toHaveLength(0);
        const foreignDest = await activeDestination(h, other.orgId);
        await expect(
          intel.ingestDocument(t.owner, {
            title: 'x',
            content: 'y',
            authorizationConfirmed: true,
            telegramDestId: foreignDest.id,
          } as any)
        ).rejects.toThrow(NotFoundException);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  // ---------------------------------------------------------------- roles
  describe('role enforcement', () => {
    it('a sales executive can author and submit but cannot approve, publish, delete or administer', async () => {
      const d = await activeDestination(h, t.orgId);
      const c = await draftCampaign(h, t, [d.id]);
      const approval = await h.agency.submitForApproval(t.sales, c.id);
      await expect(
        h.agency.reviewCampaign(t.sales, approval.id, 'APPROVE')
      ).rejects.toThrow(ForbiddenException);
      const approved = await approvedCampaign(h, t, [d.id]);
      await expect(
        h.agency.scheduleCampaign(t.sales, approved)
      ).rejects.toThrow(ForbiddenException);
      await expect(
        h.agency.publishCampaignNow(t.sales, approved)
      ).rejects.toThrow(ForbiddenException);
      await expect(h.agency.deleteCampaign(t.sales, approved)).rejects.toThrow(
        ForbiddenException
      );
      await expect(
        h.agency.createInvoice(t.sales, { customerId: t.customerId, amount: 5 })
      ).rejects.toThrow(ForbiddenException);
      await expect(
        h.telegram.registerDestination(t.sales, { chatId: '-100777' })
      ).rejects.toThrow(ForbiddenException);
      await expect(
        h.access.setRole(t.sales, t.userIds.analyst, AgencyRole.AGENCY_ADMIN)
      ).rejects.toThrow(ForbiddenException);
      await expect(h.access.listAudit(t.sales, {})).rejects.toThrow(
        ForbiddenException
      );
    });

    it('an analyst can read but not change anything', async () => {
      await expect(h.agency.getCampaigns(t.analyst)).resolves.toBeDefined();
      await expect(h.agency.getDashboard(t.analyst)).resolves.toBeDefined();
      await expect(
        draftCampaign(h, { ...t, sales: t.analyst }, [])
      ).rejects.toThrow(ForbiddenException);
      await expect(
        h.agency.createClient(t.analyst, { name: 'x' })
      ).rejects.toThrow(ForbiddenException);
    });

    it('a client user is shut out of every internal surface', async () => {
      await expect(h.agency.getCampaigns(t.client)).rejects.toThrow(
        ForbiddenException
      );
      await expect(h.agency.getClients(t.client)).rejects.toThrow(
        ForbiddenException
      );
      await expect(h.agency.getDashboard(t.client)).rejects.toThrow(
        ForbiddenException
      );
      await expect(h.agency.getInvoices(t.client)).rejects.toThrow(
        ForbiddenException
      );
      await expect(h.telegram.listDestinations(t.client)).rejects.toThrow(
        ForbiddenException
      );
      await expect(h.platforms.getConnectedAccounts(t.client)).rejects.toThrow(
        ForbiddenException
      );
    });

    it('roles default safely: an unassigned workspace member is never an approver', async () => {
      const plain = await h.access.resolveActor(
        { id: t.orgId },
        { id: t.userIds.sales },
        'USER'
      );
      // sales has no explicit row in the seed, so the derived role applies
      expect(plain.role).toBe(AgencyRole.SALES_EXECUTIVE);
      const admin = await h.access.resolveActor(
        { id: t.orgId },
        { id: 'nobody' },
        'ADMIN'
      );
      expect(admin.role).toBe(AgencyRole.AGENCY_ADMIN);
      const owner = await h.access.resolveActor(
        { id: t.orgId },
        { id: 'nobody' },
        'SUPERADMIN'
      );
      expect(owner.role).toBe(AgencyRole.AGENCY_OWNER);
    });

    it('team roles: only owners/admins assign; no self-edits; owner grants are owner-only; clients need a client', async () => {
      await expect(
        h.access.setRole(t.manager, t.userIds.sales, AgencyRole.SALES_MANAGER)
      ).rejects.toThrow(ForbiddenException);
      await expect(
        h.access.setRole(t.owner, t.userIds.owner, AgencyRole.ANALYST)
      ).rejects.toThrow(/own role/);
      await expect(
        h.access.setRole(t.owner, t.userIds.sales, AgencyRole.CLIENT)
      ).rejects.toThrow(/linked to a client/);
      const adminActor = { ...t.owner, role: AgencyRole.AGENCY_ADMIN };
      await expect(
        h.access.setRole(adminActor, t.userIds.sales, AgencyRole.AGENCY_OWNER)
      ).rejects.toThrow(/Owner role/);

      await h.access.setRole(
        t.owner,
        t.userIds.sales,
        AgencyRole.SALES_MANAGER
      );
      const promoted = await h.access.resolveActor(
        { id: t.orgId },
        { id: t.userIds.sales },
        'USER'
      );
      expect(promoted.role).toBe(AgencyRole.SALES_MANAGER);
      const audit = await h.prisma.auditEvent.findFirst({
        where: { orgId: t.orgId, action: 'team.role_changed' },
      });
      expect(audit).toMatchObject({
        actorUserId: t.userIds.owner,
        entityId: t.userIds.sales,
      });
      const team = await h.access.listTeam(t.owner);
      expect(team.find((m) => m.userId === t.userIds.sales)).toMatchObject({
        agencyRole: 'SALES_MANAGER',
        roleSource: 'ASSIGNED',
      });
    });
  });

  // ---------------------------------------------------------------- workflow integrity
  describe('approval workflow integrity', () => {
    it('status cannot be forced through the update call', async () => {
      const d = await activeDestination(h, t.orgId);
      const c = await draftCampaign(h, t, [d.id]);
      await h.agency.updateCampaign(t.sales, c.id, {
        name: 'renamed',
        status: 'APPROVED',
      } as any);
      const after = await h.prisma.campaign.findUniqueOrThrow({
        where: { id: c.id },
      });
      expect(after.status).toBe('DRAFT');
      expect(after.approvedContentHash).toBeNull();
    });

    it('four-eyes: you cannot approve your own submission, except owners/admins, which is recorded', async () => {
      const d = await activeDestination(h, t.orgId);
      const mine = await draftCampaign(h, { ...t, sales: t.salesManager }, [
        d.id,
      ]);
      const approval = await h.agency.submitForApproval(
        t.salesManager,
        mine.id
      );
      await expect(
        h.agency.reviewCampaign(t.salesManager, approval.id, 'APPROVE')
      ).rejects.toThrow(/different reviewer/);

      const ownersOwn = await draftCampaign(h, { ...t, sales: t.owner }, [
        d.id,
      ]);
      const ownerApproval = await h.agency.submitForApproval(
        t.owner,
        ownersOwn.id
      );
      const res = await h.agency.reviewCampaign(
        t.owner,
        ownerApproval.id,
        'APPROVE'
      );
      expect(res!.selfApproved).toBe(true);
    });

    it('two reviewers deciding at once: exactly one wins', async () => {
      const d = await activeDestination(h, t.orgId);
      const c = await draftCampaign(h, t, [d.id]);
      const approval = await h.agency.submitForApproval(t.sales, c.id);
      const results = await Promise.allSettled([
        h.agency.reviewCampaign(t.manager, approval.id, 'APPROVE'),
        h.agency.reviewCampaign(t.owner, approval.id, 'REJECT', 'no'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rows = await h.prisma.approvalRequest.findMany({
        where: { campaignId: c.id },
      });
      expect(rows).toHaveLength(1);
      expect(['APPROVED', 'CHANGES_REQUESTED']).toContain(rows[0].status);
      const camp = await h.prisma.campaign.findUniqueOrThrow({
        where: { id: c.id },
      });
      expect(camp.status).toBe(
        rows[0].status === 'APPROVED' ? 'APPROVED' : 'CHANGES_REQUESTED'
      );
    });

    it('resubmitting withdraws the old request so the inbox never shows stale items', async () => {
      const d = await activeDestination(h, t.orgId);
      const c = await draftCampaign(h, t, [d.id]);
      const first = await h.agency.submitForApproval(t.sales, c.id);
      await h.agency.reviewCampaign(
        t.manager,
        first.id,
        'REJECT',
        'tighten the copy'
      );
      await h.agency.updateCampaign(t.sales, c.id, {
        contentBody: 'Tighter copy.',
      });
      await h.agency.submitForApproval(t.sales, c.id);
      const pending = await h.agency.getApprovals(t.manager, 'PENDING');
      expect(pending.filter((a) => a.campaignId === c.id)).toHaveLength(1);
    });

    it('a cancelled campaign leaves no pending approval behind', async () => {
      const d = await activeDestination(h, t.orgId);
      const c = await draftCampaign(h, t, [d.id]);
      await h.agency.submitForApproval(t.sales, c.id);
      await h.agency.cancelCampaign(t.manager, c.id);
      expect(
        (await h.agency.getApprovals(t.manager, 'PENDING')).filter(
          (a) => a.campaignId === c.id
        )
      ).toHaveLength(0);
    });

    it('duplicating a campaign yields a fresh, unapproved draft', async () => {
      const d = await activeDestination(h, t.orgId);
      const id = await approvedCampaign(h, t, [d.id]);
      const copy = await h.agency.duplicateCampaign(t.sales, id);
      const row = await h.prisma.campaign.findUniqueOrThrow({
        where: { id: copy.id },
        include: { destinations: true },
      });
      expect(row).toMatchObject({ status: 'DRAFT', approvedContentHash: null });
      expect(row.destinations).toHaveLength(1);
      expect(row.name).toMatch(/\(copy\)$/);
    });

    it('every state change is in the audit trail', async () => {
      const d = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [d.id]);
      await h.publishing.dispatchDue();
      const actions = (
        await h.prisma.auditEvent.findMany({
          where: { orgId: t.orgId, entityId: id },
          orderBy: { createdAt: 'asc' },
        })
      ).map((a) => a.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'campaign.created',
          'campaign.submitted',
          'campaign.approved',
          'campaign.scheduled',
          'campaign.status_derived',
        ])
      );
    });
  });

  // ---------------------------------------------------------------- client portal
  describe('client portal', () => {
    it('shows a client only their own work and no internal fields', async () => {
      const d = await activeDestination(h, t.orgId);
      const second = await h.prisma.customer.create({
        data: { orgId: t.orgId, name: 'Other client' },
      });
      const mine = await draftCampaign(h, t, [d.id], {
        name: 'Mine',
        internalNotes: 'margin is 40%',
        budget: 9999,
      });
      await h.agency.submitForApproval(t.sales, mine.id);
      await draftCampaign(h, t, [d.id], { name: 'Unfinished draft' });
      await draftCampaign(h, t, [], { name: 'Theirs', customerId: second.id });

      const view = await h.portal.getClientPortalData(t.client, second.id); // tries to name another client
      expect(view.client.id).toBe(t.customerId); // pinned to its own regardless
      // Their submitted ad shows; an unfinished draft and another client's work do not.
      expect(view.campaigns.map((c) => c.name)).toEqual(['Mine']);
      expect(JSON.stringify(view)).not.toMatch(
        /margin|9999|internalNotes|budget/
      );
      expect(view.viewer).toEqual({ isClient: true, canReview: true });
    });

    it('shows the client the ad exactly as it will be sent, with markup neutralised', async () => {
      const d = await activeDestination(h, t.orgId);
      const c = await draftCampaign(h, t, [d.id], {
        contentBody: '<b>Big sale</b> <script>alert(1)</script>',
        ctaLink: 'https://example.com/sale',
        ctaText: 'Shop now',
      });
      await h.agency.submitForApproval(t.sales, c.id);
      const view = await h.portal.getClientPortalData(t.client);
      const html = view.campaigns.find((x) => x.id === c.id)!.preview.html;
      expect(html).toContain('<b>Big sale</b>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<script>');
      expect(html).toContain('https://example.com/sale');
    });

    it('staff can preview but cannot act as the client', async () => {
      const view = await h.portal.getClientPortalData(t.sales, t.customerId);
      expect(view.viewer).toEqual({ isClient: false, canReview: false });
      await expect(
        h.portal.clientReviewCampaign(t.sales, 'x', 'APPROVE')
      ).rejects.toThrow(ForbiddenException);
      await expect(
        h.portal.clientReviewCampaign(t.manager, 'x', 'APPROVE')
      ).rejects.toThrow(ForbiddenException);
    });

    it("client sign-off is recorded under the client's own identity and gates the agency approval", async () => {
      const d = await activeDestination(h, t.orgId);
      const c = await draftCampaign(h, t, [d.id], {
        requiresClientApproval: true,
      });
      const approval = await h.agency.submitForApproval(t.sales, c.id);
      await expect(
        h.agency.reviewCampaign(t.manager, approval.id, 'APPROVE')
      ).rejects.toThrow(/client has not approved/);

      await h.portal.clientReviewCampaign(
        t.client,
        c.id,
        'APPROVE',
        'looks great'
      );
      const row = await h.prisma.campaign.findUniqueOrThrow({
        where: { id: c.id },
      });
      expect(row.clientApprovedByUserId).toBe(t.userIds.client); // not the campaign creator
      expect(row.status).toBe('SUBMITTED'); // client approval alone never publishes or approves
      await h.agency.reviewCampaign(t.manager, approval.id, 'APPROVE');
      expect(
        await h.prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })
      ).toMatchObject({ status: 'APPROVED' });

      const audit = await h.prisma.auditEvent.findFirst({
        where: { entityId: c.id, action: 'campaign.client_approved' },
      });
      expect(audit!.actorUserId).toBe(t.userIds.client);
    });

    it("a client cannot review another client's campaign, and change requests need feedback", async () => {
      const d = await activeDestination(h, t.orgId);
      const second = await h.prisma.customer.create({
        data: { orgId: t.orgId, name: 'Rival' },
      });
      const theirs = await draftCampaign(h, t, [d.id], {
        customerId: second.id,
      });
      await h.agency.submitForApproval(t.sales, theirs.id);
      await expect(
        h.portal.clientReviewCampaign(t.client, theirs.id, 'APPROVE')
      ).rejects.toThrow(NotFoundException);

      const mine = await draftCampaign(h, t, [d.id]);
      await h.agency.submitForApproval(t.sales, mine.id);
      await expect(
        h.portal.clientReviewCampaign(t.client, mine.id, 'REQUEST_CHANGES')
      ).rejects.toThrow(/what to change/);
      await h.portal.clientReviewCampaign(
        t.client,
        mine.id,
        'REQUEST_CHANGES',
        'Wrong price'
      );
      expect(
        (await h.prisma.campaign.findUniqueOrThrow({ where: { id: mine.id } }))
          .status
      ).toBe('CHANGES_REQUESTED');
    });
  });

  // ---------------------------------------------------------------- scenario 10
  describe('10. reports use genuine stored metrics', () => {
    it('the CSV reflects exactly what was delivered, failed and clicked, and invents nothing', async () => {
      const [ok, bad] = await Promise.all([
        activeDestination(h, t.orgId, { title: 'Good channel' }),
        activeDestination(h, t.orgId, { title: 'Bad channel' }),
      ]);
      const id = await scheduledCampaign(h, t, [ok.id, bad.id]);
      h.gateway.failSendsTo(
        bad.chatId,
        gatewayError('BAD_REQUEST', 'wrong file')
      );
      await h.publishing.dispatchDue();

      const link = await h.agency.createTrackingLink(t.sales, id, {
        destinationUrl: 'https://example.com/landing',
        utmSource: 'telegram',
      });
      const human = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120';
      await h.agency.resolveTrackingLinkAndRecordClick(
        link.shortCode,
        '203.0.113.5',
        human
      );
      await h.agency.resolveTrackingLinkAndRecordClick(
        link.shortCode,
        '203.0.113.6',
        human
      );
      await h.agency.resolveTrackingLinkAndRecordClick(
        link.shortCode,
        '149.154.161.1',
        'TelegramBot (like TwitterBot)'
      ); // link preview fetch
      await new Promise((r) => setTimeout(r, 200)); // clicks are recorded off the redirect path

      const csv = await h.agency.generateCampaignCsvReport(t.analyst, id);
      expect(csv).toContain('"Delivered","1"');
      expect(csv).toContain('"Failed","1"');
      expect(csv).toContain('"Tracked link clicks","2"'); // the preview bot is not a click
      expect(csv).toContain(h.gateway.sent[0].messageId);
      expect(csv).toContain('"Status","PARTIALLY_FAILED"');
      expect(csv.toLowerCase()).not.toMatch(/impression|reach/);
    });

    it('a campaign that has not published reports zeros, not estimates', async () => {
      const d = await activeDestination(h, t.orgId);
      const id = await approvedCampaign(h, t, [d.id]);
      const csv = await h.agency.generateCampaignCsvReport(t.owner, id);
      expect(csv).toContain('"Delivered","0"');
      expect(csv).toContain('"Tracked link clicks","0"');
    });

    it('spreadsheet formulas in user text are neutralised', async () => {
      const d = await activeDestination(h, t.orgId);
      const c = await draftCampaign(h, t, [d.id], {
        name: '=HYPERLINK("http://evil.test","click")',
      });
      const csv = await h.agency.generateCampaignCsvReport(t.owner, c.id);
      expect(csv).toContain(`"'=HYPERLINK(""http://evil.test"",""click"")"`);
    });

    it('delivery rate is null (not 100%) when nothing has been sent', async () => {
      const dash = await h.agency.getDashboard(t.owner);
      expect(dash.deliveryRate).toBeNull();
      expect(dash.successfulPosts).toBe(0);
    });
  });

  // ---------------------------------------------------------------- tracking
  describe('tracking links', () => {
    it('only http(s) destinations are accepted, and a poisoned stored URL is never redirected to', async () => {
      const d = await activeDestination(h, t.orgId);
      const c = await draftCampaign(h, t, [d.id]);
      await expect(
        h.agency.createTrackingLink(t.sales, c.id, {
          destinationUrl: 'javascript:alert(1)',
        })
      ).rejects.toThrow(/http/);
      const bad = await h.prisma.trackingLink.create({
        data: {
          campaignId: c.id,
          shortCode: `poison${Math.random().toString(36).slice(2, 8)}`,
          destinationUrl: 'javascript:alert(document.cookie)',
        },
      });
      await expect(
        h.agency.resolveTrackingLinkAndRecordClick(
          bad.shortCode,
          '1.1.1.1',
          'Chrome'
        )
      ).rejects.toThrow(NotFoundException);
    });

    it('UTM parameters are appended and no raw IP is stored', async () => {
      const d = await activeDestination(h, t.orgId);
      const c = await draftCampaign(h, t, [d.id]);
      const link = await h.agency.createTrackingLink(t.sales, c.id, {
        destinationUrl: 'https://example.com/p?x=1',
        utmSource: 'telegram',
        utmMedium: 'ad',
        utmCampaign: 'spring',
      });
      const target = await h.agency.resolveTrackingLinkAndRecordClick(
        link.shortCode,
        '198.51.100.23',
        'Safari'
      );
      expect(new URL(target).searchParams.get('utm_source')).toBe('telegram');
      expect(new URL(target).searchParams.get('x')).toBe('1');
      await new Promise((r) => setTimeout(r, 150));
      const click = await h.prisma.linkClickEvent.findFirstOrThrow({
        where: { trackingLinkId: link.id },
      });
      expect(click.ipHash).toMatch(/^[0-9a-f]{16}$/);
      expect(JSON.stringify(click)).not.toContain('198.51.100.23');
    });
  });

  // ---------------------------------------------------------------- invoices
  describe('invoices', () => {
    it('numbers are sequential and unique even when created concurrently', async () => {
      const made = await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          h.agency.createInvoice(t.owner, {
            customerId: t.customerId,
            amount: n * 10,
          })
        )
      );
      const numbers = made.map((i) => i.invoiceNumber).sort();
      expect(new Set(numbers).size).toBe(5);
      expect(numbers[0]).toMatch(/^INV-\d{4}-0001$/);
      expect(numbers[4]).toMatch(/^INV-\d{4}-0005$/);
    });

    it('rejects non-positive amounts', async () => {
      await expect(
        h.agency.createInvoice(t.owner, { customerId: t.customerId, amount: 0 })
      ).rejects.toThrow(/greater than zero/);
    });
  });

  // ---------------------------------------------------------------- connected accounts
  describe('connected accounts', () => {
    it('never loads OAuth tokens into agency code, and says when a check is not live', async () => {
      const acct = await h.prisma.integration.create({
        data: {
          organizationId: t.orgId,
          internalId: 'ig1',
          name: 'Shop IG',
          providerIdentifier: 'instagram',
          type: 'social',
          token: 'TOP-SECRET',
          refreshToken: 'ALSO-SECRET',
        },
      });
      const list = await h.platforms.getConnectedAccounts(t.manager);
      expect(JSON.stringify(list)).not.toMatch(/SECRET/);
      const test = await h.platforms.testAccountConnection(t.manager, acct.id);
      expect(test.checkedLive).toBe(false);
      expect(test.message).toMatch(/provider was not contacted/);
      expect(
        JSON.stringify(await h.agencyRepo.getIntegrationById(t.orgId, acct.id))
      ).not.toMatch(/SECRET/);
    });

    it('does not invent capabilities for networks it has no data on', async () => {
      const unknown = h.platforms.getCapability('some-new-network');
      expect(unknown).toMatchObject({
        catalogued: false,
        schedulingSupported: false,
        supportsImages: false,
      });
      expect(h.platforms.getCapability('telegram').catalogued).toBe(true);
      const withInvented = h.platforms
        .getPlatformCapabilities()
        .filter(
          (c) =>
            c.identifier !== 'telegram' && c.rateLimitPerMinute !== undefined
        );
      expect(withInvented).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------- intelligence
  describe('discussion intelligence', () => {
    let intel: AgencyIntelligenceService;
    let realFetch: typeof fetch;
    beforeEach(() => {
      intel = new AgencyIntelligenceService(h.agencyRepo, h.access);
      realFetch = global.fetch;
    });
    afterEach(() => {
      global.fetch = realFetch;
      delete process.env.OPENAI_API_KEY;
      delete process.env.AGENCY_ALLOW_EXTERNAL_AI;
    });

    it('refuses content without the authorization attestation, and labels keyword search honestly', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as any;
      await expect(
        intel.ingestDocument(t.owner, { title: 'a', content: 'b' } as any)
      ).rejects.toThrow(/Confirm that this content/);
      await intel.ingestDocument(t.owner, {
        title: 'Delivery complaints',
        content: 'many customers complain about slow delivery times',
        authorizationConfirmed: true,
      } as any);
      const res = await intel.searchKnowledge(t.owner, {
        query: 'slow delivery',
      } as any);
      expect(res).toMatchObject({
        method: 'lexical-hash-128',
        semantic: false,
      });
      expect(res.results[0].title).toBe('Delivery complaints');
      expect(
        (await intel.getIntelligenceAnalytics(t.owner)).sentimentMethod
      ).toBe('keyword-lexicon');
    });

    it('does not send discussion text to a third-party API unless the operator opts in', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      const calls: string[] = [];
      global.fetch = jest.fn(async (url: any) => {
        calls.push(String(url));
        throw new Error('offline');
      }) as any;
      await intel.ingestDocument(t.owner, {
        title: 'Private chatter',
        content: 'sensitive group discussion',
        authorizationConfirmed: true,
      } as any);
      expect(calls.some((u) => u.includes('openai.com'))).toBe(false);

      process.env.AGENCY_ALLOW_EXTERNAL_AI = 'true';
      await intel.ingestDocument(t.owner, {
        title: 'Opted in',
        content: 'allowed content',
        authorizationConfirmed: true,
      } as any);
      expect(calls.some((u) => u.includes('openai.com'))).toBe(true);
    });

    it('only compares vectors from the same model, using real embeddings only when every document has one', async () => {
      // Ollama up: embeddings come back as a 3-d vector keyed to the stub text.
      global.fetch = jest.fn(async (_u: any, init: any) => {
        const text = JSON.parse(init.body).input as string;
        const v = /pricing/i.test(text) ? [1, 0, 0] : [0, 1, 0];
        return { ok: true, json: async () => ({ embeddings: [v] }) } as any;
      }) as any;
      await intel.ingestDocument(t.owner, {
        title: 'Pricing',
        content: 'what does it cost',
        authorizationConfirmed: true,
      } as any);
      await intel.ingestDocument(t.owner, {
        title: 'Hours',
        content: 'when are you open',
        authorizationConfirmed: true,
      } as any);
      const semantic = await intel.searchKnowledge(t.owner, {
        query: 'pricing question',
      } as any);
      expect(semantic).toMatchObject({ semantic: true });
      expect(semantic.method).toMatch(/^ollama:/);
      expect(semantic.results[0].title).toBe('Pricing');

      // Ollama goes away: the query has no real embedding, so ALL scores fall back to one method.
      global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as any;
      const degraded = await intel.searchKnowledge(t.owner, {
        query: 'pricing question',
      } as any);
      expect(degraded).toMatchObject({
        method: 'lexical-hash-128',
        semantic: false,
      });
    });

    it('supports retention: purge by category and age, and delete a single document', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as any;
      const a = await intel.ingestDocument(t.owner, {
        title: 'old',
        content: 'old chatter',
        category: 'DISCUSSION',
        authorizationConfirmed: true,
      } as any);
      await intel.ingestDocument(t.owner, {
        title: 'faq',
        content: 'faq entry',
        category: 'FAQ',
        authorizationConfirmed: true,
      } as any);
      await h.prisma.agencyKnowledgeDocument.update({
        where: { id: a.id },
        data: { createdAt: new Date(Date.now() - 100 * 86400000) },
      });
      expect(
        await intel.purge(t.owner, {
          category: 'DISCUSSION',
          olderThanDays: 90,
        })
      ).toEqual({ deleted: 1 });
      await expect(intel.purge(t.owner, {})).rejects.toThrow(
        /Choose a category/
      );
      const left = await h.prisma.agencyKnowledgeDocument.findMany({
        where: { orgId: t.orgId },
      });
      expect(left.map((d) => d.title)).toEqual(['faq']);
      await expect(
        intel.deleteDocument(other.owner, left[0].id)
      ).rejects.toThrow(NotFoundException);
      await expect(
        intel.ingestDocument(t.client, {
          title: 'x',
          content: 'y',
          authorizationConfirmed: true,
        } as any)
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
