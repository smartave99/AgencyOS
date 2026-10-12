'use client';

import React, { FC } from 'react';
import Link from 'next/link';
import { useCan, useDashboard } from './agency.hooks';
import {
  Card,
  EmptyState,
  Icon,
  IconName,
  LinkBtn,
  Loading,
  LoadError,
  PageHeader,
  PageShell,
  Stat,
  StatusBadge,
  Tone,
  TONE_TEXT,
  tableClass,
  timeAgo,
} from './agency.ui';
import { SystemBanner } from './system-banner.component';

const AttentionRow: FC<{
  count: number;
  text: string;
  href: string;
  icon: IconName;
  tone: Tone;
}> = ({ count, text, href, icon, tone }) =>
  count > 0 ? (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-[var(--ag-neutral-bg)]"
    >
      <span
        className={`flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--ag-neutral-bg)] ${TONE_TEXT[tone]}`}
      >
        <Icon name={icon} size={17} />
      </span>
      <span className="flex-1 text-[13px] text-newTextColor">
        <strong className="font-semibold tabular-nums">{count}</strong> {text}
      </span>
      <Icon
        name="arrow"
        size={15}
        className="text-textItemBlur group-hover:text-newTextColor group-hover:translate-x-0.5 transition-transform"
      />
    </Link>
  ) : null;

const MiniStat: FC<{ label: string; value: number; tone: Tone }> = ({
  label,
  value,
  tone,
}) => (
  <div className="rounded-xl bg-[var(--ag-neutral-bg)] p-3.5">
    <span className="text-xs text-textItemBlur">{label}</span>
    <div
      className={`mt-0.5 text-xl font-semibold tabular-nums tracking-tight ${TONE_TEXT[tone]}`}
    >
      {value}
    </div>
  </div>
);

