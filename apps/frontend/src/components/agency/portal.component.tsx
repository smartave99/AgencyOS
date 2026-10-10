'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';

interface ClientOverview {
  client: {
    id: string;
    name: string;
    companyName: string;
    email?: string;
    phone?: string;
    accountRep?: { name: string; email: string };
  };
  metrics: {
    totalCampaigns: number;
    activeCampaigns: number;
    scheduledCampaigns: number;
    completedCampaigns: number;
    totalLinkClicks: number;
    totalLeads: number;
    successfulPublications: number;
  };
  campaigns: {
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
  }[];
}

interface ClientListItem {
  id: string;
  name: string;
  companyName?: string;
}

export const AgencyPortalComponent: React.FC = () => {
  const fetch = useFetch();
  const toast = useToaster();

  const [clients, setClients] = useState<ClientListItem[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [portalData, setPortalData] = useState<ClientOverview | null>(null);

  // Review modal
  const [reviewCampaignId, setReviewCampaignId] = useState<string | null>(null);
  const [reviewAction, setReviewAction] = useState<'APPROVE' | 'REQUEST_CHANGES'>('APPROVE');
  const [reviewFeedback, setReviewFeedback] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);

  // Load clients list first
  useEffect(() => {
    (async () => {
      try {
        const res = await (await fetch('/agency/clients')).json();
        const clientList = Array.isArray(res) ? res : [];
        setClients(clientList);
        if (clientList.length > 0) {
          setSelectedClientId(clientList[0].id);
        }
      } catch {
        toast.show('Failed to fetch clients list', 'warning');
      } finally {
        setLoading(false);
      }
    })();
  }, [fetch, toast]);

  const loadPortalData = useCallback(async () => {
    if (!selectedClientId) return;
    try {
      setLoading(true);
      const res = await (await fetch(`/agency/portal/${selectedClientId}`)).json();
      setPortalData(res);
    } catch {
      toast.show('Failed to load client portal data', 'warning');
    } finally {
      setLoading(false);
    }
  }, [selectedClientId, fetch, toast]);

  useEffect(() => {
    if (selectedClientId) {
      loadPortalData();
    }
  }, [selectedClientId, loadPortalData]);

  const handleSubmitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewCampaignId || !selectedClientId) return;

    try {
      setSubmittingReview(true);
      const res = await (
        await fetch(`/agency/portal/${selectedClientId}/review`, {
          method: 'POST',
          body: JSON.stringify({
            campaignId: reviewCampaignId,
            action: reviewAction,
            feedback: reviewFeedback || undefined,
          }),
        })
      ).json();

      toast.show(res.message || 'Review submitted successfully', 'success');
      setReviewCampaignId(null);
      setReviewFeedback('');
      await loadPortalData();
    } catch {
      toast.show('Failed to submit client creative review', 'warning');
    } finally {
      setSubmittingReview(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="space-y-8 p-6 text-white max-w-7xl mx-auto printable-portal">
      {/* Print-only CSS styling */}
      <style jsx global>{`
        @media print {
          body { background: white !important; color: black !important; }
          .no-print { display: none !important; }
          .printable-portal { padding: 0 !important; max-width: 100% !important; }
          .portal-card { border: 1px solid #ccc !important; background: white !important; color: black !important; break-inside: avoid; }
          .portal-text { color: black !important; }
        }
      `}</style>

      {/* Header and Client Switcher */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-gray-800 pb-6 no-print">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-extrabold tracking-tight">Client Executive Portal</h1>
            <span className="rounded-full bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-400 border border-blue-500/30">
              Module B — Isolated Client View
            </span>
          </div>
          <p className="mt-1 text-sm text-gray-400">
            Client-facing campaign dashboard, creative approvals, and real-time verified click attribution.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {clients.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">Viewing Client:</span>
              <select
                value={selectedClientId}
                onChange={(e) => setSelectedClientId(e.target.value)}
                className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white focus:border-primary focus:outline-none"
              >
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.companyName || c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button
            onClick={handlePrint}
            className="rounded-lg border border-gray-700 bg-gray-900 px-4 py-2 text-sm font-semibold text-gray-300 hover:bg-gray-800 transition-colors flex items-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/></svg>
            Print / PDF Export
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex h-64 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}

      {!loading && portalData && (
        <>
          {/* Client Presentation Banner */}
          <div className="rounded-xl border border-gray-800 bg-[#14151a] p-6 shadow-sm portal-card">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <span className="text-xs font-semibold text-primary uppercase tracking-wider">Client Report Deck</span>
                <h2 className="text-2xl font-black text-white mt-1 portal-text">{portalData.client.companyName}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-400 portal-text">
                  <span>Primary Contact: <strong className="text-white portal-text">{portalData.client.name}</strong></span>
                  {portalData.client.email && <span>• {portalData.client.email}</span>}
                  {portalData.client.phone && <span>• {portalData.client.phone}</span>}
                </div>
              </div>

              {portalData.client.accountRep && (
                <div className="rounded-lg bg-gray-900/80 border border-gray-800 p-3 text-right">
                  <span className="text-[11px] text-gray-500 uppercase block">Dedicated Account Manager</span>
                  <span className="text-sm font-bold text-white block">{portalData.client.accountRep.name}</span>
                  <span className="text-xs text-primary">{portalData.client.accountRep.email}</span>
                </div>
              )}
            </div>
          </div>

          {/* Client High-Level KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="rounded-xl border border-gray-800 bg-[#14151a] p-4 shadow-sm portal-card">
              <span className="text-xs text-gray-400 portal-text">Active Campaigns</span>
              <p className="mt-2 text-2xl font-bold text-white portal-text">
                {portalData.metrics.activeCampaigns + portalData.metrics.scheduledCampaigns}
              </p>
              <span className="text-[11px] text-gray-500">Live or scheduled</span>
            </div>

            <div className="rounded-xl border border-gray-800 bg-[#14151a] p-4 shadow-sm portal-card">
              <span className="text-xs text-gray-400 portal-text">Audience Traffic (Clicks)</span>
              <p className="mt-2 text-2xl font-bold text-emerald-400 portal-text">
                {portalData.metrics.totalLinkClicks.toLocaleString()}
              </p>
              <span className="text-[11px] text-gray-500">Verified unique clicks</span>
            </div>

            <div className="rounded-xl border border-gray-800 bg-[#14151a] p-4 shadow-sm portal-card">
              <span className="text-xs text-gray-400 portal-text">Captured Opt-In Leads</span>
              <p className="mt-2 text-2xl font-bold text-blue-400 portal-text">
                {portalData.metrics.totalLeads.toLocaleString()}
              </p>
              <span className="text-[11px] text-gray-500">Qualified leads</span>
            </div>

            <div className="rounded-xl border border-gray-800 bg-[#14151a] p-4 shadow-sm portal-card">
              <span className="text-xs text-gray-400 portal-text">Broadcast Posts</span>
              <p className="mt-2 text-2xl font-bold text-purple-400 portal-text">
                {portalData.metrics.successfulPublications.toLocaleString()}
              </p>
              <span className="text-[11px] text-gray-500">Delivered placements</span>
            </div>
          </div>

          {/* Campaign Creative Reviews & Schedule */}
          <div className="space-y-6">
            <div className="flex items-center justify-between border-b border-gray-800 pb-3">
              <h3 className="text-lg font-bold text-white portal-text">Campaign Portfolio & Creative Approval Deck</h3>
              <span className="text-xs text-gray-400">{portalData.campaigns.length} Total Campaigns</span>
            </div>

            {portalData.campaigns.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-800 p-8 text-center text-gray-400">
                No campaigns have been created for this client yet.
              </div>
            ) : (
              portalData.campaigns.map((camp) => (
                <div key={camp.id} className="rounded-xl border border-gray-800 bg-[#14151a] p-6 shadow-sm portal-card space-y-4">
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-b border-gray-800 pb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-lg font-bold text-white portal-text">{camp.name}</h4>
                        <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-300 uppercase">
                          {camp.objective}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        Destinations: {camp.destinationsCount} authorized groups/channels
                        {camp.startDate && ` • Scheduled: ${new Date(camp.startDate).toLocaleDateString()}`}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-3 py-1 text-xs font-bold border ${
                          camp.status === 'COMPLETED'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                            : camp.status === 'PUBLISHING'
                            ? 'bg-blue-500/10 text-blue-400 border-blue-500/30'
                            : camp.status === 'APPROVED'
                            ? 'bg-purple-500/10 text-purple-400 border-purple-500/30'
                            : camp.status === 'SUBMITTED' || camp.status === 'UNDER_REVIEW'
                            ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                            : 'bg-gray-500/10 text-gray-400 border-gray-500/30'
                        }`}
                      >
                        {camp.status}
                      </span>
                    </div>
                  </div>

                  {/* Creative Preview Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Live Preview Card */}
                    <div className="md:col-span-2 rounded-lg border border-gray-800 bg-gray-900/50 p-4">
                      <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-2">
                        Creative Preview (Destination Format)
                      </span>

                      {camp.contentMedia && camp.contentMedia.length > 0 && (
                        <div className="mb-3 rounded overflow-hidden max-h-48 bg-black/40 flex items-center justify-center">
                          <img
                            src={camp.contentMedia[0]}
                            alt="Campaign Creative"
                            className="object-cover w-full h-full"
                          />
                        </div>
                      )}

                      {camp.contentTitle && (
                        <h5 className="font-bold text-white text-base mb-1 portal-text">{camp.contentTitle}</h5>
                      )}
                      <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap font-sans portal-text">
                        {camp.contentBody || 'No copy entered yet.'}
                      </p>

                      {(camp.ctaLink || camp.telegramChannelLink) && (
                        <div className="mt-4 flex flex-wrap gap-2 pt-2 border-t border-gray-800">
                          {camp.ctaLink && (
                            <a
                              href={camp.ctaLink}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-semibold text-white"
                            >
                              {camp.ctaText || 'Learn More'} ↗
                            </a>
                          )}
                          {camp.telegramChannelLink && (
                            <a
                              href={camp.telegramChannelLink}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1.5 rounded bg-[#229ED9]/20 text-[#229ED9] border border-[#229ED9]/40 px-3 py-1.5 text-xs font-semibold"
                            >
                              Join Telegram Community ↗
                            </a>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Performance & Action Column */}
                    <div className="flex flex-col justify-between space-y-4">
                      <div className="rounded-lg bg-gray-900/30 border border-gray-800 p-4 space-y-2">
                        <span className="text-xs font-semibold text-gray-400 block">Performance Summary</span>
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-400">Tracked Clicks:</span>
                          <span className="font-bold text-emerald-400">{camp.totalClicks.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-400">Opt-in Leads:</span>
                          <span className="font-bold text-blue-400">{camp.leadsCount.toLocaleString()}</span>
                        </div>
                      </div>

                      {/* Client Approval Controls */}
                      {(camp.status === 'SUBMITTED' || camp.status === 'UNDER_REVIEW') && (
                        <div className="no-print rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
                          <span className="text-xs font-bold text-amber-400 block">Client Review Awaiting</span>
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                setReviewCampaignId(camp.id);
                                setReviewAction('APPROVE');
                              }}
                              className="flex-1 rounded bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-500 transition-colors"
                            >
                              Approve Creative
                            </button>
                            <button
                              onClick={() => {
                                setReviewCampaignId(camp.id);
                                setReviewAction('REQUEST_CHANGES');
                              }}
                              className="flex-1 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-400 hover:bg-rose-500/20 transition-colors"
                            >
                              Request Changes
                            </button>
                          </div>
                        </div>
                      )}

                      {(camp.status === 'APPROVED' || camp.status === 'SCHEDULED') && (
                        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-center">
                          <span className="text-xs font-bold text-emerald-400">
                            Creative Approved & Queued
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {/* Review Modal */}
      {reviewCampaignId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm no-print">
          <div className="w-full max-w-md rounded-xl border border-gray-800 bg-[#1a1b22] p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-white">
              {reviewAction === 'APPROVE' ? 'Approve Campaign Creative' : 'Request Creative Changes'}
            </h3>
            <p className="text-xs text-gray-400 mt-1">
              {reviewAction === 'APPROVE'
                ? 'Confirming approval authorizes the agency scheduler to publish to target destinations.'
                : 'Provide feedback for the copywriting and campaign team.'}
            </p>

            <form onSubmit={handleSubmitReview} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1">
                  {reviewAction === 'APPROVE' ? 'Approval Notes (Optional)' : 'Required Revisions & Feedback *'}
                </label>
                <textarea
                  rows={4}
                  required={reviewAction === 'REQUEST_CHANGES'}
                  value={reviewFeedback}
                  onChange={(e) => setReviewFeedback(e.target.value)}
                  placeholder={
                    reviewAction === 'APPROVE'
                      ? 'e.g. Looks great, proceed with scheduled broadcast.'
                      : 'e.g. Please update the discount percentage and change CTA button text.'
                  }
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white focus:border-primary focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setReviewCampaignId(null)}
                  className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingReview}
                  className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${
                    reviewAction === 'APPROVE' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-rose-600 hover:bg-rose-500'
                  }`}
                >
                  {submittingReview ? 'Submitting...' : reviewAction === 'APPROVE' ? 'Confirm Approval' : 'Send Revisions'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
