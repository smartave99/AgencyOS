'use client';

import React, { FC, useState } from 'react';
import Link from 'next/link';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  DestinationView,
  PostingJob,
  TelegramBots,
  useAgencyApi,
  useCan,
  usePublishingEvents,
  usePublishingQueue,
  useTelegramBots,
  useTelegramDestinations,
} from './agency.hooks';
import {
  Btn,
  Card,
  Dialog,
  EmptyState,
  LinkBtn,
  Loading,
  LoadError,
  Menu,
  MenuItem,
  Notice,
  PageHeader,
  PageShell,
  Segmented,
  SelectField,
  StatusBadge,
  TextField,
  TONE_TEXT,
  formatDate,
  formatDateTime,
  tableClass,
  timeAgo,
  useBusy,
  useTouched,
} from './agency.ui';
import { SystemBanner } from './system-banner.component';

const CHAT_REF = /^(-?\d{5,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/;

interface Instructions {
  verificationCode: string;
  botUsername: string | null;
  steps: string[];
  title: string;
}

interface Preview {
  valid: boolean;
  title: string;
  type: string;
  botIsAdmin: boolean;
  canPostMessages: boolean;
  error?: string;
}

/** What the status means for the person looking at the row, and what to do next. */
const statusDetail = (d: DestinationView) => {
  switch (d.authorizationStatus) {
    case 'ACTIVE':
      return `Authorized${
        d.consentedByName ? ` by ${d.consentedByName}` : ''
      } until ${formatDate(d.consentExpiresAt)}`;
    case 'PENDING_VERIFICATION':
      return d.hasPendingVerification
        ? `Waiting for a group admin to send the code (valid until ${formatDate(
            d.verificationExpiresAt
          )})`
        : 'The code expired. Issue a new one.';
    case 'SUSPENDED':
      return d.revokedReason || 'Suspended by your team. Posts are paused.';
    case 'REVOKED':
      return d.revokedReason || 'Consent was withdrawn. Posts are paused.';
    case 'EXPIRED':
      return 'Consent expired. A group admin must authorize again.';
    case 'DISCONNECTED':
      return (
        d.revokedReason || d.lastError || 'The bot lost access to this chat.'
      );
  }
};

// ---------------------------------------------------------------------------
// The one-time authorization code, shown where it can't be lost by scrolling
// ---------------------------------------------------------------------------
const InstructionsDialog: FC<{ info: Instructions; onDone: () => void }> = ({
  info,
  onDone,
}) => {
  const toaster = useToaster();
  const command = `/authorize ${info.verificationCode}`;
  return (
    <Dialog
      size="lg"
      title={`Ask a group admin to authorize ${info.title}`}
      description="This code is shown once. You can issue a new one at any time."
      onClose={onDone}
      footer={
        <>
          <Btn
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(command);
                toaster.show('Copied', 'success');
              } catch {
                toaster.show(
                  'Copy failed. Select the text and copy it manually.',
                  'warning'
                );
              }
            }}
          >
            Copy the command
          </Btn>
          <Btn variant="primary" onClick={onDone}>
            I’ve sent it
          </Btn>
        </>
      }
    >
      {!info.botUsername && (
        <Notice tone="warn">
          AgencyOS is not connected to a Telegram bot yet, so nobody can use the
          code until a bot is connected (Settings → Telegram bots, or the
          “Connect a Telegram bot” button on the Dashboard).
        </Notice>
      )}
      <ol className="flex flex-col gap-3">
        {info.steps.map((s, i) => (
          <li key={s} className="flex gap-3 text-[13px] text-newTextColor">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--ag-accent-soft)] text-[11px] font-semibold text-[color:var(--ag-accent-text)]">
              {i + 1}
            </span>
            <span className="leading-relaxed">{s}</span>
          </li>
        ))}
      </ol>
      <code
        data-autofocus
        tabIndex={0}
        className="block rounded-xl bg-[var(--ag-neutral-bg)] px-4 py-3.5 text-center font-mono text-[15px] tracking-wide text-newTextColor select-all"
      >
        {command}
      </code>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// Connect a chat
