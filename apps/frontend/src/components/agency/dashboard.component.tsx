'use client';

import React, { FC, ReactNode } from 'react';
import Link from 'next/link';
import { useCan, useDashboard } from './agency.hooks';
import {
  Btn,
  Card,
  EmptyState,
  Loading,
  LoadError,
  PageShell,
  StatusBadge,
  timeAgo,
} from './agency.ui';
import { SystemBanner } from './system-banner.component';

const Kpi: FC<{
  label: string;
  value: ReactNode;
  hint?: string;
  href?: string;
  linkLabel?: string;
}> = ({ label, value, hint, href, linkLabel }) => (
  <div className="bg-newBgColorInner border border-newBgLineColor rounded-xl p-4 flex flex-col gap-3">
    <span className="text-xs font-medium text-textItemBlur uppercase tracking-wider">
      {label}
    </span>
    <div className="text-2xl font-bold text-newTextColor">{value}</div>
    <div className="text-xs text-textItemBlur flex items-center justify-between">
      <span>{hint}</span>
      {href && (
        <Link href={href} className="text-blue-400 hover:underline">
          {linkLabel} →
        </Link>
      )}
    </div>
  </div>
);

const AttentionItem: FC<{ count: number; text: string; href: string }> = ({
  count,
  text,
  href,
}) =>
  count > 0 ? (
    <Link
      href={href}
      className="flex items-center justify-between gap-4 rounded-lg px-3 py-2 hover:bg-newBgColor transition-colors"
    >
      <span className="text-xs text-newTextColor">
        <strong className="text-amber-400">{count}</strong> {text}
      </span>
      <span className="text-xs text-blue-400">Review →</span>
    </Link>
  ) : null;

