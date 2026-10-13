import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { hostname } from 'os';
import { DestinationAuthStatus, Prisma } from '@prisma/client';
import { AgencyRepository } from './agency.repository';
import { AgencyPublishingRepository } from './agency.publishing.repository';
import { AgencyPublishingService } from './agency.publishing.service';
import { AgencyAccessService, AgencyActor } from './agency.access.service';
import {
  AgencyTelegramBotsService,
  BotHandle,
} from './agency.telegram.bots.service';
import {
  TelegramGatewayError,
  TelegramInboundUpdate,
} from '@gitroom/nestjs-libraries/integrations/telegram/telegram.gateway';
import {
  RegisterTelegramDestinationDto,
  UpdateTelegramDestinationDto,
} from '@gitroom/nestjs-libraries/dtos/agency/telegram.dto';

// Unambiguous alphabet (no 0/O/1/I) so a code read aloud or retyped survives.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const AUTHORIZE_RE = /^\/authorize(?:@\w+)?\s+(AOS-[A-Z0-9]{8})\s*$/i;
const REVOKE_RE = /^\/revoke(?:@\w+)?\s*$/i;
const GROUP_ANONYMOUS_BOT_ID = 1087968824;

type DestinationRow = NonNullable<
  Awaited<ReturnType<AgencyRepository['getTelegramDestinationById']>>
>;

@Injectable()
export class AgencyTelegramService {
  private readonly logger = new Logger(AgencyTelegramService.name);
  private readonly holderId = `${hostname()}:${process.pid}:${randomBytes(
    3
  ).toString('hex')}`;
  // Telegram numbers each bot's updates separately, so each bot keeps its own place.
  private readonly updateOffsets = new Map<string, number>();

  constructor(
    private readonly repo: AgencyRepository,
    private readonly jobs: AgencyPublishingRepository,
    private readonly publishing: AgencyPublishingService,
    private readonly access: AgencyAccessService,
    private readonly bots: AgencyTelegramBotsService
  ) {}

  private get consentValidDays() {
    const n = Number.parseInt(process.env.AGENCY_CONSENT_VALID_DAYS || '', 10);
    return Number.isFinite(n) && n > 0 ? n : 365;
  }

  // ==========================================
  // READ
  // ==========================================
  async listDestinations(actor: AgencyActor) {
    this.access.assert(actor, 'destination:read');
    const rows = await this.repo.getTelegramDestinations(actor.orgId);
    return rows.map((r) => this.toView(r));
  }

  /** Live look at a chat without registering anything: what the bot can see and do there. */
  async previewChat(actor: AgencyActor, chatRef: string, botId?: string) {
    this.access.assert(actor, 'destination:manage');
    let bot: BotHandle;
    try {
      bot = await this.bots.chooseFor(actor.orgId, botId);
    } catch (err) {
      return this.unavailable(
        (err as Error).message || 'No Telegram bot is connected yet.'
      );
    }
    try {
      const chat = await bot.gateway.getChat(chatRef);
      const perms = await bot.gateway.getBotPermissions(chat.id);
      return {
        valid: true,
        title: chat.title,
        type: chat.type,
        botIsAdmin: perms.isAdmin,
        canPostMessages: perms.canPostMessages,
        canDeleteMessages: perms.canDeleteMessages,
        canInviteUsers: perms.canInviteUsers,
      };
    } catch (err) {
      return this.unavailable(this.describeError(err));
    }
  }

