/**
 * HTTP-level end-to-end checks on the COMPILED backend, loaded by plain Node exactly as
 * in production (node --experimental-require-module): real ApiModule routing,
 * AuthMiddleware (JWT), actor guard, whitelisting validation pipe, controllers,
 * services and PostgreSQL. Only the Temporal client is stubbed: no agency route needs a
 * Temporal server.
 *
 *   pnpm --filter ./apps/backend run build
 *   AGENCYOS_TEST_DATABASE_URL=postgresql://... pnpm --filter ./apps/backend run e2e
 *
 * Skipped unless AGENCYOS_TEST_DATABASE_URL points at a database that has the schema.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.AGENCYOS_TEST_DATABASE_URL;

/** Every key in `subset` must match; extra keys on `actual` are fine. */
const matches = (actual, subset) => {
  for (const [k, v] of Object.entries(subset)) {
    if (v && typeof v === 'object' && !Array.isArray(v))
      matches(actual?.[k], v);
    else
      assert.deepEqual(
        actual?.[k],
        v,
        `${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(
          actual?.[k]
        )}`
      );
  }
};
const rnd = () => Math.random().toString(36).slice(2, 8);

describe(
  'Agency HTTP API (compiled backend + PostgreSQL)',
  { skip: !DB && 'set AGENCYOS_TEST_DATABASE_URL to run' },
  () => {
    let app;
    let base;
    let prisma;
    let signJWT;
    const ctx = {};

    const call = async (method, path, opts = {}) => {
      const who = opts.as ? ctx.users[opts.as] : undefined;
      const res = await fetch(`${base}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          ...(who
            ? { auth: signJWT({ id: who.userId }), showorg: who.orgId }
            : {}),
          ...opts.headers,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, json, text, headers: res.headers };
    };

    before(async () => {
      Object.assign(process.env, {
        DATABASE_URL: DB,
        REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
        JWT_SECRET: 'http-e2e-test-secret-0123456789abcdef',
        FRONTEND_URL: 'http://localhost:5000',
        NOT_SECURED: 'true',
        STORAGE_PROVIDER: 'local',
        UPLOAD_DIRECTORY: process.env.UPLOAD_DIRECTORY || '/tmp',
      });
      for (const k of [
        'AGENCY_TELEGRAM_BOT_TOKEN',
        'TELEGRAM_TOKEN',
        'AGENCY_SCHEDULER_ENABLED',
      ])
        delete process.env[k];

      const dist = (p) => require(resolve(root, 'dist', p));
      const { Global, Module, ValidationPipe } = require('@nestjs/common');
      const { Test } = require('@nestjs/testing');
      const cookieParser = require('cookie-parser');
      const { TemporalService } = require('nestjs-temporal-core');
      const { ThrottlerModule } = require('@nestjs/throttler');
      const { DatabaseModule } = dist(
        'libraries/nestjs-libraries/src/database/prisma/database.module.js'
      );
      const { ApiModule } = dist('apps/backend/src/api/api.module.js');
      const { PrismaService } = dist(
        'libraries/nestjs-libraries/src/database/prisma/prisma.service.js'
      );
      signJWT = (v) =>
        dist('libraries/helpers/src/auth/auth.service.js').AuthService.signJWT(
          v
        );

      // Mirrors the real AppModule's imports, minus the three Temporal modules (which dial a
      // server at startup) that are replaced by a stub TemporalService.
      const { PublicApiModule } = dist(
        'apps/backend/src/public-api/public.api.module.js'
      );
      const { AgentModule } = dist(
        'libraries/nestjs-libraries/src/agent/agent.module.js'
      );
      const { ThirdPartyModule } = dist(
        'libraries/nestjs-libraries/src/3rdparties/thirdparty.module.js'
      );
      const { VideoModule } = dist(
        'libraries/nestjs-libraries/src/videos/video.module.js'
      );
      const { ChatModule } = dist(
        'libraries/nestjs-libraries/src/chat/chat.module.js'
      );
      class TestAppModule {}
      Global()(TestAppModule);
      Module({
        imports: [
          DatabaseModule,
          ApiModule,
          PublicApiModule,
          AgentModule,
          ThirdPartyModule,
          VideoModule,
          ChatModule,
          ThrottlerModule.forRoot({
            throttlers: [{ ttl: 60000, limit: 100000 }],
          }),
        ],
        providers: [
          {
            provide: TemporalService,
            useValue: { client: { getRawClient: () => undefined } },
          },
        ],
        exports: [
          DatabaseModule,
          ApiModule,
          PublicApiModule,
          AgentModule,
          ThrottlerModule,
          ChatModule,
          TemporalService,
        ],
      })(TestAppModule);

      const moduleRef = await Test.createTestingModule({
        imports: [TestAppModule],
      }).compile();
      app = moduleRef.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ transform: true }));
      await app.listen(0, '127.0.0.1');
      base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
      prisma = moduleRef.get(PrismaService);
      ctx.moduleRef = moduleRef;

      const mkOrg = async (label) => {
        const org = await prisma.organization.create({
          data: { name: `${label}-${rnd()}` },
        });
        const customer = await prisma.customer.create({
          data: { orgId: org.id, name: `${label} client` },
        });
        const mkUser = async (name, role, agencyRole, customerId) => {
          const user = await prisma.user.create({
            data: {
              email: `${name}-${rnd()}@test.local`,
              providerName: 'LOCAL',
              name,
              activated: true,
              timezone: 0,
            },
          });
          await prisma.userOrganization.create({
            data: { userId: user.id, organizationId: org.id, role },
          });
          if (agencyRole)
            await prisma.agencyMember.create({
              data: {
                orgId: org.id,
                userId: user.id,
                role: agencyRole,
                customerId: customerId ?? null,
              },
            });
          return { userId: user.id, orgId: org.id };
        };
        return { org, customer, mkUser };
      };
      const a = await mkOrg('A');
      const b = await mkOrg('B');
      ctx.customerId = a.customer.id;
      ctx.users = {
        owner: await a.mkUser('owner', 'SUPERADMIN'),
        manager: await a.mkUser('manager', 'USER', 'CAMPAIGN_MANAGER'),
        sales: await a.mkUser('sales', 'USER'),
        client: await a.mkUser('client', 'USER', 'CLIENT', a.customer.id),
        otherOwner: await b.mkUser('ownerB', 'SUPERADMIN'),
      };
      ctx.destination = await prisma.telegramDestination.create({
        data: {
          orgId: a.org.id,
          chatId: '-1001',
          title: 'Live',
          authorizationStatus: 'ACTIVE',
          isAuthorized: true,
          consentGrantedAt: new Date(),
          consentExpiresAt: new Date(Date.now() + 86400000),
        },
      });
    });

    after(async () => {
      await app?.close(); // open Redis/Prisma handles from Postiz modules are cut off by --test-force-exit
    });

    it('boots with every agency provider resolved (dependency injection is wired)', () => {
      assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
    });

    describe('authentication boundaries', () => {
      it('agency APIs reject anonymous callers', async () => {
        for (const path of [
          '/agency/campaigns',
          '/agency/clients',
          '/agency/dashboard',
          '/agency/team',
          '/agency/me',
          '/agency/telegram/destinations',
          '/agency/portal/me',
          '/agency/reports/publishing',
        ]) {
          assert.equal((await call('GET', path)).status, 403, path);
        }
      });

      it('tracking links resolve for anonymous visitors (they used to hit the auth wall)', async () => {
        const res = await call('GET', '/l/doesnotexist');
        assert.equal(res.status, 404);
        assert.match(res.text, /not found/i);
      });

      it('the Telegram webhook is public, needs its secret, and always answers 200', async () => {
        process.env.AGENCY_TELEGRAM_WEBHOOK_SECRET = 'e2e-secret-value';
        assert.equal(
          (
            await call('POST', '/agency/telegram/webhook', {
              body: { update_id: 1 },
            })
          ).status,
          200
        );
        assert.equal(
          (
            await call('POST', '/agency/telegram/webhook', {
              body: { update_id: 1 },
              headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
            })
          ).status,
          200
        );
        const ok = await call('POST', '/agency/telegram/webhook', {
          body: { garbage: true },
          headers: { 'x-telegram-bot-api-secret-token': 'e2e-secret-value' },
        });
        assert.equal(ok.status, 200);
        assert.deepEqual(ok.json, { ok: true });
        delete process.env.AGENCY_TELEGRAM_WEBHOOK_SECRET;
      });
    });

    describe('workflow over HTTP', () => {
      it("/agency/me reports the caller's role and what it may do", async () => {
        const sales = await call('GET', '/agency/me', { as: 'sales' });
        assert.equal(sales.json.role, 'SALES_EXECUTIVE');
        assert.equal(sales.json.userId, ctx.users.sales.userId);
        assert.ok(sales.json.permissions.includes('campaign:write'));
        assert.ok(!sales.json.permissions.includes('campaign:approve'));
        assert.equal(
          (await call('GET', '/agency/me', { as: 'owner' })).json.role,
          'AGENCY_OWNER'
        );
      });

      it('sales drafts; smuggled fields are ignored; bad links are refused; status cannot be forced', async () => {
        const created = await call('POST', '/agency/campaigns', {
          as: 'sales',
          body: {
            customerId: ctx.customerId,
            name: 'Spring promo',
            contentBody: 'Fresh fruit, delivered.',
            ctaLink: 'https://example.com/spring',
            status: 'APPROVED',
            orgId: 'someone-else',
            approvedContentHash: 'x',
            destinations: [
              {
                destinationType: 'TELEGRAM',
                telegramDestinationId: ctx.destination.id,
              },
            ],
          },
        });
        assert.equal(created.status, 201, created.text);
        assert.equal(created.json.status, 'DRAFT');
        ctx.campaignId = created.json.id;

        const forced = await call(
          'PUT',
          `/agency/campaigns/${ctx.campaignId}`,
          { as: 'sales', body: { status: 'APPROVED', name: 'Spring promo v2' } }
        );
        assert.equal(forced.status, 200);
        assert.equal(forced.json.status, 'DRAFT');
        assert.equal(forced.json.name, 'Spring promo v2');

        for (const bad of [
          'javascript:alert(1)',
          'data:text/html,x',
          'not a url',
        ]) {
          assert.equal(
            (
              await call('PUT', `/agency/campaigns/${ctx.campaignId}`, {
                as: 'sales',
                body: { ctaLink: bad },
              })
            ).status,
            400,
            bad
          );
        }
      });

      it('sales cannot approve or publish; the manager can; nothing publishes without approval', async () => {
        const submit = await call(
          'POST',
          `/agency/campaigns/${ctx.campaignId}/submit`,
          { as: 'sales', body: { notes: 'ready' } }
        );
        assert.equal(submit.status, 201, submit.text);
        ctx.approvalId = submit.json.id;

        assert.equal(
          (
            await call('POST', `/agency/approvals/${ctx.approvalId}/review`, {
              as: 'sales',
              body: { decision: 'APPROVE' },
            })
          ).status,
          403
        );
        assert.equal(
          (
            await call('POST', `/agency/campaigns/${ctx.campaignId}/publish`, {
              as: 'sales',
            })
          ).status,
          403
        );
        assert.equal(
          (
            await call('POST', `/agency/campaigns/${ctx.campaignId}/publish`, {
              as: 'manager',
            })
          ).status,
          400
        ); // not approved yet
        assert.equal(
          (
            await call('POST', `/agency/approvals/${ctx.approvalId}/review`, {
              as: 'manager',
              body: { decision: 'MAYBE' },
            })
          ).status,
          400
        );

        const approved = await call(
          'POST',
          `/agency/approvals/${ctx.approvalId}/review`,
          { as: 'manager', body: { decision: 'APPROVE', notes: 'good' } }
        );
        assert.equal(approved.status, 201, approved.text);
        assert.equal(approved.json.status, 'APPROVED');
        const detail = await call(
          'GET',
          `/agency/campaigns/${ctx.campaignId}`,
          { as: 'manager' }
        );
        assert.equal(detail.json.status, 'APPROVED');
        assert.match(detail.json.approvedContentHash, /^[0-9a-f]{64}$/);
        assert.equal(
          (
            await call('PUT', `/agency/campaigns/${ctx.campaignId}`, {
              as: 'sales',
              body: { contentBody: 'sneaky edit' },
            })
          ).status,
          400
        );
      });

      it('scheduling needs a start date; approved content is frozen until reopened; then it queues exactly one job', async () => {
        const noDate = await call(
          'POST',
          `/agency/campaigns/${ctx.campaignId}/schedule`,
          { as: 'manager' }
        );
        assert.equal(noDate.status, 400);
        assert.match(noDate.json.message, /start date/i);
        assert.equal(
          (
            await call('PUT', `/agency/campaigns/${ctx.campaignId}`, {
              as: 'manager',
              body: {
                startDate: new Date(Date.now() + 3600_000).toISOString(),
              },
            })
          ).status,
          400
        );

        assert.equal(
          (
            await call('POST', `/agency/campaigns/${ctx.campaignId}/reopen`, {
              as: 'manager',
            })
          ).status,
          201
        );
        assert.equal(
          (
            await call('PUT', `/agency/campaigns/${ctx.campaignId}`, {
              as: 'sales',
              body: {
                startDate: new Date(Date.now() + 3600_000).toISOString(),
              },
            })
          ).status,
          200
        );
        const again = await call(
          'POST',
          `/agency/campaigns/${ctx.campaignId}/submit`,
          { as: 'sales' }
        );
        await call('POST', `/agency/approvals/${again.json.id}/review`, {
          as: 'manager',
          body: { decision: 'APPROVE' },
        });
        const ok = await call(
          'POST',
          `/agency/campaigns/${ctx.campaignId}/schedule`,
          { as: 'manager' }
        );
        assert.equal(ok.status, 201, ok.text);
        assert.equal(ok.json.status, 'SCHEDULED');
        const jobs = await call(
          'GET',
          `/agency/campaigns/${ctx.campaignId}/jobs`,
          { as: 'manager' }
        );
        assert.equal(jobs.json.length, 1);
        matches(jobs.json[0], { status: 'PENDING', attempts: 0 });
        assert.doesNotMatch(
          JSON.stringify(jobs.json),
          /verificationCodeHash|token/i
        );
      });
    });

    describe('tenant and client isolation over HTTP', () => {
      it('another agency gets 404 for our campaign and sees none of our data', async () => {
        assert.equal(
          (
            await call('GET', `/agency/campaigns/${ctx.campaignId}`, {
              as: 'otherOwner',
            })
          ).status,
          404
        );
        assert.equal(
          (
            await call('POST', `/agency/campaigns/${ctx.campaignId}/cancel`, {
              as: 'otherOwner',
              body: {},
            })
          ).status,
          404
        );
        assert.deepEqual(
          (await call('GET', '/agency/campaigns', { as: 'otherOwner' })).json,
          []
        );
        assert.ok(
          !(await call('GET', '/agency/clients', { as: 'otherOwner' })).json
            .map((c) => c.id)
            .includes(ctx.customerId)
        );
        assert.deepEqual(
          (
            await call('GET', '/agency/telegram/destinations', {
              as: 'otherOwner',
            })
          ).json,
          []
        );
        const cross = await call('POST', '/agency/campaigns', {
          as: 'otherOwner',
          body: { customerId: ctx.customerId, name: 'x', contentBody: 'y' },
        });
        assert.equal(cross.status, 404);
      });

      it('a client user is blocked from internal APIs but sees their own portal, and nothing internal', async () => {
        assert.equal(
          (await call('GET', '/agency/campaigns', { as: 'client' })).status,
          403
        );
        assert.equal(
          (await call('GET', '/agency/dashboard', { as: 'client' })).status,
          403
        );
        const portal = await call('GET', '/agency/portal/me', { as: 'client' });
        assert.equal(portal.status, 200);
        assert.deepEqual(portal.json.viewer, {
          isClient: true,
          canReview: true,
        });
        assert.deepEqual(
          portal.json.campaigns.map((c) => c.name),
          ['Spring promo v2']
        );
        assert.doesNotMatch(
          portal.text,
          /internalNotes|approvedContentHash|createdBy/
        );
      });

      it('role changes are admin-only and take effect immediately', async () => {
        const salesId = ctx.users.sales.userId;
        assert.equal(
          (
            await call('PUT', `/agency/team/${salesId}/role`, {
              as: 'manager',
              body: { role: 'SALES_MANAGER' },
            })
          ).status,
          403
        );
        assert.equal(
          (
            await call('PUT', `/agency/team/${salesId}/role`, {
              as: 'owner',
              body: { role: 'NOT_A_ROLE' },
            })
          ).status,
          400
        );
        assert.equal(
          (
            await call('PUT', `/agency/team/${salesId}/role`, {
              as: 'owner',
              body: { role: 'SALES_MANAGER' },
            })
          ).status,
          200
        );
        assert.equal(
          (await call('GET', '/agency/me', { as: 'sales' })).json.role,
          'SALES_MANAGER'
        );
        const audit = await call('GET', '/agency/audit?entityType=User', {
          as: 'owner',
        });
        assert.ok(audit.json.some((e) => e.action === 'team.role_changed'));
        assert.equal(
          (await call('GET', '/agency/audit', { as: 'manager' })).status,
          403
        );
      });
    });

    describe('Telegram without a bot connected', () => {
      it('says so plainly instead of pretending', async () => {
        const verify = await call('POST', '/agency/telegram/verify', {
          as: 'manager',
          body: { chatId: '-100999' },
        });
        matches(verify.json, { valid: false });
        assert.match(verify.json.error, /Telegram bots/);
      });

      it('refuses to register a chat nobody could authorize, and still validates and guards the request', async () => {
        const reg = await call('POST', '/agency/telegram/destinations', {
          as: 'manager',
          body: { chatId: '-100123456789', title: 'Fruit chat' },
        });
        assert.equal(reg.status, 400, reg.text);
        assert.match(reg.json.message, /Connect a Telegram bot first/);
        assert.equal(
          (
            await call('POST', '/agency/telegram/destinations', {
              as: 'manager',
              body: { chatId: 'bad ref' },
            })
          ).status,
          400
        );
        // sales was promoted to SALES_MANAGER above; that role still can't manage destinations
        assert.equal(
          (
            await call('POST', '/agency/telegram/destinations', {
              as: 'sales',
              body: { chatId: '-100123456000' },
            })
          ).status,
          403
        );
      });
    });

    describe('Telegram bots', () => {
      it('lists none at first, refuses a malformed token, and keeps connecting to owners and admins', async () => {
        const none = await call('GET', '/agency/telegram/bots', {
          as: 'manager',
        });
        assert.equal(none.status, 200, none.text);
        assert.deepEqual(none.json.bots, []);
        assert.equal(none.json.server.configured, false);
        assert.equal(
          (await call('GET', '/agency/telegram/bots', { as: 'client' })).status,
          403
        );
        assert.equal(
          (
            await call('POST', '/agency/telegram/bots', {
              as: 'owner',
              body: { label: 'Acme', token: 'not-a-token' },
            })
          ).status,
          400
        );
        assert.equal(
          (
            await call('POST', '/agency/telegram/bots', {
              as: 'manager',
              body: { label: 'Acme', token: '123456789:' + 'A'.repeat(35) },
            })
          ).status,
          403
        );
      });

      it('connect, register a chat with it, pause, and remove: the token is never returned and removal stops the chat', async () => {
        // Telegram itself is not reachable from a test: answer for it.
        const { TelegramGateway } = require(resolve(
          root,
          'dist/libraries/nestjs-libraries/src/integrations/telegram/telegram.gateway.js'
        ));
        const saved = {
          getBotInfo: TelegramGateway.prototype.getBotInfo,
          getChat: TelegramGateway.prototype.getChat,
        };
        TelegramGateway.prototype.getBotInfo = async function () {
          return { id: 424242, username: 'acme_ads_bot' };
        };
        TelegramGateway.prototype.getChat = async function () {
          throw new Error('offline'); // the chat is registered anyway; the bot just cannot see it yet
        };
        try {
          const tok = '424242:' + 'B'.repeat(35);
          const added = await call('POST', '/agency/telegram/bots', {
            as: 'owner',
            body: { label: 'Acme Ads', token: tok },
          });
          assert.equal(added.status, 201, added.text);
          matches(added.json, {
            label: 'Acme Ads',
            username: 'acme_ads_bot',
            status: 'ACTIVE',
          });
          const dupe = await call('POST', '/agency/telegram/bots', {
            as: 'owner',
            body: { label: 'Again', token: tok },
          });
          assert.equal(dupe.status, 409, dupe.text);

          const listed = await call('GET', '/agency/telegram/bots', {
            as: 'manager',
          });
          assert.equal(listed.json.bots.length, 1);
          assert.ok(!listed.text.includes(tok) && !added.text.includes(tok));
          assert.ok(!listed.text.includes('tokenSealed'));

          const reg = await call('POST', '/agency/telegram/destinations', {
            as: 'manager',
            body: {
              chatId: '-100123456789',
              title: 'Fruit chat',
              isAuthorized: true,
            },
          });
          assert.equal(reg.status, 201, reg.text);
          matches(reg.json.destination, {
            authorizationStatus: 'PENDING_VERIFICATION',
            isAuthorized: false,
            botId: added.json.id,
            botUsername: 'acme_ads_bot',
          });
          assert.match(reg.json.verificationCode, /^AOS-[A-Z0-9]{8}$/);
          assert.match(reg.json.steps[0], /@acme_ads_bot/);
          assert.ok(!reg.text.includes('verificationCodeHash'));

          // Backup bots: the request is validated and guarded before Telegram is ever asked.
          const dest = reg.json.destination.id;
          const badStrategy = await call(
            'PUT',
            `/agency/telegram/destinations/${dest}/bots`,
            {
              as: 'manager',
              body: { backupBotIds: [], strategy: 'WHENEVER' },
            }
          );
          assert.equal(badStrategy.status, 400, badStrategy.text);
          assert.equal(
            (
              await call('PUT', `/agency/telegram/destinations/${dest}/bots`, {
                as: 'client',
                body: { backupBotIds: [], strategy: 'FAILOVER' },
              })
            ).status,
            403
          );
          assert.equal(
            (
              await call(
                'PUT',
                `/agency/telegram/destinations/does-not-exist/bots`,
                {
                  as: 'manager',
                  body: { backupBotIds: [], strategy: 'FAILOVER' },
                }
              )
            ).status,
            404
          );
          assert.equal(
            (
              await call(
                'POST',
                `/agency/telegram/destinations/${dest}/main-bot`,
                { as: 'manager', body: { botId: 'nope' } }
              )
            ).status,
            400
          );

          const paused = await call(
            'PUT',
            `/agency/telegram/bots/${added.json.id}`,
            {
              as: 'owner',
              body: { enabled: false },
            }
          );
          assert.equal(paused.json.status, 'DISABLED', paused.text);
          assert.equal(
            (
              await call('DELETE', `/agency/telegram/bots/${added.json.id}`, {
                as: 'manager',
              })
            ).status,
            403
          );
          const removed = await call(
            'DELETE',
            `/agency/telegram/bots/${added.json.id}`,
            { as: 'owner' }
          );
          assert.equal(removed.status, 200, removed.text);
          matches(removed.json, { removed: true, chatsStopped: 1 });
          const after = await call('GET', '/agency/telegram/destinations', {
            as: 'manager',
          });
          const mine = after.json.find((d) => d.id === reg.json.destination.id);
          assert.equal(mine.authorizationStatus, 'DISCONNECTED');
          assert.equal(
            (await call('GET', '/agency/telegram/bots', { as: 'manager' })).json
              .bots.length,
            0
          );
        } finally {
          Object.assign(TelegramGateway.prototype, saved);
        }
      });
    });

    describe('ad templates over HTTP', () => {
      it('saves, lists, edits and deletes content-only templates, and keeps them per workspace', async () => {
        const body = {
          name: 'Weekly offer',
          contentTitle: 'Fresh every Friday',
          contentBody: 'Order by Thursday and get free delivery.',
          ctaLink: 'https://bakery.test/offer',
          ctaText: 'Order',
        };
        const made = await call('POST', '/agency/templates', {
          as: 'manager',
          body,
        });
        assert.equal(made.status, 201, made.text);
        matches(made.json, {
          name: 'Weekly offer',
          orgId: ctx.users.manager.orgId,
        });

        // The same name is refused; so are bad input and fields that must not be settable.
        assert.equal(
          (await call('POST', '/agency/templates', { as: 'manager', body }))
            .status,
          400
        );
        for (const bad of [
          { name: 'X' },
          { name: 'X', contentBody: 'y', ctaLink: 'ftp://x' },
        ]) {
          assert.equal(
            (
              await call('POST', '/agency/templates', {
                as: 'manager',
                body: bad,
              })
            ).status,
            400
          );
        }

        const list = await call('GET', '/agency/templates', { as: 'manager' });
        assert.equal(list.status, 200);
        assert.deepEqual(
          list.json.map((t) => t.name),
          ['Weekly offer']
        );

        const edited = await call('PUT', `/agency/templates/${made.json.id}`, {
          as: 'manager',
          body: { name: 'Friday offer' },
        });
        assert.equal(edited.status, 200, edited.text);
        assert.equal(edited.json.name, 'Friday offer');

        // Another workspace sees none of it and cannot touch it.
        const theirs = await call('GET', '/agency/templates', {
          as: 'otherOwner',
        });
        assert.deepEqual(theirs.json, []);
        assert.equal(
          (
            await call('DELETE', `/agency/templates/${made.json.id}`, {
              as: 'otherOwner',
            })
          ).status,
          404
        );
        // A client account is shut out of staff APIs.
        assert.equal(
          (await call('GET', '/agency/templates', { as: 'client' })).status,
          403
        );

        const gone = await call('DELETE', `/agency/templates/${made.json.id}`, {
          as: 'manager',
        });
        assert.equal(gone.status, 200, gone.text);
        assert.deepEqual(
          (await call('GET', '/agency/templates', { as: 'manager' })).json,
          []
        );
      });
    });

    describe('ad versions and schedules over HTTP', () => {
      const campaign = (extra) => ({
        customerId: ctx.customerId,
        name: `Versions ${rnd()}`,
        contentBody: 'Fresh fruit, delivered.',
        destinations: [
          {
            destinationType: 'TELEGRAM',
            telegramDestinationId: ctx.destination.id,
          },
        ],
        ...extra,
      });

      it('saves versions B to D and a schedule, labels them, and refuses what cannot be sent', async () => {
        const made = await call('POST', '/agency/campaigns', {
          as: 'sales',
          body: campaign({
            scheduleKind: 'REPEAT',
            intervalMinutes: 120,
            occurrences: 4,
            variants: [
              { contentBody: 'Version B words' },
              { contentBody: 'Version C words', ctaLink: 'https://x.test/c' },
            ],
          }),
        });
        assert.equal(made.status, 201, made.text);
        matches(made.json, {
          scheduleKind: 'REPEAT',
          intervalMinutes: 120,
          occurrences: 4,
        });
        assert.deepEqual(
          made.json.variants.map((v) => v.label),
          ['B', 'C']
        );

        const read = await call('GET', `/agency/campaigns/${made.json.id}`, {
          as: 'sales',
        });
        assert.deepEqual(
          read.json.variants.map((v) => v.contentBody),
          ['Version B words', 'Version C words']
        );

        for (const bad of [
          { scheduleKind: 'WEEKLY' },
          { scheduleKind: 'REPEAT', intervalMinutes: 30, occurrences: 3 },
          { scheduleKind: 'REPEAT', intervalMinutes: 60, occurrences: 1 },
          { scheduleKind: 'DRIP' },
          { variants: [{ contentBody: '' }] },
          { variants: [{ contentBody: 'x', ctaLink: 'javascript:alert(1)' }] },
          {
            variants: [1, 2, 3, 4].map((n) => ({
              contentBody: `Version ${n}`,
            })),
          },
        ]) {
          const res = await call('POST', '/agency/campaigns', {
            as: 'sales',
            body: campaign(bad),
          });
          assert.equal(res.status, 400, JSON.stringify(bad) + res.text);
        }

        // Changing back to "once" clears the gap and count; an edit that sends no versions keeps them.
        const back = await call('PUT', `/agency/campaigns/${made.json.id}`, {
          as: 'sales',
          body: { scheduleKind: 'ONCE' },
        });
        assert.equal(back.status, 200, back.text);
        matches(back.json, {
          scheduleKind: 'ONCE',
          intervalMinutes: null,
          occurrences: null,
        });
        assert.equal(back.json.variants.length, 2);
        const cleared = await call('PUT', `/agency/campaigns/${made.json.id}`, {
          as: 'sales',
          body: { variants: [] },
        });
        assert.equal(cleared.json.variants.length, 0);

        // The report carries the per-version block (empty when nothing has been compared).
        const report = await call('GET', '/agency/reports/publishing', {
          as: 'manager',
        });
        assert.equal(report.status, 200, report.text);
        assert.ok(Array.isArray(report.json.variants));
      });
    });

    describe('Telegram user accounts and communities over HTTP', () => {
      it('signs an account in through a real worker connection, keeps secrets in, and walks research and joining under the role rules', async () => {
        // A tiny worker that speaks docs/TELEGRAM_WORKER_CONTRACT.md over loopback.
        const { createServer } = require('node:http');
        const community = {
          telegramId: '4242',
          kind: 'SUPERGROUP',
          title: 'Bakers United',
          username: 'bakers_united',
          link: 'https://t.me/bakers_united',
          description: 'For people who bake',
          memberCount: null,
          verified: false,
          scam: false,
          fake: false,
          joinRequestRequired: false,
          slowModeSeconds: null,
          hasLinkedChat: false,
          restrictionReasons: [],
        };
        const seen = [];
        const worker = createServer((req, res) => {
          let raw = '';
          req.on('data', (c) => (raw += c));
          req.on('end', () => {
            const body = raw ? JSON.parse(raw) : {};
            seen.push({
              path: req.url,
              token: req.headers['x-agencyos-worker-token'],
              body,
            });
            const send = (payload) => {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, ...payload }));
            };
            if (req.url === '/health') return send({ version: 'e2e' });
            if (req.headers['x-agencyos-worker-token'] !== 'e2e-worker-token') {
              res.statusCode = 401;
              return res.end('{}');
            }
            switch (req.url) {
              case '/v1/login/start':
                return send({
                  loginId: 'login-e2e',
                  codeDelivery: 'app',
                  timeoutSeconds: 600,
                });
              case '/v1/login/code':
                return send({
                  status: 'authorized',
                  session: 'SECRET-SESSION-E2E',
                  me: {
                    id: '777',
                    username: 'e2e_person',
                    firstName: 'Eve',
                    lastName: null,
                    premium: false,
                    phoneMasked: '+49•••••6789',
                  },
                });
              case '/v1/account/status':
                return send({
                  authorized: true,
                  me: {
                    id: '777',
                    username: 'e2e_person',
                    firstName: 'Eve',
                    lastName: null,
                    premium: false,
                    phoneMasked: '+49•••••6789',
                  },
                });
              case '/v1/communities/search':
                return send({ results: [community] });
              case '/v1/communities/refresh':
                return send({
                  results: body.refs.map((ref) => ({
                    ref,
                    ok: true,
                    community,
                    relation: 'PUBLIC_NOT_JOINED',
                  })),
                });
              case '/v1/communities/join':
                return send({ status: 'JOINED', community });
              default:
                res.statusCode = 200;
                return res.end(
                  JSON.stringify({
                    ok: false,
                    error: { code: 'UNSUPPORTED', message: req.url },
                  })
                );
            }
          });
        });
        await new Promise((r) => worker.listen(0, '127.0.0.1', r));
        process.env.AGENCYOS_TELEGRAM_WORKER_URL = `http://127.0.0.1:${
          worker.address().port
        }`;
        process.env.AGENCYOS_TELEGRAM_WORKER_TOKEN = 'e2e-worker-token';
        try {
          const status = await call('GET', '/agency/telegram/accounts/status', {
            as: 'manager',
          });
          matches(status.json, {
            configured: true,
            running: true,
            version: 'e2e',
          });

          // Only owners and admins connect accounts; the form is validated before the worker is asked.
          const start = {
            apiId: 123456,
            apiHash: 'ab'.repeat(16),
            phone: '+4915112346789',
            label: 'Eve',
          };
          assert.equal(
            (
              await call('POST', '/agency/telegram/accounts/login/start', {
                as: 'manager',
                body: start,
              })
            ).status,
            403
          );
          for (const bad of [
            { ...start, apiHash: 'short' },
            { ...start, apiId: 'x' },
            { ...start, phone: '12' },
          ]) {
            const res = await call(
              'POST',
              '/agency/telegram/accounts/login/start',
              { as: 'owner', body: bad }
            );
            assert.equal(res.status, 400, JSON.stringify(bad) + res.text);
          }
          assert.equal(
            seen.filter((x) => x.path.startsWith('/v1/login')).length,
            0
          );

          const started = await call(
            'POST',
            '/agency/telegram/accounts/login/start',
            { as: 'owner', body: start }
          );
          assert.equal(started.status, 201, started.text);
          const connected = await call(
            'POST',
            '/agency/telegram/accounts/login/code',
            {
              as: 'owner',
              body: { loginId: started.json.loginId, code: '12345' },
            }
          );
          assert.equal(connected.status, 201, connected.text);
          assert.equal(connected.json.status, 'connected');
          const accountId = connected.json.account.id;
          assert.ok(
            seen.every(
              (x) => x.token === 'e2e-worker-token' || x.path === '/health'
            )
          );

          // The session and the api hash never come back, in any response.
          const listed = await call('GET', '/agency/telegram/accounts', {
            as: 'manager',
          });
          assert.equal(listed.status, 200);
          for (const text of [connected.text, listed.text, started.text]) {
            assert.ok(!text.includes('SECRET-SESSION-E2E'), 'session leaked');
            assert.ok(!text.includes('ab'.repeat(16)), 'api hash leaked');
            assert.ok(!text.includes('4915112346789'), 'phone leaked');
            assert.ok(!text.includes('sealed'), 'sealed value leaked');
          }
          assert.equal(
            (await call('GET', '/agency/telegram/accounts', { as: 'client' }))
              .status,
            403
          );

          // Permissions: owner grants joining; a manager cannot.
          assert.equal(
            (
              await call('PUT', `/agency/telegram/accounts/${accountId}`, {
                as: 'manager',
                body: { canJoin: true },
              })
            ).status,
            403
          );
          const granted = await call(
            'PUT',
            `/agency/telegram/accounts/${accountId}`,
            { as: 'owner', body: { canJoin: true, canPublish: 'yes' } }
          );
          assert.equal(granted.status, 400); // booleans only
          const ok = await call(
            'PUT',
            `/agency/telegram/accounts/${accountId}`,
            { as: 'owner', body: { canJoin: true } }
          );
          assert.equal(ok.status, 200, ok.text);
          assert.equal(ok.json.permissions.canJoin, true);

          // Research: search, import, list, label, export.
          const search = await call('POST', '/agency/communities/search', {
            as: 'manager',
            body: { accountId, query: 'bakers' },
          });
          assert.equal(search.status, 201, search.text);
          assert.equal(search.json.results[0].username, 'bakers_united');
          assert.equal(search.json.results[0].saved, null);
          const imported = await call('POST', '/agency/communities/import', {
            as: 'manager',
            body: {
              accountId,
              refs: ['@bakers_united', 'https://t.me/bakers_united', 'x!'],
              tags: ['Food'],
            },
          });
          assert.equal(imported.status, 201, imported.text);
          assert.equal(imported.json.created, 1);
          assert.deepEqual(imported.json.failed.map((f) => f.code).sort(), [
            'DUPLICATE',
            'INVALID_REF',
          ]);
          assert.equal(
            (
              await call('POST', '/agency/communities/import', {
                as: 'manager',
                body: { accountId, refs: Array(51).fill('@bakers_united') },
              })
            ).status,
            400
          );

          const dir = await call(
            'GET',
            '/agency/communities?tag=food&sort=members',
            { as: 'sales' }
          );
          assert.equal(dir.status, 200);
          assert.equal(dir.json.length, 1);
          assert.equal(dir.json[0].memberCount, null); // nothing Telegram did not say
          const id = dir.json[0].id;
          const csv = await call('GET', '/agency/communities/export', {
            as: 'sales',
          });
          assert.match(csv.text, /^title,username,link/);
          assert.match(
            csv.text,
            /Bakers United,bakers_united,https:\/\/t\.me\/bakers_united/
          );
          const json = await call(
            'GET',
            '/agency/communities/export?format=json',
            { as: 'sales' }
          );
          assert.equal(JSON.parse(json.text)[0].username, 'bakers_united');
          assert.equal(
            (await call('GET', '/agency/communities', { as: 'client' })).status,
            403
          );
          assert.deepEqual(
            (await call('GET', '/agency/communities', { as: 'otherOwner' }))
              .json,
            []
          );
          assert.equal(
            (
              await call('GET', `/agency/communities/${id}`, {
                as: 'otherOwner',
              })
            ).status,
            404
          );

          // Joining is a deliberate act: confirmation and a reason, for the roles that may.
          assert.equal(
            (
              await call('POST', `/agency/communities/${id}/join`, {
                as: 'sales',
                body: { accountId, reason: 'Good fit', confirmed: true },
              })
            ).status,
            403
          );
          assert.equal(
            (
              await call('POST', `/agency/communities/${id}/join`, {
                as: 'manager',
                body: { accountId, reason: 'Good fit', confirmed: false },
              })
            ).status,
            400
          );
          const joined = await call('POST', `/agency/communities/${id}/join`, {
            as: 'manager',
            body: {
              accountId,
              reason: 'Bakers hang out here',
              confirmed: true,
            },
          });
          assert.equal(joined.status, 201, joined.text);
          assert.equal(joined.json.stage, 'JOINED');

          // Nothing about people was ever requested from the worker.
          for (const x of seen)
            assert.ok(
              !/participant|member|add|phone|contact/i.test(x.path),
              x.path
            );

          // Signing out ends the login and wipes it.
          const out = await call(
            'POST',
            `/agency/telegram/accounts/${accountId}/logout`,
            { as: 'owner' }
          );
          assert.equal(out.status, 201, out.text);
          assert.equal(out.json.account.status, 'LOGGED_OUT');
        } finally {
          delete process.env.AGENCYOS_TELEGRAM_WORKER_URL;
          delete process.env.AGENCYOS_TELEGRAM_WORKER_TOKEN;
          await new Promise((r) => worker.close(r));
        }
      });
    });

    describe('lead links over HTTP', () => {
      it('collects only people who tap Start, exports them, and lets them leave', async () => {
        const { TelegramGateway } = require(resolve(
          root,
          'dist/libraries/nestjs-libraries/src/integrations/telegram/telegram.gateway.js'
        ));
        const { AgencyTelegramService } = require(resolve(
          root,
          'dist/libraries/nestjs-libraries/src/database/prisma/agency/agency.telegram.service.js'
        ));
        const { AgencyTelegramBotsService } = require(resolve(
          root,
          'dist/libraries/nestjs-libraries/src/database/prisma/agency/agency.telegram.bots.service.js'
        ));
        const saved = {
          getBotInfo: TelegramGateway.prototype.getBotInfo,
          sendNotice: TelegramGateway.prototype.sendNotice,
        };
        const notices = [];
        TelegramGateway.prototype.getBotInfo = async function () {
          return { id: 515151, username: 'lead_bot' };
        };
        TelegramGateway.prototype.sendNotice = async function (chatId, text) {
          notices.push({ chatId, text });
        };
        let botId;
        try {
          // Staff who work leads, and nobody else.
          assert.equal(
            (await call('GET', '/agency/leads', { as: 'client' })).status,
            403
          );
          assert.equal(
            (await call('GET', '/agency/leads/links', { as: 'manager' }))
              .status,
            403
          );
          assert.equal(
            (
              await call('POST', '/agency/leads/links', {
                as: 'manager',
                body: { label: 'x' },
              })
            ).status,
            403
          );
          assert.deepEqual(
            (await call('GET', '/agency/leads/links', { as: 'owner' })).json,
            []
          );

          const added = await call('POST', '/agency/telegram/bots', {
            as: 'owner',
            body: { label: 'Lead bot', token: '515151:' + 'C'.repeat(35) },
          });
          assert.equal(added.status, 201, added.text);
          botId = added.json.id;

          assert.equal(
            (
              await call('POST', '/agency/leads/links', {
                as: 'owner',
                body: {},
              })
            ).status,
            400
          );
          const link = await call('POST', '/agency/leads/links', {
            as: 'owner',
            body: { label: 'Spring offer', botId, welcomeMessage: 'Hello!' },
          });
          assert.equal(link.status, 201, link.text);
          assert.equal(
            link.json.url,
            `https://t.me/lead_bot?start=${link.json.code}`
          );

          // Telegram tells the bot that someone tapped Start.
          const telegram = ctx.moduleRef.get(AgencyTelegramService, {
            strict: false,
          });
          const bots = ctx.moduleRef.get(AgencyTelegramBotsService, {
            strict: false,
          });
          const handle = await bots.handleFor(ctx.users.owner.orgId, botId);
          const hear = (text, user = 9001) =>
            telegram.handleUpdate(
              {
                update_id: Math.floor(Math.random() * 1e9),
                message: {
                  message_id: 1,
                  date: 0,
                  chat: { id: user, type: 'private' },
                  from: {
                    id: user,
                    is_bot: false,
                    first_name: 'Sam',
                    username: 'sam_k',
                  },
                  text,
                },
              },
              handle
            );
          await hear(`/start ${link.json.code}`);
          assert.match(notices.at(-1).text, /Hello!/);
          assert.match(notices.at(-1).text, /\/stop/);

          const list = await call('GET', '/agency/leads', { as: 'owner' });
          assert.equal(list.status, 200, list.text);
          matches(list.json[0], {
            name: 'Sam',
            telegramHandle: '@sam_k',
            status: 'NEW',
          });
          assert.equal(list.json.length, 1);
          assert.deepEqual(
            (await call('GET', '/agency/leads', { as: 'otherOwner' })).json,
            []
          );

          const csv = await call('GET', '/agency/leads/export?format=csv', {
            as: 'owner',
          });
          assert.equal(csv.status, 200);
          assert.match(csv.headers.get('content-type'), /text\/csv/);
          assert.match(csv.text, /"Sam","sam_k","Spring offer"/);
          const json = await call('GET', '/agency/leads/export?format=json', {
            as: 'owner',
          });
          assert.match(json.headers.get('content-type'), /application\/json/);
          assert.equal(json.json[0]['Telegram username'], 'sam_k');
          assert.equal(
            (await call('GET', '/agency/leads/export', { as: 'client' }))
              .status,
            403
          );

          const updated = await call(
            'PUT',
            `/agency/leads/${list.json[0].id}`,
            {
              as: 'owner',
              body: { status: 'QUALIFIED', notes: 'call Monday' },
            }
          );
          assert.equal(updated.status, 200, updated.text);
          matches(updated.json, { status: 'QUALIFIED', notes: 'call Monday' });
          assert.equal(
            (
              await call('PUT', `/agency/leads/${list.json[0].id}`, {
                as: 'owner',
                body: { status: 'OPTED_OUT' },
              })
            ).status,
            400
          );

          await hear('/stop');
          assert.deepEqual(
            (await call('GET', '/agency/leads', { as: 'owner' })).json,
            []
          );
          assert.match(notices.at(-1).text, /deleted your details/);
          const links = await call('GET', '/agency/leads/links', {
            as: 'owner',
          });
          matches(links.json[0], { people: 0, stopped: 1 });
          assert.equal(
            (
              await call('DELETE', `/agency/leads/links/${link.json.id}`, {
                as: 'owner',
              })
            ).status,
            200
          );
        } finally {
          if (botId)
            await call('DELETE', `/agency/telegram/bots/${botId}`, {
              as: 'owner',
            });
          Object.assign(TelegramGateway.prototype, saved);
        }
      });
    });

    describe('WhatsApp workspace over HTTP', () => {
      const wa = (path = '') => `/agency/whatsapp${path}`;
      const person = (over = {}) => ({
        name: 'Ana Costa',
        phone: '+49 151 1234 5678',
        consentSource: 'Web form',
        consentedAt: '2026-03-14',
        ...over,
      });

      it('keeps numbers masked, consent mandatory, and every step in the staff roles', async () => {
        // an analyst reads; a client and an anonymous caller get nothing
        const analystUser = await prisma.user.create({
          data: {
            email: `analyst-${rnd()}@test.local`,
            providerName: 'LOCAL',
            name: 'analyst',
            activated: true,
            timezone: 0,
          },
        });
        await prisma.userOrganization.create({
          data: {
            userId: analystUser.id,
            organizationId: ctx.users.owner.orgId,
            role: 'USER',
          },
        });
        await prisma.agencyMember.create({
          data: {
            orgId: ctx.users.owner.orgId,
            userId: analystUser.id,
            role: 'ANALYST',
          },
        });
        ctx.users.analyst = {
          userId: analystUser.id,
          orgId: ctx.users.owner.orgId,
        };
        assert.equal((await call('GET', wa('/contacts'))).status, 403);
        for (const path of ['/contacts', '/segments', '/tasks', '/settings']) {
          assert.equal(
            (await call('GET', wa(path), { as: 'client' })).status,
            403,
            path
          );
          assert.equal(
            (await call('GET', wa(path), { as: 'analyst' })).status,
            200,
            path
          );
        }
        assert.equal(
          (
            await call('POST', wa('/contacts'), {
              as: 'analyst',
              body: person(),
            })
          ).status,
          403
        );

        // consent is not optional
        for (const missing of ['consentSource', 'consentedAt', 'phone']) {
          const refused = await call('POST', wa('/contacts'), {
            as: 'sales',
            body: person({ [missing]: undefined }),
          });
          assert.equal(refused.status, 400, missing);
        }
        const smuggled = await call('POST', wa('/contacts'), {
          as: 'sales',
          body: person({
            phone: '+49 151 1234 0000',
            orgId: ctx.users.otherOwner.orgId,
            consentStatus: 'OPTED_OUT',
          }),
        });
        assert.equal(smuggled.status, 201, smuggled.text);
        matches(smuggled.json, {
          consentStatus: 'OPTED_IN',
          phone: '+4915112340000',
        });
        assert.equal(
          (
            await prisma.whatsappContact.findUniqueOrThrow({
              where: { id: smuggled.json.id },
            })
          ).orgId,
          ctx.users.sales.orgId
        );

        const created = await call('POST', wa('/contacts'), {
          as: 'sales',
          body: person({ tags: ['VIP'] }),
        });
        assert.equal(created.status, 201, created.text);
        matches(created.json, { phone: '+4915112345678', tags: ['vip'] });
        assert.equal(
          (
            await call('POST', wa('/contacts'), {
              as: 'manager',
              body: person({ phone: '0049 151 12345678' }),
            })
          ).status,
          409
        );

        // lists show the number masked; the detail shows it to the people who work contacts only
        const list = await call('GET', wa('/contacts'), { as: 'analyst' });
        assert.equal(list.status, 200);
        assert.equal(list.json.length, 2);
        assert.ok(list.json.some((c) => c.maskedPhone === '+49•••••5678'));
        assert.doesNotMatch(list.text, /15112345678|\+4915/);
        const seenBySales = await call(
          'GET',
          wa(`/contacts/${created.json.id}`),
          { as: 'sales' }
        );
        assert.equal(seenBySales.json.phone, '+4915112345678');
        const seenByAnalyst = await call(
          'GET',
          wa(`/contacts/${created.json.id}`),
          { as: 'analyst' }
        );
        assert.equal(seenByAnalyst.json.phone, null);
        assert.doesNotMatch(seenByAnalyst.text, /15112345678/);

        // another agency sees none of it
        assert.deepEqual(
          (await call('GET', wa('/contacts'), { as: 'otherOwner' })).json,
          []
        );
        assert.equal(
          (
            await call('GET', wa(`/contacts/${created.json.id}`), {
              as: 'otherOwner',
            })
          ).status,
          404
        );
        ctx.waContact = created.json;
      });

      it('checks an import without saving it, honours the body limit, and imports only attested rows with consent', async () => {
        const file = [
          'name,phone,consent_source,consent_date',
          'Ben Ode,+4915100777001,In person,2026-03-15',
          'Cleo,+4915100777002,,2026-03-15',
          'Dan,+4915112345678,Web form,2026-03-14',
          'Eve,not a number,Web form,2026-03-14',
        ].join('\n');
        const preview = await call('POST', wa('/imports/preview'), {
          as: 'sales',
          body: { csv: file },
        });
        assert.equal(preview.status, 201, preview.text);
        matches(preview.json, {
          counts: {
            total: 4,
            valid: 1,
            duplicate: 1,
            invalid: 1,
            missingConsent: 1,
          },
          canImport: true,
        });
        assert.doesNotMatch(preview.text, /4915100777001/);
        assert.equal(
          await prisma.whatsappImport.count({
            where: { orgId: ctx.users.sales.orgId },
          }),
          0
        );

        for (const body of [
          { csv: file },
          { csv: file, attested: false },
          { csv: file, attested: 'yes' },
        ]) {
          assert.equal(
            (await call('POST', wa('/imports'), { as: 'sales', body })).status,
            400
          );
        }
        assert.equal(
          (
            await call('POST', wa('/imports/preview'), {
              as: 'analyst',
              body: { csv: file },
            })
          ).status,
          403
        );

        // a file longer than the validated length is refused with a message; one past the API's
        // JSON limit is refused before it is read
        const tooLong = await call('POST', wa('/imports/preview'), {
          as: 'sales',
          body: { csv: 'x'.repeat(95000) },
        });
        assert.equal(tooLong.status, 400, tooLong.text);
        const tooBig = await call('POST', wa('/imports/preview'), {
          as: 'sales',
          body: { csv: 'x'.repeat(150000) },
        });
        assert.equal(tooBig.status, 413, tooBig.text);

        const done = await call('POST', wa('/imports'), {
          as: 'sales',
          body: { csv: file, attested: true, fileName: 'people.csv' },
        });
        assert.equal(done.status, 201, done.text);
        matches(done.json, {
          totalRows: 4,
          importedRows: 1,
          duplicateRows: 1,
          invalidRows: 1,
          missingConsentRows: 1,
          fileName: 'people.csv',
        });
        assert.match(
          done.json.attestation,
          /agreed to be contacted on WhatsApp/
        );
        const batches = await call('GET', wa('/imports'), { as: 'analyst' });
        assert.equal(batches.json.length, 1);
        const audit = await call(
          'GET',
          `/agency/audit?entityType=WhatsappImport&entityId=${done.json.id}`,
          { as: 'owner' }
        );
        assert.equal(audit.json[0].action, 'whatsapp_import.committed');
        assert.doesNotMatch(JSON.stringify(audit.json), /4915100777001/);
      });

      it('prepares tasks, makes the chat link one task at a time, never claims delivery, and remembers who withdrew', async () => {
        const settings = await call('GET', wa('/settings'), { as: 'sales' });
        assert.deepEqual(settings.json.businessApi, {
          enabled: false,
          available: false,
          message: 'Not available in this version',
        });
        assert.equal(
          (
            await call('PUT', wa('/settings'), {
              as: 'owner',
              body: { businessApiEnabled: true },
            })
          ).status,
          400
        );
        assert.equal(
          (
            await call('PUT', wa('/settings'), {
              as: 'sales',
              body: { defaultOptOutLine: 'Send END' },
            })
          ).status,
          403
        );

        const bad = await call('POST', wa('/templates'), {
          as: 'sales',
          body: { name: 'Bad', body: 'Hi {{phone}}' },
        });
        assert.equal(bad.status, 400);
        assert.match(bad.json.message, /\{\{phone\}\}/);
        const template = await call('POST', wa('/templates'), {
          as: 'sales',
          body: { name: 'Spring', body: 'Hi {{first_name}} from {{agency}}!' },
        });
        assert.equal(template.status, 201, template.text);
        matches(template.json, { optOutLine: 'Reply STOP to opt out.' });
        const preview = await call('POST', wa('/templates/preview'), {
          as: 'analyst',
          body: { body: 'Hi {{name}}', optOutLine: '' },
        });
        assert.equal(preview.status, 201);
        assert.match(preview.json.warnings[0], /no way to opt out/);

        const segment = await call('POST', wa('/segments'), {
          as: 'sales',
          body: { name: 'Everyone', tags: ['vip'] },
        });
        assert.equal(segment.status, 201, segment.text);
        assert.equal(segment.json.memberCount, 1);

        const drafted = await call('POST', wa('/tasks/draft'), {
          as: 'sales',
          body: { templateId: template.json.id, segmentId: segment.json.id },
        });
        assert.equal(drafted.status, 201, drafted.text);
        assert.equal(drafted.json.created, 1);
        const tasks = await call('GET', wa('/tasks?status=PENDING'), {
          as: 'sales',
        });
        assert.equal(tasks.json.length, 1);
        assert.doesNotMatch(tasks.text, /15112345678|wa\.me/);
        const task = tasks.json[0];
        assert.match(
          task.message,
          /^Hi Ana from .+!\n\nReply STOP to opt out\.$/
        );

        // the link is made on request, for this one task, and only for staff who work contacts
        assert.equal(
          (await call('POST', wa(`/tasks/${task.id}/open`), { as: 'analyst' }))
            .status,
          403
        );
        const opened = await call('POST', wa(`/tasks/${task.id}/open`), {
          as: 'sales',
        });
        assert.equal(opened.status, 201, opened.text);
        assert.equal(opened.json.prefilled, true);
        assert.ok(
          opened.json.url.startsWith(
            'https://wa.me/4915112345678?text=Hi%20Ana'
          )
        );
        assert.equal(
          new URL(opened.json.url).searchParams.get('text'),
          task.message
        );

        // only people can say what happened, and "delivered" is not something they can say
        for (const status of ['DELIVERED', 'READ', 'SENT']) {
          assert.equal(
            (
              await call('PUT', wa(`/tasks/${task.id}/status`), {
                as: 'sales',
                body: { status },
              })
            ).status,
            400,
            status
          );
        }
        assert.equal(
          (
            await call('PUT', wa(`/tasks/${task.id}/status`), {
              as: 'sales',
              body: { status: 'REPLIED' },
            })
          ).status,
          400
        );
        const sent = await call('PUT', wa(`/tasks/${task.id}/status`), {
          as: 'sales',
          body: { status: 'SENT_BY_USER' },
        });
        assert.equal(sent.status, 200, sent.text);
        assert.equal(sent.json.status, 'SENT_BY_USER');
        assert.doesNotMatch(sent.text, /deliver/i);
        const remind = await call('PUT', wa(`/tasks/${task.id}`), {
          as: 'sales',
          body: { followUpAt: new Date(Date.now() - 3600000).toISOString() },
        });
        assert.equal(remind.status, 200, remind.text);
        const until = encodeURIComponent(new Date().toISOString());
        const due = await call('GET', wa(`/tasks/due?until=${until}`), {
          as: 'sales',
        });
        assert.deepEqual(
          due.json.map((d) => d.id),
          [task.id]
        );

        // withdrawing ends everything: no link, no due reminder, a ledger row that outlives erasing
        const withdrawn = await call(
          'POST',
          wa(`/contacts/${ctx.waContact.id}/withdraw`),
          {
            as: 'manager',
            body: { method: 'REPLIED_STOP', reason: 'wrote STOP' },
          }
        );
        assert.equal(withdrawn.status, 201, withdrawn.text);
        matches(withdrawn.json, { consentStatus: 'OPTED_OUT' });
        const refused = await call('POST', wa(`/tasks/${task.id}/open`), {
          as: 'sales',
        });
        assert.equal(refused.status, 400);
        assert.match(refused.json.message, /withdrew consent/);
        assert.deepEqual(
          (await call('GET', wa(`/tasks/due?until=${until}`), { as: 'sales' }))
            .json,
          []
        );
        assert.equal(
          (await call('GET', wa('/segments'), { as: 'sales' })).json[0]
            .memberCount,
          0
        );
        assert.equal(
          (
            await call('POST', wa('/contacts'), {
              as: 'sales',
              body: person({ phone: '+4915112345678', name: 'Back again' }),
            })
          ).status,
          409
        );

        assert.equal(
          (
            await call('DELETE', wa(`/contacts/${ctx.waContact.id}`), {
              as: 'manager',
            })
          ).status,
          403,
          'a campaign manager works contacts but may not erase them'
        );
        assert.equal(
          (
            await call('DELETE', wa(`/contacts/${ctx.waContact.id}`), {
              as: 'owner',
            })
          ).status,
          200
        );
        const ledger = await call('GET', wa('/unsubscribes'), {
          as: 'analyst',
        });
        assert.equal(ledger.status, 200);
        assert.equal(ledger.json.length, 1);
        matches(ledger.json[0], { method: 'REPLIED_STOP', contact: null });
        assert.doesNotMatch(ledger.text, /15112345678/);
        const stored = await prisma.whatsappUnsubscribe.findMany({
          where: { orgId: ctx.users.owner.orgId },
        });
        assert.match(stored[0].phoneHash, /^[0-9a-f]{64}$/);
        assert.equal(
          await prisma.whatsappTask.count({
            where: {
              orgId: ctx.users.owner.orgId,
              contactId: ctx.waContact.id,
            },
          }),
          0
        );
        // ledger rows can only be read: there is no route that changes or removes one
        for (const method of ['PUT', 'DELETE', 'POST']) {
          const res = await call(method, wa(`/unsubscribes/${stored[0].id}`), {
            as: 'owner',
          });
          assert.equal(res.status, 404, method);
        }
      });

      it('suggests wording only as text, and says so when the AI is not available', async () => {
        const { AgencyAiGatewayService, AiProviderError } = require(resolve(
          root,
          'dist/libraries/nestjs-libraries/src/database/prisma/agency/agency.ai.gateway.service.js'
        ));
        const saved = AgencyAiGatewayService.prototype.complete;
        try {
          AgencyAiGatewayService.prototype.complete = async () => {
            throw new AiProviderError(
              'unreachable',
              'Ollama is not running. Start it or pick another AI in Settings.'
            );
          };
          const down = await call('POST', wa('/templates/suggest'), {
            as: 'sales',
            body: { brief: 'Spring offer for returning customers' },
          });
          assert.equal(down.status, 201, down.text);
          assert.deepEqual(down.json, {
            available: false,
            reason:
              'Ollama is not running. Start it or pick another AI in Settings.',
          });
          AgencyAiGatewayService.prototype.complete = async () => ({
            text: 'Hi {{first_name}}, our spring offer is here.',
            provider: 'local',
            model: 'tiny',
            ms: 3,
            notes: [],
          });
          const up = await call('POST', wa('/templates/suggest'), {
            as: 'sales',
            body: { brief: 'Spring offer' },
          });
          assert.equal(up.json.available, true);
          assert.equal(
            up.json.text,
            'Hi {{first_name}}, our spring offer is here.'
          );
          assert.equal(
            (
              await call('POST', wa('/templates/suggest'), {
                as: 'sales',
                body: {},
              })
            ).status,
            400
          );
          assert.equal(
            (
              await call('POST', wa('/templates/suggest'), {
                as: 'analyst',
                body: { brief: 'x' },
              })
            ).status,
            403
          );
        } finally {
          AgencyAiGatewayService.prototype.complete = saved;
        }
        // nothing was saved by asking
        assert.equal(
          (await call('GET', wa('/templates'), { as: 'sales' })).json.length,
          1
        );
      });
    });

    describe('client accounts are portal-only', () => {
      it("a CLIENT is refused the workspace's own APIs (plain 403, not a logout) but keeps its identity and portal", async () => {
        for (const path of [
          '/integrations/list',
          '/notifications',
          '/posts/tags',
        ]) {
          const res = await call('GET', path, { as: 'client' });
          assert.equal(res.status, 403, `${path} -> ${res.status}`);
          assert.equal(
            res.headers.get('logout'),
            null,
            `${path} must not log the client out`
          );
        }
        for (const path of ['/user/self', '/agency/me', '/agency/portal/me']) {
          const res = await call('GET', path, { as: 'client' });
          assert.equal(res.status, 200, `${path} -> ${res.status}`);
        }
        // Staff are unaffected.
        const staff = await call('GET', '/integrations/list', {
          as: 'manager',
        });
        assert.equal(staff.status, 200);
      });
    });

    describe('publishing report over HTTP', () => {
      it('is staff-only, validates the period, and reports stored results without invented metrics', async () => {
        assert.equal(
          (await call('GET', '/agency/reports/publishing', { as: 'client' }))
            .status,
          403
        );
        const bad = await call(
          'GET',
          '/agency/reports/publishing?from=yesterday',
          { as: 'manager' }
        );
        assert.equal(bad.status, 400);

        const ok = await call('GET', '/agency/reports/publishing', {
          as: 'manager',
        });
        assert.equal(ok.status, 200);
        assert.equal(ok.json.range.timezone, 'UTC');
        assert.equal(ok.json.daily.length, 30);
        assert.ok('deliveryRate' in ok.json.totals);
        assert.ok(Array.isArray(ok.json.notes) && ok.json.notes.length > 0);
        assert.doesNotMatch(
          Object.keys(ok.json.totals).join(' '),
          /impression|reach|views|engagement/i
        );

        // Another agency's client id is not reachable through this one.
        const foreign = await call(
          'GET',
          `/agency/reports/publishing?customerId=${ctx.users.otherOwner.userId}`,
          { as: 'manager' }
        );
        assert.equal(foreign.status, 404);
      });
    });

    describe('tracking and export over HTTP', () => {
      it('a tracked link redirects anonymous visitors with UTMs; link-preview bots are not counted as clicks', async () => {
        const link = await call(
          'POST',
          `/agency/campaigns/${ctx.campaignId}/tracking-links`,
          {
            as: 'manager',
            body: {
              destinationUrl: 'https://example.com/landing',
              utmSource: 'telegram',
              utmMedium: 'ad',
            },
          }
        );
        assert.equal(link.status, 201, link.text);
        assert.equal(
          (
            await call(
              'POST',
              `/agency/campaigns/${ctx.campaignId}/tracking-links`,
              { as: 'manager', body: { destinationUrl: 'javascript:alert(1)' } }
            )
          ).status,
          400
        );

        const human = await call('GET', `/l/${link.json.shortCode}`, {
          headers: { 'user-agent': 'Mozilla/5.0 Chrome/120' },
        });
        assert.equal(human.status, 302);
        const location = new URL(human.headers.get('location'));
        assert.equal(
          location.origin + location.pathname,
          'https://example.com/landing'
        );
        assert.equal(location.searchParams.get('utm_source'), 'telegram');
        assert.equal(human.headers.get('cache-control'), 'no-store');
        await call('GET', `/l/${link.json.shortCode}`, {
          headers: { 'user-agent': 'TelegramBot (like TwitterBot)' },
        });
        await new Promise((r) => setTimeout(r, 300));
        const links = await call(
          'GET',
          `/agency/campaigns/${ctx.campaignId}/tracking-links`,
          { as: 'manager' }
        );
        assert.equal(links.json[0].totalClicks, 1);
      });

      it('the CSV export is an attachment with real numbers and neutralised formulas', async () => {
        // the campaign is SCHEDULED (frozen); internal notes remain editable by design
        const noted = await call('PUT', `/agency/campaigns/${ctx.campaignId}`, {
          as: 'manager',
          body: { internalNotes: '=cmd|"/c calc"!A1' },
        });
        assert.equal(noted.status, 200, noted.text);
        const csv = await call(
          'GET',
          `/agency/campaigns/${ctx.campaignId}/export/csv`,
          { as: 'manager' }
        );
        assert.equal(csv.status, 200);
        assert.match(csv.headers.get('content-type'), /text\/csv/);
        assert.match(
          csv.headers.get('content-disposition'),
          /attachment; filename="campaign-[\w-]+-report\.csv"/
        );
        assert.ok(csv.text.includes('"Tracked link clicks","1"'));
        assert.ok(csv.text.includes('"Delivered","0"'));
        assert.equal(
          (
            await call(
              'GET',
              `/agency/campaigns/${ctx.campaignId}/export/csv`,
              { as: 'otherOwner' }
            )
          ).status,
          404
        );
      });
    });

    describe('AI settings over HTTP', () => {
      it('shows every provider to staff, keeps keys private, and limits changes to admins', async () => {
        delete process.env.AGENCYOS_LOCAL;
        process.env.OLLAMA_HOST = 'http://127.0.0.1:1'; // nothing listens here

        const view = await call('GET', '/agency/ai/settings', {
          as: 'manager',
        });
        assert.equal(view.status, 200, view.text);
        matches(view.json, {
          activeProvider: 'local',
          thinking: 'auto',
          localMode: false,
        });
        assert.equal(view.json.providers.length, 8);
        assert.equal(
          view.json.providers.find((p) => p.id === 'claude-cli').selectable,
          false,
          'command-line tools are for the desktop app only'
        );

        assert.equal(
          (await call('GET', '/agency/ai/settings', { as: 'client' })).status,
          403
        );
        assert.equal(
          (
            await call('PUT', '/agency/ai/settings', {
              as: 'manager',
              body: { activeProvider: 'openai' },
            })
          ).status,
          403
        );

        // On a server, text only goes to an outside AI service when the operator allows it.
        const blocked = await call('PUT', '/agency/ai/settings', {
          as: 'owner',
          body: { activeProvider: 'openai' },
        });
        assert.equal(blocked.status, 400);
        assert.match(blocked.text, /AGENCY_ALLOW_EXTERNAL_AI/);
        process.env.AGENCY_ALLOW_EXTERNAL_AI = 'true';

        const saved = await call('PUT', '/agency/ai/settings', {
          as: 'owner',
          body: {
            activeProvider: 'openai',
            thinking: 'medium',
            providers: {
              openai: { apiKey: 'sk-e2e-secret-key', model: 'gpt-5' },
            },
            smuggled: 'ignored',
          },
        });
        assert.equal(saved.status, 200, saved.text);
        assert.ok(
          !saved.text.includes('sk-e2e-secret-key'),
          'the key is never sent back'
        );
        matches(
          saved.json.providers.find((p) => p.id === 'openai'),
          {
            hasKey: true,
            model: 'gpt-5',
          }
        );
        const row = await prisma.agencyAiConfig.findFirst({
          where: { orgId: ctx.users.owner.orgId },
        });
        assert.ok(
          !JSON.stringify(row).includes('sk-e2e-secret-key'),
          'stored sealed, not in clear'
        );
        assert.match(row.providers.openai.apiKey, /^v1\./);

        // Another agency sees none of it.
        const other = await call('GET', '/agency/ai/settings', {
          as: 'otherOwner',
        });
        assert.equal(other.json.activeProvider, 'local');
        assert.equal(
          other.json.providers.find((p) => p.id === 'openai').hasKey,
          false
        );

        // The change is on the audit trail, without the key.
        const audit = await call(
          'GET',
          '/agency/audit?entityType=AgencyAiConfig',
          {
            as: 'owner',
          }
        );
        assert.ok(audit.json.some((e) => e.action === 'ai.settings_updated'));
        assert.ok(!audit.text.includes('sk-e2e-secret-key'));
      });

      it('refuses what cannot work: command-line tools off the desktop app, unknown levels, bad names', async () => {
        const put = (body) =>
          call('PUT', '/agency/ai/settings', { as: 'owner', body });
        assert.equal((await put({ activeProvider: 'claude-cli' })).status, 400);
        assert.equal((await put({ activeProvider: 'robot' })).status, 400);
        assert.equal((await put({ thinking: 'galaxy' })).status, 400);
        assert.equal(
          (await put({ providers: { local: { model: 'a; b' } } })).status,
          400
        );
      });

      it('command-line tool updates: visible to staff, switchable by admins, desktop app only', async () => {
        const view = await call('GET', '/agency/ai/tools', { as: 'manager' });
        assert.equal(view.status, 200, view.text);
        assert.equal(view.json.available, false, 'not the desktop app');
        assert.deepEqual(
          view.json.tools.map((t) => t.id),
          ['claude-cli', 'codex-cli', 'antigravity-cli']
        );
        assert.equal(
          view.json.tools.find((t) => t.id === 'antigravity-cli').canUpdate,
          true
        );

        const put = (as, body) => call('PUT', '/agency/ai/tools', { as, body });
        assert.equal((await put('manager', { autoUpdate: false })).status, 403);
        assert.equal((await put('owner', { autoUpdate: 'yes' })).status, 400);
        const off = await put('owner', { autoUpdate: false });
        assert.equal(off.status, 200, off.text);
        assert.equal(off.json.autoUpdate, false);
        assert.equal(
          (await put('owner', { autoUpdate: true })).json.autoUpdate,
          true
        );

        const update = await call('POST', '/agency/ai/tools/update', {
          as: 'owner',
          body: {},
        });
        assert.equal(update.status, 400);
        assert.match(update.text, /desktop app/);
        assert.equal(
          (
            await call('POST', '/agency/ai/tools/update', {
              as: 'manager',
              body: {},
            })
          ).status,
          403
        );
        assert.equal(
          (await call('GET', '/agency/ai/tools', { as: 'client' })).status,
          403
        );
      });

      it('a model and thinking level per job survive a real request (the validation pipe keeps them)', async () => {
        process.env.AGENCY_ALLOW_EXTERNAL_AI = 'true';
        const saved = await call('PUT', '/agency/ai/settings', {
          as: 'owner',
          body: {
            tasks: {
              copy: { provider: 'local', model: 'gemma3:1b', thinking: 'off' },
              agent: { thinking: 'high' },
            },
          },
        });
        assert.equal(saved.status, 200, saved.text);
        matches(saved.json.tasks, {
          copy: { provider: 'local', model: 'gemma3:1b', thinking: 'off' },
          agent: { provider: null, thinking: 'high' },
        });
        const read = await call('GET', '/agency/ai/settings', {
          as: 'manager',
        });
        assert.equal(read.json.tasks.copy.model, 'gemma3:1b');

        const bad = await call('PUT', '/agency/ai/settings', {
          as: 'owner',
          body: { tasks: { copy: { thinking: 'galaxy' } } },
        });
        assert.equal(bad.status, 400);
        assert.equal(
          (
            await call('PUT', '/agency/ai/settings', {
              as: 'manager',
              body: { tasks: { copy: null } },
            })
          ).status,
          403
        );
        const cleared = await call('PUT', '/agency/ai/settings', {
          as: 'owner',
          body: { tasks: { copy: null, agent: null } },
        });
        assert.equal(cleared.json.tasks.copy.provider, null);
      });

      it('the agent: proposals change nothing, approved changes are role-checked and audited', async () => {
        process.env.OLLAMA_HOST = 'http://127.0.0.1:1'; // no model is reachable
        const step = await call('POST', '/agency/ai/agent/step', {
          as: 'manager',
          body: { messages: [{ role: 'user', content: 'hello' }] },
        });
        assert.equal(step.status, 502, step.text);
        assert.equal(step.json.code, 'unreachable');
        assert.equal(
          (
            await call('POST', '/agency/ai/agent/step', {
              as: 'manager',
              body: { messages: [] },
            })
          ).status,
          400
        );
        assert.equal(
          (
            await call('POST', '/agency/ai/agent/step', {
              as: 'client',
              body: { messages: [{ role: 'user', content: 'hi' }] },
            })
          ).status,
          403
        );

        const act = (as, tool, args) =>
          call('POST', '/agency/ai/agent/act', { as, body: { tool, args } });
        // Reads, approvals and anything unknown are not changes the agent can make.
        for (const tool of [
          'list_clients',
          'approve_campaign',
          'delete_campaign',
        ])
          assert.equal((await act('owner', tool, {})).status, 400);

        const made = await act('owner', 'create_client', {
          name: 'Agent Made Co',
        });
        assert.equal(made.status, 201, made.text);
        assert.equal(made.json.ok, true);
        const clients = await call('GET', '/agency/clients', { as: 'owner' });
        assert.ok(clients.json.some((c) => c.name === 'Agent Made Co'));
        const audit = await call(
          'GET',
          '/agency/audit?entityType=AgentAction',
          { as: 'owner' }
        );
        assert.ok(audit.json.some((e) => e.action === 'ai.agent_action'));

        // A role that may not add clients cannot get the agent to do it for them.
        assert.equal(
          (await act('manager', 'create_client', { name: 'Nope Co' })).status,
          403
        );
        const bad = await act('owner', 'create_client', {
          name: 'Bad',
          email: 'not-an-email',
        });
        assert.equal(bad.json.ok, false);
      });

      it('Test and chat report a provider problem plainly instead of failing silently', async () => {
        await call('PUT', '/agency/ai/settings', {
          as: 'owner',
          body: { activeProvider: 'local', thinking: 'auto' },
        });
        const test = await call('POST', '/agency/ai/test', {
          as: 'manager',
          body: { provider: 'local' },
        });
        assert.equal(test.status, 201, test.text);
        matches(test.json, { ok: false, code: 'unreachable' });
        assert.match(test.json.error, /Ollama is not running/);

        const bad = await call('POST', '/agency/ai/chat', {
          as: 'manager',
          body: { messages: [] },
        });
        assert.equal(bad.status, 400);
        const chat = await call('POST', '/agency/ai/chat', {
          as: 'manager',
          body: {
            messages: [{ role: 'user', content: 'How do I add a client?' }],
          },
        });
        assert.equal(chat.status, 502, chat.text);
        assert.equal(chat.json.code, 'unreachable');

        const status = await call('GET', '/agency/ai/status', {
          as: 'manager',
        });
        assert.equal(status.status, 200);
        assert.equal(
          status.json.find((s) => s.id === 'claude-cli').detail,
          'Only available in the AgencyOS desktop app.'
        );
        assert.equal(
          status.json.find((s) => s.id === 'openai').ready,
          true,
          'the key saved earlier'
        );
        assert.equal(
          status.json.find((s) => s.id === 'anthropic').ready,
          false
        );
      });
    });
  }
);
