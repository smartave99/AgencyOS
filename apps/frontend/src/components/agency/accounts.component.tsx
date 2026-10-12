'use client';

import React, { FC, useEffect, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { useToaster } from '@gitroom/react/toaster/toaster';
import {
  useAccounts,
  useAgencyApi,
  useCan,
  useCapabilities,
  useClients,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Card,
  EmptyState,
  formatDate,
  humanize,
  labelClass,
  inputClass,
  LoadError,
  Loading,
  PageHeader,
  PageShell,
} from '@gitroom/frontend/components/agency/agency.ui';

const HEALTH_TONE: Record<string, string> = {
  HEALTHY: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  NEEDS_REFRESH: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  EXPIRED: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
  DISABLED: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
};

const AssignDialog: FC<{
  account: any;
  onClose: () => void;
  onSaved: () => void;
}> = ({ account, onClose, onSaved }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const clients = useClients();
  const [customerId, setCustomerId] = useState<string>(
    account.client?.id ?? ''
  );
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const error = customerId ? null : 'Choose a client.';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (error) return;
    setBusy(true);
    try {
      await api.post(`/agency/accounts/${account.id}/assign-client`, {
        customerId,
      });
      toaster.show('Account linked to client', 'success');
      onSaved();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="assign-title"
    >
      <form
        onSubmit={submit}
        className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-6 max-w-md w-full shadow-2xl flex flex-col gap-4"
      >
        <div>
          <h3
            id="assign-title"
            className="text-base font-bold text-newTextColor"
          >
            Assign to a client
          </h3>
          <p className="text-xs text-textItemBlur mt-1">
            Choose the client this account belongs to:{' '}
            <strong className="text-newTextColor">{account.name}</strong>
          </p>
        </div>
        <div>
          <label htmlFor="assign-client" className={labelClass}>
            Client
          </label>
          <select
            id="assign-client"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && !!error}
            className={inputClass}
          >
            <option value="">Select…</option>
            {(clients.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.companyName || c.name}
              </option>
            ))}
          </select>
          {touched && error && (
            <p className="text-[11px] text-rose-400 mt-1">{error}</p>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-3 border-t border-newBgLineColor">
          <Btn type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn type="submit" variant="primary" busy={busy}>
            Save
          </Btn>
        </div>
      </form>
    </div>
  );
};

