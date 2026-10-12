'use client';

import React, { FC, useMemo, useState } from 'react';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  useAgencyApi,
  useCan,
  useClients,
  useInvoices,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Dialog,
  EmptyState,
  formatDate,
  Icon,
  LoadError,
  Loading,
  money,
  PageHeader,
  PageShell,
  Segmented,
  SelectField,
  StatusBadge,
  TextArea,
  TextField,
  TONE_TEXT,
  Tone,
  tableClass,
  useBusy,
  useTouched,
} from '@gitroom/frontend/components/agency/agency.ui';

// Invoices are created as DRAFT and end as PAID; AgencyOS does not send them or track overdue.
const FILTERS = [
  { value: 'ALL', label: 'All' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PAID', label: 'Paid' },
];

/** Totals are kept per currency. Amounts in different currencies are never added. */
const sumByCurrency = (rows: Array<{ amount: string; currency: string }>) => {
  const totals: Record<string, number> = {};
  for (const r of rows) {
    totals[r.currency] = (totals[r.currency] ?? 0) + Number(r.amount || 0);
  }
  return totals;
};

const Total: FC<{
  label: string;
  hint: string;
  totals: Record<string, number>;
  tone?: Tone;
}> = ({ label, hint, totals, tone }) => {
  const entries = Object.entries(totals);
  return (
    <div className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)] shadow-[var(--ag-shadow)] p-5">
      <span className="text-xs font-medium text-textItemBlur">{label}</span>
      <div
        className={`mt-1 text-2xl font-semibold tracking-tight tabular-nums ${
          tone ? TONE_TEXT[tone] : 'text-newTextColor'
        }`}
      >
        {entries.length === 0
          ? '—'
          : entries.map(([cur, amount]) => (
              <div key={cur}>{money(amount, cur)}</div>
            ))}
      </div>
      <span className="mt-2 block text-xs text-textItemBlur">{hint}</span>
    </div>
  );
};

const InvoiceDialog: FC<{ onClose: () => void; onSaved: () => void }> = ({
  onClose,
  onSaved,
}) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const clients = useClients();
  const touched = useTouched();
  const { busy, run } = useBusy();
  const [form, setForm] = useState({
    customerId: '',
    amount: '',
    currency: 'USD',
    dueDate: '',
    items: '',
    notes: '',
  });
  const set =
    (key: keyof typeof form) =>
    (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >
    ) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const errors: Record<string, string | null> = {
    customerId: form.customerId ? null : 'Choose a client.',
    amount: Number(form.amount) > 0 ? null : 'Enter an amount above zero.',
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
        const invoice = await api.post<{ invoiceNumber: string }>(
          '/agency/invoices',
          {
            customerId: form.customerId,
            amount: Number(form.amount),
            currency: form.currency.toUpperCase(),
            dueDate: form.dueDate || undefined,
            items: form.items.trim() || undefined,
            notes: form.notes.trim() || undefined,
          }
        );
        toaster.show(`Invoice ${invoice.invoiceNumber} created`, 'success');
        onSaved();
      } catch (error) {
        toaster.show((error as Error).message, 'warning');
      }
    });
  };

  return (
    <Dialog
      title="New invoice"
      onClose={onClose}
      busy={busy}
      onSubmit={submit}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn type="submit" variant="primary" busy={busy}>
            Create invoice
          </Btn>
        </>
      }
    >
      <SelectField
        autoFocus
        label="Client"
        value={form.customerId}
        onChange={set('customerId')}
        onBlur={touched.blur('customerId')}
        error={touched.show('customerId', errors.customerId)}
      >
        <option value="">Select…</option>
        {(clients.data ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.companyName ? `${c.companyName} (${c.name})` : c.name}
          </option>
        ))}
      </SelectField>
      <div className="grid grid-cols-3 gap-3">
        <TextField
          wrapperClassName="col-span-2"
          label="Amount"
          type="number"
          min="0"
          step="0.01"
          value={form.amount}
          onChange={set('amount')}
          onBlur={touched.blur('amount')}
          error={touched.show('amount', errors.amount)}
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
      <TextField
        label="Due date"
        optional
        type="date"
        value={form.dueDate}
        onChange={set('dueDate')}
      />
      <TextField
        label="What it covers"
        optional
        placeholder="e.g. 10 Telegram placements + copywriting"
        value={form.items}
        onChange={set('items')}
      />
      <TextArea
        label="Internal notes"
        optional
        rows={2}
        value={form.notes}
        onChange={set('notes')}
      />
    </Dialog>
  );
};

