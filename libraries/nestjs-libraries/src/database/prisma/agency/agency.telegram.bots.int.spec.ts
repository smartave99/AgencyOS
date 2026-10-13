import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  activeDestination,
  buildHarness,
  clearQueue,
  describeDb,
  gatewayError,
  Harness,
  jobsOf,
  scheduledCampaign,
  seedTenant,
  Tenant,
} from './agency.test.support';

// Like the other Telegram specs: the controller graph is not needed for what is tested here.
jest.mock('@gitroom/nestjs-libraries/services/exception.filter', () => ({
  HttpForbiddenException: class extends Error {},
}));

// What @BotFather hands out: digits, a colon, then at least 30 letters, digits, _ or -.
const token = (n: number) => `${n}:${'x'.repeat(10)}${String(n).padEnd(25, 'q')}`;

const msg = (chat: any, from: any, text: string) => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: { message_id: 1, date: 0, chat, from, text },
});

describeDb('Telegram bots (real database, fake Telegram)', () => {
  let h: Harness;
  let t: Tenant;
  const admin = { id: 501, is_bot: false, first_name: 'Ada' };
  let seed = 700000;
  const fresh = () => ++seed;

  beforeAll(async () => {
    h = await buildHarness();
  });
  afterAll(async () => {
    await h.prisma.$disconnect();
  });
  beforeEach(async () => {
    await clearQueue(h);
    t = await seedTenant(h, 'Bot Agency');
    h.gateway.sent = [];
    h.gateway.notices = [];
    h.gateway.bots.clear();
    h.gateway.rejectedTokens.clear();
  });

  const connect = async (label = 'Acme Ads') => {
    const tok = token(fresh());
    const bot = await h.bots.add(t.owner, { label, token: tok });
    return { bot, tok, fake: h.gateway.bots.get(tok)! };
  };
  const status = async (id: string) =>
    (await h.prisma.telegramDestination.findUniqueOrThrow({ where: { id } }))
      .authorizationStatus;

  describe('connecting', () => {
    it('connects a bot once Telegram confirms the token; the token is sealed and never shown', async () => {
      const { bot, tok } = await connect('Acme Ads');
      expect(bot).toMatchObject({
        label: 'Acme Ads',
        status: 'ACTIVE',
        destinationCount: 0,
      });
      expect(bot.username).toMatch(/^bot_\d+$/);

      const listed = await h.bots.list(t.manager);
      expect(listed.bots).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toContain(tok);
      expect(JSON.stringify(listed)).not.toContain('tokenSealed');

      const row = await h.prisma.telegramBot.findUniqueOrThrow({
        where: { id: bot.id },
      });
      expect(row.tokenSealed.startsWith('v1.')).toBe(true);
      expect(row.tokenSealed).not.toContain(tok);
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);

      const audit = await h.prisma.auditEvent.findMany({
        where: { orgId: t.orgId },
      });
      expect(audit.some((e) => e.action === 'telegram_bot.connected')).toBe(true);
      expect(JSON.stringify(audit)).not.toContain(tok);
    });

    it('refuses a token Telegram rejects, a duplicate, and the server bot connected a second time', async () => {
      const rejected = token(fresh());
      h.gateway.rejectedTokens.add(rejected);
      await expect(
        h.bots.add(t.owner, { label: 'Bad', token: rejected })
      ).rejects.toThrow(/did not accept/);
      expect(
        await h.prisma.telegramBot.count({ where: { orgId: t.orgId } })
      ).toBe(0);

      const { tok } = await connect();
      await expect(
        h.bots.add(t.owner, { label: 'Again', token: tok })
      ).rejects.toThrow(ConflictException);
      await expect(
        h.bots.add(t.owner, {
          label: 'Server',
          token: process.env.AGENCY_TELEGRAM_BOT_TOKEN!,
        })
      ).rejects.toThrow(/server settings/);
      expect(
        await h.prisma.telegramBot.count({ where: { orgId: t.orgId } })
      ).toBe(1);
    });

    it('lets any number of bots be connected', async () => {
      for (let i = 0; i < 12; i += 1) await connect(`Bot ${i}`);
      expect((await h.bots.list(t.owner)).bots).toHaveLength(12);
    });

    it('is for owners and admins; staff can see the bots but not connect, change or remove them', async () => {
      const { bot } = await connect();
      await expect(
        h.bots.add(t.manager, { label: 'x', token: token(fresh()) })
      ).rejects.toThrow(ForbiddenException);
      await expect(
        h.bots.setEnabled(t.manager, bot.id, false)
      ).rejects.toThrow(ForbiddenException);
      await expect(h.telegram.removeBot(t.manager, bot.id)).rejects.toThrow(
        ForbiddenException
      );
      await expect(h.bots.list(t.client)).rejects.toThrow(ForbiddenException);
      expect((await h.bots.list(t.manager)).bots).toHaveLength(1);
    });

    it("keeps one workspace's bots out of another's", async () => {
      const { bot } = await connect();
      const rival = await seedTenant(h, 'Rival Agency');
      expect((await h.bots.list(rival.owner)).bots).toHaveLength(0);
      await expect(
        h.bots.setEnabled(rival.owner, bot.id, false)
      ).rejects.toThrow(NotFoundException);
      await expect(h.bots.handleFor(rival.orgId, bot.id)).rejects.toThrow(
        /removed/
      );
    });
  });

  describe('registering a chat', () => {
    it('uses the only bot there is, and must be told which when there are several', async () => {
      // Only the server bot exists: chats keep working as before bots could be added.
      const first = await h.telegram.registerDestination(t.manager, {
        chatId: `-100${fresh()}0001`,
      });
      expect((first.destination as any).botId).toBeNull();

      const { bot } = await connect();
      await expect(
        h.telegram.registerDestination(t.manager, {
          chatId: `-100${fresh()}0002`,
        })
      ).rejects.toThrow(/Choose which bot/);

      const second = await h.telegram.registerDestination(t.manager, {
        chatId: `-100${fresh()}0003`,
        botId: bot.id,
      });
      expect((second.destination as any).botId).toBe(bot.id);
      expect((second.destination as any).botUsername).toBe(bot.username);
      expect(second.botUsername).toBe(bot.username);
      expect(second.steps[0]).toContain(`@${bot.username}`);
    });

    it('refuses a bot that is unknown, paused or someone else’s', async () => {
      const { bot } = await connect();
      const rival = await seedTenant(h, 'Rival Agency');
      await expect(
        h.telegram.registerDestination(t.manager, {
          chatId: '-1001234567001',
          botId: 'nope',
        })
      ).rejects.toThrow(NotFoundException);
      await expect(
        h.telegram.registerDestination(rival.manager, {
          chatId: '-1001234567002',
          botId: bot.id,
        })
      ).rejects.toThrow(NotFoundException);
      await h.telegram.setBotEnabled(t.owner, bot.id, false);
      await expect(
        h.telegram.registerDestination(t.manager, {
          chatId: '-1001234567003',
          botId: bot.id,
        })
      ).rejects.toThrow(NotFoundException);
    });

    it('asks to connect a bot first when there is none to use', async () => {
      const saved = process.env.AGENCY_TELEGRAM_BOT_TOKEN;
      delete process.env.AGENCY_TELEGRAM_BOT_TOKEN;
      try {
        await expect(
          h.telegram.registerDestination(t.manager, {
            chatId: '-1001234567004',
          })
        ).rejects.toThrow(BadRequestException);
        expect(
          await h.telegram.previewChat(t.manager, '-1001234567004')
        ).toMatchObject({
          valid: false,
          error: expect.stringContaining('Telegram bots'),
        });
      } finally {
        process.env.AGENCY_TELEGRAM_BOT_TOKEN = saved;
      }
    });
  });

  describe('which bot hears and which bot posts', () => {
    it('only the bot that holds a chat can authorize it, and it answers in the chat', async () => {
      const a = await connect('Bot A');
      const b = await connect('Bot B');
      const chat = { id: -1002000000001, type: 'supergroup', title: 'Fruit' };
      const reg = await h.telegram.registerDestination(t.manager, {
        chatId: String(chat.id),
        botId: a.bot.id,
      });
      const id = (reg.destination as any).id as string;
      a.fake.makeAdmin(String(chat.id), admin.id);
      b.fake.makeAdmin(String(chat.id), admin.id);
      const handleA = await h.bots.handleFor(t.orgId, a.bot.id);
      const handleB = await h.bots.handleFor(t.orgId, b.bot.id);

      // The code is right and the sender is an admin, but this is the wrong bot: nothing happens.
      await h.telegram.handleUpdate(
        msg(chat, admin, `/authorize ${reg.verificationCode}`) as any,
        handleB
      );
      expect(await status(id)).toBe('PENDING_VERIFICATION');
      expect(b.fake.notices).toHaveLength(0);

      await h.telegram.handleUpdate(
        msg(chat, admin, `/authorize ${reg.verificationCode}`) as any,
        handleA
      );
      expect(await status(id)).toBe('ACTIVE');
      expect(a.fake.notices.some((n) => /now authorized/.test(n.text))).toBe(true);
      expect(b.fake.notices).toHaveLength(0);
    });

    it('posts through the bot of each chat and never through another', async () => {
      const a = await connect('Bot A');
      const b = await connect('Bot B');
      const onA = await activeDestination(h, t.orgId, { botId: a.bot.id });
      const onB = await activeDestination(h, t.orgId, { botId: b.bot.id });
      const onServer = await activeDestination(h, t.orgId);
      const id = await scheduledCampaign(h, t, [onA.id, onB.id, onServer.id]);

      expect(await h.publishing.dispatchDue()).toBe(3);
      expect((await jobsOf(h, id)).map((j) => j.status)).toEqual([
        'SUCCEEDED',
        'SUCCEEDED',
        'SUCCEEDED',
      ]);
      expect(a.fake.sent.map((s) => s.chatId)).toEqual([onA.chatId]);
      expect(b.fake.sent.map((s) => s.chatId)).toEqual([onB.chatId]);
      expect(h.gateway.sent.map((s) => s.chatId)).toEqual([onServer.chatId]);
    });

    it('losing its place in a chat disconnects only the chats that bot serves', async () => {
      const a = await connect('Bot A');
      const b = await connect('Bot B');
      const rival = await seedTenant(h, 'Rival Agency');
      const chatId = '-1002000000009';
      const mine = await activeDestination(h, t.orgId, {
        chatId,
        botId: a.bot.id,
      });
      const theirs = await activeDestination(h, rival.orgId, {
        chatId,
        botId: b.bot.id,
      });
      const kicked = {
        update_id: 1,
        my_chat_member: {
          chat: { id: Number(chatId), type: 'supergroup' },
          new_chat_member: { status: 'kicked' },
        },
      };
      await h.telegram.handleUpdate(
        kicked as any,
        await h.bots.handleFor(t.orgId, a.bot.id)
      );
      expect(await status(mine.id)).toBe('DISCONNECTED');
      expect(await status(theirs.id)).toBe('ACTIVE');
    });
  });

  describe('pausing and removing', () => {
    it('a paused bot stops its chats with a reason, and resuming sends the paused posts', async () => {
      const a = await connect('Bot A');
      const dest = await activeDestination(h, t.orgId, { botId: a.bot.id });
      const id = await scheduledCampaign(h, t, [dest.id]);

      const paused = await h.telegram.setBotEnabled(t.owner, a.bot.id, false);
      expect(paused.status).toBe('DISABLED');
      expect(await h.publishing.dispatchDue()).toBe(1);
      const [blocked] = await jobsOf(h, id);
      expect(blocked).toMatchObject({
        status: 'BLOCKED',
        lastErrorCode: 'UNCONFIGURED',
      });
      expect(blocked.lastError).toMatch(/paused/);
      expect(a.fake.sent).toHaveLength(0);
      expect(h.gateway.sent).toHaveLength(0); // never handed to the server bot

      const resumed = await h.telegram.setBotEnabled(t.owner, a.bot.id, true);
      expect(resumed.status).toBe('ACTIVE');
      expect((await jobsOf(h, id))[0].status).toBe('PENDING');
      await h.publishing.dispatchDue();
      expect((await jobsOf(h, id))[0].status).toBe('SUCCEEDED');
      expect(a.fake.sent).toHaveLength(1);
    });

    it('removing a bot wipes its token and stops its chats, and no other bot takes them over', async () => {
      const a = await connect('Bot A');
      const b = await connect('Bot B');
      const onA = await activeDestination(h, t.orgId, { botId: a.bot.id });
      const onB = await activeDestination(h, t.orgId, { botId: b.bot.id });
      const id = await scheduledCampaign(h, t, [onA.id, onB.id]);

      const out = await h.telegram.removeBot(t.owner, a.bot.id);
      expect(out).toMatchObject({ removed: true, chatsStopped: 1 });
      expect(await status(onA.id)).toBe('DISCONNECTED');
      expect(
        (
          await h.prisma.telegramDestination.findUniqueOrThrow({
            where: { id: onA.id },
          })
        ).lastError
      ).toMatch(/bot was removed/);
      expect(await status(onB.id)).toBe('ACTIVE');

      const row = await h.prisma.telegramBot.findUniqueOrThrow({
        where: { id: a.bot.id },
      });
      expect(row.deletedAt).not.toBeNull();
      expect(row.tokenSealed).toBe('');
      expect((await h.bots.list(t.owner)).bots.map((x) => x.id)).toEqual([
        b.bot.id,
      ]);
      await expect(h.bots.handleFor(t.orgId, a.bot.id)).rejects.toThrow(
        /removed/
      );

      await h.publishing.dispatchDue();
      const jobs = await jobsOf(h, id);
      expect(jobs.filter((j) => j.status === 'SUCCEEDED')).toHaveLength(1);
      expect(a.fake.sent).toHaveLength(0);
      expect(b.fake.sent).toHaveLength(1);
      expect(h.gateway.sent).toHaveLength(0);
    });

    it('a token Telegram stops accepting is marked, and the bot stops being listened for', async () => {
      const a = await connect('Bot A');
      expect((await h.bots.pollable()).map((x) => x.id)).toContain(a.bot.id);
      const handle = await h.bots.handleFor(t.orgId, a.bot.id);
      jest
        .spyOn(a.fake, 'getUpdates')
        .mockRejectedValue(
          gatewayError('UNCONFIGURED', 'Telegram bot token was rejected')
        );
      expect(await h.telegram.pollUpdatesOnce(handle, 0)).toBe(0);

      const [row] = (await h.bots.list(t.owner)).bots;
      expect(row.status).toBe('INVALID');
      expect(row.lastError).toMatch(/rejected/);
      expect((await h.bots.pollable()).map((x) => x.id)).not.toContain(
        a.bot.id
      );
    });

    it('checking a bot asks Telegram again and clears a rejection that has passed', async () => {
      const a = await connect('Bot A');
      await h.prisma.telegramBot.update({
        where: { id: a.bot.id },
        data: { status: 'INVALID', lastError: 'rejected' },
      });
      const checked = await h.bots.check(t.owner, a.bot.id);
      expect(checked).toMatchObject({ status: 'ACTIVE', lastError: null });

      h.gateway.rejectedTokens.add(a.tok);
      const failed = await h.bots.check(t.owner, a.bot.id);
      expect(failed.status).toBe('INVALID');
    });
  });

  describe('what the dashboard may claim', () => {
    it('counts the bots that are listening and says when none is', async () => {
      const a = await connect('Bot A');
      const on = await h.publishing.getSystemStatus();
      expect(on.telegram.configured).toBe(true);
      expect(on.telegram.bots).toBeGreaterThanOrEqual(2); // the server bot and this one

      await h.telegram.setBotEnabled(t.owner, a.bot.id, false);
      const pollable = await h.bots.pollable();
      expect(pollable.map((x) => x.id)).not.toContain(a.bot.id);
    });
  });
});