export const AgencyAccountsComponent = () => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { can } = useCan();
  const accounts = useAccounts();
  const capabilities = useCapabilities();
  const [testing, setTesting] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<any | null>(null);

  const test = async (id: string) => {
    setTesting(id);
    try {
      const res = await api.post<{ healthy: boolean; message: string }>(
        `/agency/accounts/${id}/test-connection`
      );
      toaster.show(res.message, res.healthy ? 'success' : 'warning');
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    } finally {
      setTesting(null);
    }
  };

  return (
    <PageShell>
      <PageHeader
        crumb="Platforms"
        title="Connected accounts"
        subtitle="Social accounts connected to this workspace and what each network supports. Publishing from AgencyOS campaigns is Telegram only today."
        actions={
          <Link
            href="/agency/telegram"
            className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white shadow-sm"
          >
            Telegram destinations
          </Link>
        }
      />

      <p className="text-xs rounded-lg border border-amber-500/20 bg-amber-500/10 text-amber-400 p-3">
        Accounts for other networks are connected and shown here, but campaigns
        cannot publish to them yet. They are listed so you can see their stored
        status and which client they belong to.
      </p>

      <Card
        title="Accounts"
        subtitle="Status is read from stored data. Tests do not contact the network."
      >
        {accounts.error ? (
          <LoadError error={accounts.error} onRetry={() => accounts.mutate()} />
        ) : !accounts.data ? (
          <Loading />
        ) : accounts.data.length === 0 ? (
          <EmptyState
            title="No social accounts connected"
            hint="Telegram destinations are managed on their own page. Other networks can be connected from the workspace settings."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-newBgLineColor text-[11px] uppercase text-textItemBlur">
                <tr>
                  <th className="py-2.5 px-3">Account</th>
                  <th className="py-2.5 px-3">Network</th>
                  <th className="py-2.5 px-3">Client</th>
                  <th className="py-2.5 px-3">Stored status</th>
                  <th className="py-2.5 px-3">Token expires</th>
                  <th className="py-2.5 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-newBgLineColor">
                {accounts.data.map((acc) => (
                  <tr key={acc.id}>
                    <td className="py-3 px-3 font-semibold text-newTextColor">
                      {acc.name}
                      {acc.profile && (
                        <span className="block text-[11px] font-normal text-textItemBlur">
                          @{acc.profile}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-textItemBlur">
                      {humanize(acc.provider)}
                    </td>
                    <td className="py-3 px-3">
                      {acc.client ? (
                        <span className="text-newTextColor">
                          {acc.client.companyName || acc.client.name}
                        </span>
                      ) : (
                        <span className="text-textItemBlur italic">
                          Unassigned
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3">
                      <span
                        className={clsx(
                          'inline-flex px-2 py-0.5 rounded text-[11px] font-semibold border',
                          HEALTH_TONE[acc.healthStatus] ?? HEALTH_TONE.DISABLED
                        )}
                      >
                        {humanize(acc.healthStatus)}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-textItemBlur">
                      {acc.tokenExpiration
                        ? formatDate(acc.tokenExpiration)
                        : 'No expiry on record'}
                    </td>
                    <td className="py-3 px-3 text-right">
                      <div className="flex justify-end gap-2">
                        <Btn
                          busy={testing === acc.id}
                          onClick={() => void test(acc.id)}
                        >
                          Check status
                        </Btn>
                        {can('accounts:manage') && (
                          <Btn onClick={() => setAssigning(acc)}>
                            Assign client
                          </Btn>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <section>
        <h2 className="text-sm font-bold text-newTextColor mb-3">
          What each network supports
        </h2>
        {capabilities.error ? (
          <LoadError
            error={capabilities.error}
            onRetry={() => capabilities.mutate()}
          />
        ) : !capabilities.data ? (
          <Loading />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {capabilities.data.map((cap) => (
              <div
                key={cap.identifier}
                className="bg-newBgColorInner border border-newBgLineColor rounded-xl p-5 flex flex-col gap-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-newTextColor">
                    {cap.name}
                  </h3>
                  {cap.identifier === 'telegram' ? (
                    <span className="text-[11px] font-semibold text-emerald-400">
                      Publishing supported
                    </span>
                  ) : (
                    <span className="text-[11px] text-textItemBlur">
                      Not publishable yet
                    </span>
                  )}
                </div>
                <p className="text-xs text-textItemBlur">{cap.description}</p>
                {cap.catalogued ? (
                  <dl className="text-xs grid grid-cols-2 gap-y-1.5 border-t border-newBgLineColor pt-3">
                    <dt className="text-textItemBlur">Max text</dt>
                    <dd className="text-newTextColor text-right">
                      {cap.maxTextLength.toLocaleString()}
                    </dd>
                    <dt className="text-textItemBlur">Formatting</dt>
                    <dd className="text-newTextColor text-right">
                      {humanize(cap.supportsFormatting)}
                    </dd>
                    <dt className="text-textItemBlur">Media</dt>
                    <dd className="text-newTextColor text-right">
                      {[
                        cap.supportsImages && 'Images',
                        cap.supportsVideos && 'Video',
                      ]
                        .filter(Boolean)
                        .join(', ') || 'None'}
                    </dd>
                    <dt className="text-textItemBlur">Destinations</dt>
                    <dd className="text-newTextColor text-right">
                      {cap.destinationTypes.map(humanize).join(', ')}
                    </dd>
                    {cap.rateLimitPerMinute && (
                      <>
                        <dt className="text-textItemBlur">Guideline</dt>
                        <dd className="text-newTextColor text-right">
                          ~{cap.rateLimitPerMinute}/min per group
                        </dd>
                      </>
                    )}
                  </dl>
                ) : (
                  <p className="text-[11px] text-textItemBlur border-t border-newBgLineColor pt-3">
                    No verified capability data recorded for this network.
                  </p>
                )}
                <p className="text-[11px] text-textItemBlur">
                  <span className="font-semibold text-newTextColor">
                    Compliance:{' '}
                  </span>
                  {cap.complianceNotes}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {assigning && (
        <AssignDialog
          account={assigning}
          onClose={() => setAssigning(null)}
          onSaved={() => {
            setAssigning(null);
            void accounts.mutate();
          }}
        />
      )}
    </PageShell>
  );
};
