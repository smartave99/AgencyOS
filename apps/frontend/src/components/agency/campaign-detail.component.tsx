'use client';

import React, { FC, useEffect, useState } from 'react';
import Link from 'next/link';
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
  inputClass,
  labelClass,
  Loading,
  LoadError,
  PageShell,
  StatusBadge,
  formatDate,
  formatDateTime,
  humanize,
  timeAgo,
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
    } catch (e: any) {
      toaster.show(e.message, 'warning');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-textItemBlur font-medium border-b border-newBgLineColor">
          <tr>
            <th className="py-2 px-3">Destination</th>
            <th className="py-2 px-3">Status</th>
            <th className="py-2 px-3">Attempts</th>
            <th className="py-2 px-3">When</th>
            <th className="py-2 px-3">Detail</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-newBgLineColor/50">
          {jobs.map((j) => (
            <tr key={j.id} className="align-top">
              <td className="py-2.5 px-3 text-newTextColor font-medium">
                {j.telegramDestination?.title ?? '—'}
              </td>
              <td className="py-2.5 px-3">
                <StatusBadge status={j.status} />
              </td>
              <td className="py-2.5 px-3 text-textItemBlur">
                {j.attempts}/{j.maxAttempts}
              </td>
              <td className="py-2.5 px-3 text-textItemBlur">
                {j.status === 'PENDING'
                  ? `sends ${timeAgo(j.nextAttemptAt)}`
                  : j.completedAt
                  ? formatDateTime(j.completedAt)
                  : '—'}
              </td>
              <td className="py-2.5 px-3 text-textItemBlur max-w-sm">
                {j.releaseUrl ? (
                  <a
                    href={j.releaseUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-400 hover:underline"
                  >
                    View on Telegram ↗
                  </a>
                ) : (
                  jobHint(j) || '—'
                )}
                {j.status === 'UNCERTAIN' && canControl && (
                  <div className="flex gap-1.5 mt-1.5">
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
    } catch (err: any) {
      toaster.show(err.message, 'warning');
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
        <p className="text-xs text-textItemBlur">No tracked links yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {c.trackingLinks.map((l) => (
            <li
              key={l.id}
              className="flex items-center justify-between gap-3 rounded-lg bg-newBgColor border border-newBgLineColor px-3 py-2 text-xs"
            >
              <div className="min-w-0">
                <code className="text-newTextColor break-all">
                  {backendUrl}/l/{l.shortCode}
                </code>
                <div className="text-textItemBlur truncate">
                  → {l.destinationUrl}
                </div>
              </div>
              <div className="text-right shrink-0">
                <button
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(`${backendUrl}/l/${l.shortCode}`)
                      .then(() => toaster.show('Link copied', 'success'))
                      .catch(() => toaster.show('Could not copy', 'warning'));
                  }}
                  className="text-[11px] text-blue-400 hover:underline mb-1"
                >
                  Copy
                </button>
                <div className="text-newTextColor font-semibold">
                  {l.totalClicks}
                </div>
                <div className="text-[10px] text-textItemBlur">clicks</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form onSubmit={create} className="flex items-end gap-2">
          <div className="flex-1">
            <label htmlFor="tl" className={labelClass}>
              Landing page
            </label>
            <input
              id="tl"
              className={inputClass}
              placeholder="https://example.com/offer"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-invalid={!!url && !valid}
            />
            {url && !valid && (
              <p className="text-[11px] text-rose-400 mt-1">
                Enter a full link starting with https://
              </p>
            )}
          </div>
          <Btn type="submit" busy={busy} disabled={!valid}>
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
        <Loading label="Loading campaign…" />
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
    } catch (e: any) {
      toaster.show(e.message, 'warning');
    } finally {
      setBusy(null);
    }
  };

  const base = `/agency/campaigns/${c.id}`;
  const s = c.status;
  const editable = s === 'DRAFT' || s === 'CHANGES_REQUESTED';
  const media = parseMedia(c.contentMedia);
  const downloadCsv = async () => {
    try {
      await api.download(`${base}/export/csv`, `campaign-${c.id}.csv`);
    } catch (e: any) {
      toaster.show(e.message, 'warning');
    }
  };

  const actions: React.ReactNode[] = [];
  if (editable && can('campaign:write')) {
    actions.push(
      <Link key="edit" href={`${base}/edit`}>
        <Btn>Edit</Btn>
      </Link>,
      <Btn
        key="submit"
        variant="primary"
        busy={busy === 'submit'}
        onClick={() => act('submit', `${base}/submit`, 'Submitted for review')}
      >
        Submit for review
      </Btn>
    );
  }
  if ((s === 'SUBMITTED' || s === 'UNDER_REVIEW') && can('campaign:approve')) {
    actions.push(
      <Link key="review" href="/agency/approvals">
        <Btn variant="primary">Review now</Btn>
      </Link>
    );
  }
  if (s === 'APPROVED' && can('campaign:schedule')) {
    actions.push(
      <Btn
        key="schedule"
        variant="primary"
        disabled={!c.startDate}
        busy={busy === 'schedule'}
        onClick={() => act('schedule', `${base}/schedule`, 'Scheduled')}
      >
        Schedule
      </Btn>
    );
  }
  if ((s === 'APPROVED' || s === 'SCHEDULED') && can('campaign:publish')) {
    actions.push(
      <Btn
        key="publish"
        busy={busy === 'publish'}
        onClick={() =>
          act('publish', `${base}/publish`, 'Queued to send now', {
            message: `Send "${c.name}" to ${c.destinations.length} destination(s) right now?`,
            button: 'Yes, send now',
          })
        }
      >
        Send now
      </Btn>
    );
  }
  if ((s === 'SCHEDULED' || s === 'PUBLISHING') && can('campaign:control')) {
    actions.push(
      <Btn
        key="pause"
        busy={busy === 'pause'}
        onClick={() => act('pause', `${base}/pause`, 'Paused')}
      >
        Pause
      </Btn>
    );
  }
  if (s === 'PAUSED' && can('campaign:control')) {
    actions.push(
      <Btn
        key="resume"
        variant="primary"
        busy={busy === 'resume'}
        onClick={() => act('resume', `${base}/resume`, 'Resumed')}
      >
        Resume
      </Btn>
    );
  }
  if ((s === 'FAILED' || s === 'PARTIALLY_FAILED') && can('campaign:control')) {
    actions.push(
      <Btn
        key="retry"
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
  if (
    ['APPROVED', 'SCHEDULED', 'PAUSED', 'FAILED', 'PARTIALLY_FAILED'].includes(
      s
    ) &&
    can('campaign:control')
  ) {
    actions.push(
      <Btn
        key="reopen"
        busy={busy === 'reopen'}
        onClick={() =>
          act('reopen', `${base}/reopen`, 'Reopened as a draft', {
            message:
              'Reopening cancels anything still queued and voids the approval, so the edited version must be reviewed again.',
            button: 'Yes, reopen it',
          })
        }
      >
        Reopen to edit
      </Btn>
    );
  }
  if (can('campaign:write')) {
    actions.push(
      <Btn
        key="dup"
        busy={busy === 'dup'}
        onClick={async () => {
          setBusy('dup');
          try {
            const copy = await api.post<{ id: string }>(`${base}/duplicate`);
            toaster.show('Copied as a new draft', 'success');
            router.push(`/agency/campaigns/${copy.id}`);
          } catch (e: any) {
            toaster.show(e.message, 'warning');
          } finally {
            setBusy(null);
          }
        }}
      >
        Duplicate
      </Btn>
    );
  }
  if (can('analytics:read')) {
    actions.push(
      <Btn key="csv" variant="ghost" onClick={downloadCsv}>
        Download report
      </Btn>
    );
  }
  if (
    ['COMPLETED', 'CANCELLED', 'FAILED', 'PARTIALLY_FAILED'].includes(s) &&
    can('campaign:control')
  ) {
    actions.push(
      <Btn
        key="archive"
        variant="ghost"
        busy={busy === 'archive'}
        onClick={() => act('archive', `${base}/archive`, 'Archived')}
      >
        Archive
      </Btn>
    );
  }
  if (
    !['CANCELLED', 'COMPLETED', 'ARCHIVED'].includes(s) &&
    can('campaign:control')
  ) {
    actions.push(
      <Btn
        key="cancel"
        variant="danger"
        busy={busy === 'cancel'}
        onClick={() =>
          act('cancel', `${base}/cancel`, 'Cancelled', {
            message:
              'Cancel this campaign? Anything not yet sent will not be sent.',
            button: 'Yes, cancel it',
            destructive: true,
          })
        }
      >
        Cancel campaign
      </Btn>
    );
  }

  const delivered = c.postingJobs.filter(
    (j) => j.status === 'SUCCEEDED'
  ).length;

  return (
    <PageShell>
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-newBgLineColor pb-5">
        <div className="min-w-0">
          <Link
            href="/agency/campaigns"
            className="text-xs text-blue-400 hover:underline"
          >
            ← All campaigns
          </Link>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <h1 className="text-2xl font-bold text-newTextColor tracking-tight">
              {c.name}
            </h1>
            <StatusBadge status={c.status} />
          </div>
          <p className="text-xs text-textItemBlur mt-0.5">
            {c.customer?.companyName || c.customer?.name} ·{' '}
            {humanize(c.objective)} · created by {c.createdBy?.name} on{' '}
            {formatDate(c.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 justify-end">
          {actions}
        </div>
      </div>

      {c.requiresAttention && (
        <div
          role="alert"
          className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs text-amber-400"
        >
          <strong>Needs attention.</strong> {c.attentionReason}
        </div>
      )}
      {s === 'APPROVED' && !c.startDate && (
        <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-xs text-blue-300">
          It’s approved but has no start time yet. Reopen it, set one, and have
          it approved again, or ask the author to set it before approval.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 flex flex-col gap-6">
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
                title="No destinations chosen"
                hint="Edit the campaign to choose where it should post."
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {c.destinations.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center justify-between gap-3 rounded-lg bg-newBgColor border border-newBgLineColor px-3 py-2 text-xs"
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
              <p className="text-xs text-textItemBlur">
                Not submitted for review yet.
              </p>
            ) : (
              <ol className="flex flex-col gap-3">
                {c.approvals.map((a) => (
                  <li
                    key={a.id}
                    className="text-xs flex flex-col gap-1 border-l-2 border-newBgLineColor pl-3"
                  >
                    <div className="flex items-center gap-2">
                      <StatusBadge status={a.status} />
                      <span className="text-textItemBlur">
                        submitted by {a.submittedByUser?.name} ·{' '}
                        {formatDateTime(a.createdAt)}
                      </span>
                    </div>
                    {a.submissionNotes && (
                      <div className="text-textItemBlur italic">
                        “{a.submissionNotes}”
                      </div>
                    )}
                    {a.reviewedAt && (
                      <div className="text-textItemBlur">
                        reviewed by {a.reviewedByUser?.name ?? 'a manager'} ·{' '}
                        {formatDateTime(a.reviewedAt)}
                        {a.selfApproved && (
                          <span className="text-amber-400">
                            {' '}
                            · approved by its own submitter (owner/admin)
                          </span>
                        )}
                        {a.reviewNotes && (
                          <div className="italic">“{a.reviewNotes}”</div>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {c.requiresClientApproval && (
              <p className="text-xs text-textItemBlur">
                Client sign-off required:{' '}
                {c.clientApprovedAt ? (
                  <span className="text-emerald-400">
                    given {formatDateTime(c.clientApprovedAt)}
                  </span>
                ) : (
                  <span className="text-amber-400">not given yet</span>
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
                <Loading />
              ) : audit.length === 0 ? (
                <p className="text-xs text-textItemBlur">
                  No activity recorded.
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {audit.map((a) => (
                    <li
                      key={a.id}
                      className="text-xs flex items-baseline justify-between gap-3"
                    >
                      <span className="text-newTextColor">
                        {humanize(a.action.replace('.', ' '))}
                        {a.summary && (
                          <span className="text-textItemBlur">
                            {' '}
                            · {a.summary}
                          </span>
                        )}
                      </span>
                      <span className="text-[11px] text-textItemBlur shrink-0">
                        {a.actorRole ?? 'System'} · {timeAgo(a.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>

        <div className="lg:col-span-5 flex flex-col gap-6">
          <TelegramPreview preview={preview} media={media} />
          <Card title="Details">
            <dl className="grid grid-cols-2 gap-y-2 text-xs">
              <dt className="text-textItemBlur">Starts</dt>
              <dd className="text-newTextColor">
                {formatDateTime(c.startDate)}
              </dd>
              <dt className="text-textItemBlur">Stops sending</dt>
              <dd className="text-newTextColor">
                {c.endDate ? formatDateTime(c.endDate) : 'No end'}
              </dd>
              <dt className="text-textItemBlur">Budget</dt>
              <dd className="text-newTextColor">
                {c.budget ? `$${Number(c.budget).toLocaleString()}` : '—'}
              </dd>
              <dt className="text-textItemBlur">Approved</dt>
              <dd className="text-newTextColor">
                {c.approvedAt ? formatDateTime(c.approvedAt) : '—'}
              </dd>
              <dt className="text-textItemBlur">Version</dt>
              <dd className="text-newTextColor">{c.revision}</dd>
            </dl>
            {c.internalNotes && (
              <div className="text-xs">
                <div className={labelClass}>Internal notes</div>
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
