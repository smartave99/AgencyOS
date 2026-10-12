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

    describe('Telegram without a configured bot token', () => {
      it('says so plainly instead of pretending', async () => {
        const verify = await call('POST', '/agency/telegram/verify', {
          as: 'manager',
          body: { chatId: '-100999' },
        });
        matches(verify.json, { valid: false });
        assert.match(verify.json.error, /not configured/i);
      });

      it('registering a destination yields a pending destination and a one-time code; it never starts authorized', async () => {
        const reg = await call('POST', '/agency/telegram/destinations', {
          as: 'manager',
          body: {
            chatId: '-100123456789',
            title: 'Fruit chat',
            canPostMessages: true,
            isAuthorized: true,
          },
        });
        assert.equal(reg.status, 201, reg.text);
        matches(reg.json.destination, {
          authorizationStatus: 'PENDING_VERIFICATION',
          isAuthorized: false,
        });
        assert.match(reg.json.verificationCode, /^AOS-[A-Z0-9]{8}$/);
        assert.ok(!reg.text.includes('verificationCodeHash'));
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

        const view = await call('GET', '/agency/ai/settings', { as: 'manager' });
        assert.equal(view.status, 200, view.text);
        matches(view.json, { activeProvider: 'local', thinking: 'auto', localMode: false });
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
            providers: { openai: { apiKey: 'sk-e2e-secret-key', model: 'gpt-5' } },
            smuggled: 'ignored',
          },
        });
        assert.equal(saved.status, 200, saved.text);
        assert.ok(!saved.text.includes('sk-e2e-secret-key'), 'the key is never sent back');
        matches(saved.json.providers.find((p) => p.id === 'openai'), {
          hasKey: true,
          model: 'gpt-5',
        });
        const row = await prisma.agencyAiConfig.findFirst({
          where: { orgId: ctx.users.owner.orgId },
        });
        assert.ok(!JSON.stringify(row).includes('sk-e2e-secret-key'), 'stored sealed, not in clear');
        assert.match(row.providers.openai.apiKey, /^v1\./);

        // Another agency sees none of it.
        const other = await call('GET', '/agency/ai/settings', { as: 'otherOwner' });
        assert.equal(other.json.activeProvider, 'local');
        assert.equal(other.json.providers.find((p) => p.id === 'openai').hasKey, false);

        // The change is on the audit trail, without the key.
        const audit = await call('GET', '/agency/audit?entityType=AgencyAiConfig', {
          as: 'owner',
        });
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
        assert.equal(view.json.tools.find((t) => t.id === 'antigravity-cli').canUpdate, false);

        const put = (as, body) => call('PUT', '/agency/ai/tools', { as, body });
        assert.equal((await put('manager', { autoUpdate: false })).status, 403);
        assert.equal((await put('owner', { autoUpdate: 'yes' })).status, 400);
        const off = await put('owner', { autoUpdate: false });
        assert.equal(off.status, 200, off.text);
        assert.equal(off.json.autoUpdate, false);
        assert.equal((await put('owner', { autoUpdate: true })).json.autoUpdate, true);

        const update = await call('POST', '/agency/ai/tools/update', { as: 'owner', body: {} });
        assert.equal(update.status, 400);
        assert.match(update.text, /desktop app/);
        assert.equal(
          (await call('POST', '/agency/ai/tools/update', { as: 'manager', body: {} })).status,
          403
        );
        assert.equal((await call('GET', '/agency/ai/tools', { as: 'client' })).status, 403);
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
          body: { messages: [{ role: 'user', content: 'How do I add a client?' }] },
        });
        assert.equal(chat.status, 502, chat.text);
        assert.equal(chat.json.code, 'unreachable');

        const status = await call('GET', '/agency/ai/status', { as: 'manager' });
        assert.equal(status.status, 200);
        assert.equal(
          status.json.find((s) => s.id === 'claude-cli').detail,
          'Only available in the AgencyOS desktop app.'
        );
        assert.equal(status.json.find((s) => s.id === 'openai').ready, true, 'the key saved earlier');
        assert.equal(status.json.find((s) => s.id === 'anthropic').ready, false);
      });
    });
  }
);