  // ==========================================
  // REGISTRATION → PROOF OF ADMIN CONSENT
  // ==========================================
  /**
   * Registers a chat in PENDING_VERIFICATION. It cannot receive ads until a chat
   * administrator sends `/authorize <code>` inside the chat itself. The code is shown
   * once; only its hash is stored.
   */
  async registerDestination(
    actor: AgencyActor,
    dto: RegisterTelegramDestinationDto
  ) {
    this.access.assert(actor, 'destination:manage');
    const chatRef = this.normalizeRef(dto.chatId);
    this.assertSettings(dto);
    // The bot is chosen first: it is the one that looks the chat up, posts in it and hears /authorize.
    const bot = await this.bots.chooseFor(actor.orgId, dto.botId);

    const existing = await this.repo.getTelegramDestinationByChat(
      actor.orgId,
      chatRef
    );
    if (existing) {
      throw new ConflictException(
        'This chat is already registered. Open it to manage authorization.'
      );
    }

    let title = dto.title?.trim() || chatRef;
    let type = 'channel';
    let chatId = chatRef;
    let botNote: string | null = null;
    try {
      const chat = await bot.gateway.getChat(chatRef);
      title = chat.title;
      type = chat.type;
      chatId = chat.id;
      const dupe = await this.repo.getTelegramDestinationByChat(
        actor.orgId,
        chatId
      );
      if (dupe) {
        throw new ConflictException(
          'This chat is already registered. Open it to manage authorization.'
        );
      }
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      botNote =
        'The bot cannot see this chat yet. Add it as an administrator, then authorize.';
    }

    const { code, hash } = this.newVerificationCode();
    const created = await this.repo.createTelegramDestination(actor.orgId, {
      chatId,
      title,
      type,
      botId: bot.id,
      botUsername: (await this.usernameOf(bot)) || undefined,
      timezone: dto.timezone,
      ownerName: dto.ownerName,
      ownerContact: dto.ownerContact,
      permittedCategories: dto.permittedCategories,
      postingFrequencyRules: dto.postingFrequencyRules,
      allowedPostingWindows: dto.allowedPostingWindows,
      verificationCodeHash: hash,
      verificationExpiresAt: new Date(Date.now() + 72 * 3600 * 1000),
    });
    if (botNote)
      await this.repo.recordDestinationError(actor.orgId, created.id, botNote);
    await this.access.audit(actor, {
      action: 'destination.registered',
      entityType: 'TelegramDestination',
      entityId: created.id,
      summary: `Registered "${title}" (awaiting admin authorization)`,
    });
    return {
      destination: this.toView(created),
      ...(await this.instructions(code, bot)),
    };
  }

