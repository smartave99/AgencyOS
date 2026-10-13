'use client';

import { useCallback, useMemo } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

// ---------------------------------------------------------------------------
// Types mirroring the backend responses the agency screens consume
// ---------------------------------------------------------------------------
export interface AgencyMe {
  userId: string;
  role: string;
  customerId: string | null;
  permissions: string[];
}

// AI providers (mirrors AgencyAiGatewayService; secrets never come back, only `hasKey`)
export type AiProviderId =
  | 'local'
  | 'claude-cli'
  | 'codex-cli'
  | 'antigravity-cli'
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'openai-compatible';

export type ThinkingLevel =
  | 'auto'
  | 'off'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

/** The jobs that can each use their own model and thinking level. */
export type AiTask = 'copy' | 'improve' | 'copilot' | 'agent';

export interface AiProviderView {
  id: AiProviderId;
  label: string;
  kind: 'local' | 'cli' | 'api';
  summary: string;
  setup: string;
  experimental: boolean;
  needsKey: boolean;
  keyOptional: boolean;
  baseUrlEditable: boolean;
  thinkingLevels: ThinkingLevel[];
  suggestedModels: string[];
  model: string | null;
  baseUrl: string;
  hasKey: boolean;
  keySource: 'saved' | 'environment' | null;
  selectable: boolean;
  unavailable: string | null;
}

export interface AiSettings {
  localMode: boolean;
  activeProvider: AiProviderId;
  thinking: ThinkingLevel;
  providers: AiProviderView[];
  tasks: Record<
    AiTask,
    {
      provider: AiProviderId | null;
      model: string | null;
      thinking: ThinkingLevel | null;
    }
  >;
}

export interface AiProviderStatus {
  id: AiProviderId;
  ready: boolean;
  detail: string;
  version?: string;
  models?: string[];
}

export interface AiModelInfo {
  id: string;
  label: string;
  description?: string;
  thinkingLevels?: ThinkingLevel[];
  isDefault?: boolean;
}

export interface AiModels {
  models: AiModelInfo[];
  live: boolean;
  note?: string;
}

export interface AiTestResult {
  ok: boolean;
  provider: AiProviderId;
  model?: string | null;
  ms: number;
  sample?: string;
  notes?: string[];
  code?: string;
  error?: string;
}

export type AgentTurn =
  | { type: 'final'; text: string }
  | {
      type: 'tool';
      tool: string;
      activity: string;
      args: Record<string, unknown>;
      thought?: string;
      ok: boolean;
      result: string;
    }
  | {
      type: 'proposal';
      tool: string;
      activity: string;
      args: Record<string, unknown>;
      thought?: string;
      summary: string;
    };

export interface AgentStepResult {
  turn: AgentTurn;
  assistant: string;
  provider: AiProviderId;
  model: string | null;
  ms: number;
  notes: string[];
}

export interface AgentActResult {
  ok: boolean;
  result: string;
  summary: string;
}

export interface AiChatReply {
  reply: string;
  provider: AiProviderId;
  model: string | null;
  ms: number;
  notes: string[];
}

export interface AiToolView {
  id: AiProviderId;
  label: string;
  installed: boolean;
  version: string | null;
  autoUpdate: boolean;
  canUpdate: boolean;
  status: 'unknown' | 'current' | 'updated' | 'failed' | 'skipped' | 'manual';
  message: string | null;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
  manualHint: string;
}

export interface AiTools {
  available: boolean;
  autoUpdate: boolean;
  tools: AiToolView[];
}

export interface TelegramBotView {
  id: string;
  label: string;
  username: string;
  status: 'ACTIVE' | 'DISABLED' | 'INVALID';
  lastError: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  destinationCount: number;
}

/** The connected bots, plus the one from the server settings (read-only), if any. The token never comes back. */
export interface TelegramBots {
  bots: TelegramBotView[];
  server: { configured: boolean; label: string; username: string | null };
}