export const AgencyDashboardComponent: FC = () => {
  const { data, error, isLoading, mutate } = useDashboard();
  const { can, isClient } = useCan();

  if (isClient) {
    return (
      <PageShell>
        <EmptyState
          title="Your campaigns live in the client portal"
          action={
            <Link href="/agency/portal">
              <Btn variant="primary">Open client portal</Btn>
            </Link>
          }
        />
      </PageShell>
    );
  }

  const attention =
    (data?.campaignsNeedingAttention ?? 0) +
    (data?.destinationsNeedingAttention ?? 0) +
    (data?.blockedPosts ?? 0) +
    (data?.pendingApprovalsCount ?? 0);

  return (
    <PageShell>
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-newBgLineColor pb-5">
        <div>
          <h1 className="text-2xl font-bold text-newTextColor tracking-tight">
            Agency dashboard
          </h1>
          <p className="text-xs text-textItemBlur mt-0.5">
            Everything that needs you, then how the work is going.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can('client:write') && (
            <Link href="/agency/clients">
              <Btn>Onboard client</Btn>
            </Link>
          )}
          {can('campaign:write') && (
            <Link href="/agency/campaigns/new">
              <Btn variant="primary">New campaign</Btn>
            </Link>
          )}
        </div>
      </div>

      <SystemBanner />

      {error ? (
        <LoadError error={error} onRetry={() => mutate()} />
      ) : isLoading || !data ? (
        <Loading label="Loading dashboard…" />
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
              <div className="flex flex-col">
                <AttentionItem
                  count={data.campaignsNeedingAttention}
                  text="campaign(s) have failed or paused posts"
                  href="/agency/campaigns"
                />
                <AttentionItem
                  count={data.destinationsNeedingAttention}
                  text="Telegram destination(s) lost authorization or access"
                  href="/agency/telegram"
                />
                <AttentionItem
                  count={data.blockedPosts}
                  text="queued post(s) are paused until a destination is fixed"
                  href="/agency/telegram"
                />
                <AttentionItem
                  count={data.pendingApprovalsCount}
                  text="campaign(s) are waiting for review"
                  href="/agency/approvals"
                />
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Kpi
              label="Active clients"
              value={data.activeClientsCount}
              hint="Managed portfolios"
              href="/agency/clients"
              linkLabel="Directory"
            />
            <Kpi
              label="Running campaigns"
              value={data.activeCampaignsCount}
              hint={`of ${data.totalCampaignsCount} total`}
              href="/agency/campaigns"
              linkLabel="Manage"
            />
            <Kpi
              label="Awaiting review"
              value={data.pendingApprovalsCount}
              hint="In the approval inbox"
              href="/agency/approvals"
              linkLabel="Review"
            />
            <Kpi
              label="Authorized destinations"
              value={data.telegramDestinationsCount}
              hint="Can receive ads today"
              href="/agency/telegram"
              linkLabel="Registry"
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card
              className="lg:col-span-2"
              title="Recent campaigns"
              right={
                <Link
                  href="/agency/campaigns"
                  className="text-xs text-blue-400 hover:underline"
                >
                  View all ({data.totalCampaignsCount})
                </Link>
              }
            >
              {data.recentCampaigns.length === 0 ? (
                <EmptyState
                  title="No campaigns yet"
                  hint="Create a campaign for a client, pick authorized destinations, and send it for review."
                  action={
                    can('campaign:write') ? (
                      <Link href="/agency/campaigns/new">
                        <Btn variant="primary">Create the first campaign</Btn>
                      </Link>
                    ) : undefined
                  }
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-textItemBlur font-medium border-b border-newBgLineColor">
                      <tr>
                        <th className="py-2">Campaign</th>
                        <th className="py-2">Client</th>
                        <th className="py-2">Status</th>
                        <th className="py-2">Destinations</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-newBgLineColor/40">
                      {data.recentCampaigns.map((c) => (
                        <tr key={c.id} className="hover:bg-newBgColor/40">
                          <td className="py-3 font-medium text-newTextColor">
                            <Link
                              href={`/agency/campaigns/${c.id}`}
                              className="hover:text-blue-400"
                            >
                              {c.name}
                            </Link>
                            {c.requiresAttention && (
                              <span
                                className="ml-2 text-amber-400"
                                title="Needs attention"
                              >
                                ●
                              </span>
                            )}
                          </td>
                          <td className="py-3 text-textItemBlur">
                            {c.customer?.companyName || c.customer?.name}
                          </td>
                          <td className="py-3">
                            <StatusBadge status={c.status} />
                          </td>
                          <td className="py-3 text-textItemBlur">
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
                <Stat
                  label="Delivered"
                  value={data.successfulPosts}
                  tone="text-emerald-400"
                />
                <Stat
                  label="Failed"
                  value={data.failedPosts}
                  tone="text-rose-400"
                />
                <Stat
                  label="Paused"
                  value={data.blockedPosts}
                  tone="text-amber-400"
                />
                <Stat
                  label="Queued"
                  value={data.queuedPosts}
                  tone="text-blue-400"
                />
              </div>
              <div className="text-xs text-textItemBlur">
                Delivery rate{' '}
                <strong className="text-newTextColor">
                  {data.deliveryRate === null ? '—' : `${data.deliveryRate}%`}
                </strong>
                {data.deliveryRate === null && ' (nothing has been sent yet)'}
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-textItemBlur uppercase">
                  Recent attempts
                </span>
                {data.recentEvents.length === 0 ? (
                  <div className="py-4 text-center text-xs text-textItemBlur">
                    Nothing sent yet.
                  </div>
                ) : (
                  data.recentEvents.map((e) => (
                    <div
                      key={e.id}
                      className="p-2.5 rounded-lg bg-newBgColor border border-newBgLineColor/50 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-newTextColor truncate">
                          {e.campaign?.name}
                        </div>
                        <div className="text-[11px] text-textItemBlur truncate">
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

const Stat: FC<{ label: string; value: number; tone: string }> = ({
  label,
  value,
  tone,
}) => (
  <div className="p-3 rounded-lg bg-newBgColor border border-newBgLineColor">
    <span className="text-[11px] text-textItemBlur uppercase font-semibold">
      {label}
    </span>
    <div className={`text-lg font-bold mt-0.5 ${tone}`}>{value}</div>
  </div>
);
