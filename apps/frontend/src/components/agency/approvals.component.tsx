'use client';

import React, { FC, useEffect, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { useToaster } from '@gitroom/react/toaster/toaster';
import {
  useAgencyApi,
  useApprovals,
  useCan,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  EmptyState,
  formatDate,
  inputClass,
  labelClass,
  LoadError,
  Loading,
  money,
  PageHeader,
  PageShell,
  StatusBadge,
} from '@gitroom/frontend/components/agency/agency.ui';

const FILTERS = ['PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'ALL'] as const;
const FILTER_LABEL: Record<(typeof FILTERS)[number], string> = {
  PENDING: 'Waiting for review',
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Sent back',
  ALL: 'All',
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
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const needsNotes = decision === 'REJECT';
  const notesError =
    needsNotes && !notes.trim()
      ? 'Say what needs to change so the author can fix it.'
      : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (notesError) return;
    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-title"
    >
      <form
        onSubmit={submit}
        className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-6 max-w-md w-full shadow-2xl flex flex-col gap-4"
      >
        <div>
          <h3
            id="review-title"
            className="text-base font-bold text-newTextColor"
          >
            {decision === 'APPROVE'
              ? 'Approve this campaign'
              : 'Send back for changes'}
          </h3>
          <p className="text-xs text-textItemBlur mt-1">
            {decision === 'APPROVE'
              ? `You are approving “${item.campaign.name}” exactly as it reads now. If anyone edits the ad afterwards, the approval no longer applies and it must be reviewed again.`
              : `“${item.campaign.name}” returns to draft so ${
                  item.submittedByUser?.name || 'the author'
                } can revise it.`}
          </p>
        </div>

        {decision === 'APPROVE' && selfReview && (
          <p className="text-xs rounded-lg border border-amber-500/20 bg-amber-500/10 text-amber-400 p-3">
            You submitted this campaign yourself. Your approval will be recorded
            as a self-approval in the audit trail.
          </p>
        )}

        <div>
          <label htmlFor="review-notes" className={labelClass}>
            {needsNotes ? 'What needs to change' : 'Note (optional)'}
          </label>
          <textarea
            id="review-notes"
            rows={3}
            autoFocus
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && !!notesError}
            className={clsx(inputClass, 'resize-none')}
          />
          {touched && notesError && (
            <p className="text-[11px] text-rose-400 mt-1">{notesError}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-newBgLineColor">
          <Btn type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn
            type="submit"
            variant={decision === 'APPROVE' ? 'primary' : 'danger'}
            busy={busy}
          >
            {decision === 'APPROVE' ? 'Approve' : 'Send back'}
          </Btn>
        </div>
      </form>
    </div>
  );
};

export const AgencyApprovalsComponent = () => {
  const { can, userId, isLoading: roleLoading } = useCan();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('PENDING');
  const { data, error, isLoading, mutate } = useApprovals(filter);
  const [active, setActive] = useState<{
    item: any;
    decision: Decision;
  } | null>(null);

  const canReview = can('campaign:approve');

  return (
    <PageShell>
      <PageHeader
        crumb="Approvals"
        title="Approvals"
        subtitle="Nothing is published until a reviewer approves the exact content. Review the ad, its destinations and the sign-off requirements here."
        actions={
          <div className="flex items-center gap-1 bg-newBgColorInner border border-newBgLineColor p-1 rounded-xl">
            {FILTERS.map((status) => (
              <button
                key={status}
                onClick={() => setFilter(status)}
                aria-pressed={filter === status}
                className={clsx(
                  'px-3 py-1.5 text-xs font-semibold rounded-lg transition-all',
                  filter === status
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-textItemBlur hover:text-newTextColor'
                )}
              >
                {FILTER_LABEL[status]}
              </button>
            ))}
          </div>
        }
      />

      {!roleLoading && !canReview && (
        <p className="text-xs rounded-lg border border-newBgLineColor bg-newBgColorInner text-textItemBlur p-3">
          Your role can see the queue but can’t approve or reject. Ask a manager
          or admin to review.
        </p>
      )}

      {error ? (
        <LoadError error={error} onRetry={() => mutate()} />
      ) : isLoading || !data ? (
        <Loading label="Loading approvals…" />
      ) : data.length === 0 ? (
        <div className="bg-newBgColorInner border border-newBgLineColor rounded-2xl">
          <EmptyState
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
        <div className="flex flex-col gap-4">
          {data.map((item) => {
            const c = item.campaign;
            const destinations: any[] = c.destinations ?? [];
            const selfReview = !!userId && item.submittedByUserId === userId;
            return (
              <article
                key={item.id}
                className="bg-newBgColorInner border border-newBgLineColor rounded-xl p-5 flex flex-col lg:flex-row gap-6 justify-between"
              >
                <div className="flex-1 flex flex-col gap-3 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={item.status} />
                    {c.requiresClientApproval && (
                      <span className="text-[11px] text-textItemBlur">
                        {c.clientApprovedAt
                          ? `Client signed off ${formatDate(
                              c.clientApprovedAt
                            )}`
                          : 'Client sign-off required before scheduling'}
                      </span>
                    )}
                    <span className="text-xs text-textItemBlur">
                      Submitted by {item.submittedByUser?.name || 'unknown'} on{' '}
                      {formatDate(item.createdAt)}
                      {selfReview && ' (you)'}
                    </span>
                  </div>

                  <div>
                    <Link
                      href={`/agency/campaigns/${c.id}`}
                      className="text-base font-bold text-newTextColor hover:underline"
                    >
                      {c.name}
                    </Link>
                    <div className="text-xs text-textItemBlur mt-0.5">
                      Client:{' '}
                      <span className="text-newTextColor font-medium">
                        {c.customer?.companyName || c.customer?.name}
                      </span>
                      {c.budget && ` • Budget ${money(c.budget)}`}
                    </div>
                  </div>

                  <div className="p-3.5 rounded-lg bg-newBgColor border border-newBgLineColor text-xs text-newTextColor whitespace-pre-wrap max-h-36 overflow-y-auto break-words">
                    {c.contentTitle && (
                      <div className="font-semibold mb-1">{c.contentTitle}</div>
                    )}
                    {c.contentBody}
                  </div>

                  {item.submissionNotes && (
                    <p className="text-xs text-textItemBlur italic">
                      Author’s note: “{item.submissionNotes}”
                    </p>
                  )}
                </div>

                <div className="lg:w-72 flex flex-col justify-between border-t lg:border-t-0 lg:border-l border-newBgLineColor pt-4 lg:pt-0 lg:pl-6 gap-4">
                  <div>
                    <span className="text-[11px] font-semibold text-textItemBlur uppercase">
                      Destinations ({destinations.length})
                    </span>
                    <ul className="flex flex-col gap-1.5 mt-2">
                      {destinations.slice(0, 4).map((d) => (
                        <li
                          key={d.id}
                          className="text-xs text-newTextColor truncate flex items-center gap-1.5"
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                          {d.telegramDestination?.title ||
                            d.integration?.name ||
                            'Destination'}
                        </li>
                      ))}
                      {destinations.length > 4 && (
                        <li className="text-[11px] text-textItemBlur">
                          + {destinations.length - 4} more
                        </li>
                      )}
                    </ul>
                  </div>

                  {item.status === 'PENDING' ? (
                    canReview ? (
                      <div className="flex flex-col gap-2">
                        <Btn
                          variant="primary"
                          onClick={() =>
                            setActive({ item, decision: 'APPROVE' })
                          }
                        >
                          Approve
                        </Btn>
                        <Btn
                          variant="danger"
                          onClick={() =>
                            setActive({ item, decision: 'REJECT' })
                          }
                        >
                          Send back for changes
                        </Btn>
                      </div>
                    ) : null
                  ) : (
                    <div className="text-xs text-textItemBlur">
                      {item.reviewedByUser?.name
                        ? `Reviewed by ${
                            item.reviewedByUser.name
                          } on ${formatDate(item.reviewedAt)}`
                        : `Reviewed ${formatDate(item.reviewedAt)}`}
                      {item.selfApproved && ' · self-approved'}
                      {item.reviewNotes && (
                        <div className="italic mt-1">“{item.reviewNotes}”</div>
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
