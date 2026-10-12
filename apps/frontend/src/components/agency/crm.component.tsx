'use client';

import React, { FC, useEffect, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  Deal,
  useAgencyApi,
  useCan,
  useDealSummary,
  useDeals,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  EmptyState,
  humanize,
  inputClass,
  labelClass,
  LoadError,
  Loading,
  money,
  PageHeader,
  PageShell,
} from '@gitroom/frontend/components/agency/agency.ui';

type Stage = Deal['stage'];

const STAGES: Array<{ key: Stage; label: string; accent: string }> = [
  { key: 'PROSPECT', label: 'Prospects', accent: 'border-slate-500' },
  { key: 'CONTACTED', label: 'Contacted', accent: 'border-blue-500' },
  { key: 'PROPOSAL_SENT', label: 'Proposal sent', accent: 'border-amber-500' },
  { key: 'WON', label: 'Won', accent: 'border-emerald-500' },
  { key: 'LOST', label: 'Lost', accent: 'border-rose-500' },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// New deal
// ---------------------------------------------------------------------------
const DealDialog: FC<{ onClose: () => void; onSaved: () => void }> = ({
  onClose,
  onSaved,
}) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const [form, setForm] = useState({
    contactName: '',
    companyName: '',
    contactEmail: '',
    value: '',
    currency: 'USD',
    notes: '',
  });
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const set =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  const blur = (key: string) => () =>
    setTouched((t) => ({ ...t, [key]: true }));

  const errors: Record<string, string | null> = {
    contactName: form.contactName.trim() ? null : 'Who is the contact?',
    contactEmail:
      form.contactEmail && !EMAIL.test(form.contactEmail)
        ? 'That doesn’t look like an email address.'
        : null,
    value:
      form.value && !(Number(form.value) >= 0)
        ? 'Enter a number, or leave empty.'
        : null,
    currency: /^[A-Za-z]{3}$/.test(form.currency)
      ? null
      : 'Use a 3-letter code.',
  };
  const invalid = Object.values(errors).some(Boolean);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({
      contactName: true,
      contactEmail: true,
      value: true,
      currency: true,
    });
    if (invalid) return;
    setBusy(true);
    try {
      await api.post('/agency/crm/deals', {
        contactName: form.contactName.trim(),
        companyName: form.companyName.trim() || undefined,
        contactEmail: form.contactEmail.trim() || undefined,
        value: form.value ? Number(form.value) : undefined,
        currency: form.currency.toUpperCase(),
        notes: form.notes.trim() || undefined,
      });
      toaster.show('Deal added to Prospects', 'success');
      onSaved();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    } finally {
      setBusy(false);
    }
  };

  const field = (
    key: keyof typeof form,
    label: string,
    props: React.InputHTMLAttributes<HTMLInputElement> = {}
  ) => (
    <div>
      <label htmlFor={`deal-${key}`} className={labelClass}>
        {label}
      </label>
      <input
        id={`deal-${key}`}
        value={form[key]}
        onChange={set(key)}
        onBlur={blur(key)}
        aria-invalid={touched[key] && !!errors[key]}
        className={inputClass}
        {...props}
      />
      {touched[key] && errors[key] && (
        <p className="text-[11px] text-rose-400 mt-1">{errors[key]}</p>
      )}
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="deal-title"
    >
      <form
        onSubmit={submit}
        className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-6 max-w-md w-full shadow-2xl flex flex-col gap-4"
      >
        <h3 id="deal-title" className="text-base font-bold text-newTextColor">
          New deal
        </h3>
        {field('contactName', 'Contact name', { autoFocus: true })}
        {field('companyName', 'Company (optional)')}
        {field('contactEmail', 'Email (optional)', { type: 'email' })}
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            {field('value', 'Expected value (optional)', {
              type: 'number',
              min: 0,
              step: '0.01',
            })}
          </div>
          {field('currency', 'Currency', { maxLength: 3 })}
        </div>
        <div>
          <label htmlFor="deal-notes" className={labelClass}>
            Notes (optional)
          </label>
          <textarea
            id="deal-notes"
            rows={2}
            value={form.notes}
            onChange={set('notes')}
            className={clsx(inputClass, 'resize-none')}
          />
        </div>
        <div className="flex justify-end gap-2 pt-3 border-t border-newBgLineColor">
          <Btn type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn type="submit" variant="primary" busy={busy}>
            Add deal
          </Btn>
        </div>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Lost reason
// ---------------------------------------------------------------------------
const LostDialog: FC<{
  deal: Deal;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}> = ({ deal, onClose, onConfirm }) => {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = reason.trim() ? null : 'Say why this deal was lost.';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (error) return;
    setBusy(true);
    try {
      await onConfirm(reason.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lost-title"
    >
      <form
        onSubmit={submit}
        className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-6 max-w-md w-full shadow-2xl flex flex-col gap-4"
      >
        <div>
          <h3 id="lost-title" className="text-base font-bold text-newTextColor">
            Mark as lost
          </h3>
          <p className="text-xs text-textItemBlur mt-1">
            {deal.companyName || deal.contactName}
          </p>
        </div>
        <div>
          <label htmlFor="lost-reason" className={labelClass}>
            Reason
          </label>
          <input
            id="lost-reason"
            autoFocus
            maxLength={300}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && !!error}
            className={inputClass}
          />
          {touched && error && (
            <p className="text-[11px] text-rose-400 mt-1">{error}</p>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-3 border-t border-newBgLineColor">
          <Btn type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn type="submit" variant="danger" busy={busy}>
            Mark as lost
          </Btn>
        </div>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------
export const AgencyCrmComponent = () => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { can } = useCan();
  const deals = useDeals();
  const summary = useDealSummary();
  const [adding, setAdding] = useState(false);
  const [losing, setLosing] = useState<Deal | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<Stage | null>(null);

  const canWrite = can('crm:write');
  const reload = () => Promise.all([deals.mutate(), summary.mutate()]);

  const move = async (deal: Deal, stage: Stage, lostReason?: string) => {
    if (deal.stage === stage) return;
    if (stage === 'LOST' && lostReason === undefined) {
      setLosing(deal);
      return;
    }
    try {
      await api.post(`/agency/crm/deals/${deal.id}/stage`, {
        stage,
        lostReason,
      });
      toaster.show(`Moved to ${humanize(stage)}`, 'success');
      setLosing(null);
      await reload();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
      await reload();
    }
  };

  const convert = async (deal: Deal) => {
    if (
      !(await deleteDialog(
        `Create a client from ${
          deal.companyName || deal.contactName
        }? Their contact details carry over.`,
        'Create client',
        undefined,
        undefined,
        true
      ))
    )
      return;
    try {
      await api.post(`/agency/crm/deals/${deal.id}/convert`);
      toaster.show('Client created', 'success');
      await reload();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  const remove = async (deal: Deal) => {
    if (
      !(await deleteDialog(
        `Delete the deal with ${
          deal.companyName || deal.contactName
        }? This can’t be undone.`
      ))
    )
      return;
    try {
      await api.del(`/agency/crm/deals/${deal.id}`);
      toaster.show('Deal deleted', 'success');
      await reload();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  const error = deals.error || summary.error;
  const list = deals.data ?? [];
  const totals = (stage: Stage) =>
    summary.data?.stages.find((s) => s.stage === stage);

  return (
    <PageShell>
      <PageHeader
        crumb="Sales pipeline"
        title="Sales pipeline"
        subtitle="Deals you are working before they become clients. Counts and values are totals of the deals stored here, not forecasts."
        actions={
          canWrite ? (
            <Btn variant="primary" onClick={() => setAdding(true)}>
              New deal
            </Btn>
          ) : undefined
        }
      />

      {error ? (
        <LoadError error={error} onRetry={reload} />
      ) : !deals.data ? (
        <Loading label="Loading pipeline…" />
      ) : list.length === 0 ? (
        <div className="bg-newBgColorInner border border-newBgLineColor rounded-2xl">
          <EmptyState
            title="No deals yet"
            hint="Add a prospect to start tracking them from first contact to signed client."
            action={
              canWrite ? (
                <Btn variant="primary" onClick={() => setAdding(true)}>
                  New deal
                </Btn>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-4 items-start">
          {STAGES.map((stage) => {
            const column = list.filter((d) => d.stage === stage.key);
            const t = totals(stage.key);
            return (
              <section
                key={stage.key}
                aria-label={stage.label}
                onDragOver={(e) => {
                  if (!canWrite || !dragId) return;
                  e.preventDefault();
                  setOverStage(stage.key);
                }}
                onDragLeave={() => setOverStage(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setOverStage(null);
                  const deal = list.find((d) => d.id === dragId);
                  setDragId(null);
                  if (deal) void move(deal, stage.key);
                }}
                className={clsx(
                  'bg-newBgColorInner border border-newBgLineColor rounded-xl p-3 flex flex-col gap-3 min-h-40 border-t-2',
                  stage.accent,
                  overStage === stage.key && 'ring-1 ring-blue-500'
                )}
              >
                <header className="flex items-baseline justify-between px-1">
                  <h2 className="text-xs font-bold text-newTextColor">
                    {stage.label}
                  </h2>
                  <span className="text-[11px] text-textItemBlur">
                    {column.length}
                  </span>
                </header>
                {t && Object.keys(t.totals).length > 0 && (
                  <p className="text-[11px] text-textItemBlur px-1">
                    {Object.entries(t.totals)
                      .map(([cur, amount]) => money(amount, cur))
                      .join(' · ')}
                  </p>
                )}

                {column.map((deal) => (
                  <article
                    key={deal.id}
                    draggable={canWrite}
                    onDragStart={() => setDragId(deal.id)}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverStage(null);
                    }}
                    className={clsx(
                      'bg-newBgColor border border-newBgLineColor rounded-lg p-3 flex flex-col gap-2',
                      canWrite && 'cursor-grab active:cursor-grabbing',
                      dragId === deal.id && 'opacity-50'
                    )}
                  >
                    <div>
                      <p className="text-xs font-semibold text-newTextColor break-words">
                        {deal.companyName || deal.contactName}
                      </p>
                      {deal.companyName && (
                        <p className="text-[11px] text-textItemBlur">
                          {deal.contactName}
                        </p>
                      )}
                    </div>
                    {deal.value && (
                      <p className="text-xs text-newTextColor">
                        {money(deal.value, deal.currency)}
                      </p>
                    )}
                    {deal.stage === 'LOST' && deal.lostReason && (
                      <p className="text-[11px] text-textItemBlur italic">
                        “{deal.lostReason}”
                      </p>
                    )}
                    {deal.owner && (
                      <p className="text-[11px] text-textItemBlur">
                        Owner: {deal.owner.name || deal.owner.email}
                      </p>
                    )}

                    {canWrite && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <label className="sr-only" htmlFor={`stage-${deal.id}`}>
                          Move {deal.contactName} to stage
                        </label>
                        <select
                          id={`stage-${deal.id}`}
                          value={deal.stage}
                          onChange={(e) =>
                            void move(deal, e.target.value as Stage)
                          }
                          className="bg-newBgColorInner border border-newBgLineColor rounded-md px-1.5 py-1 text-[11px] text-newTextColor"
                        >
                          {STAGES.map((s) => (
                            <option key={s.key} value={s.key}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                        {deal.stage === 'WON' &&
                          !deal.customerId &&
                          can('client:write') && (
                            <button
                              onClick={() => void convert(deal)}
                              className="text-[11px] font-semibold text-blue-400 hover:underline"
                            >
                              Create client
                            </button>
                          )}
                        {deal.customerId && (
                          <Link
                            href="/agency/clients"
                            className="text-[11px] text-emerald-400 hover:underline"
                          >
                            Client created
                          </Link>
                        )}
                        {can('crm:delete') && (
                          <button
                            onClick={() => void remove(deal)}
                            className="ml-auto text-[11px] text-rose-400 hover:underline"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      )}

      {adding && (
        <DealDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void reload();
          }}
        />
      )}
      {losing && (
        <LostDialog
          deal={losing}
          onClose={() => setLosing(null)}
          onConfirm={(reason) => move(losing, 'LOST', reason)}
        />
      )}
    </PageShell>
  );
};
