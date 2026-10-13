'use client';

import React, { FC, useState } from 'react';
import Link from 'next/link';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  LeadLinkView,
  LeadView,
  useAgencyApi,
  useCampaigns,
  useCan,
  useLeadLinks,
  useLeads,
  useTelegramBots,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Card,
  Dialog,
  EmptyState,
  humanize,
  LoadError,
  Loading,
  Menu,
  MenuItem,
  Notice,
  PageHeader,
  PageShell,
  SelectField,
  StatusBadge,
  tableClass,
  TextArea,
  TextField,
  timeAgo,
  useBusy,
  useTouched,
} from '@gitroom/frontend/components/agency/agency.ui';

const STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST'];
const SERVER_BOT = 'server';

// ---------------------------------------------------------------------------
// New link
// ---------------------------------------------------------------------------
const NewLinkDialog: FC<{ onClose: () => void; onSaved: () => void }> = ({
  onClose,
  onSaved,
}) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const touched = useTouched();
  const { busy, run } = useBusy();
  const { data: bots } = useTelegramBots();
  const { data: campaigns } = useCampaigns('ALL', '');
  const [label, setLabel] = useState('');
  const [botId, setBotId] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [welcome, setWelcome] = useState('');

  const choices = [
    ...(bots?.server.configured
      ? [{ id: SERVER_BOT, name: bots.server.label }]
      : []),
    ...(bots?.bots ?? [])
      .filter((b) => b.status === 'ACTIVE')
      .map((b) => ({ id: b.id, name: `${b.label} (@${b.username})` })),
  ];
  const chosen = botId || (choices.length === 1 ? choices[0].id : '');
  const errors = {
    label: label.trim() ? null : 'Give the link a name.',
    bot: chosen ? null : 'Choose which bot the link opens.',
  };

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    touched.all(['label', 'bot']);
    if (errors.label || errors.bot) return;
    await run(async () => {
      try {
        await api.post('/agency/leads/links', {
          label: label.trim(),
          botId: chosen,
          campaignId: campaignId || undefined,
          welcomeMessage: welcome.trim() || undefined,
        });
        toaster.show('Link created.', 'success');
        onSaved();
        onClose();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  return (
    <Dialog
      title="New lead link"
      description="Anyone who taps Start on this link is added to your leads. They are told what is kept and how to stop."
      onClose={onClose}
      busy={busy}
      onSubmit={save}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" type="submit" busy={busy}>
            Create link
          </Btn>
        </>
      }
    >
      {bots && choices.length === 0 ? (
        <Notice
          tone="warn"
          action={
            <Link
              href="/settings?tab=telegram"
              className="font-medium text-[color:var(--ag-accent-text)] hover:underline"
            >
              Connect a bot
            </Link>
          }
        >
          A link opens a chat with one of your bots, so connect a bot first.
        </Notice>
      ) : (
        <div className="flex flex-col gap-4">
          <TextField
            label="Name"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={touched.blur('label')}
            error={touched.show('label', errors.label)}
            placeholder="Spring offer"
            autoFocus
          />
          <SelectField
            label="Bot"
            value={chosen}
            onChange={(e) => setBotId(e.target.value)}
            onBlur={touched.blur('bot')}
            error={touched.show('bot', errors.bot)}
          >
            <option value="">Choose a bot…</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Campaign"
            optional
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
          >
            <option value="">Not tied to a campaign</option>
            {(campaigns ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectField>
          <TextArea
            label="Welcome message"
            optional
            rows={3}
            value={welcome}
            onChange={(e) => setWelcome(e.target.value)}
            maxLength={500}
            hint="Said first when someone taps Start. The notice about what is kept and /stop is always added after it."
          />
        </div>
      )}
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// A person's note
// ---------------------------------------------------------------------------
const NoteDialog: FC<{
  lead: LeadView;
  onClose: () => void;
  onSaved: () => void;
}> = ({ lead, onClose, onSaved }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const [notes, setNotes] = useState(lead.notes ?? '');

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    await run(async () => {
      try {
        await api.put(`/agency/leads/${lead.id}`, { notes });
        onSaved();
        onClose();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  return (
    <Dialog
      title="Note"
      description={lead.name || lead.telegramHandle || 'Lead'}
      onClose={onClose}
      busy={busy}
      onSubmit={save}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" type="submit" busy={busy}>
            Save note
          </Btn>
        </>
      }
    >
      <TextArea
        label="Note"
        rows={4}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        maxLength={2000}
        autoFocus
      />
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------
export const AgencyLeadsComponent: FC = () => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { can } = useCan();
  const canWrite = can('crm:write');
  const [linkId, setLinkId] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [noting, setNoting] = useState<LeadView | null>(null);
  const links = useLeadLinks();
  const people = useLeads(linkId, status, search);

  const refresh = () => {
    void links.mutate();
    void people.mutate();
  };

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toaster.show(done, 'success');
    } catch {
      toaster.show(
        'Copying is not allowed here. Select the text instead.',
        'warning'
      );
    }
  };

  const download = async (format: 'csv' | 'json') => {
    const params = new URLSearchParams({ format });
    if (linkId) params.set('linkId', linkId);
    try {
      await api.download(`/agency/leads/export?${params}`, `leads.${format}`);
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  const setLeadStatus = async (lead: LeadView, next: string) => {
    try {
      await api.put(`/agency/leads/${lead.id}`, { status: next });
      void people.mutate();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  const erase = async (lead: LeadView) => {
    if (
      !(await deleteDialog(
        `Delete ${
          lead.name || lead.telegramHandle || 'this person'
        } from your leads? Their details are removed from AgencyOS.`,
        'Delete person',
        undefined,
        undefined,
        true
      ))
    ) {
      return;
    }
    try {
      await api.del(`/agency/leads/${lead.id}`);
      refresh();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  const removeLink = async (link: LeadLinkView) => {
    if (
      !(await deleteDialog(
        `Stop using “${link.label}”? Nobody new can join through it. The ${
          link.people
        } ${
          link.people === 1 ? 'person' : 'people'
        } already on it stay in your leads.`,
        'Remove link',
        undefined,
        undefined,
        true
      ))
    ) {
      return;
    }
    try {
      await api.del(`/agency/leads/links/${link.id}`);
      refresh();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  const personMenu = (lead: LeadView): MenuItem[] => [
    ...STATUSES.filter((s) => s !== lead.status).map((s) => ({
      label: `Mark as ${humanize(s).toLowerCase()}`,
      onClick: () => void setLeadStatus(lead, s),
    })),
    { label: 'Edit note', onClick: () => setNoting(lead) },
    { label: 'Delete person', danger: true, onClick: () => void erase(lead) },
  ];

  const asText = () =>
    (people.data ?? [])
      .map((p) =>
        [p.name, p.telegramHandle, humanize(p.status)]
          .filter(Boolean)
          .join(' · ')
      )
      .join('\n');

  return (
    <PageShell>
      <PageHeader
        title="Leads"
        subtitle="People who tapped Start on one of your bot links. Nobody else is collected, and anyone can send /stop to the bot to be deleted."
        actions={
          <>
            <Menu
              label="Export leads"
              items={[
                { label: 'Download CSV', onClick: () => void download('csv') },
                {
                  label: 'Download JSON',
                  onClick: () => void download('json'),
                },
                {
                  label: 'Copy as text',
                  onClick: () => void copy(asText(), 'Copied.'),
                  disabled: !people.data?.length,
                },
              ]}
            />
            {canWrite && (
              <Btn variant="primary" onClick={() => setAdding(true)}>
                New link
              </Btn>
            )}
          </>
        }
      />

      <Card
        title="Links"
        subtitle="Share a link where people already are: your website, a poster, a QR code, an ad."
      >
        {links.error ? (
          <LoadError error={links.error} onRetry={() => links.mutate()} />
        ) : !links.data ? (
          <Loading rows={2} />
        ) : links.data.length === 0 ? (
          <EmptyState
            icon="link"
            title="No links yet"
            hint="A link opens a chat with your bot. Whoever taps Start becomes a lead."
            action={
              canWrite ? (
                <Btn variant="primary" onClick={() => setAdding(true)}>
                  Make the first link
                </Btn>
              ) : undefined
            }
          />
        ) : (
          <div className={tableClass.wrap}>
            <table className={tableClass.table}>
              <thead className={tableClass.head}>
                <tr>
                  <th className={tableClass.th}>Link</th>
                  <th className={tableClass.th}>Address</th>
                  <th className={`${tableClass.th} text-right`}>People</th>
                  <th className={`${tableClass.th} text-right`}>Stopped</th>
                  <th className={tableClass.th}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {links.data.map((link) => (
                  <tr key={link.id} className={tableClass.row}>
                    <td className={`${tableClass.td} font-medium`}>
                      {link.label}
                      {link.campaign && (
                        <span className="block text-xs font-normal text-textItemBlur">
                          {link.campaign.name}
                        </span>
                      )}
                    </td>
                    <td className={tableClass.td}>
                      {link.url ? (
                        <span className="flex items-center gap-2">
                          <span className="max-w-[18rem] truncate text-textItemBlur">
                            {link.url}
                          </span>
                          <Btn
                            onClick={() => void copy(link.url!, 'Link copied.')}
                          >
                            Copy
                          </Btn>
                        </span>
                      ) : (
                        <span className="text-textItemBlur">
                          Its bot is not available
                        </span>
                      )}
                    </td>
                    <td className={`${tableClass.td} text-right tabular-nums`}>
                      {link.people}
                    </td>
                    <td
                      className={`${tableClass.td} text-right tabular-nums text-textItemBlur`}
                    >
                      {link.stopped}
                    </td>
                    <td className={`${tableClass.td} text-right`}>
                      {canWrite && (
                        <Menu
                          label="Link actions"
                          items={[
                            {
                              label: 'Remove link',
                              danger: true,
                              onClick: () => void removeLink(link),
                            },
                          ]}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="People">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <TextField
            label="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, username or note"
          />
          <SelectField
            label="Link"
            value={linkId}
            onChange={(e) => setLinkId(e.target.value)}
          >
            <option value="">All links</option>
            {(links.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">Everyone</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </SelectField>
        </div>
        {people.error ? (
          <LoadError error={people.error} onRetry={() => people.mutate()} />
        ) : !people.data ? (
          <Loading rows={3} />
        ) : people.data.length === 0 ? (
          <EmptyState
            icon="users"
            title={
              search || linkId || status ? 'Nobody matches' : 'No leads yet'
            }
            hint={
              search || linkId || status
                ? 'Try clearing the filters.'
                : 'When someone taps Start on one of your links, they appear here.'
            }
          />
        ) : (
          <div className={tableClass.wrap}>
            <table className={tableClass.table}>
              <thead className={tableClass.head}>
                <tr>
                  <th className={tableClass.th}>Person</th>
                  <th className={tableClass.th}>Link</th>
                  <th className={tableClass.th}>Status</th>
                  <th className={tableClass.th}>Started</th>
                  <th className={tableClass.th}>Note</th>
                  <th className={tableClass.th}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {people.data.map((lead) => (
                  <tr key={lead.id} className={tableClass.row}>
                    <td className={`${tableClass.td} font-medium`}>
                      {lead.name || 'No name'}
                      {lead.telegramHandle && (
                        <span className="block text-xs font-normal text-textItemBlur">
                          {lead.telegramHandle}
                        </span>
                      )}
                    </td>
                    <td className={`${tableClass.td} text-textItemBlur`}>
                      {lead.leadLink?.label ?? '—'}
                    </td>
                    <td className={tableClass.td}>
                      <StatusBadge status={lead.status} />
                    </td>
                    <td className={`${tableClass.td} text-textItemBlur`}>
                      {timeAgo(lead.consentedAt ?? lead.createdAt)}
                    </td>
                    <td
                      className={`${tableClass.td} max-w-[16rem] truncate text-textItemBlur`}
                    >
                      {lead.notes ?? ''}
                    </td>
                    <td className={`${tableClass.td} text-right`}>
                      {canWrite && (
                        <Menu label="Lead actions" items={personMenu(lead)} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {adding && (
        <NewLinkDialog onClose={() => setAdding(false)} onSaved={refresh} />
      )}
      {noting && (
        <NoteDialog
          lead={noting}
          onClose={() => setNoting(null)}
          onSaved={() => void people.mutate()}
        />
      )}
    </PageShell>
  );
};
