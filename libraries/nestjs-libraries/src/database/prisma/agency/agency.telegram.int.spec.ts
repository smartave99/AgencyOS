import { BadRequestException, ConflictException } from '@nestjs/common';
import { AgencyTelegramWebhookController } from '@gitroom/backend/api/routes/agency.telegram.controller';
import { agencyValidationPipe } from '@gitroom/nestjs-libraries/dtos/agency/agency.pipe';
import {
  RegisterTelegramDestinationDto,
  UpdateTelegramDestinationDto,
} from '@gitroom/nestjs-libraries/dtos/agency/telegram.dto';
import {
  activeDestination,
  buildHarness,
  clearQueue,
  describeDb,
  Harness,
  jobsOf,
  scheduledCampaign,
  seedTenant,
  Tenant,
} from './agency.test.support';

// The controller file imports an exception class whose module graph pulls in an
// ESM-only dependency that Jest can't parse; the webhook logic under test doesn't use it.
jest.mock('@gitroom/nestjs-libraries/services/exception.filter', () => ({
  HttpForbiddenException: class extends Error {},
}));

const msg = (chat: any, from: any, text: string, extra: any = {}) => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: { message_id: 1, date: 0, chat, from, text, ...extra },
});

describeDb(
  'Telegram destination consent (real database, fake Telegram)',
  () => {
    let h: Harness;
    let t: Tenant;
    let chatId: number;
    const chat = () => ({
      id: chatId,
      type: 'supergroup',
      title: 'Fruit Lovers',
    });
    const admin = {
      id: 501,
      is_bot: false,
      first_name: 'Ada',
      last_name: 'Lovelace',
    };

    beforeAll(async () => {
      h = await buildHarness();
    });
    afterAll(async () => {
      await h.prisma.$disconnect();
    });
    beforeEach(async () => {
      await clearQueue(h);
      t = await seedTenant(h, 'Fruit Agency');
      chatId = -1000000000 - Math.floor(Math.random() * 1e8);
      h.gateway.sent = [];
      h.gateway.notices = [];
      h.gateway.admins.clear();
      h.gateway.perms.clear();
      h.gateway.permErrors.clear();
      h.gateway.sendErrors.clear();
    });

    const register = async (ref = String(chatId)) => {
      const reg = await h.telegram.registerDestination(t.manager, {
        chatId: ref,
      });
      return {
        id: (reg.destination as any).id as string,
        code: reg.verificationCode,
      };
    };
    const status = async (id: string) =>
      (await h.prisma.telegramDestination.findUniqueOrThrow({ where: { id } }))
        .authorizationStatus;

    describe('registration', () => {
      it('validates the chat reference and settings before saving anything', async () => {
        await expect(
          agencyValidationPipe.transform(
            { chatId: 'not a chat' },
            { type: 'body', metatype: RegisterTelegramDestinationDto }
          )
        ).rejects.toBeDefined();
        await expect(
          agencyValidationPipe.transform(
            { chatId: '@ab' },
            { type: 'body', metatype: RegisterTelegramDestinationDto }
          )
        ).rejects.toBeDefined();
        await expect(
          agencyValidationPipe.transform(
            { chatId: '-1001234567890' },
            { type: 'body', metatype: RegisterTelegramDestinationDto }
          )
        ).resolves.toBeDefined();
        // permission claims in the body are ignored: they come from Telegram only
        const out: any = await agencyValidationPipe.transform(
          {
            chatId: '-1001234567890',
            canPostMessages: true,
            isAuthorized: true,
          },
          { type: 'body', metatype: RegisterTelegramDestinationDto }
        );
        expect(out).toEqual({ chatId: '-1001234567890' });

        await expect(
          h.telegram.registerDestination(t.manager, {
            chatId: '-100123',
            allowedPostingWindows: 'not json',
          } as any)
        ).rejects.toThrow(/valid JSON/);
        await expect(
          h.telegram.registerDestination(t.manager, {
            chatId: '-100124',
            allowedPostingWindows: '[{"start":"9","end":"x"}]',
          } as any)
        ).rejects.toThrow(/Posting windows must look like/);
        await expect(
          h.telegram.registerDestination(t.manager, {
            chatId: '-100125',
            timezone: 'Mars/Olympus',
          } as any)
        ).rejects.toThrow(/Unknown time zone/);
        await expect(
          agencyValidationPipe.transform(
            { postingFrequencyRules: 'x'.repeat(600) },
            { type: 'body', metatype: UpdateTelegramDestinationDto }
          )
        ).rejects.toBeDefined();
      });

      it('registers once per workspace, never exposes the code hash, and stores only a hash', async () => {
        const { id, code } = await register();
        await expect(
          h.telegram.registerDestination(t.manager, { chatId: String(chatId) })
        ).rejects.toThrow(ConflictException);
        const row = await h.prisma.telegramDestination.findUniqueOrThrow({
          where: { id },
        });
        expect(row.verificationCodeHash).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(row)).not.toContain(code);
        const listed = await h.telegram.listDestinations(t.manager);
        expect(JSON.stringify(listed)).not.toContain('verificationCodeHash');
        expect(listed.find((d: any) => d.id === id)).toMatchObject({
          hasPendingVerification: true,
          isAuthorized: false,
        });
      });

      it('@username references are normalised and resolved to the numeric id on authorization', async () => {
        const { id, code } = await register('@Fruit_Lovers');
        expect(
          (
            await h.prisma.telegramDestination.findUniqueOrThrow({
              where: { id },
            })
          ).chatId
        ).toBe('-1009999999'); // resolved by the (fake) getChat
        void code;
      });
    });

    describe('admin proof via /authorize', () => {
      it('a chat administrator activates the destination; consent is recorded and announced in the chat', async () => {
        const { id, code } = await register();
        h.gateway.makeAdmin(String(chatId), admin.id);
        await h.telegram.handleUpdate(msg(chat(), admin, `/authorize ${code}`));

        const row = await h.prisma.telegramDestination.findUniqueOrThrow({
          where: { id },
        });
        expect(row).toMatchObject({
          authorizationStatus: 'ACTIVE',
          isAuthorized: true,
          consentedByTelegramId: '501',
          consentedByName: 'Ada Lovelace',
          verificationCodeHash: null,
          canPostMessages: true,
        });
        const days =
          (row.consentExpiresAt!.getTime() - row.consentGrantedAt!.getTime()) /
          86400000;
        expect(Math.round(days)).toBe(365);
        expect(h.gateway.notices[0].text).toMatch(/Fruit Agency.*authorized/);
        expect(h.gateway.notices[0].text).toMatch(/\/revoke/); // tells the admins how to stop it
        const audit = await h.prisma.auditEvent.findFirst({
          where: { entityId: id, action: 'destination.authorized' },
        });
        expect(audit!.summary).toContain('Ada Lovelace');
      });

      it('the code is single-use', async () => {
        const { id, code } = await register();
        h.gateway.makeAdmin(String(chatId), admin.id);
        await h.telegram.handleUpdate(msg(chat(), admin, `/authorize ${code}`));
        await h.telegram.handleUpdate(msg(chat(), admin, `/revoke`));
        expect(await status(id)).toBe('REVOKED');
        await h.telegram.handleUpdate(msg(chat(), admin, `/authorize ${code}`)); // replay
        expect(await status(id)).toBe('REVOKED');
      });

      it('a member who is not an administrator cannot authorize', async () => {
        const { id, code } = await register();
        await h.telegram.handleUpdate(
          msg(
            chat(),
            { id: 999, is_bot: false, first_name: 'Rando' },
            `/authorize ${code}`
          )
        );
        expect(await status(id)).toBe('PENDING_VERIFICATION');
        expect(h.gateway.notices[0].text).toMatch(/Only a group administrator/);
      });

      it('a bot account cannot authorize', async () => {
        const { id, code } = await register();
        h.gateway.makeAdmin(String(chatId), 7);
        await h.telegram.handleUpdate(
          msg(
            chat(),
            { id: 7, is_bot: true, first_name: 'SomeBot' },
            `/authorize ${code}`
          )
        );
        expect(await status(id)).toBe('PENDING_VERIFICATION');
      });

      it('wrong, malformed and expired codes are ignored silently (no oracle for guessing)', async () => {
        const { id, code } = await register();
        h.gateway.makeAdmin(String(chatId), admin.id);
        await h.telegram.handleUpdate(
          msg(chat(), admin, `/authorize AOS-ZZZZZZZZ`)
        );
        await h.telegram.handleUpdate(
          msg(chat(), admin, `/authorize nonsense`)
        );
        await h.telegram.handleUpdate(
          msg(chat(), admin, `please /authorize ${code}`)
        );
        expect(await status(id)).toBe('PENDING_VERIFICATION');
        expect(h.gateway.notices).toHaveLength(0);

        await h.prisma.telegramDestination.update({
          where: { id },
          data: { verificationExpiresAt: new Date(Date.now() - 1000) },
        });
        await h.telegram.handleUpdate(msg(chat(), admin, `/authorize ${code}`));
        expect(await status(id)).toBe('PENDING_VERIFICATION');
      });

      it('a code only works in the chat it was issued for', async () => {
        const { id, code } = await register();
        const otherChat = {
          id: chatId - 1,
          type: 'supergroup',
          title: 'Elsewhere',
        };
        h.gateway.makeAdmin(String(otherChat.id), admin.id);
        await h.telegram.handleUpdate(
          msg(otherChat, admin, `/authorize ${code}`)
        );
        expect(await status(id)).toBe('PENDING_VERIFICATION');
      });

      it('the bot must itself be able to post, otherwise the destination stays pending and the admin is told why', async () => {
        const { id, code } = await register();
        h.gateway.makeAdmin(String(chatId), admin.id);
        h.gateway.perms.set(String(chatId), {
          isAdmin: false,
          canPostMessages: false,
          canDeleteMessages: false,
          canInviteUsers: false,
        });
        await h.telegram.handleUpdate(msg(chat(), admin, `/authorize ${code}`));
        expect(await status(id)).toBe('PENDING_VERIFICATION');
        expect(h.gateway.notices[0].text).toMatch(
          /administrator with permission to post/
        );

        h.gateway.perms.clear(); // admin fixes it and retries with the same code
        await h.telegram.handleUpdate(msg(chat(), admin, `/authorize ${code}`));
        expect(await status(id)).toBe('ACTIVE');
      });

      it('a channel post counts as admin proof (only admins can post in a channel)', async () => {
        const { id, code } = await register();
        await h.telegram.handleUpdate({
          update_id: 1,
          channel_post: {
            message_id: 1,
            date: 0,
            chat: { id: chatId, type: 'channel', title: 'News' },
            sender_chat: { id: chatId, type: 'channel', title: 'News' },
            author_signature: 'Editor Eve',
            text: `/authorize ${code}`,
          },
        } as any);
        const row = await h.prisma.telegramDestination.findUniqueOrThrow({
          where: { id },
        });
        expect(row).toMatchObject({
          authorizationStatus: 'ACTIVE',
          consentedByName: 'Editor Eve',
          consentedByTelegramId: null,
        });
      });

      it('an anonymous group administrator is accepted; an anonymous non-admin sender is not', async () => {
        const { id, code } = await register();
        const anon = { id: 1087968824, is_bot: true, first_name: 'Group' };
        await h.telegram.handleUpdate(
          msg(chat(), anon, `/authorize ${code}`, {
            sender_chat: { id: chatId, type: 'supergroup' },
            author_signature: 'Boss',
          })
        );
        expect(await status(id)).toBe('ACTIVE');

        const second = await register(String(chatId - 5));
        await h.telegram.handleUpdate(
          msg(
            { id: chatId - 5, type: 'supergroup' },
            anon,
            `/authorize ${second.code}`,
            { sender_chat: { id: 123, type: 'channel' } }
          )
        );
        expect(await status(second.id)).toBe('PENDING_VERIFICATION');
      });
    });

    describe('withdrawing consent', () => {
      it('/revoke from a non-admin does nothing; from an admin it stops every agency using the chat', async () => {
        const dest = await activeDestination(h, t.orgId, {
          chatId: String(chatId),
        });
        const rival = await seedTenant(h, 'Rival');
        const rivalDest = await activeDestination(h, rival.orgId, {
          chatId: String(chatId),
        });
        await h.telegram.handleUpdate(
          msg(chat(), { id: 1, is_bot: false, first_name: 'Member' }, '/revoke')
        );
        expect(await status(dest.id)).toBe('ACTIVE');

        h.gateway.makeAdmin(String(chatId), admin.id);
        await h.telegram.handleUpdate(msg(chat(), admin, '/revoke'));
        expect(await status(dest.id)).toBe('REVOKED');
        expect(await status(rivalDest.id)).toBe('REVOKED');
        expect(h.gateway.notices.at(-1)!.text).toMatch(/revoked/i);
      });

      it('removing the bot from the chat disconnects the destination and pauses its queue', async () => {
        const dest = await activeDestination(h, t.orgId, {
          chatId: String(chatId),
        });
        const campaignId = await scheduledCampaign(h, t, [dest.id], {
          startDate: new Date(Date.now() + 3600_000),
        });
        await h.telegram.handleUpdate({
          update_id: 9,
          my_chat_member: {
            chat: chat(),
            from: admin,
            date: 0,
            old_chat_member: { status: 'administrator' },
            new_chat_member: { status: 'kicked' },
          },
        } as any);
        expect(await status(dest.id)).toBe('DISCONNECTED');
        expect((await jobsOf(h, campaignId))[0].status).toBe('BLOCKED');
      });

      it('losing the right to post in a channel disconnects; keeping it does not', async () => {
        const dest = await activeDestination(h, t.orgId, {
          chatId: String(chatId),
        });
        const change = (can: boolean) => ({
          update_id: 10,
          my_chat_member: {
            chat: { id: chatId, type: 'channel', title: 'News' },
            from: admin,
            date: 0,
            old_chat_member: { status: 'administrator' },
            new_chat_member: {
              status: 'administrator',
              can_post_messages: can,
            },
          },
        });
        await h.telegram.handleUpdate(change(true) as any);
        expect(await status(dest.id)).toBe('ACTIVE');
        await h.telegram.handleUpdate(change(false) as any);
        expect(await status(dest.id)).toBe('DISCONNECTED');
      });

      it('re-authorizing needs a fresh admin /authorize; nothing resumes on its own', async () => {
        const dest = await activeDestination(h, t.orgId, {
          chatId: String(chatId),
        });
        await h.telegram.revoke(t.manager, dest.id, 'client request');
        await expect(h.telegram.resume(t.manager, dest.id)).rejects.toThrow(
          /Only a suspended destination/
        );
        const { verificationCode } = await h.telegram.restartVerification(
          t.manager,
          dest.id
        );
        expect(await status(dest.id)).toBe('PENDING_VERIFICATION');
        h.gateway.makeAdmin(String(chatId), admin.id);
        await h.telegram.handleUpdate(
          msg(chat(), admin, `/authorize ${verificationCode}`)
        );
        expect(await status(dest.id)).toBe('ACTIVE');
      });

      it('an already-active destination cannot be put back into verification', async () => {
        const dest = await activeDestination(h, t.orgId);
        await expect(
          h.telegram.restartVerification(t.manager, dest.id)
        ).rejects.toThrow(/already authorized/);
      });
    });

    describe('staff controls', () => {
      it('suspend pauses the queue; resume re-checks consent and permissions before reopening', async () => {
        const dest = await activeDestination(h, t.orgId);
        const campaignId = await scheduledCampaign(h, t, [dest.id], {
          startDate: new Date(Date.now() + 3600_000),
        });
        await h.telegram.suspend(t.manager, dest.id, 'billing dispute');
        expect(await status(dest.id)).toBe('SUSPENDED');
        expect((await jobsOf(h, campaignId))[0].status).toBe('BLOCKED');

        h.gateway.perms.set(dest.chatId, {
          isAdmin: false,
          canPostMessages: false,
          canDeleteMessages: false,
          canInviteUsers: false,
        });
        await expect(h.telegram.resume(t.manager, dest.id)).rejects.toThrow(
          /no longer an administrator/
        );
        h.gateway.perms.clear();
        await h.telegram.resume(t.manager, dest.id);
        expect(await status(dest.id)).toBe('ACTIVE');
        expect((await jobsOf(h, campaignId))[0].status).toBe('PENDING');
      });

      it('cannot resume once consent has lapsed', async () => {
        const dest = await activeDestination(h, t.orgId);
        await h.telegram.suspend(t.manager, dest.id);
        await h.prisma.telegramDestination.update({
          where: { id: dest.id },
          data: { consentExpiresAt: new Date(Date.now() - 1000) },
        });
        await expect(h.telegram.resume(t.manager, dest.id)).rejects.toThrow(
          /Consent has expired/
        );
      });

      it('a health refresh takes an active destination out of service if the bot lost its rights', async () => {
        const dest = await activeDestination(h, t.orgId);
        h.gateway.perms.set(dest.chatId, {
          isAdmin: true,
          canPostMessages: false,
          canDeleteMessages: false,
          canInviteUsers: false,
        });
        const view: any = await h.telegram.refreshHealth(t.manager, dest.id);
        expect(view.authorizationStatus).toBe('DISCONNECTED');
      });

      it('removing a destination revokes consent and blocks its jobs, and nothing is deleted from history', async () => {
        const dest = await activeDestination(h, t.orgId);
        const campaignId = await scheduledCampaign(h, t, [dest.id], {
          startDate: new Date(Date.now() + 3600_000),
        });
        await h.telegram.remove(t.manager, dest.id);
        const row = await h.prisma.telegramDestination.findUniqueOrThrow({
          where: { id: dest.id },
        });
        expect(row).toMatchObject({
          authorizationStatus: 'REVOKED',
          isAuthorized: false,
        });
        expect(row.deletedAt).not.toBeNull();
        expect((await jobsOf(h, campaignId))[0].status).toBe('BLOCKED');
        expect(
          await h.prisma.auditEvent.count({ where: { entityId: dest.id } })
        ).toBeGreaterThanOrEqual(2);
      });

      it('previewing a chat changes nothing', async () => {
        const before = await h.prisma.telegramDestination.count({
          where: { orgId: t.orgId },
        });
        const preview = await h.telegram.previewChat(t.manager, '-100555');
        expect(preview).toMatchObject({ valid: true, botIsAdmin: true });
        expect(
          await h.prisma.telegramDestination.count({
            where: { orgId: t.orgId },
          })
        ).toBe(before);
      });
    });

    describe('update transport', () => {
      it('the webhook ignores a wrong or missing secret, processes a correct one, and never throws', async () => {
        process.env.AGENCY_TELEGRAM_WEBHOOK_SECRET =
          'correct-horse-battery-staple';
        const { id, code } = await register();
        h.gateway.makeAdmin(String(chatId), admin.id);
        const controller = new AgencyTelegramWebhookController(h.telegram);
        const update: any = msg(chat(), admin, `/authorize ${code}`);

        await expect(controller.webhook(undefined, update)).resolves.toEqual({
          ok: true,
        });
        await expect(
          controller.webhook('wrong-secret-of-the-same-len!', update)
        ).resolves.toEqual({ ok: true });
        expect(await status(id)).toBe('PENDING_VERIFICATION');

        await controller.webhook('correct-horse-battery-staple', update);
        expect(await status(id)).toBe('ACTIVE');

        jest
          .spyOn(h.telegram, 'handleUpdate')
          .mockRejectedValueOnce(new Error('boom'));
        await expect(
          controller.webhook('correct-horse-battery-staple', update)
        ).resolves.toEqual({ ok: true });
        jest.restoreAllMocks();
        delete process.env.AGENCY_TELEGRAM_WEBHOOK_SECRET;
      });

      it('without a configured secret the webhook accepts nothing', async () => {
        delete process.env.AGENCY_TELEGRAM_WEBHOOK_SECRET;
        const { id, code } = await register();
        h.gateway.makeAdmin(String(chatId), admin.id);
        await new AgencyTelegramWebhookController(h.telegram).webhook(
          'anything',
          msg(chat(), admin, `/authorize ${code}`) as any
        );
        expect(await status(id)).toBe('PENDING_VERIFICATION');
      });

      it('polling processes updates, advances its offset, and a malformed update never stops the batch', async () => {
        await h.prisma.leaderLease.deleteMany({
          where: { name: 'agency-telegram-updates' },
        }); // a previous run's lease may still be live
        const { id, code } = await register();
        h.gateway.makeAdmin(String(chatId), admin.id);
        const batch = [
          { update_id: 100 }, // nothing recognisable
          { update_id: 101, message: { chat: chat(), text: null } },
          msg(chat(), admin, `/authorize ${code}`),
        ];
        batch[2].update_id = 102;
        const spy = jest
          .spyOn(h.gateway, 'getUpdates')
          .mockResolvedValueOnce(batch as any)
          .mockResolvedValue([]);
        const server = await h.bots.handleFor(t.orgId, null);
        expect(await h.telegram.pollUpdatesOnce(server, 0)).toBe(3);
        expect(await status(id)).toBe('ACTIVE');
        await h.telegram.pollUpdatesOnce(server, 0);
        expect(spy).toHaveBeenLastCalledWith(103, 0); // acknowledges what it processed
        spy.mockRestore();
      });

      it('only one process holds the polling lease at a time', async () => {
        const name = `test-lease-${Math.random()}`;
        expect(await h.jobsRepo.acquireLease(name, 'proc-A', 60_000)).toBe(
          true
        );
        expect(await h.jobsRepo.acquireLease(name, 'proc-B', 60_000)).toBe(
          false
        );
        expect(await h.jobsRepo.acquireLease(name, 'proc-A', 60_000)).toBe(
          true
        ); // holder renews
        await h.prisma.leaderLease.update({
          where: { name },
          data: { leaseUntil: new Date(Date.now() - 1000) },
        });
        expect(await h.jobsRepo.acquireLease(name, 'proc-B', 60_000)).toBe(
          true
        ); // expired → takeover
        expect(await h.jobsRepo.acquireLease(name, 'proc-A', 60_000)).toBe(
          false
        );
      });
    });

    it('schema: a campaign cannot target the same destination twice', async () => {
      const dest = await activeDestination(h, t.orgId);
      const camp = await h.agency.createCampaign(t.sales, {
        customerId: t.customerId,
        name: 'dupe',
        contentBody: 'x',
        destinations: [
          { destinationType: 'TELEGRAM', telegramDestinationId: dest.id },
        ],
      });
      await expect(
        h.prisma.campaignDestination.create({
          data: {
            campaignId: camp.id,
            destinationType: 'TELEGRAM',
            telegramDestinationId: dest.id,
          },
        })
      ).rejects.toMatchObject({ code: 'P2002' });
      await expect(
        h.agency.updateCampaignDestinations(t.sales, camp.id, [
          { destinationType: 'TELEGRAM', telegramDestinationId: dest.id },
          { destinationType: 'TELEGRAM', telegramDestinationId: dest.id },
        ])
      ).rejects.toThrow(BadRequestException);
    });
  }
);