export const AgencyDashboardComponent: FC = () => {
  const { can, isClient, isLoading: roleLoading } = useCan();
  const { data, error, mutate } = useDashboard(!roleLoading && !isClient);

  if (roleLoading) {
    return (
      <PageShell>
        <Loading />
      </PageShell>
    );
  }

  if (isClient) {
    return (
      <PageShell>
        <div className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)]">
          <EmptyState
            icon="doc"
            title="Your campaigns live in the client portal"
            hint="See the ads waiting for your approval and how your campaigns are going."
            action={
              <LinkBtn href="/agency/portal" variant="primary" size="md">
                Open client portal
              </LinkBtn>
            }
          />
        </div>
      </PageShell>
    );
  }

  const attention = data
    ? data.campaignsNeedingAttention +
      data.destinationsNeedingAttention +
      data.blockedPosts +
      data.pendingApprovalsCount
    : 0;

  return (
    <PageShell>
      <PageHeader
        title="Dashboard"
        subtitle="What needs you first, then how the work is going."
        actions={
          <>
            {can('client:write') && (
              <LinkBtn href="/agency/clients">Add client</LinkBtn>
            )}
            {can('campaign:write') && (
              <LinkBtn href="/agency/campaigns/new" variant="primary">
                <Icon name="plus" size={15} />
                New campaign
              </LinkBtn>
            )}
          </>
        }
      />

      <SystemBanner />

      {error ? (
        <LoadError error={error} onRetry={() => mutate()} />
      ) : !data ? (
        <Loading label="Loading dashboard" />
      ) : (
        <>
          <Card
            title={attention > 0 ? 'Needs your attention' : 'All clear'}
            subtitle={
              attention > 0
                ? 'Open items, most urgent first.'
                : 'Nothing is waiting on you right now.'
            }
          >
            {attention > 0 && (
              <div className="flex flex-col -mx-2">
                <AttentionRow
                  count={data.campaignsNeedingAttention}
                  text="campaign(s) have failed or paused posts"
                  href="/agency/campaigns"
                  icon="alert"
                  tone="bad"
                />
                <AttentionRow
                  count={data.destinationsNeedingAttention}
                  text="Telegram destination(s) lost authorization or access"
                  href="/agency/telegram"
                  icon="send"
                  tone="bad"
                />
                <AttentionRow
                  count={data.blockedPosts}
                  text="queued post(s) are paused until a destination is fixed"
                  href="/agency/telegram"
                  icon="clock"
                  tone="warn"
                />
                <AttentionRow
                  count={data.pendingApprovalsCount}
                  text="campaign(s) are waiting for review"
                  href="/agency/approvals"
                  icon="check"
                  tone="info"
                />
              </div>
            )}
          </Card>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Stat
              label="Active clients"
              value={data.activeClientsCount}
              hint="Managed portfolios"
              href="/agency/clients"
              linkLabel="Open"
            />
            <Stat
              label="In flight"
              value={data.activeCampaignsCount}
              hint="Approved, scheduled or publishing"
              href="/agency/campaigns"
              linkLabel="Open"
            />
            <Stat
              label="Awaiting review"
              value={data.pendingApprovalsCount}
              hint="In the approval inbox"
              href="/agency/approvals"
              linkLabel="Review"
            />
            <Stat
              label="Authorized destinations"
              value={data.telegramDestinationsCount}
              hint="Can receive ads today"
              href="/agency/telegram"
              linkLabel="Open"
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card
              className="lg:col-span-2"
              title="Recent campaigns"
              right={
                <Link
                  href="/agency/campaigns"
                  className="text-[13px] font-medium text-[color:var(--ag-accent-text)] hover:underline"
                >
                  View all
                </Link>
              }
            >
              {data.recentCampaigns.length === 0 ? (
                <EmptyState
                  icon="megaphone"
                  title="No campaigns yet"
                  hint="Create a campaign for a client, pick authorized destinations and send it for review."
                  action={
                    can('campaign:write') ? (
                      <LinkBtn href="/agency/campaigns/new" variant="primary">
                        Create the first campaign
                      </LinkBtn>
                    ) : undefined
                  }
                />
              ) : (
                <div className={tableClass.wrap}>
                  <table className={tableClass.table}>
                    <thead className={tableClass.head}>
                      <tr>
                        <th className={tableClass.th}>Campaign</th>
                        <th className={tableClass.th}>Client</th>
                        <th className={tableClass.th}>Status</th>
                        <th className={`${tableClass.th} text-right`}>
                          Destinations
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentCampaigns.map((c) => (
                        <tr key={c.id} className={tableClass.row}>
                          <td className={`${tableClass.td} font-medium`}>
                            <Link
                              href={`/agency/campaigns/${c.id}`}
                              className="text-newTextColor hover:text-[color:var(--ag-accent-text)]"
                            >
                              {c.name}
                            </Link>
                            {c.requiresAttention && (
                              <span
                                className={`ml-2 ${TONE_TEXT.warn}`}
                                title="Needs attention"
                                aria-label="Needs attention"
                              >
                                ●
                              </span>
                            )}
                          </td>
                          <td className={`${tableClass.td} text-textItemBlur`}>
                            {c.customer?.companyName || c.customer?.name}
                          </td>
                          <td className={tableClass.td}>
                            <StatusBadge status={c.status} />
                          </td>
                          <td
                            className={`${tableClass.td} text-right tabular-nums text-textItemBlur`}
                          >
                            {c._count?.destinations ?? 0}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card title="Delivery" subtitle="Counted from stored send results.">
              <div className="grid grid-cols-2 gap-3">
                <MiniStat
                  label="Delivered"
                  value={data.successfulPosts}
                  tone="good"
                />
                <MiniStat label="Failed" value={data.failedPosts} tone="bad" />
                <MiniStat
                  label="Paused"
                  value={data.blockedPosts}
                  tone="warn"
                />
                <MiniStat label="Queued" value={data.queuedPosts} tone="info" />
              </div>
              <p className="text-[13px] text-textItemBlur">
                Delivery rate{' '}
                <strong className="text-newTextColor font-semibold">
                  {data.deliveryRate === null ? '—' : `${data.deliveryRate}%`}
                </strong>
                {data.deliveryRate === null && ' · nothing has been sent yet'}
              </p>
              <div className="flex flex-col gap-2 pt-1">
                <span className="text-xs font-medium text-textItemBlur">
                  Recent attempts
                </span>
                {data.recentEvents.length === 0 ? (
                  <p className="py-4 text-center text-[13px] text-textItemBlur">
                    Nothing sent yet.
                  </p>
                ) : (
                  data.recentEvents.map((e) => (
                    <div
                      key={e.id}
                      className="p-3 rounded-xl bg-[var(--ag-neutral-bg)] flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-newTextColor truncate">
                          {e.campaign?.name}
                        </div>
                        <div className="text-xs text-textItemBlur truncate">
                          {e.telegramDestination?.title ?? 'Telegram'} ·{' '}
                          {timeAgo(e.executedAt)}
                        </div>
                      </div>
                      <StatusBadge status={e.status} />
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>
        </>
      )}
    </PageShell>
  );
};
