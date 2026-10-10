'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';

interface PlatformCapability {
  identifier: string;
  name: string;
  description: string;
  maxTextLength: number;
  supportsImages: boolean;
  supportsVideos: boolean;
  maxVideoDurationSeconds?: number;
  supportsLinks: boolean;
  supportsFormatting: 'MARKDOWN_HTML' | 'PLAIN_TEXT' | 'LIMITED';
  destinationTypes: string[];
  supportsDirectMessage: boolean;
  schedulingSupported: boolean;
  rateLimitPerMinute: number;
  complianceNotes: string;
}

interface AccountHealthSummary {
  id: string;
  name: string;
  provider: string;
  profile?: string;
  client?: { id: string; name: string; companyName?: string };
  healthStatus: 'HEALTHY' | 'NEEDS_REFRESH' | 'EXPIRED' | 'DISABLED';
  tokenExpiration?: string;
  refreshNeeded: boolean;
  disabled: boolean;
  capabilities: PlatformCapability;
}

interface ClientOption {
  id: string;
  name: string;
  companyName?: string;
}

export const AgencyAccountsComponent: React.FC = () => {
  const fetch = useFetch();
  const toast = useToaster();

  const [loading, setLoading] = useState(true);
  const [capabilities, setCapabilities] = useState<PlatformCapability[]>([]);
  const [accounts, setAccounts] = useState<AccountHealthSummary[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [testingId, setTestingId] = useState<string | null>(null);

  // Assign modal
  const [assigningAccount, setAssigningAccount] = useState<AccountHealthSummary | null>(null);
  const [selectedClientId, setSelectedClientId] = useState('');

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [capsRes, accsRes, clientsRes] = await Promise.all([
        (await fetch('/agency/platforms/capabilities')).json(),
        (await fetch('/agency/accounts')).json(),
        (await fetch('/agency/clients')).json(),
      ]);

      setCapabilities(Array.isArray(capsRes) ? capsRes : []);
      setAccounts(Array.isArray(accsRes) ? accsRes : []);
      setClients(Array.isArray(clientsRes) ? clientsRes : []);
    } catch {
      toast.show('Failed to load platform registry', 'warning');
    } finally {
      setLoading(false);
    }
  }, [fetch, toast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleTestConnection = async (id: string) => {
    try {
      setTestingId(id);
      const res = await (
        await fetch(`/agency/accounts/${id}/test-connection`, {
          method: 'POST',
        })
      ).json();

      if (res.healthy) {
        toast.show(res.message || 'Connection test successful', 'success');
      } else {
        toast.show(res.message || 'Connection requires attention', 'warning');
      }
    } catch {
      toast.show('Failed to run diagnostic test', 'warning');
    } finally {
      setTestingId(null);
    }
  };

  const handleAssignClient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assigningAccount || !selectedClientId) return;

    try {
      await fetch(`/agency/accounts/${assigningAccount.id}/assign-client`, {
        method: 'POST',
        body: JSON.stringify({ customerId: selectedClientId }),
      });
      toast.show('Account linked to client successfully', 'success');
      setAssigningAccount(null);
      setSelectedClientId('');
      await loadData();
    } catch {
      toast.show('Failed to link account to client', 'warning');
    }
  };

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-8 p-6 text-white max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-gray-800 pb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-extrabold tracking-tight">Platform Registry & Account Health</h1>
            <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-400 border border-emerald-500/30">
              Module G & H — Cross-Platform
            </span>
          </div>
          <p className="mt-1 text-sm text-gray-400">
            Official capabilities, token validity diagnostics, and client-channel routing across all social networks.
          </p>
        </div>
      </div>

      {/* Connected Accounts Table */}
      <div className="rounded-xl border border-gray-800 bg-[#14151a] p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-white">Connected Publishing Accounts</h2>
            <p className="text-xs text-gray-400">Active agency-authorized social accounts and Telegram bots with health telemetry.</p>
          </div>
          <span className="text-xs text-gray-500 font-mono">
            {accounts.length} Total Accounts
          </span>
        </div>

        {accounts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-800 p-8 text-center">
            <p className="text-sm text-gray-400">No social accounts connected yet in this workspace.</p>
            <p className="text-xs text-gray-500 mt-1">Connect your Telegram bots in the Telegram Registry or link OAuth channels in Settings.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-800 text-xs font-semibold uppercase text-gray-400">
                <tr>
                  <th className="py-3 px-4">Account Name</th>
                  <th className="py-3 px-4">Platform</th>
                  <th className="py-3 px-4">Associated Client</th>
                  <th className="py-3 px-4">Health Status</th>
                  <th className="py-3 px-4">Expires</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/60">
                {accounts.map((acc) => (
                  <tr key={acc.id} className="hover:bg-gray-900/40 transition-colors">
                    <td className="py-3.5 px-4 font-semibold text-white">
                      {acc.name}
                      {acc.profile && <span className="block text-xs font-normal text-gray-500">@{acc.profile}</span>}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="rounded bg-gray-800 px-2 py-0.5 text-xs font-semibold text-gray-300 uppercase">
                        {acc.provider}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-gray-300">
                      {acc.client ? (
                        <span className="font-medium text-white">{acc.client.companyName || acc.client.name}</span>
                      ) : (
                        <span className="text-xs text-gray-500 italic">Agency Default</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold border ${
                          acc.healthStatus === 'HEALTHY'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                            : acc.healthStatus === 'NEEDS_REFRESH'
                            ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                            : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                        }`}
                      >
                        {acc.healthStatus}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-xs text-gray-400">
                      {acc.tokenExpiration ? new Date(acc.tokenExpiration).toLocaleDateString() : 'Permanent / Bot'}
                    </td>
                    <td className="py-3.5 px-4 text-right space-x-2">
                      <button
                        onClick={() => handleTestConnection(acc.id)}
                        disabled={testingId === acc.id}
                        className="rounded border border-gray-700 bg-gray-900 px-2.5 py-1 text-xs text-gray-300 hover:bg-gray-800 transition-colors"
                      >
                        {testingId === acc.id ? 'Testing...' : 'Test Connection'}
                      </button>
                      <button
                        onClick={() => {
                          setAssigningAccount(acc);
                          setSelectedClientId(acc.client?.id || '');
                        }}
                        className="rounded border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs text-primary hover:bg-primary/20 transition-colors"
                      >
                        Assign Client
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Official Platform Capability Registry Grid */}
      <div>
        <div className="mb-4">
          <h2 className="text-lg font-bold text-white">Platform Capability Registry</h2>
          <p className="text-xs text-gray-400">Official technical constraints, formatting support, and compliance specifications.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {capabilities.map((cap) => (
            <div key={cap.identifier} className="rounded-xl border border-gray-800 bg-[#14151a] p-5 shadow-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-white text-base">{cap.name}</h3>
                  <span className="rounded bg-primary/10 text-primary px-2 py-0.5 text-xs font-semibold">
                    {cap.rateLimitPerMinute} req/m
                  </span>
                </div>
                <p className="mt-2 text-xs text-gray-400 leading-relaxed">{cap.description}</p>

                <div className="mt-4 space-y-2 text-xs border-t border-gray-800/80 pt-3">
                  <div className="flex justify-between text-gray-300">
                    <span className="text-gray-500">Max Characters:</span>
                    <span className="font-mono font-semibold">{cap.maxTextLength.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-gray-300">
                    <span className="text-gray-500">Formatting:</span>
                    <span className="font-semibold">{cap.supportsFormatting}</span>
                  </div>
                  <div className="flex justify-between text-gray-300">
                    <span className="text-gray-500">Media:</span>
                    <span>{cap.supportsImages ? ' Images' : ''}{cap.supportsVideos ? ' Videos' : ''}</span>
                  </div>
                  <div className="flex justify-between text-gray-300">
                    <span className="text-gray-500">Destinations:</span>
                    <span className="font-semibold">{cap.destinationTypes.join(', ')}</span>
                  </div>
                </div>
              </div>

              <div className="mt-4 rounded bg-gray-900/60 p-2 text-[11px] text-gray-400 border border-gray-800">
                <span className="font-semibold text-gray-300">Compliance: </span>
                {cap.complianceNotes}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Assign Client Modal */}
      {assigningAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-gray-800 bg-[#1a1b22] p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-white">Assign Account to Client</h3>
            <p className="text-xs text-gray-400 mt-1">
              Select which agency client owns or is authorized to publish through <strong className="text-white">{assigningAccount.name}</strong>.
            </p>

            <form onSubmit={handleAssignClient} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1">Select Client</label>
                <select
                  required
                  value={selectedClientId}
                  onChange={(e) => setSelectedClientId(e.target.value)}
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white focus:border-primary focus:outline-none"
                >
                  <option value="">-- Select Client --</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.companyName || c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setAssigningAccount(null)}
                  className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary/90"
                >
                  Save Assignment
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