// ---------------------------------------------------------------------------
const RegisterPanel: FC<{
  onRegistered: () => void;
  onInstructions: (i: Instructions) => void;
}> = ({ onRegistered, onInstructions }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const touched = useTouched();
  const [chatRef, setChatRef] = useState('');
  const [owner, setOwner] = useState('');
  const [botChoice, setBotChoice] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<'check' | 'register' | null>(null);
  const { data: botList } = useTelegramBots();

  // Every bot that can post: the connected ones that are on, plus the server's. A chat is served by
  // exactly one of them, so with several the person chooses.
  const choices = [
    ...(botList?.bots ?? [])
      .filter((b) => b.status === 'ACTIVE')
      .map((b) => ({ value: b.id, label: `${b.label} (@${b.username})` })),
    ...(botList?.server.configured
      ? [
          {
            value: 'server',
            label: `${botList.server.label}${
              botList.server.username ? ` (@${botList.server.username})` : ''
            }`,
          },
        ]
      : []),
  ];
  const botId = choices.some((c) => c.value === botChoice)
    ? botChoice
    : choices[0]?.value ?? '';

  const trimmed = chatRef.trim();
  const refError = !trimmed
    ? 'Enter the chat to connect.'
    : !CHAT_REF.test(trimmed)
    ? 'Use the numeric chat ID (like -1001234567890) or the public @username.'
    : null;

  const check = async () => {
    touched.all(['chat']);
    if (refError) return;
    setBusy('check');
    setPreview(null);
    try {
      setPreview(
        await api.post<Preview>('/agency/telegram/verify', {
          chatId: trimmed,
          botId: botId || undefined,
        })
      );
    } catch (e) {
      toaster.show((e as Error).message, 'warning');
    } finally {
      setBusy(null);
    }
  };

  const register = async (e: React.FormEvent) => {
    e.preventDefault();
    touched.all(['chat']);
    if (refError) return;
    setBusy('register');
    try {
      const res = await api.post<{
        destination: DestinationView;
        verificationCode: string;
        botUsername: string | null;
        steps: string[];
      }>('/agency/telegram/destinations', {
        chatId: trimmed,
        botId: botId || undefined,
        ownerName: owner.trim() || undefined,
      });
      onInstructions({
        verificationCode: res.verificationCode,
        botUsername: res.botUsername,
        steps: res.steps,
        title: res.destination.title,
      });
      setChatRef('');
      setOwner('');
      setPreview(null);
      touched.reset();
      onRegistered();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    } finally {
      setBusy(null);
    }
  };

  if (botList && choices.length === 0) {
    return (
      <Card
        title="Connect a group or channel"
        subtitle="Ads are only ever sent to chats whose administrators have authorized you."
      >
        <Notice
          tone="warn"
          action={
            <LinkBtn href="/settings?tab=telegram" variant="primary">
              Connect a Telegram bot
            </LinkBtn>
          }
        >
          Connect a Telegram bot first. It is the bot that posts your ads and
          hears a group admin’s authorization.
        </Notice>
      </Card>
    );
  }

  return (
    <Card
      title="Connect a group or channel"
      subtitle="Ads are only ever sent to chats whose administrators have authorized you."
    >
      <form className="flex flex-col gap-4" onSubmit={register} noValidate>
        {choices.length > 1 && (
          <SelectField
            label="Posts through"
            hint="Each chat is served by one bot. It needs to be added to the chat as an administrator."
            value={botId}
            onChange={(e) => {
              setBotChoice(e.target.value);
              setPreview(null);
            }}
          >
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </SelectField>
        )}
        <TextField
          label="Chat ID or public @username"
          className="font-mono"
          placeholder="@yourchannel or -1001234567890"
          value={chatRef}
          onChange={(e) => {
            setChatRef(e.target.value);
            setPreview(null);
          }}
          onBlur={touched.blur('chat')}
          error={touched.show('chat', refError)}
        />
        <TextField
          label="Who owns this chat?"
          optional
          placeholder="e.g. Fruit Lovers community, Priya"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
        />

        {preview &&
          (preview.valid ? (
            <div className="ag-rise rounded-xl bg-[var(--ag-neutral-bg)] p-4 text-[13px] flex flex-col gap-1.5">
              <div className="font-semibold text-newTextColor">
                {preview.title}{' '}
                <span className="text-textItemBlur font-normal">
                  ({preview.type})
                </span>
              </div>
              <div
                className={preview.botIsAdmin ? TONE_TEXT.good : TONE_TEXT.warn}
              >
                {preview.botIsAdmin
                  ? 'The bot is an administrator here.'
                  : 'The bot is not an administrator yet. Add it as one before authorizing.'}
              </div>
              <div
                className={
                  preview.canPostMessages ? TONE_TEXT.good : TONE_TEXT.warn
                }
              >
                {preview.canPostMessages
                  ? 'It can post messages.'
                  : 'It cannot post messages yet.'}
              </div>
            </div>
          ) : (
            <Notice tone="warn">{preview.error}</Notice>
          ))}

        <div className="flex items-center justify-end gap-2">
          <Btn busy={busy === 'check'} onClick={check}>
            Check chat
          </Btn>
          <Btn type="submit" variant="primary" busy={busy === 'register'}>
            Get authorization code
          </Btn>
        </div>
      </form>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// One destination: its state in plain words, the next step, the rest in a menu
// ---------------------------------------------------------------------------
const DestinationRow: FC<{
  d: DestinationView;
  canManage: boolean;
  onChanged: () => void;
  onInstructions: (i: Instructions) => void;
}> = ({ d, canManage, onChanged, onInstructions }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { busy, run: runBusy } = useBusy();
  const { data: botList } = useTelegramBots();
  const [editingBots, setEditingBots] = useState(false);

  const run = (fn: () => Promise<void>, done?: string) =>
    runBusy(async () => {
      try {
        await fn();
        if (done) toaster.show(done, 'success');
        onChanged();
      } catch (e) {
        toaster.show((e as Error).message, 'warning');
      }
    });

  const newCode = () =>
    run(async () => {
      const res = await api.post<{
        verificationCode: string;
        botUsername: string | null;
        steps: string[];
      }>(`/agency/telegram/destinations/${d.id}/reauthorize`);
      onInstructions({
        verificationCode: res.verificationCode,
        botUsername: res.botUsername,
        steps: res.steps,
        title: d.title,
      });
    });

  const confirmThen = async (
    message: string,
    confirm: string,
    action: () => Promise<void>,
    done: string
  ) => {
    if (await deleteDialog(message, confirm, undefined, undefined, true)) {
      await run(action, done);
    }
  };

  const status = d.authorizationStatus;
  const post = (path: string) => async () => {
    await api.post(`/agency/telegram/destinations/${d.id}/${path}`, {});
  };

  const menu: MenuItem[] = [];
  if (status === 'ACTIVE') {
    menu.push(
      {
        label: 'Backup bots…',
        onClick: () => setEditingBots(true),
      },
      {
        label: 'Check health',
        onClick: () => void run(post('refresh'), 'Checked just now'),
      },
      {
        label: 'Pause posting',
        onClick: () =>
          void confirmThen(
            `Pause posting to "${d.title}"? Queued posts wait until you resume.`,
            'Yes, pause it',
            post('suspend'),
            'Destination paused'
          ),
      },
      {
        label: 'Revoke authorization',
        danger: true,
        onClick: () =>
          void confirmThen(
            `Revoke authorization for "${d.title}"? Queued posts are blocked and a group admin must authorize again.`,
            'Yes, revoke',
            post('revoke'),
            'Authorization revoked'
          ),
      }
    );
  }
  menu.push({
    label: 'Remove from registry',
    danger: true,
    onClick: () =>
      void confirmThen(
        `Remove "${d.title}" from your registry? Its history stays in your reports.`,
        'Yes, remove it',
        async () => {
          await api.del(`/agency/telegram/destinations/${d.id}`);
        },
        'Destination removed'
      ),
  });

  return (
    <li className="flex flex-col sm:flex-row sm:items-center gap-4 py-4 border-t first:border-t-0 border-[color:var(--ag-hairline)]">
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold tracking-tight text-newTextColor">
            {d.title}
          </span>
          <StatusBadge status={status} />
        </div>
        <div className="mt-0.5 font-mono text-xs text-textItemBlur">
          {d.chatId}
          {d.botUsername && (
            <span className="font-sans"> · via @{d.botUsername}</span>
          )}
        </div>
        <p className="mt-1.5 text-[13px] text-textItemBlur max-w-lg">
          {statusDetail(d)}
        </p>
        {d.backupBotIds.length > 0 && (
          <p className="mt-1 text-xs text-textItemBlur">
            Backup bots:{' '}
            {d.backupBotIds.map((key) => botName(botList, key)).join(', ')} ·{' '}
            {STRATEGY[d.botStrategy].short}
          </p>
        )}
        {d.lastError && status === 'ACTIVE' && (
          <p className={`mt-1 text-xs ${TONE_TEXT.warn}`}>
            Last problem: {d.lastError}
          </p>
        )}
        <p className="mt-1 text-xs text-textItemBlur">
          {d.lastSuccessfulPostAt
            ? `Last delivery ${timeAgo(d.lastSuccessfulPostAt)}`
            : 'No posts yet'}{' '}
          · used by {d._count.campaignDestinations} campaign
          {d._count.campaignDestinations === 1 ? '' : 's'}
        </p>
      </div>

      {editingBots && botList && (
        <BackupBotsDialog
          d={d}
          bots={botList}
          onClose={() => setEditingBots(false)}
          onChanged={onChanged}
        />
      )}

      {canManage && (
        <div className="flex items-center gap-2 shrink-0">
          {status === 'SUSPENDED' && (
            <Btn
              variant="primary"
              busy={busy}
              onClick={() => void run(post('resume'), 'Destination resumed')}
            >
              Resume
            </Btn>
          )}
          {(status === 'PENDING_VERIFICATION' ||
            status === 'REVOKED' ||
            status === 'EXPIRED' ||
            status === 'DISCONNECTED') && (
            <Btn variant="primary" busy={busy} onClick={() => void newCode()}>
              {status === 'PENDING_VERIFICATION' ? 'New code' : 'Re-authorize'}
            </Btn>
          )}
          <Menu items={menu} />
        </div>
      )}
    </li>
  );
};

// ---------------------------------------------------------------------------
// A chat's backup bots: other bots of yours that the chat's administrator has also made administrators
// ---------------------------------------------------------------------------
export const STRATEGY: Record<
  DestinationView['botStrategy'],
  { label: string; short: string; help: string }
> = {
  FAILOVER: {
    label: 'Main bot first',
    short: 'main bot first',
    help: 'The main bot posts. A backup takes over only when AgencyOS cannot use the main bot: it is paused, removed, or Telegram no longer accepts its token.',
  },
  ROUND_ROBIN: {
    label: 'Take turns',
    short: 'taking turns',
    help: 'Posts take turns across the main bot and the backups.',
  },
  LEAST_USED: {
    label: 'Fewest posts first',
    short: 'fewest posts first',
    help: 'Each post goes to the bot that sent the fewest in the last 24 hours.',
  },
};

export const botName = (bots: TelegramBots | undefined, key: string) => {
  if (key === 'server') return bots?.server.label ?? 'Server bot';
  const bot = bots?.bots.find((b) => b.id === key);
  return bot ? `${bot.label} (@${bot.username})` : 'A removed bot';
};

export const BackupBotsDialog: FC<{
  d: DestinationView;
  bots: TelegramBots;
  onClose: () => void;
  onChanged: () => void;
}> = ({ d, bots, onClose, onChanged }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const mainKey = d.botId ?? 'server';
  const [chosen, setChosen] = useState<string[]>(d.backupBotIds);
  const [strategy, setStrategy] = useState(d.botStrategy);
  const [problem, setProblem] = useState<string | null>(null);

  // Every bot that could help: the connected ones that are on, and the server's, except the main one.
  const options = [
    ...bots.bots
      .filter((b) => b.status === 'ACTIVE')
      .map((b) => ({ key: b.id, label: `${b.label} (@${b.username})` })),
    ...(bots.server.configured
      ? [{ key: 'server', label: bots.server.label }]
      : []),
  ].filter((o) => o.key !== mainKey);

  const toggle = (key: string) =>
    setChosen((now) =>
      now.includes(key) ? now.filter((k) => k !== key) : [...now, key]
    );

  const save = () =>
    run(async () => {
      setProblem(null);
      try {
        await api.put(`/agency/telegram/destinations/${d.id}/bots`, {
          backupBotIds: chosen,
          strategy,
        });
        toaster.show('Saved', 'success');
        onChanged();
        onClose();
      } catch (e) {
        setProblem((e as Error).message);
      }
    });

  const makeMain = async (key: string) => {
    if (
      !(await deleteDialog(
        `Make ${botName(bots, key)} the main bot of "${
          d.title
        }"? The current main bot becomes a backup.`,
        'Yes, switch',
        undefined,
        undefined,
        true
      ))
    ) {
      return;
    }
    await run(async () => {
      setProblem(null);
      try {
        await api.post(`/agency/telegram/destinations/${d.id}/main-bot`, {
          botId: key,
        });
        toaster.show('The main bot was changed', 'success');
        onChanged();
        onClose();
      } catch (e) {
        setProblem((e as Error).message);
      }
    });
  };

  return (
    <Dialog
      title={`Backup bots for ${d.title}`}
      description="Other bots of yours that may post in this chat too."
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" busy={busy} onClick={() => void save()}>
            Save
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-textItemBlur">
          Main bot:{' '}
          <b className="text-newTextColor">{botName(bots, mainKey)}</b>
        </p>
        {options.length === 0 ? (
          <Notice
            tone="info"
            action={
              <LinkBtn href="/settings?tab=telegram">Connect a bot</LinkBtn>
            }
          >
            There is no other bot to use yet.
          </Notice>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-medium text-textItemBlur">
              Backups
            </legend>
            {options.map((o) => (
              <div key={o.key} className="flex items-center gap-3">
                <label className="flex flex-1 items-center gap-2 text-[14px]">
                  <input
                    type="checkbox"
                    checked={chosen.includes(o.key)}
                    onChange={() => toggle(o.key)}
                  />
                  {o.label}
                </label>
                {d.backupBotIds.includes(o.key) && chosen.includes(o.key) && (
                  <Btn onClick={() => void makeMain(o.key)} disabled={busy}>
                    Make main
                  </Btn>
                )}
              </div>
            ))}
          </fieldset>
        )}
        <SelectField
          label="How they share the work"
          hint={STRATEGY[strategy].help}
          value={strategy}
          onChange={(e) =>
            setStrategy(e.target.value as DestinationView['botStrategy'])
          }
        >
          {(Object.keys(STRATEGY) as Array<keyof typeof STRATEGY>).map(
            (key) => (
              <option key={key} value={key}>
                {STRATEGY[key].label}
              </option>
            )
          )}
        </SelectField>
        <p className="rounded-xl bg-[var(--ag-neutral-bg)] p-3 text-xs leading-relaxed text-textItemBlur">
          A backup posts only if this chat’s administrator has already made it
          an administrator with permission to post; nothing here adds a bot to a
          chat. AgencyOS never switches bots because the chat removed one or
          because Telegram asked a bot to slow down: it stops, or waits. Every
          change of bot is recorded in the audit trail with the reason and the
          campaign.
        </p>
        {problem && <Notice tone="bad">{problem}</Notice>}
      </div>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// Queue and receipts
// ---------------------------------------------------------------------------
const QUEUE_CHIPS: Array<{ status: PostingJob['status']; label: string }> = [
  { status: 'PENDING', label: 'Queued' },
  { status: 'SENDING', label: 'Sending' },
  { status: 'SUCCEEDED', label: 'Delivered' },
  { status: 'BLOCKED', label: 'Paused' },
  { status: 'DEAD', label: 'Failed' },
  { status: 'UNCERTAIN', label: 'Needs check' },
];

const QueuePanel: FC = () => {
  const [filter, setFilter] = useState('');
  const { data, error, mutate } = usePublishingQueue(filter);
  return (
    <Card
      title="Publishing queue"
      subtitle="Every post waiting to go out, in flight, or needing attention."
    >
      <Segmented
        ariaLabel="Queue status"
        value={filter}
        onChange={setFilter}
        options={[
          { value: '', label: 'All' },
          ...QUEUE_CHIPS.map((chip) => ({
            value: chip.status as string,
            label: chip.label,
            count: data?.counts?.[chip.status] ?? 0,
          })),
        ]}
      />
      {error ? (
        <LoadError error={error} onRetry={() => mutate()} />
      ) : !data ? (
        <Loading rows={3} />
      ) : data.jobs.length === 0 ? (
        <EmptyState
          icon="clock"
          title="Nothing in the queue"
          hint="Scheduled and published campaigns show up here."
        />
      ) : (
        <div className={tableClass.wrap}>
          <table className={tableClass.table}>
            <thead className={tableClass.head}>
              <tr>
                <th className={tableClass.th}>Campaign</th>
                <th className={tableClass.th}>Destination</th>
                <th className={tableClass.th}>Status</th>
                <th className={tableClass.th}>Attempts</th>
                <th className={tableClass.th}>Next / finished</th>
                <th className={tableClass.th}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((j) => (
                <tr key={j.id} className={tableClass.row}>
                  <td className={tableClass.td}>
                    <Link
                      href={`/agency/campaigns/${j.campaign?.id}`}
                      className="text-newTextColor hover:text-[color:var(--ag-accent-text)] font-medium"
                    >
                      {j.campaign?.name}
                    </Link>
                  </td>
                  <td className={`${tableClass.td} text-textItemBlur`}>
                    {j.telegramDestination?.title ?? '—'}
                  </td>
                  <td className={tableClass.td}>
                    <StatusBadge status={j.status} />
                  </td>
                  <td
                    className={`${tableClass.td} text-textItemBlur tabular-nums`}
                  >
                    {j.attempts}/{j.maxAttempts}
                  </td>
                  <td className={`${tableClass.td} text-textItemBlur`}>
                    {j.status === 'PENDING'
                      ? timeAgo(j.nextAttemptAt)
                      : timeAgo(j.completedAt)}
                  </td>
                  <td className={`${tableClass.td} text-textItemBlur max-w-xs`}>
                    {j.releaseUrl ? (
                      <a
                        href={j.releaseUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[color:var(--ag-accent-text)] hover:underline"
                      >
                        View on Telegram ↗
                      </a>
                    ) : (
                      j.lastError || '—'
                    )}
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

const ReceiptsPanel: FC = () => {
  const { data } = usePublishingEvents();
  return (
    <Card
      title="Delivery receipts"
      subtitle="Every send attempt, with Telegram’s own message ID."
    >
      {!data ? (
        <Loading rows={3} />
      ) : data.length === 0 ? (
        <EmptyState icon="doc" title="No delivery attempts yet" />
      ) : (
        <div className={tableClass.wrap}>
          <table className={tableClass.table}>
            <thead className={tableClass.head}>
              <tr>
                <th className={tableClass.th}>When</th>
                <th className={tableClass.th}>Campaign</th>
                <th className={tableClass.th}>Destination</th>
                <th className={tableClass.th}>Bot</th>
                <th className={tableClass.th}>Message ID</th>
                <th className={tableClass.th}>Result</th>
                <th className={tableClass.th}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.map((evt) => (
                <tr key={evt.id} className={tableClass.row}>
                  <td className={`${tableClass.td} text-textItemBlur`}>
                    {formatDateTime(evt.executedAt)}
                  </td>
                  <td
                    className={`${tableClass.td} text-newTextColor font-medium`}
                  >
                    {evt.campaign?.name}
                  </td>
                  <td className={`${tableClass.td} text-textItemBlur`}>
                    {evt.telegramDestination?.title ?? '—'}
                  </td>
                  <td className={`${tableClass.td} text-textItemBlur`}>
                    {evt.botUsername ? `@${evt.botUsername}` : '—'}
                  </td>
                  <td
                    className={`${tableClass.td} font-mono text-xs text-textItemBlur`}
                  >
                    {evt.externalMessageId || '—'}
                  </td>
                  <td className={tableClass.td}>
                    <StatusBadge status={evt.status} />
                  </td>
                  <td className={`${tableClass.td} text-textItemBlur max-w-xs`}>
                    {evt.releaseUrl ? (
                      <a
                        href={evt.releaseUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[color:var(--ag-accent-text)] hover:underline"
                      >
                        View ↗
                      </a>
                    ) : (
                      evt.errorMessage || '—'
                    )}
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

export const AgencyTelegramComponent: FC = () => {
  const { can } = useCan();
  const { data: destinations, error, mutate } = useTelegramDestinations();
  const [instructions, setInstructions] = useState<Instructions | null>(null);
  const [tab, setTab] = useState('queue');
  const canManage = can('destination:manage');

  return (
    <PageShell>
      <PageHeader
        title="Telegram destinations"
        subtitle="A chat can receive your ads only after one of its administrators authorizes it, and they can withdraw that at any time."
        actions={<LinkBtn href="/settings?tab=telegram">Manage bots</LinkBtn>}
      />
      <SystemBanner />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {canManage && (
          <div className="lg:col-span-5">
            <RegisterPanel
              onRegistered={() => mutate()}
              onInstructions={setInstructions}
            />
          </div>
        )}

        <Card
          title="Your destinations"
          subtitle="Only authorized destinations can be chosen for a campaign."
          right={
            <span className="text-xs text-textItemBlur">
              {destinations?.length ?? 0} registered
            </span>
          }
          className={canManage ? 'lg:col-span-7' : 'lg:col-span-12'}
        >
          {error ? (
            <LoadError error={error} onRetry={() => mutate()} />
          ) : !destinations ? (
            <Loading />
          ) : destinations.length === 0 ? (
            <EmptyState
              icon="send"
              title="No destinations yet"
              hint={
                canManage
                  ? 'Connect your first group or channel to get started.'
                  : 'A campaign manager can connect a group or channel here.'
              }
            />
          ) : (
            <ul className="flex flex-col -my-2">
              {destinations.map((d) => (
                <DestinationRow
                  key={d.id}
                  d={d}
                  canManage={canManage}
                  onChanged={() => mutate()}
                  onInstructions={setInstructions}
                />
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Segmented
          ariaLabel="Delivery view"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'queue', label: 'Publishing queue' },
            { value: 'receipts', label: 'Delivery receipts' },
          ]}
        />
        {tab === 'queue' ? <QueuePanel /> : <ReceiptsPanel />}
      </div>

      {instructions && (
        <InstructionsDialog
          info={instructions}
          onDone={() => setInstructions(null)}
        />
      )}
    </PageShell>
  );
};
