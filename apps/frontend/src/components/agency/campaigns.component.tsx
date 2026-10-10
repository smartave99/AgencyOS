'use client';

import React, { useCallback, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import clsx from 'clsx';
import Link from 'next/link';

interface Campaign {
  id: string;
  name: string;
  objective: string;
  status: string;
  budget: string | null;
  startDate: string | null;
  endDate: string | null;
  contentTitle: string | null;
  contentBody: string;
  createdAt: string;
  customer: { id: string; name: string; companyName: string | null };
  createdBy: { id: string; name: string; email: string };
  destinations: Array<{
    id: string;
    destinationType: string;
    telegramDestination?: { id: string; title: string; chatId: string; isAuthorized: boolean };
    integration?: { id: string; name: string; type: string };
  }>;
  _count: { publishingEvents: number; leads: number };
}

export const AgencyCampaignsComponent = () => {
  const fetch = useFetch();
  const toaster = useToaster();
  const [selectedStatus, setSelectedStatus] = useState<string>('ALL');
  const [search, setSearch] = useState('');

  const loadCampaigns = useCallback(async () => {
    const params = new URLSearchParams();
    if (selectedStatus !== 'ALL') params.append('status', selectedStatus);
    if (search) params.append('search', search);

    const res = await fetch(`/agency/campaigns?${params.toString()}`);
    if (!res.ok) throw new Error('Failed to load campaigns');
    return res.json() as Promise<Campaign[]>;
  }, [fetch, selectedStatus, search]);

  const { data: campaigns, isLoading, mutate } = useSWR(['agency-campaigns', selectedStatus, search], loadCampaigns);

  const handleSubmitForApproval = async (campaignId: string) => {
    try {
      const res = await fetch(`/agency/campaigns/${campaignId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'Submitted for manager review' }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Failed to submit campaign');
      }
      toaster.show('Campaign submitted for review', 'success');
      mutate();
    } catch (err: any) {
      toaster.show(err.message || 'Submission failed', 'warning');
    }
  };

  const handleScheduleCampaign = async (campaignId: string) => {
    try {
      const res = await fetch(`/agency/campaigns/${campaignId}/schedule`, {
        method: 'POST',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Failed to schedule campaign');
      }
      toaster.show('Campaign scheduled for delivery!', 'success');
      mutate();
    } catch (err: any) {
      toaster.show(err.message || 'Scheduling failed', 'warning');
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'APPROVED':
      case 'SCHEDULED':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      case 'PUBLISHING':
        return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
      case 'SUBMITTED':
      case 'UNDER_REVIEW':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
      case 'CHANGES_REQUESTED':
      case 'FAILED':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
      case 'COMPLETED':
        return 'bg-purple-500/10 text-purple-400 border-purple-500/20';
      default:
        return 'bg-slate-500/10 text-slate-400 border-slate-500/20';
    }
  };

  const statusTabs = [
    { label: 'All Campaigns', value: 'ALL' },
    { label: 'Draft', value: 'DRAFT' },
    { label: 'Submitted', value: 'SUBMITTED' },
    { label: 'Approved', value: 'APPROVED' },
    { label: 'Scheduled', value: 'SCHEDULED' },
    { label: 'Completed', value: 'COMPLETED' },
  ];

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-newBgLineColor pb-5">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/agency/dashboard" className="text-xs text-blue-400 hover:underline">
              ← Dashboard
            </Link>
            <span className="text-xs text-textItemBlur">/</span>
            <span className="text-xs text-textItemBlur">Advertising Campaigns</span>
          </div>
          <h1 className="text-2xl font-bold text-newTextColor tracking-tight mt-1">
            Advertising Campaign Registry
          </h1>
          <p className="text-xs text-textItemBlur mt-0.5">
            Manage advertising briefs, creative content, multi-destination fan-out, and approvals.
          </p>
        </div>

        <Link
          href="/agency/campaigns/new"
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-all"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M12 5v14" />
          </svg>
          Create New Campaign
        </Link>
      </div>

      {/* Tabs and Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* Status Tabs */}
        <div className="flex items-center gap-1 bg-newBgColorInner border border-newBgLineColor p-1 rounded-xl">
          {statusTabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setSelectedStatus(tab.value)}
              className={clsx(
                'px-3 py-1.5 text-xs font-medium rounded-lg transition-all',
                selectedStatus === tab.value
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-textItemBlur hover:text-newTextColor'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative w-72">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 text-textItemBlur"
            xmlns="http://www.w3.org/2000/svg"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            placeholder="Search campaigns..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-newBgColorInner border border-newBgLineColor rounded-lg pl-9 pr-3 py-1.5 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      {/* Campaign Cards Grid */}
      {isLoading ? (
        <div className="py-20 text-center text-xs text-textItemBlur">Loading campaigns...</div>
      ) : !campaigns || campaigns.length === 0 ? (
        <div className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-16 flex flex-col items-center justify-center text-center">
          <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 mb-3">
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>
          <p className="text-sm font-semibold text-newTextColor">No campaigns matching this view</p>
          <p className="text-xs text-textItemBlur mt-1 max-w-sm">
            Create an advertisement campaign, assign destinations, and submit it for manager review.
          </p>
          <Link
            href="/agency/campaigns/new"
            className="mt-4 px-4 py-2 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-500 transition-all"
          >
            Create New Campaign
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {campaigns.map((camp) => (
            <div
              key={camp.id}
              className="bg-newBgColorInner border border-newBgLineColor rounded-xl p-4 flex flex-col justify-between hover:border-slate-700 transition-all gap-4"
            >
              {/* Header */}
              <div>
                <div className="flex items-start justify-between gap-2">
                  <span className={clsx('px-2 py-0.5 rounded text-[10px] font-semibold border', getStatusBadge(camp.status))}>
                    {camp.status}
                  </span>
                  <span className="text-[11px] text-textItemBlur font-medium">
                    {camp.customer?.companyName || camp.customer?.name}
                  </span>
                </div>

                <h3 className="text-sm font-bold text-newTextColor mt-2 leading-snug">
                  {camp.name}
                </h3>

                <p className="text-xs text-textItemBlur line-clamp-2 mt-1">
                  {camp.contentBody}
                </p>
              </div>

              {/* Destinations & Budget Metadata */}
              <div className="flex flex-col gap-2 pt-3 border-t border-newBgLineColor/60 text-xs">
                <div className="flex items-center justify-between text-textItemBlur">
                  <span>Destinations</span>
                  <span className="text-newTextColor font-medium">
                    {camp.destinations?.length ?? 0} targeted
                  </span>
                </div>

                {camp.budget && (
                  <div className="flex items-center justify-between text-textItemBlur">
                    <span>Campaign Budget</span>
                    <span className="text-newTextColor font-semibold">
                      ${Number(camp.budget).toLocaleString()}
                    </span>
                  </div>
                )}

                {camp.startDate && (
                  <div className="flex items-center justify-between text-textItemBlur">
                    <span>Schedule</span>
                    <span className="text-newTextColor">
                      {new Date(camp.startDate).toLocaleDateString()}
                    </span>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2 pt-2 border-t border-newBgLineColor/60">
                {camp.status === 'DRAFT' && (
                  <button
                    onClick={() => handleSubmitForApproval(camp.id)}
                    className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-all text-center"
                  >
                    Submit for Approval
                  </button>
                )}

                {camp.status === 'APPROVED' && (
                  <button
                    onClick={() => handleScheduleCampaign(camp.id)}
                    className="flex-1 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition-all text-center"
                  >
                    Schedule Delivery
                  </button>
                )}

                {camp.status === 'SCHEDULED' && (
                  <div className="flex-1 py-1.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-medium rounded-lg text-center">
                    Queued for Auto-Posting
                  </div>
                )}

                {camp.status === 'SUBMITTED' && (
                  <div className="flex-1 py-1.5 bg-amber-500/10 text-amber-400 border border-amber-500/20 text-xs font-medium rounded-lg text-center">
                    Awaiting Manager Review
                  </div>
                )}

                <Link
                  href={`/agency/campaigns/${camp.id}`}
                  className="px-3 py-1.5 bg-newBgColor hover:bg-slate-800 text-newTextColor border border-newBgLineColor text-xs rounded-lg transition-colors"
                >
                  Details
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
