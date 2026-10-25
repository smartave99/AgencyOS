// Dev harness: the real compiled backend (Temporal stubbed, as in the e2e tests) on :3000,
// with the production CORS settings, so the Next.js frontend can talk to it in local mode.
import { createRequire } from 'node:module';
const require = createRequire('/home/user/AgencyOS/apps/backend/package.json');
const dist = (p) => require('/home/user/AgencyOS/apps/backend/dist/' + p);
process.env.TZ = 'UTC';
const { Global, Module, ValidationPipe } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const cookieParser = require('cookie-parser');
const { json } = require('express');
const { TemporalService } = require('nestjs-temporal-core');
const { ThrottlerModule } = require('@nestjs/throttler');
const { DatabaseModule } = dist('libraries/nestjs-libraries/src/database/prisma/database.module.js');
const { ApiModule } = dist('apps/backend/src/api/api.module.js');
const { PublicApiModule } = dist('apps/backend/src/public-api/public.api.module.js');
const { AgentModule } = dist('libraries/nestjs-libraries/src/agent/agent.module.js');
const { ThirdPartyModule } = dist('libraries/nestjs-libraries/src/3rdparties/thirdparty.module.js');
const { VideoModule } = dist('libraries/nestjs-libraries/src/videos/video.module.js');
const { ChatModule } = dist('libraries/nestjs-libraries/src/chat/chat.module.js');
// Telegram is not reachable from here: answer for it, per bot, so the bot screens can be used.
if (process.env.DEV_FAKE_TELEGRAM) {
  const { TelegramGateway } = dist('libraries/nestjs-libraries/src/integrations/telegram/telegram.gateway.js');
  const P = TelegramGateway.prototype;
  P.getBotInfo = async function () {
    if (this.token && /rejected/.test(this.token)) { const { TelegramGatewayError } = dist('libraries/nestjs-libraries/src/integrations/telegram/telegram.gateway.js'); throw new TelegramGatewayError('UNCONFIGURED', 'Telegram bot token was rejected'); }
    const id = Number(String(this.token).split(':')[0]); return { id, username: 'bot_' + id };
  };
  P.getChat = async function (ref) { return { id: ref.startsWith('@') ? '-1009999999' : ref, type: 'supergroup', title: 'Chat ' + ref }; };
  P.getBotPermissions = async function () { return { isAdmin: true, canPostMessages: true, canDeleteMessages: false, canInviteUsers: false }; };
  P.getUpdates = async function () { await new Promise((r) => setTimeout(r, 4000)); return []; };
  P.deleteWebhook = async function () {};
}
const { HttpExceptionFilter } = dist('libraries/nestjs-libraries/src/services/exception.filter.js');
class TestAppModule {}
Global()(TestAppModule);
Module({
  imports: [DatabaseModule, ApiModule, PublicApiModule, AgentModule, ThirdPartyModule, VideoModule, ChatModule, ThrottlerModule.forRoot({ throttlers: [{ ttl: 60000, limit: 100000 }] })],
  providers: [{ provide: TemporalService, useValue: { client: { getRawClient: () => undefined } } }],
  exports: [DatabaseModule, ApiModule, PublicApiModule, AgentModule, ThrottlerModule, ChatModule, TemporalService],
})(TestAppModule);
const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
const app = moduleRef.createNestApplication({
  cors: {
    allowedHeaders: ['Content-Type', 'Authorization', 'auth', 'showorg', 'impersonate'],
    exposedHeaders: ['reload', 'onboarding', 'activate', 'auth', 'showorg', 'impersonate'],
    origin: [process.env.FRONTEND_URL],
  },
});
app.use(cookieParser());
app.use(json({ limit: '50mb' }));
app.useGlobalPipes(new ValidationPipe({ transform: true }));
app.useGlobalFilters(new HttpExceptionFilter());
await app.listen(3000, '127.0.0.1');
console.log('backend ready on 3000');
