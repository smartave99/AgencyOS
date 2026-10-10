'use client';

import React, { useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import clsx from 'clsx';
import Link from 'next/link';

interface AgencyInvoice {
  id: string;
  invoiceNumber: string;
  amount: string;
  currency: string;
  status: string;
  dueDate: string | null;
  paidAt: string | null;
  items: string | null;
  notes: string | null;
  createdAt: string;
  customer: {
    id: string;
    name: string;
    companyName: string | null;
    email: string;
  };
}

interface Client {
  id: string;
  name: string;
  companyName: string | null;
}

export const AgencyBillingComponent = () => {
  const fetch = useFetch();
  const toaster = useToaster();
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  // New Invoice Modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [items, setItems] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch Invoices
  const { data: invoices, mutate, isLoading } = useSWR<AgencyInvoice[]>(
    ['agency-invoices', statusFilter],
    async () => {
      const url = statusFilter === 'ALL' ? '/agency/invoices' : `/agency/invoices?status=${statusFilter}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      return res.json();
    }
  );

  // Fetch Clients for dropdown
  const { data: clients } = useSWR<Client[]>('agency-clients-billing', async () => {
    const res = await fetch('/agency/clients');
    if (!res.ok) return [];
    return res.json();
  });

  const handleCreateInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerId || !amount) {
      toaster.show('Client and Amount are required', 'warning');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/agency/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId,
          amount: parseFloat(amount),
          dueDate: dueDate || undefined,
          items: items || undefined,
          notes: notes || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Failed to create invoice');
      }

      toaster.show('Invoice generated successfully!', 'success');
      setShowCreateModal(false);
      setCustomerId('');
      setAmount('');
      setDueDate('');
      setItems('');
      setNotes('');
      mutate();
    } catch (err: any) {
      toaster.show(err.message || 'Error creating invoice', 'warning');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleMarkPaid = async (id: string, invoiceNumber: string) => {
    try {
      const res = await fetch(`/agency/invoices/${id}/pay`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to mark invoice as paid');
      toaster.show(`Invoice ${invoiceNumber} marked as PAID`, 'success');
      mutate();
    } catch (err: any) {
      toaster.show(err.message || 'Action failed', 'warning');
    }
  };

  // Metrics Calculation
  const totalInvoiced = invoices?.reduce((sum, inv) => sum + parseFloat(inv.amount || '0'), 0) || 0;
  const paidRevenue = invoices
    ?.filter((inv) => inv.status === 'PAID')
    .reduce((sum, inv) => sum + parseFloat(inv.amount || '0'), 0) || 0;
  const pendingRevenue = invoices
    ?.filter((inv) => inv.status === 'DRAFT' || inv.status === 'SENT')
    .reduce((sum, inv) => sum + parseFloat(inv.amount || '0'), 0) || 0;

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'PAID':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      case 'SENT':
        return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
      case 'OVERDUE':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
      default:
        return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-newBgLineColor pb-5">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/agency/dashboard" className="text-xs text-blue-400 hover:underline">
              ← Dashboard
            </Link>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-newTextColor mt-1">
            Agency Billing & Client Invoices
          </h1>
          <p className="text-xs text-textItemBlur mt-1">
            Track client retainer payments, campaign package fees, and billing revenue.
          </p>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-all"
        >
          <span>+ Create Invoice</span>
        </button>
      </div>

      {/* Financial KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 rounded-xl bg-seventh border border-newBgLineColor">
          <span className="text-[11px] font-semibold text-textItemBlur uppercase">Total Invoiced</span>
          <div className="text-2xl font-bold text-newTextColor mt-1">
            ${totalInvoiced.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </div>
          <span className="text-[10px] text-textItemBlur mt-1 block">Across all client accounts</span>
        </div>

        <div className="p-4 rounded-xl bg-seventh border border-emerald-500/20">
          <span className="text-[11px] font-semibold text-emerald-400 uppercase">Collected Revenue (Paid)</span>
          <div className="text-2xl font-bold text-emerald-400 mt-1">
            ${paidRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </div>
          <span className="text-[10px] text-emerald-400/70 mt-1 block">Verified received funds</span>
        </div>

        <div className="p-4 rounded-xl bg-seventh border border-amber-500/20">
          <span className="text-[11px] font-semibold text-amber-400 uppercase">Outstanding Balance</span>
          <div className="text-2xl font-bold text-amber-400 mt-1">
            ${pendingRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </div>
          <span className="text-[10px] text-amber-400/70 mt-1 block">Awaiting client payment</span>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-2 border-b border-newBgLineColor pb-2">
        {['ALL', 'PAID', 'SENT', 'DRAFT', 'OVERDUE'].map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
              statusFilter === status
                ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                : 'text-textItemBlur hover:text-newTextColor'
            )}
          >
            {status}
          </button>
        ))}
      </div>

      {/* Invoices Table */}
      <div className="rounded-xl border border-newBgLineColor bg-seventh overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-newBgColor/40 border-b border-newBgLineColor text-textItemBlur uppercase text-[10px] font-semibold">
              <tr>
                <th className="py-3 px-4">Invoice #</th>
                <th className="py-3 px-4">Client</th>
                <th className="py-3 px-4">Amount</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Due Date</th>
                <th className="py-3 px-4">Items Summary</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-newBgLineColor">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-textItemBlur">
                    Loading invoices...
                  </td>
                </tr>
              ) : !invoices || invoices.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-textItemBlur">
                    No invoices recorded for this filter.
                  </td>
                </tr>
              ) : (
                invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-newBgColor/20 transition-colors">
                    <td className="py-3.5 px-4 font-mono font-medium text-newTextColor">
                      {inv.invoiceNumber}
                    </td>
                    <td className="py-3.5 px-4 font-semibold text-newTextColor">
                      {inv.customer.companyName || inv.customer.name}
                    </td>
                    <td className="py-3.5 px-4 font-bold text-newTextColor">
                      ${parseFloat(inv.amount).toFixed(2)} {inv.currency}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className={clsx('px-2 py-0.5 rounded text-[10px] font-semibold border', getStatusBadge(inv.status))}>
                        {inv.status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-textItemBlur">
                      {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : 'Immediate'}
                    </td>
                    <td className="py-3.5 px-4 text-textItemBlur truncate max-w-xs">
                      {inv.items || 'Advertising campaign retainer'}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      {inv.status !== 'PAID' && (
                        <button
                          onClick={() => handleMarkPaid(inv.id, inv.invoiceNumber)}
                          className="px-2.5 py-1 bg-emerald-600/20 hover:bg-emerald-600 text-emerald-400 hover:text-white rounded text-[10px] font-semibold transition-all"
                        >
                          Mark Paid ✓
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal: Create Invoice */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-seventh border border-newBgLineColor rounded-2xl w-full max-w-md p-6 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-newBgLineColor pb-3">
              <h3 className="text-base font-bold text-newTextColor">Create Client Invoice</h3>
              <button onClick={() => setShowCreateModal(false)} className="text-textItemBlur hover:text-newTextColor">
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateInvoice} className="flex flex-col gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                  Client Account *
                </label>
                <select
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  required
                  className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor focus:outline-none focus:border-blue-500"
                >
                  <option value="">Select a client...</option>
                  {clients?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.companyName ? `${c.companyName} (${c.name})` : c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                  Amount (USD) *
                </label>
                <input
                  type="number"
                  step="0.01"
                  placeholder="e.g. 1500.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                  className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                  Due Date
                </label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                  Package / Line Items Summary
                </label>
                <input
                  type="text"
                  placeholder="e.g. 10x Telegram Broadcasts + Content Copywriting"
                  value={items}
                  onChange={(e) => setItems(e.target.value)}
                  className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                  Internal Notes
                </label>
                <textarea
                  rows={2}
                  placeholder="Billing terms, bank transfer reference, etc."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-newBgLineColor mt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 border border-newBgLineColor text-xs text-textItemBlur rounded-lg hover:text-newTextColor"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold rounded-lg shadow-sm"
                >
                  {isSubmitting ? 'Creating...' : 'Create Invoice'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
