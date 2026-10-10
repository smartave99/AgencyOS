'use client';

import React, { useCallback, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import clsx from 'clsx';
import Link from 'next/link';

interface TelegramDestination {
  id: string;
  chatId: string;
  title: string;
  type: string;
  botUsername: string | null;
  isAuthorized: boolean;
  canPostMessages: boolean;
  canDeleteMessages: boolean;
  canInviteUsers: boolean;
  lastVerifiedAt: string;
  lastError: string | null;
  _count: { campaignDestinations: number; publishingEvents: number };
}

interface PublishingEvent {
  id: string;
  externalMessageId: string | null;
  releaseUrl: string | null;
  status: string;
  errorMessage: string | null;
  executedAt: string;
  campaign?: { id: string; name: string };
  telegramDestination?: { id: string; title: string; type: string };
}

export const AgencyTelegramComponent = () => {
  const fetch = useFetch();
  const toaster = useToaster();

  // Onboarding Wizard State
  const [chatIdInput, setChatIdInput] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [verificationResult, setVerificationResult] = useState<{
    valid: boolean;
    title: string;
    type: string;
    botIsAdmin: boolean;
    canPostMessages: boolean;
    canDeleteMessages: boolean;
    canInviteUsers: boolean;
    error?: string;
  } | null>(null);

  // Load Destinations
  const loadDestinations = useCallback(async () => {
    const res = await fetch('/agency/telegram/destinations');
    if (!res.ok) throw new Error('Failed to load Telegram destinations');
    return res.json() as Promise<TelegramDestination[]>;
  }, [fetch]);

  const { data: destinations, isLoading, mutate } = useSWR('telegram-destinations', loadDestinations);

  // Load Events
  const loadEvents = useCallback(async () => {
    const res = await fetch('/agency/telegram/events');
    if (!res.ok) return [];
    return res.json() as Promise<PublishingEvent[]>;
  }, [fetch]);

  const { data: events } = useSWR('telegram-events', loadEvents, { refreshInterval: 10000 });

  const handleVerifyChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatIdInput.trim()) {
      toaster.show('Please enter a Telegram Chat ID or @channelname', 'warning');
      return;
    }

    setIsVerifying(true);
    setVerificationResult(null);

    try {
      const res = await fetch('/agency/telegram/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: chatIdInput.trim() }),
      });

      const data = await res.json();
      setVerificationResult(data);

      if (data.valid) {
        toaster.show('Chat verified! Bot permissions confirmed.', 'success');
      } else {
        toaster.show(data.error || 'Verification failed', 'warning');
      }
    } catch (err: any) {
      toaster.show(err.message || 'Error verifying chat', 'warning');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleRegisterDestination = async () => {
    if (!verificationResult && !chatIdInput.trim()) return;

    setIsRegistering(true);
    try {
      const res = await fetch('/agency/telegram/destinations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: chatIdInput.trim(),
          title: verificationResult?.title || chatIdInput.trim(),
          type: verificationResult?.type || 'channel',
          canPostMessages: verificationResult?.canPostMessages ?? true,
          canDeleteMessages: verificationResult?.canDeleteMessages ?? false,
          canInviteUsers: verificationResult?.canInviteUsers ?? false,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Failed to register destination');
      }

      toaster.show('Telegram destination registered and authorized!', 'success');
      setChatIdInput('');
      setVerificationResult(null);
      mutate();
    } catch (err: any) {
      toaster.show(err.message || 'Registration failed', 'warning');
    } finally {
      setIsRegistering(false);
    }
  };

  const handleDeleteDestination = async (id: string, title: string) => {
    if (!confirm(`Remove destination "${title}" from the authorized agency registry?`)) return;

    try {
      const res = await fetch(`/agency/telegram/destinations/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete destination');
      toaster.show('Destination removed', 'success');
      mutate();
    } catch (err: any) {
      toaster.show(err.message || 'Error deleting destination', 'warning');
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
            <span className="text-xs text-textItemBlur">Telegram Infrastructure</span>
          </div>
          <h1 className="text-2xl font-bold text-newTextColor tracking-tight mt-1">
            Telegram Destination Registry & Bot Authorization
          </h1>
          <p className="text-xs text-textItemBlur mt-0.5">
            Explicitly authorized channels and supergroups with verified bot administrator privileges.
          </p>
        </div>
      </div>

      {/* Two Column Layout: Onboarding Wizard (Left) & Destination Registry (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Onboarding Wizard (5 cols) */}
        <div className="lg:col-span-5 bg-newBgColorInner border border-newBgLineColor rounded-2xl p-6 flex flex-col gap-4">
          <div className="border-b border-newBgLineColor pb-3">
            <h2 className="text-sm font-bold text-newTextColor">
              Onboard & Verify Telegram Destination
            </h2>
            <p className="text-xs text-textItemBlur mt-0.5">
              Verify bot administrator status before adding to campaign destination options.
            </p>
          </div>

          <form onSubmit={handleVerifyChat} className="flex flex-col gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                Chat ID or Public Username *
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  required
                  placeholder="e.g. @yourchannel or -100192837465"
                  value={chatIdInput}
                  onChange={(e) => setChatIdInput(e.target.value)}
                  className="flex-1 bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500 font-mono"
                />
                <button
                  type="submit"
                  disabled={isVerifying}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-all disabled:opacity-50"
                >
                  {isVerifying ? 'Verifying...' : 'Verify'}
                </button>
              </div>
              <p className="text-[11px] text-textItemBlur mt-1">
                Tip: Add your bot as Administrator in the group or channel first.
              </p>
            </div>
          </form>

          {/* Verification Results Panel */}
          {verificationResult && (
            <div className="p-4 rounded-xl bg-newBgColor border border-newBgLineColor flex flex-col gap-3 mt-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-newTextColor">
                  {verificationResult.title || 'Chat Found'}
                </span>
                <span className="text-[11px] uppercase text-textItemBlur font-medium">
                  {verificationResult.type}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className={clsx('w-2 h-2 rounded-full', verificationResult.botIsAdmin ? 'bg-emerald-400' : 'bg-rose-400')} />
                  <span>Admin Status:</span>
                  <strong className={verificationResult.botIsAdmin ? 'text-emerald-400' : 'text-rose-400'}>
                    {verificationResult.botIsAdmin ? 'Yes' : 'No'}
                  </strong>
                </div>

                <div className="flex items-center gap-1.5">
                  <span className={clsx('w-2 h-2 rounded-full', verificationResult.canPostMessages ? 'bg-emerald-400' : 'bg-rose-400')} />
                  <span>Can Post:</span>
                  <strong className={verificationResult.canPostMessages ? 'text-emerald-400' : 'text-rose-400'}>
                    {verificationResult.canPostMessages ? 'Yes' : 'No'}
                  </strong>
                </div>

                <div className="flex items-center gap-1.5">
                  <span className={clsx('w-2 h-2 rounded-full', verificationResult.canDeleteMessages ? 'bg-emerald-400' : 'bg-slate-500')} />
                  <span>Can Delete:</span>
                  <strong className={verificationResult.canDeleteMessages ? 'text-emerald-400' : 'text-slate-400'}>
                    {verificationResult.canDeleteMessages ? 'Yes' : 'No'}
                  </strong>
                </div>

                <div className="flex items-center gap-1.5">
                  <span className={clsx('w-2 h-2 rounded-full', verificationResult.canInviteUsers ? 'bg-emerald-400' : 'bg-slate-500')} />
                  <span>Can Invite:</span>
                  <strong className={verificationResult.canInviteUsers ? 'text-emerald-400' : 'text-slate-400'}>
                    {verificationResult.canInviteUsers ? 'Yes' : 'No'}
                  </strong>
                </div>
              </div>

              {verificationResult.error && (
                <div className="text-xs text-rose-400 bg-rose-500/10 p-2 rounded border border-rose-500/20">
                  {verificationResult.error}
                </div>
              )}

              {verificationResult.valid && (
                <button
                  onClick={handleRegisterDestination}
                  disabled={isRegistering}
                  className="w-full mt-2 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-all"
                >
                  {isRegistering ? 'Registering...' : '✓ Authorize & Save Destination'}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Right: Destination Registry (7 cols) */}
        <div className="lg:col-span-7 bg-newBgColorInner border border-newBgLineColor rounded-2xl p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between border-b border-newBgLineColor pb-3">
            <div>
              <h2 className="text-sm font-bold text-newTextColor">
                Authorized Destination Registry
              </h2>
              <p className="text-xs text-textItemBlur mt-0.5">
                Destinations available for campaign targeting
              </p>
            </div>
            <span className="text-xs text-textItemBlur font-medium">
              {destinations?.length ?? 0} registered
            </span>
          </div>

          {isLoading ? (
            <div className="py-16 text-center text-xs text-textItemBlur">Loading registry...</div>
          ) : !destinations || destinations.length === 0 ? (
            <div className="py-16 flex flex-col items-center justify-center text-center">
              <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 mb-3">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" />
                </svg>
              </div>
              <p className="text-sm font-medium text-newTextColor">No Telegram destinations yet</p>
              <p className="text-xs text-textItemBlur mt-1">
                Use the verification panel on the left to add your first channel or supergroup.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-newBgColor border-b border-newBgLineColor text-textItemBlur font-medium">
                  <tr>
                    <th className="py-2.5 px-3">Destination Title</th>
                    <th className="py-2.5 px-3">Chat ID</th>
                    <th className="py-2.5 px-3">Type</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-newBgLineColor/50">
                  {destinations.map((d) => (
                    <tr key={d.id} className="hover:bg-newBgColor/40 transition-colors">
                      <td className="py-3 px-3 font-semibold text-newTextColor">
                        {d.title}
                      </td>
                      <td className="py-3 px-3 font-mono text-[11px] text-textItemBlur">
                        {d.chatId}
                      </td>
                      <td className="py-3 px-3 uppercase text-[10px] text-textItemBlur">
                        {d.type}
                      </td>
                      <td className="py-3 px-3">
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          Authorized
                        </span>
                      </td>
                      <td className="py-3 px-3 text-right">
                        <button
                          onClick={() => handleDeleteDestination(d.id, d.title)}
                          className="p-1 text-slate-500 hover:text-rose-400 rounded transition-colors"
                          title="Remove Destination"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Real-Time Publishing Delivery Receipts Section */}
      <div className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between border-b border-newBgLineColor pb-3">
          <div>
            <h2 className="text-sm font-bold text-newTextColor">
              Publishing Audit & Delivery Receipts
            </h2>
            <p className="text-xs text-textItemBlur mt-0.5">
              Live broadcast telemetry with Telegram external message IDs and clickable links.
            </p>
          </div>
          <span className="text-xs text-emerald-400 flex items-center gap-1.5 font-medium">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Live Logging Active
          </span>
        </div>

        {!events || events.length === 0 ? (
          <div className="py-12 text-center text-xs text-textItemBlur">
            No broadcast delivery events recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-newBgColor border-b border-newBgLineColor text-textItemBlur font-medium">
                <tr>
                  <th className="py-2.5 px-3">Executed At</th>
                  <th className="py-2.5 px-3">Campaign</th>
                  <th className="py-2.5 px-3">Destination</th>
                  <th className="py-2.5 px-3">Message ID</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3 text-right">Live Link</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-newBgLineColor/50">
                {events.map((evt) => (
                  <tr key={evt.id} className="hover:bg-newBgColor/40 transition-colors">
                    <td className="py-3 px-3 text-textItemBlur">
                      {new Date(evt.executedAt).toLocaleString()}
                    </td>
                    <td className="py-3 px-3 font-medium text-newTextColor">
                      {evt.campaign?.name || 'Campaign'}
                    </td>
                    <td className="py-3 px-3 text-textItemBlur">
                      {evt.telegramDestination?.title || 'Telegram'}
                    </td>
                    <td className="py-3 px-3 font-mono text-[11px] text-textItemBlur">
                      {evt.externalMessageId || 'N/A'}
                    </td>
                    <td className="py-3 px-3">
                      <span
                        className={clsx(
                          'px-2 py-0.5 rounded text-[10px] font-semibold border',
                          evt.status === 'SUCCESS'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                        )}
                      >
                        {evt.status}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right">
                      {evt.releaseUrl ? (
                        <a
                          href={evt.releaseUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-400 hover:underline font-medium"
                        >
                          View on Telegram ↗
                        </a>
                      ) : (
                        <span className="text-textItemBlur">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