/** A saved ad format: content only, no client, chats or schedule. */
export interface AdTemplate {
  id: string;
  name: string;
  contentTitle: string | null;
  contentBody: string;
  contentMedia: string | null;
  ctaLink: string | null;
  ctaText: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A link that opens one of the agency's bots; whoever taps Start on it asked to hear from the agency. */
export interface LeadLinkView {
  id: string;
  label: string;
  code: string;
  url: string | null;
  welcomeMessage: string | null;
  createdAt: string;
  campaign: { id: string; name: string } | null;
  people: number;
  stopped: number;
}

export interface LeadView {
  id: string;
  name: string | null;
  telegramHandle: string | null;
  status: string;
  notes: string | null;
  consentedAt: string | null;
  createdAt: string;
  leadLink: { id: string; label: string } | null;
  campaign: { id: string; name: string } | null;
}

// WhatsApp workspace (mirrors AgencyWhatsappService). Numbers arrive masked except in a contact's
// own detail, and only for roles that work contacts.
export type WhatsappConsentStatus = 'OPTED_IN' | 'OPTED_OUT';

/** What a person marked a task as. There is no "delivered": AgencyOS cannot see it. */
export type WhatsappTaskStatus =
  | 'PENDING'
  | 'SENT_BY_USER'
  | 'REPLIED'
  | 'SKIPPED';

export interface WhatsappContactItem {
  id: string;
  name: string;
  maskedPhone: string;
  company: string | null;
  language: string | null;
  tags: string[];
  consentStatus: WhatsappConsentStatus;
  consentSource: string;
  consentedAt: string;
  optedOutAt: string | null;
  createdAt: string;
}

export interface WhatsappContactDetail extends WhatsappContactItem {
  /** The whole number; null for roles that may only read. */
  phone: string | null;
  notes: string | null;
  consentEvidence: string | null;
  optOutMethod: string | null;
  optOutReason: string | null;
  importId: string | null;
  tasks: Array<{
    id: string;
    status: WhatsappTaskStatus;
    label: string;
    templateName: string | null;
    followUpAt: string | null;
    sentAt: string | null;
    createdAt: string;
  }>;
}

export interface WhatsappSegmentView {
  id: string;
  name: string;
  tags: string[];
  languages: string[];
  consentSources: string[];
  memberCount: number;
  createdAt: string;
}

export interface WhatsappTemplateView {
  id: string;
  name: string;
  body: string;
  language: string | null;
  link: string | null;
  optOutLine: string;
  optOutMissing: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WhatsappTaskView {
  id: string;
  status: WhatsappTaskStatus;
  label: string;
  message: string;
  skipReason: string | null;
  note: string | null;
  followUpAt: string | null;
  openedAt: string | null;
  sentAt: string | null;
  repliedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contact: {
    id: string;
    name: string;
    maskedPhone: string;
    consentStatus: WhatsappConsentStatus;
  };
  template: { id: string; name: string } | null;
}

export interface WhatsappImportView {
  id: string;
  fileName: string | null;
  totalRows: number;
  importedRows: number;
  duplicateRows: number;
  invalidRows: number;
  missingConsentRows: number;
  withdrawnRows: number;
  attestation: string;
  attestedBy: string;
  createdAt: string;
}

export type WhatsappImportRowStatus =
  | 'VALID'
  | 'DUPLICATE'
  | 'INVALID'
  | 'MISSING_CONSENT'
  | 'WITHDRAWN';

export interface WhatsappImportPreview {
  counts: {
    total: number;
    valid: number;
    duplicate: number;
    invalid: number;
    missingConsent: number;
    withdrawn: number;
  };
  rows: Array<{
    line: number;
    status: WhatsappImportRowStatus;
    name: string;
    phone: string | null;
    reasons: string[];
  }>;
  columnProblems: string[];
  canImport: boolean;
}

export interface WhatsappUnsubscribeView {
  id: string;
  receivedAt: string;
  method: string;
  recordedBy: string;
  /** Null once the person's details were erased: only a hash is left. */
  contact: { id: string; name: string; maskedPhone: string } | null;
}

export interface WhatsappSettings {
  defaultOptOutLine: string;
  businessApi: { enabled: boolean; available: boolean; message: string };
  placeholders: string[];
  withdrawMethods: string[];
  attestation: string;
  limits: {
    maxImportRows: number;
    maxImportChars: number;
    maxTasksPerDraft: number;
  };
}

export interface WhatsappFacets {
  tags: string[];
  languages: string[];
  consentSources: string[];
}

export interface WhatsappTemplatePreview {
  message: string;
  characters: number;
  problems: string[];
  warnings: string[];
  missing: string[];
  usedSample: boolean;
}

export type WhatsappSuggestion =
  | { available: true; text: string; provider: string; model: string | null }
  | { available: false; reason: string };

export interface DestinationView {
  id: string;
  /** Which connected bot serves this chat; null is the server's bot. */
  botId: string | null;
  botUsername: string | null;
  /** Other bots allowed to post here (ids of connected bots, or "server"), and how they share the work. */
  backupBotIds: string[];
  botStrategy: 'FAILOVER' | 'ROUND_ROBIN' | 'LEAST_USED';
  lastBotId: string | null;
  chatId: string;
  title: string;
  type: string;
  authorizationStatus:
    | 'PENDING_VERIFICATION'
    | 'ACTIVE'
    | 'SUSPENDED'
    | 'REVOKED'
    | 'EXPIRED'
    | 'DISCONNECTED';
  hasPendingVerification: boolean;
  verificationExpiresAt: string | null;
  consentGrantedAt: string | null;
  consentExpiresAt: string | null;
  consentedByName: string | null;
  revokedReason: string | null;
  canPostMessages: boolean;
  timezone: string;
  ownerName: string | null;
  lastSuccessfulPostAt: string | null;
  lastError: string | null;
  allowedPostingWindows: string | null;
  postingFrequencyRules: string | null;
  _count: { campaignDestinations: number; publishingEvents: number };
}

export interface PostingJob {
  id: string;
  status:
    | 'PENDING'
    | 'SENDING'
    | 'SUCCEEDED'
    | 'BLOCKED'
    | 'DEAD'
    | 'CANCELLED'
    | 'UNCERTAIN';
  attempts: number;
  maxAttempts: number;
  scheduledFor: string;
  nextAttemptAt: string;
  completedAt: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  externalMessageId: string | null;
  releaseUrl: string | null;
  /** Which version of the ad this post carries; null is version A. */
  variantLabel?: string | null;
  /** 0 for the first post to a chat, then 1, 2... for repeats. */
  occurrence?: number;
  campaign?: { id: string; name: string };
  telegramDestination?: {
    id: string;
    title: string;
    type: string;
    authorizationStatus?: string;
  } | null;
}

export interface QueueResponse {
  counts: Record<PostingJob['status'], number>;
  jobs: PostingJob[];
}

export interface DashboardResponse {
  activeClientsCount: number;
  activeCampaignsCount: number;
  totalCampaignsCount: number;
  pendingApprovalsCount: number;
  telegramDestinationsCount: number;
  destinationsNeedingAttention: number;
  campaignsNeedingAttention: number;
  connectedSocialCount: number;
  successfulPosts: number;
  failedPosts: number;
  blockedPosts: number;
  queuedPosts: number;
  runningPosts: number;
  deliveryRate: number | null;
  /** What is sending or waiting on someone, most urgent first. */
  queue: Array<{
    id: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    nextAttemptAt: string;
    lastError: string | null;
    lastErrorCode: string | null;
    campaign: { id: string; name: string };
    telegramDestination: { id: string; title: string } | null;
  }>;
  health: {
    bots: Array<{
      id: string;
      label: string;
      username: string;
      status: string;
      lastError: string | null;
      lastCheckedAt: string | null;
      chats: number;
    }>;
    chats: Record<string, number>;
    rateLimitedChats: number;
  };
  system: {
    dispatcher: { online: boolean; lastSeenAt: string | null };
    telegram: {
      configured: boolean;
      listening: boolean;
      updates: 'webhook' | 'polling' | 'off';
    };
  };
  recentCampaigns: Array<{
    id: string;
    name: string;
    status: string;
    requiresAttention?: boolean;
    customer: { name: string; companyName: string | null };
    createdAt: string;
    _count: { destinations: number; publishingEvents: number };
  }>;
  recentEvents: Array<{
    id: string;
    status: string;
    errorMessage: string | null;
    executedAt: string;
    campaign: { name: string };
    telegramDestination?: { title: string };
  }>;
}

export interface CampaignSummary {
  id: string;
  name: string;
  objective: string;
  status: string;
  requiresAttention: boolean;
  attentionReason: string | null;
  requiresClientApproval: boolean;
  clientApprovedAt: string | null;
  budget: string | null;
  startDate: string | null;
  endDate: string | null;
  contentTitle: string | null;
  contentBody: string;
  contentMedia: string | null;
  ctaLink: string | null;
  ctaText: string | null;
  telegramChannelLink: string | null;
  internalNotes: string | null;
  scheduleKind?: 'ONCE' | 'REPEAT' | 'DRIP';
  intervalMinutes?: number | null;
  occurrences?: number | null;
  /** The other versions of the ad (B, C, D); the fields above are version A. */
  variants?: Array<{
    label: string;
    contentTitle: string | null;
    contentBody: string;
    contentMedia: string | null;
    ctaLink: string | null;
    ctaText: string | null;
  }>;
  revision: number;
  approvedAt: string | null;
  createdAt: string;
  customer: { id: string; name: string; companyName: string | null };
  createdBy: { id: string; name: string; email: string };
  destinations: Array<{
    id: string;
    destinationType: string;
    scheduledAt: string | null;
    telegramDestination?: {
      id: string;
      title: string;
      chatId: string;
      authorizationStatus?: string;
    } | null;
    integration?: { id: string; name: string; type: string } | null;
  }>;
  _count?: { publishingEvents: number; leads: number };
}

export interface CampaignDetail extends CampaignSummary {
  approvals: Array<{
    id: string;
    status: string;
    submissionNotes: string | null;
    reviewNotes: string | null;
    selfApproved: boolean;
    createdAt: string;
    reviewedAt: string | null;
    submittedByUser: { id: string; name: string };
    reviewedByUser?: { id: string; name: string } | null;
  }>;
  postingJobs: PostingJob[];
  trackingLinks: Array<{
    id: string;
    shortCode: string;
    destinationUrl: string;
    totalClicks: number;
  }>;
}

export interface AuditEntry {
  id: string;
  action: string;
  actorUserId: string | null;
  actorRole: string | null;
  summary: string | null;
  createdAt: string;
}

export interface Deal {
  id: string;
  contactName: string;
  companyName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  value: string | null;
  currency: string;
  stage: 'PROSPECT' | 'CONTACTED' | 'PROPOSAL_SENT' | 'WON' | 'LOST';
  lostReason: string | null;
  notes: string | null;
  customerId: string | null;
  owner: { id: string; name: string | null; email: string } | null;
  customer: { id: string; name: string } | null;
}

export interface ReportTally {
  queued: number;
  delivered: number;
  failed: number;
  paused: number;
  uncertain: number;
  cancelled: number;
}

export interface PublishingReport {
  range: { from: string; to: string; timezone: string };
  customerId: string | null;
  totals: ReportTally & { deliveryRate: number | null; trackedClicks: number };
  campaigns: Array<
    ReportTally & {
      id: string;
      name: string;
      status: string;
      client: string;
      deliveryRate: number | null;
      trackedClicks: number;
      lastDeliveredAt: string | null;
    }
  >;
  destinations: Array<
    ReportTally & {
      id: string;
      title: string;
      deliveryRate: number | null;
      lastDeliveredAt: string | null;
    }
  >;
  /** Only campaigns that posted more than one version of their ad in the period. */
  variants: Array<
    ReportTally & {
      campaignId: string;
      campaignName: string;
      label: string;
      deliveryRate: number | null;
    }
  >;
  daily: Array<{
    date: string;
    delivered: number;
    failed: number;
    other: number;
  }>;
  dailyTruncated: boolean;
  notes: string[];
}

export interface TeamMember {
  userId: string;
  name: string | null;
  email: string;
  workspaceRole: string;
  agencyRole: string;
  roleSource: 'ASSIGNED' | 'DERIVED';
  customerId: string | null;
}

export interface PortalOverview {
  client: {
    id: string;
    name: string;
    companyName: string;
    email?: string;
    phone?: string;
    accountRep?: { name: string; email: string };
  };
  viewer: { isClient: boolean; canReview: boolean };
  metrics: {
    totalCampaigns: number;
    activeCampaigns: number;
    scheduledCampaigns: number;
    completedCampaigns: number;
    totalLinkClicks: number;
    totalLeads: number;
    successfulPublications: number;
  };
  campaigns: Array<{
    id: string;
    name: string;
    objective: string;
    status: string;
    startDate?: string;
    endDate?: string;
    contentTitle?: string;
    contentBody?: string;
    contentMedia?: string[];
    ctaLink?: string;
    ctaText?: string;
    telegramChannelLink?: string;
    totalClicks: number;
    leadsCount: number;
    destinationsCount: number;
    awaitingClientApproval: boolean;
    clientApprovedAt?: string;
    preview: { html: string; format: string };
  }>;
}

// ---------------------------------------------------------------------------
// API helper: JSON in/out, and the server's own error message when it says no
// ---------------------------------------------------------------------------
const messageOf = (body: any, fallback: string) => {
  const m = body?.message;
  if (Array.isArray(m)) return m.join('. ');
  return typeof m === 'string' && m ? m : fallback;
};

export const useAgencyApi = () => {
  const fetch = useFetch();
  return useMemo(() => {
    const request = async <T>(
      method: string,
      path: string,
      body?: unknown
    ): Promise<T> => {
      const res = await fetch(path, {
        method,
        ...(body !== undefined
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
      });
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (!res.ok) {
        throw new Error(messageOf(json, `Request failed (${res.status})`));
      }
      return json as T;
    };
    return {
      get: <T>(path: string) => request<T>('GET', path),
      post: <T>(path: string, body: unknown = {}) =>
        request<T>('POST', path, body),
      put: <T>(path: string, body: unknown = {}) =>
        request<T>('PUT', path, body),
      del: <T>(path: string) => request<T>('DELETE', path),
      /** Authenticated file download (the API needs the auth header, so a plain link can't be used). */
      download: async (path: string, filename: string) => {
        const res = await fetch(path);
        if (!res.ok) {
          throw new Error(
            messageOf(
              await res.json().catch(() => undefined),
              'Download failed'
            )
          );
        }
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      },
    };
  }, [fetch]);
};

type Api = ReturnType<typeof useAgencyApi>;

/** One cached request. Every resource below is its own named hook. */
export const useResource = <T>(
  key: unknown[] | null,
  path: string,
  refreshMs?: number
) => {
  const api = useAgencyApi();
  const load = useCallback(() => api.get<T>(path), [api, path]);
  return useSWR<T>(key, load, {
    revalidateOnFocus: true,
    ...(refreshMs ? { refreshInterval: refreshMs } : {}),
  });
};

// ---------------------------------------------------------------------------
// Named hooks, one SWR call each
// ---------------------------------------------------------------------------
export const useAgencyMe = () =>
  useResource<AgencyMe>(['agency-me'], '/agency/me');

export const useDashboard = (enabled = true) =>
  useResource<DashboardResponse>(
    enabled ? ['agency-dashboard'] : null,
    '/agency/dashboard',
    15000
  );

export const useCampaigns = (
  status: string,
  search: string,
  enabled = true
) => {
  const params = new URLSearchParams();
  if (status !== 'ALL') params.set('status', status);
  if (search.trim()) params.set('search', search.trim());
  return useResource<CampaignSummary[]>(
    enabled ? ['agency-campaigns', status, search] : null,
    `/agency/campaigns?${params.toString()}`,
    20000
  );
};

export const useCampaign = (id: string) =>
  useResource<CampaignDetail>(
    ['agency-campaign', id],
    `/agency/campaigns/${id}`,
    8000
  );

export const useCampaignAudit = (id: string, enabled: boolean) =>
  useResource<AuditEntry[]>(
    enabled ? ['agency-audit', 'Campaign', id] : null,
    `/agency/audit?entityType=Campaign&entityId=${id}&limit=50`
  );

export const useAuditLog = (enabled: boolean) =>
  useResource<AuditEntry[]>(
    enabled ? ['agency-audit-log'] : null,
    '/agency/audit?limit=50'
  );

export const useApprovals = (status: string) =>
  useResource<any[]>(
    ['agency-approvals', status],
    `/agency/approvals${status !== 'ALL' ? `?status=${status}` : ''}`,
    20000
  );

export const useClients = (search = '') =>
  useResource<any[]>(
    ['agency-clients', search],
    `/agency/clients${search ? `?search=${encodeURIComponent(search)}` : ''}`
  );

export const useTelegramDestinations = () =>
  useResource<DestinationView[]>(
    ['agency-telegram-destinations'],
    '/agency/telegram/destinations',
    15000
  );

export const useAdTemplates = (enabled = true) =>
  useResource<AdTemplate[]>(
    enabled ? ['agency-templates'] : null,
    '/agency/templates'
  );

export const useLeadLinks = () =>
  useResource<LeadLinkView[]>(
    ['agency-lead-links'],
    '/agency/leads/links',
    20000
  );

export const useLeads = (linkId: string, status: string, search: string) => {
  const params = new URLSearchParams();
  if (linkId) params.set('linkId', linkId);
  if (status) params.set('status', status);
  if (search.trim()) params.set('search', search.trim());
  return useResource<LeadView[]>(
    ['agency-leads', linkId, status, search],
    `/agency/leads?${params.toString()}`,
    20000
  );
};

export const useWhatsappSettings = () =>
  useResource<WhatsappSettings>(
    ['agency-whatsapp-settings'],
    '/agency/whatsapp/settings'
  );

export const useWhatsappFacets = () =>
  useResource<WhatsappFacets>(
    ['agency-whatsapp-facets'],
    '/agency/whatsapp/facets'
  );

export const useWhatsappContacts = (
  search: string,
  status: string,
  tag: string
) => {
  const params = new URLSearchParams();
  if (search.trim()) params.set('search', search.trim());
  if (status) params.set('status', status);
  if (tag) params.set('tag', tag);
  return useResource<WhatsappContactItem[]>(
    ['agency-whatsapp-contacts', search, status, tag],
    `/agency/whatsapp/contacts?${params.toString()}`,
    30000
  );
};

export const useWhatsappContact = (id: string) =>
  useResource<WhatsappContactDetail>(
    ['agency-whatsapp-contact', id],
    `/agency/whatsapp/contacts/${id}`
  );

export const useWhatsappSegments = () =>
  useResource<WhatsappSegmentView[]>(
    ['agency-whatsapp-segments'],
    '/agency/whatsapp/segments',
    30000
  );

export const useWhatsappTemplates = () =>
  useResource<WhatsappTemplateView[]>(
    ['agency-whatsapp-templates'],
    '/agency/whatsapp/templates'
  );

export const useWhatsappTasks = (status: string, limit = 0) => {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (limit) params.set('limit', String(limit));
  return useResource<WhatsappTaskView[]>(
    ['agency-whatsapp-tasks', status, limit],
    `/agency/whatsapp/tasks?${params.toString()}`
  );
};

export const useWhatsappDueTasks = (until: string) =>
  useResource<WhatsappTaskView[]>(
    ['agency-whatsapp-due', until],
    `/agency/whatsapp/tasks/due?until=${encodeURIComponent(until)}`
  );

export const useWhatsappImports = () =>
  useResource<WhatsappImportView[]>(
    ['agency-whatsapp-imports'],
    '/agency/whatsapp/imports'
  );

export const useWhatsappUnsubscribes = () =>
  useResource<WhatsappUnsubscribeView[]>(
    ['agency-whatsapp-unsubscribes'],
    '/agency/whatsapp/unsubscribes'
  );

export const useTelegramBots = (enabled = true) =>
  useResource<TelegramBots>(
    enabled ? ['agency-telegram-bots'] : null,
    '/agency/telegram/bots',
    20000
  );

export const usePublishingQueue = (status = '') =>
  useResource<QueueResponse>(
    ['agency-queue', status],
    `/agency/telegram/jobs${status ? `?status=${status}` : ''}`,
    8000
  );

export const usePublishingEvents = () =>
  useResource<any[]>(['agency-events'], '/agency/telegram/events', 15000);

export const useDeals = () =>
  useResource<Deal[]>(['agency-deals'], '/agency/crm/deals');

export const useDealSummary = () =>
  useResource<{
    stages: Array<{
      stage: string;
      count: number;
      totals: Record<string, number>;
    }>;
  }>(['agency-deal-summary'], '/agency/crm/summary');

export const usePublishingReport = (
  from: string,
  to: string,
  customerId: string
) => {
  const params = new URLSearchParams({ from, to });
  if (customerId) params.set('customerId', customerId);
  return useResource<PublishingReport>(
    ['agency-report', from, to, customerId],
    `/agency/reports/publishing?${params.toString()}`
  );
};

export const useTeam = () =>
  useResource<TeamMember[]>(['agency-team'], '/agency/team');

/** `clientId` null = the signed-in CLIENT's own portal; staff pass a client id to preview it. */
export const usePortal = (clientId: string | null, enabled = true) =>
  useResource<PortalOverview>(
    enabled ? ['agency-portal', clientId] : null,
    clientId ? `/agency/portal/${clientId}` : '/agency/portal/me'
  );

export const useIntelligence = () =>
  useResource<any>(['agency-intelligence'], '/agency/intelligence');

export const useInvoices = (status = '') =>
  useResource<any[]>(
    ['agency-invoices', status],
    `/agency/invoices${status ? `?status=${status}` : ''}`
  );

export const useAccounts = () =>
  useResource<any[]>(['agency-accounts'], '/agency/accounts');

export const useCapabilities = () =>
  useResource<any[]>(['agency-capabilities'], '/agency/platforms/capabilities');

export const useAiSettings = () =>
  useResource<AiSettings>(['agency-ai-settings'], '/agency/ai/settings');

export const useAiStatus = () =>
  useResource<AiProviderStatus[]>(['agency-ai-status'], '/agency/ai/status');

export const useAiTools = () =>
  useResource<AiTools>(['agency-ai-tools'], '/agency/ai/tools');

export const useAiModels = (provider: AiProviderId) =>
  useResource<AiModels>(
    ['agency-ai-models', provider],
    `/agency/ai/models/${provider}`
  );

// ---------------------------------------------------------------------------
// Role awareness: hide what the server would refuse anyway
// ---------------------------------------------------------------------------
export const useCan = () => {
  const { data, isLoading } = useAgencyMe();
  const can = useCallback(
    (permission: string) => !!data?.permissions.includes(permission),
    [data]
  );
  return {
    can,
    role: data?.role,
    userId: data?.userId,
    isLoading,
    isClient: data?.role === 'CLIENT',
  };
};

export type { Api };
