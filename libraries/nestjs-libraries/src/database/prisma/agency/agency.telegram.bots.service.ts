import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'crypto';
import { TelegramBotStatus, TelegramBotStrategy } from '@prisma/client';
import { AgencyRepository } from './agency.repository';
import { AgencyPublishingRepository } from './agency.publishing.repository';
import { AgencyAccessService, AgencyActor } from './agency.access.service';
import {
  TelegramGateway,
  TelegramGatewayError,
} from '@gitroom/nestjs-libraries/integrations/telegram/telegram.gateway';
import {
  AddTelegramBotDto,
  UpdateTelegramBotDto,
} from '@gitroom/nestjs-libraries/dtos/agency/telegram.dto';

/**
 * One bot as the rest of AgencyOS uses it: the gateway that speaks as that bot, plus the name to
 * show. `id` is null for the bot named in the server settings, which is how chats worked before
 * bots could be connected in the app.
 */
export interface BotHandle {
  id: string | null;
  /** Whose bot it is; null for the server's bot. */
  orgId: string | null;
  label: string;
  username: string;
  gateway: TelegramGateway;
}

/** Why a bot was chosen for a post, in the words the audit trail uses. */
export interface BotPick {
  bot: BotHandle;
  /** The bot's identity in a chat's lists: its id, or "server" for the server's bot. */
  key: string;
  reason: 'MAIN' | 'MAIN_UNAVAILABLE' | 'ROUND_ROBIN' | 'LEAST_USED';
  /** Why the main bot was not used, when it was not. */
  detail?: string;
}

interface ChatBots {
  id: string;
  botId: string | null;
  backupBotIds: string[];
  botStrategy: TelegramBotStrategy;
  lastBotId: string | null;
}

const SERVER_BOT_LABEL = 'Server bot';
/** What a request says to mean the bot from the server settings, which has no id of its own. */
export const SERVER_BOT = 'server';
const SERVER_NAME_TTL_MS = 10 * 60 * 1000;

/**
 * Connects Telegram bots. Any number can be connected: each is its own @BotFather bot with its own
 * token, and each chat is registered with exactly one of them. A token is a password for its bot,
 * so it is sealed (AES-256-GCM) and never leaves this service: lists show the name and state only.
 */
@Injectable()
export class AgencyTelegramBotsService {
  private readonly logger = new Logger(AgencyTelegramBotsService.name);
  private serverName: { username: string; at: number } | null = null;

  constructor(
    private readonly repo: AgencyRepository,
    private readonly jobs: AgencyPublishingRepository,
    private readonly access: AgencyAccessService,
    private readonly gateway: TelegramGateway
  ) {}

