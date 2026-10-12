'use client';

import React, { FC, useState } from 'react';
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
  Dialog,
  EmptyState,
  Icon,
  inputClass,
  LoadError,
  Loading,
  Menu,
  MenuItem,
  PageHeader,
  PageShell,
  StatusBadge,
  TextArea,
  TextField,
  tableClass,
  useBusy,
  useTouched,
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
  const touched = useTouched();
  const { busy, run } = useBusy();
  const [form, setForm] = useState(EMPTY);

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

  const set =
    (key: keyof typeof EMPTY) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    touched.all(Object.keys(errors));
    if (Object.values(errors).some(Boolean)) return;
    await run(async () => {
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
      }
    });
  };

  return (
    <Dialog
      size="lg"
      title="Add a client"
      onClose={onClose}
      busy={busy}
      onSubmit={submit}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn type="submit" variant="primary" busy={busy}>
            Add client
          </Btn>
        </>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <TextField
          autoFocus
          label="Contact name"
          value={form.name}
          onChange={set('name')}
          onBlur={touched.blur('name')}
          error={touched.show('name', errors.name)}
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
          value={form.email}
          onChange={set('email')}
          onBlur={touched.blur('email')}
          error={touched.show('email', errors.email)}
        />
        <TextField
          label="Phone"
          optional
          value={form.phone}
          onChange={set('phone')}
        />
        <TextField
          label="Industry"
          optional
          value={form.industry}
          onChange={set('industry')}
        />
        <TextField
          label="Website"
          optional
          type="url"
          placeholder="https://"
          value={form.website}
          onChange={set('website')}
          onBlur={touched.blur('website')}
          error={touched.show('website', errors.website)}
        />
      </div>
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
        title="Clients"
        subtitle="The businesses you run campaigns for."
        actions={
          canWrite ? (
            <Btn variant="primary" onClick={() => setAdding(true)}>
              <Icon name="plus" size={15} />
              Add client
            </Btn>
          ) : undefined
        }
      />

      <div className="flex items-center justify-between gap-4">
        <div className="relative w-full max-w-sm">
          <Icon
            name="search"
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-textItemBlur"
          />
          <label htmlFor="client-search" className="sr-only">
            Search clients
          </label>
          <input
            id="client-search"
            type="search"
            placeholder="Search by name, company or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={clsx(inputClass, 'pl-8')}
          />
        </div>
        <div className="text-xs text-textItemBlur whitespace-nowrap">
          {data ? `${data.length} client${data.length === 1 ? '' : 's'}` : ''}
        </div>
      </div>

      {error ? (
        <LoadError error={error} onRetry={() => mutate()} />
      ) : !data ? (
        <Loading label="Loading clients" />
      ) : data.length === 0 ? (
        <div className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)]">
          <EmptyState
            icon="users"
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
        <div className="ag-rise rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)] shadow-[var(--ag-shadow)] p-2 sm:p-3">
          <div className={tableClass.wrap}>
            <table className={tableClass.table}>
              <thead className={tableClass.head}>
                <tr>
                  <th className={tableClass.th}>Company</th>
                  <th className={tableClass.th}>Contact</th>
                  <th className={tableClass.th}>Industry</th>
                  <th className={tableClass.th}>Status</th>
                  <th className={`${tableClass.th} text-right`}>Campaigns</th>
                  <th className={tableClass.th}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((client) => {
                  const menu: MenuItem[] = [];
                  if (can('client:delete')) {
                    menu.push({
                      label: 'Remove client',
                      danger: true,
                      onClick: () =>
                        void remove(
                          client.id,
                          client.companyName || client.name
                        ),
                    });
                  }
                  return (
                    <tr key={client.id} className={tableClass.row}>
                      <td className={tableClass.td}>
                        <div className="font-semibold text-newTextColor">
                          {client.companyName || client.name}
                        </div>
                        {client.website && isUrl(client.website) && (
                          <a
                            href={client.website}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-[color:var(--ag-accent-text)] hover:underline"
                          >
                            {client.website.replace(/^https?:\/\//, '')}
                          </a>
                        )}
                      </td>
                      <td className={tableClass.td}>
                        <div className="text-newTextColor">{client.name}</div>
                        <div className="text-xs text-textItemBlur">
                          {client.email || 'No email'}
                        </div>
                      </td>
                      <td className={`${tableClass.td} text-textItemBlur`}>
                        {client.industry || '—'}
                      </td>
                      <td className={tableClass.td}>
                        <StatusBadge
                          status={client.status}
                          label={
                            client.status.charAt(0) +
                            client.status.slice(1).toLowerCase()
                          }
                        />
                      </td>
                      <td
                        className={`${tableClass.td} text-right tabular-nums text-textItemBlur`}
                      >
                        {client._count?.campaigns ?? 0}
                      </td>
                      <td className={tableClass.td}>
                        <div className="flex items-center justify-end gap-2">
                          {can('campaign:write') && (
                            <Link
                              href={`/agency/campaigns/new?client=${client.id}`}
                              className="text-[13px] font-medium text-[color:var(--ag-accent-text)] hover:underline whitespace-nowrap"
                            >
                              New campaign
                            </Link>
                          )}
                          <Menu
                            label={`Actions for ${client.name}`}
                            items={menu}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
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
