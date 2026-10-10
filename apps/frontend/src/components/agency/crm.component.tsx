'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';

interface Lead {
  id: string;
  name: string;
  company: string;
  email: string;
  phone?: string;
  value: number;
  stage: 'PROSPECT' | 'CONTACTED' | 'PROPOSAL_SENT' | 'WON';
}

export const AgencyCrmComponent = () => {
  const [leads, setLeads] = useState<Lead[]>([
    {
      id: 'lead-1',
      name: 'Michael Scott',
      company: 'Dunder Mifflin Tech',
      email: 'michael@dunder.com',
      value: 1200,
      stage: 'PROSPECT',
    },
    {
      id: 'lead-2',
      name: 'Sarah Connor',
      company: 'Cyberdyne AI',
      email: 'sarah@cyberdyne.io',
      value: 3500,
      stage: 'PROPOSAL_SENT',
    },
    {
      id: 'lead-3',
      name: 'Bruce Wayne',
      company: 'Wayne Enterprises',
      email: 'bruce@wayne.corp',
      value: 8000,
      stage: 'WON',
    },
    {
      id: 'lead-4',
      name: 'Elena Rostova',
      company: 'CryptoPulse Media',
      email: 'elena@cryptopulse.net',
      value: 2400,
      stage: 'CONTACTED',
    },
  ]);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newLeadName, setNewLeadName] = useState('');
  const [newLeadCompany, setNewLeadCompany] = useState('');
  const [newLeadEmail, setNewLeadEmail] = useState('');
  const [newLeadValue, setNewLeadValue] = useState('');

  const stages = [
    { key: 'PROSPECT', label: 'Prospects / Inquiries', color: 'border-slate-500' },
    { key: 'CONTACTED', label: 'Initial Contact Made', color: 'border-blue-500' },
    { key: 'PROPOSAL_SENT', label: 'Campaign Proposal Sent', color: 'border-amber-500' },
    { key: 'WON', label: 'Won / Active Client', color: 'border-emerald-500' },
  ];

  const handleAddLead = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLeadName.trim()) return;

    const newLead: Lead = {
      id: `lead-${Date.now()}`,
      name: newLeadName.trim(),
      company: newLeadCompany.trim() || 'Direct Client',
      email: newLeadEmail.trim(),
      value: newLeadValue ? parseFloat(newLeadValue) : 1000,
      stage: 'PROSPECT',
    };

    setLeads((prev) => [newLead, ...prev]);
    setIsModalOpen(false);
    setNewLeadName('');
    setNewLeadCompany('');
    setNewLeadEmail('');
    setNewLeadValue('');
  };

  const moveLead = (id: string, newStage: Lead['stage']) => {
    setLeads((prev) =>
      prev.map((l) => (l.id === id ? { ...l, stage: newStage } : l))
    );
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
            <span className="text-xs text-textItemBlur">/</span>
            <span className="text-xs text-textItemBlur">Sales & Opportunities</span>
          </div>
          <h1 className="text-2xl font-bold text-newTextColor tracking-tight mt-1">
            Agency CRM & Sales Pipeline
          </h1>
          <p className="text-xs text-textItemBlur mt-0.5">
            Manage sales opportunities, advertising proposals, and deal progressions.
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-all"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M12 5v14" />
          </svg>
          Add New Lead
        </button>
      </div>

      {/* Pipeline Kanban Board */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {stages.map((stage) => {
          const stageLeads = leads.filter((l) => l.stage === stage.key);
          const totalValue = stageLeads.reduce((acc, l) => acc + l.value, 0);

          return (
            <div
              key={stage.key}
              className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-4 flex flex-col gap-3 min-h-[450px]"
            >
              {/* Stage Header */}
              <div className="flex items-center justify-between border-b border-newBgLineColor pb-2.5">
                <div className="flex items-center gap-2">
                  <span className={clsx('w-2 h-2 rounded-full border-2', stage.color)} />
                  <span className="text-xs font-bold text-newTextColor">{stage.label}</span>
                </div>
                <span className="text-[11px] font-semibold text-textItemBlur bg-newBgColor px-2 py-0.5 rounded">
                  {stageLeads.length}
                </span>
              </div>

              <div className="text-[11px] text-textItemBlur font-medium">
                Stage Pipeline: <strong className="text-newTextColor">${totalValue.toLocaleString()}</strong>
              </div>

              {/* Lead Cards */}
              <div className="flex flex-col gap-2.5 flex-1">
                {stageLeads.map((lead) => (
                  <div
                    key={lead.id}
                    className="p-3.5 rounded-xl bg-newBgColor border border-newBgLineColor/60 flex flex-col gap-2 hover:border-slate-600 transition-all shadow-sm"
                  >
                    <div>
                      <div className="text-xs font-bold text-newTextColor">{lead.company}</div>
                      <div className="text-[11px] text-textItemBlur">{lead.name}</div>
                    </div>

                    <div className="flex items-center justify-between text-xs pt-2 border-t border-newBgLineColor/40">
                      <span className="font-semibold text-emerald-400">
                        ${lead.value.toLocaleString()}
                      </span>

                      {/* Move selector */}
                      <select
                        value={lead.stage}
                        onChange={(e) => moveLead(lead.id, e.target.value as any)}
                        className="bg-newBgColorInner border border-newBgLineColor text-[10px] text-textItemBlur rounded px-1.5 py-0.5 focus:outline-none"
                      >
                        <option value="PROSPECT">Prospect</option>
                        <option value="CONTACTED">Contacted</option>
                        <option value="PROPOSAL_SENT">Proposal Sent</option>
                        <option value="WON">Won</option>
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Lead Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-6 max-w-md w-full shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-newBgLineColor pb-3">
              <h3 className="text-base font-bold text-newTextColor">Add New Sales Lead</h3>
              <button onClick={() => setIsModalOpen(false)} className="text-textItemBlur hover:text-newTextColor">
                ✕
              </button>
            </div>

            <form onSubmit={handleAddLead} className="flex flex-col gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                  Contact Person *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Alex Mercer"
                  value={newLeadName}
                  onChange={(e) => setNewLeadName(e.target.value)}
                  className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-1.5 text-xs text-newTextColor focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                  Company Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. Mercer Capital"
                  value={newLeadCompany}
                  onChange={(e) => setNewLeadCompany(e.target.value)}
                  className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-1.5 text-xs text-newTextColor focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                  Email
                </label>
                <input
                  type="email"
                  placeholder="alex@example.com"
                  value={newLeadEmail}
                  onChange={(e) => setNewLeadEmail(e.target.value)}
                  className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-1.5 text-xs text-newTextColor focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-textItemBlur uppercase mb-1">
                  Estimated Campaign Value ($)
                </label>
                <input
                  type="number"
                  placeholder="1500"
                  value={newLeadValue}
                  onChange={(e) => setNewLeadValue(e.target.value)}
                  className="w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-1.5 text-xs text-newTextColor focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-newBgLineColor">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-3 py-1.5 rounded-lg border border-newBgLineColor text-xs text-textItemBlur hover:text-newTextColor"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow-sm"
                >
                  Save Lead
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