  // ==========================================
  // SECRETS (AES-256-GCM, key derived from the install's JWT_SECRET)
  // ==========================================
  private secretKey(): Buffer {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new HttpException(
        'The server has no secret to protect tokens',
        500
      );
    }
    return Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(secret),
        Buffer.from('agencyos-telegram-bots'),
        Buffer.from('bot-token-v1'),
        32
      )
    );
  }

  private seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.secretKey(), iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      body.toString('base64'),
    ].join('.');
  }

  private open(sealed: string): string | null {
    try {
      const [version, iv, tag, body] = sealed.split('.');
      if (version !== 'v1') return null;
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.secretKey(),
        Buffer.from(iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(body, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // A different install secret or a damaged value: the bot has to be connected again.
      return null;
    }
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  // ==========================================
  // READ
  // ==========================================
  async list(actor: AgencyActor) {
    this.access.assert(actor, 'destination:read');
    const [bots, server] = await Promise.all([
      this.repo.getTelegramBots(actor.orgId),
      this.serverBot(),
    ]);
    return { bots, server };
  }

  /** The bot from the server settings, if there is one: shown read-only next to the connected ones. */
  private async serverBot() {
    if (!TelegramGateway.serverToken()) {
      return { configured: false, label: SERVER_BOT_LABEL, username: null };
    }
    return {
      configured: true,
      label: SERVER_BOT_LABEL,
      username: await this.serverUsername(),
    };
  }

  private async serverUsername(): Promise<string | null> {
    if (
      this.serverName &&
      Date.now() - this.serverName.at < SERVER_NAME_TTL_MS
    ) {
      return this.serverName.username;
    }
    try {
      const me = await this.gateway.getBotInfo();
      this.serverName = { username: me.username, at: Date.now() };
      return me.username;
    } catch {
      return null;
    }
  }

  // ==========================================
  // CONNECT, CHECK, RENAME, PAUSE
  // ==========================================
  async add(actor: AgencyActor, dto: AddTelegramBotDto) {
    this.access.assert(actor, 'bot:manage');
    const token = dto.token.trim();
    const label = dto.label.trim();
    if (!label) throw new BadRequestException('Give the bot a name.');
    if (token === TelegramGateway.serverToken()) {
      throw new ConflictException(
        'This bot is already connected through the server settings.'
      );
    }
    const tokenHash = this.hashToken(token);
    const same = await this.repo.findTelegramBotByTokenHash(tokenHash);
    if (same) {
      throw new ConflictException(
        same.orgId === actor.orgId
          ? `This bot is already connected as "${same.label}".`
          : 'This bot is already connected to another workspace.'
      );
    }

    let info: { id: number; username: string };
    try {
      info = await this.gateway.bound(token).getBotInfo();
    } catch (err) {
      this.gateway.forget(token);
      throw this.explain(err);
    }

    const created = await this.repo.createTelegramBot(actor.orgId, {
      label,
      tokenSealed: this.seal(token),
      tokenHash,
      telegramBotId: String(info.id),
      username: info.username,
    });
    await this.access.audit(actor, {
      action: 'telegram_bot.connected',
      entityType: 'TelegramBot',
      entityId: created.id,
      summary: `Connected @${info.username} as "${label}"`,
    });
    return { ...created, destinationCount: 0 };
  }

  async rename(actor: AgencyActor, id: string, dto: UpdateTelegramBotDto) {
    this.access.assert(actor, 'bot:manage');
    const bot = await this.require(actor.orgId, id);
    if (dto.label && dto.label.trim() !== bot.label) {
      await this.repo.updateTelegramBot(actor.orgId, id, {
        label: dto.label.trim(),
      });
      await this.access.audit(actor, {
        action: 'telegram_bot.renamed',
        entityType: 'TelegramBot',
        entityId: id,
        summary: `Renamed "${bot.label}" to "${dto.label.trim()}"`,
      });
    }
    return this.view(actor.orgId, id);
  }

  /**
   * Asks Telegram who the token belongs to. A token Telegram no longer accepts marks the bot as
   * needing attention; a network problem changes nothing, since it says nothing about the bot.
   */
  async check(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'bot:manage');
    const bot = await this.require(actor.orgId, id);
    const token = this.open(bot.tokenSealed);
    if (!token) {
      await this.repo.updateTelegramBot(actor.orgId, id, {
        status: TelegramBotStatus.INVALID,
        lastError:
          'AgencyOS cannot open the saved token (this install has a new secret). Remove the bot and connect it again.',
        lastCheckedAt: new Date(),
      });
      return this.view(actor.orgId, id);
    }
    try {
      const me = await this.gateway.bound(token).getBotInfo();
      await this.repo.updateTelegramBot(actor.orgId, id, {
        username: me.username,
        lastError: null,
        lastCheckedAt: new Date(),
        ...(bot.status === TelegramBotStatus.INVALID
          ? { status: TelegramBotStatus.ACTIVE }
          : {}),
      });
    } catch (err) {
      const failure = this.classify(err);
      await this.repo.updateTelegramBot(actor.orgId, id, {
        lastError: failure.message,
        lastCheckedAt: new Date(),
        ...(failure.kind === 'UNCONFIGURED'
          ? { status: TelegramBotStatus.INVALID }
          : {}),
      });
    }
    return this.view(actor.orgId, id);
  }

  /** Pausing keeps the bot and its chats; nothing is sent or listened for until it is resumed. */
  async setEnabled(actor: AgencyActor, id: string, enabled: boolean) {
    this.access.assert(actor, 'bot:manage');
    const bot = await this.require(actor.orgId, id);
    await this.repo.updateTelegramBot(actor.orgId, id, {
      status: enabled ? TelegramBotStatus.ACTIVE : TelegramBotStatus.DISABLED,
      ...(enabled ? { lastError: null } : {}),
    });
    await this.access.audit(actor, {
      action: enabled ? 'telegram_bot.resumed' : 'telegram_bot.paused',
      entityType: 'TelegramBot',
      entityId: id,
      summary: `${enabled ? 'Resumed' : 'Paused'} "${bot.label}"`,
    });
    return enabled ? this.check(actor, id) : this.view(actor.orgId, id);
  }

  /** Wipes the token. Chats that used the bot are taken out of service by AgencyTelegramService. */
  async delete(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'bot:manage');
    const bot = await this.require(actor.orgId, id);
    const token = this.open(bot.tokenSealed);
    await this.repo.deleteTelegramBot(actor.orgId, id);
    if (token) this.gateway.forget(token);
    await this.access.audit(actor, {
      action: 'telegram_bot.removed',
      entityType: 'TelegramBot',
      entityId: id,
      summary: `Removed @${bot.username} ("${bot.label}")`,
    });
    return { removed: true };
  }

  // ==========================================
  // USED BY THE OTHER TELEGRAM SERVICES
  // ==========================================
  /**
   * The bot a chat is served by. Throws a TelegramGatewayError('UNCONFIGURED') that says which bot
   * and what to do, so a paused or removed bot stops its chats with a reason, never silently
   * switches them to another bot.
   */
  async handleFor(orgId: string, botId: string | null): Promise<BotHandle> {
    if (botId === null) {
      if (!TelegramGateway.serverToken()) {
        throw new TelegramGatewayError(
          'UNCONFIGURED',
          'No Telegram bot is connected for this chat. Add one in Settings → Telegram bots.'
        );
      }
      return this.serverHandle();
    }
    const row = await this.repo.getTelegramBotByIdWithToken(botId);
    if (!row || row.deletedAt || row.orgId !== orgId) {
      throw new TelegramGatewayError(
        'UNCONFIGURED',
        'The bot for this chat was removed. Connect it again, or register the chat with another bot.'
      );
    }
    return this.openHandle(row);
  }

  /**
   * Which bot a new chat is registered with: the one asked for, or the only one there is. With
   * several to choose from the person must say which, so a chat is never given a bot by chance.
   */
  async chooseFor(orgId: string, requested?: string): Promise<BotHandle> {
    const bots = (await this.repo.getTelegramBots(orgId)).filter(
      (b) => b.status === TelegramBotStatus.ACTIVE
    );
    const serverOn = !!TelegramGateway.serverToken();
    if (requested === SERVER_BOT) {
      if (!serverOn) {
        throw new NotFoundException('The server bot is not set up.');
      }
      return this.serverHandle();
    }
    if (requested) {
      if (!bots.some((b) => b.id === requested)) {
        throw new NotFoundException('That bot is not connected, or is paused.');
      }
      return this.handleFor(orgId, requested);
    }
    const choices = bots.length + (serverOn ? 1 : 0);
    if (choices === 0) {
      throw new BadRequestException(
        'Connect a Telegram bot first: Settings → Telegram bots.'
      );
    }
    if (choices > 1) {
      throw new BadRequestException('Choose which bot posts in this chat.');
    }
    return bots.length === 1
      ? this.handleFor(orgId, bots[0].id)
      : this.serverHandle();
  }

  /** A bot's identity in a chat's lists: its id, or "server" for the bot from the server settings. */
  static keyOf(botId: string | null) {
    return botId ?? SERVER_BOT;
  }

  /**
   * Which of a chat's bots posts this time. The main bot is the chat's own consent anchor; backups
   * are other bots of the same agency that the chat's administrator has made administrators too
   * (checked live by the sender). Switching happens only because AgencyOS cannot use a bot
   * (paused, removed, rejected token) or because the agency asked for turns; never because a chat
   * removed a bot or because Telegram asked us to slow down. `skip` holds bots already ruled out
   * during this send.
   */
  async pick(
    orgId: string,
    chat: ChatBots,
    skip: ReadonlySet<string> = new Set()
  ): Promise<BotPick> {
    const mainKey = AgencyTelegramBotsService.keyOf(chat.botId);
    const order = [mainKey, ...chat.backupBotIds.filter((k) => k !== mainKey)];
    const usable: Array<{ key: string; bot: BotHandle }> = [];
    let mainProblem: Error | null = null;
    let firstProblem: Error | null = null;
    for (const key of order) {
      if (skip.has(key)) continue;
      try {
        usable.push({
          key,
          bot: await this.handleFor(orgId, key === SERVER_BOT ? null : key),
        });
      } catch (err) {
        firstProblem ??= err as Error;
        if (key === mainKey) mainProblem = err as Error;
      }
    }
    if (usable.length === 0) {
      throw (
        firstProblem ??
        new TelegramGatewayError(
          'UNCONFIGURED',
          'No Telegram bot can post to this chat right now.'
        )
      );
    }
    const detail = mainProblem?.message;
    const pickOf = (
      chosen: { key: string; bot: BotHandle },
      reason: BotPick['reason']
    ): BotPick => ({
      bot: chosen.bot,
      key: chosen.key,
      reason: chosen.key === mainKey ? 'MAIN' : reason,
      ...(chosen.key !== mainKey && detail ? { detail } : {}),
    });

    if (chat.botStrategy === TelegramBotStrategy.ROUND_ROBIN) {
      const last = usable.findIndex((u) => u.key === chat.lastBotId);
      return pickOf(usable[(last + 1) % usable.length], 'ROUND_ROBIN');
    }
    if (chat.botStrategy === TelegramBotStrategy.LEAST_USED) {
      const counts = await this.jobs.countSendsByBot(
        chat.id,
        new Date(Date.now() - 24 * 3600 * 1000)
      );
      const least = usable.reduce((best, u) =>
        (counts.get(u.key) ?? 0) < (counts.get(best.key) ?? 0) ? u : best
      );
      return pickOf(least, 'LEAST_USED');
    }
    // FAILOVER: the main bot, or the first usable backup when it cannot be used.
    return pickOf(usable[0], 'MAIN_UNAVAILABLE');
  }

  /** Every bot that should be listening for /authorize and /revoke: the server's, plus each active one. */
  async pollable(): Promise<BotHandle[]> {
    const handles: BotHandle[] = [];
    if (TelegramGateway.serverToken()) handles.push(this.serverHandle());
    for (const row of await this.repo.getPollableTelegramBots()) {
      try {
        handles.push(this.openHandle(row));
      } catch (err) {
        this.logger.warn(
          `Not listening for "${row.label}": ${(err as Error).message}`
        );
      }
    }
    return handles;
  }

  /** What the dashboard may truthfully say: is a bot connected, and which update listeners should be running. */
  async connection() {
    const handles = await this.pollable();
    return { configured: handles.length > 0, count: handles.length, handles };
  }

  /** Telegram refused the token while listening or sending: the bot is marked, and stops being polled. */
  async markRejected(bot: BotHandle, reason: string) {
    if (!bot.id || !bot.orgId) return;
    await this.repo.updateTelegramBot(bot.orgId, bot.id, {
      status: TelegramBotStatus.INVALID,
      lastError: reason,
      lastCheckedAt: new Date(),
    });
  }

  static leaseName(bot: { id: string | null }) {
    return bot.id
      ? `agency-telegram-updates:${bot.id}`
      : 'agency-telegram-updates';
  }

  // ==========================================
  // HELPERS
  // ==========================================
  private serverHandle(): BotHandle {
    return {
      id: null,
      orgId: null,
      label: SERVER_BOT_LABEL,
      username: this.serverName?.username ?? '',
      gateway: this.gateway,
    };
  }

  private openHandle(row: {
    id: string;
    orgId: string;
    label: string;
    username: string;
    status: TelegramBotStatus;
    tokenSealed: string;
  }): BotHandle {
    if (row.status !== TelegramBotStatus.ACTIVE) {
      throw new TelegramGatewayError(
        'UNCONFIGURED',
        row.status === TelegramBotStatus.DISABLED
          ? `The bot "${row.label}" is paused. Resume it in Settings → Telegram bots.`
          : `Telegram no longer accepts the token of "${row.label}". Check it in Settings → Telegram bots.`
      );
    }
    const token = this.open(row.tokenSealed);
    if (!token) {
      throw new TelegramGatewayError(
        'UNCONFIGURED',
        `AgencyOS cannot open the saved token of "${row.label}". Remove the bot and connect it again.`
      );
    }
    return {
      id: row.id,
      orgId: row.orgId,
      label: row.label,
      username: row.username,
      gateway: this.gateway.bound(token),
    };
  }

  private async require(orgId: string, id: string) {
    const bot = await this.repo.getTelegramBotWithToken(orgId, id);
    if (!bot) throw new NotFoundException('Bot not found');
    return bot;
  }

  private async view(orgId: string, id: string) {
    const bots = await this.repo.getTelegramBots(orgId);
    const bot = bots.find((b) => b.id === id);
    if (!bot) throw new NotFoundException('Bot not found');
    return bot;
  }

  private classify(err: unknown) {
    return err instanceof TelegramGatewayError
      ? err
      : this.gateway.classify(err);
  }

  /** A person-readable reason a token could not be connected. */
  private explain(err: unknown) {
    const failure = this.classify(err);
    if (failure.kind === 'UNCONFIGURED') {
      return new BadRequestException(
        'Telegram did not accept this token. Copy it again from @BotFather.'
      );
    }
    return new HttpException(
      'Could not reach Telegram to check the token. Check the internet connection and try again.',
      502
    );
  }
}
