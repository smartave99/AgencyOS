'use client';

import React, { FC, useState } from 'react';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  useAgencyApi,
  useCan,
  useWhatsappContact,
  useWhatsappContacts,
  useWhatsappFacets,
  useWhatsappSegments,
  useWhatsappSettings,
  useWhatsappTemplates,
  useWhatsappUnsubscribes,
  WhatsappContactItem,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Card,
  Dialog,
  EmptyState,
  formatDate,
  LoadError,
  Loading,
  Menu,
  MenuItem,
  Notice,
  SelectField,
  tableClass,
  TextArea,
  TextField,
  useBusy,
  useTouched,
} from '@gitroom/frontend/components/agency/agency.ui';
import {
  CONSENT_SOURCES,
  ConsentBadge,
  dayValue,
  phoneProblem,
  refreshWhatsapp,
  TagList,
  TaskBadge,
  WITHDRAW_METHODS,
  withdrawMethod,
} from '@gitroom/frontend/components/agency/whatsapp.shared';
import { PrepareDialog } from '@gitroom/frontend/components/agency/whatsapp.templates.component';

const splitTags = (text: string) =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

// ---------------------------------------------------------------------------
// Add one person, with the record of how and when they agreed
// ---------------------------------------------------------------------------
const AddContactDialog: FC<{ onClose: () => void }> = ({ onClose }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const touched = useTouched();
  const { busy, run } = useBusy();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [company, setCompany] = useState('');
  const [language, setLanguage] = useState('');
  const [tags, setTags] = useState('');
  const [source, setSource] = useState('');
  const [evidence, setEvidence] = useState('');
  const [date, setDate] = useState('');
  const [refused, setRefused] = useState<string | null>(null);

  const errors = {
    name: name.trim() ? null : 'Give the person a name.',
    phone: phoneProblem(phone),
    source: source ? null : 'Say how this person agreed to be contacted.',
    evidence:
      source === 'Other' && !evidence.trim()
        ? 'Describe how they agreed, so it can be checked later.'
        : null,
    date: date
      ? date > dayValue(new Date())
        ? 'The date cannot be in the future.'
        : null
      : 'Say the day this person agreed.',
  };

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    touched.all(['name', 'phone', 'source', 'evidence', 'date']);
    if (Object.values(errors).some(Boolean)) return;
    setRefused(null);
    await run(async () => {
      try {
        await api.post('/agency/whatsapp/contacts', {
          name: name.trim(),
          phone: phone.trim(),
          company: company.trim() || undefined,
          language: language.trim() || undefined,
          tags: splitTags(tags),
          consentSource: source,
          consentEvidence: evidence.trim() || undefined,
          consentedAt: date,
        });
        toaster.show('Contact added.', 'success');
        void refreshWhatsapp();
        onClose();
      } catch (err) {
        setRefused((err as Error).message);
      }
    });
  };

  return (
    <Dialog
      title="Add a contact"
      description="Only add someone who agreed to be contacted on WhatsApp. How and when they agreed is part of the record."
      size="lg"
      onClose={onClose}
      busy={busy}
      onSubmit={save}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" type="submit" busy={busy}>
            Add contact
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {refused && <Notice tone="bad">{refused}</Notice>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <TextField
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={touched.blur('name')}
            error={touched.show('name', errors.name)}
            maxLength={120}
            autoFocus
          />
          <TextField
            label="WhatsApp number"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onBlur={touched.blur('phone')}
            error={touched.show('phone', errors.phone)}
            placeholder="+49 151 1234 5678"
            inputMode="tel"
            autoComplete="off"
          />
          <TextField
            label="Company"
            optional
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            maxLength={120}
          />
          <TextField
            label="Language"
            optional
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="en"
            maxLength={12}
          />
        </div>
        <TextField
          label="Tags"
          optional
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="vip, berlin"
          hint="Separate tags with commas."
        />
        <div className="rounded-xl border border-[color:var(--ag-hairline)] p-4 flex flex-col gap-4">
          <p className="text-[13px] font-medium text-newTextColor">
            Consent record
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <SelectField
              label="How they agreed"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onBlur={touched.blur('source')}
              error={touched.show('source', errors.source)}
            >
              <option value="">Choose…</option>
              {CONSENT_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </SelectField>
            <TextField
              label="The day they agreed"
              type="date"
              value={date}
              max={dayValue(new Date())}
              onChange={(e) => setDate(e.target.value)}
              onBlur={touched.blur('date')}
              error={touched.show('date', errors.date)}
            />
          </div>
          <TextArea
            label="Evidence"
            optional={source !== 'Other'}
            rows={2}
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            onBlur={touched.blur('evidence')}
            error={touched.show('evidence', errors.evidence)}
            maxLength={500}
            hint="What shows it, for example “Ticked the box on the spring-offer page” or “List v3, row 12”."
          />
        </div>
      </div>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// Withdraw consent: they asked to stop, and it is remembered even after erasing
// ---------------------------------------------------------------------------
const WithdrawDialog: FC<{
  contact: { id: string; name: string };
  onClose: () => void;
}> = ({ contact, onClose }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const touched = useTouched();
  const { busy, run } = useBusy();
  const [method, setMethod] = useState('');
  const [date, setDate] = useState(dayValue(new Date()));
  const [reason, setReason] = useState('');

  const errors = {
    method: method ? null : 'Say how the request reached you.',
    date: !date
      ? 'Say the day they asked.'
      : date > dayValue(new Date())
      ? 'The date cannot be in the future.'
      : null,
  };

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    touched.all(['method', 'date']);
    if (errors.method || errors.date) return;
    if (
      !(await deleteDialog(
        `${contact.name} will be marked as opted out, taken out of every segment, and messages waiting for them are closed. This cannot be undone in this version.`,
        'Withdraw consent',
        'Withdraw consent?',
        undefined,
        true
      ))
    ) {
      return;
    }
    await run(async () => {
      try {
        await api.post(`/agency/whatsapp/contacts/${contact.id}/withdraw`, {
          method,
          receivedAt: date,
          reason: reason.trim() || undefined,
        });
        toaster.show(
          'Consent withdrawn. They will not be contacted.',
          'success'
        );
        void refreshWhatsapp();
        onClose();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  return (
    <Dialog
      title="Withdraw consent"
      description={`${contact.name} asked not to be contacted. They are kept out of every list, message and chat link, and the withdrawal is remembered even if you later erase their details.`}
      onClose={onClose}
      busy={busy}
      onSubmit={save}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="danger" type="submit" busy={busy}>
            Withdraw consent
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <SelectField
          label="How did they ask?"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          onBlur={touched.blur('method')}
          error={touched.show('method', errors.method)}
          autoFocus
        >
          <option value="">Choose…</option>
          {Object.entries(WITHDRAW_METHODS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </SelectField>
        <TextField
          label="The day they asked"
          type="date"
          value={date}
          max={dayValue(new Date())}
          onChange={(e) => setDate(e.target.value)}
          onBlur={touched.blur('date')}
          error={touched.show('date', errors.date)}
        />
        <TextArea
          label="Note"
          optional
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          hint="Keep it short. Do not write phone numbers here."
        />
      </div>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// A contact's own screen: the only place the whole number is shown
// ---------------------------------------------------------------------------
const ContactDialog: FC<{ id: string; onClose: () => void }> = ({
  id,
  onClose,
}) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { can } = useCan();
  const canWrite = can('whatsapp:write');
  const canErase = can('whatsapp:delete');
  const { busy, run } = useBusy();
  const contact = useWhatsappContact(id);
  const [form, setForm] = useState<{
    name: string;
    company: string;
    language: string;
    tags: string;
    notes: string;
  } | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const data = contact.data;
  const values = form ?? {
    name: data?.name ?? '',
    company: data?.company ?? '',
    language: data?.language ?? '',
    tags: (data?.tags ?? []).join(', '),
    notes: data?.notes ?? '',
  };
  const change = (patch: Partial<typeof values>) =>
    setForm({ ...values, ...patch });

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!values.name.trim()) return;
    await run(async () => {
      try {
        await api.put(`/agency/whatsapp/contacts/${id}`, {
          name: values.name.trim(),
          company: values.company.trim(),
          language: values.language.trim(),
          tags: splitTags(values.tags),
          notes: values.notes,
        });
        toaster.show('Saved.', 'success');
        setForm(null);
        void refreshWhatsapp();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  const erase = async () => {
    if (!data) return;
    if (
      !(await deleteDialog(
        `Erase ${
          data.name
        }? Their name, number, notes and every message prepared for them are deleted.${
          data.consentStatus === 'OPTED_OUT'
            ? ' The fact that they withdrew stays in the unsubscribed list, without their details.'
            : ' If they asked not to be contacted, withdraw consent first so that is remembered.'
        }`,
        'Erase contact',
        undefined,
        undefined,
        true
      ))
    ) {
      return;
    }
    await run(async () => {
      try {
        await api.del(`/agency/whatsapp/contacts/${id}`);
        toaster.show('Contact erased.', 'success');
        void refreshWhatsapp();
        onClose();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  return (
    <>
      <Dialog
        title={data?.name ?? 'Contact'}
        description={
          data && (
            <span className="inline-flex items-center gap-2">
              <ConsentBadge status={data.consentStatus} />
              <span>Added {formatDate(data.createdAt)}</span>
            </span>
          )
        }
        size="lg"
        onClose={onClose}
        busy={busy}
        onSubmit={save}
        footer={
          data && (
            <>
              {canErase && (
                <Btn variant="danger" onClick={erase} disabled={busy}>
                  Erase contact
                </Btn>
              )}
              {canWrite && data.consentStatus === 'OPTED_IN' && (
                <Btn
                  variant="danger"
                  onClick={() => setWithdrawing(true)}
                  disabled={busy}
                >
                  Withdraw consent
                </Btn>
              )}
              <Btn onClick={onClose} disabled={busy}>
                Close
              </Btn>
              {canWrite && (
                <Btn
                  variant="primary"
                  type="submit"
                  busy={busy}
                  disabled={!form}
                >
                  Save changes
                </Btn>
              )}
            </>
          )
        }
      >
        {contact.error ? (
          <LoadError error={contact.error} onRetry={() => contact.mutate()} />
        ) : !data ? (
          <Loading rows={4} />
        ) : (
          <div className="flex flex-col gap-5">
            {data.consentStatus === 'OPTED_OUT' && (
              <Notice tone="warn">
                Withdrew consent
                {data.optedOutAt ? ` on ${formatDate(data.optedOutAt)}` : ''}
                {data.optOutMethod
                  ? ` (${withdrawMethod(data.optOutMethod).toLowerCase()})`
                  : ''}
                . They are kept out of every segment and message list, and there
                is no chat link for them.
                {data.optOutReason ? ` Note: ${data.optOutReason}` : ''}
              </Notice>
            )}

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
              <div>
                <dt className="text-xs font-medium text-textItemBlur">
                  WhatsApp number
                </dt>
                <dd className="mt-1 text-newTextColor tabular-nums break-all">
                  {data.phone ?? data.maskedPhone}
                </dd>
                <dd className="mt-1 text-xs text-textItemBlur">
                  {data.phone
                    ? 'Shown only here and in the chat link.'
                    : 'Your role sees numbers masked.'}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-textItemBlur">
                  How they agreed
                </dt>
                <dd className="mt-1 text-newTextColor">
                  {data.consentSource} · {formatDate(data.consentedAt)}
                </dd>
                {data.consentEvidence && (
                  <dd className="mt-1 text-xs text-textItemBlur break-words">
                    {data.consentEvidence}
                  </dd>
                )}
              </div>
            </dl>

            {canWrite ? (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <TextField
                    label="Name"
                    value={values.name}
                    onChange={(e) => change({ name: e.target.value })}
                    error={
                      values.name.trim() ? undefined : 'Give the person a name.'
                    }
                    maxLength={120}
                  />
                  <TextField
                    label="Company"
                    optional
                    value={values.company}
                    onChange={(e) => change({ company: e.target.value })}
                    maxLength={120}
                  />
                  <TextField
                    label="Language"
                    optional
                    value={values.language}
                    onChange={(e) => change({ language: e.target.value })}
                    maxLength={12}
                  />
                  <TextField
                    label="Tags"
                    optional
                    value={values.tags}
                    onChange={(e) => change({ tags: e.target.value })}
                    hint="Separate tags with commas."
                  />
                </div>
                <TextArea
                  label="Notes"
                  optional
                  rows={3}
                  value={values.notes}
                  onChange={(e) => change({ notes: e.target.value })}
                  maxLength={2000}
                />
              </div>
            ) : (
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
                <div>
                  <dt className="text-xs font-medium text-textItemBlur">
                    Company
                  </dt>
                  <dd className="mt-1 text-newTextColor">
                    {data.company ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-textItemBlur">
                    Tags
                  </dt>
                  <dd className="mt-1">
                    <TagList tags={data.tags} />
                    {data.tags.length === 0 && '—'}
                  </dd>
                </div>
                {data.notes && (
                  <div className="sm:col-span-2">
                    <dt className="text-xs font-medium text-textItemBlur">
                      Notes
                    </dt>
                    <dd className="mt-1 text-newTextColor whitespace-pre-wrap">
                      {data.notes}
                    </dd>
                  </div>
                )}
              </dl>
            )}

            <div>
              <p className="text-xs font-medium text-textItemBlur mb-2">
                Messages prepared for them
              </p>
              {data.tasks.length === 0 ? (
                <p className="text-[13px] text-textItemBlur">None yet.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-[color:var(--ag-hairline)]">
                  {data.tasks.map((task) => (
                    <li
                      key={task.id}
                      className="py-2.5 first:pt-0 last:pb-0 flex flex-wrap items-center justify-between gap-2 text-[13px]"
                    >
                      <span className="text-newTextColor">{task.label}</span>
                      <span className="flex items-center gap-2">
                        <span className="text-xs text-textItemBlur">
                          {formatDate(task.createdAt)}
                        </span>
                        <TaskBadge status={task.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Dialog>
      {withdrawing && data && (
        <WithdrawDialog
          contact={{ id: data.id, name: data.name }}
          onClose={() => setWithdrawing(false)}
        />
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
export const ContactsTab: FC<{
  onImport: () => void;
  onPrepared: () => void;
}> = ({ onImport, onPrepared }) => {
  const { can } = useCan();
  const canWrite = can('whatsapp:write');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState<WhatsappContactItem | null>(
    null
  );
  const [preparing, setPreparing] = useState<WhatsappContactItem | null>(null);
  const contacts = useWhatsappContacts(search, status, tag);
  const facets = useWhatsappFacets();
  const templates = useWhatsappTemplates();
  const segments = useWhatsappSegments();
  const settings = useWhatsappSettings();
  const filtered = !!(search || status || tag);

  const menu = (contact: WhatsappContactItem): MenuItem[] => [
    { label: 'Open details', onClick: () => setOpen(contact.id) },
    ...(canWrite && contact.consentStatus === 'OPTED_IN'
      ? [
          {
            label: 'Prepare a message',
            onClick: () => setPreparing(contact),
          },
          {
            label: 'Withdraw consent',
            danger: true,
            onClick: () => setWithdrawing(contact),
          },
        ]
      : []),
  ];

  return (
    <Card
      title="Contacts"
      subtitle="People who agreed to be contacted on WhatsApp. Numbers are masked in this list."
      right={
        canWrite && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Btn onClick={onImport}>Import a list</Btn>
            <Btn variant="primary" onClick={() => setAdding(true)}>
              Add contact
            </Btn>
          </div>
        )
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <TextField
          label="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name, company or tag"
        />
        <SelectField
          label="Consent"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">Everyone</option>
          <option value="OPTED_IN">Opted in</option>
          <option value="OPTED_OUT">Opted out</option>
        </SelectField>
        <SelectField
          label="Tag"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
        >
          <option value="">All tags</option>
          {(facets.data?.tags ?? []).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </SelectField>
      </div>

      {contacts.error ? (
        <LoadError error={contacts.error} onRetry={() => contacts.mutate()} />
      ) : !contacts.data ? (
        <Loading rows={4} />
      ) : contacts.data.length === 0 ? (
        <EmptyState
          icon="users"
          title={filtered ? 'Nobody matches' : 'No contacts yet'}
          hint={
            filtered
              ? 'Try clearing the filters.'
              : 'Add someone who agreed to be contacted on WhatsApp, or import a list that records when and how each person agreed.'
          }
          action={
            !filtered && canWrite ? (
              <Btn variant="primary" onClick={() => setAdding(true)}>
                Add the first contact
              </Btn>
            ) : undefined
          }
        />
      ) : (
        <div className={tableClass.wrap}>
          <table className={tableClass.table}>
            <thead className={tableClass.head}>
              <tr>
                <th className={tableClass.th}>Person</th>
                <th className={tableClass.th}>Number</th>
                <th className={tableClass.th}>How they agreed</th>
                <th className={tableClass.th}>Status</th>
                <th className={tableClass.th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {contacts.data.map((contact) => (
                <tr key={contact.id} className={tableClass.row}>
                  <td className={tableClass.td}>
                    <button
                      type="button"
                      onClick={() => setOpen(contact.id)}
                      className="font-medium text-left text-newTextColor hover:underline"
                    >
                      {contact.name}
                    </button>
                    {contact.company && (
                      <span className="block text-xs text-textItemBlur">
                        {contact.company}
                      </span>
                    )}
                    <TagList tags={contact.tags} className="mt-1" />
                  </td>
                  <td
                    className={`${tableClass.td} tabular-nums text-textItemBlur whitespace-nowrap`}
                  >
                    {contact.maskedPhone}
                  </td>
                  <td className={`${tableClass.td} text-textItemBlur`}>
                    {contact.consentSource}
                    <span className="block text-xs">
                      {formatDate(contact.consentedAt)}
                    </span>
                  </td>
                  <td className={tableClass.td}>
                    <ConsentBadge status={contact.consentStatus} />
                    {contact.consentStatus === 'OPTED_OUT' && (
                      <span className="block mt-1 text-xs text-textItemBlur max-w-[14rem]">
                        Withdrew consent
                        {contact.optedOutAt
                          ? ` on ${formatDate(contact.optedOutAt)}`
                          : ''}
                        . No messages or chat links.
                      </span>
                    )}
                  </td>
                  <td className={`${tableClass.td} text-right`}>
                    <Menu
                      label={`Actions for ${contact.name}`}
                      items={menu(contact)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && <AddContactDialog onClose={() => setAdding(false)} />}
      {open && <ContactDialog id={open} onClose={() => setOpen(null)} />}
      {withdrawing && (
        <WithdrawDialog
          contact={withdrawing}
          onClose={() => setWithdrawing(null)}
        />
      )}
      {preparing && (
        <PrepareDialog
          templates={templates.data ?? []}
          segments={segments.data ?? []}
          limit={settings.data?.limits.maxTasksPerDraft ?? 500}
          contact={preparing}
          onClose={() => setPreparing(null)}
          onDone={onPrepared}
        />
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Unsubscribed: the ledger. It can be read, never edited or emptied.
// ---------------------------------------------------------------------------
export const UnsubscribedTab: FC = () => {
  const ledger = useWhatsappUnsubscribes();
  return (
    <Card
      title="Unsubscribed"
      subtitle="Everyone who withdrew consent. This list is kept even after someone’s details are erased: only a scrambled fingerprint of the number stays, so a withdrawn person cannot be added again by mistake."
    >
      {ledger.error ? (
        <LoadError error={ledger.error} onRetry={() => ledger.mutate()} />
      ) : !ledger.data ? (
        <Loading rows={3} />
      ) : ledger.data.length === 0 ? (
        <EmptyState
          icon="shield"
          title="Nobody has withdrawn"
          hint="When someone asks to stop, withdraw their consent on their contact. It is recorded here and cannot be edited or removed."
        />
      ) : (
        <div className={tableClass.wrap}>
          <table className={tableClass.table}>
            <thead className={tableClass.head}>
              <tr>
                <th className={tableClass.th}>Person</th>
                <th className={tableClass.th}>Asked on</th>
                <th className={tableClass.th}>How it reached you</th>
                <th className={tableClass.th}>Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {ledger.data.map((row) => (
                <tr key={row.id} className={tableClass.row}>
                  <td className={`${tableClass.td} font-medium`}>
                    {row.contact ? (
                      <>
                        {row.contact.name}
                        <span className="block text-xs font-normal text-textItemBlur tabular-nums">
                          {row.contact.maskedPhone}
                        </span>
                      </>
                    ) : (
                      <span className="font-normal text-textItemBlur">
                        Erased contact
                      </span>
                    )}
                  </td>
                  <td className={`${tableClass.td} text-textItemBlur`}>
                    {formatDate(row.receivedAt)}
                  </td>
                  <td className={`${tableClass.td} text-textItemBlur`}>
                    {withdrawMethod(row.method)}
                  </td>
                  <td className={`${tableClass.td} text-textItemBlur`}>
                    {row.recordedBy}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
};
