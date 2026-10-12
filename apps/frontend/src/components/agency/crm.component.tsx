'use client';

import React, { FC, useState } from 'react';
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
  Dialog,
  EmptyState,
  Icon,
  humanize,
  LoadError,
  Loading,
  Menu,
  MenuItem,
  money,
  PageHeader,
  PageShell,
  TextArea,
  TextField,
  useBusy,
  useTouched,
} from '@gitroom/frontend/components/agency/agency.ui';

type Stage = Deal['stage'];

const STAGES: Array<{ key: Stage; label: string; accent: string }> = [
  { key: 'PROSPECT', label: 'Prospects', accent: 'bg-[var(--ag-neutral-fg)]' },
  { key: 'CONTACTED', label: 'Contacted', accent: 'bg-[var(--ag-info-fg)]' },
  {
    key: 'PROPOSAL_SENT',
    label: 'Proposal sent',
    accent: 'bg-[var(--ag-warn-fg)]',
  },
  { key: 'WON', label: 'Won', accent: 'bg-[var(--ag-good-fg)]' },
  { key: 'LOST', label: 'Lost', accent: 'bg-[var(--ag-bad-fg)]' },
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
  const touched = useTouched();
  const { busy, run } = useBusy();
  const [form, setForm] = useState({
    contactName: '',
    companyName: '',
    contactEmail: '',
    value: '',
    currency: 'USD',
    notes: '',
  });
  const set =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    touched.all(Object.keys(errors));
    if (Object.values(errors).some(Boolean)) return;
    await run(async () => {
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
      }
    });
  };

  return (
    <Dialog
      title="New deal"
      onClose={onClose}
      busy={busy}
      onSubmit={submit}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn type="submit" variant="primary" busy={busy}>
            Add deal
          </Btn>
        </>
      }
    >
      <TextField
        autoFocus
        label="Contact name"
        value={form.contactName}
        onChange={set('contactName')}
        onBlur={touched.blur('contactName')}
        error={touched.show('contactName', errors.contactName)}
      />
      <TextField
        label="Company"
        optional
        value={form.companyName}
        onChange={set('companyName')}
      />
      <TextField
        label="Email"
        optional
        type="email"
        value={form.contactEmail}
        onChange={set('contactEmail')}
        onBlur={touched.blur('contactEmail')}
        error={touched.show('contactEmail', errors.contactEmail)}
      />
      <div className="grid grid-cols-3 gap-3">
        <TextField
          wrapperClassName="col-span-2"
          label="Expected value"
          optional
          type="number"
          min={0}
          step="0.01"
          value={form.value}
          onChange={set('value')}
          onBlur={touched.blur('value')}
          error={touched.show('value', errors.value)}
        />
        <TextField
          label="Currency"
          maxLength={3}
          value={form.currency}
          onChange={set('currency')}
          onBlur={touched.blur('currency')}
          error={touched.show('currency', errors.currency)}
        />
      </div>
      <TextArea
        label="Notes"
        optional
        rows={2}
        value={form.notes}
        onChange={set('notes')}
      />
    </Dialog>
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
  const touched = useTouched();
  const { busy, run } = useBusy();
  const [reason, setReason] = useState('');
  const error = reason.trim() ? undefined : 'Say why this deal was lost.';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    touched.all(['reason']);
    if (error) return;
    await run(() => onConfirm(reason.trim()));
  };

  return (
    <Dialog
      size="sm"
      title="Mark as lost"
      description={deal.companyName || deal.contactName}
      onClose={onClose}
      busy={busy}
      onSubmit={submit}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn type="submit" variant="danger" busy={busy}>
            Mark as lost
          </Btn>
        </>
      }
    >
      <TextField
        autoFocus
        label="Reason"
        maxLength={300}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onBlur={touched.blur('reason')}
        error={touched.show('reason', error)}
      />
    </Dialog>
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

  const dealMenu = (deal: Deal): MenuItem[] => {
    const items: MenuItem[] = [];
    if (deal.stage === 'WON' && !deal.customerId && can('client:write')) {
      items.push({ label: 'Create client', onClick: () => void convert(deal) });
    }
    for (const s of STAGES) {
      if (s.key !== deal.stage) {
        items.push({
          label: `Move to ${s.label}`,
          onClick: () => void move(deal, s.key),
        });
      }
    }
    if (can('crm:delete')) {
      items.push({
        label: 'Delete deal',
        danger: true,
        onClick: () => void remove(deal),
      });
    }
    return items;
  };

  return (
    <PageShell>
      <PageHeader
        title="Sales pipeline"
        subtitle="Deals you are working before they become clients. Counts and values are totals of the deals stored here, not forecasts."
        actions={
          canWrite ? (
            <Btn variant="primary" onClick={() => setAdding(true)}>
              <Icon name="plus" size={15} />
              New deal
            </Btn>
          ) : undefined
        }
      />

      {error ? (
        <LoadError error={error} onRetry={reload} />
      ) : !deals.data ? (
        <Loading label="Loading pipeline" />
      ) : list.length === 0 ? (
        <div className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)]">
          <EmptyState
            icon="chart"
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
        <div className="ag-rise grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-4 items-start">
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
                  'rounded-2xl bg-[var(--ag-neutral-bg)] p-3 flex flex-col gap-3 min-h-40 border border-transparent',
                  overStage === stage.key &&
                    'border-[color:var(--ag-accent)] bg-[var(--ag-accent-soft)]'
                )}
              >
                <header className="flex items-center gap-2 px-1">
                  <span
                    className={clsx('h-2 w-2 rounded-full', stage.accent)}
                  />
                  <h2 className="text-[13px] font-semibold text-newTextColor">
                    {stage.label}
                  </h2>
                  <span className="ml-auto text-xs tabular-nums text-textItemBlur">
                    {column.length}
                  </span>
                </header>
                {t && Object.keys(t.totals).length > 0 && (
                  <p className="text-xs text-textItemBlur px-1 -mt-1">
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
                      'rounded-xl bg-newBgColorInner border border-[color:var(--ag-hairline)] shadow-[var(--ag-shadow)] p-3.5 flex flex-col gap-2',
                      canWrite && 'cursor-grab active:cursor-grabbing',
                      dragId === deal.id && 'opacity-50'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-newTextColor break-words">
                          {deal.companyName || deal.contactName}
                        </p>
                        {deal.companyName && (
                          <p className="text-xs text-textItemBlur">
                            {deal.contactName}
                          </p>
                        )}
                      </div>
                      {canWrite && (
                        <Menu label="Deal actions" items={dealMenu(deal)} />
                      )}
                    </div>
                    {deal.value && (
                      <p className="text-[13px] font-medium text-newTextColor tabular-nums">
                        {money(deal.value, deal.currency)}
                      </p>
                    )}
                    {deal.stage === 'LOST' && deal.lostReason && (
                      <p className="text-xs text-textItemBlur italic">
                        “{deal.lostReason}”
                      </p>
                    )}
                    <div className="flex items-center justify-between gap-2 text-xs text-textItemBlur">
                      <span className="truncate">
                        {deal.owner
                          ? deal.owner.name || deal.owner.email
                          : 'Unassigned'}
                      </span>
                      {deal.customerId && (
                        <Link
                          href="/agency/clients"
                          className="shrink-0 font-medium text-[color:var(--ag-good-fg)] hover:underline"
                        >
                          Client created
                        </Link>
                      )}
                    </div>
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
