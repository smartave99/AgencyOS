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
  Icon,
  inputClass,
  LinkBtn,
  LoadError,
  PageHeader,
  PageShell,
  Segmented,
  Skeleton,
  StatusBadge,
  TONE_TEXT,
  btnClass,
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
    } catch (e) {
      toaster.show((e as Error).message, 'warning');
    } finally {
      setBusy(false);
    }
  };

  const editable = c.status === 'DRAFT' || c.status === 'CHANGES_REQUESTED';
  // One quick action, the obvious next step for this campaign and this person.
  const quick = (() => {
    if (editable && can('campaign:write')) {
      return (
        <Btn
          variant="primary"
          busy={busy}
          onClick={() =>
            run(`/agency/campaigns/${c.id}/submit`, 'Submitted for review')
          }
        >
          Submit for review
        </Btn>
      );
    }
    if (c.status === 'SUBMITTED' && can('campaign:approve')) {
      return (
        <LinkBtn href="/agency/approvals" variant="primary">
          Review
        </LinkBtn>
      );
    }
    if (c.status === 'APPROVED' && can('campaign:schedule') && c.startDate) {
      return (
        <Btn
          variant="primary"
          busy={busy}
          onClick={() => run(`/agency/campaigns/${c.id}/schedule`, 'Scheduled')}
        >
          Schedule
        </Btn>
      );
    }
    return null;
  })();

  return (
    <article className="group relative rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)] shadow-[var(--ag-shadow)] p-5 flex flex-col gap-4 hover:border-[color:var(--ag-accent)]/40 hover:-translate-y-px transition-all">
      <div className="flex items-center justify-between gap-2">
        <StatusBadge status={c.status} />
        <span className="text-xs text-textItemBlur truncate">
          {c.customer?.companyName || c.customer?.name}
        </span>
      </div>

      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold tracking-tight text-newTextColor leading-snug">
          {/* The whole card opens the campaign; actions sit above this layer. */}
          <Link
            href={`/agency/campaigns/${c.id}`}
            className="after:absolute after:inset-0 after:rounded-2xl"
          >
            {c.name}
          </Link>
        </h3>
        <p className="mt-1 text-[13px] leading-relaxed text-textItemBlur line-clamp-2">
          {c.contentBody}
        </p>
      </div>

      {c.requiresAttention && (
        <p
          className={clsx('flex items-center gap-1.5 text-xs', TONE_TEXT.warn)}
        >
          <Icon name="alert" size={13} />
          {c.attentionReason ?? 'Needs attention'}
        </p>
      )}

      <div className="mt-auto flex items-end justify-between gap-3">
        <dl className="text-xs text-textItemBlur flex flex-col gap-0.5">
          <div>
            <dt className="sr-only">Destinations</dt>
            <dd>
              {c.destinations?.length ?? 0} destination
              {(c.destinations?.length ?? 0) === 1 ? '' : 's'}
            </dd>
          </div>
          {c.startDate && (
            <div>
              <dt className="sr-only">Starts</dt>
              <dd>Starts {formatDate(c.startDate)}</dd>
            </div>
          )}
        </dl>
        {quick && <div className="relative z-10">{quick}</div>}
      </div>
    </article>
  );
};

const CardsSkeleton = () => (
  <div
    role="status"
    aria-busy="true"
    className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
  >
    <span className="sr-only">Loading campaigns</span>
    {Array.from({ length: 6 }, (_, i) => (
      <div
        key={i}
        className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)] p-5 flex flex-col gap-3"
      >
        <Skeleton className="w-24 h-5 rounded-full" />
        <Skeleton className="w-3/4 h-5" />
        <Skeleton className="w-full" />
        <Skeleton className="w-2/3" />
      </div>
    ))}
  </div>
);

export const AgencyCampaignsComponent: FC = () => {
  const { can } = useCan();
  const [status, setStatus] = useState('ALL');
  const [search, setSearch] = useState('');
  const [onlyAttention, setOnlyAttention] = useState(false);
  const { data, error, mutate } = useCampaigns(status, search);
  const campaigns = (data ?? []).filter(
    (c) => !onlyAttention || c.requiresAttention
  );

  return (
    <PageShell>
      <PageHeader
        title="Campaigns"
        subtitle="Briefs, creative, destinations and where each one stands."
        actions={
          can('campaign:write') ? (
            <LinkBtn href="/agency/campaigns/new" variant="primary">
              <Icon name="plus" size={15} />
              New campaign
            </LinkBtn>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          ariaLabel="Campaign status"
          value={status}
          onChange={setStatus}
          options={TABS}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={onlyAttention}
            onClick={() => setOnlyAttention((v) => !v)}
            className={clsx(
              btnClass('secondary', 'sm'),
              onlyAttention &&
                'border-[color:var(--ag-warn-line)] bg-[var(--ag-warn-bg)] text-[color:var(--ag-warn-fg)]'
            )}
          >
            <Icon name="alert" size={14} />
            Needs attention
          </button>
          <div className="relative">
            <Icon
              name="search"
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-textItemBlur"
            />
            <input
              type="search"
              aria-label="Search campaigns"
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={clsx(inputClass, 'pl-8 w-48 sm:w-56 h-8 py-0')}
            />
          </div>
        </div>
      </div>

      {error ? (
        <LoadError error={error} onRetry={() => mutate()} />
      ) : !data ? (
        <CardsSkeleton />
      ) : campaigns.length === 0 ? (
        <div className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)]">
          <EmptyState
            icon="megaphone"
            title={
              status === 'ALL' && !search && !onlyAttention
                ? 'No campaigns yet'
                : 'No campaigns match this view'
            }
            hint="Create a campaign, choose authorized destinations and send it for review."
            action={
              can('campaign:write') ? (
                <LinkBtn href="/agency/campaigns/new" variant="primary">
                  New campaign
                </LinkBtn>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="ag-rise grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {campaigns.map((c) => (
            <CampaignCard key={c.id} c={c} onChanged={() => mutate()} />
          ))}
        </div>
      )}
    </PageShell>
  );
};
