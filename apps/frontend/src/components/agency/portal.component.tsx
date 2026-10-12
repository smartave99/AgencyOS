'use client';

import React, { FC, useEffect, useState } from 'react';
import clsx from 'clsx';
import { useToaster } from '@gitroom/react/toaster/toaster';
import {
  PortalOverview,
  useAgencyApi,
  useCan,
  useClients,
  usePortal,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Card,
  EmptyState,
  formatDate,
  inputClass,
  labelClass,
  LoadError,
  Loading,
  PageHeader,
  PageShell,
  StatusBadge,
} from '@gitroom/frontend/components/agency/agency.ui';

type Campaign = PortalOverview['campaigns'][number];

// ---------------------------------------------------------------------------
// Client feedback
// ---------------------------------------------------------------------------
const ReviewDialog: FC<{
  campaign: Campaign;
  action: 'APPROVE' | 'REQUEST_CHANGES';
  onClose: () => void;
  onDone: () => void;
}> = ({ campaign, action, onClose, onDone }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const [feedback, setFeedback] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const error =
    action === 'REQUEST_CHANGES' && !feedback.trim()
      ? 'Tell us what to change.'
      : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (error) return;
    setBusy(true);
    try {
      const res = await api.post<{ message: string }>('/agency/portal/review', {
        campaignId: campaign.id,
        action,
        feedback: feedback.trim() || undefined,
      });
      toaster.show(res.message, 'success');
      onDone();
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
      aria-labelledby="client-review-title"
    >
      <form
        onSubmit={submit}
        className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-6 max-w-md w-full shadow-2xl flex flex-col gap-4"
      >
        <div>
          <h3
            id="client-review-title"
            className="text-base font-bold text-newTextColor"
          >
            {action === 'APPROVE' ? 'Approve this ad' : 'Request changes'}
          </h3>
          <p className="text-xs text-textItemBlur mt-1">
            {action === 'APPROVE'
              ? `You are approving “${campaign.name}” as it reads now. The agency still schedules and publishes it.`
              : `Your note goes to the agency team and “${campaign.name}” goes back to them for edits.`}
          </p>
        </div>
        <div>
          <label htmlFor="client-feedback" className={labelClass}>
            {action === 'APPROVE'
              ? 'Comment (optional)'
              : 'What should change?'}
          </label>
          <textarea
            id="client-feedback"
            rows={4}
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && !!error}
            className={clsx(inputClass, 'resize-none')}
          />
          {touched && error && (
            <p className="text-[11px] text-rose-400 mt-1">{error}</p>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-3 border-t border-newBgLineColor">
          <Btn type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn
            type="submit"
            variant={action === 'APPROVE' ? 'primary' : 'danger'}
            busy={busy}
          >
            {action === 'APPROVE' ? 'Approve' : 'Send feedback'}
          </Btn>
        </div>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// One client's view. Identical for a client and for staff previewing it.
// ---------------------------------------------------------------------------
const Stat: FC<{ label: string; value: string; hint: string }> = ({
  label,
  value,
  hint,
}) => (
  <div className="bg-newBgColorInner border border-newBgLineColor rounded-xl p-4">
    <p className="text-xs text-textItemBlur">{label}</p>
    <p className="mt-2 text-2xl font-bold text-newTextColor">{value}</p>
    <p className="text-[11px] text-textItemBlur mt-1">{hint}</p>
  </div>
);

const PortalView: FC<{ clientId: string | null }> = ({ clientId }) => {
  const portal = usePortal(clientId);
  const [reviewing, setReviewing] = useState<{
    campaign: Campaign;
    action: 'APPROVE' | 'REQUEST_CHANGES';
  } | null>(null);

  if (portal.error) {
    return <LoadError error={portal.error} onRetry={() => portal.mutate()} />;
  }
  if (!portal.data) return <Loading label="Loading your campaigns…" />;

  const { client, metrics, campaigns, viewer } = portal.data;
  const waiting = campaigns.filter((c) => c.awaitingClientApproval);

  return (
    <>
      <Card>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-newTextColor">
              {client.companyName}
            </h2>
            <p className="text-xs text-textItemBlur mt-1">
              {[client.name, client.email, client.phone]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          {client.accountRep && (
            <div className="text-xs text-textItemBlur sm:text-right">
              <span className="block uppercase text-[11px]">
                Your account manager
              </span>
              <span className="block text-sm font-semibold text-newTextColor">
                {client.accountRep.name}
              </span>
              <a
                href={`mailto:${client.accountRep.email}`}
                className="text-blue-400 hover:underline"
              >
                {client.accountRep.email}
              </a>
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat
          label="Awaiting your approval"
          value={String(waiting.length)}
          hint="Ads that need your sign-off"
        />
        <Stat
          label="Live or scheduled"
          value={String(metrics.activeCampaigns + metrics.scheduledCampaigns)}
          hint="Campaigns currently going out"
        />
        <Stat
          label="Delivered posts"
          value={metrics.successfulPublications.toLocaleString()}
          hint="Confirmed by Telegram"
        />
        <Stat
          label="Tracked link clicks"
          value={metrics.totalLinkClicks.toLocaleString()}
          hint="Clicks on tracking links we created"
        />
      </div>

      <Card title="Your campaigns" subtitle={`${campaigns.length} in total`}>
        {campaigns.length === 0 ? (
          <EmptyState
            title="No campaigns yet"
            hint="When your agency creates an ad for you it will appear here."
          />
        ) : (
          <ul className="flex flex-col gap-4">
            {campaigns.map((c) => (
              <li
                key={c.id}
                className="rounded-xl border border-newBgLineColor bg-newBgColor p-5 flex flex-col gap-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-newTextColor">
                      {c.name}
                    </h3>
                    <p className="text-[11px] text-textItemBlur mt-0.5">
                      {c.destinationsCount} destination
                      {c.destinationsCount === 1 ? '' : 's'}
                      {c.startDate && ` · starts ${formatDate(c.startDate)}`}
                      {c.totalClicks > 0 &&
                        ` · ${c.totalClicks.toLocaleString()} tracked clicks`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {c.clientApprovedAt && (
                      <span className="text-[11px] text-emerald-400">
                        You approved on {formatDate(c.clientApprovedAt)}
                      </span>
                    )}
                    <StatusBadge status={c.status} />
                  </div>
                </div>

                {(c.contentTitle || c.contentBody) && (
                  <div className="rounded-lg border border-newBgLineColor bg-newBgColorInner p-3 text-xs text-newTextColor whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                    {c.contentTitle && (
                      <div className="font-semibold mb-1">{c.contentTitle}</div>
                    )}
                    {c.contentBody}
                    {c.ctaLink && (
                      <div className="mt-2 text-blue-400 break-all">
                        {c.ctaText || 'Link'}: {c.ctaLink}
                      </div>
                    )}
                  </div>
                )}

                {!!c.contentMedia?.length && (
                  <div className="flex flex-wrap gap-2">
                    {c.contentMedia.map((src) => (
                      <img
                        key={src}
                        src={src}
                        alt=""
                        className="h-20 w-20 rounded-lg object-cover border border-newBgLineColor"
                      />
                    ))}
                  </div>
                )}

                {c.awaitingClientApproval && viewer.canReview && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Btn
                      variant="primary"
                      onClick={() =>
                        setReviewing({ campaign: c, action: 'APPROVE' })
                      }
                    >
                      Approve this ad
                    </Btn>
                    <Btn
                      variant="danger"
                      onClick={() =>
                        setReviewing({ campaign: c, action: 'REQUEST_CHANGES' })
                      }
                    >
                      Request changes
                    </Btn>
                  </div>
                )}
                {c.awaitingClientApproval && !viewer.canReview && (
                  <p className="text-[11px] text-amber-400">
                    Waiting for the client’s approval. Only the client can give
                    it.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {reviewing && (
        <ReviewDialog
          campaign={reviewing.campaign}
          action={reviewing.action}
          onClose={() => setReviewing(null)}
          onDone={() => {
            setReviewing(null);
            portal.mutate();
          }}
        />
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Staff preview: pick a client and see exactly what they see
// ---------------------------------------------------------------------------
const StaffPreview = () => {
  const clients = useClients();
  const [clientId, setClientId] = useState<string | null>(null);
  const selected = clientId ?? clients.data?.[0]?.id ?? null;

  if (clients.error) {
    return <LoadError error={clients.error} onRetry={() => clients.mutate()} />;
  }
  if (!clients.data) return <Loading label="Loading clients…" />;
  if (clients.data.length === 0) {
    return (
      <div className="bg-newBgColorInner border border-newBgLineColor rounded-2xl">
        <EmptyState
          title="No clients to preview"
          hint="Add a client first, then you can see the portal exactly as they do."
        />
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-500/20 bg-blue-500/10 p-3 text-xs text-blue-400">
        <span>
          You are previewing this portal as staff. Client approvals can only be
          given by the client’s own login.
        </span>
        <label className="flex items-center gap-2 ml-auto">
          <span>Client</span>
          <select
            value={selected ?? ''}
            onChange={(e) => setClientId(e.target.value)}
            className="bg-newBgColor border border-newBgLineColor rounded-lg px-2 py-1 text-xs text-newTextColor"
          >
            {clients.data.map((c) => (
              <option key={c.id} value={c.id}>
                {c.companyName || c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {selected && <PortalView key={selected} clientId={selected} />}
    </>
  );
};

export const AgencyPortalComponent = () => {
  const { isClient, isLoading } = useCan();
  return (
    <PageShell>
      <PageHeader
        crumb="Client portal"
        title="Client portal"
        subtitle="What your client sees: their ads, the approvals waiting on them and verified delivery. Nothing internal is shown."
      />
      {isLoading ? (
        <Loading />
      ) : isClient ? (
        <PortalView clientId={null} />
      ) : (
        <StaffPreview />
      )}
    </PageShell>
  );
};