export const AgencyBillingComponent = () => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { can } = useCan();
  const [filter, setFilter] = useState('ALL');
  const [creating, setCreating] = useState(false);
  const invoices = useInvoices(filter === 'ALL' ? '' : filter);
  const all = useInvoices('');

  const canWrite = can('billing:write');
  const rows = invoices.data ?? [];
  const everything = all.data ?? [];

  const totals = useMemo(
    () => ({
      invoiced: sumByCurrency(everything),
      paid: sumByCurrency(everything.filter((i) => i.status === 'PAID')),
      outstanding: sumByCurrency(everything.filter((i) => i.status !== 'PAID')),
    }),
    [everything]
  );

  const reload = () => Promise.all([invoices.mutate(), all.mutate()]);

  const markPaid = async (invoice: any) => {
    if (
      !(await deleteDialog(
        `Record ${invoice.invoiceNumber} (${money(
          invoice.amount,
          invoice.currency
        )}) as paid? AgencyOS does not check with a bank; this records that you received the payment.`,
        'Record as paid',
        undefined,
        undefined,
        true
      ))
    )
      return;
    try {
      await api.post(`/agency/invoices/${invoice.id}/pay`);
      toaster.show(`${invoice.invoiceNumber} recorded as paid`, 'success');
      await reload();
    } catch (error) {
      toaster.show((error as Error).message, 'warning');
    }
  };

  return (
    <PageShell>
      <PageHeader
        title="Invoices"
        subtitle="Invoice records for your clients and whether you have recorded them as paid. AgencyOS does not email invoices or process payments; payment is recorded by hand."
        actions={
          canWrite ? (
            <Btn variant="primary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={15} />
              New invoice
            </Btn>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Total label="Invoiced" hint="All invoices" totals={totals.invoiced} />
        <Total
          label="Recorded as paid"
          hint="Marked paid by your team"
          totals={totals.paid}
          tone="good"
        />
        <Total
          label="Outstanding"
          hint="Not yet recorded as paid"
          totals={totals.outstanding}
          tone="warn"
        />
      </div>

      <Segmented
        ariaLabel="Invoice status"
        value={filter}
        onChange={setFilter}
        options={FILTERS}
      />

      {invoices.error ? (
        <LoadError error={invoices.error} onRetry={() => invoices.mutate()} />
      ) : !invoices.data ? (
        <Loading label="Loading invoices" />
      ) : rows.length === 0 ? (
        <div className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)]">
          <EmptyState
            icon="card"
            title="No invoices"
            hint={
              filter === 'ALL'
                ? 'Create an invoice for a client to start tracking billing.'
                : 'No invoices have this status.'
            }
            action={
              canWrite && filter === 'ALL' ? (
                <Btn variant="primary" onClick={() => setCreating(true)}>
                  New invoice
                </Btn>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="ag-rise rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)] shadow-[var(--ag-shadow)] p-2 sm:p-3">
          <div className={tableClass.wrap}>
            <table className={tableClass.table}>
              <thead className={tableClass.head}>
                <tr>
                  <th className={tableClass.th}>Invoice</th>
                  <th className={tableClass.th}>Client</th>
                  <th className={`${tableClass.th} text-right`}>Amount</th>
                  <th className={tableClass.th}>Status</th>
                  <th className={tableClass.th}>Due</th>
                  <th className={tableClass.th}>Covers</th>
                  <th className={tableClass.th}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((inv) => (
                  <tr key={inv.id} className={tableClass.row}>
                    <td
                      className={`${tableClass.td} font-mono text-xs text-newTextColor`}
                    >
                      {inv.invoiceNumber}
                    </td>
                    <td
                      className={`${tableClass.td} font-medium text-newTextColor`}
                    >
                      {inv.customer.companyName || inv.customer.name}
                    </td>
                    <td
                      className={`${tableClass.td} text-right font-semibold tabular-nums text-newTextColor`}
                    >
                      {money(inv.amount, inv.currency)}
                    </td>
                    <td className={tableClass.td}>
                      <StatusBadge status={inv.status} />
                      {inv.paidAt && (
                        <span className="block text-xs text-textItemBlur mt-1">
                          {formatDate(inv.paidAt)}
                        </span>
                      )}
                    </td>
                    <td className={`${tableClass.td} text-textItemBlur`}>
                      {inv.dueDate ? formatDate(inv.dueDate) : '—'}
                    </td>
                    <td
                      className={`${tableClass.td} text-textItemBlur truncate max-w-xs`}
                    >
                      {inv.items || '—'}
                    </td>
                    <td className={`${tableClass.td} text-right`}>
                      {canWrite && inv.status !== 'PAID' && (
                        <Btn onClick={() => void markPaid(inv)}>
                          Record as paid
                        </Btn>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {creating && (
        <InvoiceDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void reload();
          }}
        />
      )}
    </PageShell>
  );
};
