'use client';

import React, { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import Link from 'next/link';

interface DashboardMetrics {
  activeClientsCount: number;
  activeCampaignsCount: number;
  totalCampaignsCount: number;
  pendingApprovalsCount: number;
  telegramDestinationsCount: number;
  connectedSocialCount: number;
  successfulPosts: number;
  failedPosts: number;
  recentCampaigns: Array<{
    id: string;
    name: string;
    status: string;
    customer: { name: string; companyName: string | null };
    createdAt: string;
    _count: { destinations: number; publishingEvents: number };
  }>;
  recentEvents: Array<{
    id: string;
    status: string;
    executedAt: string;
    campaign: { name: string };
    telegramDestination?: { title: string };
  }>;
}

export const AgencyDashboardComponent = () => {
  const fetch = useFetch();
  const router = useRouter();

  const loadDashboard = useCallback(async () => {
    const res = await fetch('/agency/dashboard');
    if (!res.ok) throw new Error('Failed to load dashboard metrics');
    return res.json() as Promise<DashboardMetrics>;
  }, [fetch]);

  const { data, error, isLoading, mutate } = useSWR('agency-dashboard', loadDashboard, {
    revalidateOnFocus: true,
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'APPROVED':
      case 'SCHEDULED':
      case 'SUCCESS':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      case 'PUBLISHING':
        return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
      case 'UNDER_REVIEW':
      case 'SUBMITTED':
      case 'PENDING':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
      case 'FAILED':
      case 'CHANGES_REQUESTED':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
      default:
        return 'bg-slate-500/10 text-slate-400 border-slate-500/20';
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
      {/* Header & Quick Action Row */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-newBgLineColor pb-5">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
              AgencyOS Enterprise
            </span>
            <span className="text-xs text-textItemBlur">Operational Control</span>
          </div>
          <h1 className="text-2xl font-bold text-newTextColor tracking-tight mt-1">
            Executive Agency Dashboard
          </h1>
          <p className="text-xs text-textItemBlur mt-0.5">
            Real-time multi-tenant campaigns, authorized Telegram channels, and client delivery status.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/agency/campaigns/new"
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-all"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M12 5v14" />
            </svg>
            Create Campaign
          </Link>

          <Link
            href="/agency/clients"
            className="flex items-center gap-2 px-3.5 py-2 bg-newBgColor hover:bg-newBgColorInner text-newTextColor border border-newBgLineColor text-xs font-medium rounded-lg transition-all"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            Onboard Client
          </Link>

          <Link
            href="/agency/telegram"
            className="flex items-center gap-2 px-3.5 py-2 bg-newBgColor hover:bg-newBgColorInner text-newTextColor border border-newBgLineColor text-xs font-medium rounded-lg transition-all"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m22 2-7 20-4-9-9-4Z" />
              <path d="M22 2 11 13" />
            </svg>
            Verify Telegram
          </Link>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Active Clients */}
        <div className="bg-newBgColorInner border border-newBgLineColor rounded-xl p-4 flex flex-col justify-between hover:border-slate-700 transition-colors">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-textItemBlur uppercase tracking-wider">Active Clients</span>
            <span className="p-2 rounded-lg bg-blue-500/10 text-blue-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
              </svg>
            </span>
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold text-newTextColor">
              {isLoading ? '...' : data?.activeClientsCount ?? 0}
            </div>
            <div className="text-xs text-textItemBlur mt-1 flex items-center justify-between">
              <span>Managed Portfolios</span>
              <Link href="/agency/clients" className="text-blue-400 hover:underline">View directory →</Link>
            </div>
          </div>
        </div>

        {/* Active Campaigns */}
        <div className="bg-newBgColorInner border border-newBgLineColor rounded-xl p-4 flex flex-col justify-between hover:border-slate-700 transition-colors">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-textItemBlur uppercase tracking-wider">Running Campaigns</span>
            <span className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </span>
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold text-newTextColor">
              {isLoading ? '...' : data?.activeCampaignsCount ?? 0}
            </div>
            <div className="text-xs text-textItemBlur mt-1 flex items-center justify-between">
              <span>Of {data?.totalCampaignsCount ?? 0} Total Campaigns</span>
              <Link href="/agency/campaigns" className="text-emerald-400 hover:underline">Manage →</Link>
            </div>
          </div>
        </div>

        {/* Pending Approvals */}
        <div className="bg-newBgColorInner border border-newBgLineColor rounded-xl p-4 flex flex-col justify-between hover:border-slate-700 transition-colors">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-textItemBlur uppercase tracking-wider">Pending Approvals</span>
            <span className="p-2 rounded-lg bg-amber-500/10 text-amber-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
              </svg>
            </span>
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold text-newTextColor">
              {isLoading ? '...' : data?.pendingApprovalsCount ?? 0}
            </div>
            <div className="text-xs text-textItemBlur mt-1 flex items-center justify-between">
              <span>Review inbox queue</span>
              <Link href="/agency/approvals" className="text-amber-400 hover:underline">Review queue →</Link>
            </div>
          </div>
        </div>

        {/* Authorized Telegram Destinations */}
        <div className="bg-newBgColorInner border border-newBgLineColor rounded-xl p-4 flex flex-col justify-between hover:border-slate-700 transition-colors">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-textItemBlur uppercase tracking-wider">Authorized Telegram</span>
            <span className="p-2 rounded-lg bg-sky-500/10 text-sky-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" />
              </svg>
            </span>
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold text-newTextColor">
              {isLoading ? '...' : data?.telegramDestinationsCount ?? 0}
            </div>
            <div className="text-xs text-textItemBlur mt-1 flex items-center justify-between">
              <span>Verified Bot Destinations</span>
              <Link href="/agency/telegram" className="text-sky-400 hover:underline">Registry →</Link>
            </div>
          </div>
        </div>
      </div>

      {/* Two Column Layout: Recent Campaigns & Delivery Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Recent Campaigns (2 cols) */}
        <div className="lg:col-span-2 bg-newBgColorInner border border-newBgLineColor rounded-xl p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between border-b border-newBgLineColor pb-3">
            <div>
              <h2 className="text-sm font-semibold text-newTextColor">Recent Advertising Campaigns</h2>
              <p className="text-xs text-textItemBlur">Latest campaigns created across client accounts</p>
            </div>
            <Link href="/agency/campaigns" className="text-xs text-blue-400 hover:underline">
              View all ({data?.totalCampaignsCount ?? 0})
            </Link>
          </div>

          {isLoading ? (
            <div className="py-12 text-center text-xs text-textItemBlur">Loading campaigns...</div>
          ) : !data?.recentCampaigns || data.recentCampaigns.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center text-center">
              <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 mb-3">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </div>
              <p className="text-sm font-medium text-newTextColor">No campaigns yet</p>
              <p className="text-xs text-textItemBlur mt-1">Start by creating an advertising campaign for a client.</p>
              <Link href="/agency/campaigns/new" className="mt-4 px-4 py-2 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-500 transition-all">
                Create First Campaign
              </Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-newBgLineColor/60 text-textItemBlur font-medium">
                    <th className="pb-2.5">Campaign Name</th>
                    <th className="pb-2.5">Client</th>
                    <th className="pb-2.5">Status</th>
                    <th className="pb-2.5">Destinations</th>
                    <th className="pb-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-newBgLineColor/40">
                  {data.recentCampaigns.map((camp) => (
                    <tr key={camp.id} className="hover:bg-newBgColor/40 transition-colors">
                      <td className="py-3 font-medium text-newTextColor">
                        <Link href={`/agency/campaigns/${camp.id}`} className="hover:text-blue-400">
                          {camp.name}
                        </Link>
                      </td>
                      <td className="py-3 text-textItemBlur">
                        {camp.customer?.companyName || camp.customer?.name}
                      </td>
                      <td className="py-3">
                        <span className={clsx('px-2 py-0.5 rounded text-[11px] font-medium border', getStatusBadge(camp.status))}>
                          {camp.status}
                        </span>
                      </td>
                      <td className="py-3 text-textItemBlur">
                        {camp._count?.destinations ?? 0} target(s)
                      </td>
                      <td className="py-3 text-right">
                        <Link
                          href={`/agency/campaigns/${camp.id}`}
                          className="px-2.5 py-1 bg-newBgColor hover:bg-slate-700 text-newTextColor rounded border border-newBgLineColor text-[11px]"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right Column: Execution Health & Logs (1 col) */}
        <div className="bg-newBgColorInner border border-newBgLineColor rounded-xl p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between border-b border-newBgLineColor pb-3">
            <div>
              <h2 className="text-sm font-semibold text-newTextColor">Publishing Telemetry</h2>
              <p className="text-xs text-textItemBlur">Authentic delivery audit receipts</p>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-emerald-400 font-medium">Scheduler Online</span>
            </div>
          </div>

          {/* Delivery Stats Bar */}
          <div className="grid grid-cols-2 gap-3 p-3 rounded-lg bg-newBgColor border border-newBgLineColor">
            <div>
              <span className="text-[11px] text-textItemBlur uppercase font-semibold">Delivered Posts</span>
              <div className="text-lg font-bold text-emerald-400 mt-0.5">
                {data?.successfulPosts ?? 0}
              </div>
            </div>
            <div>
              <span className="text-[11px] text-textItemBlur uppercase font-semibold">Failed Retries</span>
              <div className="text-lg font-bold text-rose-400 mt-0.5">
                {data?.failedPosts ?? 0}
              </div>
            </div>
          </div>

          {/* Recent Activity List */}
          <div className="flex flex-col gap-2 mt-1">
            <span className="text-xs font-semibold text-textItemBlur uppercase">Recent Delivery Events</span>
            {isLoading ? (
              <div className="py-6 text-center text-xs text-textItemBlur">Loading logs...</div>
            ) : !data?.recentEvents || data.recentEvents.length === 0 ? (
              <div className="py-6 text-center text-xs text-textItemBlur">No broadcast events logged yet.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {data.recentEvents.map((evt) => (
                  <div key={evt.id} className="p-2.5 rounded-lg bg-newBgColor border border-newBgLineColor/50 flex items-center justify-between">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs font-medium text-newTextColor truncate max-w-[180px]">
                        {evt.campaign?.name}
                      </span>
                      <span className="text-[11px] text-textItemBlur">
                        Destination: {evt.telegramDestination?.title || 'Social'}
                      </span>
                    </div>
                    <span className={clsx('px-2 py-0.5 rounded text-[10px] font-semibold border', getStatusBadge(evt.status))}>
                      {evt.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
