import { ForbiddenException } from '@nestjs/common';
import {
  buildHarness,
  connectAccount,
  describeDb,
  Harness,
  seedTenant,
  Tenant,
} from './agency.test.support';

// Like the other Telegram specs: the controller graph is not needed for what is tested here.
jest.mock('@gitroom/nestjs-libraries/services/exception.filter', () => ({
  HttpForbiddenException: class extends Error {},
}));

const token = (n: number) =>
  `${n}:${'x'.repeat(10)}${String(n).padEnd(25, 'q')}`;

describeDb(
  'Telegram identities in one list (real database, fake Telegram)',
  () => {
    let h: Harness;
    let t: Tenant;
    let seed = 3_000_000 + Math.floor(Math.random() * 6_000_000);

    beforeAll(async () => {
      h = await buildHarness();
    });
    afterAll(async () => {
      await h.prisma.$disconnect();
    });
    beforeEach(async () => {
      t = await seedTenant(h, 'overview');
      h.userGateway.errors.clear();
    });

    it('lists bots and user accounts side by side with one set of states', async () => {
      const bot = await h.bots.add(t.owner, {
        label: 'Main bot',
        token: token(++seed),
      });
      const sam = await connectAccount(h, t, {
        username: 'agency_sam',
        label: 'Sam',
      });
      const lee = await connectAccount(h, t, {
        username: 'agency_lee',
        label: 'Lee',
      });
      await h.users.update(t.owner, lee.id, { canPublish: true });
      await h.users.pause(t.owner, sam.id);
      await h.bots.setEnabled(t.owner, bot.id, false);

      const view = await h.overview.overview(t.owner);
      const byLabel = Object.fromEntries(
        view.identities.map((i) => [i.label, i])
      );
      expect(byLabel['Main bot']).toMatchObject({
        kind: 'bot',
        state: 'PAUSED',
        status: 'DISABLED',
      });
      expect(byLabel['Sam']).toMatchObject({
        kind: 'userAccount',
        state: 'PAUSED',
        handle: '@agency_sam',
      });
      expect(byLabel['Lee']).toMatchObject({
        kind: 'userAccount',
        state: 'READY',
      });
      expect(byLabel['Lee'].permissions).toEqual(['research', 'publish']);
      // The bot from the server settings is listed too (the harness has one), and counts as ready.
      expect(
        view.identities.filter((i) => i.kind === 'serverBot')
      ).toHaveLength(1);
      expect(view.totals).toMatchObject({
        all: 4,
        ready: 2,
        paused: 2,
        limited: 0,
        needsAttention: 0,
      });
      expect(view.note).toMatch(/never given to another account/);
      expect(view.worker).toMatchObject({ configured: true });
    });

    it('shows a limited account as limited, with when it may try again, and does not move its work', async () => {
      const sam = await connectAccount(h, t, { username: 'limited_sam' });
      await h.prisma.telegramUserAccount.update({
        where: { id: sam.id },
        data: {
          status: 'RATE_LIMITED',
          rateLimitedUntil: new Date(Date.now() + 60_000),
        },
      });
      const view = await h.overview.overview(t.owner);
      const row = view.identities.find((i) => i.id === sam.id)!;
      expect(row.state).toBe('LIMITED');
      expect(row.retryAt).toBeInstanceOf(Date);
      expect(row.summary).toMatch(/no other account takes them over/);
      // A wait that has run out is shown as ready again.
      await h.prisma.telegramUserAccount.update({
        where: { id: sam.id },
        data: { rateLimitedUntil: new Date(Date.now() - 1000) },
      });
      const later = await h.overview.overview(t.owner);
      expect(later.identities.find((i) => i.id === sam.id)!.state).toBe(
        'READY'
      );
    });

    it('puts a signed-out account and a rejected bot under "needs attention"', async () => {
      const sam = await connectAccount(h, t, { username: 'out_sam' });
      await h.prisma.telegramUserAccount.update({
        where: { id: sam.id },
        data: { status: 'LOGGED_OUT' },
      });
      const bot = await h.bots.add(t.owner, {
        label: 'Old bot',
        token: token(++seed),
      });
      await h.prisma.telegramBot.update({
        where: { id: bot.id },
        data: { status: 'INVALID', lastError: 'Unauthorized' },
      });
      const view = await h.overview.overview(t.owner);
      expect(view.totals.needsAttention).toBe(2);
      expect(view.identities.find((i) => i.id === bot.id)!.lastError).toBe(
        'Unauthorized'
      );
    });

    it('never carries a token, a session or a phone number', async () => {
      await h.bots.add(t.owner, { label: 'Secret bot', token: token(++seed) });
      await connectAccount(h, t, { username: 'private_sam' });
      const text = JSON.stringify(await h.overview.overview(t.owner));
      expect(text).not.toMatch(
        /tokenSealed|tokenHash|sessionSealed|credentialsSealed|:xxxxxxxxxx/
      );
      expect(text).not.toMatch(/\+49151\d{4,}/);
    });

    it('shows only what the person may see, and refuses someone who may see neither', async () => {
      await connectAccount(h, t, { username: 'visible_sam' });
      const seesAccounts = await h.overview.overview(t.manager);
      expect(seesAccounts.identities.length).toBeGreaterThan(0);
      await expect(h.overview.overview(t.client)).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });
  }
);
