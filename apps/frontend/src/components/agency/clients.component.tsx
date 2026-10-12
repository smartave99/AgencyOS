'use client';

import React, { FC, useEffect, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  useAgencyApi,
  useCan,
  useClients,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  EmptyState,
  inputClass,
  labelClass,
  LoadError,
  Loading,
  PageHeader,
  PageShell,
  StatusBadge,
} from '@gitroom/frontend/components/agency/agency.ui';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isUrl = (value: string) => {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

const EMPTY = {
  name: '',
  companyName: '',
  email: '',
  phone: '',
  industry: '',
  website: '',
  notes: '',
};

const ClientDialog: FC<{ onClose: () => void; onSaved: () => void }> = ({
  onClose,
  onSaved,
}) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const [form, setForm] = useState(EMPTY);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const errors: Record<string, string | null> = {
    name: form.name.trim() ? null : 'Who is the main contact?',
    email:
      form.email.trim() && !EMAIL.test(form.email.trim())
        ? 'That doesn’t look like an email address.'
        : null,
    website:
      form.website.trim() && !isUrl(form.website.trim())
        ? 'Start with https://'
        : null,
  };
  const invalid = Object.values(errors).some(Boolean);

  const set =
    (key: keyof typeof EMPTY) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  const blur = (key: string) => () =>
    setTouched((t) => ({ ...t, [key]: true }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ name: true, email: true, website: true });
    if (invalid) return;
    setBusy(true);
    try {
      const body = Object.fromEntries(
        Object.entries(form)
          .map(([k, v]) => [k, v.trim()])
          .filter(([, v]) => v)
      );
      await api.post('/agency/clients', body);
      toaster.show('Client added', 'success');
      onSaved();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    } finally {
      setBusy(false);
    }
  };

  const field = (
    key: keyof typeof EMPTY,
    label: string,
    props: React.InputHTMLAttributes<HTMLInputElement> = {}
  ) => (
    <div>
      <label htmlFor={`client-${key}`} className={labelClass}>
        {label}
      </label>
      <input
        id={`client-${key}`}
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="client-title"
    >
      <form
        onSubmit={submit}
        className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-6 max-w-lg w-full shadow-2xl flex flex-col gap-4"
      >
        <h3 id="client-title" className="text-base font-bold text-newTextColor">
          Add a client
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field('name', 'Contact name', { autoFocus: true })}
          {field('companyName', 'Company (optional)')}
          {field('email', 'Email (optional)', { type: 'email' })}
          {field('phone', 'Phone (optional)')}
          {field('industry', 'Industry (optional)')}
          {field('website', 'Website (optional)', {
            type: 'url',
            placeholder: 'https://',
          })}
        </div>
        <div>
          <label htmlFor="client-notes" className={labelClass}>
            Internal notes (optional)
          </label>
          <textarea
            id="client-notes"
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
            Add client
          </Btn>
        </div>
      </form>
    </div>
  );
};

export const AgencyClientsComponent = () => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { can } = useCan();
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const { data, error, mutate } = useClients(search);

  const remove = async (id: string, name: string) => {
    if (
      !(await deleteDialog(
        `Remove ${name}? Their campaigns stay in the system for your records.`
      ))
    )
      return;
    try {
      await api.del(`/agency/clients/${id}`);
      toaster.show('Client removed', 'success');
      await mutate();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  const canWrite = can('client:write');

  return (
    <PageShell>
      <PageHeader
        crumb="Clients"
        title="Clients"
        subtitle="The businesses you run campaigns for."
        actions={
          canWrite ? (
            <Btn variant="primary" onClick={() => setAdding(true)}>
              Add client
            </Btn>
          ) : undefined
        }
      />

      <div className="flex items-center justify-between gap-4 bg-newBgColorInner border border-newBgLineColor rounded-xl p-3">
        <div className="flex-1 max-w-md">
          <label htmlFor="client-search" className="sr-only">
            Search clients
          </label>
          <input
            id="client-search"
            type="search"
            placeholder="Search by name, company or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="text-xs text-textItemBlur">
          {data ? `${data.length} client${data.length === 1 ? '' : 's'}` : ''}
        </div>
      </div>

      {error ? (
        <LoadError error={error} onRetry={() => mutate()} />
      ) : !data ? (
        <Loading label="Loading clients…" />
      ) : data.length === 0 ? (
        <div className="bg-newBgColorInner border border-newBgLineColor rounded-2xl">
          <EmptyState
            title={search ? 'No matching clients' : 'No clients yet'}
            hint={
              search
                ? 'Try a different search.'
                : 'Add your first client to start building campaigns for them.'
            }
            action={
              canWrite && !search ? (
                <Btn variant="primary" onClick={() => setAdding(true)}>
                  Add client
                </Btn>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="bg-newBgColorInner border border-newBgLineColor rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-newBgColor border-b border-newBgLineColor text-textItemBlur font-medium">
                <tr>
                  <th className="py-3 px-4">Company</th>
                  <th className="py-3 px-4">Contact</th>
                  <th className="py-3 px-4">Industry</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Campaigns</th>
                  <th className="py-3 px-4 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-newBgLineColor">
                {data.map((client) => (
                  <tr key={client.id}>
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-newTextColor">
                        {client.companyName || client.name}
                      </div>
                      {client.website && isUrl(client.website) && (
                        <a
                          href={client.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-blue-400 hover:underline"
                        >
                          {client.website.replace(/^https?:\/\//, '')}
                        </a>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="text-newTextColor font-medium">
                        {client.name}
                      </div>
                      <div className="text-[11px] text-textItemBlur">
                        {client.email || 'No email'}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 text-textItemBlur">
                      {client.industry || '—'}
                    </td>
                    <td className="py-3.5 px-4">
                      <StatusBadge status={client.status} />
                    </td>
                    <td className="py-3.5 px-4 text-textItemBlur">
                      {client._count?.campaigns ?? 0}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-3">
                        {can('campaign:write') && (
                          <Link
                            href={`/agency/campaigns/new?client=${client.id}`}
                            className="text-[11px] font-semibold text-blue-400 hover:underline"
                          >
                            New campaign
                          </Link>
                        )}
                        {can('client:delete') && (
                          <button
                            onClick={() => void remove(client.id, client.name)}
                            className="text-[11px] text-rose-400 hover:underline"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {adding && (
        <ClientDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void mutate();
          }}
        />
      )}
    </PageShell>
  );
};
