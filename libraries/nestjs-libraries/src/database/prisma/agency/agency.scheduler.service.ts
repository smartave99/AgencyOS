import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AgencyPublishingService } from './agency.publishing.service';
import { AgencyTelegramService } from './agency.telegram.service';
import { TelegramGateway } from '@gitroom/nestjs-libraries/integrations/telegram/telegram.gateway';

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

  constructor(
    private readonly publishing: AgencyPublishingService,
    private readonly telegram: AgencyTelegramService,
    private readonly gateway: TelegramGateway
  ) {}

  onModuleInit() {
    if (process.env.AGENCY_SCHEDULER_ENABLED !== 'true') {
      this.logger.log(
        'Agency scheduler is disabled (set AGENCY_SCHEDULER_ENABLED=true to run it in this process).'
      );
      return;
    }
    const intervalMs = Math.max(
      2000,
      Number.parseInt(process.env.AGENCY_DISPATCH_INTERVAL_MS || '', 10) ||
        15000
    );
    this.logger.log(
      `Agency scheduler started (dispatch every ${intervalMs}ms).`
    );
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
    void this.startUpdateTransport();
  }

  onModuleDestroy() {
    this.stopped = true;
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
      const sent = await this.publishing.dispatchDue();
      if (sent > 0) this.logger.log(`Dispatched ${sent} posting job(s).`);
      await this.telegram.expireConsents();
    } catch (err: any) {
      this.logger.error(`Dispatch pass failed: ${err?.message}`);
    } finally {
      this.running = false;
    }
  }

  private async startUpdateTransport() {
    if (!this.gateway.isConfigured()) {
      this.logger.warn(
        'No Telegram bot token configured; destination authorization and publishing are unavailable.'
      );
      return;
    }
    const webhookUrl = process.env.AGENCY_TELEGRAM_WEBHOOK_URL;
    const secret = process.env.AGENCY_TELEGRAM_WEBHOOK_SECRET;
    try {
      if (webhookUrl && secret) {
        await this.gateway.setWebhook(webhookUrl, secret);
        this.logger.log('Telegram updates are delivered by webhook.');
        return;
      }
      // Polling and a webhook are mutually exclusive on the Telegram side.
      await this.gateway.deleteWebhook();
    } catch (err: any) {
      this.logger.warn(
        `Could not configure Telegram update delivery: ${err?.message}`
      );
      return;
    }
    if (
      process.env.AGENCY_TELEGRAM_BOT_TOKEN === undefined &&
      process.env.TELEGRAM_TOKEN
    ) {
      this.logger.warn(
        "Polling with TELEGRAM_TOKEN, which Postiz channel linking also polls. Set a dedicated AGENCY_TELEGRAM_BOT_TOKEN to avoid the two consuming each other's updates."
      );
    }
    this.logger.log('Telegram updates are delivered by long polling.');
    void this.pollLoop();
  }

  private async pollLoop() {
    while (!this.stopped) {
      const started = Date.now();
      await this.telegram.pollUpdatesOnce(20);
      // A poll that returned instantly (not the leader, or an error) must not spin.
      if (Date.now() - started < 1000) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
}
