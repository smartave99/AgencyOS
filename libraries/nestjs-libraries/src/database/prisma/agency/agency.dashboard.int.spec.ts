import {
  activeDestination,
  buildHarness,
  clearQueue,
  describeDb,
  gatewayError,
  Harness,
  jobsOf,
  makeJobsDue,
  scheduledCampaign,
  seedTenant,
  Tenant,
} from './agency.test.support';

describeDb('Dashboard queue and health (real database)', () => {
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
    h.gateway.sent = [];
    h.gateway.sendErrors.clear();
    h.gateway.permErrors.clear();
    t = await seedTenant(h, 'dash');
    other = await seedTenant(h, 'dash-other');
  });

  it('lists the waiting posts, and puts what needs someone ahead of what is only waiting', async () => {
    const waiting = await activeDestination(h, t.orgId);
    const failing = await activeDestination(h, t.orgId);
    // starts tomorrow, so it is still waiting when the other one has failed
    await scheduledCampaign(h, t, [waiting.id], {
      startDate: new Date(Date.now() + 86_400_000),
    });
    const failId = await scheduledCampaign(h, t, [failing.id]);
    h.gateway.failSendsTo(failing.chatId, gatewayError('NETWORK', 'timeout'));
    for (let i = 0; i < 3; i++) {
      await makeJobsDue(h, failId);
      await h.publishing.dispatchDue();
    }

    const board = await h.agency.getDashboard(t.owner);
    expect(board.queue.map((job) => job.status)).toEqual(['DEAD', 'PENDING']);
    expect(board.queue[0]).toMatchObject({
      attempts: 3,
      maxAttempts: 3,
      telegramDestination: { id: failing.id },
    });
    expect(board.queue[0].lastError).toMatch(/Gave up after 3 attempts/);
    expect(board.queue[1].telegramDestination?.id).toBe(waiting.id);
  });

  it("never shows another workspace's posts, bots or chats", async () => {
    const theirs = await activeDestination(h, other.orgId);
    await scheduledCampaign(h, other, [theirs.id]);
    const mine = await h.agency.getDashboard(t.owner);
    expect(mine.queue).toEqual([]);
    expect(mine.health.bots).toEqual([]);
    expect(mine.health.chats).toEqual({});
  });

  it('reports each bot with its state and chat count, and counts chats by what they can do', async () => {
    const bot = await h.prisma.telegramBot.create({
      data: {
        orgId: t.orgId,
        label: 'Sales bot',
        tokenSealed: 'sealed',
        tokenHash: `hash-${Math.random()}`,
        telegramBotId: `${Math.floor(Math.random() * 1e9)}`,
        username: 'sales_bot',
        status: 'INVALID',
        lastError: 'Telegram rejected this bot’s token.',
      },
    });
    await activeDestination(h, t.orgId, { botId: bot.id });
    await activeDestination(h, t.orgId);
    await activeDestination(h, t.orgId, { authorizationStatus: 'REVOKED' });
    // a removed bot is not listed
    await h.prisma.telegramBot.create({
      data: {
        orgId: t.orgId,
        label: 'Gone',
        tokenSealed: '',
        tokenHash: `hash-${Math.random()}`,
        telegramBotId: `${Math.floor(Math.random() * 1e9)}`,
        username: 'gone_bot',
        status: 'DISABLED',
        deletedAt: new Date(),
      },
    });

    const board = await h.agency.getDashboard(t.owner);
    expect(board.health.bots).toEqual([
      expect.objectContaining({
        label: 'Sales bot',
        username: 'sales_bot',
        status: 'INVALID',
        chats: 1,
      }),
    ]);
    // the token itself never leaves the database
    expect(JSON.stringify(board)).not.toMatch(/tokenSealed|tokenHash/);
    expect(board.health.chats).toMatchObject({ ACTIVE: 2, REVOKED: 1 });
  });

  it('counts the chats Telegram has asked to slow down, only while the wait lasts', async () => {
    const slow = await activeDestination(h, t.orgId);
    const id = await scheduledCampaign(h, t, [slow.id]);
    h.gateway.failSendsTo(
      slow.chatId,
      gatewayError('RATE_LIMITED', 'Too Many Requests', 300)
    );
    await h.publishing.dispatchDue();
    expect((await h.agency.getDashboard(t.owner)).health.rateLimitedChats).toBe(
      1
    );

    await h.prisma.postingJob.updateMany({
      where: { campaignId: id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    expect((await jobsOf(h, id))[0].lastErrorCode).toBe('RATE_LIMITED');
    expect((await h.agency.getDashboard(t.owner)).health.rateLimitedChats).toBe(
      0
    );
  });

  it('counts a post that is being sent right now', async () => {
    const d = await activeDestination(h, t.orgId);
    const id = await scheduledCampaign(h, t, [d.id]);
    await h.prisma.postingJob.updateMany({
      where: { campaignId: id },
      data: { status: 'SENDING' },
    });
    const board = await h.agency.getDashboard(t.owner);
    expect(board.runningPosts).toBe(1);
    expect(board.queue[0].status).toBe('SENDING');
  });
});
