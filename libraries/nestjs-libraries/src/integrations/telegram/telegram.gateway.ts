import { Injectable } from '@nestjs/common';
import TelegramBot from 'node-telegram-bot-api';
import { createReadStream, existsSync, statSync } from 'fs';
import { extname, resolve, sep } from 'path';

export type TelegramErrorKind =
  | 'UNCONFIGURED'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'
  | 'CHAT_NOT_FOUND'
  | 'CHAT_MIGRATED'
  | 'BAD_REQUEST'
  | 'NETWORK'
  | 'UNKNOWN';

export class TelegramGatewayError extends Error {
  constructor(
    public readonly kind: TelegramErrorKind,
    message: string,
    public readonly retryAfterSeconds?: number,
    // Messages that were already delivered before the failure. When non-empty the
    // outcome is partially applied and a blind retry would duplicate the ad.
    public readonly partialMessageIds: string[] = []
  ) {
    super(message);
    this.name = 'TelegramGatewayError';
  }
}

export interface TelegramAd {
  title?: string | null;
  body: string;
  ctaText?: string | null;
  ctaLink?: string | null;
  channelLink?: string | null;
  media?: string[];
}

export interface TelegramSendResult {
  primaryMessageId: string;
  messageIds: string[];
  releaseUrl?: string;
}

export interface TelegramChatInfo {
  id: string;
  type: string;
  title: string;
  username?: string;
}

export interface BotPermissions {
  isAdmin: boolean;
  canPostMessages: boolean;
  canDeleteMessages: boolean;
  canInviteUsers: boolean;
}

export interface TelegramInboundUpdate {
  update_id: number;
  message?: TelegramBot.Message;
  channel_post?: TelegramBot.Message;
  my_chat_member?: TelegramBot.ChatMemberUpdated;
}

const CAPTION_LIMIT = 1024;
const MESSAGE_LIMIT = 4096;
const MEDIA_GROUP_LIMIT = 10;
const ALLOWED_FORMAT_TAGS: Record<string, string> = {
  b: 'b',
  strong: 'b',
  i: 'i',
  em: 'i',
  u: 'u',
  s: 's',
  code: 'code',
  pre: 'pre',
};
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v']);

/**
 * The only class that talks to the Telegram Bot API for AgencyOS. Controllers and
 * generic services depend on this gateway, never on node-telegram-bot-api, so every
 * Telegram-specific behaviour (HTML safety, limits, error classification) lives here.
 */
@Injectable()
export class TelegramGateway {
  private bot: TelegramBot | null = null;

  private get token(): string | undefined {
    return process.env.AGENCY_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
  }

  isConfigured(): boolean {
    return !!this.token;
  }

  private client(): TelegramBot {
    if (!this.token) {
      throw new TelegramGatewayError(
        'UNCONFIGURED',
        'Telegram bot is not configured (set AGENCY_TELEGRAM_BOT_TOKEN)'
      );
    }
    if (!this.bot) {
      this.bot = new TelegramBot(this.token);
    }
    return this.bot;
  }

  // ------------------------------------------------------------------
  // Read operations
  // ------------------------------------------------------------------
  async getBotInfo(): Promise<{ id: number; username: string }> {
    return this.call(async (bot) => {
      const me = await bot.getMe();
      return { id: me.id, username: me.username || '' };
    });
  }

  async getChat(chatRef: string): Promise<TelegramChatInfo> {
    return this.call(async (bot) => {
      const chat = await bot.getChat(chatRef);
      return {
        id: String(chat.id),
        type: chat.type,
        title: chat.title || chat.username || String(chat.id),
        username: chat.username,
      };
    });
  }

  async getBotPermissions(chatId: string): Promise<BotPermissions> {
    return this.call(async (bot) => {
      const me = await bot.getMe();
      const member = await bot.getChatMember(chatId, me.id);
      const isCreator = member.status === 'creator';
      const isAdmin = isCreator || member.status === 'administrator';
      const chat = await bot.getChat(chatId);
      // In channels posting needs the explicit right; in groups any member may post
      // unless restricted, and administrators may post.
      const canPost =
        isAdmin &&
        (isCreator ||
          chat.type !== 'channel' ||
          member.can_post_messages === true);
      return {
        isAdmin,
        canPostMessages: canPost,
        canDeleteMessages: isAdmin && (isCreator || !!member.can_delete_messages),
        canInviteUsers: isAdmin && (isCreator || !!member.can_invite_users),
      };
    });
  }

