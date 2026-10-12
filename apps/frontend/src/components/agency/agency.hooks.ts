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

export interface DestinationView {
  id: string;
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
  deliveryRate: number | null;
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
const useResource = <T>(
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
