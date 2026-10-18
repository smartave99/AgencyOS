import { Injectable } from '@nestjs/common';
import { AgencyAccessService, AgencyActor } from './agency.access.service';
import { AgencyTelegramBotsService } from './agency.telegram.bots.service';
import { AgencyTelegramUsersService } from './agency.telegram.users.service';

export type IdentityState = 'READY' | 'PAUSED' | 'LIMITED' | 'NEEDS_ATTENTION';

/** One bot or user account, in the same words, so the agency sees every Telegram identity it relies on in one list. */
export interface TelegramIdentity {
  kind: 'bot' | 'serverBot' | 'userAccount';
  id: string | null;
  label: string;
  handle: string | null;
  state: IdentityState;
  status: string;
  summary: string;
  retryAt: Date | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  destinationCount: number;
  communityCount: number | null;
  /** What a user account has been allowed to do. Bots only post to the chats they were added to. */
  permissions: string[] | null;
}

const BOT_STATES: Record<string, { state: IdentityState; summary: string }> = {
  ACTIVE: { state: 'READY', summary: 'Ready to post to its chats.' },
  DISABLED: {
    state: 'PAUSED',
    summary: 'Switched off here. Its chats are not posted to.',
  },
  INVALID: {
    state: 'NEEDS_ATTENTION',
    summary: 'Telegram rejected the token. Connect the bot again.',
  },
};

const ACCOUNT_STATES: Record<
  string,
  { state: IdentityState; summary: string }
> = {
  ACTIVE: { state: 'READY', summary: 'Signed in and ready.' },
  PAUSED: {
    state: 'PAUSED',
    summary: 'Paused here. Its jobs wait until it is resumed.',
  },
  RATE_LIMITED: {
    state: 'LIMITED',
    summary:
      'Telegram asked this account to wait. Its jobs wait; no other account takes them over.',
  },
  RESTRICTED: {
    state: 'LIMITED',
    summary:
      'Telegram has limited this account. Its jobs are paused and no other account takes them over.',
  },
  SESSION_INVALID: {
    state: 'NEEDS_ATTENTION',
    summary:
      'Telegram ended this sign-in. Sign in again with the code Telegram sends.',
  },
  LOGGED_OUT: {
    state: 'NEEDS_ATTENTION',
    summary: 'Signed out. Sign in again to use it.',
  },
};

const PERMISSION_WORDS: Record<string, string> = {
  canResearch: 'research',
  canJoin: 'join',
  canPublish: 'publish',
  canManage: 'manage',
};

/** Reads the bots and the user accounts side by side. It changes nothing and holds no credentials. */
@Injectable()
export class AgencyTelegramOverviewService {
  constructor(
    private access: AgencyAccessService,
    private bots: AgencyTelegramBotsService,
    private users: AgencyTelegramUsersService
  ) {}

  async overview(actor: AgencyActor) {
    const seeBots = this.access.can(actor, 'destination:read');
    const seeAccounts = this.access.can(actor, 'userAccount:read');
    if (!seeBots && !seeAccounts) this.access.assert(actor, 'userAccount:read');

    const [botList, accountList, worker] = await Promise.all([
      seeBots ? this.bots.list(actor) : null,
      seeAccounts ? this.users.list(actor) : null,
      seeAccounts ? this.users.workerStatus(actor) : null,
    ]);

    const identities: TelegramIdentity[] = [];
    if (botList?.server?.configured) {
      identities.push({
        kind: 'serverBot',
        id: null,
        label: botList.server.label,
        handle: botList.server.username ? `@${botList.server.username}` : null,
        state: 'READY',
        status: 'ACTIVE',
        summary:
          'The bot from this computer’s settings. Chats added without choosing a bot use it.',
        retryAt: null,
        lastCheckedAt: null,
        lastError: null,
        destinationCount: 0,
        communityCount: null,
        permissions: null,
      });
    }
    for (const b of botList?.bots ?? []) {
      const known = BOT_STATES[b.status] ?? BOT_STATES.INVALID;
      identities.push({
        kind: 'bot',
        id: b.id,
        label: b.label,
        handle: b.username ? `@${b.username}` : null,
        state: known.state,
        status: b.status,
        summary: known.summary,
        retryAt: null,
        lastCheckedAt: b.lastCheckedAt ?? null,
        lastError: b.lastError ?? null,
        destinationCount: b.destinationCount ?? 0,
        communityCount: null,
        permissions: null,
      });
    }
    for (const a of accountList ?? []) {
      const known = ACCOUNT_STATES[a.status] ?? ACCOUNT_STATES.SESSION_INVALID;
      identities.push({
        kind: 'userAccount',
        id: a.id,
        label: a.label,
        handle: a.username ? `@${a.username}` : a.phoneMasked,
        state: known.state,
        status: a.status,
        summary: known.summary,
        retryAt:
          a.status === 'RATE_LIMITED' ? a.rateLimitedUntil ?? null : null,
        lastCheckedAt: a.lastCheckedAt ?? null,
        lastError: a.statusReason || a.lastError || null,
        destinationCount: a.destinationCount ?? 0,
        communityCount: a.communityCount ?? 0,
        permissions: Object.entries(a.permissions)
          .filter(([, granted]) => granted)
          .map(([key]) => PERMISSION_WORDS[key] ?? key),
      });
    }

    const count = (state: IdentityState) =>
      identities.filter((i) => i.state === state).length;
    return {
      identities,
      totals: {
        all: identities.length,
        ready: count('READY'),
        paused: count('PAUSED'),
        limited: count('LIMITED'),
        needsAttention: count('NEEDS_ATTENTION'),
      },
      worker,
      // Shown so nobody expects a limited account's jobs to move: they never do.
      note: 'When an account is limited, restricted or signed out, its jobs wait for it. They are never given to another account.',
    };
  }
}
