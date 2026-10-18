import { useResource } from './agency.hooks';

// ---------------------------------------------------------------------------
// Telegram user accounts and the community directory. Each resource is its own named hook.
// ---------------------------------------------------------------------------
export type AccountStatus =
  | 'ACTIVE'
  | 'PAUSED'
  | 'RATE_LIMITED'
  | 'RESTRICTED'
  | 'SESSION_INVALID'
  | 'LOGGED_OUT';

export interface WorkerStatus {
  configured: boolean;
  running: boolean;
  version: string | null;
  message: string | null;
}

export interface TelegramUserAccountView {
  id: string;
  label: string;
  username: string | null;
  displayName: string | null;
  phoneMasked: string;
  status: AccountStatus;
  statusReason: string | null;
  rateLimitedUntil: string | null;
  permissions: {
    canResearch: boolean;
    canJoin: boolean;
    canPublish: boolean;
    canManage: boolean;
  };
  lastCheckedAt: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  destinationCount: number;
  communityCount: number;
  createdAt: string;
}

export interface AccountEvent {
  id: string;
  kind: string;
  code: string | null;
  message: string;
  createdAt: string;
}

export type CommunityStage =
  | 'DISCOVERED'
  | 'REVIEW_REQUIRED'
  | 'JOIN_REQUEST_PENDING'
  | 'JOINED'
  | 'ADVERTISING_ALLOWED'
  | 'PUBLISHING_AUTHORIZED'
  | 'NOT_ELIGIBLE'
  | 'BLOCKED';

export type CommunityRelation =
  | 'OWNED'
  | 'ADMINISTERED'
  | 'MEMBER'
  | 'PUBLIC_NOT_JOINED'
  | 'RESTRICTED'
  | 'UNAVAILABLE';

export interface CommunityView {
  id: string;
  telegramId: string | null;
  kind: string | null;
  username: string | null;
  title: string;
  description: string | null;
  memberCount: number | null;
  verified: boolean;
  scam: boolean;
  fake: boolean;
  joinRequestRequired: boolean;
  slowModeSeconds: number | null;
  language: string | null;
  category: string | null;
  tags: string[];
  notes: string | null;
  bookmarked: boolean;
  relation: CommunityRelation;
  available: boolean;
  lastErrorCode: string | null;
  stage: CommunityStage;
  stageReason: string | null;
  operatingAccountId: string | null;
  operatingAccount?: {
    id: string;
    label: string;
    username: string | null;
  } | null;
  adReview: 'NOT_REVIEWED' | 'ALLOWED' | 'NOT_ALLOWED';
  adReviewNote: string | null;
  adReviewEvidenceUrl: string | null;
  adReviewedAt: string | null;
  lastRefreshedAt: string | null;
  source: string | null;
  createdAt: string;
  destinations?: Array<{ id: string; authorizationStatus: string }>;
}

export interface CommunityHistoryEntry {
  id: string;
  kind: string;
  summary: string;
  fromStage: CommunityStage | null;
  toStage: CommunityStage | null;
  changes: Record<string, [unknown, unknown]> | null;
  createdAt: string;
}

export interface CommunityFilterState {
  search: string;
  stage: string;
  bookmarked: boolean;
  sort: string;
  category: string;
}

export const useTelegramWorkerStatus = () =>
  useResource<WorkerStatus>(
    ['agency-telegram-worker'],
    '/agency/telegram/accounts/status',
    30000
  );

export type IdentityState = 'READY' | 'PAUSED' | 'LIMITED' | 'NEEDS_ATTENTION';

export interface TelegramIdentityView {
  kind: 'bot' | 'serverBot' | 'userAccount';
  id: string | null;
  label: string;
  handle: string | null;
  state: IdentityState;
  status: string;
  summary: string;
  retryAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  destinationCount: number;
  communityCount: number | null;
  permissions: string[] | null;
}

export interface TelegramOverviewView {
  identities: TelegramIdentityView[];
  totals: {
    all: number;
    ready: number;
    paused: number;
    limited: number;
    needsAttention: number;
  };
  worker: WorkerStatus | null;
  note: string;
}

export const useTelegramOverview = () =>
  useResource<TelegramOverviewView>(
    ['agency-telegram-overview'],
    '/agency/telegram/overview',
    20000
  );

export const useTelegramUserAccounts = () =>
  useResource<TelegramUserAccountView[]>(
    ['agency-telegram-user-accounts'],
    '/agency/telegram/accounts',
    20000
  );

export const useTelegramAccountEvents = (id: string | null) =>
  useResource<AccountEvent[]>(
    id ? ['agency-telegram-account-events', id] : null,
    `/agency/telegram/accounts/${id}/events`
  );

export const useCommunities = (f: CommunityFilterState) => {
  const params = new URLSearchParams();
  if (f.search.trim()) params.set('search', f.search.trim());
  if (f.stage) params.set('stage', f.stage);
  if (f.bookmarked) params.set('bookmarked', 'true');
  if (f.sort) params.set('sort', f.sort);
  if (f.category.trim()) params.set('category', f.category.trim());
  return useResource<CommunityView[]>(
    ['agency-communities', f.search, f.stage, f.bookmarked, f.sort, f.category],
    `/agency/communities?${params.toString()}`,
    30000
  );
};

export const useCommunity = (id: string) =>
  useResource<{ community: CommunityView; history: CommunityHistoryEntry[] }>(
    ['agency-community', id],
    `/agency/communities/${id}`,
    30000
  );

export const useCommunityDuplicates = () =>
  useResource<
    Array<
      Array<{
        id: string;
        title: string;
        username: string | null;
        stage: string;
      }>
    >
  >(['agency-community-duplicates'], '/agency/communities/duplicates');
