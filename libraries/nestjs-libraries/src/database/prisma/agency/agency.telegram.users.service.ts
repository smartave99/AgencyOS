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
  hkdfSync,
  randomBytes,
} from 'crypto';
import {
  TelegramAccountEventKind,
  TelegramUserAccount,
  TelegramUserAccountStatus,
} from '@prisma/client';
import { AgencyAccessService, AgencyActor } from './agency.access.service';
import { AgencyTelegramUsersRepository } from './agency.telegram.users.repository';
import {
  TelegramUserGateway,
  TelegramUserGatewayError,
  UserAccountCredentials,
  UserGatewayMe,
} from '@gitroom/nestjs-libraries/integrations/telegram/telegram.user.gateway';

/** What an account may be used for. Research is on for a new account; the rest is granted. */
export type AccountPermission =
  | 'canResearch'
  | 'canJoin'
  | 'canPublish'
  | 'canManage';

const PERMISSION_TEXT: Record<AccountPermission, string> = {
  canResearch: 'look up public communities',
  canJoin: 'join or leave communities',
  canPublish: 'post advertisements',
  canManage: 'create and manage communities',
};

const LOGIN_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_LOGINS = 20;

/** Why an account cannot be used right now. Callers that run jobs read `reason` and stop, never reroute. */
export class TelegramAccountUnusableException extends ConflictException {
  constructor(
    public readonly reason:
      | 'PAUSED'
      | 'LOGGED_OUT'
      | 'SESSION_INVALID'
      | 'RESTRICTED'
      | 'RATE_LIMITED'
      | 'NOT_PERMITTED'
      | 'UNREADABLE',
    message: string,
    public readonly retryAt?: Date
  ) {
    super(message);
  }
}

interface PendingLogin {
  orgId: string;
  userId: string;
  label: string;
  apiId: number;
  apiHash: string;
  expiresAt: number;
}

/**
 * Connects Telegram user accounts (MTProto, through the loopback worker). A person signs in with the
 * code Telegram sends them; the api id, api hash and session are sealed together (AES-256-GCM) and
 * never leave this service. Each account has its own permissions. A restricted, limited or signed-out
 * account is reported and paused: no other account ever takes its place by itself.
 */
@Injectable()
export class AgencyTelegramUsersService {
  private readonly logger = new Logger(AgencyTelegramUsersService.name);
  // Logins are in progress only for minutes and only in this process; nothing about them is stored.
  private readonly pending = new Map<string, PendingLogin>();

  constructor(
    private readonly repo: AgencyTelegramUsersRepository,
    private readonly access: AgencyAccessService,
    private readonly gateway: TelegramUserGateway
  ) {}