  async isChatAdmin(chatId: string, userId: number): Promise<boolean> {
    return this.call(async (bot) => {
      const member = await bot.getChatMember(chatId, userId);
      return member.status === 'creator' || member.status === 'administrator';
    });
  }

  async getUpdates(
    offset: number | undefined,
    timeoutSeconds: number
  ): Promise<TelegramInboundUpdate[]> {
    return this.call(async (bot) => {
      const updates = await bot.getUpdates({
        ...(offset !== undefined ? { offset } : {}),
        timeout: timeoutSeconds,
        allowed_updates: ['message', 'channel_post', 'my_chat_member'],
      });
      return updates as unknown as TelegramInboundUpdate[];
    });
  }

  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.call(async (bot) => {
      await bot.setWebHook(url, {
        secret_token: secretToken,
        allowed_updates: ['message', 'channel_post', 'my_chat_member'],
      } as any);
    });
  }

  async deleteWebhook(): Promise<void> {
    await this.call(async (bot) => {
      await bot.deleteWebHook();
    });
  }

  async sendNotice(chatId: string, text: string): Promise<void> {
    await this.call(async (bot) => {
      await bot.sendMessage(chatId, text);
    });
  }

  // ------------------------------------------------------------------
  // Publishing
  // ------------------------------------------------------------------
  /** Renders the HTML that will be sent, so previews match delivery exactly. */
  renderAdHtml(ad: TelegramAd): string {
    const parts: string[] = [];
    if (ad.title?.trim()) {
      parts.push(`<b>${this.escapeHtml(ad.title.trim())}</b>`);
    }
    parts.push(this.formatBody(ad.body));
    const link = this.safeHttpUrl(ad.ctaLink);
    if (link) {
      const label = ad.ctaText?.trim() || link;
      parts.push(
        `👉 <a href="${this.escapeAttr(link)}">${this.escapeHtml(label)}</a>`
      );
    } else {
      const channel = this.safeHttpUrl(ad.channelLink);
      if (channel) {
        parts.push(
          `📢 <a href="${this.escapeAttr(channel)}">${this.escapeHtml(
            channel
          )}</a>`
        );
      }
    }
    return parts.join('\n\n');
  }

  /** Throws a TelegramGatewayError(BAD_REQUEST) describing the first violated limit. */
  validateAd(ad: TelegramAd): void {
    const html = this.renderAdHtml(ad);
    const media = ad.media || [];
    const visible = this.visibleLength(html);
    if (!ad.body?.trim()) {
      throw new TelegramGatewayError('BAD_REQUEST', 'Advertisement text is empty');
    }
    if (visible > MESSAGE_LIMIT) {
      throw new TelegramGatewayError(
        'BAD_REQUEST',
        `Advertisement is ${visible} characters; Telegram allows ${MESSAGE_LIMIT}`
      );
    }
    if (media.length > MEDIA_GROUP_LIMIT) {
      throw new TelegramGatewayError(
        'BAD_REQUEST',
        `Telegram allows at most ${MEDIA_GROUP_LIMIT} media items per post`
      );
    }
    if (media.length > 1 && media.some((m) => this.mediaKind(m) === 'document')) {
      throw new TelegramGatewayError(
        'BAD_REQUEST',
        'Only images and videos can be combined in one Telegram post'
      );
    }
    for (const m of media) {
      this.assertSupportedMediaRef(m);
    }
  }

  async sendAd(chatId: string, ad: TelegramAd): Promise<TelegramSendResult> {
    this.validateAd(ad);
    const html = this.renderAdHtml(ad);
    const media = ad.media || [];
    const sent: string[] = [];

    try {
      return await this.call(async (bot) => {
        const textFitsCaption = this.visibleLength(html) <= CAPTION_LIMIT;

        if (media.length === 0) {
          const res = await bot.sendMessage(chatId, html, {
            parse_mode: 'HTML',
          });
          sent.push(String(res.message_id));
        } else if (media.length === 1) {
          const res = await this.sendSingleMedia(
            bot,
            chatId,
            media[0],
            textFitsCaption ? html : undefined
          );
          sent.push(String(res.message_id));
          if (!textFitsCaption) {
            const text = await bot.sendMessage(chatId, html, {
              parse_mode: 'HTML',
              reply_to_message_id: res.message_id,
            });
            sent.push(String(text.message_id));
          }
        } else {
          const group = media.map((m, idx) => ({
            type: this.mediaKind(m) === 'video' ? 'video' : 'photo',
            media: this.resolveMedia(m) as string,
            ...(idx === 0 && textFitsCaption
              ? { caption: html, parse_mode: 'HTML' }
              : {}),
          }));
          const res = await bot.sendMediaGroup(chatId, group as any[]);
          for (const m of res) sent.push(String(m.message_id));
          if (!textFitsCaption) {
            const text = await bot.sendMessage(chatId, html, {
              parse_mode: 'HTML',
              reply_to_message_id: res[0].message_id,
            });
            sent.push(String(text.message_id));
          }
        }

        return {
          primaryMessageId: sent[0],
          messageIds: sent,
          releaseUrl: await this.buildReleaseUrl(bot, chatId, sent[0]),
        };
      });
    } catch (err) {
      if (err instanceof TelegramGatewayError && sent.length > 0) {
        // Part of the ad is already live: surface that so the caller never blindly
        // retries and posts it twice.
        throw new TelegramGatewayError(
          err.kind,
          err.message,
          err.retryAfterSeconds,
          sent
        );
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------
  private async sendSingleMedia(
    bot: TelegramBot,
    chatId: string,
    mediaRef: string,
    caption?: string
  ): Promise<TelegramBot.Message> {
    const source = this.resolveMedia(mediaRef);
    const options = caption
      ? { caption, parse_mode: 'HTML' as const }
      : undefined;
    const kind = this.mediaKind(mediaRef);
    if (kind === 'video') return bot.sendVideo(chatId, source, options);
    if (kind === 'animation') return bot.sendAnimation(chatId, source, options);
    if (kind === 'photo') return bot.sendPhoto(chatId, source, options);
    return bot.sendDocument(chatId, source, options);
  }

  private mediaKind(ref: string): 'photo' | 'video' | 'animation' | 'document' {
    const ext = extname(ref.split('?')[0]).toLowerCase();
    if (ext === '.gif') return 'animation';
    if (IMAGE_EXT.has(ext)) return 'photo';
    if (VIDEO_EXT.has(ext)) return 'video';
    return 'document';
  }

  private assertSupportedMediaRef(ref: string): void {
    if (this.localUploadPath(ref)) return;
    if (!this.safeHttpUrl(ref)) {
      throw new TelegramGatewayError(
        'BAD_REQUEST',
        'Media must be an uploaded file or an http(s) URL'
      );
    }
  }

  /**
   * Uploaded media is served from UPLOAD_DIRECTORY on this machine, which Telegram
   * cannot reach on localhost deployments, so those are streamed to Telegram. Any
   * other http(s) URL is passed through for Telegram to fetch itself.
   */
  private resolveMedia(ref: string): string | NodeJS.ReadableStream {
    const local = this.localUploadPath(ref);
    if (local) {
      return createReadStream(local);
    }
    const url = this.safeHttpUrl(ref);
    if (!url) {
      throw new TelegramGatewayError(
        'BAD_REQUEST',
        'Media must be an uploaded file or an http(s) URL'
      );
    }
    return url;
  }

  private localUploadPath(ref: string): string | null {
    const uploadDir = process.env.UPLOAD_DIRECTORY;
    if (!uploadDir) return null;
    const frontend = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
    let relative: string | null = null;
    if (frontend && ref.startsWith(`${frontend}/uploads/`)) {
      relative = ref.slice(`${frontend}/uploads/`.length);
    } else if (ref.startsWith('/uploads/')) {
      relative = ref.slice('/uploads/'.length);
    }
    if (relative === null) return null;
    const base = resolve(uploadDir);
    let decoded: string;
    try {
      decoded = decodeURIComponent(relative.split('?')[0]);
    } catch {
      return null;
    }
    const file = resolve(base, decoded);
    // Confine reads to UPLOAD_DIRECTORY; resolve() collapses any `..` segments.
    if (!file.startsWith(base + sep)) return null;
    return existsSync(file) && statSync(file).isFile() ? file : null;
  }

  private async buildReleaseUrl(
    bot: TelegramBot,
    chatId: string,
    messageId: string
  ): Promise<string | undefined> {
    try {
      const chat = await bot.getChat(chatId);
      if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
    } catch {
      // Falls through to the private-chat form below.
    }
    return chatId.startsWith('-100')
      ? `https://t.me/c/${chatId.slice(4)}/${messageId}`
      : undefined;
  }

  escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private escapeAttr(value: string): string {
    return this.escapeHtml(value).replace(/"/g, '&quot;');
  }

  /**
   * Escapes everything, then restores a strict allowlist of attribute-less
   * formatting tags. Unbalanced tags would make Telegram reject the whole post, so
   * in that case the text is sent fully escaped instead.
   */
  private formatBody(raw: string): string {
    const escaped = this.escapeHtml(raw.trim());
    const stack: string[] = [];
    let balanced = true;
    const restored = escaped.replace(
      /&lt;(\/?)([a-z]+)&gt;/gi,
      (match, slash: string, name: string) => {
        const tag = ALLOWED_FORMAT_TAGS[name.toLowerCase()];
        if (!tag) return match;
        if (slash) {
          if (stack.pop() !== tag) balanced = false;
          return `</${tag}>`;
        }
        stack.push(tag);
        return `<${tag}>`;
      }
    );
    return balanced && stack.length === 0 ? restored : escaped;
  }

  private safeHttpUrl(value?: string | null): string | null {
    if (!value) return null;
    try {
      const url = new URL(value.trim());
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? url.toString()
        : null;
    } catch {
      return null;
    }
  }

  private visibleLength(html: string): number {
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&').length;
  }

  private async call<T>(fn: (bot: TelegramBot) => Promise<T>): Promise<T> {
    const bot = this.client();
    try {
      return await fn(bot);
    } catch (err) {
      throw this.classify(err);
    }
  }

  classify(err: unknown): TelegramGatewayError {
    if (err instanceof TelegramGatewayError) return err;
    const e = err as any;
    const body = e?.response?.body;
    const code: number | undefined = body?.error_code;
    const description: string = String(body?.description || e?.message || '');
    const lower = description.toLowerCase();

    if (e?.code === 'ETELEGRAM' && code) {
      if (code === 429) {
        return new TelegramGatewayError(
          'RATE_LIMITED',
          description,
          Number(body?.parameters?.retry_after) || 30
        );
      }
      if (code === 401) {
        return new TelegramGatewayError('UNCONFIGURED', 'Telegram bot token was rejected');
      }
      if (code === 403) {
        return new TelegramGatewayError('FORBIDDEN', description);
      }
      if (code === 400) {
        if (body?.parameters?.migrate_to_chat_id) {
          return new TelegramGatewayError(
            'CHAT_MIGRATED',
            'Group was upgraded to a supergroup; register the new chat ID'
          );
        }
        if (lower.includes('chat not found')) {
          return new TelegramGatewayError('CHAT_NOT_FOUND', description);
        }
        if (
          lower.includes('not enough rights') ||
          lower.includes('have no rights') ||
          lower.includes('bot was kicked') ||
          lower.includes('bot is not a member')
        ) {
          return new TelegramGatewayError('FORBIDDEN', description);
        }
        return new TelegramGatewayError('BAD_REQUEST', description);
      }
      if (code >= 500) {
        return new TelegramGatewayError('NETWORK', description);
      }
      return new TelegramGatewayError('UNKNOWN', description);
    }
    if (e?.code === 'EFATAL' || e?.code === 'EPARSE') {
      return new TelegramGatewayError('NETWORK', description);
    }
    return new TelegramGatewayError('UNKNOWN', description || 'Unknown Telegram error');
  }
}
