'use client';

import React, { FC, useState } from 'react';
import { useToaster } from '@gitroom/react/toaster/toaster';
import {
  useAgencyApi,
  useCan,
  useWhatsappDueTasks,
  useWhatsappSegments,
  useWhatsappSettings,
  useWhatsappTasks,
  useWhatsappTemplates,
  WhatsappTaskStatus,
  WhatsappTaskView,
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
  PageHeader,
  PageShell,
  Segmented,
  StatusBadge,
  TextArea,
  TextField,
  timeAgo,
  useBusy,
} from '@gitroom/frontend/components/agency/agency.ui';
import {
  dayValue,
  daysFromNow,
  endOfTodayIso,
  refreshWhatsapp,
  startOfDayIso,
  TaskBadge,
  useCopy,
} from '@gitroom/frontend/components/agency/whatsapp.shared';
import {
  ContactsTab,
  UnsubscribedTab,
} from '@gitroom/frontend/components/agency/whatsapp.contacts.component';
import { ImportsTab } from '@gitroom/frontend/components/agency/whatsapp.imports.component';
import {
  PrepareDialog,
  SegmentsTab,
  TemplatesTab,
} from '@gitroom/frontend/components/agency/whatsapp.templates.component';

type Tab =
  | 'today'
  | 'contacts'
  | 'segments'
  | 'templates'
  | 'outreach'
  | 'imports'
  | 'unsubscribed';

