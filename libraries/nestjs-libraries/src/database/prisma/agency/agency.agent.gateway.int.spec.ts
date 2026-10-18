import { createHash } from 'crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AgencyRole } from '@prisma/client';
import {
  buildHarness,
  connectAccount,
  describeDb,
  activeDestination,
  Harness,
  seedTenant,
  Tenant,
} from './agency.test.support';
import {
  AgentPrincipal,
  CallLimiter,
  findMcpServer,
} from './agency.agent.gateway.service';
import {
  AGENT_SCOPES,
  CreateAgentTokenDto,
} from '@gitroom/nestjs-libraries/dtos/agency/agent.integrations.dto';

jest.mock('@gitroom/nestjs-libraries/services/exception.filter', () => ({
  HttpForbiddenException: class extends Error {},
}));

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const realFetch = global.fetch;

/** The only tool names an outside agent may ever see. Adding one is a decision, so it fails here first. */
const ALLOWED_TOOLS = [
  'dashboard',
  'list_clients',
  'list_campaigns',
  'get_campaign',
  'list_destinations',
  'list_approvals',
  'get_report',
  'list_deals',
  'suggest_copy',
  'list_communities',
  'get_community',
  'list_telegram_accounts',
  'get_proposal',
  'create_client',
  'create_campaign_draft',
  'update_campaign_draft',
  'set_campaign_destinations',
  'submit_campaign_for_review',
];
const DRAFT_TOOLS = [
  'create_client',
  'create_campaign_draft',
  'update_campaign_draft',
  'set_campaign_destinations',
  'submit_campaign_for_review',
];
const FORBIDDEN_NAME =
  /send|publish|schedule|approve_|delete|join|leave|authorize|logout|shell|exec|file|http|secret|token/;
/** The most any tool an agent is offered may need from the person behind it. */
const PERMISSIONS_AGENTS_MAY_USE = [
  'dashboard:read',
  'client:read',
  'client:write',
  'campaign:read',
  'campaign:write',
  'destination:read',
  'analytics:read',
  'crm:read',
  'ai:use',
  'research:read',
  'userAccount:read',
  'ai:configure',
];

