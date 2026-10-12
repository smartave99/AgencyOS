'use client';

import React, { FC, useState } from 'react';
import Link from 'next/link';
import { useToaster } from '@gitroom/react/toaster/toaster';
import {
  useAgencyApi,
  useApprovals,
  useCan,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Dialog,
  EmptyState,
  formatDate,
  LoadError,
  Loading,
  money,
  Notice,
  PageHeader,
  PageShell,
  Segmented,
  StatusBadge,
  TextArea,
  TONE_TEXT,
  useBusy,
  useTouched,
} from '@gitroom/frontend/components/agency/agency.ui';

const FILTERS = [
  { value: 'PENDING', label: 'Waiting for review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'CHANGES_REQUESTED', label: 'Sent back' },
  { value: 'ALL', label: 'All' },
];
const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Waiting for review',
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Sent back',
};

type Decision = 'APPROVE' | 'REJECT';

const ReviewDialog: FC<{
  item: any;
  decision: Decision;
  selfReview: boolean;
  onClose: () => void;
  onDone: () => void;
}> = ({ item, decision, selfReview, onClose, onDone }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const touched = useTouched();
  const { busy, run } = useBusy();
  const [notes, setNotes] = useState('');

  const needsNotes = decision === 'REJECT';
  const notesError =
    needsNotes && !notes.trim()
      ? 'Say what needs to change so the author can fix it.'
      : undefined;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    touched.all(['notes']);
    if (notesError) return;
    await run(async () => {
      try {
        await api.post(`/agency/approvals/${item.id}/review`, {
          decision,
          notes: notes.trim() || undefined,
        });
        toaster.show(
          decision === 'APPROVE'
            ? 'Approved. The campaign can now be scheduled.'
            : 'Sent back to the author with your feedback.',
          'success'
        );
        onDone();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  return (
    <Dialog
      title={
        decision === 'APPROVE'
          ? 'Approve this campaign'
          : 'Send back for changes'
      }
      description={
        decision === 'APPROVE'
          ? `You are approving “${item.campaign.name}” exactly as it reads now. If anyone edits the ad afterwards, the approval no longer applies and it must be reviewed again.`
          : `“${item.campaign.name}” returns to draft so ${
              item.submittedByUser?.name || 'the author'
            } can revise it.`
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
            variant={decision === 'APPROVE' ? 'primary' : 'danger'}
            busy={busy}
          >
            {decision === 'APPROVE' ? 'Approve' : 'Send back'}
          </Btn>
        </>
      }
    >
      {decision === 'APPROVE' && selfReview && (
        <Notice tone="warn">
          You submitted this campaign yourself. Your approval is recorded as a
          self-approval in the audit trail.
        </Notice>
      )}
      <TextArea
        autoFocus
        label={needsNotes ? 'What needs to change' : 'Note'}
        optional={!needsNotes}
        rows={3}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={touched.blur('notes')}
        error={touched.show('notes', notesError)}
      />
    </Dialog>
  );
};

export const AgencyApprovalsComponent = () => {
  const { can, userId, isLoading: roleLoading } = useCan();
  const [filter, setFilter] = useState('PENDING');
  const { data, error, mutate } = useApprovals(filter);
  const [active, setActive] = useState<{
    item: any;
    decision: Decision;
  } | null>(null);

  const canReview = can('campaign:approve');

  return (
    <PageShell>
      <PageHeader
        title="Approvals"
        subtitle="Nothing is published until a reviewer approves the exact content. Review the ad, its destinations and any client sign-off here."
        actions={
          <Segmented
            ariaLabel="Approval status"
            value={filter}
            onChange={setFilter}
            options={FILTERS}
          />
        }
      />

      {!roleLoading && !canReview && (
        <Notice tone="info">
          Your role can see the queue but can’t approve or reject. Ask a manager
          or admin to review.
        </Notice>
      )}

      {error ? (
        <LoadError error={error} onRetry={() => mutate()} />
      ) : !data ? (
        <Loading label="Loading approvals" />
      ) : data.length === 0 ? (
        <div className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)]">
          <EmptyState
            icon="check"
            title={
              filter === 'PENDING'
                ? 'Nothing waiting for review'
                : 'Nothing here'
            }
            hint={
              filter === 'PENDING'
                ? 'When someone submits a campaign for review it will appear here.'
                : 'No approvals match this view.'
            }
          />
        </div>
      ) : (
        <div className="ag-rise flex flex-col gap-4">
          {data.map((item) => {
            const c = item.campaign;
            const destinations: any[] = c.destinations ?? [];
            const selfReview = !!userId && item.submittedByUserId === userId;
            const awaitingClient =
              c.requiresClientApproval && !c.clientApprovedAt;
            return (
              <article
                key={item.id}
                className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)] shadow-[var(--ag-shadow)] p-5 sm:p-6 flex flex-col lg:flex-row gap-6 justify-between"
              >
                <div className="flex-1 flex flex-col gap-4 min-w-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <StatusBadge
                      status={item.status}
                      label={STATUS_LABEL[item.status]}
                    />
                    <span className="text-xs text-textItemBlur">
                      Submitted by {item.submittedByUser?.name || 'unknown'} on{' '}
                      {formatDate(item.createdAt)}
                      {selfReview && ' (you)'}
                    </span>
                  </div>

                  <div>
                    <Link
                      href={`/agency/campaigns/${c.id}`}
                      className="text-[17px] font-semibold tracking-tight text-newTextColor hover:text-[color:var(--ag-accent-text)]"
                    >
                      {c.name}
                    </Link>
                    <div className="text-[13px] text-textItemBlur mt-0.5">
                      {c.customer?.companyName || c.customer?.name}
                      {c.budget && ` · Budget ${money(c.budget)}`}
                    </div>
                  </div>

                  <div className="rounded-xl bg-[var(--ag-neutral-bg)] p-4 text-[13px] leading-relaxed text-newTextColor whitespace-pre-wrap max-h-40 overflow-y-auto break-words">
                    {c.contentTitle && (
                      <div className="font-semibold mb-1">{c.contentTitle}</div>
                    )}
                    {c.contentBody}
                  </div>

                  {c.requiresClientApproval && (
                    <p className="text-[13px] text-textItemBlur">
                      Client sign-off:{' '}
                      {c.clientApprovedAt ? (
                        <span className={TONE_TEXT.good}>
                          given {formatDate(c.clientApprovedAt)}
                        </span>
                      ) : (
                        <span className={TONE_TEXT.warn}>
                          required before it can be approved
                        </span>
                      )}
                    </p>
                  )}

                  {item.submissionNotes && (
                    <p className="text-[13px] text-textItemBlur italic">
                      Author’s note: “{item.submissionNotes}”
                    </p>
                  )}
                </div>

                <div className="lg:w-72 flex flex-col justify-between lg:border-l border-[color:var(--ag-hairline)] lg:pl-6 gap-5">
                  <div>
                    <span className="text-xs font-medium text-textItemBlur">
                      Destinations ({destinations.length})
                    </span>
                    <ul className="flex flex-col gap-1.5 mt-2">
                      {destinations.slice(0, 4).map((d) => (
                        <li
                          key={d.id}
                          className="text-[13px] text-newTextColor truncate flex items-center gap-2"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--ag-accent)] shrink-0" />
                          {d.telegramDestination?.title ||
                            d.integration?.name ||
                            'Destination'}
                        </li>
                      ))}
                      {destinations.length > 4 && (
                        <li className="text-xs text-textItemBlur">
                          + {destinations.length - 4} more
                        </li>
                      )}
                    </ul>
                  </div>

                  {item.status === 'PENDING' ? (
                    canReview && (
                      <div className="flex flex-col gap-2">
                        <Btn
                          variant="primary"
                          className="!h-10"
                          disabled={awaitingClient}
                          title={
                            awaitingClient
                              ? 'The client must sign off first'
                              : undefined
                          }
                          onClick={() =>
                            setActive({ item, decision: 'APPROVE' })
                          }
                        >
                          Approve
                        </Btn>
                        {awaitingClient && (
                          <p className="text-xs text-center text-textItemBlur">
                            Approval unlocks once the client signs off.
                          </p>
                        )}
                        <Btn
                          variant="ghost"
                          onClick={() =>
                            setActive({ item, decision: 'REJECT' })
                          }
                        >
                          Send back for changes
                        </Btn>
                      </div>
                    )
                  ) : (
                    <div className="text-[13px] text-textItemBlur">
                      {item.reviewedByUser?.name
                        ? `Reviewed by ${
                            item.reviewedByUser.name
                          } on ${formatDate(item.reviewedAt)}`
                        : `Reviewed ${formatDate(item.reviewedAt)}`}
                      {item.selfApproved && ' · self-approved'}
                      {item.reviewNotes && (
                        <p className="italic mt-1">“{item.reviewNotes}”</p>
                      )}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {active && (
        <ReviewDialog
          item={active.item}
          decision={active.decision}
          selfReview={!!userId && active.item.submittedByUserId === userId}
          onClose={() => setActive(null)}
          onDone={() => {
            setActive(null);
            mutate();
          }}
        />
      )}
    </PageShell>
  );
};