// ---------------------------------------------------------------------------
// A reminder day and a note for one task
// ---------------------------------------------------------------------------
const ReminderDialog: FC<{
  task: WhatsappTaskView;
  onClose: () => void;
  onSaved: () => void;
}> = ({ task, onClose, onSaved }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const [day, setDay] = useState(
    task.followUpAt
      ? dayValue(new Date(task.followUpAt))
      : dayValue(daysFromNow(1))
  );

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!day) return;
    await run(async () => {
      try {
        await api.put(`/agency/whatsapp/tasks/${task.id}`, {
          followUpAt: startOfDayIso(day),
        });
        onSaved();
        onClose();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  return (
    <Dialog
      title="Remind me"
      description="The reminder shows under Today in this app on that day. Nothing is sent to anyone."
      size="sm"
      onClose={onClose}
      busy={busy}
      onSubmit={save}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" type="submit" busy={busy}>
            Set reminder
          </Btn>
        </>
      }
    >
      <TextField
        label="Day"
        type="date"
        value={day}
        onChange={(e) => setDay(e.target.value)}
        error={day ? undefined : 'Choose a day.'}
        autoFocus
      />
    </Dialog>
  );
};

const NoteDialog: FC<{
  task: WhatsappTaskView;
  onClose: () => void;
  onSaved: () => void;
}> = ({ task, onClose, onSaved }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const [note, setNote] = useState(task.note ?? '');

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    await run(async () => {
      try {
        await api.put(`/agency/whatsapp/tasks/${task.id}`, { note });
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
      description="For you and your team. It is never sent to the person."
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
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={1000}
        autoFocus
      />
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// One task: three things a person does by hand. Nothing here sends anything.
// ---------------------------------------------------------------------------
const TaskRow: FC<{
  task: WhatsappTaskView;
  canWrite: boolean;
  /** The next one to do: its button is the filled one. */
  next?: boolean;
}> = ({ task, canWrite, next }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const copy = useCopy();
  const [fallback, setFallback] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const { busy, run } = useBusy();
  const [noting, setNoting] = useState(false);
  const [reminding, setReminding] = useState(false);
  const optedOut = task.contact.consentStatus === 'OPTED_OUT';
  const open = task.status !== 'SKIPPED' && !optedOut;

  /**
   * Opens this one chat. The blank tab is opened right away, inside the click, so the browser lets
   * it through; the link is asked for afterwards and put into it. If nothing opens, the link is
   * shown below for the person to click themselves.
   */
  const openChat = async () => {
    const blank = window.open('about:blank', '_blank');
    if (blank) blank.opener = null;
    setOpening(true);
    try {
      const { url } = await api.post<{ url: string }>(
        `/agency/whatsapp/tasks/${task.id}/open`
      );
      setFallback(url);
      if (blank) blank.location.href = url;
      else window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      blank?.close();
      toaster.show((err as Error).message, 'warning');
    } finally {
      setOpening(false);
      void refreshWhatsapp();
    }
  };

  const mark = async (status: WhatsappTaskStatus) => {
    await run(async () => {
      try {
        await api.put(`/agency/whatsapp/tasks/${task.id}/status`, { status });
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      } finally {
        void refreshWhatsapp();
      }
    });
  };

  const remind = async (day: Date | null) => {
    await run(async () => {
      try {
        await api.put(`/agency/whatsapp/tasks/${task.id}`, {
          followUpAt: day ? startOfDayIso(dayValue(day)) : null,
        });
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      } finally {
        void refreshWhatsapp();
      }
    });
  };

  const clearReminder: MenuItem[] = task.followUpAt
    ? [{ label: 'Clear the reminder', onClick: () => void remind(null) }]
    : [];
  const reminders: MenuItem[] =
    task.status === 'PENDING' || task.status === 'SENT_BY_USER'
      ? [
          {
            label: 'Remind me tomorrow',
            onClick: () => void remind(daysFromNow(1)),
          },
          {
            label: 'Remind me in 3 days',
            onClick: () => void remind(daysFromNow(3)),
          },
          {
            label: 'Remind me in a week',
            onClick: () => void remind(daysFromNow(7)),
          },
          { label: 'Pick a reminder day…', onClick: () => setReminding(true) },
          ...clearReminder,
        ]
      : [];
  const undo: MenuItem[] =
    task.status === 'SENT_BY_USER'
      ? [
          {
            label: 'Undo: not sent after all',
            onClick: () => void mark('PENDING'),
          },
        ]
      : task.status === 'REPLIED'
      ? [
          {
            label: 'Undo: not replied',
            onClick: () => void mark('SENT_BY_USER'),
          },
        ]
      : task.status === 'SKIPPED' && !optedOut
      ? [{ label: 'Reopen this task', onClick: () => void mark('PENDING') }]
      : [];
  const menu: MenuItem[] = [
    ...reminders,
    {
      label: task.note ? 'Edit note' : 'Add a note',
      onClick: () => setNoting(true),
    },
    ...undo,
  ];

  return (
    <li className="py-5 first:pt-0 last:pb-0 flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-newTextColor">
              {task.contact.name}
            </span>
            <span className="text-xs text-textItemBlur tabular-nums">
              {task.contact.maskedPhone}
            </span>
            <TaskBadge status={task.status} />
            {optedOut && <StatusBadge status="REVOKED" label="Opted out" />}
          </div>
          <p className="mt-0.5 text-xs text-textItemBlur">
            {[
              task.label,
              task.status === 'SENT_BY_USER' && task.sentAt
                ? `you marked it sent ${timeAgo(task.sentAt)}`
                : '',
              task.status === 'REPLIED' && task.repliedAt
                ? `replied ${timeAgo(task.repliedAt)}`
                : '',
              task.followUpAt ? `reminder ${formatDate(task.followUpAt)}` : '',
              task.openedAt && task.status === 'PENDING'
                ? `chat opened ${timeAgo(task.openedAt)}`
                : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {canWrite && (
          <Menu label={`More for ${task.contact.name}`} items={menu} />
        )}
      </div>

      <p className="rounded-xl bg-[var(--ag-neutral-bg)] px-3.5 py-2.5 text-[13px] leading-relaxed text-newTextColor whitespace-pre-wrap break-words max-h-44 overflow-y-auto">
        {task.message}
      </p>

      {task.note && (
        <p className="text-xs text-textItemBlur whitespace-pre-wrap break-words">
          Note: {task.note}
        </p>
      )}

      {optedOut && (
        <p className="text-xs text-textItemBlur">
          This person withdrew consent, so the message is closed and there is no
          chat link.
        </p>
      )}
      {!optedOut && task.status === 'SKIPPED' && task.skipReason && (
        <p className="text-xs text-textItemBlur">{task.skipReason}</p>
      )}

      {canWrite && open && (
        <div className="flex flex-wrap items-center gap-2">
          <Btn
            variant={
              next && task.status === 'PENDING' ? 'primary' : 'secondary'
            }
            busy={opening}
            onClick={openChat}
            title={
              task.status === 'PENDING'
                ? 'Opens the chat with this message typed in the box. You press send.'
                : 'Opens the chat. The message is only filled in while the task is waiting.'
            }
          >
            Open in WhatsApp
          </Btn>
          <Btn onClick={() => void copy(task.message, 'Message copied.')}>
            Copy message
          </Btn>
          {task.status === 'PENDING' && (
            <>
              <Btn disabled={busy} onClick={() => void mark('SENT_BY_USER')}>
                Mark as sent
              </Btn>
              <Btn
                variant="ghost"
                disabled={busy}
                onClick={() => void mark('SKIPPED')}
              >
                Mark as skipped
              </Btn>
            </>
          )}
          {task.status === 'SENT_BY_USER' && (
            <Btn disabled={busy} onClick={() => void mark('REPLIED')}>
              Mark as replied
            </Btn>
          )}
        </div>
      )}
      {fallback && open && (
        <p className="text-xs text-textItemBlur">
          If WhatsApp did not open,{' '}
          <a
            href={fallback}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[color:var(--ag-accent-text)] hover:underline"
          >
            open this chat
          </a>
          . Come back and mark the message when you have sent it.
        </p>
      )}

      {noting && (
        <NoteDialog
          task={task}
          onClose={() => setNoting(false)}
          onSaved={() => void refreshWhatsapp()}
        />
      )}
      {reminding && (
        <ReminderDialog
          task={task}
          onClose={() => setReminding(false)}
          onSaved={() => void refreshWhatsapp()}
        />
      )}
    </li>
  );
};

const TaskList: FC<{ tasks: WhatsappTaskView[]; canWrite: boolean }> = ({
  tasks,
  canWrite,
}) => (
  <ul className="flex flex-col divide-y divide-[color:var(--ag-hairline)]">
    {tasks.map((task, i) => (
      <TaskRow key={task.id} task={task} canWrite={canWrite} next={i === 0} />
    ))}
  </ul>
);

// ---------------------------------------------------------------------------
// Today: reminders that came due, then what is waiting to be sent
// ---------------------------------------------------------------------------
const TodayTab: FC<{ go: (tab: Tab) => void; canWrite: boolean }> = ({
  go,
  canWrite,
}) => {
  const due = useWhatsappDueTasks(endOfTodayIso());
  const waiting = useWhatsappTasks('PENDING');
  const first = (waiting.data ?? []).slice(0, 10);

  return (
    <div className="flex flex-col gap-6">
      <Card
        title="Follow-ups due"
        subtitle="Reminders you set for today or earlier. They show here only: nothing is sent."
      >
        {due.error ? (
          <LoadError error={due.error} onRetry={() => due.mutate()} />
        ) : !due.data ? (
          <Loading rows={2} />
        ) : due.data.length === 0 ? (
          <EmptyState
            icon="check"
            title="Nothing to follow up today"
            hint="When you set a reminder on a message, it appears here on that day."
          />
        ) : (
          <TaskList tasks={due.data} canWrite={canWrite} />
        )}
      </Card>

      <Card
        title="Waiting to be sent"
        subtitle="One chat at a time: open it, send the message yourself, then mark it."
        right={
          waiting.data && waiting.data.length > first.length ? (
            <Btn onClick={() => go('outreach')}>
              See all {waiting.data.length}
            </Btn>
          ) : undefined
        }
      >
        {waiting.error ? (
          <LoadError error={waiting.error} onRetry={() => waiting.mutate()} />
        ) : !waiting.data ? (
          <Loading rows={3} />
        ) : first.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="No messages waiting"
            hint="Add people who agreed to be contacted, write a template, then prepare messages for them."
            action={
              canWrite ? (
                <Btn variant="primary" onClick={() => go('contacts')}>
                  Go to contacts
                </Btn>
              ) : undefined
            }
          />
        ) : (
          <TaskList tasks={first} canWrite={canWrite} />
        )}
      </Card>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Outreach: every prepared message, by what happened to it
// ---------------------------------------------------------------------------
const OUTREACH_FILTERS: Array<{ value: WhatsappTaskStatus; label: string }> = [
  { value: 'PENDING', label: 'To send' },
  { value: 'SENT_BY_USER', label: 'Marked sent by you' },
  { value: 'REPLIED', label: 'Replied' },
  { value: 'SKIPPED', label: 'Skipped' },
];

const OutreachTab: FC<{ canWrite: boolean }> = ({ canWrite }) => {
  const [status, setStatus] = useState<WhatsappTaskStatus>('PENDING');
  const [preparing, setPreparing] = useState(false);
  const tasks = useWhatsappTasks(status);
  const templates = useWhatsappTemplates();
  const segments = useWhatsappSegments();
  const settings = useWhatsappSettings();

  return (
    <Card
      title="Outreach"
      subtitle="Each message is for one person. AgencyOS cannot see whether a message arrived: “sent” only means you marked it so."
      right={
        canWrite && (
          <Btn variant="primary" onClick={() => setPreparing(true)}>
            Prepare messages
          </Btn>
        )
      }
    >
      <Segmented
        ariaLabel="Message status"
        value={status}
        onChange={setStatus}
        options={OUTREACH_FILTERS}
      />
      {tasks.error ? (
        <LoadError error={tasks.error} onRetry={() => tasks.mutate()} />
      ) : !tasks.data ? (
        <Loading rows={3} />
      ) : tasks.data.length === 0 ? (
        <EmptyState
          icon="inbox"
          title={
            status === 'PENDING'
              ? 'No messages waiting'
              : `Nothing is ${OUTREACH_FILTERS.find(
                  (f) => f.value === status
                )?.label.toLowerCase()} yet`
          }
          hint={
            status === 'PENDING'
              ? 'Prepare messages for a segment or a contact. They wait here until you send them.'
              : undefined
          }
        />
      ) : (
        <TaskList tasks={tasks.data} canWrite={canWrite} />
      )}
      {preparing && (
        <PrepareDialog
          templates={templates.data ?? []}
          segments={segments.data ?? []}
          limit={settings.data?.limits.maxTasksPerDraft ?? 500}
          onClose={() => setPreparing(false)}
          onDone={() => {
            setStatus('PENDING');
            void refreshWhatsapp();
          }}
        />
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------
export const AgencyWhatsappComponent: FC = () => {
  const { can, isLoading } = useCan();
  const canWrite = can('whatsapp:write');
  const [tab, setTab] = useState<Tab>('today');
  const waiting = useWhatsappTasks('PENDING');
  const due = useWhatsappDueTasks(endOfTodayIso());

  if (isLoading) {
    return (
      <PageShell>
        <Loading />
      </PageShell>
    );
  }
  if (!can('whatsapp:read')) {
    return (
      <PageShell>
        <PageHeader title="WhatsApp" />
        <Notice>Your role cannot see the WhatsApp workspace.</Notice>
      </PageShell>
    );
  }

  const prepared = () => {
    setTab('outreach');
    void refreshWhatsapp();
  };

  return (
    <PageShell>
      <PageHeader
        title="WhatsApp"
        subtitle="Prepare messages for people who agreed to hear from you, and send each one yourself in WhatsApp. AgencyOS never sends for you and cannot see whether a message arrived."
      />
      <Segmented
        ariaLabel="WhatsApp sections"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'today', label: 'Today', count: due.data?.length },
          { value: 'contacts', label: 'Contacts' },
          { value: 'segments', label: 'Segments' },
          { value: 'templates', label: 'Templates' },
          { value: 'outreach', label: 'Outreach', count: waiting.data?.length },
          { value: 'imports', label: 'Imports' },
          { value: 'unsubscribed', label: 'Unsubscribed' },
        ]}
      />
      <div role="tabpanel" aria-label="WhatsApp section">
        {tab === 'today' && <TodayTab go={setTab} canWrite={canWrite} />}
        {tab === 'contacts' && (
          <ContactsTab
            onImport={() => setTab('imports')}
            onPrepared={prepared}
          />
        )}
        {tab === 'segments' && <SegmentsTab onPrepared={prepared} />}
        {tab === 'templates' && <TemplatesTab onPrepared={prepared} />}
        {tab === 'outreach' && <OutreachTab canWrite={canWrite} />}
        {tab === 'imports' && <ImportsTab />}
        {tab === 'unsubscribed' && <UnsubscribedTab />}
      </div>
    </PageShell>
  );
};
