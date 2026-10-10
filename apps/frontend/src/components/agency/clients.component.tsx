'use client';

import React, { useCallback, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import clsx from 'clsx';
import Link from 'next/link';

interface Client {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  industry: string | null;
  website: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
  assignedSalesUser?: { id: string; name: string; email: string };
  _count: { campaigns: number; integrations: number };
}

export const AgencyClientsComponent = () => {
  const fetch = useFetch();
  const toaster = useToaster();
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form State
  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [industry, setIndustry] = useState('');
  const [website, setWebsite] = useState('');
  const [notes, setNotes] = useState('');

  const loadClients = useCallback(async () => {
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    const res = await fetch(`/agency/clients${query}`);
    if (!res.ok) throw new Error('Failed to load clients');
    return res.json() as Promise<Client[]>;
  }, [fetch, search]);

  const { data: clients, isLoading, mutate } = useSWR(['agency-clients', search], loadClients);

  const handleCreateClient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toaster.show('Contact name is required', 'warning');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/agency/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          companyName: companyName.trim() || undefined,
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          industry: industry.trim() || undefined,
          website: website.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Failed to create client');
      }

      toaster.show('Client onboarded successfully', 'success');
      setIsModalOpen(false);
      // Reset form
      setName('');
      setCompanyName('');
      setEmail('');
      setPhone('');
      setIndustry('');
      setWebsite('');
      setNotes('');
      mutate();
    } catch (err: any) {
      toaster.show(err.message || 'Error onboarding client', 'warning');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteClient = async (id: string, clientName: string) => {
    if (!confirm(`Are you sure you want to remove client "${clientName}"?`)) return;

    try {
      const res = await fetch(`/agency/clients/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete client');
      toaster.show('Client removed', 'success');
      mutate();
    } catch (err: any) {
      toaster.show(err.message || 'Error deleting client', 'warning');
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
      {/* Header & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-newBgLineColor pb-5">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/agency/dashboard" className="text-xs text-blue-400 hover:underline">
              ← Dashboard
            </Link>
            <span className="text-xs text-textItemBlur">/</span>
            <span className="text-xs text-textItemBlur">Client Directory</span>
          </div>
          <h1 className="text-2xl font-bold text-newTextColor tracking-tight mt-1">
            Client Accounts & Portfolios
          </h1>
          <p className="text-xs text-textItemBlur mt-0.5">
            Manage client profiles, company contacts, campaign history, and assigned sales representatives.
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-all"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M12 5v14" />
          </svg>
          Onboard New Client
        </button>
      </div>

      {/* Search and Filters Bar */}
      <div className="flex items-center justify-between gap-4 bg-newBgColorInner border border-newBgLineColor rounded-xl p-3">
        <div className="relative flex-1 max-w-md">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 text-textItemBlur"
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            placeholder="Search by client name, company, or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-newBgColor border border-newBgLineColor rounded-lg pl-9 pr-3 py-1.5 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="text-xs text-textItemBlur">
          Total: <span className="text-newTextColor font-semibold">{clients?.length ?? 0}</span> client(s)
        </div>
      </div>

      {/* Clients Table */}
      <div className="bg-newBgColorInner border border-newBgLineColor rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="py-16 text-center text-xs text-textItemBlur">Loading client directory...</div>
        ) : !clients || clients.length === 0 ? (
          <div className="py-16 flex flex-col items-center justify-center text-center">
            <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
              </svg>
            </div>
            <p className="text-sm font-medium text-newTextColor">No clients found</p>
            <p className="text-xs text-textItemBlur mt-1">Get started by onboarding your first advertising client.</p>
            <button
              onClick={() => setIsModalOpen(true)}
              className="mt-4 px-4 py-2 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-500 transition-all"
            >
              Onboard Client
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-newBgColor border-b border-newBgLineColor text-textItemBlur font-medium">
                <tr>
                  <th className="py-3 px-4">Company / Business</th>
                  <th className="py-3 px-4">Primary Contact</th>
                  <th className="py-3 px-4">Industry</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Active Campaigns</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-newBgLineColor/50">
                {clients.map((client) => (
                  <tr key={client.id} className="hover:bg-newBgColor/40 transition-colors">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-newTextColor">
                        {client.companyName || client.name}
                      </div>
                      {client.website && (
                        <a
                          href={client.website}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] text-blue-400 hover:underline flex items-center gap-1 mt-0.5"
                        >
                          {client.website.replace(/^https?:\/\//, '')}
                          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                          </svg>
                        </a>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="text-newTextColor font-medium">{client.name}</div>
                      <div className="text-[11px] text-textItemBlur">{client.email || 'No email provided'}</div>
                    </td>
                    <td className="py-3.5 px-4 text-textItemBlur">
                      {client.industry || 'General'}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        {client.status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-textItemBlur">
                      {client._count?.campaigns ?? 0} campaign(s)
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Link
                          href={`/agency/campaigns/new?client=${client.id}`}
                          className="px-2.5 py-1 bg-blue-600/10 hover:bg-blue-600/20 text-blue-400 rounded border border-blue-500/20 text-[11px] font-medium"
                        >
                          + New Ad
                        </Link>
                        <button
                          onClick={() => handleDeleteClient(client.id, client.name)}
                          className="p-1 text-slate-500 hover:text-rose-400 rounded transition-colors"
                          title="Remove Client"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Onboard Client Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-6 max-w-lg w-full shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-newBgLineColor pb-3">
              <div>
                <h3 className="text-base font-bold text-newTextColor">Onboard Advertising Client</h3>
                <p className="text-xs text-textItemBlur">Add client business details and contact information</p>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-textItemBlur hover:text-newTextColor p-1 rounded-lg"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateClient} className="flex flex-col gap-3.5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                    Contact Name *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. John Doe"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-1.5 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                    Company Name
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Acme Corp"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-1.5 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                    Email Address
                  </label>
                  <input
                    type="email"
                    placeholder="client@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-1.5 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                    Phone Number
                  </label>
                  <input
                    type="text"
                    placeholder="+1 555-0199"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-1.5 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                    Industry / Category
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Fintech, SaaS, Retail"
                    value={industry}
                    onChange={(e) => setIndustry(e.target.value)}
                    className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-1.5 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                    Website URL
                  </label>
                  <input
                    type="url"
                    placeholder="https://example.com"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-1.5 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                  Internal Notes
                </label>
                <textarea
                  rows={2}
                  placeholder="Notes about target audience, goals, special requirements..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-1.5 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500 resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-newBgLineColor mt-1">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-3 py-1.5 rounded-lg border border-newBgLineColor text-xs text-textItemBlur hover:text-newTextColor transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-all disabled:opacity-50"
                >
                  {isSubmitting ? 'Onboarding...' : 'Save & Onboard Client'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
