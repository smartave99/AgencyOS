import { ForbiddenException } from '@nestjs/common';
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

const NOT_ADMIN = {
  isAdmin: false,
  canPostMessages: false,
  canDeleteMessages: false,
  canInviteUsers: false,
};

describeDb(
  'Backup bots and taking turns (real database, fake Telegram)',
  () => {
    let h: Harness;
    let t: Tenant;
    let seed = 2_000_000 + Math.floor(Math.random() * 7_000_000);
    const tenants: Tenant[] = [];

    beforeAll(async () => {
      h = await buildHarness();
    });
    afterAll(async () => {
      await h.prisma.$disconnect();
    });
    beforeEach(async () => {
      await clearQueue(h);
      t = await seedTenant(h, 'Backup Agency');
      tenants.push(t);
      h.gateway.sent = [];
      h.gateway.notices = [];
      h.gateway.bots.clear();
      h.gateway.rejectedTokens.clear();
    });
    afterEach(async () => {
      await h.prisma.telegramBot.updateMany({
        where: { orgId: { in: tenants.map((x) => x.orgId) }, deletedAt: null },
        data: {
          deletedAt: new Date(),
          status: 'DISABLED',
          tokenSealed: '',
          tokenHash: '',
        },
      });
    });

    const connect = async (label: string) => {
      const tok = `${++seed}:${'x'.repeat(10)}${String(seed).padEnd(25, 'q')}`;
      const bot = await h.bots.add(t.owner, { label, token: tok });
      return { bot, fake: h.gateway.bots.get(tok)! };
    };
    /** A chat served by `main`, with `backups` allowed to help in the way `strategy` says. */
    const chat = async (
      main: { bot: { id: string } },
      backups: Array<{ bot: { id: string } }> = [],
      strategy: 'FAILOVER' | 'ROUND_ROBIN' | 'LEAST_USED' = 'FAILOVER'
    ) => {
      const dest = await activeDestination(h, t.orgId, { botId: main.bot.id });
      if (backups.length || strategy !== 'FAILOVER') {
        await h.telegram.updateChatBots(t.manager, dest.id, {
          backupBotIds: backups.map((b) => b.bot.id),
          strategy,
        });
      }
      return dest;
    };
    const post = async (destId: string, count = 1) => {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        ids.push(await scheduledCampaign(h, t, [destId]));
      }
      await h.publishing.dispatchDue();
      return ids;
    };
    const switches = async () =>
      (
        await h.prisma.auditEvent.findMany({
          where: { orgId: t.orgId, action: 'destination.bot_switched' },
          orderBy: { createdAt: 'asc' },
        })
      ).map((e) => ({ summary: e.summary, ...(e.metadata as any) }));
    const stateOf = (id: string) =>
      h.prisma.telegramDestination.findUniqueOrThrow({ where: { id } });

    describe('choosing backups', () => {
      it('a backup must already be an administrator of the chat; the main bot cannot be its own backup', async () => {
        const main = await connect('Main');
        const other = await connect('Other');
        const dest = await activeDestination(h, t.orgId, {
          botId: main.bot.id,
        });

        other.fake.perms.set(dest.chatId, NOT_ADMIN);
        await expect(
          h.telegram.updateChatBots(t.manager, dest.id, {
            backupBotIds: [other.bot.id],
            strategy: 'FAILOVER',
          })
        ).rejects.toThrow(/as an administrator with permission to post/);
        await expect(
          h.telegram.updateChatBots(t.manager, dest.id, {
            backupBotIds: [main.bot.id],
            strategy: 'FAILOVER',
          })
        ).rejects.toThrow(/cannot also be a backup/);
        expect((await stateOf(dest.id)).backupBotIds).toEqual([]);

        other.fake.perms.delete(dest.chatId); // the chat's administrator added it
        const saved: any = await h.telegram.updateChatBots(t.manager, dest.id, {
          backupBotIds: [other.bot.id, 'server'],
          strategy: 'ROUND_ROBIN',
        });
        expect(saved).toMatchObject({
          backupBotIds: [other.bot.id, 'server'],
          botStrategy: 'ROUND_ROBIN',
        });
        const audit = await h.prisma.auditEvent.findMany({
          where: { orgId: t.orgId, action: 'destination.bots_changed' },
        });
        expect(audit).toHaveLength(1);
      });

      it('is for people who manage destinations, refuses bots that are unknown, paused or someone else’s', async () => {
        const main = await connect('Main');
        const other = await connect('Other');
        const dest = await activeDestination(h, t.orgId, {
          botId: main.bot.id,
        });
        await expect(
          h.telegram.updateChatBots(t.analyst, dest.id, {
            backupBotIds: [other.bot.id],
            strategy: 'FAILOVER',
          })
        ).rejects.toThrow(ForbiddenException);
        await expect(
          h.telegram.updateChatBots(t.manager, dest.id, {
            backupBotIds: ['nope'],
            strategy: 'FAILOVER',
          })
        ).rejects.toThrow(/removed/);
        await h.telegram.setBotEnabled(t.owner, other.bot.id, false);
        await expect(
          h.telegram.updateChatBots(t.manager, dest.id, {
            backupBotIds: [other.bot.id],
            strategy: 'FAILOVER',
          })
        ).rejects.toThrow(/paused/);
      });
    });

    describe('failover: only when AgencyOS cannot use the main bot', () => {
      it('the main bot posts, and nothing is switched while it can', async () => {
        const main = await connect('Main');
        const backup = await connect('Backup');
        const dest = await chat(main, [backup]);
        await post(dest.id, 2);
        expect(main.fake.sent).toHaveLength(2);
        expect(backup.fake.sent).toHaveLength(0);
        expect(await switches()).toEqual([]);
      });

      it('a paused main bot hands over to the backup, logged with time, reason and campaign, and back again', async () => {
        const main = await connect('Main');
        const backup = await connect('Backup');
        const dest = await chat(main, [backup]);

        await h.telegram.setBotEnabled(t.owner, main.bot.id, false);
        const [first] = await post(dest.id);
        expect(backup.fake.sent).toHaveLength(1);
        expect(main.fake.sent).toHaveLength(0);
        const [job] = await jobsOf(h, first);
        expect(job.status).toBe('SUCCEEDED');
        expect((job.receipt as any).bot).toMatchObject({
          key: backup.bot.id,
          username: backup.bot.username,
        });
        const event = await h.prisma.publishingEvent.findFirstOrThrow({
          where: { campaignId: first, status: 'SUCCESS' },
        });
        expect(event.botUsername).toBe(backup.bot.username);

        const log = await switches();
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({
          reason: 'MAIN_UNAVAILABLE',
          from: main.bot.id,
          to: backup.bot.id,
          campaignId: first,
          jobId: job.id,
        });
        expect(log[0].summary).toMatch(/paused/);
        expect((await stateOf(dest.id)).lastBotId).toBe(backup.bot.id);

        // A second post through the same backup is not a new switch.
        await post(dest.id);
        expect(await switches()).toHaveLength(1);

        await h.telegram.setBotEnabled(t.owner, main.bot.id, true);
        await post(dest.id);
        expect(main.fake.sent).toHaveLength(1);
        const after = await switches();
        expect(after).toHaveLength(2);
        expect(after[1]).toMatchObject({ reason: 'MAIN', to: main.bot.id });
      });

      it('never works around a chat: when the chat takes the main bot’s rights away, posting stops, whatever backups exist', async () => {
        const main = await connect('Main');
        const backup = await connect('Backup');
        const dest = await chat(main, [backup]);
        main.fake.perms.set(dest.chatId, NOT_ADMIN);
        const [id] = await post(dest.id);
        const [job] = await jobsOf(h, id);
        expect(job).toMatchObject({
          status: 'BLOCKED',
          lastErrorCode: 'PERMISSION_LOST',
        });
        expect((await stateOf(dest.id)).authorizationStatus).toBe(
          'DISCONNECTED'
        );
        expect(backup.fake.sent).toHaveLength(0);
        expect(main.fake.sent).toHaveLength(0);
      });

      it('never works around Telegram slowing a bot down: the post waits for its own bot', async () => {
        const main = await connect('Main');
        const backup = await connect('Backup');
        const dest = await chat(main, [backup]);
        main.fake.failSendsTo(
          dest.chatId,
          gatewayError('RATE_LIMITED', 'Too Many Requests', 30)
        );
        const [id] = await post(dest.id);
        const [job] = await jobsOf(h, id);
        expect(job.status).toBe('PENDING');
        expect(job.lastErrorCode).toBe('RATE_LIMITED');
        expect(backup.fake.sent).toHaveLength(0);
        expect(await switches()).toEqual([]);
      });

      it('a removed main bot stops its chat, as before; backups are not promoted on their own', async () => {
        const main = await connect('Main');
        const backup = await connect('Backup');
        const dest = await chat(main, [backup]);
        await h.telegram.removeBot(t.owner, main.bot.id);
        expect((await stateOf(dest.id)).authorizationStatus).toBe(
          'DISCONNECTED'
        );
      });
    });

    describe('taking turns', () => {
      it('round robin shares posts across the chat’s bots and logs each change of bot', async () => {
        const a = await connect('A');
        const b = await connect('B');
        const dest = await chat(a, [b], 'ROUND_ROBIN');
        await post(dest.id, 4);
        expect(a.fake.sent).toHaveLength(2);
        expect(b.fake.sent).toHaveLength(2);
        const log = await switches();
        expect(log.length).toBeGreaterThanOrEqual(3); // A, B, A, B: every change after the first post
        expect(
          log.every((e) => ['ROUND_ROBIN', 'MAIN'].includes(e.reason))
        ).toBe(true);
      });

      it('least used gives the next posts to the bot that has sent fewest in the last 24 hours', async () => {
        const a = await connect('A');
        const b = await connect('B');
        const dest = await chat(a, [b], 'LEAST_USED');

        await h.telegram.setBotEnabled(t.owner, b.bot.id, false);
        await post(dest.id, 2); // only A can post
        expect(a.fake.sent).toHaveLength(2);

        await h.telegram.setBotEnabled(t.owner, b.bot.id, true);
        await post(dest.id, 2);
        expect(b.fake.sent).toHaveLength(2); // B is catching up
        expect(a.fake.sent).toHaveLength(2);
      });

      it('a backup the chat no longer lets post leaves the rotation, and the others carry on', async () => {
        const a = await connect('A');
        const b = await connect('B');
        const dest = await chat(a, [b], 'ROUND_ROBIN');
        b.fake.perms.set(dest.chatId, NOT_ADMIN);
        await post(dest.id, 2);
        expect(a.fake.sent).toHaveLength(2);
        expect(b.fake.sent).toHaveLength(0);
        expect((await stateOf(dest.id)).backupBotIds).toEqual([]);
        const dropped = await h.prisma.auditEvent.findMany({
          where: { orgId: t.orgId, action: 'destination.backup_bot_dropped' },
        });
        expect(dropped).toHaveLength(1);
      });

      it('the server bot can take turns too', async () => {
        const a = await connect('A');
        const dest = await activeDestination(h, t.orgId, { botId: a.bot.id });
        await h.telegram.updateChatBots(t.manager, dest.id, {
          backupBotIds: ['server'],
          strategy: 'ROUND_ROBIN',
        });
        await post(dest.id, 2);
        expect(a.fake.sent).toHaveLength(1);
        expect(h.gateway.sent).toHaveLength(1);
      });
    });

    describe('the manual switch', () => {
      it('makes a backup the main bot, keeps the old one as a backup, and logs it', async () => {
        const a = await connect('A');
        const b = await connect('B');
        const dest = await chat(a, [b]);
        const switched: any = await h.telegram.makeMainBot(
          t.manager,
          dest.id,
          b.bot.id
        );
        expect(switched.botId).toBe(b.bot.id);
        expect(switched.botUsername).toBe(b.bot.username);
        expect(switched.backupBotIds).toEqual([a.bot.id]);
        await post(dest.id);
        expect(b.fake.sent).toHaveLength(1);
        const manual = (await switches()).find((e) => e.reason === 'MANUAL');
        expect(manual).toMatchObject({ from: a.bot.id, to: b.bot.id });
      });

      it('only for an authorized chat, only to one of its backups, only if that bot can post', async () => {
        const a = await connect('A');
        const b = await connect('B');
        const dest = await chat(a, [b]);
        await expect(
          h.telegram.makeMainBot(t.manager, dest.id, 'nope')
        ).rejects.toThrow(/backup bots/);
        b.fake.perms.set(dest.chatId, NOT_ADMIN);
        await expect(
          h.telegram.makeMainBot(t.manager, dest.id, b.bot.id)
        ).rejects.toThrow(/administrator/);
        b.fake.perms.delete(dest.chatId);
        await h.telegram.suspend(t.manager, dest.id, 'paused for a test');
        await expect(
          h.telegram.makeMainBot(t.manager, dest.id, b.bot.id)
        ).rejects.toThrow(/authorized chat/);
      });

      it('removing a bot takes it off every chat’s backup list', async () => {
        const a = await connect('A');
        const b = await connect('B');
        const dest = await chat(a, [b]);
        await h.telegram.removeBot(t.owner, b.bot.id);
        expect((await stateOf(dest.id)).backupBotIds).toEqual([]);
      });
    });
  }
);
