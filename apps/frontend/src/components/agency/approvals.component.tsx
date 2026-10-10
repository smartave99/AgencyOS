'use client';

import React, { useCallback, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import clsx from 'clsx';
import Link from 'next/link';

interface ApprovalItem {
  id: string;
  status: string;
  submissionNotes: string | null;
  reviewNotes: string | null;
  createdAt: string;
  reviewedAt: string | null;
  submittedByUser: { id: string; name: string; email: string };
  reviewedByUser?: { id: string; name: string; email: string };
  campaign: {
    id: string;
    name: string;
    status: string;
    contentTitle: string | null;
    contentBody: string;
    budget: string | null;
    customer: { id: string; name: string; companyName: string | null };
    destinations: Array<{
      id: string;
      telegramDestination?: { title: string; type: string };
      integration?: { name: string; type: string };
    }>;
  };
}

export const AgencyApprovalsComponent = () => {
  const fetch = useFetch();
  const toaster = useToaster();
  const [filter, setFilter] = useState<string>('PENDING');

  // Review Dialog State
  const [activeReviewId, setActiveReviewId] = useState<string | null>(null);
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [reviewNotes, setReviewNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadApprovals = useCallback(async () => {
    const query = filter !== 'ALL' ? `?status=${filter}` : '';
    const res = await fetch(`/agency/approvals${query}`);
    if (!res.ok) throw new Error('Failed to load approvals');
    return res.json() as Promise<ApprovalItem[]>;
  }, [fetch, filter]);

  const { data: approvals, isLoading, mutate } = useSWR(['agency-approvals', filter], loadApprovals);

  const handleReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeReviewId) return;

    setIsSubmitting(true);
    try {
      const res = await fetch(`/agency/approvals/${activeReviewId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          notes: reviewNotes.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Failed to submit review');
      }

      toaster.show(
        decision === 'APPROVE' ? 'Campaign approved!' : 'Changes requested from submitter',
        'success'
      );
      setActiveReviewId(null);
      setReviewNotes('');
      mutate();
    } catch (err: any) {
      toaster.show(err.message || 'Review failed', 'warning');
    } finally {
      setIsSubmitting(false);
    }
  };

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
            <span className="text-xs text-textItemBlur">Governance & Reviews</span>
          </div>
          <h1 className="text-2xl font-bold text-newTextColor tracking-tight mt-1">
            Campaign Approval Inbox
          </h1>
          <p className="text-xs text-textItemBlur mt-0.5">
            Review submitted promotional copy, budgets, and target destinations before scheduling.
          </p>
        </div>

        {/* Status Filter */}
        <div className="flex items-center gap-1 bg-newBgColorInner border border-newBgLineColor p-1 rounded-xl">
          {['PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'ALL'].map((status) => (
            <button
              key={status}
              onClick={() => setFilter(status)}
              className={clsx(
                'px-3 py-1.5 text-xs font-semibold rounded-lg transition-all',
                filter === status
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-textItemBlur hover:text-newTextColor'
              )}
            >
              {status.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {/* Approvals List */}
      {isLoading ? (
        <div className="py-20 text-center text-xs text-textItemBlur">Loading approvals inbox...</div>
      ) : !approvals || approvals.length === 0 ? (
        <div className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-16 flex flex-col items-center justify-center text-center">
          <div className="w-12 h-12 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center mb-3">
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <p className="text-sm font-semibold text-newTextColor">Inbox Clear</p>
          <p className="text-xs text-textItemBlur mt-1 max-w-sm">
            There are no campaigns waiting for review in this category.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {approvals.map((item) => (
            <div
              key={item.id}
              className="bg-newBgColorInner border border-newBgLineColor rounded-xl p-5 flex flex-col lg:flex-row gap-6 justify-between hover:border-slate-700 transition-colors"
            >
              {/* Campaign Brief Info */}
              <div className="flex-1 flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className={clsx(
                      'px-2.5 py-0.5 rounded text-[11px] font-semibold border',
                      item.status === 'APPROVED'
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                        : item.status === 'PENDING'
                        ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                        : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                    )}
                  >
                    {item.status}
                  </span>
                  <span className="text-xs text-textItemBlur">
                    Submitted by {item.submittedByUser?.name || 'Sales Rep'} on{' '}
                    {new Date(item.createdAt).toLocaleDateString()}
                  </span>
                </div>

                <div>
                  <h3 className="text-base font-bold text-newTextColor">
                    {item.campaign.name}
                  </h3>
                  <div className="text-xs text-textItemBlur mt-0.5">
                    Client: <span className="text-newTextColor font-medium">{item.campaign.customer?.companyName || item.campaign.customer?.name}</span>
                    {item.campaign.budget && ` • Budget: $${item.campaign.budget}`}
                  </div>
                </div>

                {/* Promotional Copy Box */}
                <div className="p-3.5 rounded-lg bg-newBgColor border border-newBgLineColor text-xs text-newTextColor whitespace-pre-wrap max-h-36 overflow-y-auto">
                  {item.campaign.contentBody}
                </div>

                {item.submissionNotes && (
                  <div className="text-xs text-textItemBlur italic">
                    Notes: "{item.submissionNotes}"
                  </div>
                )}
              </div>

              {/* Destinations & Action Controls */}
              <div className="lg:w-72 flex flex-col justify-between border-t lg:border-t-0 lg:border-l border-newBgLineColor pt-4 lg:pt-0 lg:pl-6 gap-4">
                <div>
                  <span className="text-[11px] font-semibold text-textItemBlur uppercase">
                    Target Destinations ({item.campaign.destinations?.length ?? 0})
                  </span>
                  <div className="flex flex-col gap-1.5 mt-2">
                    {(item.campaign.destinations || []).slice(0, 4).map((d, i) => (
                      <div key={i} className="text-xs text-newTextColor truncate flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                        {d.telegramDestination?.title || d.integration?.name || 'Social Account'}
                      </div>
                    ))}
                    {(item.campaign.destinations?.length ?? 0) > 4 && (
                      <div className="text-[11px] text-textItemBlur">
                        + {item.campaign.destinations.length - 4} more
                      </div>
                    )}
                  </div>
                </div>

                {/* Actions */}
                {item.status === 'PENDING' ? (
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => {
                        setActiveReviewId(item.id);
                        setDecision('APPROVE');
                      }}
                      className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-all"
                    >
                      Approve Campaign
                    </button>
                    <button
                      onClick={() => {
                        setActiveReviewId(item.id);
                        setDecision('REJECT');
                      }}
                      className="w-full py-2 bg-newBgColor hover:bg-slate-800 text-rose-400 border border-rose-500/20 text-xs font-semibold rounded-lg transition-all"
                    >
                      Request Changes
                    </button>
                  </div>
                ) : (
                  <div className="text-xs text-textItemBlur">
                    Reviewed on {item.reviewedAt ? new Date(item.reviewedAt).toLocaleDateString() : 'N/A'}
                    {item.reviewNotes && <div className="italic mt-1">"{item.reviewNotes}"</div>}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Review Confirmation Modal */}
      {activeReviewId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-6 max-w-md w-full shadow-2xl flex flex-col gap-4">
            <h3 className="text-base font-bold text-newTextColor">
              {decision === 'APPROVE' ? 'Approve Advertising Campaign' : 'Request Changes'}
            </h3>
            <p className="text-xs text-textItemBlur">
              {decision === 'APPROVE'
                ? 'Approving this campaign unlocks scheduling and automated publishing.'
                : 'Send the campaign back to the sales executive with change instructions.'}
            </p>

            <form onSubmit={handleReview} className="flex flex-col gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                  Manager Review Notes
                </label>
                <textarea
                  rows={3}
                  placeholder={decision === 'APPROVE' ? 'Optional approval notes...' : 'Explain required changes...'}
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500 resize-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-newBgLineColor">
                <button
                  type="button"
                  onClick={() => setActiveReviewId(null)}
                  className="px-3 py-1.5 rounded-lg border border-newBgLineColor text-xs text-textItemBlur hover:text-newTextColor"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className={clsx(
                    'px-4 py-1.5 text-white text-xs font-semibold rounded-lg shadow-sm transition-all',
                    decision === 'APPROVE' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-rose-600 hover:bg-rose-500'
                  )}
                >
                  {isSubmitting ? 'Submitting...' : decision === 'APPROVE' ? 'Confirm Approval' : 'Submit Feedback'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
