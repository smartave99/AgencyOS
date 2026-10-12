/**
 * The desktop app has no sign-in. These checks run the COMPILED backend against PostgreSQL and
 * prove the one thing that replaces it: the app server opens the local workspace with a key, and
 * nobody else can open a session, register, sign in or reset a password.
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
const KEY = 'local-key-0123456789abcdef0123456789abcdef';
const OWNER = 'owner@agencyos.local';

describe(
  'Local mode: no sign-in (compiled backend + PostgreSQL)',
  { skip: !DB && 'set AGENCYOS_TEST_DATABASE_URL to run' },
  () => {
    let app;
    let base;
    let prisma;

    const call = async (method, path, { headers = {}, body } = {}) => {
      const res = await fetch(`${base}${path}`, {
        method,
        redirect: 'manual',
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, json, text };
    };
    const local = (on) => {
      if (on) {
        process.env.AGENCYOS_LOCAL = 'true';
        process.env.AGENCYOS_LOCAL_KEY = KEY;
      } else {
        delete process.env.AGENCYOS_LOCAL;
        delete process.env.AGENCYOS_LOCAL_KEY;
      }
    };
    const owners = () => prisma.user.count({ where: { email: OWNER } });
    // A previous run leaves the local workspace behind; remove it, memberships first.
    const removeOwner = async () => {
      const memberships = await prisma.userOrganization.findMany({
        where: { user: { email: OWNER } },
        select: { organizationId: true },
      });
      await prisma.userOrganization.deleteMany({
        where: { user: { email: OWNER } },
      });
      await prisma.organization.deleteMany({
        where: { id: { in: memberships.map((m) => m.organizationId) } },
      });
      await prisma.user.deleteMany({ where: { email: OWNER } });
    };

    before(async () => {
      Object.assign(process.env, {
        DATABASE_URL: DB,
        REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
        JWT_SECRET: 'local-e2e-test-secret-0123456789abcdef',
        FRONTEND_URL: 'http://localhost:5000',
        NOT_SECURED: 'true',
        STORAGE_PROVIDER: 'local',
        UPLOAD_DIRECTORY: process.env.UPLOAD_DIRECTORY || '/tmp',
      });
      local(false);

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
      await removeOwner();
    });

    after(async () => {
      local(false);
      await removeOwner();
      await app?.close();
    });

    it('is off by default: even the right key opens nothing outside local mode', async () => {
      local(false);
      process.env.AGENCYOS_LOCAL_KEY = KEY;
      const r = await call('POST', '/auth/local-session', {
        headers: { 'x-agencyos-local-key': KEY },
      });
      assert.equal(r.status, 403);
      assert.equal(await owners(), 0);
    });

    it('refuses a missing or wrong key and creates nothing', async () => {
      local(true);
      for (const headers of [
        {},
        { 'x-agencyos-local-key': 'nope' },
        { 'x-agencyos-local-key': `${KEY}x` },
        { 'x-agencyos-local-key': '' },
      ]) {
        const r = await call('POST', '/auth/local-session', { headers });
        assert.equal(r.status, 403, JSON.stringify(headers));
        assert.equal(r.json?.jwt, undefined);
      }
      assert.equal(await owners(), 0);
    });

    it('with the key opens the one local workspace, and the session works on the real API', async () => {
      local(true);
      const first = await call('POST', '/auth/local-session', {
        headers: { 'x-agencyos-local-key': KEY },
      });
      assert.equal(first.status, 200);
      assert.equal(typeof first.json.jwt, 'string');

      const self = await call('GET', '/user/self', {
        headers: { auth: first.json.jwt },
      });
      assert.equal(self.status, 200);
      assert.equal(self.json.email, OWNER);
      assert.equal(self.json.activated, true);
      assert.equal(self.json.role, 'SUPERADMIN');
      assert.ok(self.json.orgId);

      // Asking again gives the same person and workspace, never a second one.
      const again = await call('POST', '/auth/local-session', {
        headers: { 'x-agencyos-local-key': KEY },
      });
      const selfAgain = await call('GET', '/user/self', {
        headers: { auth: again.json.jwt },
      });
      assert.equal(selfAgain.json.id, self.json.id);
      assert.equal(selfAgain.json.orgId, self.json.orgId);
      assert.equal(await owners(), 1);
    });

    it('switches off sign-in, sign-up and password reset, so no account can be added or guessed', async () => {
      local(true);
      const before = await prisma.user.count();
      const attempts = [
        [
          '/auth/register',
          {
            email: 'intruder@example.com',
            password: 'password123',
            provider: 'LOCAL',
            company: 'Intruder Ltd',
          },
        ],
        [
          '/auth/login',
          { email: OWNER, password: 'password123', provider: 'LOCAL' },
        ],
        ['/auth/forgot', { email: OWNER }],
        ['/auth/forgot-return', { token: 'x', password: 'password123' }],
        ['/auth/activate', { code: 'x' }],
        ['/auth/resend-activation', { email: OWNER }],
      ];
      for (const [path, body] of attempts) {
        const r = await call('POST', path, { body });
        assert.equal(r.status, 403, path);
        assert.match(r.text, /does not use sign-in/, path);
      }
      assert.equal((await call('GET', '/auth/can-register')).status, 403);
      assert.equal(await prisma.user.count(), before, 'no account was created');
    });

    it('leaves normal sign-in alone outside local mode (servers and developers still use it)', async () => {
      local(false);
      const r = await call('POST', '/auth/login', {
        body: {
          email: 'nobody@example.com',
          password: 'password123',
          provider: 'LOCAL',
        },
      });
      assert.equal(r.status, 400);
      assert.match(r.text, /Invalid user name or password/);
    });
  }
);
