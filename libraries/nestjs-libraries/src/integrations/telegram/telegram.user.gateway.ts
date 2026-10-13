import { Injectable } from '@nestjs/common';
import { extname } from 'path';
import { randomBytes } from 'crypto';
import { TelegramAd, TelegramGateway } from './telegram.gateway';

/**
 * The one boundary to Telegram *user accounts* (MTProto). The Python worker in apps/telegram-worker
 * does the talking; this class only speaks the loopback contract in docs/TELEGRAM_WORKER_CONTRACT.md.
 * Nothing else calls the worker, and the Bot API gateway next to this one is untouched.
 */
export type UserGatewayErrorCode =
  | 'SESSION_INVALID'
  | 'PHONE_INVALID'
  | 'CODE_INVALID'
  | 'CODE_EXPIRED'
  | 'PASSWORD_REQUIRED'
  | 'PASSWORD_INVALID'
  | 'LOGIN_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'ACCOUNT_RESTRICTED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'PRIVATE'
  | 'INVALID_REF'
  | 'NETWORK'
  | 'OUTCOME_UNKNOWN'
  | 'UNSUPPORTED'
  | 'UNKNOWN'
  | 'BAD_REQUEST'
  // Ours, not Telegram's: the worker is not set up, not running, or does not accept our token.
  | 'WORKER_UNAVAILABLE'
  | 'WORKER_AUTH'
  | 'WORKER_PROTOCOL';

export class TelegramUserGatewayError extends Error {
  constructor(
    public readonly code: UserGatewayErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'TelegramUserGatewayError';
  }
}

/** What the worker needs to act as one account for one request. Never stored in the clear. */
export interface UserAccountCredentials {
  apiId: number;
  apiHash: string;
  session: string;
}

export interface UserGatewayMe {
  id: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  premium: boolean;
  phoneMasked: string;
}

export type UserGatewayRelation =
  | 'OWNED'
  | 'ADMINISTERED'
  | 'MEMBER'
  | 'PUBLIC_NOT_JOINED'
  | 'RESTRICTED'
  | 'UNAVAILABLE';

export interface UserGatewayCommunity {
  /** Null when Telegram gives none (a preview of an invite link to a community not joined). */
  telegramId: string | null;
  kind: 'GROUP' | 'SUPERGROUP' | 'CHANNEL' | 'BROADCAST_CHANNEL';
  title: string;
  username: string | null;
  link: string | null;
  description: string | null;
  memberCount: number | null;
  verified: boolean;
  scam: boolean;
  fake: boolean;
  joinRequestRequired: boolean;
  slowModeSeconds: number | null;
  hasLinkedChat: boolean;
  restrictionReasons: string[];
}

export interface UserGatewayCanPost {
  sendMessages: boolean;
  sendMedia: boolean;
  isAdmin: boolean;
  postMessagesInChannel: boolean;
  slowModeSeconds: number | null;
}

export interface UserGatewayResolved {
  community: UserGatewayCommunity;
  relation: UserGatewayRelation;
  canPost: UserGatewayCanPost | null;
}

export interface UserGatewayWorkerAd {
  html: string;
  media: Array<{ path: string; kind: 'photo' | 'video' }>;
  buttonText?: string;
  buttonUrl?: string;
}

export interface UserGatewaySendResult {
  messageIds: string[];
  primaryMessageId: string;
  releaseUrl: string | null;
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm']);

@Injectable()
export class TelegramUserGateway {
  /** Where the supervised worker listens; empty means user accounts are not set up on this install. */
  protected baseUrl(): string {
    return (process.env.AGENCYOS_TELEGRAM_WORKER_URL || '').replace(/\/$/, '');
  }

  protected token(): string {
    return process.env.AGENCYOS_TELEGRAM_WORKER_TOKEN || '';
  }

  isConfigured(): boolean {
    return !!this.baseUrl() && !!this.token();
  }