describeDb('Agent gateway (real database)', () => {
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
    t = await seedTenant(h, 'agent-gw');
    other = await seedTenant(h, 'agent-gw-other');
    // suggest_copy asks the agency's AI; with none reachable it answers from its template engine.
    global.fetch = jest.fn(async () => {
      throw new Error('no network in tests');
    }) as any;
  });
  afterEach(async () => {
    global.fetch = realFetch;
    // The test database is shared: a bot or account left behind would be waited for by the dashboard
    // checks of other specs (they look at every connected bot, whoever owns it).
    const orgs = { in: [t.orgId, other.orgId] };
    await h.prisma.telegramBot.updateMany({
      where: { orgId: orgs, deletedAt: null },
      data: {
        deletedAt: new Date(),
        status: 'DISABLED',
        tokenSealed: '',
        tokenHash: '',
      },
    });
    await h.prisma.telegramUserAccount.updateMany({
      where: { orgId: orgs, deletedAt: null },
      data: { deletedAt: new Date(), sealed: '' },
    });
  });

  // ---- helpers -------------------------------------------------------------------------
  const mint = async (
    actor = t.owner,
    scope: 'READ' | 'DRAFT' = 'DRAFT',
    label = 'Antigravity',
    expiresInDays?: number
  ) => h.agents.createToken(actor, { label, scope, expiresInDays });
  const login = async (token: string): Promise<AgentPrincipal> =>
    h.agents.authenticate(`Bearer ${token}`);
  const agent = async (
    actor = t.owner,
    scope: 'READ' | 'DRAFT' = 'DRAFT'
  ): Promise<{ p: AgentPrincipal; token: string; id: string }> => {
    const made = await mint(actor, scope);
    return { p: await login(made.token), token: made.token, id: made.id };
  };
  const statusOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return 200;
    } catch (error: any) {
      return error.getStatus?.() ?? 500;
    }
  };
  const member = async (
    tenant: Tenant,
    role: AgencyRole,
    orgRole: 'ADMIN' | 'USER' = 'USER'
  ) => {
    const user = await h.prisma.user.create({
      data: {
        email: `${role}-${Math.random().toString(36).slice(2)}@test.local`,
        providerName: 'LOCAL',
        name: role,
        activated: true,
        timezone: 0,
      } as any,
    });
    await h.prisma.userOrganization.create({
      data: { userId: user.id, organizationId: tenant.orgId, role: orgRole },
    });
    await h.accessRepo.upsertMember(tenant.orgId, user.id, role, null);
    return h.access.resolveActor({ id: tenant.orgId }, user, orgRole);
  };
  const call = (p: AgentPrincipal, tool: string, args: any = {}) =>
    h.agents.call(p, tool, args) as Promise<any>;
  const audits = (orgId: string, action: string) =>
    h.prisma.auditEvent.findMany({ where: { orgId, action } });

  // ========================================================================================
  describe('tokens', () => {
    it('are shown once, kept only as a hash, and never listed', async () => {
      const made = await mint(t.owner, 'DRAFT', 'Antigravity');
      expect(made.token).toMatch(/^agt_[A-Za-z0-9_-]{43}$/);
      expect(made).toMatchObject({
        label: 'Antigravity',
        scope: 'DRAFT',
        state: 'ACTIVE',
      });

      const row: any = await h.prisma.agentToken.findUniqueOrThrow({
        where: { id: made.id },
      });
      expect(row.tokenHash).toBe(sha256(made.token));
      // Nothing in the row, nor the list, can give the key back.
      expect(JSON.stringify(row)).not.toContain(made.token);
      const listed = JSON.stringify(await h.agents.listTokens(t.owner));
      expect(listed).not.toContain(made.token);
      expect(listed).not.toContain(row.tokenHash);
      expect(listed).toContain(made.id);

      // Two keys are never the same.
      expect((await mint()).token).not.toBe(made.token);
    });

    it('last 90 days unless told otherwise, and can be made without an expiry', async () => {
      const dflt = await mint();
      const days = (d: Date | null) =>
        Math.round((d!.getTime() - Date.now()) / 86_400_000);
      expect(days(dflt.expiresAt)).toBe(90);
      expect(days((await mint(t.owner, 'READ', 'short', 7)).expiresAt)).toBe(7);
      expect((await mint(t.owner, 'READ', 'forever', 0)).expiresAt).toBeNull();
    });

    it('have two scopes only: reading and drafting', async () => {
      expect([...AGENT_SCOPES]).toEqual(['READ', 'DRAFT']);
      for (const scope of ['WRITE', 'ADMIN', 'SEND', '']) {
        const dto = plainToInstance(CreateAgentTokenDto, { label: 'x', scope });
        expect((await validate(dto)).map((e) => e.property)).toContain('scope');
      }
      const ok = plainToInstance(CreateAgentTokenDto, {
        label: 'x',
        scope: 'READ',
        expiresInDays: 30,
      });
      expect(await validate(ok)).toEqual([]);
      const tooLong = plainToInstance(CreateAgentTokenDto, {
        label: 'x',
        scope: 'READ',
        expiresInDays: 4000,
      });
      expect(await validate(tooLong)).not.toEqual([]);
    });

    it('can only be made, listed and revoked by owners and admins', async () => {
      const owner = (await mint()).id;
      const admin = await member(t, AgencyRole.AGENCY_ADMIN, 'ADMIN');
      expect((await mint(admin)).id).toBeTruthy();
      expect(await h.agents.listTokens(admin)).not.toHaveLength(0);
      await h.agents.revokeToken(admin, owner);

      const refused = [
        t.manager, // campaign manager
        t.sales,
        t.salesManager,
        t.analyst,
        t.client,
      ];
      for (const who of refused) {
        expect(await statusOf(mint(who))).toBe(403);
        expect(await statusOf(h.agents.listTokens(who))).toBe(403);
        expect(await statusOf(h.agents.revokeToken(who, owner))).toBe(403);
        expect(await statusOf((async () => h.agents.config(who))())).toBe(403);
        expect(await statusOf(h.agents.listProposals(who))).toBe(403);
        expect(await statusOf(h.agents.approve(who, 'x'))).toBe(403);
        expect(await statusOf(h.agents.decline(who, 'x'))).toBe(403);
      }
    });

    it('stop working the moment they are revoked, and other agencies cannot revoke them', async () => {
      const { p, token, id } = await agent();
      expect(p.orgId).toBe(t.orgId);
      expect(await statusOf(h.agents.revokeToken(other.owner, id))).toBe(404);
      await login(token); // untouched by the attempt

      const revoked = await h.agents.revokeToken(t.owner, id);
      expect(revoked.state).toBe('REVOKED');
      expect(await statusOf(login(token))).toBe(401);
      // Revoking again changes nothing and is not an error.
      expect((await h.agents.revokeToken(t.owner, id)).state).toBe('REVOKED');
      expect(await audits(t.orgId, 'agent.token_revoked')).toHaveLength(1);
    });

    it('stop working when they expire', async () => {
      const { token, id } = await agent();
      await h.prisma.agentToken.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(await statusOf(login(token))).toBe(401);
      const [row] = (await h.agents.listTokens(t.owner)).filter(
        (k) => k.id === id
      );
      expect(row.state).toBe('EXPIRED');
    });

    it('are limited to ten that work, and a race cannot exceed it', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) ids.push((await mint()).id);
      expect(await statusOf(mint())).toBe(409);
      await h.agents.revokeToken(t.owner, ids[0]);
      expect((await mint()).id).toBeTruthy();
      // An expired key does not take a place.
      await h.prisma.agentToken.update({
        where: { id: ids[1] },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await mint()).id).toBeTruthy();

      const crowded = await seedTenant(h, 'crowded');
      const results = await Promise.allSettled(
        Array.from({ length: 14 }, () => mint(crowded.owner))
      );
      const active = await h.prisma.agentToken.count({
        where: { orgId: crowded.orgId, revokedAt: null },
      });
      expect(active).toBeLessThanOrEqual(10);
      expect(results.filter((r) => r.status === 'fulfilled').length).toBe(
        active
      );
    });

    it('open nothing without a valid Authorization header', async () => {
      const { token } = await agent();
      const wrongKey = `agt_${'A'.repeat(43)}`;
      const refusals = [
        undefined,
        '',
        token, // no scheme
        `Basic ${token}`,
        `Bearer ${token}x`,
        `Bearer ${token.slice(0, -1)}`,
        'Bearer agt_short',
        `Bearer ${wrongKey}`,
        `Bearer ${token.replace('agt_', 'agx_')}`,
      ];
      for (const header of refusals) {
        expect(await statusOf(h.agents.authenticate(header))).toBe(401);
      }
      expect((await h.agents.authenticate(`bearer ${token}`)).label).toBe(
        'Antigravity'
      );
    });

    it('never outrank the person who made them', async () => {
      const creator = await member(t, AgencyRole.AGENCY_ADMIN, 'ADMIN');
      const { token } = await agent(creator);
      await login(token);

      // Demoted: the key stops working for everything.
      await h.accessRepo.upsertMember(
        t.orgId,
        creator.userId,
        AgencyRole.SALES_EXECUTIVE,
        null
      );
      expect(await statusOf(login(token))).toBe(403);

      // Put back, then removed from the workspace.
      await h.accessRepo.upsertMember(
        t.orgId,
        creator.userId,
        AgencyRole.AGENCY_ADMIN,
        null
      );
      await login(token);
      await h.prisma.userOrganization.updateMany({
        where: { userId: creator.userId, organizationId: t.orgId },
        data: { disabled: true },
      });
      expect(await statusOf(login(token))).toBe(401);
    });

    it('record when they were last used', async () => {
      const { token, id } = await mint();
      const before = await h.prisma.agentToken.findUniqueOrThrow({
        where: { id },
      });
      expect(before.lastUsedAt).toBeNull();
      await login(token);
      const after = await h.prisma.agentToken.findUniqueOrThrow({
        where: { id },
      });
      expect(after.lastUsedAt).not.toBeNull();
    });

    it('are rate limited per token with a 429, and one token does not slow another', async () => {
      const busy = await mint();
      const calm = await mint();
      for (let i = 0; i < 60; i++) await login(busy.token);
      let error: any;
      try {
        await login(busy.token);
      } catch (e) {
        error = e;
      }
      expect(error.getStatus()).toBe(429);
      expect(error.getResponse().message).toMatch(/Too many calls/);
      expect(error.getResponse().retryAfterSeconds).toBeGreaterThan(0);
      await login(calm.token);

      // The window slides: a minute later the same key is fine again.
      let now = 1_000_000;
      const limiter = new CallLimiter(3, 60_000, () => now);
      expect([1, 2, 3].map(() => limiter.hit('k'))).toEqual([0, 0, 0]);
      expect(limiter.hit('k')).toBeGreaterThan(0);
      now += 61_000;
      expect(limiter.hit('k')).toBe(0);
    });

    it('write audit events that never contain the token', async () => {
      const { id, token } = await agent();
      await h.agents.revokeToken(t.owner, id);
      const made = await audits(t.orgId, 'agent.token_created');
      expect(made).toHaveLength(1);
      expect(made[0]).toMatchObject({
        actorUserId: t.userIds.owner,
        entityType: 'AgentToken',
        entityId: id,
        summary: 'Antigravity (DRAFT)',
      });
      const all = JSON.stringify(
        await h.prisma.auditEvent.findMany({ where: { orgId: t.orgId } })
      );
      expect(all).not.toContain(token);
      expect(all).not.toContain(sha256(token));
    });
  });

  // ========================================================================================
  describe('the tool list', () => {
    it('is exactly the allowlist, and nothing about it can send, approve or delete', async () => {
      const names = h.agents.allTools().map((x) => x.name);
      expect(names).toEqual(ALLOWED_TOOLS);
      expect(names.filter((n) => FORBIDDEN_NAME.test(n))).toEqual([]);
      for (const bad of [
        'approve_campaign',
        'send_campaign',
        'delete_client',
      ]) {
        expect(names).not.toContain(bad);
      }
      expect(
        h.agents
          .allTools()
          .filter((x) => x.scope === 'DRAFT')
          .map((x) => x.name)
      ).toEqual(DRAFT_TOOLS);
    });

    it('needs from the person nothing beyond looking, drafting and reading the directory', () => {
      const used = new Set<string>();
      for (const tool of h.agents.allTools()) {
        const permission = (h.agents as any).catalogue.find(
          (x: any) => x.name === tool.name
        ).permission;
        used.add(permission);
      }
      expect(
        [...used].filter((x) => !PERMISSIONS_AGENTS_MAY_USE.includes(x))
      ).toEqual([]);
    });

    it('shows a reading token only the reading tools, and a drafting token all of them', async () => {
      const read = await agent(t.owner, 'READ');
      const draft = await agent(t.owner, 'DRAFT');
      const readNames = h.agents.tools(read.p).tools.map((x) => x.name);
      expect(readNames).toEqual(
        ALLOWED_TOOLS.filter((n) => !DRAFT_TOOLS.includes(n))
      );
      expect(h.agents.tools(draft.p).tools.map((x) => x.name)).toEqual(
        ALLOWED_TOOLS
      );
    });

    it('describes each tool with a JSON Schema the agent can follow', async () => {
      const { p } = await agent();
      const list = h.agents.tools(p).tools;
      const create = list.find((x) => x.name === 'create_campaign_draft')!;
      expect(create.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['clientId', 'name', 'contentBody'],
        properties: { name: { type: 'string', maxLength: 200 } },
      });
      expect(create.description).toMatch(
        /nothing happens until a person approves/i
      );
      expect(create.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
      });
      const look = list.find((x) => x.name === 'list_clients')!;
      expect(look.annotations.readOnlyHint).toBe(true);
      expect(look.inputSchema).not.toHaveProperty('required');
    });
  });

  // ========================================================================================
  describe('scope and arguments', () => {
    it('a reading token cannot call a drafting tool', async () => {
      const { p } = await agent(t.owner, 'READ');
      for (const tool of DRAFT_TOOLS) {
        expect(await statusOf(call(p, tool, { name: 'X' }))).toBe(403);
      }
      expect(
        await h.prisma.agentProposal.count({ where: { orgId: t.orgId } })
      ).toBe(0);
      expect((await call(p, 'list_clients')).length).toBe(1);
    });

    it('refuses a tool that does not exist, including everything that would reach the outside world', async () => {
      const { p } = await agent();
      for (const tool of [
        'send_campaign',
        'publish_campaign',
        'schedule_campaign',
        'approve_campaign',
        'delete_client',
        'join_community',
        'authorize_chat',
        'logout_account',
        'create_telegram_account',
        'set_role',
        'read_secret',
        'run_shell',
        'read_file',
        'http_request',
        'nope',
      ]) {
        expect(await statusOf(call(p, tool))).toBe(404);
      }
    });

    it('cleans and checks arguments the way the in-app agent does', async () => {
      const { p } = await agent();
      // required
      expect(await statusOf(call(p, 'create_client', {}))).toBe(400);
      expect(await statusOf(call(p, 'get_campaign', {}))).toBe(400);
      // too long
      expect(
        await statusOf(call(p, 'create_client', { name: 'x'.repeat(201) }))
      ).toBe(400);
      // not one of the allowed values
      expect(
        await statusOf(call(p, 'list_campaigns', { status: 'SENT' }))
      ).toBe(400);
      expect(
        await statusOf(call(p, 'list_communities', { stage: 'JOINED_ALL' }))
      ).toBe(400);
      // a number that is not one
      expect(
        await statusOf(call(p, 'list_communities', { limit: 'many' }))
      ).toBe(400);
      // not an object at all is treated as no arguments
      expect((await call(p, 'list_clients', 'whatever')).length).toBe(1);

      // Unknown arguments are dropped, not stored and not forwarded.
      const proposed = await call(p, 'create_client', {
        name: 'Acme',
        orgId: 'someone-else',
        status: 'APPROVED',
        approve: true,
      });
      const row = await h.prisma.agentProposal.findUniqueOrThrow({
        where: { id: proposed.proposalId },
      });
      expect(row.args).toEqual({ name: 'Acme' });
    });
  });

  // ========================================================================================
  describe('reading', () => {
    it('runs every reading tool inside the token’s own agency', async () => {
      await h.agency.createClient(t.owner, {
        name: 'Acme Bakery',
        email: 'owner@acme.test',
      } as any);
      await h.agency.createClient(other.owner, {
        name: 'Other Agency Client',
      } as any);
      const dest = await activeDestination(h, t.orgId, {
        title: 'Bakers chat',
      });
      const campaign = await h.agency.createCampaign(t.sales, {
        customerId: t.customerId,
        name: 'Spring loaf',
        contentBody: 'Fresh bread',
        destinations: [
          { destinationType: 'TELEGRAM', telegramDestinationId: dest.id },
        ],
      } as any);
      await h.crm.createDeal(t.owner, {
        contactName: 'Pat Prospect',
        companyName: 'Prospect Ltd',
        contactEmail: 'pat@prospect.test',
      } as any);
      const { p } = await agent();

      expect(await call(p, 'dashboard')).toMatchObject({ totalCampaigns: 1 });
      const clients = await call(p, 'list_clients');
      expect(clients.map((c: any) => c.name)).toContain('Acme Bakery');
      expect(clients.map((c: any) => c.name)).not.toContain(
        'Other Agency Client'
      );
      expect((await call(p, 'list_clients', { search: 'bakery' })).length).toBe(
        1
      );
      expect(await call(p, 'list_campaigns')).toEqual([
        expect.objectContaining({ id: campaign.id, name: 'Spring loaf' }),
      ]);
      expect(await call(p, 'get_campaign', { id: campaign.id })).toMatchObject({
        name: 'Spring loaf',
        destinations: ['Bakers chat'],
      });
      expect(await call(p, 'list_destinations')).toEqual([
        expect.objectContaining({ id: dest.id, title: 'Bakers chat' }),
      ]);
      expect(await call(p, 'list_approvals')).toEqual([]);
      expect(await call(p, 'get_report')).toBeDefined();
      const deals = await call(p, 'list_deals');
      expect(deals).toEqual([
        expect.objectContaining({ company: 'Prospect Ltd', stage: 'PROSPECT' }),
      ]);
      const copy = await call(p, 'suggest_copy', { brief: 'Fresh bread' });
      expect(copy.headlines.length).toBeGreaterThan(0);

      // Another agency's campaign is a plain not-found.
      const foreign = await h.agency.createCampaign(other.sales, {
        customerId: other.customerId,
        name: 'Foreign',
        contentBody: 'x',
      } as any);
      expect(await statusOf(call(p, 'get_campaign', { id: foreign.id }))).toBe(
        404
      );
    });

    it('does not give out client e-mail addresses or prospects’ names', async () => {
      await h.agency.createClient(t.owner, {
        name: 'Acme Bakery',
        email: 'owner@acme.test',
      } as any);
      await h.crm.createDeal(t.owner, {
        contactName: 'Pat Prospect',
        companyName: 'Prospect Ltd',
        contactEmail: 'pat@prospect.test',
        contactPhone: '+4915112345678',
      } as any);
      const { p } = await agent();
      const clients = JSON.stringify(await call(p, 'list_clients'));
      const deals = JSON.stringify(await call(p, 'list_deals'));
      expect(clients).toContain('Acme Bakery');
      expect(clients).not.toContain('owner@acme.test');
      expect(deals).toContain('Prospect Ltd');
      for (const hidden of [
        'Pat Prospect',
        'pat@prospect.test',
        '4915112345678',
      ]) {
        expect(deals).not.toContain(hidden);
      }
    });

    it('lists the community directory with its metadata and nothing about people or messages', async () => {
      const make = (over: any) =>
        h.prisma.community.create({
          data: {
            orgId: t.orgId,
            telegramId: String(Math.floor(Math.random() * 1e12)),
            title: 'Bakers',
            username: `bakers_${Math.random().toString(36).slice(2, 8)}`,
            description: 'PRIVATE-ABOUT-TEXT scraped from Telegram',
            notes: 'PRIVATE-TEAM-NOTE',
            stageReason: 'PRIVATE-STAGE-REASON',
            memberCount: 4200,
            category: 'food',
            tags: ['bread', 'local'],
            ...over,
          },
        });
      const a = await make({
        title: 'Bakers United',
        username: 'bakers_united',
      });
      await make({
        title: 'Cars',
        username: 'fast_cars',
        stage: 'JOINED',
        description: 'bakers in the about text',
      });
      await h.prisma.community.create({
        data: {
          orgId: other.orgId,
          title: 'Other Agency Group',
          username: 'other_group',
        },
      });
      const { p } = await agent();

      const all = await call(p, 'list_communities');
      expect(all.map((c: any) => c.title).sort()).toEqual([
        'Bakers United',
        'Cars',
      ]);
      expect(all.find((c: any) => c.id === a.id)).toMatchObject({
        title: 'Bakers United',
        username: '@bakers_united',
        members: 4200,
        stage: 'DISCOVERED',
        category: 'food',
        tags: ['bread', 'local'],
      });
      // Searching sees titles and @usernames, not the text Telegram published about a community.
      expect(
        (await call(p, 'list_communities', { search: 'bakers' })).map(
          (c: any) => c.title
        )
      ).toEqual(['Bakers United']);
      expect(
        (await call(p, 'list_communities', { search: '@fast_cars' })).length
      ).toBe(1);
      expect(
        (await call(p, 'list_communities', { stage: 'JOINED' })).map(
          (c: any) => c.title
        )
      ).toEqual(['Cars']);
      expect((await call(p, 'list_communities', { limit: 1 })).length).toBe(1);

      const one = await call(p, 'get_community', { id: a.id });
      expect(one.title).toBe('Bakers United');
      const text = JSON.stringify([all, one]);
      for (const hidden of [
        'PRIVATE-ABOUT-TEXT',
        'PRIVATE-TEAM-NOTE',
        'PRIVATE-STAGE-REASON',
        'Other Agency Group',
      ]) {
        expect(text).not.toContain(hidden);
      }
      const keys = Object.keys(one);
      expect(keys).not.toContain('description');
      expect(keys).not.toContain('notes');
      expect(keys).not.toContain('telegramId');
      expect(keys).not.toContain('operatingAccountId');

      const foreign = await h.prisma.community.findFirstOrThrow({
        where: { orgId: other.orgId },
      });
      expect(await statusOf(call(p, 'get_community', { id: foreign.id }))).toBe(
        404
      );
    });

    it('shows Telegram accounts’ health without ids or credentials', async () => {
      const account = await connectAccount(h, t, {
        label: 'Sales line',
        grants: { canJoin: true },
      });
      const { p } = await agent();
      const list = await call(p, 'list_telegram_accounts');
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        label: 'Sales line',
        status: 'ACTIVE',
        permissions: {
          canResearch: true,
          canJoin: true,
          canPublish: false,
          canManage: false,
        },
        phoneMasked: account.phoneMasked,
      });
      expect(list[0].phoneMasked).toMatch(/•/);
      expect(Object.keys(list[0]).sort()).toEqual(
        [
          'label',
          'lastCheckedAt',
          'lastErrorCode',
          'permissions',
          'phoneMasked',
          'rateLimitedUntil',
          'status',
          'statusReason',
        ].sort()
      );
      expect(JSON.stringify(list)).not.toContain(account.id);
      // Another agency has none.
      const theirs = await agent(other.owner);
      expect(await call(theirs.p, 'list_telegram_accounts')).toEqual([]);
    });

    it('lets a token see only the proposals it made', async () => {
      const a = await agent();
      const b = await agent();
      const made = await call(a.p, 'create_client', { name: 'Acme' });
      expect(
        await call(a.p, 'get_proposal', { id: made.proposalId })
      ).toMatchObject({
        status: 'PENDING',
        tool: 'create_client',
      });
      expect(
        await statusOf(call(b.p, 'get_proposal', { id: made.proposalId }))
      ).toBe(404);
      const theirs = await agent(other.owner);
      expect(
        await statusOf(call(theirs.p, 'get_proposal', { id: made.proposalId }))
      ).toBe(404);
    });

    it('removes secret-shaped keys and the fields an agent is not given, whatever a tool returns', () => {
      const safe = (h.agents as any).safe.bind(h.agents);
      expect(
        safe('list_clients', [
          {
            name: 'A',
            email: 'a@b.c',
            session: 's',
            nested: {
              apiHash: 'h',
              token: 't',
              keep: 1,
              phone: '+1',
              phoneMasked: '+1•••',
            },
          },
        ])
      ).toEqual([{ name: 'A', nested: { keep: 1, phoneMasked: '+1•••' } }]);
      expect(safe('x', { when: new Date(0), n: null })).toEqual({
        when: new Date(0).toISOString(),
        n: null,
      });
      expect(() => safe('x', { big: 'y'.repeat(300_000) })).toThrow(
        /too large/
      );
    });
  });

  // ========================================================================================
  describe('proposals', () => {
    it('are created, not carried out, and the agent is told so', async () => {
      const { p, id } = await agent();
      const before = await h.prisma.customer.count({
        where: { orgId: t.orgId },
      });
      const result = await call(p, 'create_client', {
        name: 'Fresh Client',
        industry: 'Food',
      });
      expect(result).toEqual({
        status: 'pending_approval',
        proposalId: expect.any(String),
        message: expect.stringMatching(
          /Nothing has changed.*person has to approve/s
        ),
      });
      expect(await h.prisma.customer.count({ where: { orgId: t.orgId } })).toBe(
        before
      );

      const row = await h.prisma.agentProposal.findUniqueOrThrow({
        where: { id: result.proposalId },
      });
      expect(row).toMatchObject({
        orgId: t.orgId,
        tokenId: id,
        tool: 'create_client',
        args: { name: 'Fresh Client', industry: 'Food' },
        summary: 'Add the client “Fresh Client”',
        status: 'PENDING',
      });
      const hours =
        (row.expiresAt.getTime() - row.createdAt.getTime()) / 3_600_000;
      expect(hours).toBeCloseTo(24, 1);

      const entries = await audits(t.orgId, 'agent.proposal_created');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actorUserId: null,
        actorRole: 'AGENT',
        entityId: row.id,
      });
    });

    it('asked for twice come back as the same waiting proposal', async () => {
      const { p } = await agent();
      const first = await call(p, 'create_client', {
        name: 'Acme',
        industry: 'Food',
      });
      const again = await call(p, 'create_client', {
        industry: 'Food',
        name: 'Acme',
      });
      expect(again.proposalId).toBe(first.proposalId);
      const other2 = await call(p, 'create_client', { name: 'Acme 2' });
      expect(other2.proposalId).not.toBe(first.proposalId);
      expect(
        await h.prisma.agentProposal.count({ where: { orgId: t.orgId } })
      ).toBe(2);
    });

    it('cannot pile up: a token and an agency each have a limit on waiting ones', async () => {
      const { p } = await agent();
      for (let i = 0; i < 20; i++)
        await call(p, 'create_client', { name: `C${i}` });
      expect(
        await statusOf(call(p, 'create_client', { name: 'One too many' }))
      ).toBe(429);
      // Approving or declining makes room.
      const [first] = await h.agents.listProposals(t.owner, 'PENDING');
      await h.agents.decline(t.owner, first.id);
      expect(
        await statusOf(call(p, 'create_client', { name: 'Room again' }))
      ).toBe(200);
    });

    it('run when a person approves, as that person, exactly once', async () => {
      const creator = t.owner;
      const approver = await member(t, AgencyRole.AGENCY_ADMIN, 'ADMIN');
      const { p, token } = await agent(creator);
      const proposed = await call(p, 'create_client', { name: 'Approved Co' });

      const done = await h.agents.approve(approver, proposed.proposalId);
      expect(done).toMatchObject({
        status: 'APPROVED',
        outcome: { ok: true, result: { name: 'Approved Co' } },
      });
      const clients = await h.prisma.customer.findMany({
        where: { orgId: t.orgId, name: 'Approved Co' },
      });
      expect(clients).toHaveLength(1);

      // Nothing runs a second time.
      expect(
        await statusOf(h.agents.approve(approver, proposed.proposalId))
      ).toBe(409);
      expect(
        await statusOf(h.agents.approve(creator, proposed.proposalId))
      ).toBe(409);
      expect(
        await statusOf(h.agents.decline(creator, proposed.proposalId))
      ).toBe(409);
      expect(
        await h.prisma.customer.count({
          where: { orgId: t.orgId, name: 'Approved Co' },
        })
      ).toBe(1);

      // It was recorded against the approver, and the agent can see the result.
      const row = await h.prisma.agentProposal.findUniqueOrThrow({
        where: { id: proposed.proposalId },
      });
      expect(row.decidedById).toBe(approver.userId);
      expect(
        await call(await login(token), 'get_proposal', {
          id: proposed.proposalId,
        })
      ).toMatchObject({ status: 'APPROVED', outcome: { ok: true } });
      const trail = await audits(t.orgId, 'agent.proposal_approved');
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        actorUserId: approver.userId,
        entityId: proposed.proposalId,
      });
      const acted = await audits(t.orgId, 'ai.agent_action');
      expect(acted[0].metadata).toMatchObject({ approvedBy: approver.userId });
    });

    it('two people pressing Approve together run it once', async () => {
      const { p } = await agent();
      const second = await member(t, AgencyRole.AGENCY_ADMIN, 'ADMIN');
      const proposed = await call(p, 'create_client', { name: 'Twice?' });
      const results = await Promise.allSettled([
        h.agents.approve(t.owner, proposed.proposalId),
        h.agents.approve(second, proposed.proposalId),
        h.agents.approve(t.owner, proposed.proposalId),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        await h.prisma.customer.count({
          where: { orgId: t.orgId, name: 'Twice?' },
        })
      ).toBe(1);
    });

    it('carry out a whole piece of work step by step, and none of it sends or schedules anything', async () => {
      const dest = await activeDestination(h, t.orgId, {
        title: 'Bakers chat',
      });
      const { p } = await agent();
      const approve = async (proposed: any) =>
        (await h.agents.approve(t.owner, proposed.proposalId)).outcome as any;

      const client = await approve(
        await call(p, 'create_client', { name: 'Loaf Co' })
      );
      expect(client.ok).toBe(true);

      const draft = await approve(
        await call(p, 'create_campaign_draft', {
          clientId: client.result.id,
          name: 'Spring loaf',
          contentBody: 'Fresh bread, <b>today</b>',
          ctaLink: 'https://example.com/bread',
          ctaText: 'Order',
          destinationIds: dest.id,
        })
      );
      expect(draft).toMatchObject({ ok: true, result: { status: 'DRAFT' } });
      const campaignId = draft.result.id;

      const edit = await approve(
        await call(p, 'update_campaign_draft', {
          id: campaignId,
          contentBody: 'Fresh bread, warm',
        })
      );
      expect(edit.ok).toBe(true);
      const second = await activeDestination(h, t.orgId, {
        title: 'Second chat',
      });
      expect(
        (
          await approve(
            await call(p, 'set_campaign_destinations', {
              id: campaignId,
              destinationIds: `${dest.id}, ${second.id}`,
            })
          )
        ).result.destinations
      ).toBe(2);
      expect(
        (
          await approve(
            await call(p, 'submit_campaign_for_review', { id: campaignId })
          )
        ).ok
      ).toBe(true);

      const campaign = await h.prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
      });
      expect(campaign).toMatchObject({
        status: 'SUBMITTED',
        contentBody: 'Fresh bread, warm',
        // The campaign is the approver's, not the agent's or the key's.
        createdById: t.userIds.owner,
        approvedAt: null,
      });
      // A person still has to approve it; nothing was queued or delivered.
      expect(await h.prisma.postingJob.count({ where: { campaignId } })).toBe(
        0
      );
      expect(h.gateway.sent).toEqual([]);
      expect(await call(p, 'list_approvals')).toEqual([
        expect.objectContaining({ campaignId, status: 'PENDING' }),
      ]);
    });

    it('that fail when they run say why, and stay approved without running again', async () => {
      const { p } = await agent();
      const proposed = await call(p, 'create_client', {
        name: 'Bad Mail',
        email: 'not-an-email',
      });
      const done = await h.agents.approve(t.owner, proposed.proposalId);
      expect(done.status).toBe('APPROVED');
      expect(done.outcome).toMatchObject({ ok: false });
      expect((done.outcome as any).error).toMatch(/email/i);
      expect(
        await h.prisma.customer.count({
          where: { orgId: t.orgId, name: 'Bad Mail' },
        })
      ).toBe(0);
      expect(
        await statusOf(h.agents.approve(t.owner, proposed.proposalId))
      ).toBe(409);
      expect(
        await call(p, 'get_proposal', { id: proposed.proposalId })
      ).toMatchObject({
        status: 'APPROVED',
        outcome: { ok: false },
      });
    });

    it('that are declined never run, and the agent can see the reason', async () => {
      const { p } = await agent();
      const proposed = await call(p, 'create_client', { name: 'Declined Co' });
      const declined = await h.agents.decline(
        t.owner,
        proposed.proposalId,
        'Not now'
      );
      expect(declined).toMatchObject({
        status: 'DECLINED',
        outcome: { ok: false, error: 'Declined: Not now' },
      });
      expect(
        await statusOf(h.agents.approve(t.owner, proposed.proposalId))
      ).toBe(409);
      expect(
        await h.prisma.customer.count({
          where: { orgId: t.orgId, name: 'Declined Co' },
        })
      ).toBe(0);
      expect(
        await call(p, 'get_proposal', { id: proposed.proposalId })
      ).toMatchObject({
        status: 'DECLINED',
      });
      expect(await audits(t.orgId, 'agent.proposal_declined')).toHaveLength(1);
    });

    it('that are older than a day never run, and are marked expired when anyone looks', async () => {
      const { p } = await agent();
      const proposed = await call(p, 'create_client', { name: 'Too Late' });
      await h.prisma.agentProposal.update({
        where: { id: proposed.proposalId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(
        await statusOf(h.agents.approve(t.owner, proposed.proposalId))
      ).toBe(409);
      expect(
        await h.prisma.customer.count({
          where: { orgId: t.orgId, name: 'Too Late' },
        })
      ).toBe(0);
      expect(
        await call(p, 'get_proposal', { id: proposed.proposalId })
      ).toMatchObject({
        status: 'EXPIRED',
      });

      const second = await call(p, 'create_client', { name: 'Also Late' });
      await h.prisma.agentProposal.update({
        where: { id: second.proposalId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(await statusOf(h.agents.decline(t.owner, second.proposalId))).toBe(
        409
      );
      const listed = await h.agents.listProposals(t.owner, 'EXPIRED');
      expect(listed.map((x) => x.id).sort()).toEqual(
        [proposed.proposalId, second.proposalId].sort()
      );
    });

    it('are refused to an approver who no longer has the permission, and stay waiting', async () => {
      const { p } = await agent();
      const approver = await member(t, AgencyRole.AGENCY_ADMIN, 'ADMIN');
      const proposed = await call(p, 'create_client', { name: 'Needs Rights' });
      await h.accessRepo.upsertMember(
        t.orgId,
        approver.userId,
        AgencyRole.SALES_EXECUTIVE,
        null
      );
      const demoted = await h.access.resolveActor(
        { id: t.orgId },
        { id: approver.userId },
        'USER'
      );
      expect(
        await statusOf(h.agents.approve(demoted, proposed.proposalId))
      ).toBe(403);
      for (const who of [t.manager, t.sales, t.analyst, t.client]) {
        expect(await statusOf(h.agents.approve(who, proposed.proposalId))).toBe(
          403
        );
      }
      expect(
        await h.prisma.customer.count({
          where: { orgId: t.orgId, name: 'Needs Rights' },
        })
      ).toBe(0);
      expect(
        (
          await h.prisma.agentProposal.findUniqueOrThrow({
            where: { id: proposed.proposalId },
          })
        ).status
      ).toBe('PENDING');
      // Still approvable by someone who may.
      expect(
        (await h.agents.approve(t.owner, proposed.proposalId)).status
      ).toBe('APPROVED');
    });

    it('belong to one agency: another agency cannot see, approve or decline them', async () => {
      const { p } = await agent();
      const proposed = await call(p, 'create_client', { name: 'Mine' });
      expect(await h.agents.listProposals(other.owner)).toEqual([]);
      expect(
        await statusOf(h.agents.approve(other.owner, proposed.proposalId))
      ).toBe(404);
      expect(
        await statusOf(h.agents.decline(other.owner, proposed.proposalId))
      ).toBe(404);
      expect(await h.prisma.customer.count({ where: { name: 'Mine' } })).toBe(
        0
      );
      expect(await h.agents.listProposals(t.owner)).toHaveLength(1);
    });

    it('are withdrawn when their token is revoked', async () => {
      const { p, id } = await agent();
      const proposed = await call(p, 'create_client', { name: 'Orphan' });
      await h.agents.revokeToken(t.owner, id);
      expect(
        await statusOf(h.agents.approve(t.owner, proposed.proposalId))
      ).toBe(409);
      const [row] = await h.agents.listProposals(t.owner);
      expect(row.status).toBe('EXPIRED');
      expect((row.outcome as any).error).toMatch(/revoked/);
      expect(
        await h.prisma.customer.count({
          where: { orgId: t.orgId, name: 'Orphan' },
        })
      ).toBe(0);
    });

    it('show a person the exact arguments and which token asked', async () => {
      const { p } = await agent(t.owner, 'DRAFT');
      await call(p, 'create_client', { name: 'Show Me', industry: 'Food' });
      const [row] = await h.agents.listProposals(t.owner, 'PENDING');
      expect(row).toMatchObject({
        tool: 'create_client',
        args: { name: 'Show Me', industry: 'Food' },
        summary: 'Add the client “Show Me”',
        status: 'PENDING',
        from: { label: 'Antigravity', scope: 'DRAFT' },
      });
      expect(await h.agents.listProposals(t.owner, 'APPROVED')).toEqual([]);
    });
  });

  // ========================================================================================
  describe('secrets', () => {
    it('no tool, run against data full of secrets, ever returns one', async () => {
      // Real secrets in every place AgencyOS keeps them.
      const botToken = `${
        700_000 + Math.floor(Math.random() * 9_000_000)
      }:SECRET-bot-token-abcdefghijklmnopqrstuvwxyz`;
      await h.bots.add(t.owner, { label: 'Main bot', token: botToken });
      const account = await connectAccount(h, t, {
        label: 'Sales line',
        password: 'two-step-PASSWORD-123',
        grants: { canJoin: true, canPublish: true },
      });
      const phones = [...h.userGateway.people.keys()];
      expect(phones.length).toBeGreaterThan(0);
      // The most hostile case: a full number and a session-shaped string in free-text fields.
      await h.prisma.telegramUserAccount.update({
        where: { id: account.id },
        data: {
          lastError: `Login failed for ${phones[phones.length - 1]}`,
          displayName: 'Real Person Name',
          username: 'real_person_handle',
          statusReason: 'Telegram limited this account',
        },
      });
      await h.aiGateway.updateSettings(t.owner, {
        providers: { openai: { apiKey: 'sk-openai-SECRET-KEY-0123456789' } },
      });
      await h.agency.createClient(t.owner, {
        name: 'Secret Co',
        email: 'secret-client@example.test',
      } as any);
      await h.crm.createDeal(t.owner, {
        contactName: 'Hidden Contact',
        companyName: 'Hidden Ltd',
        contactEmail: 'hidden@example.test',
        contactPhone: '+4915100000000',
      } as any);
      await h.prisma.community.create({
        data: {
          orgId: t.orgId,
          title: 'Visible Title',
          username: 'visible_group',
          description: 'DESCRIPTION-FROM-TELEGRAM',
          notes: 'NOTE-BY-TEAM',
          telegramId: '-100123456',
        },
      });
      const dest = await activeDestination(h, t.orgId);
      const campaign = await h.agency.createCampaign(t.sales, {
        customerId: t.customerId,
        name: 'Secrets run',
        contentBody: 'Hello',
        destinations: [
          { destinationType: 'TELEGRAM', telegramDestinationId: dest.id },
        ],
      } as any);
      const community = await h.prisma.community.findFirstOrThrow({
        where: { orgId: t.orgId },
      });

      const { p, token } = await agent();

      // Everything that must never appear, gathered from the database itself.
      const rows = {
        account: await h.prisma.telegramUserAccount.findUniqueOrThrow({
          where: { id: account.id },
        }),
        bot: await h.prisma.telegramBot.findFirstOrThrow({
          where: { orgId: t.orgId },
        }),
        ai: await h.prisma.agencyAiConfig.findUniqueOrThrow({
          where: { orgId: t.orgId },
        }),
        token: await h.prisma.agentToken.findUniqueOrThrow({
          where: { tokenHash: sha256(token) },
        }),
      };
      const forbidden = [
        token,
        sha256(token),
        rows.account.sealed,
        rows.bot.tokenSealed,
        rows.bot.tokenHash,
        botToken,
        botToken.split(':')[1],
        'a1'.repeat(16), // the account's api hash
        'two-step-PASSWORD-123',
        ...h.userGateway.sessions.keys(), // login sessions
        ...phones,
        ...phones.map((x) => x.replace('+', '')),
        'sk-openai-SECRET-KEY-0123456789',
        JSON.stringify(rows.ai.providers),
        process.env.JWT_SECRET!,
        'real_person_handle',
        'Real Person Name',
        'secret-client@example.test',
        'Hidden Contact',
        'hidden@example.test',
        '+4915100000000',
        'DESCRIPTION-FROM-TELEGRAM',
        'NOTE-BY-TEAM',
        '-100123456',
        account.id,
      ].filter(Boolean) as string[];
      expect(forbidden.length).toBeGreaterThan(15);

      // Run every tool the agent is offered, with arguments that make each do real work.
      const outputs: Record<string, unknown> = {
        '/tools': h.agents.tools(p),
        '/health': h.agents.health(p),
        config: h.agents.config(t.owner),
      };
      const args: Record<string, any> = {
        get_campaign: { id: campaign.id },
        get_community: { id: community.id },
        suggest_copy: { brief: 'Fresh bread' },
        create_client: { name: 'New Client' },
        create_campaign_draft: {
          clientId: t.customerId,
          name: 'Draft',
          contentBody: 'x',
        },
        update_campaign_draft: { id: campaign.id, name: 'Renamed' },
        set_campaign_destinations: { id: campaign.id, destinationIds: dest.id },
        submit_campaign_for_review: { id: campaign.id },
      };
      for (const tool of h.agents.tools(p).tools) {
        if (tool.name === 'get_proposal') continue;
        outputs[tool.name] = await call(p, tool.name, args[tool.name] ?? {});
      }
      // get_proposal needs a real id from one of the drafts above.
      outputs.get_proposal = await call(p, 'get_proposal', {
        id: (outputs.create_client as any).proposalId,
      });
      // ...and what a person sees after approving every one of them.
      const waiting = await h.agents.listProposals(t.owner, 'PENDING');
      for (const proposal of waiting) {
        outputs[`approved:${proposal.tool}`] = await h.agents.approve(
          t.owner,
          proposal.id
        );
      }
      outputs.afterApproval = await call(p, 'get_proposal', {
        id: (outputs.create_client as any).proposalId,
      });
      outputs.tokens = await h.agents.listTokens(t.owner);

      expect(Object.keys(outputs).length).toBeGreaterThanOrEqual(
        ALLOWED_TOOLS.length
      );
      const serialized = JSON.stringify(outputs);
      for (const secret of forbidden) {
        expect(serialized).not.toContain(secret);
      }
      // ...and no key anywhere in any output is named like a secret.
      const keys = new Set<string>();
      const walk = (v: unknown) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (v && typeof v === 'object' && !(v instanceof Date)) {
          for (const [k, x] of Object.entries(v)) {
            keys.add(k);
            walk(x);
          }
        }
      };
      walk(JSON.parse(serialized));
      expect(
        [...keys].filter((k) =>
          /^(sealed|session|apiHash|apiId|apiKey|password|secret|token|tokenHash|phone|phoneNumber)$/i.test(
            k
          )
        )
      ).toEqual([]);
    });
  });

  // ========================================================================================
  describe('the connection settings', () => {
    it('give a copy-paste block with a placeholder instead of a token, and say what is unverified', () => {
      const config = h.agents.config(t.owner);
      const file = JSON.parse(config.configText);
      expect(file).toEqual({
        mcpServers: {
          agencyos: {
            command: 'node',
            args: [expect.stringMatching(/server\.mjs$/)],
            env: {
              AGENCYOS_MCP_URL: `http://127.0.0.1:${process.env.PORT || 3000}`,
              AGENCYOS_MCP_TOKEN: '<paste the token shown once>',
            },
          },
        },
      });
      expect(config.fileName).toBe('.agents/mcp_config.json');
      expect(config.verifiedWithAntigravity).toBe(false);
      expect(config.serverFound).toBe(true);
      expect(config.genericCommand).toMatch(/^node ".*server\.mjs"$/);
      expect(config.tools.map((x) => x.name)).toEqual(ALLOWED_TOOLS);
      expect(config.limits).toEqual({
        activeTokens: 10,
        callsPerMinute: 60,
        proposalHours: 24,
        defaultTokenDays: 90,
      });
    });

    it('use the Node.js that came with the installed app, when the app says where it is', () => {
      const before = process.env.AGENCYOS_NODE_PATH;
      process.env.AGENCYOS_NODE_PATH =
        'C:\\Users\\Sam\\AppData\\Local\\Programs\\AgencyOS\\runtime\\node\\node.exe';
      try {
        const config = h.agents.config(t.owner);
        expect(JSON.parse(config.configText).mcpServers.agencyos.command).toBe(
          process.env.AGENCYOS_NODE_PATH
        );
        expect(config.genericCommand).toMatch(
          /^"C:\\Users.*node\.exe" ".*server\.mjs"$/
        );
      } finally {
        if (before === undefined) delete process.env.AGENCYOS_NODE_PATH;
        else process.env.AGENCYOS_NODE_PATH = before;
      }
    });

    it('find the MCP server in the install, the source tree or where the person says', () => {
      const has =
        (...files: string[]) =>
        (p: string) =>
          files
            .map((f) => f.replace(/\\/g, '/'))
            .includes(p.replace(/\\/g, '/'));
      const installed = '/opt/AgencyOS/app/agent-mcp/server.mjs';
      expect(
        findMcpServer(
          {},
          has(installed),
          '/opt/AgencyOS/app/backend/dist/libraries/x/y'
        )
      ).toEqual({ path: installed, found: true });
      const source = '/src/agencyos/apps/agent-mcp/server.mjs';
      expect(
        findMcpServer({}, has(source), '/src/agencyos/libraries/a/b')
      ).toEqual({ path: source, found: true });
      expect(
        findMcpServer(
          { AGENCYOS_MCP_SERVER: '/elsewhere/server.mjs' },
          has('/elsewhere/server.mjs')
        )
      ).toEqual({ path: '/elsewhere/server.mjs', found: true });
      const missing = findMcpServer(
        { AGENCYOS_HOME: '/opt/AgencyOS' },
        () => false,
        '/nowhere'
      );
      expect(missing.found).toBe(false);
      expect(missing.path.replace(/\\/g, '/')).toMatch(
        /\/opt\/AgencyOS\/app\/agent-mcp\/server\.mjs$/
      );
    });
  });
});