  /** Issues a fresh code. The only way back to ACTIVE after revoke/expiry/disconnect is a new admin /authorize. */
  async restartVerification(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'destination:manage');
    const dest = await this.requireDestination(actor.orgId, id);
    if (dest.authorizationStatus === DestinationAuthStatus.ACTIVE) {
      throw new BadRequestException('Destination is already authorized');
    }
    // A chat whose bot is gone cannot be authorized: say so now rather than issue a code nobody can use.
    const bot = await this.bots.handleFor(actor.orgId, dest.botId);
    const { code, hash } = this.newVerificationCode();
    const updated = await this.repo.setDestinationAuthorization(
      actor.orgId,
      id,
      {
        authorizationStatus: DestinationAuthStatus.PENDING_VERIFICATION,
        verificationCodeHash: hash,
        verificationExpiresAt: new Date(Date.now() + 72 * 3600 * 1000),
      }
    );
    await this.access.audit(actor, {
      action: 'destination.verification_restarted',
      entityType: 'TelegramDestination',
      entityId: id,
      summary: `New authorization code issued (was ${dest.authorizationStatus})`,
    });
    return {
      destination: this.toView(updated!),
      ...(await this.instructions(code, bot)),
    };
  }

  async updateSettings(
    actor: AgencyActor,
    id: string,
    dto: UpdateTelegramDestinationDto
  ) {
    this.access.assert(actor, 'destination:manage');
    await this.requireDestination(actor.orgId, id);
    this.assertSettings(dto);
    const updated = await this.repo.updateTelegramDestinationSettings(
      actor.orgId,
      id,
      {
        ...dto,
      }
    );
    await this.access.audit(actor, {
      action: 'destination.settings_updated',
      entityType: 'TelegramDestination',
      entityId: id,
    });
    return this.toView(updated!);
  }

  // ==========================================
  // LIFECYCLE ACTIONS
  // ==========================================
  async suspend(actor: AgencyActor, id: string, reason?: string) {
    this.access.assert(actor, 'destination:manage');
    const dest = await this.requireDestination(actor.orgId, id);
    if (dest.authorizationStatus !== DestinationAuthStatus.ACTIVE) {
      throw new BadRequestException(
        'Only an active destination can be suspended'
      );
    }
    await this.publishing.handleDestinationUnavailable(
      actor.orgId,
      id,
      'SUSPENDED',
      reason || 'Suspended by agency staff',
      actor
    );
    return this.toView(
      (await this.repo.getTelegramDestinationById(actor.orgId, id))!
    );
  }

  /** Resumes a suspended destination, but only if consent is still valid and the bot can still post. */
  async resume(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'destination:manage');
    const dest = await this.requireDestination(actor.orgId, id);
    if (dest.authorizationStatus !== DestinationAuthStatus.SUSPENDED) {
      throw new BadRequestException(
        'Only a suspended destination can be resumed; others need a new authorization'
      );
    }
    if (
      !dest.consentGrantedAt ||
      (dest.consentExpiresAt && dest.consentExpiresAt <= new Date())
    ) {
      throw new BadRequestException(
        'Consent has expired; restart verification'
      );
    }
    const perms = await this.bots
      .handleFor(actor.orgId, dest.botId)
      .then((bot) => bot.gateway.getBotPermissions(dest.chatId))
      .catch((e) => {
        throw new BadRequestException(this.describeError(e));
      });
    if (!perms.isAdmin || !perms.canPostMessages) {
      throw new BadRequestException(
        'The bot is no longer an administrator with permission to post'
      );
    }
    await this.repo.setDestinationAuthorization(actor.orgId, id, {
      authorizationStatus: DestinationAuthStatus.ACTIVE,
      revokedReason: null,
      lastError: null,
      canPostMessages: perms.canPostMessages,
      canDeleteMessages: perms.canDeleteMessages,
      canInviteUsers: perms.canInviteUsers,
    });
    const resumed = await this.publishing.unblockForDestination(
      actor.orgId,
      id
    );
    await this.access.audit(actor, {
      action: 'destination.resumed',
      entityType: 'TelegramDestination',
      entityId: id,
      summary: `Resumed; ${resumed} queued post(s) re-queued`,
    });
    return this.toView(
      (await this.repo.getTelegramDestinationById(actor.orgId, id))!
    );
  }

  async revoke(actor: AgencyActor, id: string, reason?: string) {
    this.access.assert(actor, 'destination:manage');
    await this.requireDestination(actor.orgId, id);
    await this.publishing.handleDestinationUnavailable(
      actor.orgId,
      id,
      'REVOKED',
      reason || 'Consent revoked',
      actor
    );
    return this.toView(
      (await this.repo.getTelegramDestinationById(actor.orgId, id))!
    );
  }

  async remove(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'destination:manage');
    const dest = await this.requireDestination(actor.orgId, id);
    if (dest.authorizationStatus === DestinationAuthStatus.ACTIVE) {
      await this.publishing.handleDestinationUnavailable(
        actor.orgId,
        id,
        'REVOKED',
        'Destination removed',
        actor
      );
    }
    await this.repo.deleteTelegramDestination(actor.orgId, id);
    await this.access.audit(actor, {
      action: 'destination.removed',
      entityType: 'TelegramDestination',
      entityId: id,
      summary: `Removed "${dest.title}"`,
    });
    return { removed: true };
  }

  /** Live re-check. An ACTIVE destination the bot can no longer post to is taken out of service. */
  async refreshHealth(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'destination:manage');
    const dest = await this.requireDestination(actor.orgId, id);
    try {
      const bot = await this.bots.handleFor(actor.orgId, dest.botId);
      const perms = await bot.gateway.getBotPermissions(dest.chatId);
      if (
        dest.authorizationStatus === DestinationAuthStatus.ACTIVE &&
        (!perms.isAdmin || !perms.canPostMessages)
      ) {
        await this.publishing.handleDestinationUnavailable(
          actor.orgId,
          id,
          'DISCONNECTED',
          'Bot is no longer an administrator with permission to post',
          actor
        );
      } else {
        await this.repo.setDestinationAuthorization(actor.orgId, id, {
          authorizationStatus: dest.authorizationStatus,
          canPostMessages: perms.canPostMessages,
          canDeleteMessages: perms.canDeleteMessages,
          canInviteUsers: perms.canInviteUsers,
        });
      }
    } catch (err) {
      if (
        dest.authorizationStatus === DestinationAuthStatus.ACTIVE &&
        this.isLostAccess(err)
      ) {
        await this.publishing.handleDestinationUnavailable(
          actor.orgId,
          id,
          'DISCONNECTED',
          this.describeError(err),
          actor
        );
      } else {
        await this.repo.recordDestinationError(
          actor.orgId,
          id,
          this.describeError(err)
        );
      }
    }
    return this.toView(
      (await this.repo.getTelegramDestinationById(actor.orgId, id))!
    );
  }

  // ==========================================
  // BOTS: what happens to their chats
  // ==========================================
  /** Resuming a bot sends its authorized chats' paused posts on their way again. */
  async setBotEnabled(actor: AgencyActor, id: string, enabled: boolean) {
    const bot = await this.bots.setEnabled(actor, id, enabled);
    if (bot.status === 'ACTIVE') {
      for (const d of await this.repo.getDestinationsOfBot(actor.orgId, id)) {
        if (d.authorizationStatus === DestinationAuthStatus.ACTIVE) {
          await this.publishing.unblockForDestination(actor.orgId, d.id);
        }
      }
    }
    return bot;
  }

  /**
   * Removing a bot wipes its token and takes every chat it served out of service, with queued posts
   * paused and a reason shown. A chat is never silently handed to a different bot.
   */
  async removeBot(actor: AgencyActor, id: string) {
    const chats = (
      await this.repo.getDestinationsOfBot(actor.orgId, id)
    ).filter((d) => d.authorizationStatus !== DestinationAuthStatus.REVOKED);
    const result = await this.bots.delete(actor, id);
    for (const d of chats) {
      await this.publishing.handleDestinationUnavailable(
        actor.orgId,
        d.id,
        'DISCONNECTED',
        'Its bot was removed',
        actor
      );
    }
    return { ...result, chatsStopped: chats.length };
  }

  // ==========================================
  // INBOUND TELEGRAM UPDATES (webhook or polling) — must never throw
  // ==========================================
  /**
   * `bot` is the bot that received the update: it alone may act on it, and it answers in the chat.
   * Without one the update came by the webhook, which only the server's bot has.
   */
  async handleUpdate(
    update: TelegramInboundUpdate,
    receiver?: BotHandle
  ): Promise<void> {
    try {
      const bot = receiver ?? (await this.bots.handleFor('', null));
      if (update.my_chat_member) {
        await this.onBotMembershipChanged(update.my_chat_member, bot);
        return;
      }
      const msg = update.message ?? update.channel_post;
      if (!msg?.text) return;
      const text = msg.text.trim();
      const authorize = AUTHORIZE_RE.exec(text);
      if (authorize) {
        await this.onAuthorizeCommand(msg, authorize[1].toUpperCase(), bot);
      } else if (REVOKE_RE.test(text)) {
        await this.onRevokeCommand(msg, bot);
      }
    } catch (err: any) {
      this.logger.error(
        `Telegram update ${update?.update_id} failed: ${err?.message}`
      );
    }
  }

  private async onAuthorizeCommand(
    msg: NonNullable<TelegramInboundUpdate['message']>,
    code: string,
    bot: BotHandle
  ) {
    const chatId = String(msg.chat.id);
    const refs = [
      chatId,
      ...(msg.chat.username ? [`@${msg.chat.username.toLowerCase()}`] : []),
    ];
    const candidates = (
      await Promise.all(
        refs.map((r) =>
          this.repo.getDestinationsPendingVerification(r, new Date(), bot.id)
        )
      )
    ).flat();
    const hash = this.hashCode(code);
    const dest = candidates.find(
      (c) =>
        c.verificationCodeHash && this.safeEqual(c.verificationCodeHash, hash)
    );
    // Unknown, expired or already-used code: say nothing, so codes cannot be probed.
    if (!dest) return;

    const isChannelPost = !msg.from && !!msg.sender_chat;
    const fromId = msg.from?.id;
    let authorizerName: string | null = null;
    let authorizerId: string | null = null;
    if (isChannelPost) {
      // Only channel administrators can post in a channel: the post itself is the proof.
      authorizerName =
        msg.author_signature ||
        msg.sender_chat?.title ||
        'channel administrator';
    } else if (
      fromId === GROUP_ANONYMOUS_BOT_ID &&
      msg.sender_chat?.id === msg.chat.id
    ) {
      // An administrator posting anonymously as the group.
      authorizerName = msg.author_signature || 'anonymous group administrator';
    } else if (fromId && !msg.from?.is_bot) {
      if (!(await bot.gateway.isChatAdmin(chatId, fromId))) {
        await this.notice(
          bot,
          chatId,
          'Only a group administrator can authorize advertising here.'
        );
        return;
      }
      authorizerId = String(fromId);
      authorizerName =
        [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') ||
        msg.from?.username ||
        null;
    } else {
      return;
    }

    const perms = await bot.gateway.getBotPermissions(chatId);
    if (!perms.isAdmin || !perms.canPostMessages) {
      await this.notice(
        bot,
        chatId,
        'Please make me an administrator with permission to post messages, then send the command again.'
      );
      return;
    }
    const orgName = await this.repo.getOrganizationName(dest.orgId);
    const now = new Date();
    const expires = new Date(
      now.getTime() + this.consentValidDays * 24 * 3600 * 1000
    );
    await this.repo.setDestinationAuthorization(dest.orgId, dest.id, {
      authorizationStatus: DestinationAuthStatus.ACTIVE,
      verificationCodeHash: null,
      verificationExpiresAt: null,
      consentGrantedAt: now,
      consentExpiresAt: expires,
      consentedByTelegramId: authorizerId,
      consentedByName: authorizerName,
      consentRevokedAt: null,
      revokedReason: null,
      lastError: null,
      canPostMessages: perms.canPostMessages,
      canDeleteMessages: perms.canDeleteMessages,
      canInviteUsers: perms.canInviteUsers,
      title: msg.chat.title || dest.title,
      type: msg.chat.type,
    });
    // Inbound refs may have been an @username; from here on the numeric id is canonical.
    if (dest.chatId !== chatId) {
      await this.repo.setDestinationChatId(dest.orgId, dest.id, chatId);
    }
    await this.access.audit(null, {
      orgId: dest.orgId,
      action: 'destination.authorized',
      entityType: 'TelegramDestination',
      entityId: dest.id,
      summary: `Authorized by ${authorizerName ?? 'a chat administrator'}`,
      metadata: {
        telegramUserId: authorizerId,
        consentExpiresAt: expires.toISOString(),
      } as Prisma.InputJsonValue,
    });
    await this.publishing.unblockForDestination(dest.orgId, dest.id);
    await this.notice(
      bot,
      chatId,
      `✅ ${orgName} is now authorized to publish advertising posts in this chat until ${expires
        .toISOString()
        .slice(
          0,
          10
        )}. Any administrator can stop this at any time by sending /revoke or removing the bot.`
    );
  }

  /** A chat administrator can withdraw consent for every agency using this chat, without anyone's cooperation. */
  private async onRevokeCommand(
    msg: NonNullable<TelegramInboundUpdate['message']>,
    bot: BotHandle
  ) {
    const chatId = String(msg.chat.id);
    const isChannelPost = !msg.from && !!msg.sender_chat;
    if (!isChannelPost) {
      const fromId = msg.from?.id;
      const anonymousAdmin =
        fromId === GROUP_ANONYMOUS_BOT_ID &&
        msg.sender_chat?.id === msg.chat.id;
      if (
        !anonymousAdmin &&
        (!fromId ||
          msg.from?.is_bot ||
          !(await bot.gateway.isChatAdmin(chatId, fromId)))
      ) {
        return;
      }
    }
    const rows = await this.repo.getTelegramDestinationsByChatAcrossOrgs(
      chatId
    );
    const live = rows.filter(
      (r) => r.authorizationStatus === DestinationAuthStatus.ACTIVE
    );
    for (const r of live) {
      await this.publishing.handleDestinationUnavailable(
        r.orgId,
        r.id,
        'REVOKED',
        'Revoked by a chat administrator'
      );
    }
    await this.notice(
      bot,
      chatId,
      live.length
        ? '🛑 Advertising authorization revoked. No further ads will be posted here.'
        : 'No active advertising authorization exists for this chat.'
    );
  }

  private async onBotMembershipChanged(
    change: NonNullable<TelegramInboundUpdate['my_chat_member']>,
    bot: BotHandle
  ) {
    const status = change.new_chat_member?.status;
    const can = (change.new_chat_member as any)?.can_post_messages;
    const lost =
      status === 'left' ||
      status === 'kicked' ||
      status === 'restricted' ||
      (status === 'member' && change.chat.type === 'channel') ||
      (status === 'administrator' &&
        change.chat.type === 'channel' &&
        can === false);
    if (!lost) return;
    // This bot lost its place; chats served by another bot are not affected.
    const rows = await this.repo.getTelegramDestinationsOfBotByChat(
      String(change.chat.id),
      bot.id
    );
    for (const r of rows.filter(
      (x) => x.authorizationStatus === DestinationAuthStatus.ACTIVE
    )) {
      await this.publishing.handleDestinationUnavailable(
        r.orgId,
        r.id,
        'DISCONNECTED',
        `Bot membership changed (${status})`
      );
    }
  }

  /** Daily-ish sweep: consent has a lifetime, and an expired one stops posting by itself. */
  async expireConsents(): Promise<number> {
    const due = await this.repo.getDestinationsWithExpiredConsent(new Date());
    for (const d of due) {
      await this.publishing.handleDestinationUnavailable(
        d.orgId,
        d.id,
        'EXPIRED',
        'Posting consent expired'
      );
    }
    return due.length;
  }

  // ==========================================
  // UPDATE TRANSPORT
  // ==========================================
  /** Long-polls one bot once. Only the lease holder polls a bot, so processes never fight over getUpdates. */
  async pollUpdatesOnce(bot: BotHandle, timeoutSeconds = 20): Promise<number> {
    const lease = AgencyTelegramBotsService.leaseName(bot);
    const leader = await this.jobs.acquireLease(
      lease,
      this.holderId,
      (timeoutSeconds + 40) * 1000
    );
    if (!leader) return 0;
    try {
      const updates = await bot.gateway.getUpdates(
        this.updateOffsets.get(lease),
        timeoutSeconds
      );
      for (const u of updates) {
        await this.handleUpdate(u, bot);
        this.updateOffsets.set(lease, u.update_id + 1);
      }
      return updates.length;
    } catch (err) {
      if (
        err instanceof TelegramGatewayError &&
        err.kind === 'UNKNOWN' &&
        /webhook/i.test(err.message)
      ) {
        this.logger.warn(
          `The webhook of "${bot.label}" is active; polling is disabled for it`
        );
      } else {
        this.logger.warn(
          `Telegram polling for "${bot.label}" failed: ${
            (err as Error)?.message
          }`
        );
        // Telegram refusing the token is permanent until a new one is given: stop asking.
        if (
          err instanceof TelegramGatewayError &&
          err.kind === 'UNCONFIGURED'
        ) {
          await this.bots.markRejected(bot, err.message).catch(() => undefined);
        }
      }
      return 0;
    }
  }

  // ==========================================
  // HELPERS
  // ==========================================
  private async requireDestination(
    orgId: string,
    id: string
  ): Promise<DestinationRow> {
    const dest = await this.repo.getTelegramDestinationById(orgId, id);
    if (!dest) throw new NotFoundException('Destination not found');
    return dest;
  }

  private normalizeRef(ref: string): string {
    const trimmed = ref.trim();
    return trimmed.startsWith('@') ? trimmed.toLowerCase() : trimmed;
  }

  private newVerificationCode() {
    const bytes = randomBytes(8);
    let body = '';
    for (const b of bytes) body += CODE_ALPHABET[b % CODE_ALPHABET.length];
    const code = `AOS-${body}`;
    return { code, hash: this.hashCode(code) };
  }

  private hashCode(code: string) {
    return createHash('sha256').update(code.toUpperCase()).digest('hex');
  }

  private safeEqual(a: string, b: string) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }

  private async usernameOf(bot: BotHandle): Promise<string | null> {
    if (bot.username) return bot.username;
    return bot.gateway.getBotInfo().then(
      (b) => b.username,
      () => null
    );
  }

  private async instructions(code: string, bot: BotHandle) {
    const botUsername = await this.usernameOf(bot);
    return {
      verificationCode: code,
      botUsername,
      steps: [
        botUsername
          ? `Add @${botUsername} to the group/channel as an administrator with permission to post messages.`
          : 'Add the AgencyOS bot to the group/channel as an administrator with permission to post messages.',
        `A group/channel administrator sends this message inside the chat: /authorize ${code}`,
        'The destination turns active as soon as the bot confirms. The code is valid for 72 hours and works once.',
      ],
    };
  }

  /** Never exposes verification secrets; derives what the UI needs to guide the next step. */
  private toView<T extends { verificationCodeHash?: string | null }>(row: T) {
    const { verificationCodeHash, ...safe } = row;
    return { ...safe, hasPendingVerification: !!verificationCodeHash };
  }

  private assertSettings(dto: {
    timezone?: string;
    postingFrequencyRules?: string;
    allowedPostingWindows?: string;
    permittedCategories?: string;
  }) {
    if (dto.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: dto.timezone });
      } catch {
        throw new BadRequestException(`Unknown time zone "${dto.timezone}"`);
      }
    }
    const json = (label: string, raw?: string) => {
      if (!raw) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        throw new BadRequestException(`${label} must be valid JSON`);
      }
    };
    const windows = json('Allowed posting windows', dto.allowedPostingWindows);
    if (
      windows !== undefined &&
      (!Array.isArray(windows) ||
        windows.some(
          (w) =>
            !/^\d{2}:\d{2}$/.test(w?.start) || !/^\d{2}:\d{2}$/.test(w?.end)
        ))
    ) {
      throw new BadRequestException(
        'Posting windows must look like [{"days":[1,2,3],"start":"09:00","end":"18:00"}]'
      );
    }
    const rules = json('Posting frequency rules', dto.postingFrequencyRules);
    if (
      rules !== undefined &&
      (typeof rules !== 'object' || Array.isArray(rules) || rules === null)
    ) {
      throw new BadRequestException(
        'Frequency rules must look like {"maxPerDay":3,"minIntervalMinutes":60}'
      );
    }
    json('Permitted categories', dto.permittedCategories);
  }

  private isLostAccess(err: unknown) {
    const kind = (err as TelegramGatewayError)?.kind;
    return (
      kind === 'FORBIDDEN' ||
      kind === 'CHAT_NOT_FOUND' ||
      kind === 'CHAT_MIGRATED'
    );
  }

  private describeError(err: unknown) {
    return (err as Error)?.message || 'Telegram request failed';
  }

  private unavailable(error: string) {
    return {
      valid: false,
      title: '',
      type: '',
      botIsAdmin: false,
      canPostMessages: false,
      canDeleteMessages: false,
      canInviteUsers: false,
      error,
    };
  }

  private async notice(bot: BotHandle, chatId: string, text: string) {
    try {
      await bot.gateway.sendNotice(chatId, text);
    } catch (err: any) {
      this.logger.warn(`Could not reply in chat ${chatId}: ${err?.message}`);
    }
  }
}
