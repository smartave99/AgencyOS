'use client';

import React, { FC, useState } from 'react';
import { useToaster } from '@gitroom/react/toaster/toaster';
import {
  PortalOverview,
  useAgencyApi,
  useCan,
  useClients,
  usePortal,
} from '@gitroom/frontend/components/agency/agency.hooks';
import { TelegramBubble } from '@gitroom/frontend/components/agency/campaign-form.component';
import {
  Btn,
  Card,
  Dialog,
  EmptyState,
  formatDate,
  Icon,
  LoadError,
  Loading,
  Notice,
  PageHeader,
  PageShell,
  SelectField,
  Stat,
  StatusBadge,
  TextArea,
  TONE_TEXT,
  useBusy,
  useTouched,
} from '@gitroom/frontend/components/agency/agency.ui';

type Campaign = PortalOverview['campaigns'][number];

const media = (c: Campaign) =>
  (c.contentMedia ?? []).map((path, i) => ({ id: `m${i}`, path }));

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
  const touched = useTouched();
  const { busy, run } = useBusy();
  const [feedback, setFeedback] = useState('');

  const error =
    action === 'REQUEST_CHANGES' && !feedback.trim()
      ? 'Tell us what to change.'
      : undefined;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    touched.all(['feedback']);
    if (error) return;
    await run(async () => {
      try {
        const res = await api.post<{ message: string }>(
          '/agency/portal/review',
          {
            campaignId: campaign.id,
            action,
            feedback: feedback.trim() || undefined,
          }
        );
        toaster.show(res.message, 'success');
        onDone();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  return (
    <Dialog
      title={action === 'APPROVE' ? 'Approve this ad' : 'Request changes'}
      description={
        action === 'APPROVE'
          ? `You are approving “${campaign.name}” as it reads now. The agency still schedules and publishes it.`
          : `Your note goes to the agency team and “${campaign.name}” goes back to them for edits.`
      }
      onClose={onClose}
      busy={busy}
      onSubmit={submit}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn
            type="submit"
            variant={action === 'APPROVE' ? 'primary' : 'danger'}
            busy={busy}
          >
            {action === 'APPROVE' ? 'Approve' : 'Send feedback'}
          </Btn>
        </>
      }
    >
      <TextArea
        autoFocus
        label={action === 'APPROVE' ? 'Comment' : 'What should change?'}
        optional={action === 'APPROVE'}
        rows={4}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        onBlur={touched.blur('feedback')}
        error={touched.show('feedback', error)}
      />
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// One client's view. Identical for a client and for staff previewing it.
// ---------------------------------------------------------------------------
const PortalView: FC<{ clientId: string | null; heading: boolean }> = ({
  clientId,
  heading,
}) => {
  const portal = usePortal(clientId);
  const [reviewing, setReviewing] = useState<{
    campaign: Campaign;
    action: 'APPROVE' | 'REQUEST_CHANGES';
  } | null>(null);

  if (portal.error) {
    return <LoadError error={portal.error} onRetry={() => portal.mutate()} />;
  }
  if (!portal.data) return <Loading label="Loading your campaigns" />;

  const { client, metrics, campaigns, viewer } = portal.data;
  const waiting = campaigns.filter((c) => c.awaitingClientApproval);
  const rest = campaigns.filter((c) => !c.awaitingClientApproval);

  return (
    <>
      {heading && (
        <PageHeader
          title={client.companyName}
          subtitle={
            client.accountRep
              ? `Your campaigns and approvals. Your account manager is ${client.accountRep.name}.`
              : 'Your campaigns and approvals.'
          }
          actions={
            client.accountRep && (
              <a
                href={`mailto:${client.accountRep.email}`}
                className="inline-flex h-8 items-center gap-1.5 rounded-[10px] border border-[color:var(--ag-hairline)] px-3 text-[13px] font-medium text-newTextColor hover:bg-[var(--ag-neutral-bg)]"
              >
                Contact {client.accountRep.name.split(' ')[0]}
              </a>
            )
          }
        />
      )}

      {waiting.length > 0 ? (
        <section
          className="flex flex-col gap-4"
          aria-label="Needs your approval"
        >
          <h2 className="text-[17px] font-semibold tracking-tight text-newTextColor">
            Needs your approval
          </h2>
          {waiting.map((c) => (
            <article
              key={c.id}
              className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)] shadow-[var(--ag-shadow)] p-5 sm:p-6 grid grid-cols-1 md:grid-cols-2 gap-6"
            >
              <TelegramBubble html={c.preview.html} media={media(c)} />
              <div className="flex flex-col justify-between gap-6">
                <div>
                  <h3 className="text-[17px] font-semibold tracking-tight text-newTextColor">
                    {c.name}
                  </h3>
                  <p className="mt-1 text-[13px] text-textItemBlur">
                    Goes to {c.destinationsCount} channel
                    {c.destinationsCount === 1 ? '' : 's'}
                    {c.startDate && ` · starts ${formatDate(c.startDate)}`}
                  </p>
                  <p className="mt-4 text-[13px] leading-relaxed text-textItemBlur">
                    This is exactly what your audience will see. Approving
                    records your sign-off on this version; the agency still
                    schedules and sends it.
                  </p>
                </div>
                {viewer.canReview ? (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Btn
                      variant="primary"
                      size="md"
                      onClick={() =>
                        setReviewing({ campaign: c, action: 'APPROVE' })
                      }
                    >
                      Approve this ad
                    </Btn>
                    <Btn
                      size="md"
                      onClick={() =>
                        setReviewing({ campaign: c, action: 'REQUEST_CHANGES' })
                      }
                    >
                      Request changes
                    </Btn>
                  </div>
                ) : (
                  <Notice tone="info">
                    Waiting for the client’s approval. Only the client can give
                    it.
                  </Notice>
                )}
              </div>
            </article>
          ))}
        </section>
      ) : (
        <div className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)]">
          <EmptyState
            icon="check"
            title="You’re all caught up"
            hint="Nothing is waiting for your approval. New ads appear here the moment they are ready for you."
          />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Stat
          label="Live or scheduled"
          value={metrics.activeCampaigns + metrics.scheduledCampaigns}
          hint="Campaigns going out"
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
            icon="megaphone"
            title="No campaigns yet"
            hint="When your agency creates an ad for you it will appear here."
          />
        ) : (
          <ul className="flex flex-col">
            {[...waiting, ...rest].map((c) => (
              <li
                key={c.id}
                className="border-t first:border-t-0 border-[color:var(--ag-hairline)]"
              >
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-4 py-4">
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] font-medium text-newTextColor truncate">
                        {c.name}
                      </div>
                      <div className="text-xs text-textItemBlur mt-0.5">
                        {c.destinationsCount} channel
                        {c.destinationsCount === 1 ? '' : 's'}
                        {c.startDate && ` · starts ${formatDate(c.startDate)}`}
                        {c.totalClicks > 0 &&
                          ` · ${c.totalClicks.toLocaleString()} tracked clicks`}
                        {c.clientApprovedAt && (
                          <span className={TONE_TEXT.good}>
                            {' '}
                            · you approved on {formatDate(c.clientApprovedAt)}
                          </span>
                        )}
                      </div>
                    </div>
                    <StatusBadge status={c.status} />
                    <Icon
                      name="chevron"
                      size={16}
                      className="text-textItemBlur transition-transform group-open:rotate-180"
                    />
                  </summary>
                  <div className="pb-5 max-w-md">
                    <TelegramBubble html={c.preview.html} media={media(c)} />
                  </div>
                </details>
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
  if (!clients.data) return <Loading label="Loading clients" />;
  if (clients.data.length === 0) {
    return (
      <div className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)]">
        <EmptyState
          icon="users"
          title="No clients to preview"
          hint="Add a client first, then you can see the portal exactly as they do."
        />
      </div>
    );
  }

  return (
    <>
      <Notice
        tone="info"
        action={
          <SelectField
            label="Client"
            wrapperClassName="w-56"
            value={selected ?? ''}
            onChange={(e) => setClientId(e.target.value)}
          >
            {clients.data.map((c) => (
              <option key={c.id} value={c.id}>
                {c.companyName || c.name}
              </option>
            ))}
          </SelectField>
        }
      >
        You are previewing this portal as staff. Client approvals can only be
        given by the client’s own login.
      </Notice>
      {selected && (
        <PortalView key={selected} clientId={selected} heading={false} />
      )}
    </>
  );
};

export const AgencyPortalComponent = () => {
  const { isClient, isLoading } = useCan();
  return (
    <PageShell>
      {isLoading ? (
        <Loading />
      ) : isClient ? (
        <PortalView clientId={null} heading />
      ) : (
        <>
          <PageHeader
            title="Client portal"
            subtitle="What your client sees: their ads, the approvals waiting on them and verified delivery. Nothing internal is shown."
          />
          <StaffPreview />
        </>
      )}
    </PageShell>
  );
};
