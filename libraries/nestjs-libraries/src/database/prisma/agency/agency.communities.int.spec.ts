import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import {
  activeDestination,
  buildHarness,
  connectAccount,
  describeDb,
  Harness,
  seedTenant,
  Tenant,
} from './agency.test.support';

const name = (stem = 'bakery') => `${stem}_${randomBytes(3).toString('hex')}`;

describeDb(
  'Communities: research and the road to an authorized chat (real database, fake worker)',
  () => {
    let h: Harness;
    let t: Tenant;

    beforeAll(async () => {
      h = await buildHarness();
    });
    afterAll(async () => {
      await h.prisma.$disconnect();
    });
    beforeEach(async () => {
      t = await seedTenant(h, 'communities');
      h.userGateway.calls = [];
      h.userGateway.errors.clear();
    });

    const researcher = () => connectAccount(h, t);
    const full = () =>
      connectAccount(h, t, {
        grants: { canJoin: true, canPublish: true, canManage: true },
      });
    const rows = (id: string) =>
      h.prisma.community.findUniqueOrThrow({
        where: { id },
        include: { destinations: true },
      });

    /** Puts a public community in the directory, as a person would: by naming it. */
    const saved = async (accountId: string, username = name(), over = {}) => {
      const entry = h.userGateway.community(username, over);
      await h.communities.importRefs(t.manager, {
        accountId,
        refs: [`@${username}`],
      });
      const row = await h.prisma.community.findFirstOrThrow({
        where: { orgId: t.orgId, username },
      });
      return { entry, row, username };
    };

    describe('research', () => {
      it('shows Telegram’s public results and whether each is already saved', async () => {
        const a = await researcher();
        const stem = name('sourdough');
        h.userGateway.community(`${stem}_one`, {
          title: `${stem} Lovers`,
          memberCount: 5400,
        });
        h.userGateway.community(`${stem}_two`, {
          title: `${stem} Club`,
          memberCount: null,
        });
        await h.communities.importRefs(t.manager, {
          accountId: a.id,
          refs: [`@${stem}_one`],
        });

        const found = await h.communities.search(t.manager, {
          accountId: a.id,
          query: stem,
        });
        expect(found.results.map((r) => r.username).sort()).toEqual([
          `${stem}_one`,
          `${stem}_two`,
        ]);
        expect(
          found.results.find((r) => r.username === `${stem}_one`)!.saved
        ).toMatchObject({ stage: 'DISCOVERED' });
        expect(
          found.results.find((r) => r.username === `${stem}_two`)!.saved
        ).toBeNull();
        // Nothing was saved by looking.
        expect(
          await h.prisma.community.count({ where: { orgId: t.orgId } })
        ).toBe(1);
        await expect(
          h.communities.search(t.manager, { accountId: a.id, query: ' x ' })
        ).rejects.toThrow(/2 to 100/);
      });

      it('saves exactly what Telegram returned: a count it did not give stays empty, and a repeat updates instead of duplicating', async () => {
        const a = await researcher();
        const username = name();
        const entry = h.userGateway.community(username, {
          memberCount: null,
          title: 'Old title',
        });
        const first = await h.communities.importRefs(t.manager, {
          accountId: a.id,
          refs: [
            `@${username}`,
            `https://t.me/${username}`,
            'not a link',
            'https://t.me/+secretinvite',
            'ab',
          ],
          tags: ['Bakery', 'bakery', ' local '],
          category: 'Food',
          language: 'en',
        });
        expect(first.created).toBe(1);
        expect(first.failed.map((f) => f.code).sort()).toEqual([
          'DUPLICATE',
          'INVALID_REF',
          'INVALID_REF',
          'PRIVATE',
        ]);
        const row = await h.prisma.community.findFirstOrThrow({
          where: { orgId: t.orgId, username },
        });
        expect(row.memberCount).toBeNull();
        expect(row.tags).toEqual(['bakery', 'local']);
        expect(row).toMatchObject({
          category: 'Food',
          language: 'en',
          stage: 'DISCOVERED',
          relation: 'PUBLIC_NOT_JOINED',
        });

        entry.community.title = 'New title';
        entry.community.memberCount = 777;
        const again = await h.communities.importRefs(t.manager, {
          accountId: a.id,
          refs: [`@${username}`],
        });
        expect(again).toMatchObject({ created: 0, updated: 1 });
        expect(
          await h.prisma.community.count({ where: { orgId: t.orgId } })
        ).toBe(1);
        const changed = await h.prisma.community.findUniqueOrThrow({
          where: { id: row.id },
        });
        expect(changed).toMatchObject({ title: 'New title', memberCount: 777 });
        const history = await h.prisma.communityHistory.findMany({
          where: { communityId: row.id },
          orderBy: { createdAt: 'asc' },
        });
        expect(history.map((x) => x.kind)).toEqual(['CREATED', 'REFRESH']);
        expect((history[1].changes as any).title).toEqual([
          'Old title',
          'New title',
        ]);
      });

      it('is bounded, needs an account allowed to research, and is for people who do outreach', async () => {
        const a = await researcher();
        const many = Array.from({ length: 51 }, (_, i) => `@bakery_x${i}00`);
        await expect(
          h.communities.importRefs(t.manager, { accountId: a.id, refs: many })
        ).rejects.toThrow(/at most 50/);
        await expect(
          h.communities.importRefs(t.manager, { accountId: a.id, refs: [] })
        ).rejects.toBeInstanceOf(BadRequestException);
        await h.users.update(t.owner, a.id, { canResearch: false });
        await expect(
          h.communities.search(t.manager, { accountId: a.id, query: 'bakery' })
        ).rejects.toThrow(/not allowed to look up public communities/);
        await expect(
          h.communities.search(t.analyst, { accountId: a.id, query: 'bakery' })
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(await h.communities.list(t.analyst)).toEqual([]); // analysts may read the directory
        await expect(h.communities.list(t.client)).rejects.toBeInstanceOf(
          ForbiddenException
        );
      });

      it('stops at a Telegram limit: the account waits, nothing else is tried, and what was not done is listed', async () => {
        const a = await researcher();
        const b = await researcher();
        const username = name();
        h.userGateway.community(username);
        h.userGateway.fail(
          '/v1/communities/refresh',
          h.userGateway.err('RATE_LIMITED', 'flood', 120)
        );
        const out = await h.communities.importRefs(t.manager, {
          accountId: a.id,
          refs: [`@${username}`],
        });
        expect(out).toMatchObject({ created: 0, retryAfterSeconds: 60 });
        expect(out.failed[0].code).toBe('RATE_LIMITED');
        const list = await h.users.list(t.owner);
        expect(list.find((x) => x.id === a.id)!.status).toBe('RATE_LIMITED');
        expect(list.find((x) => x.id === b.id)!.status).toBe('ACTIVE');
        // The other account was not used in its place.
        const used = h.userGateway.calls
          .filter((c) => (c.body as any).account)
          .map((c) => (c.body as any).account.session);
        expect(new Set(used).size).toBe(1);
        // While limited, the account refuses further requests without asking Telegram.
        h.userGateway.calls = [];
        await expect(
          h.communities.search(t.manager, { accountId: a.id, query: 'bakery' })
        ).rejects.toThrow(/asked .* to wait/);
        expect(h.userGateway.calls).toHaveLength(0);
      });

      it('a refresh records what changed, marks a community Telegram no longer shows, and stays inside its agency', async () => {
        const a = await researcher();
        const { entry, row, username } = await saved(a.id);
        entry.community.description = 'Now with pastries';
        const out = await h.communities.refresh(t.manager, {
          accountId: a.id,
          ids: [row.id],
        });
        expect(out).toMatchObject({ refreshed: 1, changed: 1, problems: [] });
        const detail = await h.communities.get(t.manager, row.id);
        expect(detail.history[0].kind).toBe('REFRESH');
        expect((detail.history[0].changes as any).description[1]).toBe(
          'Now with pastries'
        );

        h.userGateway.world.delete(username.toLowerCase());
        const gone = await h.communities.refresh(t.manager, {
          accountId: a.id,
          ids: [row.id],
        });
        expect(gone.problems).toEqual([
          { id: row.id, title: row.title, code: 'NOT_FOUND' },
        ]);
        expect((await rows(row.id)).available).toBe(false);
        await expect(
          h.communities.refresh(t.manager, {
            accountId: a.id,
            ids: Array(21)
              .fill(row.id)
              .map((_, i) => `${row.id}${i}`),
          })
        ).rejects.toThrow(/at most 20/);

        const other = await seedTenant(h, 'other');
        await expect(
          h.communities.get(other.owner, row.id)
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(await h.communities.list(other.owner)).toEqual([]);
      });

      it('keeps labels and bookmarks, filters and sorts, exports metadata only, and points at likely repeats', async () => {
        const a = await researcher();
        const one = await saved(a.id, name('alpha'), {
          title: 'Bread Club',
          memberCount: 50,
        });
        const two = await saved(a.id, name('beta'), {
          title: 'bread  club!',
          memberCount: 900,
        });
        const three = await saved(a.id, name('gamma'), {
          title: 'Cheese',
          memberCount: null,
        });
        await h.communities.update(t.sales, one.row.id, {
          tags: ['Food', 'Local'],
          category: 'Food',
          language: 'en',
          notes: 'Friendly admins',
          bookmarked: true,
        });
        await h.communities.update(t.sales, two.row.id, { category: 'Food' });

        expect(
          (await h.communities.list(t.sales, { bookmarked: true })).map(
            (c) => c.id
          )
        ).toEqual([one.row.id]);
        expect(
          (
            await h.communities.list(t.sales, {
              category: 'Food',
              sort: 'members',
            })
          ).map((c) => c.id)
        ).toEqual([two.row.id, one.row.id]);
        expect(
          (await h.communities.list(t.sales, { tag: 'local' })).map((c) => c.id)
        ).toEqual([one.row.id]);
        expect(
          (await h.communities.list(t.sales, { search: '@GAMMA' })).map(
            (c) => c.id
          )
        ).toEqual([three.row.id]);

        const exported = await h.communities.exportRows(t.sales, {});
        expect(exported).toHaveLength(3);
        expect(Object.keys(exported[0]).sort()).toEqual(
          [
            'available',
            'category',
            'description',
            'kind',
            'language',
            'lastRefreshed',
            'link',
            'members',
            'relation',
            'stage',
            'tags',
            'title',
            'username',
          ].sort()
        );
        expect(
          exported.find((r) => r.username === three.username)!.members
        ).toBe('');

        const repeats = await h.communities.duplicates(t.sales);
        expect(repeats).toHaveLength(1);
        expect(repeats[0].map((r) => r.id).sort()).toEqual(
          [one.row.id, two.row.id].sort()
        );
        const history = await h.communities.get(t.sales, one.row.id);
        expect(history.history.map((x) => x.kind)).toContain('LABELS');
      });

      it('checks a pasted list without asking Telegram, and reads public messages only on request, a few at a time, never stored', async () => {
        const checked = h.communities.validateLinks(t.sales, [
          '@good_name',
          'https://t.me/good_name',
          'bad',
          'https://t.me/+invite',
          'https://example.com/x',
        ]);
        expect(checked.map((c) => c.ok)).toEqual([
          true,
          false,
          false,
          false,
          false,
        ]);
        expect(checked[1].reason).toBe('Listed twice');
        expect(h.userGateway.calls).toHaveLength(0);

        const a = await researcher();
        const { entry, row } = await saved(a.id);
        entry.messages.push({
          id: '1',
          date: new Date().toISOString(),
          text: 'Hello public channel',
        });
        const read = await h.communities.publicMessages(t.sales, row.id, a.id);
        expect(read.messages).toEqual([
          expect.objectContaining({ text: 'Hello public channel' }),
        ]);
        expect(JSON.stringify(await rows(row.id))).not.toContain(
          'Hello public channel'
        );
        const audit = await h.prisma.auditEvent.findMany({
          where: { orgId: t.orgId, action: 'research.messages_viewed' },
        });
        expect(audit).toHaveLength(1);
        expect(audit[0].summary).not.toContain('Hello');
        for (let i = 0; i < 9; i++)
          await h.communities.publicMessages(t.sales, row.id, a.id);
        await expect(
          h.communities.publicMessages(t.sales, row.id, a.id)
        ).rejects.toThrow(/Slow down/);
      });

      it('never asks Telegram for people: no member list, no phone numbers, nobody added', async () => {
        const a = await full();
        const { row } = await saved(a.id);
        await h.communities
          .search(t.manager, { accountId: a.id, query: 'bakery' })
          .catch(() => undefined);
        await h.communities.refresh(t.manager, {
          accountId: a.id,
          ids: [row.id],
        });
        await h.communities.join(t.manager, row.id, {
          accountId: a.id,
          reason: 'Good fit for bakeries',
          confirmed: true,
        });
        const asked = new Set(h.userGateway.calls.map((c) => c.path));
        for (const path of asked) {
          expect(path).not.toMatch(
            /participant|member|add|invite-user|phone|contact/i
          );
        }
        // Every request carried an account and nothing that names people to contact.
        for (const c of h.userGateway.calls) {
          expect(Object.keys(c.body as object)).not.toEqual(
            expect.arrayContaining(['users'])
          );
        }
      });
    });

    describe('joining', () => {
      it('is one person’s decision with a reason, through an account allowed to join, and is recorded', async () => {
        const a = await researcher();
        const { row } = await saved(a.id);
        await expect(
          h.communities.join(t.manager, row.id, {
            accountId: a.id,
            reason: 'Good fit',
            confirmed: false,
          })
        ).rejects.toThrow(/Confirm/);
        await expect(
          h.communities.join(t.manager, row.id, {
            accountId: a.id,
            reason: '',
            confirmed: true,
          })
        ).rejects.toThrow(/Say why/);
        await expect(
          h.communities.join(t.manager, row.id, {
            accountId: a.id,
            reason: 'Good fit',
            confirmed: true,
          })
        ).rejects.toThrow(/not allowed to join/);
        await expect(
          h.communities.join(t.sales, row.id, {
            accountId: a.id,
            reason: 'Good fit',
            confirmed: true,
          })
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.userGateway.asked('/v1/communities/join')).toHaveLength(0);

        await h.users.update(t.owner, a.id, { canJoin: true });
        const joined = await h.communities.join(t.manager, row.id, {
          accountId: a.id,
          reason: 'Bakery owners hang out here',
          confirmed: true,
        });
        expect(joined).toMatchObject({
          stage: 'JOINED',
          relation: 'MEMBER',
          operatingAccountId: a.id,
        });
        expect(h.userGateway.asked('/v1/communities/join')).toHaveLength(1);
        const history = await h.prisma.communityHistory.findMany({
          where: { communityId: row.id },
          orderBy: { createdAt: 'asc' },
        });
        expect(history.map((x) => x.kind)).toEqual([
          'CREATED',
          'JOIN',
          'STAGE',
        ]);
        expect(history[1].summary).toContain('Bakery owners hang out here');
        await expect(
          h.communities.join(t.manager, row.id, {
            accountId: a.id,
            reason: 'Again please',
            confirmed: true,
          })
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('waits when the community asks its administrators, and moves on only when Telegram shows the account as a member', async () => {
        const a = await full();
        const { entry, row } = await saved(a.id, name(), {
          joinRequestRequired: true,
        });
        const pending = await h.communities.join(t.manager, row.id, {
          accountId: a.id,
          reason: 'Invitation only group',
          confirmed: true,
        });
        expect(pending.stage).toBe('JOIN_REQUEST_PENDING');
        expect(pending.relation).toBe('PUBLIC_NOT_JOINED');
        expect(
          (await h.communities.checkMembership(t.manager, row.id)).stage
        ).toBe('JOIN_REQUEST_PENDING');
        const session = [...entry.pending][0];
        entry.members.add(session);
        expect(
          (await h.communities.checkMembership(t.manager, row.id)).stage
        ).toBe('JOINED');
      });

      it('is capped per account per day, and Telegram’s limit is passed on, not slept through', async () => {
        process.env.AGENCY_JOIN_DAILY_CAP = '2';
        try {
          const a = await full();
          for (let i = 0; i < 2; i++) {
            const { row } = await saved(a.id);
            await h.communities.join(t.manager, row.id, {
              accountId: a.id,
              reason: `Joining number ${i}`,
              confirmed: true,
            });
          }
          const { row } = await saved(a.id);
          await expect(
            h.communities.join(t.manager, row.id, {
              accountId: a.id,
              reason: 'One too many',
              confirmed: true,
            })
          ).rejects.toThrow(/already joined 2/);
        } finally {
          delete process.env.AGENCY_JOIN_DAILY_CAP;
        }
        const b = await full();
        const { row } = await saved(b.id);
        h.userGateway.fail(
          '/v1/communities/join',
          h.userGateway.err('RATE_LIMITED', 'flood', 300)
        );
        await expect(
          h.communities.join(t.manager, row.id, {
            accountId: b.id,
            reason: 'Trying again',
            confirmed: true,
          })
        ).rejects.toThrow(/wait 300 seconds/);
        expect((await rows(row.id)).stage).toBe('DISCOVERED');
        expect(
          (await h.users.list(t.owner)).find((x) => x.id === b.id)!.status
        ).toBe('RATE_LIMITED');
      });

      it('is refused for a community marked not eligible until a person reopens it', async () => {
        const a = await full();
        const { row } = await saved(a.id);
        await h.communities.markNotEligible(
          t.manager,
          row.id,
          'Rules forbid promotion'
        );
        await expect(
          h.communities.join(t.manager, row.id, {
            accountId: a.id,
            reason: 'Changed my mind',
            confirmed: true,
          })
        ).rejects.toThrow(/not eligible or blocked/);
        expect(
          (await h.communities.reopen(t.manager, row.id, 'Rules changed')).stage
        ).toBe('REVIEW_REQUIRED');
        const joined = await h.communities.join(t.manager, row.id, {
          accountId: a.id,
          reason: 'Rules were updated',
          confirmed: true,
        });
        expect(joined.stage).toBe('JOINED');
      });
    });

    describe('advertising permission and authorization', () => {
      const joined = async () => {
        const a = await full();
        const made = await saved(a.id);
        await h.communities.join(t.manager, made.row.id, {
          accountId: a.id,
          reason: 'Good fit for us',
          confirmed: true,
        });
        return { a, ...made };
      };
      const allow = (id: string, extra = {}) =>
        h.communities.reviewAdvertising(t.manager, id, {
          decision: 'ALLOWED',
          note: 'Pinned rules say one promo post per week is fine.',
          evidenceUrl: 'https://t.me/rules/1',
          rulesRead: true,
          advertisingPermitted: true,
          ...extra,
        });

      it('is a recorded human review of the rules: it needs the confirmations, a note and a joined community', async () => {
        const a = await full();
        const { row } = await saved(a.id);
        await expect(allow(row.id)).rejects.toThrow(/Join the community first/);
        await h.communities.join(t.manager, row.id, {
          accountId: a.id,
          reason: 'Good fit for us',
          confirmed: true,
        });
        await expect(allow(row.id, { rulesRead: false })).rejects.toThrow(
          /read the community’s rules/
        );
        await expect(allow(row.id, { note: 'ok' })).rejects.toThrow(
          /at least a sentence/
        );
        await expect(
          allow(row.id, { evidenceUrl: 'javascript:alert(1)' })
        ).rejects.toThrow(/https/);
        const ok = await allow(row.id);
        expect(ok).toMatchObject({
          stage: 'ADVERTISING_ALLOWED',
          adReview: 'ALLOWED',
          adReviewedById: t.userIds.manager,
        });
        expect(ok.adReviewEvidenceUrl).toBe('https://t.me/rules/1');
      });

      it('cannot approve a community Telegram marks as a scam', async () => {
        const a = await full();
        const { row } = await saved(a.id, name(), { scam: true });
        await h.communities.join(t.manager, row.id, {
          accountId: a.id,
          reason: 'Checking it out',
          confirmed: true,
        });
        await expect(allow(row.id)).rejects.toThrow(/scam or fake/);
      });

      it('registers a place to post only after that review, through the one account that is a member who may write', async () => {
        const { a, row } = await joined();
        await expect(
          h.communities.authorize(t.manager, row.id, a.id)
        ).rejects.toThrow(/advertising is allowed here first/);
        await allow(row.id);
        const research = await researcher();
        await expect(
          h.communities.authorize(t.manager, row.id, research.id)
        ).rejects.toThrow(/Another account is joined/);
        const out = await h.communities.authorize(t.manager, row.id, a.id);
        expect(out.community.stage).toBe('PUBLISHING_AUTHORIZED');
        const dest = await h.prisma.telegramDestination.findUniqueOrThrow({
          where: { id: out.destinationId },
        });
        expect(dest).toMatchObject({
          senderKind: 'USER_ACCOUNT',
          userAccountId: a.id,
          communityId: row.id,
          authorizationStatus: 'ACTIVE',
          isAuthorized: true,
        });
        expect(dest.chatId).toBe(`-100${row.telegramId}`);
        const days =
          (dest.consentExpiresAt!.getTime() - Date.now()) / 86_400_000;
        expect(days).toBeGreaterThan(89);
        expect(days).toBeLessThan(91);
        expect(dest.consentedByName).toMatch(/Advertising review by/);
      });

      it('is refused when the account may not write there, or the chat already belongs to a bot', async () => {
        const a = await full();
        const made = await saved(a.id, name(), { kind: 'SUPERGROUP' });
        made.entry.canWrite = false;
        await h.communities.join(t.manager, made.row.id, {
          accountId: a.id,
          reason: 'Reading only first',
          confirmed: true,
        });
        await allow(made.row.id);
        await expect(
          h.communities.authorize(t.manager, made.row.id, a.id)
        ).rejects.toThrow(/cannot post in this community/);

        made.entry.canWrite = true;
        await activeDestination(h, t.orgId, {
          chatId: `-100${made.row.telegramId}`,
        });
        await expect(
          h.communities.authorize(t.manager, made.row.id, a.id)
        ).rejects.toThrow(/already registered with a bot/);
      });

      it('is taken back by withdrawing, by saying advertising is not allowed, or by leaving: queued posts there pause', async () => {
        const { a, row } = await joined();
        await allow(row.id);
        const { destinationId } = await h.communities.authorize(
          t.manager,
          row.id,
          a.id
        );
        const status = async () =>
          (
            await h.prisma.telegramDestination.findUniqueOrThrow({
              where: { id: destinationId },
            })
          ).authorizationStatus;

        await h.communities.withdraw(
          t.manager,
          row.id,
          'Pausing outreach here'
        );
        expect(await status()).toBe('REVOKED');
        expect((await rows(row.id)).stage).toBe('ADVERTISING_ALLOWED');

        // Authorizing again brings the same chat back, not a second registration.
        const again = await h.communities.authorize(t.manager, row.id, a.id);
        expect(again.destinationId).toBe(destinationId);
        expect(await status()).toBe('ACTIVE');

        await h.communities.leave(t.manager, row.id, a.id);
        expect(await status()).toBe('REVOKED');
        expect(await rows(row.id)).toMatchObject({
          stage: 'REVIEW_REQUIRED',
          operatingAccountId: null,
        });
      });

      it('a later “not allowed” ends posting there at once', async () => {
        const { a, row } = await joined();
        await allow(row.id);
        const { destinationId } = await h.communities.authorize(
          t.manager,
          row.id,
          a.id
        );
        const out = await h.communities.reviewAdvertising(t.manager, row.id, {
          decision: 'NOT_ALLOWED',
          note: 'The admins changed the rules: no more promotion.',
        });
        expect(out.stage).toBe('NOT_ELIGIBLE');
        expect(
          (
            await h.prisma.telegramDestination.findUniqueOrThrow({
              where: { id: destinationId },
            })
          ).authorizationStatus
        ).toBe('REVOKED');
      });

      it('is blocked, with its chat paused, when Telegram shows the community as unusable for the account', async () => {
        const { a, row, username } = await joined();
        await allow(row.id);
        const { destinationId } = await h.communities.authorize(
          t.manager,
          row.id,
          a.id
        );
        h.userGateway.world.delete(username.toLowerCase());
        await h.communities.refresh(t.manager, {
          accountId: a.id,
          ids: [row.id],
        });
        expect(await rows(row.id)).toMatchObject({
          stage: 'BLOCKED',
          available: false,
        });
        expect(
          (
            await h.prisma.telegramDestination.findUniqueOrThrow({
              where: { id: destinationId },
            })
          ).authorizationStatus
        ).toBe('DISCONNECTED');
        await expect(
          h.communities.reopen(t.sales, row.id, 'x')
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(
          (await h.communities.reopen(t.manager, row.id, 'Looked into it'))
            .stage
        ).toBe('REVIEW_REQUIRED');
      });

      it('only moves along the allowed steps', async () => {
        const a = await full();
        const { row } = await saved(a.id);
        await expect(
          h.communities.withdraw(t.manager, row.id, 'x')
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          h.communities.authorize(t.manager, row.id, a.id)
        ).rejects.toBeInstanceOf(ConflictException);
        await expect(
          h.communities.reopen(t.manager, row.id, 'x')
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    describe('communities the agency runs', () => {
      it('creates one, edits it, reads its invite link, and reviews join requests one at a time', async () => {
        const a = await full();
        const made = await h.communities.createCommunity(t.manager, {
          accountId: a.id,
          kind: 'channel',
          title: 'Sunrise Bakery Offers',
          about: 'Weekly deals',
          username: name('sunrise'),
        });
        expect(made.inviteLink).toMatch(/^https:\/\/t\.me\/\+/);
        expect(made.community).toMatchObject({
          relation: 'OWNED',
          stage: 'JOINED',
          kind: 'BROADCAST_CHANNEL',
          operatingAccountId: a.id,
        });

        const edited = await h.communities.updateCommunity(
          t.manager,
          made.community.id,
          { title: 'Sunrise Bakery Deals' }
        );
        expect(edited.title).toBe('Sunrise Bakery Deals');
        expect(
          (await h.communities.inviteLink(t.manager, made.community.id)).link
        ).toMatch(/^https:\/\/t\.me\/\+/);

        const entry = h.userGateway.world.get(
          made.community.username!.toLowerCase()
        )!;
        entry.joinRequests.push(
          {
            userId: '111',
            username: 'asker_one',
            date: new Date().toISOString(),
            bio: null,
          },
          {
            userId: '222',
            username: 'asker_two',
            date: new Date().toISOString(),
            bio: 'Baker',
          }
        );
        const listed = await h.communities.joinRequests(
          t.manager,
          made.community.id
        );
        expect(listed.requests.map((r) => r.userId)).toEqual(['111', '222']);
        await h.communities.decideJoinRequest(t.manager, made.community.id, {
          userId: '111',
          approve: true,
        });
        expect(entry.joinRequests.map((r) => r.userId)).toEqual(['222']);
        await expect(
          h.communities.decideJoinRequest(t.manager, made.community.id, {
            userId: 'all',
            approve: true,
          })
        ).rejects.toThrow(/one request/);
        // Looking at requests is recorded, and what is shown is not stored.
        const audit = await h.prisma.auditEvent.findMany({
          where: {
            orgId: t.orgId,
            action: { startsWith: 'community.join_request' },
          },
        });
        expect(audit.map((x) => x.action).sort()).toEqual([
          'community.join_request_approved',
          'community.join_requests_viewed',
        ]);
        expect(JSON.stringify(await rows(made.community.id))).not.toContain(
          'asker_two'
        );
      });

      it('is only for accounts allowed to manage, and only for communities the agency owns or administers', async () => {
        const limited = await connectAccount(h, t, {
          grants: { canJoin: true },
        });
        await expect(
          h.communities.createCommunity(t.manager, {
            accountId: limited.id,
            kind: 'group',
            title: 'No',
          })
        ).rejects.toThrow(/not allowed to create and manage/);
        const a = await full();
        const { row } = await saved(a.id);
        await expect(
          h.communities.inviteLink(t.manager, row.id)
        ).rejects.toThrow(/owns or administers/);
        await expect(
          h.communities.joinRequests(t.manager, row.id)
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          h.communities.createCommunity(t.sales, {
            accountId: a.id,
            kind: 'group',
            title: 'No',
          })
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          h.communities.createCommunity(t.manager, {
            accountId: a.id,
            kind: 'group',
            title: '',
          })
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('brings in the communities the account already runs, as joined', async () => {
        const a = await full();
        const own = h.userGateway.community(name('owned'));
        const telegramUserId = (
          await h.prisma.telegramUserAccount.findUniqueOrThrow({
            where: { id: a.id },
          })
        ).telegramUserId;
        const [session] = [...h.userGateway.sessions.keys()].filter((s) =>
          s.endsWith(telegramUserId)
        );
        own.admins.add(session);
        const member = h.userGateway.community(name('memberonly'));
        member.members.add(session);
        const out = await h.communities.syncMine(t.manager, a.id);
        expect(out).toEqual({ added: 1, updated: 0 });
        const row = await h.prisma.community.findFirstOrThrow({
          where: { orgId: t.orgId },
        });
        expect(row).toMatchObject({
          relation: 'ADMINISTERED',
          stage: 'JOINED',
          operatingAccountId: a.id,
        });
      });
    });
  }
);
