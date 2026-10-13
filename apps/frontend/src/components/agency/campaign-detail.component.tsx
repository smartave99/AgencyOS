'use client';

import React, { FC, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  CampaignDetail,
  PostingJob,
  useAgencyApi,
  useCampaign,
  useCampaignAudit,
  useCan,
} from './agency.hooks';
import { Preview, TelegramPreview } from './campaign-form.component';
import {
  Btn,
  Card,
  EmptyState,
  LinkBtn,
  Loading,
  LoadError,
  Menu,
  MenuItem,
  Notice,
  PageHeader,
  PageShell,
  Stepper,
  StatusBadge,
  TextField,
  TONE_TEXT,
  formatDate,
  formatDateTime,
  describeSchedule,
  humanize,
  money,
  prettySummary,
  roleLabel,
  tableClass,
  timeAgo,
  useTouched,
} from './agency.ui';

const parseMedia = (raw: string | null) => {
  if (!raw) return [] as { id: string; path: string }[];
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((m: any, i: number) =>
        typeof m === 'string'
          ? { id: `m${i}`, path: m }
          : { id: m.id ?? `m${i}`, path: m.path ?? m.url }
      )
      .filter((m) => !!m.path);
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Where this campaign is in its life, and what happens next
// ---------------------------------------------------------------------------
const STEPS = [
  { key: 'draft', label: 'Draft' },
  { key: 'review', label: 'Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'publishing', label: 'Publishing' },
  { key: 'delivered', label: 'Delivered' },
];

const progress = (
  status: string
): { current: number; attention?: boolean } | null => {
  switch (status) {
    case 'DRAFT':
      return { current: 0 };
    case 'CHANGES_REQUESTED':
      return { current: 0, attention: true };
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
      return { current: 1 };
    case 'APPROVED':
      return { current: 2 };
    case 'SCHEDULED':
      return { current: 3 };
    case 'PUBLISHING':
      return { current: 4 };
    case 'PAUSED':
      return { current: 4, attention: true };
    case 'PARTIALLY_FAILED':
    case 'FAILED':
      return { current: 5, attention: true };
    case 'COMPLETED':
      return { current: STEPS.length };
    default:
      return null; // cancelled / archived: the badge says it all
  }
};

const nextStep = (c: CampaignDetail): string => {
  switch (c.status) {
    case 'DRAFT':
      return 'This is still a draft. Submit it for review when it is ready.';
    case 'CHANGES_REQUESTED':
      return 'A reviewer asked for changes. Edit the campaign and submit it again.';
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
      return c.requiresClientApproval && !c.clientApprovedAt
        ? 'Waiting for a reviewer, and for the client to sign off.'
        : 'Waiting for a reviewer. Nothing is published until it is approved.';
    case 'APPROVED':
      return c.startDate
        ? 'Approved. Schedule it to queue the posts.'
        : 'Approved, but it has no start time. Reopen it to set one.';
    case 'SCHEDULED':
      return 'Queued. Each destination receives it at the scheduled time.';
    case 'PUBLISHING':
      return 'Posts are going out now.';
    case 'PAUSED':
      return 'Paused. Nothing more is sent until it is resumed.';
    case 'COMPLETED':
      return 'Every destination has received this ad.';
    case 'PARTIALLY_FAILED':
      return 'Some destinations received it and some did not. See what happened below.';
    case 'FAILED':
      return 'It could not be delivered. See what happened below.';
    case 'CANCELLED':
      return 'Cancelled. Nothing further will be sent.';
    case 'ARCHIVED':
      return 'Archived.';
    default:
      return '';
  }
};

/** Plain-language hint for a job that needs a human. */
const jobHint = (j: PostingJob) => {
  switch (j.lastErrorCode) {
    case 'DESTINATION_NOT_AUTHORIZED':
    case 'DESTINATION_REVOKED':
    case 'DESTINATION_EXPIRED':
    case 'DESTINATION_SUSPENDED':
    case 'DESTINATION_DISCONNECTED':
    case 'FORBIDDEN':
    case 'CHAT_NOT_FOUND':
    case 'PERMISSION_LOST':
      return 'The destination is no longer authorized or the bot lost access. Fix it on the Telegram page and this post resumes.';
    case 'CONTENT_CHANGED':
      return 'The content changed after approval. Reopen, review and approve it again.';
    case 'UNCONFIGURED':
      return 'No working Telegram bot is configured on the server.';
    case 'LEASE_EXPIRED':
    case 'PARTIAL_SEND':
    case 'WORKER_ERROR':
      return 'We can’t be sure whether this was posted. Check the chat, then tell us below.';
    case 'DEFERRED':
      return 'Waiting for the destination’s posting window or frequency limit.';
    default:
      return j.lastError;
  }
};

const JobsTable: FC<{
  jobs: PostingJob[];
  canControl: boolean;
  onChanged: () => void;
}> = ({ jobs, canControl, onChanged }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const [busy, setBusy] = useState<string | null>(null);

  const resolve = async (job: PostingJob, outcome: 'POSTED' | 'NOT_POSTED') => {
    const ok = await deleteDialog(
      outcome === 'POSTED'
        ? 'You checked the chat and the ad IS there? We’ll record it as delivered.'
        : 'You checked the chat and the ad is NOT there? We’ll queue it to be sent again.',
      'Yes, that’s right',
      'Confirm what you found',
      undefined,
      false
    );
    if (!ok) return;
    setBusy(job.id);
    try {
      await api.post(`/agency/campaigns/jobs/${job.id}/resolve`, { outcome });
      toaster.show('Recorded', 'success');
      onChanged();
    } catch (e) {
      toaster.show((e as Error).message, 'warning');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={tableClass.wrap}>
      <table className={tableClass.table}>
        <thead className={tableClass.head}>
          <tr>
            <th className={tableClass.th}>Destination</th>
            <th className={tableClass.th}>Status</th>
            <th className={tableClass.th}>Attempts</th>
            <th className={tableClass.th}>When</th>
            <th className={tableClass.th}>Detail</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} className={`${tableClass.row} align-top`}>
              <td className={`${tableClass.td} font-medium text-newTextColor`}>
                {j.telegramDestination?.title ?? '—'}
                {(j.variantLabel || (j.occurrence ?? 0) > 0) && (
                  <div className="mt-0.5 text-xs font-normal text-textItemBlur">
                    {[
                      j.variantLabel ? `Version ${j.variantLabel}` : null,
                      (j.occurrence ?? 0) > 0
                        ? `Repeat ${(j.occurrence ?? 0) + 1}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                )}
              </td>
              <td className={tableClass.td}>
                <StatusBadge status={j.status} />
              </td>
              <td className={`${tableClass.td} text-textItemBlur tabular-nums`}>
                {j.attempts}/{j.maxAttempts}
              </td>
              <td className={`${tableClass.td} text-textItemBlur`}>
                {j.status === 'PENDING'
                  ? `Sends ${timeAgo(j.nextAttemptAt)}`
                  : j.completedAt
                  ? formatDateTime(j.completedAt)
                  : '—'}
              </td>
              <td className={`${tableClass.td} text-textItemBlur max-w-sm`}>
                {j.releaseUrl ? (
                  <a
                    href={j.releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[color:var(--ag-accent-text)] hover:underline"
                  >
                    View on Telegram ↗
                  </a>
                ) : (
                  jobHint(j) || '—'
                )}
                {j.status === 'UNCERTAIN' && canControl && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    <Btn
                      busy={busy === j.id}
                      onClick={() => resolve(j, 'POSTED')}
                    >
                      It was posted
                    </Btn>
                    <Btn
                      busy={busy === j.id}
                      onClick={() => resolve(j, 'NOT_POSTED')}
                    >
                      It wasn’t posted
                    </Btn>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const TrackingLinks: FC<{
  c: CampaignDetail;
  canWrite: boolean;
  onChanged: () => void;
}> = ({ c, canWrite, onChanged }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const touched = useTouched();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = (() => {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  })();
  // The redirect is served by the backend, which is where clickers must be sent.
  const { backendUrl } = useVariables();

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    touched.all(['url']);
    if (!valid) return;
    setBusy(true);
    try {
      await api.post(`/agency/campaigns/${c.id}/tracking-links`, {
        destinationUrl: url,
        utmSource: 'telegram',
        utmMedium: 'ad',
        utmCampaign: c.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 60),
      });
      setUrl('');
      toaster.show('Tracking link created', 'success');
      onChanged();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Tracked links"
      subtitle="Put a short link in the ad to count real clicks. Link-preview bots aren’t counted."
    >
      {c.trackingLinks.length === 0 ? (
        <p className="text-[13px] text-textItemBlur">No tracked links yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {c.trackingLinks.map((l) => (
            <li
              key={l.id}
              className="flex items-center justify-between gap-3 rounded-xl bg-[var(--ag-neutral-bg)] px-4 py-3 text-[13px]"
            >
              <div className="min-w-0">
                <code className="text-newTextColor break-all text-xs">
                  {backendUrl}/l/{l.shortCode}
                </code>
                <div className="text-textItemBlur truncate text-xs mt-0.5">
                  → {l.destinationUrl}
                </div>
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <div className="text-right">
                  <div className="text-newTextColor font-semibold tabular-nums">
                    {l.totalClicks}
                  </div>
                  <div className="text-[11px] text-textItemBlur">clicks</div>
                </div>
                <Btn
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(`${backendUrl}/l/${l.shortCode}`)
                      .then(() => toaster.show('Link copied', 'success'))
                      .catch(() => toaster.show('Could not copy', 'warning'));
                  }}
                >
                  Copy
                </Btn>
              </div>
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form onSubmit={create} noValidate className="flex items-start gap-2">
          <TextField
            wrapperClassName="flex-1"
            label="Landing page"
            placeholder="https://example.com/offer"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={touched.blur('url')}
            error={touched.show(
              'url',
              valid ? null : 'Enter a full link starting with https://'
            )}
          />
          <Btn type="submit" busy={busy} className="mt-[26px]">
            Create link
          </Btn>
        </form>
      )}
    </Card>
  );
};

export const CampaignDetailComponent: FC<{ id: string }> = ({ id }) => {
  const api = useAgencyApi();
  const router = useRouter();
  const toaster = useToaster();
  const { can } = useCan();
  const { data: c, error, mutate } = useCampaign(id);
  const { data: audit } = useCampaignAudit(id, can('audit:read'));
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    if (!c) return;
    api
      .post<Preview>('/agency/campaigns/preview', {
        contentTitle: c.contentTitle ?? undefined,
        contentBody: c.contentBody,
        ctaLink: c.ctaLink ?? undefined,
        ctaText: c.ctaText ?? undefined,
        telegramChannelLink: c.telegramChannelLink ?? undefined,
        media: parseMedia(c.contentMedia).map((m) => m.path),
      })
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [api, c]);

  if (error) {
    return (
      <PageShell>
        <LoadError error={error} onRetry={() => mutate()} />
      </PageShell>
    );
  }
  if (!c) {
    return (
      <PageShell>
        <Loading label="Loading campaign" />
      </PageShell>
    );
  }

  const act = async (
    key: string,
    path: string,
    done: string,
    confirm?: { message: string; button: string; destructive?: boolean }
  ) => {
    if (
      confirm &&
      !(await deleteDialog(
        confirm.message,
        confirm.button,
        undefined,
        undefined,
        confirm.destructive
      ))
    ) {
      return;
    }
    setBusy(key);
    try {
      await api.post(path, {});
      toaster.show(done, 'success');
      await mutate();
    } catch (e) {
      toaster.show((e as Error).message, 'warning');
    } finally {
      setBusy(null);
    }
  };

  const base = `/agency/campaigns/${c.id}`;
  const s = c.status;
  const editable = s === 'DRAFT' || s === 'CHANGES_REQUESTED';
  const media = parseMedia(c.contentMedia);
  const steps = progress(s);

  // ------------------------------------------------------------------ actions
  // One primary action: the obvious next step. Everything else lives in the menu.
  let primary: React.ReactNode = null;
  if (editable && can('campaign:write')) {
    primary = (
      <Btn
        variant="primary"
        busy={busy === 'submit'}
        onClick={() => act('submit', `${base}/submit`, 'Submitted for review')}
      >
        Submit for review
      </Btn>
    );
  } else if (
    (s === 'SUBMITTED' || s === 'UNDER_REVIEW') &&
    can('campaign:approve')
  ) {
    primary = (
      <LinkBtn href="/agency/approvals" variant="primary">
        Review now
      </LinkBtn>
    );
  } else if (s === 'APPROVED' && can('campaign:schedule')) {
    primary = (
      <Btn
        variant="primary"
        disabled={!c.startDate}
        busy={busy === 'schedule'}
        onClick={() => act('schedule', `${base}/schedule`, 'Scheduled')}
      >
        Schedule
      </Btn>
    );
  } else if (s === 'PAUSED' && can('campaign:control')) {
    primary = (
      <Btn
        variant="primary"
        busy={busy === 'resume'}
        onClick={() => act('resume', `${base}/resume`, 'Resumed')}
      >
        Resume
      </Btn>
    );
  } else if (
    (s === 'FAILED' || s === 'PARTIALLY_FAILED') &&
    can('campaign:control')
  ) {
    primary = (
      <Btn
        variant="primary"
        busy={busy === 'retry'}
        onClick={() =>
          act('retry', `${base}/retry`, 'Retrying the failed posts')
        }
      >
        Retry failed posts
      </Btn>
    );
  }

  const menu: MenuItem[] = [];
  if ((s === 'APPROVED' || s === 'SCHEDULED') && can('campaign:publish')) {
    menu.push({
      label: 'Send now',
      onClick: () =>
        void act('publish', `${base}/publish`, 'Queued to send now', {
          message: `Send "${c.name}" to ${c.destinations.length} destination(s) right now?`,
          button: 'Yes, send now',
        }),
    });
  }
  if ((s === 'SCHEDULED' || s === 'PUBLISHING') && can('campaign:control')) {
    menu.push({
      label: 'Pause',
      onClick: () => void act('pause', `${base}/pause`, 'Paused'),
    });
  }
  if (
    ['APPROVED', 'SCHEDULED', 'PAUSED', 'FAILED', 'PARTIALLY_FAILED'].includes(
      s
    ) &&
    can('campaign:control')
  ) {
    menu.push({
      label: 'Reopen to edit',
      onClick: () =>
        void act('reopen', `${base}/reopen`, 'Reopened as a draft', {
          message:
            'Reopening cancels anything still queued and voids the approval, so the edited version must be reviewed again.',
          button: 'Yes, reopen it',
        }),
    });
  }
  if (can('campaign:write')) {
    menu.push({
      label: 'Duplicate',
      onClick: () =>
        void (async () => {
          setBusy('dup');
          try {
            const copy = await api.post<{ id: string }>(`${base}/duplicate`);
            toaster.show('Copied as a new draft', 'success');
            router.push(`/agency/campaigns/${copy.id}`);
          } catch (e) {
            toaster.show((e as Error).message, 'warning');
          } finally {
            setBusy(null);
          }
        })(),
    });
  }
  if (can('analytics:read')) {
    menu.push({
      label: 'Download delivery report (CSV)',
      onClick: () =>
        void api
          .download(`${base}/export/csv`, `campaign-${c.id}.csv`)
          .catch((e: Error) => toaster.show(e.message, 'warning')),
    });
  }
  if (
    ['COMPLETED', 'CANCELLED', 'FAILED', 'PARTIALLY_FAILED'].includes(s) &&
    can('campaign:control')
  ) {
    menu.push({
      label: 'Archive',
      onClick: () => void act('archive', `${base}/archive`, 'Archived'),
    });
  }
  if (
    !['CANCELLED', 'COMPLETED', 'ARCHIVED'].includes(s) &&
    can('campaign:control')
  ) {
    menu.push({
      label: 'Cancel campaign',
      danger: true,
      onClick: () =>
        void act('cancel', `${base}/cancel`, 'Cancelled', {
          message:
            'Cancel this campaign? Anything not yet sent will not be sent.',
          button: 'Yes, cancel it',
          destructive: true,
        }),
    });
  }

  const delivered = c.postingJobs.filter(
    (j) => j.status === 'SUCCEEDED'
  ).length;

  return (
    <PageShell>
      <PageHeader
        back={{ href: '/agency/campaigns', label: 'Campaigns' }}
        title={c.name}
        badge={<StatusBadge status={c.status} />}
        subtitle={`${c.customer?.companyName || c.customer?.name} · ${humanize(
          c.objective
        )} · created by ${c.createdBy?.name} on ${formatDate(c.createdAt)}`}
        actions={
          <>
            {editable && can('campaign:write') && (
              <LinkBtn href={`${base}/edit`}>Edit</LinkBtn>
            )}
            {primary}
            <Menu items={menu} />
          </>
        }
      />

      {c.requiresAttention && (
        <Notice tone="warn">
          <strong className="font-semibold">Needs attention.</strong>{' '}
          {c.attentionReason}
        </Notice>
      )}

      {steps && (
        <Card>
          <Stepper
            steps={STEPS}
            current={steps.current}
            attention={steps.attention}
          />
          <p className="text-[13px] text-textItemBlur">{nextStep(c)}</p>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 flex flex-col gap-6 min-w-0">
          <Card
            title="Delivery"
            subtitle={
              c.postingJobs.length
                ? `${delivered} of ${c.postingJobs.length} delivered`
                : 'Nothing queued yet.'
            }
          >
            {c.postingJobs.length > 0 ? (
              <JobsTable
                jobs={c.postingJobs}
                canControl={can('campaign:control')}
                onChanged={() => mutate()}
              />
            ) : c.destinations.length === 0 ? (
              <EmptyState
                icon="send"
                title="No destinations chosen"
                hint="Edit the campaign to choose where it should post."
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {c.destinations.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center justify-between gap-3 rounded-xl bg-[var(--ag-neutral-bg)] px-4 py-3 text-[13px]"
                  >
                    <span className="text-newTextColor font-medium">
                      {d.telegramDestination?.title ??
                        d.integration?.name ??
                        'Destination'}
                    </span>
                    {d.telegramDestination?.authorizationStatus && (
                      <StatusBadge
                        status={d.telegramDestination.authorizationStatus}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Review history">
            {c.approvals.length === 0 ? (
              <p className="text-[13px] text-textItemBlur">
                Not submitted for review yet.
              </p>
            ) : (
              <ol className="flex flex-col gap-4">
                {c.approvals.map((a) => (
                  <li
                    key={a.id}
                    className="text-[13px] flex flex-col gap-1.5 border-l-2 border-[color:var(--ag-hairline)] pl-4"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={a.status} />
                      <span className="text-textItemBlur">
                        Submitted by {a.submittedByUser?.name} ·{' '}
                        {formatDateTime(a.createdAt)}
                      </span>
                    </div>
                    {a.submissionNotes && (
                      <p className="text-textItemBlur italic">
                        “{a.submissionNotes}”
                      </p>
                    )}
                    {a.reviewedAt && (
                      <div className="text-textItemBlur">
                        Reviewed by {a.reviewedByUser?.name ?? 'a manager'} ·{' '}
                        {formatDateTime(a.reviewedAt)}
                        {a.selfApproved && (
                          <span className={TONE_TEXT.warn}>
                            {' '}
                            · approved by its own submitter (owner or admin)
                          </span>
                        )}
                        {a.reviewNotes && (
                          <p className="italic">“{a.reviewNotes}”</p>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {c.requiresClientApproval && (
              <p className="text-[13px] text-textItemBlur">
                Client sign-off:{' '}
                {c.clientApprovedAt ? (
                  <span className={TONE_TEXT.good}>
                    given {formatDateTime(c.clientApprovedAt)}
                  </span>
                ) : (
                  <span className={TONE_TEXT.warn}>not given yet</span>
                )}
              </p>
            )}
          </Card>

          <TrackingLinks
            c={c}
            canWrite={can('campaign:write')}
            onChanged={() => mutate()}
          />

          {can('audit:read') && (
            <Card title="Activity" subtitle="Who did what, and when.">
              {!audit ? (
                <Loading rows={3} />
              ) : audit.length === 0 ? (
                <p className="text-[13px] text-textItemBlur">
                  No activity recorded.
                </p>
              ) : (
                <ul className="flex flex-col">
                  {audit.map((a) => (
                    <li
                      key={a.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-t first:border-t-0 border-[color:var(--ag-hairline)] py-2.5 text-[13px]"
                    >
                      <span className="text-newTextColor">
                        {humanize(a.action.replace('.', ' '))}
                        {a.summary && (
                          <span className="text-textItemBlur">
                            {' '}
                            · {prettySummary(a.summary)}
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-textItemBlur shrink-0">
                        {a.actorRole ? roleLabel(a.actorRole) : 'System'} ·{' '}
                        {timeAgo(a.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>

        <div className="lg:col-span-5 flex flex-col gap-6 min-w-0">
          <TelegramPreview preview={preview} media={media} />
          {!!c.variants?.length && (
            <Card
              title="Versions being compared"
              subtitle="Chats take turns: the first chat gets A, the next B, and so on."
            >
              <ul className="flex flex-col gap-3">
                {[
                  {
                    label: 'A',
                    contentTitle: c.contentTitle,
                    contentBody: c.contentBody,
                  },
                  ...c.variants,
                ].map((v) => (
                  <li
                    key={v.label}
                    className="flex gap-3 rounded-xl bg-[var(--ag-neutral-bg)] p-3 text-[13px]"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ag-accent-soft)] text-xs font-semibold text-[color:var(--ag-accent-text)]">
                      {v.label}
                    </span>
                    <div className="min-w-0">
                      {v.contentTitle && (
                        <div className="font-medium text-newTextColor">
                          {v.contentTitle}
                        </div>
                      )}
                      <p className="line-clamp-3 whitespace-pre-wrap break-words text-textItemBlur">
                        {v.contentBody}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="Details">
            <dl className="grid grid-cols-2 gap-y-3 text-[13px]">
              <dt className="text-textItemBlur">Starts</dt>
              <dd className="text-newTextColor text-right">
                {formatDateTime(c.startDate)}
              </dd>
              <dt className="text-textItemBlur">Stops sending</dt>
              <dd className="text-newTextColor text-right">
                {c.endDate ? formatDateTime(c.endDate) : 'No end'}
              </dd>
              <dt className="text-textItemBlur">Schedule</dt>
              <dd className="text-newTextColor text-right">
                {describeSchedule(
                  c.scheduleKind,
                  c.intervalMinutes,
                  c.occurrences
                )}
              </dd>
              <dt className="text-textItemBlur">Budget</dt>
              <dd className="text-newTextColor text-right">
                {money(c.budget)}
              </dd>
              <dt className="text-textItemBlur">Approved</dt>
              <dd className="text-newTextColor text-right">
                {c.approvedAt ? formatDateTime(c.approvedAt) : '—'}
              </dd>
              <dt className="text-textItemBlur">Version</dt>
              <dd className="text-newTextColor text-right tabular-nums">
                {c.revision}
              </dd>
            </dl>
            {c.internalNotes && (
              <div className="text-[13px] border-t border-[color:var(--ag-hairline)] pt-4">
                <div className="text-xs font-medium text-textItemBlur mb-1.5">
                  Internal notes
                </div>
                <p className="text-newTextColor whitespace-pre-wrap">
                  {c.internalNotes}
                </p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </PageShell>
  );
};
