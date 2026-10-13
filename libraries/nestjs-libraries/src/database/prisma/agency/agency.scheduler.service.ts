import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AgencyPublishingService } from './agency.publishing.service';
import { AgencyTelegramService } from './agency.telegram.service';
import {
  AgencyTelegramBotsService,
  BotHandle,
} from './agency.telegram.bots.service';
import { TelegramGatewayError } from '@gitroom/nestjs-libraries/integrations/telegram/telegram.gateway';

/**
 * Drives the database-backed publishing queue. It is a thin loop: every guarantee
 * (one worker per job, retries, idempotency) lives in AgencyPublishingService and the
 * job table, so running this in several processes is safe, just redundant.
 *
 * It is opt-in (AGENCY_SCHEDULER_ENABLED=true). DatabaseModule is imported by the
 * backend, the orchestrator and the CLI commands app, and a one-off CLI run must not
 * start publishing.
 */
@Injectable()
export class AgencySchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgencySchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private intervalMs = 15000;
  // One listener per bot, so a slow or silent bot never holds up another one's /authorize.
  private readonly listeners = new Map<string, { stop: boolean }>();
  private serverWebhookSet = false;

  constructor(
    private readonly publishing: AgencyPublishingService,
    private readonly telegram: AgencyTelegramService,
    private readonly bots: AgencyTelegramBotsService
  ) {}

  onModuleInit() {
    if (process.env.AGENCY_SCHEDULER_ENABLED !== 'true') {
      this.logger.log(
        'Agency scheduler is disabled (set AGENCY_SCHEDULER_ENABLED=true to run it in this process).'
      );
      return;
    }
    this.intervalMs = Math.max(
      2000,
      Number.parseInt(process.env.AGENCY_DISPATCH_INTERVAL_MS || '', 10) ||
        15000
    );
    this.logger.log(
      `Agency scheduler started (dispatch every ${this.intervalMs}ms).`
    );
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  onModuleDestroy() {
    this.stopped = true;
    for (const listener of this.listeners.values()) listener.stop = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One dispatch pass. Overlapping passes in one process are skipped, not queued. */
  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.publishing.heartbeat(this.intervalMs);
      const sent = await this.publishing.dispatchDue();
      if (sent > 0) this.logger.log(`Dispatched ${sent} posting job(s).`);
      await this.telegram.expireConsents();
    } catch (err: any) {
      this.logger.error(`Dispatch pass failed: ${err?.message}`);
    } finally {
      this.running = false;
    }
    // Bots can be connected or paused at any time in the app: each pass starts and stops listeners to match.
    await this.syncListeners();
  }

  private async syncListeners() {
    try {
      const bots = await this.bots.pollable();
      const wanted = new Set(bots.map((b) => AgencyTelegramBotsService.leaseName(b)));
      for (const [name, listener] of this.listeners) {
        if (!wanted.has(name)) {
          listener.stop = true;
          this.listeners.delete(name);
          this.logger.log(`Stopped listening on ${name}.`);
        }
      }
      if (bots.length === 0 && !this.warnedNoBot) {
        this.warnedNoBot = true;
        this.logger.warn(
          'No Telegram bot is connected; destination authorization and publishing are unavailable. Add one in Settings → Telegram bots.'
        );
      }
      for (const bot of bots) {
        const name = AgencyTelegramBotsService.leaseName(bot);
        if (this.listeners.has(name)) continue;
        this.warnedNoBot = false;
        const listener = { stop: false };
        this.listeners.set(name, listener);
        void this.listen(bot, listener);
      }
    } catch (err: any) {
      this.logger.warn(`Could not update the Telegram listeners: ${err?.message}`);
    }
  }

  private warnedNoBot = false;

  private async listen(bot: BotHandle, listener: { stop: boolean }) {
    const webhookUrl = process.env.AGENCY_TELEGRAM_WEBHOOK_URL;
    const secret = process.env.AGENCY_TELEGRAM_WEBHOOK_SECRET;
    try {
      // A webhook is only for the server's bot: bots connected in the app always poll.
      if (bot.id === null && webhookUrl && secret) {
        if (!this.serverWebhookSet) {
          await bot.gateway.setWebhook(webhookUrl, secret);
          this.serverWebhookSet = true;
        }
        this.logger.log('Telegram updates are delivered by webhook.');
        return;
      }
      // Polling and a webhook are mutually exclusive on the Telegram side.
      await bot.gateway.deleteWebhook();
    } catch (err: any) {
      this.logger.warn(
        `Could not configure Telegram update delivery for "${bot.label}": ${err?.message}`
      );
      if (err instanceof TelegramGatewayError && err.kind === 'UNCONFIGURED') {
        await this.bots.markRejected(bot, err.message).catch(() => undefined);
      }
      // Try again on the next pass (a bot Telegram rejected is no longer in the list).
      this.listeners.delete(AgencyTelegramBotsService.leaseName(bot));
      return;
    }
    if (
      bot.id === null &&
      process.env.AGENCY_TELEGRAM_BOT_TOKEN === undefined &&
      process.env.TELEGRAM_TOKEN
    ) {
      this.logger.warn(
        "Polling with TELEGRAM_TOKEN, which AgencyOS channel linking also polls. Set a dedicated AGENCY_TELEGRAM_BOT_TOKEN to avoid the two consuming each other's updates."
      );
    }
    this.logger.log(`Listening for Telegram updates for "${bot.label}".`);
    while (!this.stopped && !listener.stop) {
      const started = Date.now();
      await this.telegram.pollUpdatesOnce(bot, 20);
      // A poll that returned instantly (not the leader, or an error) must not spin.
      if (Date.now() - started < 1000) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
}