  // ==========================================
  // SECRETS (AES-256-GCM, key derived from the install's JWT_SECRET, separate from bot tokens)
  // ==========================================
  private secretKey(): Buffer {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new HttpException(
        'The server has no secret to protect Telegram sign-ins',
        500
      );
    }
    return Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(secret),
        Buffer.from('agencyos-telegram-user-accounts'),
        Buffer.from('user-session-v1'),
        32
      )
    );
  }

  private seal(creds: UserAccountCredentials): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.secretKey(), iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(creds), 'utf8'),
      cipher.final(),
    ]);
    return [
      'v1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      body.toString('base64'),
    ].join('.');
  }

  private open(sealed: string): UserAccountCredentials | null {
    try {
      const [version, iv, tag, body] = sealed.split('.');
      if (version !== 'v1') return null;
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.secretKey(),
        Buffer.from(iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      const parsed = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(body, 'base64')),
          decipher.final(),
        ]).toString('utf8')
      );
      return typeof parsed?.apiId === 'number' &&
        typeof parsed?.apiHash === 'string' &&
        typeof parsed?.session === 'string'
        ? parsed
        : null;
    } catch {
      // A different install secret or a damaged value: the account has to be signed in again.
      return null;
    }
  }

  // ==========================================
  // WHAT THE SCREENS SEE (never the sealed value, never a full phone number)
  // ==========================================
  private view(
    a: TelegramUserAccount & {
      destinationCount?: number;
      communityCount?: number;
    }
  ) {
    return {
      id: a.id,
      label: a.label,
      username: a.username,
      displayName: a.displayName,
      phoneMasked: a.phoneMasked,
      status: this.effectiveStatus(a),
      statusReason: a.statusReason,
      rateLimitedUntil: a.rateLimitedUntil,
      permissions: {
        canResearch: a.canResearch,
        canJoin: a.canJoin,
        canPublish: a.canPublish,
        canManage: a.canManage,
      },
      lastCheckedAt: a.lastCheckedAt,
      lastError: a.lastError,
      lastErrorCode: a.lastErrorCode,
      destinationCount: a.destinationCount ?? 0,
      communityCount: a.communityCount ?? 0,
      createdAt: a.createdAt,
    };
  }

  /** A rate limit that has run out is not shown as one: the next request simply goes ahead. */
  private effectiveStatus(a: TelegramUserAccount): TelegramUserAccountStatus {
    return a.status === 'RATE_LIMITED' &&
      (!a.rateLimitedUntil || a.rateLimitedUntil <= new Date())
      ? 'ACTIVE'
      : a.status;
  }

  async workerStatus(actor: AgencyActor) {
    this.access.assert(actor, 'userAccount:read');
    if (!this.gateway.isConfigured()) {
      return {
        configured: false,
        running: false,
        version: null,
        message:
          'Telegram user accounts are not set up on this computer. The Telegram worker has to be installed and started first.',
      };
    }
    const health = await this.gateway.health();
    return {
      configured: true,
      running: health.ok === true,
      version: health.version ?? null,
      message: health.ok
        ? null
        : 'The Telegram worker is not running. AgencyOS starts it with the app; restart AgencyOS from Settings → System if it stays off.',
    };
  }

  async list(actor: AgencyActor) {
    this.access.assert(actor, 'userAccount:read');
    return (await this.repo.list(actor.orgId)).map((a) => this.view(a));
  }

  async events(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'userAccount:read');
    await this.require(actor.orgId, id);
    return this.repo.events(actor.orgId, id);
  }

  private async require(orgId: string, id: string) {
    const account = await this.repo.get(orgId, id);
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  // ==========================================
  // SIGN IN (phone, code, optional two-step password)
  // ==========================================
  private sweepLogins() {
    const now = Date.now();
    for (const [id, p] of this.pending) {
      if (p.expiresAt <= now) this.pending.delete(id);
    }
  }

  async startLogin(
    actor: AgencyActor,
    input: { label?: string; apiId: number; apiHash: string; phone: string }
  ) {
    this.access.assert(actor, 'userAccount:manage');
    const phone = input.phone.replace(/[\s()-]/g, '');
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
      throw new BadRequestException(
        'Enter the phone number with its country code, like +4915112345678'
      );
    }
    if (!Number.isInteger(input.apiId) || input.apiId <= 0) {
      throw new BadRequestException('The api id is a whole number');
    }
    if (!/^[0-9a-f]{32}$/i.test(input.apiHash)) {
      throw new BadRequestException(
        'The api hash is 32 letters and digits from my.telegram.org'
      );
    }
    this.sweepLogins();
    if (this.pending.size >= MAX_PENDING_LOGINS) {
      throw new BadRequestException(
        'Too many sign-ins are waiting. Finish or cancel one first.'
      );
    }
    try {
      const started = await this.gateway.loginStart({
        apiId: input.apiId,
        apiHash: input.apiHash,
        phone,
      });
      this.pending.set(started.loginId, {
        orgId: actor.orgId,
        userId: actor.userId,
        label: input.label?.trim() || '',
        apiId: input.apiId,
        apiHash: input.apiHash,
        expiresAt: Date.now() + LOGIN_TTL_MS,
      });
      await this.access.audit(actor, {
        action: 'telegram_account.login_started',
        entityType: 'TelegramUserAccount',
        summary: 'A Telegram account sign-in was started',
      });
      return {
        loginId: started.loginId,
        codeDelivery: started.codeDelivery,
        expiresInSeconds: Math.round(LOGIN_TTL_MS / 1000),
      };
    } catch (err) {
      throw AgencyTelegramUsersService.httpError(err);
    }
  }

  private pendingFor(actor: AgencyActor, loginId: string) {
    this.sweepLogins();
    const p = this.pending.get(loginId);
    if (!p || p.orgId !== actor.orgId || p.userId !== actor.userId) {
      throw new NotFoundException(
        'This sign-in expired or was not started by you. Start again.'
      );
    }
    return p;
  }

  async submitCode(actor: AgencyActor, loginId: string, code: string) {
    this.access.assert(actor, 'userAccount:manage');
    const login = this.pendingFor(actor, loginId);
    const clean = code.replace(/\s/g, '');
    if (!/^\d{4,8}$/.test(clean)) {
      throw new BadRequestException('The code is the digits Telegram sent you');
    }
    try {
      const result = await this.gateway.loginCode({ loginId, code: clean });
      if (result.status === 'password_required') {
        return { status: 'password_required' as const };
      }
      return await this.finish(actor, loginId, login, result);
    } catch (err) {
      this.dropIfFinal(loginId, err);
      throw AgencyTelegramUsersService.httpError(err);
    }
  }

  async submitPassword(actor: AgencyActor, loginId: string, password: string) {
    this.access.assert(actor, 'userAccount:manage');
    const login = this.pendingFor(actor, loginId);
    try {
      const result = await this.gateway.loginPassword({ loginId, password });
      return await this.finish(actor, loginId, login, result);
    } catch (err) {
      this.dropIfFinal(loginId, err);
      throw AgencyTelegramUsersService.httpError(err);
    }
  }

  async cancelLogin(actor: AgencyActor, loginId: string) {
    this.access.assert(actor, 'userAccount:manage');
    this.pendingFor(actor, loginId);
    this.pending.delete(loginId);
    await this.gateway.loginCancel(loginId).catch(() => undefined);
    return { cancelled: true };
  }

  /** A wrong code or password can be tried again; anything else ends this sign-in. */
  private dropIfFinal(loginId: string, err: unknown) {
    if (
      err instanceof TelegramUserGatewayError &&
      ['CODE_INVALID', 'PASSWORD_INVALID', 'NETWORK', 'RATE_LIMITED'].includes(
        err.code
      )
    ) {
      return;
    }
    this.pending.delete(loginId);
  }

  private async finish(
    actor: AgencyActor,
    loginId: string,
    login: PendingLogin,
    result: { status: 'authorized'; session: string; me: UserGatewayMe }
  ) {
    this.pending.delete(loginId);
    const sealed = this.seal({
      apiId: login.apiId,
      apiHash: login.apiHash,
      session: result.session,
    });
    const me = result.me;
    const label =
      login.label ||
      me.username?.replace(/^@?/, '@') ||
      [me.firstName, me.lastName].filter(Boolean).join(' ') ||
      'Telegram account';
    const displayName =
      [me.firstName, me.lastName].filter(Boolean).join(' ') || null;
    const known = await this.repo.findByTelegramUser(actor.orgId, me.id);
    let account: TelegramUserAccount;
    if (known) {
      // The same Telegram account signing in again: its permissions and history stay.
      account =
        (await this.repo.update(actor.orgId, known.id, {
          sealed,
          status: 'ACTIVE',
          statusReason: null,
          rateLimitedUntil: null,
          lastError: null,
          lastErrorCode: null,
          lastCheckedAt: new Date(),
          username: me.username,
          displayName,
          phoneMasked: me.phoneMasked,
        })) ?? known;
    } else {
      account = await this.repo.create(actor.orgId, {
        label,
        telegramUserId: me.id,
        username: me.username,
        displayName,
        phoneMasked: me.phoneMasked,
        sealed,
        connectedById: actor.userId,
        lastCheckedAt: new Date(),
      });
    }
    await this.event(actor.orgId, account.id, 'CONNECTED', {
      message: known ? 'Signed in again' : 'Signed in',
      actorUserId: actor.userId,
    });
    await this.access.audit(actor, {
      action: 'telegram_account.connected',
      entityType: 'TelegramUserAccount',
      entityId: account.id,
      summary: `${account.label} (${account.phoneMasked}) signed in`,
    });
    return { status: 'connected' as const, account: this.view(account) };
  }

  // ==========================================
  // MANAGE
  // ==========================================
  async update(
    actor: AgencyActor,
    id: string,
    input: { label?: string } & Partial<Record<AccountPermission, boolean>>
  ) {
    this.access.assert(actor, 'userAccount:manage');
    const account = await this.require(actor.orgId, id);
    const data: Record<string, unknown> = {};
    if (input.label !== undefined) {
      const label = input.label.trim();
      if (!label) throw new BadRequestException('Give the account a name');
      data.label = label;
    }
    const changed: string[] = [];
    for (const key of Object.keys(PERMISSION_TEXT) as AccountPermission[]) {
      if (input[key] !== undefined && input[key] !== account[key]) {
        data[key] = input[key];
        changed.push(
          `${input[key] ? 'allowed to' : 'no longer allowed to'} ${
            PERMISSION_TEXT[key]
          }`
        );
      }
    }
    if (Object.keys(data).length === 0) return this.view(account);
    const fresh = await this.repo.update(actor.orgId, id, data);
    if (changed.length) {
      await this.event(actor.orgId, id, 'PERMISSIONS_CHANGED', {
        message: `This account is ${changed.join('; ')}`,
        actorUserId: actor.userId,
      });
      await this.access.audit(actor, {
        action: 'telegram_account.permissions_changed',
        entityType: 'TelegramUserAccount',
        entityId: id,
        summary: `${account.label}: ${changed.join('; ')}`,
      });
    }
    return this.view(fresh ?? account);
  }

  async pause(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'userAccount:manage');
    const account = await this.require(actor.orgId, id);
    if (
      account.status === 'LOGGED_OUT' ||
      account.status === 'SESSION_INVALID'
    ) {
      throw new BadRequestException('Sign this account in again first');
    }
    const fresh = await this.repo.setStatus(actor.orgId, id, 'PAUSED', {
      statusReason: 'Paused by a person',
    });
    await this.event(actor.orgId, id, 'PAUSED', {
      message: 'Paused',
      actorUserId: actor.userId,
    });
    await this.access.audit(actor, {
      action: 'telegram_account.paused',
      entityType: 'TelegramUserAccount',
      entityId: id,
      summary: account.label,
    });
    return this.view(fresh ?? account);
  }

  async resume(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'userAccount:manage');
    const account = await this.require(actor.orgId, id);
    if (account.status !== 'PAUSED') {
      throw new BadRequestException(
        'Only a paused account can be resumed. A limited or signed-out account has to be checked or signed in again.'
      );
    }
    const fresh = await this.repo.setStatus(actor.orgId, id, 'ACTIVE', {
      statusReason: null,
    });
    await this.event(actor.orgId, id, 'RESUMED', {
      message: 'Resumed',
      actorUserId: actor.userId,
    });
    await this.access.audit(actor, {
      action: 'telegram_account.resumed',
      entityType: 'TelegramUserAccount',
      entityId: id,
      summary: account.label,
    });
    return this.view(fresh ?? account);
  }

  /** Asks Telegram whether the login still works. Reports what it says; it never tries another account. */
  async check(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'userAccount:manage');
    const account = await this.require(actor.orgId, id);
    const creds = account.sealed ? this.open(account.sealed) : null;
    if (!creds) {
      const fresh = await this.repo.setStatus(
        actor.orgId,
        id,
        account.status === 'LOGGED_OUT' ? 'LOGGED_OUT' : 'SESSION_INVALID',
        {
          statusReason: 'Sign in again',
          lastCheckedAt: new Date(),
        }
      );
      return this.view(fresh ?? account);
    }
    try {
      const result = await this.gateway.accountStatus(creds);
      if (result.authorized) {
        const keep =
          account.status === 'PAUSED' || account.status === 'RESTRICTED';
        const fresh = await this.repo.update(actor.orgId, id, {
          ...(keep
            ? {}
            : { status: 'ACTIVE', statusReason: null, rateLimitedUntil: null }),
          lastError: keep ? account.lastError : null,
          lastErrorCode: keep ? account.lastErrorCode : null,
          lastCheckedAt: new Date(),
          username: result.me.username,
        });
        await this.event(actor.orgId, id, 'HEALTH_OK', {
          message: 'Telegram accepts this login',
          actorUserId: actor.userId,
        });
        return this.view(fresh ?? account);
      }
      await this.recordFailure(
        actor.orgId,
        id,
        new TelegramUserGatewayError(
          'SESSION_INVALID',
          'Telegram no longer accepts this login'
        ),
        actor.userId
      );
    } catch (err) {
      if (err instanceof TelegramUserGatewayError) {
        await this.recordFailure(actor.orgId, id, err, actor.userId);
      } else {
        throw err;
      }
    }
    return this.view((await this.repo.get(actor.orgId, id)) ?? account);
  }

  /** Ends the login at Telegram and forgets it here. The account cannot be used again until it is signed in. */
  async logout(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'userAccount:manage');
    const account = await this.require(actor.orgId, id);
    const creds = account.sealed ? this.open(account.sealed) : null;
    let endedAtTelegram = false;
    if (creds) {
      try {
        endedAtTelegram =
          (await this.gateway.accountLogout(creds)).loggedOut === true;
      } catch (err) {
        // Offline, or the login was already gone: the local copy is wiped either way.
        this.logger.warn(`Logout of account ${id}: ${(err as Error).message}`);
      }
    }
    const fresh = await this.repo.update(actor.orgId, id, {
      sealed: '',
      status: 'LOGGED_OUT',
      statusReason: 'Signed out',
      rateLimitedUntil: null,
      canPublish: false,
      canJoin: false,
      canManage: false,
    });
    await this.event(actor.orgId, id, 'LOGGED_OUT', {
      message: endedAtTelegram
        ? 'Signed out; Telegram ended the login'
        : 'Signed out here; Telegram could not be reached to end the login, so end it in Telegram → Settings → Devices',
      actorUserId: actor.userId,
    });
    await this.access.audit(actor, {
      action: 'telegram_account.logged_out',
      entityType: 'TelegramUserAccount',
      entityId: id,
      summary: account.label,
    });
    return { account: this.view(fresh ?? account), endedAtTelegram };
  }

  async remove(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'userAccount:manage');
    const account = await this.require(actor.orgId, id);
    if (account.status !== 'LOGGED_OUT') {
      throw new BadRequestException(
        'Sign the account out before removing it, so its login ends at Telegram'
      );
    }
    const inUse = await this.repo.destinationIds(actor.orgId, id);
    if (inUse.length) {
      throw new BadRequestException(
        `${inUse.length} chat(s) still post through this account. Take them off it first.`
      );
    }
    await this.repo.softDelete(actor.orgId, id);
    await this.access.audit(actor, {
      action: 'telegram_account.removed',
      entityType: 'TelegramUserAccount',
      entityId: id,
      summary: account.label,
    });
    return { removed: true };
  }

  // ==========================================
  // USED BY THE OTHER TELEGRAM SERVICES
  // ==========================================
  /**
   * The credentials for one account, for one purpose. Refuses, with the reason, when the account is
   * paused, limited, restricted, signed out, or was not given this permission. Callers stop on that
   * refusal; nothing here ever chooses a different account.
   */
  async credentialsFor(
    orgId: string,
    accountId: string,
    need: AccountPermission
  ): Promise<{ account: TelegramUserAccount; creds: UserAccountCredentials }> {
    const account = await this.repo.get(orgId, accountId);
    if (!account) throw new NotFoundException('Account not found');
    if (!account[need]) {
      throw new TelegramAccountUnusableException(
        'NOT_PERMITTED',
        `${account.label} is not allowed to ${PERMISSION_TEXT[need]}. An administrator can allow it on the Accounts page.`
      );
    }
    switch (this.effectiveStatus(account)) {
      case 'PAUSED':
        throw new TelegramAccountUnusableException(
          'PAUSED',
          `${account.label} is paused`
        );
      case 'LOGGED_OUT':
        throw new TelegramAccountUnusableException(
          'LOGGED_OUT',
          `${account.label} is signed out`
        );
      case 'SESSION_INVALID':
        throw new TelegramAccountUnusableException(
          'SESSION_INVALID',
          `Telegram ended ${account.label}’s login. Sign it in again.`
        );
      case 'RESTRICTED':
        throw new TelegramAccountUnusableException(
          'RESTRICTED',
          `Telegram limited ${account.label}${
            account.statusReason ? ` (${account.statusReason})` : ''
          }. It is not used until a person has looked into it.`
        );
      case 'RATE_LIMITED':
        throw new TelegramAccountUnusableException(
          'RATE_LIMITED',
          `Telegram asked ${account.label} to wait${
            account.rateLimitedUntil
              ? ` until ${account.rateLimitedUntil.toISOString()}`
              : ''
          }`,
          account.rateLimitedUntil ?? undefined
        );
      default:
        break;
    }
    const creds = this.open(account.sealed);
    if (!creds) {
      await this.recordFailure(
        orgId,
        accountId,
        new TelegramUserGatewayError(
          'SESSION_INVALID',
          'The saved login could not be read'
        )
      );
      throw new TelegramAccountUnusableException(
        'UNREADABLE',
        `${account.label}’s saved login could not be read. Sign it in again.`
      );
    }
    return { account, creds };
  }

  /**
   * What Telegram's answer means for an account: a login that ended, a limit, a wait. It is written
   * down and shown; the account is paused where Telegram says to stop. It is never a reason to use
   * another account.
   */
  async recordFailure(
    orgId: string,
    accountId: string,
    err: TelegramUserGatewayError,
    actorUserId?: string | null
  ) {
    const base = {
      lastError: err.message.slice(0, 300),
      lastErrorCode: err.code,
      lastCheckedAt: new Date(),
    };
    switch (err.code) {
      case 'SESSION_INVALID':
        await this.repo.setStatus(orgId, accountId, 'SESSION_INVALID', {
          ...base,
          statusReason: 'Telegram ended this login',
        });
        await this.event(orgId, accountId, 'SESSION_INVALID', {
          message: err.message,
          code: err.code,
          actorUserId,
        });
        break;
      case 'ACCOUNT_RESTRICTED':
        await this.repo.setStatus(orgId, accountId, 'RESTRICTED', {
          ...base,
          statusReason: 'Telegram limited this account',
        });
        await this.event(orgId, accountId, 'RESTRICTED', {
          message: err.message,
          code: err.code,
          actorUserId,
        });
        break;
      case 'RATE_LIMITED': {
        const until = new Date(
          Date.now() + (err.retryAfterSeconds ?? 60) * 1000
        );
        await this.repo.setStatus(orgId, accountId, 'RATE_LIMITED', {
          ...base,
          rateLimitedUntil: until,
          statusReason: 'Telegram asked this account to wait',
        });
        await this.event(orgId, accountId, 'RATE_LIMITED', {
          message: `Wait ${err.retryAfterSeconds ?? 60} seconds`,
          code: err.code,
          actorUserId,
        });
        break;
      }
      default:
        await this.repo.update(orgId, accountId, base);
        await this.event(orgId, accountId, 'ERROR', {
          message: err.message,
          code: err.code,
          actorUserId,
        });
    }
    await this.access.audit(null, {
      orgId,
      action: `telegram_account.${err.code.toLowerCase()}`,
      entityType: 'TelegramUserAccount',
      entityId: accountId,
      summary: err.message.slice(0, 200),
    });
  }

  /**
   * The account a quiet background lookup uses: the first one connected for research, and only while
   * it is in good standing. If it is limited, paused or signed out there is no lookup; nothing else
   * stands in for it.
   */
  async firstResearchAccountId(orgId: string): Promise<string | null> {
    const first = (await this.repo.list(orgId)).find((a) => a.canResearch);
    return first && this.effectiveStatus(first) === 'ACTIVE' ? first.id : null;
  }

  private async event(
    orgId: string,
    accountId: string,
    kind: TelegramAccountEventKind,
    event: {
      message: string;
      code?: string | null;
      actorUserId?: string | null;
    }
  ) {
    await this.repo.addEvent(orgId, accountId, { kind, ...event });
  }

  // ==========================================
  // TELLING A PERSON WHAT HAPPENED
  // ==========================================
  /** The status code and plain words a screen can show for a worker or Telegram failure. */
  static httpError(err: unknown): HttpException {
    if (err instanceof HttpException) return err;
    if (!(err instanceof TelegramUserGatewayError)) {
      return new HttpException('Something went wrong talking to Telegram', 502);
    }
    const text: Partial<Record<TelegramUserGatewayError['code'], string>> = {
      PHONE_INVALID: 'Telegram does not accept that phone number',
      CODE_INVALID: 'That code is not right. Check it and try again.',
      CODE_EXPIRED: 'That code expired. Start the sign-in again.',
      PASSWORD_INVALID: 'That password is not right.',
      LOGIN_NOT_FOUND: 'This sign-in expired. Start again.',
      SESSION_INVALID: 'Telegram ended this account’s login. Sign it in again.',
      ACCOUNT_RESTRICTED:
        'Telegram limited this account. It is not used until a person has looked into it.',
      FORBIDDEN: 'This account is not allowed to do that here',
      NOT_FOUND: 'Telegram has no community with that name or link',
      PRIVATE:
        'That community is private, so there is nothing public to show. Join it from Telegram if you are invited.',
      INVALID_REF:
        'Enter a public @name, a t.me link, or an invite link of a community',
      NETWORK: 'Telegram could not be reached. Try again in a moment.',
      OUTCOME_UNKNOWN:
        'The result is not known: check in Telegram before trying again',
      UNSUPPORTED: 'Telegram does not offer that for this kind of community',
      WORKER_UNAVAILABLE: 'The Telegram worker is not running on this computer',
      WORKER_AUTH:
        'The Telegram worker does not accept this install. Restart AgencyOS.',
      WORKER_PROTOCOL:
        'The Telegram worker answered in a way AgencyOS cannot read',
    };
    const message = text[err.code] ?? err.message ?? 'Telegram refused that';
    switch (err.code) {
      case 'RATE_LIMITED':
        return new HttpException(
          `Telegram asked to wait ${
            err.retryAfterSeconds ?? 60
          } seconds before trying again`,
          429
        );
      case 'WORKER_UNAVAILABLE':
      case 'WORKER_AUTH':
        return new HttpException(message, 503);
      case 'WORKER_PROTOCOL':
      case 'NETWORK':
      case 'UNKNOWN':
      case 'OUTCOME_UNKNOWN':
        return new HttpException(message, 502);
      case 'ACCOUNT_RESTRICTED':
      case 'SESSION_INVALID':
        return new ConflictException(message);
      case 'NOT_FOUND':
        return new NotFoundException(message);
      default:
        return new BadRequestException(message);
    }
  }
}
