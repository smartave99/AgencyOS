'use client';

import React, { FC, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
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

// Invoices are created as DRAFT and end as PAID; AgencyOS does not send them or track overdue.
const FILTERS = ['ALL', 'DRAFT', 'PAID'] as const;

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
}> = ({ label, hint, totals }) => {
  const entries = Object.entries(totals);
  return (
    <div className="p-4 rounded-xl bg-newBgColorInner border border-newBgLineColor">
      <span className="text-[11px] font-semibold text-textItemBlur uppercase">
        {label}
      </span>
      <div className="text-xl font-bold text-newTextColor mt-1">
        {entries.length === 0
          ? '—'
          : entries.map(([cur, amount]) => (
              <div key={cur}>{money(amount, cur)}</div>
            ))}
      </div>
      <span className="text-[11px] text-textItemBlur mt-1 block">{hint}</span>
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
  const [form, setForm] = useState({
    customerId: '',
    amount: '',
    currency: 'USD',
    dueDate: '',
    items: '',
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

  const errors: Record<string, string | null> = {
    customerId: form.customerId ? null : 'Choose a client.',
    amount: Number(form.amount) > 0 ? null : 'Enter an amount above zero.',
    currency: /^[A-Za-z]{3}$/.test(form.currency)
      ? null
      : 'Use a 3-letter code.',
  };
  const invalid = Object.values(errors).some(Boolean);
  const blur = (key: string) => () =>
    setTouched((t) => ({ ...t, [key]: true }));
  const err = (key: string) =>
    touched[key] && errors[key] ? (
      <p className="text-[11px] text-rose-400 mt-1">{errors[key]}</p>
    ) : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ customerId: true, amount: true, currency: true });
    if (invalid) return;
    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invoice-title"
    >
      <form
        onSubmit={submit}
        className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-6 max-w-md w-full shadow-2xl flex flex-col gap-4"
      >
        <h3
          id="invoice-title"
          className="text-base font-bold text-newTextColor"
        >
          New invoice
        </h3>

        <div>
          <label htmlFor="inv-client" className={labelClass}>
            Client
          </label>
          <select
            id="inv-client"
            autoFocus
            value={form.customerId}
            onChange={(e) => setForm({ ...form, customerId: e.target.value })}
            onBlur={blur('customerId')}
            aria-invalid={touched.customerId && !!errors.customerId}
            className={inputClass}
          >
            <option value="">Select…</option>
            {(clients.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.companyName ? `${c.companyName} (${c.name})` : c.name}
              </option>
            ))}
          </select>
          {err('customerId')}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label htmlFor="inv-amount" className={labelClass}>
              Amount
            </label>
            <input
              id="inv-amount"
              type="number"
              min="0"
              step="0.01"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              onBlur={blur('amount')}
              aria-invalid={touched.amount && !!errors.amount}
              className={inputClass}
            />
            {err('amount')}
          </div>
          <div>
            <label htmlFor="inv-currency" className={labelClass}>
              Currency
            </label>
            <input
              id="inv-currency"
              maxLength={3}
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value })}
              onBlur={blur('currency')}
              aria-invalid={touched.currency && !!errors.currency}
              className={inputClass}
            />
            {err('currency')}
          </div>
        </div>

        <div>
          <label htmlFor="inv-due" className={labelClass}>
            Due date (optional)
          </label>
          <input
            id="inv-due"
            type="date"
            value={form.dueDate}
            onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="inv-items" className={labelClass}>
            What it covers (optional)
          </label>
          <input
            id="inv-items"
            value={form.items}
            onChange={(e) => setForm({ ...form, items: e.target.value })}
            placeholder="e.g. 10 Telegram placements + copywriting"
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="inv-notes" className={labelClass}>
            Internal notes (optional)
          </label>
          <textarea
            id="inv-notes"
            rows={2}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            className={clsx(inputClass, 'resize-none')}
          />
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-newBgLineColor">
          <Btn type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn type="submit" variant="primary" busy={busy}>
            Create invoice
          </Btn>
        </div>
      </form>
    </div>
  );
};

export const AgencyBillingComponent = () => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { can } = useCan();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL');
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
        crumb="Billing"
        title="Invoices"
        subtitle="Invoice records for your clients and whether you have recorded them as paid. AgencyOS does not email invoices or process payments; payment is recorded by hand."
        actions={
          canWrite ? (
            <Btn variant="primary" onClick={() => setCreating(true)}>
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
        />
        <Total
          label="Outstanding"
          hint="Not yet recorded as paid"
          totals={totals.outstanding}
        />
      </div>

      <div
        className="flex items-center gap-2 border-b border-newBgLineColor pb-2"
        role="tablist"
      >
        {FILTERS.map((status) => (
          <button
            key={status}
            role="tab"
            aria-selected={filter === status}
            onClick={() => setFilter(status)}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
              filter === status
                ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                : 'text-textItemBlur hover:text-newTextColor'
            )}
          >
            {status === 'ALL'
              ? 'All'
              : status.charAt(0) + status.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {invoices.error ? (
        <LoadError error={invoices.error} onRetry={() => invoices.mutate()} />
      ) : !invoices.data ? (
        <Loading label="Loading invoices…" />
      ) : rows.length === 0 ? (
        <div className="bg-newBgColorInner border border-newBgLineColor rounded-2xl">
          <EmptyState
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
        <div className="rounded-xl border border-newBgLineColor bg-newBgColorInner overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-newBgLineColor text-textItemBlur uppercase text-[10px] font-semibold">
                <tr>
                  <th className="py-3 px-4">Invoice</th>
                  <th className="py-3 px-4">Client</th>
                  <th className="py-3 px-4">Amount</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Due</th>
                  <th className="py-3 px-4">Covers</th>
                  <th className="py-3 px-4 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-newBgLineColor">
                {rows.map((inv) => (
                  <tr key={inv.id}>
                    <td className="py-3.5 px-4 font-mono font-medium text-newTextColor">
                      {inv.invoiceNumber}
                    </td>
                    <td className="py-3.5 px-4 font-semibold text-newTextColor">
                      {inv.customer.companyName || inv.customer.name}
                    </td>
                    <td className="py-3.5 px-4 font-bold text-newTextColor">
                      {money(inv.amount, inv.currency)}
                    </td>
                    <td className="py-3.5 px-4">
                      <StatusBadge status={inv.status} />
                      {inv.paidAt && (
                        <span className="block text-[11px] text-textItemBlur mt-0.5">
                          {formatDate(inv.paidAt)}
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-textItemBlur">
                      {inv.dueDate ? formatDate(inv.dueDate) : '—'}
                    </td>
                    <td className="py-3.5 px-4 text-textItemBlur truncate max-w-xs">
                      {inv.items || '—'}
                    </td>
                    <td className="py-3.5 px-4 text-right">
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