  /**
   * One request to the worker. Telegram-side failures come back as `{ok:false, error}` and are
   * thrown as TelegramUserGatewayError with the worker's code; a worker that is down, or does not
   * take our token, is reported as ours (WORKER_*) so it is never mistaken for a Telegram refusal.
   */
  protected async post<T>(
    path: string,
    body: Record<string, unknown>,
    options: {
      timeoutMs?: number;
      correlationId?: string;
      /** A send: not hearing back is not "it failed", it may have been delivered. */
      ambiguousOnTimeout?: boolean;
    } = {}
  ): Promise<T> {
    if (!this.isConfigured()) {
      throw new TelegramUserGatewayError(
        'WORKER_UNAVAILABLE',
        'Telegram user accounts are not set up on this computer'
      );
    }
    const correlationId =
      options.correlationId ?? randomBytes(8).toString('hex');
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AgencyOS-Worker-Token': this.token(),
          'X-Correlation-Id': correlationId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (err: any) {
      const timedOut =
        err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new TelegramUserGatewayError(
        timedOut
          ? options.ambiguousOnTimeout
            ? 'OUTCOME_UNKNOWN'
            : 'NETWORK'
          : 'WORKER_UNAVAILABLE',
        timedOut
          ? 'The Telegram worker did not answer in time'
          : 'The Telegram worker is not running'
      );
    }
    if (res.status === 401) {
      throw new TelegramUserGatewayError(
        'WORKER_AUTH',
        'The Telegram worker did not accept this install’s token'
      );
    }
    let json: any;
    try {
      json = await res.json();
    } catch {
      throw new TelegramUserGatewayError(
        'WORKER_PROTOCOL',
        `The Telegram worker sent something unreadable (HTTP ${res.status})`
      );
    }
    if (json?.ok === true) return json as T;
    const error = json?.error;
    if (error && typeof error.code === 'string') {
      throw new TelegramUserGatewayError(
        error.code as UserGatewayErrorCode,
        String(error.message ?? error.code),
        typeof error.retryAfterSeconds === 'number'
          ? error.retryAfterSeconds
          : undefined
      );
    }
    throw new TelegramUserGatewayError(
      'WORKER_PROTOCOL',
      `The Telegram worker answered HTTP ${res.status} in an unknown shape`
    );
  }

  health() {
    // The only call without a token: whether anything is listening at all.
    return this.getHealth();
  }

