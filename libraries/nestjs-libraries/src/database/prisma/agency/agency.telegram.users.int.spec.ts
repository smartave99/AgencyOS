import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TelegramUserGateway } from '@gitroom/nestjs-libraries/integrations/telegram/telegram.user.gateway';
import { AgencyTelegramUsersService } from './agency.telegram.users.service';
import { AgencyTelegramUsersRepository } from './agency.telegram.users.repository';
import {
  buildHarness,
  connectAccount,
  describeDb,
  Harness,
  seedTenant,
  Tenant,
} from './agency.test.support';

describeDb('Telegram user accounts (real database, fake worker)', () => {
  let h: Harness;
  let t: Tenant;

  beforeAll(async () => {
    h = await buildHarness();
  });
  afterAll(async () => {
    await h.prisma.$disconnect();
  });
  beforeEach(async () => {
    t = await seedTenant(h, 'accounts');
    h.userGateway.calls = [];
    h.userGateway.errors.clear();
  });

  const login = async (phone: string, extra: object = {}) => {
    return h.users.startLogin(t.owner, {
      apiId: 123456,
      apiHash: 'a1'.repeat(16),
      phone,
      ...extra,
    });
  };

  describe('signing in', () => {
    it('takes the phone, the code Telegram sent, and keeps only a sealed login and a masked number', async () => {
      const phone = '+4915123456789';
      h.userGateway.person(phone, { username: 'agency_sam' });
      const start = await login(phone, { label: 'Sam’s account' });
      expect(start.loginId).toBeTruthy();

      const done: any = await h.users.submitCode(
        t.owner,
        start.loginId,
        '12345'
      );
      expect(done.status).toBe('connected');
      const account = done.account;
      expect(account).toMatchObject({
        label: 'Sam’s account',
        username: 'agency_sam',
        status: 'ACTIVE',
        permissions: {
          canResearch: true,
          canJoin: false,
          canPublish: false,
          canManage: false,
        },
      });
      expect(account.phoneMasked).toContain('•');
      expect(account.phoneMasked).not.toContain('123456789');

      // The database holds the login only as an AES-GCM blob: no session, api hash or number in the clear.
      const row = await h.prisma.telegramUserAccount.findUniqueOrThrow({
        where: { id: account.id },
      });
      expect(row.sealed).toMatch(/^v1\./);
      const dump = JSON.stringify(row);
      expect(dump).not.toContain('session-');
      expect(dump).not.toContain('a1a1a1');
      expect(dump).not.toContain('4915123456789');

      // Nothing a screen can fetch carries the secret.
      const listed = JSON.stringify(await h.users.list(t.owner));
      expect(listed).not.toContain('sealed');
      expect(listed).not.toContain('session-');
      expect(listed).not.toContain('a1a1a1');

      const events = await h.users.events(t.owner, account.id);
      expect(events.map((e) => e.kind)).toEqual(['CONNECTED']);
    });

    it('asks for the two-step password when the account has one, and lets a wrong code or password be retried', async () => {
      const phone = '+4915198765432';
      h.userGateway.person(phone, { password: 'correct horse' });
      const start = await login(phone);
      await expect(
        h.users.submitCode(t.owner, start.loginId, '00000')
      ).rejects.toThrow(/code is not right/);
      const needs: any = await h.users.submitCode(
        t.owner,
        start.loginId,
        '12345'
      );
      expect(needs.status).toBe('password_required');
      await expect(
        h.users.submitPassword(t.owner, start.loginId, 'wrong')
      ).rejects.toThrow(/password is not right/);
      const done: any = await h.users.submitPassword(
        t.owner,
        start.loginId,
        'correct horse'
      );
      expect(done.status).toBe('connected');
      // The password never reaches storage or the audit trail.
      const audit = JSON.stringify(
        await h.prisma.auditEvent.findMany({ where: { orgId: t.orgId } })
      );
      expect(audit).not.toContain('correct horse');
      expect(audit).not.toContain('12345');
    });

    it('checks what is typed before Telegram is asked, and explains Telegram’s refusals', async () => {
      await expect(
        h.users.startLogin(t.owner, {
          apiId: 1,
          apiHash: 'x',
          phone: '+4915111111111',
        })
      ).rejects.toThrow(/32 letters and digits/);
      await expect(
        h.users.startLogin(t.owner, {
          apiId: 1,
          apiHash: 'a1'.repeat(16),
          phone: '0151 1234',
        })
      ).rejects.toThrow(/country code/);
      await expect(
        h.users.startLogin(t.owner, {
          apiId: 0,
          apiHash: 'a1'.repeat(16),
          phone: '+4915111111111',
        })
      ).rejects.toThrow(/whole number/);
      expect(h.userGateway.calls).toHaveLength(0);
      await expect(login('+4915100000000')).rejects.toThrow(
        /does not accept that phone number/
      );
      const start = await login(
        (h.userGateway.person('+4915133333333'), '+4915133333333')
      );
      await expect(
        h.users.submitCode(t.owner, start.loginId, 'abc')
      ).rejects.toThrow(/digits Telegram sent/);
    });

    it('is finished only by the person who started it, in the agency they started it in', async () => {
      const phone = '+4915144444444';
      h.userGateway.person(phone);
      const start = await login(phone);
      await expect(
        h.users.submitCode(t.manager, start.loginId, '12345')
      ).rejects.toBeInstanceOf(ForbiddenException); // managers cannot connect accounts at all
      const other = await seedTenant(h, 'other');
      await expect(
        h.users.submitCode(other.owner, start.loginId, '12345')
      ).rejects.toBeInstanceOf(NotFoundException);
      await h.users.cancelLogin(t.owner, start.loginId);
      await expect(
        h.users.submitCode(t.owner, start.loginId, '12345')
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('signing in again as the same Telegram account keeps its permissions and history', async () => {
      const first = await connectAccount(h, t, {
        username: 'same_person',
        grants: { canJoin: true },
      });
      const phone = '+4915155555555';
      const person = h.userGateway.person(phone, {
        id: (
          await h.prisma.telegramUserAccount.findUniqueOrThrow({
            where: { id: first.id },
          })
        ).telegramUserId,
      });
      expect(person.id).toBeTruthy();
      const start = await login(phone);
      const done: any = await h.users.submitCode(
        t.owner,
        start.loginId,
        '12345'
      );
      expect(done.account.id).toBe(first.id);
      expect(done.account.permissions.canJoin).toBe(true);
      expect(await h.users.list(t.owner)).toHaveLength(1);
      const events = await h.users.events(t.owner, first.id);
      expect(events.map((e) => e.message)).toEqual(
        expect.arrayContaining(['Signed in again', 'Signed in'])
      );
    });

    it('says plainly when the worker is not set up, and never invents a status', async () => {
      const unset = new AgencyTelegramUsersService(
        new AgencyTelegramUsersRepository(h.prisma),
        h.access,
        new TelegramUserGateway()
      );
      delete process.env.AGENCYOS_TELEGRAM_WORKER_URL;
      const status = await unset.workerStatus(t.owner);
      expect(status).toMatchObject({ configured: false, running: false });
      expect(status.message).toMatch(/not set up/);
      await expect(
        unset.startLogin(t.owner, {
          apiId: 1,
          apiHash: 'a1'.repeat(16),
          phone: '+4915166666666',
        })
      ).rejects.toThrow(/worker is not running/);
    });
  });

  describe('permissions', () => {
    it('start with research only; an owner grants the rest, each change is recorded', async () => {
      const a = await connectAccount(h, t);
      const updated = await h.users.update(t.owner, a.id, {
        canJoin: true,
        canPublish: true,
        label: 'Outreach',
      });
      expect(updated.permissions).toEqual({
        canResearch: true,
        canJoin: true,
        canPublish: true,
        canManage: false,
      });
      expect(updated.label).toBe('Outreach');
      const events = await h.users.events(t.owner, a.id);
      expect(events[0].kind).toBe('PERMISSIONS_CHANGED');
      expect(events[0].message).toMatch(/allowed to join/);
      const audit = await h.prisma.auditEvent.findMany({
        where: {
          orgId: t.orgId,
          action: 'telegram_account.permissions_changed',
        },
      });
      expect(audit).toHaveLength(1);
    });

    it('can be changed, seen and used only by the right roles', async () => {
      const a = await connectAccount(h, t);
      for (const who of [t.manager, t.sales, t.analyst, t.client]) {
        await expect(
          h.users.update(who, a.id, { canPublish: true })
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(h.users.logout(who, a.id)).rejects.toBeInstanceOf(
          ForbiddenException
        );
      }
      expect(await h.users.list(t.manager)).toHaveLength(1); // staff can see them
      await expect(h.users.list(t.client)).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it('are checked every time the account is used, with the reason in words', async () => {
      const a = await connectAccount(h, t);
      await expect(
        h.users.credentialsFor(t.orgId, a.id, 'canPublish')
      ).rejects.toThrow(/not allowed to post advertisements/);
      await expect(
        h.users.credentialsFor(t.orgId, a.id, 'canJoin')
      ).rejects.toThrow(/not allowed to join or leave/);
      const { creds } = await h.users.credentialsFor(
        t.orgId,
        a.id,
        'canResearch'
      );
      expect(creds.session).toMatch(/^session-/);
    });

    it('never cross agencies', async () => {
      const a = await connectAccount(h, t);
      const other = await seedTenant(h, 'other');
      expect(await h.users.list(other.owner)).toEqual([]);
      await expect(h.users.pause(other.owner, a.id)).rejects.toBeInstanceOf(
        NotFoundException
      );
      await expect(
        h.users.credentialsFor(other.orgId, a.id, 'canResearch')
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('what Telegram does to an account', () => {
    it('a limit is waited out, shown, and then forgotten, never worked around', async () => {
      const a = await connectAccount(h, t);
      await h.users.recordFailure(
        t.orgId,
        a.id,
        h.userGateway.err('RATE_LIMITED', 'flood', 90)
      );
      const [limited] = await h.users.list(t.owner);
      expect(limited.status).toBe('RATE_LIMITED');
      expect(limited.rateLimitedUntil!.getTime()).toBeGreaterThan(
        Date.now() + 60_000
      );
      await expect(
        h.users.credentialsFor(t.orgId, a.id, 'canResearch')
      ).rejects.toMatchObject({ reason: 'RATE_LIMITED' });
      // Once the time has passed it is simply usable again.
      await h.prisma.telegramUserAccount.update({
        where: { id: a.id },
        data: { rateLimitedUntil: new Date(Date.now() - 1000) },
      });
      expect((await h.users.list(t.owner))[0].status).toBe('ACTIVE');
      await h.users.credentialsFor(t.orgId, a.id, 'canResearch');
    });

    it('a restriction or an ended login stops the account and says so; another account is never used instead', async () => {
      const a = await connectAccount(h, t);
      const b = await connectAccount(h, t);
      await h.users.recordFailure(
        t.orgId,
        a.id,
        h.userGateway.err('ACCOUNT_RESTRICTED', 'peer flood')
      );
      await h.users.recordFailure(
        t.orgId,
        b.id,
        h.userGateway.err('SESSION_INVALID', 'revoked')
      );
      const list = await h.users.list(t.owner);
      expect(list.find((x) => x.id === a.id)!.status).toBe('RESTRICTED');
      expect(list.find((x) => x.id === b.id)!.status).toBe('SESSION_INVALID');
      await expect(
        h.users.credentialsFor(t.orgId, a.id, 'canResearch')
      ).rejects.toMatchObject({ reason: 'RESTRICTED' });
      await expect(
        h.users.credentialsFor(t.orgId, b.id, 'canResearch')
      ).rejects.toMatchObject({ reason: 'SESSION_INVALID' });
      // The quiet background lookup uses the first research account only: when it is not in good standing there is none.
      expect(await h.users.firstResearchAccountId(t.orgId)).toBeNull();
      expect((await h.users.events(t.owner, a.id))[0]).toMatchObject({
        kind: 'RESTRICTED',
        code: 'ACCOUNT_RESTRICTED',
      });
    });

    it('a health check asks Telegram and records the answer; a paused account stays paused', async () => {
      const a = await connectAccount(h, t);
      const ok = await h.users.check(t.owner, a.id);
      expect(ok.status).toBe('ACTIVE');
      expect(ok.lastCheckedAt).not.toBeNull();
      await h.users.pause(t.owner, a.id);
      expect((await h.users.check(t.owner, a.id)).status).toBe('PAUSED');
      await h.users.resume(t.owner, a.id);

      // Telegram ended the login from the phone's device list.
      const row = await h.prisma.telegramUserAccount.findUniqueOrThrow({
        where: { id: a.id },
      });
      for (const [session] of h.userGateway.sessions)
        h.userGateway.revoked.add(session);
      const after = await h.users.check(t.owner, a.id);
      expect(after.status).toBe('SESSION_INVALID');
      expect(row.id).toBe(a.id);
      const kinds = (await h.users.events(t.owner, a.id)).map((e) => e.kind);
      expect(kinds).toEqual(
        expect.arrayContaining([
          'HEALTH_OK',
          'SESSION_INVALID',
          'PAUSED',
          'RESUMED',
        ])
      );
    });

    it('pause stops its use; only a paused account can be resumed', async () => {
      const a = await connectAccount(h, t);
      await h.users.pause(t.owner, a.id);
      await expect(
        h.users.credentialsFor(t.orgId, a.id, 'canResearch')
      ).rejects.toMatchObject({ reason: 'PAUSED' });
      await h.users.resume(t.owner, a.id);
      await h.users.credentialsFor(t.orgId, a.id, 'canResearch');
      await expect(h.users.resume(t.owner, a.id)).rejects.toBeInstanceOf(
        BadRequestException
      );
    });
  });

  describe('signing out and removing', () => {
    it('ends the login at Telegram, wipes the sealed login, and switches every permission off', async () => {
      const a = await connectAccount(h, t, {
        grants: { canJoin: true, canPublish: true, canManage: true },
      });
      const revokedBefore = h.userGateway.revoked.size;
      const out = await h.users.logout(t.owner, a.id);
      expect(out.endedAtTelegram).toBe(true);
      expect(out.account.status).toBe('LOGGED_OUT');
      expect(out.account.permissions).toEqual({
        canResearch: true,
        canJoin: false,
        canPublish: false,
        canManage: false,
      });
      const row = await h.prisma.telegramUserAccount.findUniqueOrThrow({
        where: { id: a.id },
      });
      expect(row.sealed).toBe('');
      expect(h.userGateway.revoked.size).toBe(revokedBefore + 1);
      await expect(
        h.users.credentialsFor(t.orgId, a.id, 'canResearch')
      ).rejects.toMatchObject({ reason: 'LOGGED_OUT' });
    });

    it('still wipes the local copy when Telegram cannot be reached, and says how to finish', async () => {
      const a = await connectAccount(h, t);
      h.userGateway.fail('/v1/account/logout', h.userGateway.err('NETWORK'));
      const out = await h.users.logout(t.owner, a.id);
      expect(out.endedAtTelegram).toBe(false);
      expect((await h.users.events(t.owner, a.id))[0].message).toMatch(
        /Devices/
      );
      expect(
        (
          await h.prisma.telegramUserAccount.findUniqueOrThrow({
            where: { id: a.id },
          })
        ).sealed
      ).toBe('');
    });

    it('is removed only after signing out, and not while chats still post through it', async () => {
      const a = await connectAccount(h, t);
      await expect(h.users.remove(t.owner, a.id)).rejects.toThrow(
        /Sign the account out/
      );
      await h.users.logout(t.owner, a.id);
      await h.prisma.telegramDestination.create({
        data: {
          orgId: t.orgId,
          chatId: '-1007770001',
          title: 'Linked',
          senderKind: 'USER_ACCOUNT',
          userAccountId: a.id,
        },
      });
      await expect(h.users.remove(t.owner, a.id)).rejects.toThrow(
        /chat\(s\) still post/
      );
      await h.prisma.telegramDestination.deleteMany({
        where: { orgId: t.orgId },
      });
      expect(await h.users.remove(t.owner, a.id)).toEqual({ removed: true });
      expect(await h.users.list(t.owner)).toEqual([]);
    });
  });
});
