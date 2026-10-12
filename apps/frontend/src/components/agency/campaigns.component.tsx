'use client';

import React, { FC, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { useToaster } from '@gitroom/react/toaster/toaster';
import {
  CampaignSummary,
  useAgencyApi,
  useCampaigns,
  useCan,
} from './agency.hooks';
import {
  Btn,
  EmptyState,
  inputClass,
  Loading,
  LoadError,
  PageHeader,
  PageShell,
  StatusBadge,
  formatDate,
} from './agency.ui';

const TABS = [
  { label: 'All', value: 'ALL' },
  { label: 'Drafts', value: 'DRAFT' },
  { label: 'In review', value: 'SUBMITTED' },
  { label: 'Changes asked', value: 'CHANGES_REQUESTED' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Scheduled', value: 'SCHEDULED' },
  { label: 'Publishing', value: 'PUBLISHING' },
  { label: 'Completed', value: 'COMPLETED' },
  { label: 'Partly failed', value: 'PARTIALLY_FAILED' },
  { label: 'Failed', value: 'FAILED' },
];

const CampaignCard: FC<{ c: CampaignSummary; onChanged: () => void }> = ({
  c,
  onChanged,
}) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { can } = useCan();
  const [busy, setBusy] = useState(false);

  const run = async (path: string, done: string) => {
    setBusy(true);
    try {
      await api.post(path, {});
      toaster.show(done, 'success');
      onChanged();
    } catch (e: any) {
      toaster.show(e.message, 'warning');
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    try {
      await api.download(
        `/agency/campaigns/${c.id}/export/csv`,
        `campaign-${c.id}.csv`
      );
    } catch (e: any) {
      toaster.show(e.message, 'warning');
    }
  };

  const editable = c.status === 'DRAFT' || c.status === 'CHANGES_REQUESTED';
  return (
    <article className="bg-newBgColorInner border border-newBgLineColor rounded-xl p-4 flex flex-col justify-between hover:border-slate-700 transition-all gap-4">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <StatusBadge status={c.status} />
            {c.requiresAttention && (
              <span
                className="text-amber-400 text-xs"
                title={c.attentionReason ?? 'Needs attention'}
                aria-label="Needs attention"
              >
                ● needs attention
              </span>
            )}
          </div>
          <span className="text-[11px] text-textItemBlur font-medium truncate">
            {c.customer?.companyName || c.customer?.name}
          </span>
        </div>
        <h3 className="text-sm font-bold text-newTextColor mt-2 leading-snug">
          <Link
            href={`/agency/campaigns/${c.id}`}
            className="hover:text-blue-400"
          >
            {c.name}
          </Link>
        </h3>
        <p className="text-xs text-textItemBlur line-clamp-2 mt-1">
          {c.contentBody}
        </p>
      </div>

      <dl className="flex flex-col gap-1.5 pt-3 border-t border-newBgLineColor/60 text-xs">
        <div className="flex justify-between text-textItemBlur">
          <dt>Destinations</dt>
          <dd className="text-newTextColor font-medium">
            {c.destinations?.length ?? 0}
          </dd>
        </div>
        {c.startDate && (
          <div className="flex justify-between text-textItemBlur">
            <dt>Starts</dt>
            <dd className="text-newTextColor">{formatDate(c.startDate)}</dd>
          </div>
        )}
        {c.budget && (
          <div className="flex justify-between text-textItemBlur">
            <dt>Budget</dt>
            <dd className="text-newTextColor">
              ${Number(c.budget).toLocaleString()}
            </dd>
          </div>
        )}
      </dl>

      <div className="flex items-center gap-2 pt-2 border-t border-newBgLineColor/60">
        {editable && can('campaign:write') && (
          <Btn
            variant="primary"
            className="flex-1"
            busy={busy}
            onClick={() =>
              run(`/agency/campaigns/${c.id}/submit`, 'Submitted for review')
            }
          >
            Submit for review
          </Btn>
        )}
        {c.status === 'SUBMITTED' && can('campaign:approve') && (
          <Link href="/agency/approvals" className="flex-1">
            <Btn variant="primary" className="w-full">
              Review
            </Btn>
          </Link>
        )}
        {c.status === 'APPROVED' && can('campaign:schedule') && (
          <Btn
            variant="primary"
            className="flex-1"
            busy={busy}
            onClick={() =>
              run(`/agency/campaigns/${c.id}/schedule`, 'Scheduled')
            }
          >
            Schedule
          </Btn>
        )}
        <Link href={`/agency/campaigns/${c.id}`}>
          <Btn>Open</Btn>
        </Link>
        {can('analytics:read') && (
          <Btn
            variant="ghost"
            onClick={download}
            title="Download the delivery report (CSV)"
          >
            CSV
          </Btn>
        )}
      </div>
    </article>
  );
};

export const AgencyCampaignsComponent: FC = () => {
  const { can } = useCan();
  const [status, setStatus] = useState('ALL');
  const [search, setSearch] = useState('');
  const [onlyAttention, setOnlyAttention] = useState(false);
  const { data, error, isLoading, mutate } = useCampaigns(status, search);
  const campaigns = (data ?? []).filter(
    (c) => !onlyAttention || c.requiresAttention
  );

  return (
    <PageShell>
      <PageHeader
        crumb="Campaigns"
        title="Campaigns"
        subtitle="Briefs, creative, destinations and where each one stands."
        actions={
          can('campaign:write') ? (
            <Link href="/agency/campaigns/new">
              <Btn variant="primary">New campaign</Btn>
            </Link>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex flex-wrap items-center gap-1 bg-newBgColorInner border border-newBgLineColor p-1 rounded-xl"
          role="tablist"
        >
          {TABS.map((tab) => (
            <button
              key={tab.value}
              role="tab"
              aria-selected={status === tab.value}
              onClick={() => setStatus(tab.value)}
              className={clsx(
                'px-3 py-1.5 text-xs font-medium rounded-lg transition-all',
                status === tab.value
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-textItemBlur hover:text-newTextColor'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-textItemBlur">
            <input
              type="checkbox"
              checked={onlyAttention}
              onChange={(e) => setOnlyAttention(e.target.checked)}
            />
            Needs attention
          </label>
          <input
            type="search"
            aria-label="Search campaigns"
            placeholder="Search campaigns…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={inputClass + ' w-64'}
          />
        </div>
      </div>

      {error ? (
        <LoadError error={error} onRetry={() => mutate()} />
      ) : isLoading ? (
        <Loading label="Loading campaigns…" />
      ) : campaigns.length === 0 ? (
        <div className="bg-newBgColorInner border border-newBgLineColor rounded-2xl">
          <EmptyState
            title="No campaigns match this view"
            hint="Create a campaign, choose authorized destinations, and send it for review."
            action={
              can('campaign:write') ? (
                <Link href="/agency/campaigns/new">
                  <Btn variant="primary">New campaign</Btn>
                </Link>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {campaigns.map((c) => (
            <CampaignCard key={c.id} c={c} onChanged={() => mutate()} />
          ))}
        </div>
      )}
    </PageShell>
  );
};
