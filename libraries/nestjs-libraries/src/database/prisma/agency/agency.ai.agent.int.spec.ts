import {
  activeDestination,
  buildHarness,
  describeDb,
  Harness,
  seedTenant,
  Tenant,
} from './agency.test.support';

const realFetch = global.fetch;
const realEnv = { ...process.env };

/** The "model" is a script: each call to the chat endpoint answers with the next scripted reply. */
const script = (...replies: string[]) => {
  const calls: any[] = [];
  let i = 0;
  global.fetch = jest.fn(async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body));
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return {
      ok: true,
      json: async () => ({ message: { content: reply } }),
    } as any;
  }) as any;
  return calls;
};
const tool = (name: string, args: Record<string, unknown> = {}) =>
  JSON.stringify({ thought: `use ${name}`, tool: name, args });

describeDb('AI agent (real database, scripted model)', () => {
  let h: Harness;
  let t: Tenant;
  let other: Tenant;
  const ask = (actor: Tenant['owner'], text = 'do it') =>
    h.aiAgent.step(actor, { messages: [{ role: 'user', content: text }] });

  beforeAll(async () => {
    h = await buildHarness();
  });
  afterAll(async () => {
    await h.prisma.$disconnect();
  });
  beforeEach(async () => {
    process.env.AGENCYOS_LOCAL = 'true';
    t = await seedTenant(h, 'agent');
    other = await seedTenant(h, 'agent-other');
    // The scripted model stands in for the local one; the desktop app's own default is Antigravity.
    for (const tenant of [t, other]) {
      await h.aiGateway.updateSettings(tenant.owner, {
        activeProvider: 'local',
      });
    }
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...realEnv };
  });

  it('answers when it has what it needs, and shows a plain reply as it is', async () => {
    script(JSON.stringify({ final: 'All clear.' }));
    const r = await ask(t.owner);
    expect(r.turn).toEqual({ type: 'final', text: 'All clear.' });

    script('Sure, you have no campaigns yet.');
    expect((await ask(t.owner)).turn).toEqual({
      type: 'final',
      text: 'Sure, you have no campaigns yet.',
    });
  });

  it('looks things up as the person, inside their own agency only', async () => {
    await h.agency.createClient(t.owner, { name: 'Acme Bakery' } as any);
    await h.agency.createClient(other.owner, {
      name: 'Other Agency Client',
    } as any);
    script(tool('list_clients'));
    const r = await ask(t.owner);
    expect(r.turn).toMatchObject({
      type: 'tool',
      tool: 'list_clients',
      ok: true,
    });
    const text = (r.turn as any).result as string;
    expect(text).toContain('Acme Bakery');
    expect(text).not.toContain('Other Agency Client');

    // Another agency's campaign cannot be read by id either.
    const client = await h.agency.createClient(other.owner, {
      name: 'X',
    } as any);
    const campaign: any = await h.agency.createCampaign(other.owner, {
      customerId: client.id,
      name: 'Secret',
      contentBody: 'hello',
    });
    script(tool('get_campaign', { id: campaign.id }));
    const stolen = await ask(t.owner);
    expect((stolen.turn as any).ok).toBe(false);
    expect((stolen.turn as any).result).not.toContain('Secret');
  });

  it('turns mistakes into messages the model can fix, not errors', async () => {
    const turn = async (reply: string) => (await ask(t.owner)).turn as any;
    script(tool('approve_campaign', { id: 'x' }));
    expect(await turn('')).toMatchObject({ ok: false });
    script(tool('get_campaign', {}));
    expect((await turn('')).result).toMatch(/“id” is required/);
    script(tool('list_campaigns', { status: 'WHATEVER' }));
    expect((await turn('')).result).toMatch(/must be one of/);
  });

  it('proposes a change but does nothing until the person approves it', async () => {
    script(
      tool('create_client', { name: 'Acme Bakery', email: 'hi@acme.test' })
    );
    const r = await ask(t.owner);
    expect(r.turn).toMatchObject({
      type: 'proposal',
      tool: 'create_client',
      summary: 'Add the client “Acme Bakery”',
    });
    // The agency starts with the one client every test tenant has; nothing was added yet.
    expect(await h.agency.getClients(t.owner)).toHaveLength(1);

    const done = await h.aiAgent.act(t.owner, {
      tool: 'create_client',
      args: { name: 'Acme Bakery', email: 'hi@acme.test' },
    });
    expect(done.ok).toBe(true);
    expect(
      (await h.agency.getClients(t.owner)).map((c: any) => c.name)
    ).toContain('Acme Bakery');
    const audit = await h.accessRepo.listAuditEvents(t.orgId, {
      entityType: 'AgentAction',
    });
    expect(audit[0]).toMatchObject({
      action: 'ai.agent_action',
      actorUserId: t.userIds.owner,
    });
    expect(JSON.stringify(audit[0].metadata)).toContain('create_client');
  });

  it('drafts a campaign, never sends it, and refuses what a form would refuse', async () => {
    const client = await h.agency.createClient(t.owner, {
      name: 'Acme',
    } as any);
    const draft = {
      clientId: client.id,
      name: 'Spring sale',
      contentTitle: 'Fresh bread',
      contentBody: '<b>Fresh</b> bread every morning',
    };
    const done = await h.aiAgent.act(t.owner, {
      tool: 'create_campaign_draft',
      args: draft,
    });
    expect(done.result).toContain('"id"');
    expect(done.ok).toBe(true);
    const id = JSON.parse(done.result).id;
    const campaign: any = await h.agency.getCampaignById(t.owner, id);
    expect(campaign.status).toBe('DRAFT');
    expect(campaign.postingJobs).toHaveLength(0);

    const bad = await h.aiAgent.act(t.owner, {
      tool: 'create_campaign_draft',
      args: { ...draft, name: 'Bad link', ctaLink: 'not a url' },
    });
    expect(bad.ok).toBe(false);
    expect(await h.agency.getCampaigns(t.owner)).toHaveLength(1);

    // A draft with nowhere to go cannot be submitted, and the agent is told why.
    const early = await h.aiAgent.act(t.owner, {
      tool: 'submit_campaign_for_review',
      args: { id },
    });
    expect(early.ok).toBe(false);
    expect(early.result).toMatch(/no target destinations/);

    const destination = await activeDestination(h, t.orgId);
    const placed = await h.aiAgent.act(t.owner, {
      tool: 'set_campaign_destinations',
      args: { id, destinationIds: destination.id },
    });
    expect(placed.ok).toBe(true);
    const submit = await h.aiAgent.act(t.owner, {
      tool: 'submit_campaign_for_review',
      args: { id },
    });
    expect(submit.ok).toBe(true);
    // Submitted, not approved or sent: the agent has no way to approve, schedule or send.
    const after: any = await h.agency.getCampaignById(t.owner, id);
    expect(after.status).toBe('SUBMITTED');
    expect(after.postingJobs).toHaveLength(0);
    expect(h.gateway.sent).toHaveLength(0);
  });

  it('only offers, and only runs, what the person’s role allows', async () => {
    const calls = script(JSON.stringify({ final: 'ok' }));
    await ask(t.analyst);
    const prompt = calls[0].messages[0].content as string;
    expect(prompt).toContain('list_campaigns');
    expect(prompt).not.toContain('create_client');
    expect(prompt).not.toContain('create_campaign_draft');

    script(tool('create_client', { name: 'Nope' }));
    const r = await ask(t.analyst);
    expect((r.turn as any).ok).toBe(false);
    await expect(
      h.aiAgent.act(t.analyst, {
        tool: 'create_client',
        args: { name: 'Nope' },
      })
    ).rejects.toThrow();
    expect(await h.agency.getClients(t.owner)).toHaveLength(1);
  });

  it('will not "approve" a read tool or an unknown one as a change', async () => {
    for (const name of [
      'list_clients',
      'approve_campaign',
      'delete_campaign',
    ]) {
      await expect(
        h.aiAgent.act(t.owner, { tool: name, args: {} })
      ).rejects.toThrow(/not a change/);
    }
    // A client user cannot use the AI at all.
    await expect(ask(t.client)).rejects.toThrow();
  });

  it('keeps the model’s own words in the conversation and passes the job to the agent settings', async () => {
    const calls = script(JSON.stringify({ final: 'ok' }));
    await h.aiGateway.updateSettings(t.owner, {
      tasks: {
        agent: { provider: 'local', model: 'qwen3:14b', thinking: 'off' },
      },
    });
    await ask(t.owner);
    expect(calls[0]).toMatchObject({ model: 'qwen3:14b', think: false });
    expect(calls[0].messages[0].role).toBe('system');
    expect(calls[0].format).toBe('json');
  });
});