  protected async getHealth(): Promise<{
    ok: boolean;
    version?: string;
    telethon?: string;
    uptimeSeconds?: number;
  }> {
    if (!this.baseUrl()) return { ok: false };
    try {
      const res = await fetch(`${this.baseUrl()}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      return res.ok ? await res.json() : { ok: false };
    } catch {
      return { ok: false };
    }
  }

  // ---- Login ---------------------------------------------------------------
  loginStart(input: { apiId: number; apiHash: string; phone: string }) {
    return this.post<{
      loginId: string;
      codeDelivery: string;
      timeoutSeconds: number;
    }>('/v1/login/start', input);
  }

  loginCode(input: { loginId: string; code: string }) {
    return this.post<
      | { status: 'authorized'; session: string; me: UserGatewayMe }
      | { status: 'password_required' }
    >('/v1/login/code', input);
  }

  loginPassword(input: { loginId: string; password: string }) {
    return this.post<{
      status: 'authorized';
      session: string;
      me: UserGatewayMe;
    }>('/v1/login/password', input);
  }

  loginCancel(loginId: string) {
    return this.post<{ cancelled: boolean }>('/v1/login/cancel', { loginId });
  }

  // ---- Account -------------------------------------------------------------
  accountStatus(account: UserAccountCredentials) {
    return this.post<
      { authorized: true; me: UserGatewayMe } | { authorized: false }
    >('/v1/account/status', { account });
  }

  accountLogout(account: UserAccountCredentials) {
    return this.post<{ loggedOut: boolean }>('/v1/account/logout', {
      account,
    });
  }

  // ---- Communities ---------------------------------------------------------
  searchCommunities(
    account: UserAccountCredentials,
    query: string,
    limit: number
  ) {
    return this.post<{ results: UserGatewayCommunity[] }>(
      '/v1/communities/search',
      { account, query, limit }
    );
  }

  resolveCommunity(account: UserAccountCredentials, ref: string) {
    return this.post<UserGatewayResolved>('/v1/communities/resolve', {
      account,
      ref,
    });
  }

  refreshCommunities(account: UserAccountCredentials, refs: string[]) {
    return this.post<{
      results: Array<{
        ref: string;
        ok: boolean;
        community?: UserGatewayCommunity;
        relation?: UserGatewayRelation;
        error?: { code: UserGatewayErrorCode; message: string };
      }>;
    }>('/v1/communities/refresh', { account, refs }, { timeoutMs: 60_000 });
  }

  communityMessages(
    account: UserAccountCredentials,
    ref: string,
    limit: number
  ) {
    return this.post<{
      messages: Array<{
        id: string;
        date: string;
        text: string;
        views?: number | null;
      }>;
    }>('/v1/communities/messages', { account, ref, limit });
  }

  myCommunities(account: UserAccountCredentials, limit: number) {
    return this.post<{
      communities: Array<{
        community: UserGatewayCommunity;
        relation: UserGatewayRelation;
      }>;
    }>('/v1/communities/mine', { account, limit }, { timeoutMs: 60_000 });
  }

  communityPermissions(account: UserAccountCredentials, ref: string) {
    return this.post<{
      relation: UserGatewayRelation;
      canPost: UserGatewayCanPost | null;
    }>('/v1/communities/permissions', { account, ref });
  }

  joinCommunity(account: UserAccountCredentials, ref: string) {
    return this.post<{
      status: 'JOINED' | 'JOIN_REQUEST_PENDING';
      community: UserGatewayCommunity;
    }>('/v1/communities/join', { account, ref });
  }

  leaveCommunity(account: UserAccountCredentials, ref: string) {
    return this.post<{ left: boolean }>('/v1/communities/leave', {
      account,
      ref,
    });
  }

  createCommunity(
    account: UserAccountCredentials,
    input: {
      kind: 'group' | 'channel';
      title: string;
      about?: string;
      username?: string;
    }
  ) {
    return this.post<{
      community: UserGatewayCommunity;
      inviteLink?: string;
    }>('/v1/communities/create', { account, ...input });
  }

  updateCommunity(
    account: UserAccountCredentials,
    ref: string,
    input: { title?: string; about?: string }
  ) {
    return this.post<{ community: UserGatewayCommunity }>(
      '/v1/communities/update',
      { account, ref, ...input }
    );
  }

  inviteLink(account: UserAccountCredentials, ref: string) {
    return this.post<{ link: string }>('/v1/communities/invite-link', {
      account,
      ref,
    });
  }

  joinRequests(account: UserAccountCredentials, ref: string, limit: number) {
    return this.post<{
      requests: Array<{
        userId: string;
        username?: string | null;
        date: string;
        bio?: string | null;
      }>;
    }>('/v1/communities/join-requests', { account, ref, limit });
  }

  decideJoinRequest(
    account: UserAccountCredentials,
    ref: string,
    userId: string,
    approve: boolean
  ) {
    return this.post<{ decided: boolean }>(
      '/v1/communities/join-requests/decide',
      { account, ref, userId, approve }
    );
  }

  // ---- Sending -------------------------------------------------------------
  sendMessage(
    account: UserAccountCredentials,
    ref: string,
    ad: UserGatewayWorkerAd
  ) {
    return this.post<UserGatewaySendResult>(
      '/v1/messages/send',
      { account, ref, ad },
      { timeoutMs: 120_000, ambiguousOnTimeout: true }
    );
  }

  /**
   * The same text the bot would send (one renderer, so a preview is true for both), plus the files:
   * a user account uploads files itself, so media must be a file AgencyOS holds, never a web address.
   */
  buildWorkerAd(ad: TelegramAd, bot: TelegramGateway): UserGatewayWorkerAd {
    bot.validateAd(ad);
    const media = (ad.media ?? []).map((ref) => {
      const path = bot.resolveLocalMedia(ref);
      if (!path) {
        throw new TelegramUserGatewayError(
          'BAD_REQUEST',
          'Pictures and videos must be uploaded to AgencyOS to be posted from a user account'
        );
      }
      const ext = extname(path).toLowerCase();
      const kind = IMAGE_EXT.has(ext)
        ? ('photo' as const)
        : VIDEO_EXT.has(ext)
        ? ('video' as const)
        : null;
      if (!kind) {
        throw new TelegramUserGatewayError(
          'BAD_REQUEST',
          'A user account can post pictures (jpg, png, webp) and videos (mp4, mov, webm)'
        );
      }
      return { path, kind };
    });
    return { html: bot.renderAdHtml(ad), media };
  }
}
