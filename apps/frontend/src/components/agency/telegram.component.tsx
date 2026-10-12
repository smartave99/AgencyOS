'use client';

import React, { FC, useState } from 'react';
import Link from 'next/link';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  DestinationView,
  PostingJob,
  useAgencyApi,
  useCan,
  usePublishingEvents,
  usePublishingQueue,
  useTelegramDestinations,
} from './agency.hooks';
import {
  Btn,
  Card,
  EmptyState,
  inputClass,
  labelClass,
  Loading,
  LoadError,
  PageHeader,
  PageShell,
  StatusBadge,
  formatDate,
  formatDateTime,
  timeAgo,
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
        : 'Code expired. Issue a new one.';
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

const CopyButton: FC<{ text: string; label: string }> = ({ text, label }) => {
  const toaster = useToaster();
  return (
    <Btn
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toaster.show('Copied', 'success');
        } catch {
          toaster.show(
            'Copy failed. Select the text and copy it manually.',
            'warning'
          );
        }
      }}
    >
      {label}
    </Btn>
  );
};

const InstructionsCard: FC<{ info: Instructions; onDone: () => void }> = ({
  info,
  onDone,
}) => (
  <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4 flex flex-col gap-3">
    <div>
      <div className="text-xs font-bold text-newTextColor">
        Almost there: ask a group admin to authorize {info.title}
      </div>
      <p className="text-[11px] text-textItemBlur mt-0.5">
        This is shown once. You can issue a new code any time.
      </p>
    </div>
    <ol className="list-decimal pl-4 text-xs text-newTextColor flex flex-col gap-1.5">
      {info.steps.map((s) => (
        <li key={s}>{s}</li>
      ))}
    </ol>
    <div className="flex items-center gap-2">
      <code className="flex-1 rounded-lg bg-newBgColor border border-newBgLineColor px-3 py-2 text-xs font-mono text-newTextColor select-all">
        /authorize {info.verificationCode}
      </code>
      <CopyButton text={`/authorize ${info.verificationCode}`} label="Copy" />
    </div>
    <div className="flex justify-end">
      <Btn variant="ghost" onClick={onDone}>
        I’ve sent it
      </Btn>
    </div>
  </div>
);

const RegisterPanel: FC<{ onRegistered: () => void }> = ({ onRegistered }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const [chatRef, setChatRef] = useState('');
  const [owner, setOwner] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [instructions, setInstructions] = useState<Instructions | null>(null);
  const [busy, setBusy] = useState<'check' | 'register' | null>(null);

  const trimmed = chatRef.trim();
  const refError =
    trimmed && !CHAT_REF.test(trimmed)
      ? 'Use the numeric chat ID (like -1001234567890) or the public @username.'
      : null;

  const check = async () => {
    setBusy('check');
    setPreview(null);
    try {
      setPreview(
        await api.post<Preview>('/agency/telegram/verify', { chatId: trimmed })
      );
    } catch (e: any) {
      toaster.show(e.message, 'warning');
    } finally {
      setBusy(null);
    }
  };

  const register = async () => {
    setBusy('register');
    try {
      const res = await api.post<{
        destination: DestinationView;
        verificationCode: string;
        botUsername: string | null;
        steps: string[];
      }>('/agency/telegram/destinations', {
        chatId: trimmed,
        ownerName: owner.trim() || undefined,
      });
      setInstructions({
        verificationCode: res.verificationCode,
        botUsername: res.botUsername,
        steps: res.steps,
        title: res.destination.title,
      });
      setChatRef('');
      setOwner('');
      setPreview(null);
      onRegistered();
    } catch (e: any) {
      toaster.show(e.message, 'warning');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="Connect a group or channel"
      subtitle="Ads are only ever sent to chats whose administrators have authorized you."
    >
      {instructions ? (
        <InstructionsCard
          info={instructions}
          onDone={() => setInstructions(null)}
        />
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!refError && trimmed) void register();
          }}
        >
          <div>
            <label htmlFor="chat-ref" className={labelClass}>
              Chat ID or public @username
            </label>
            <input
              id="chat-ref"
              className={inputClass + ' font-mono'}
              placeholder="@yourchannel or -1001234567890"
              value={chatRef}
              onChange={(e) => {
                setChatRef(e.target.value);
                setPreview(null);
              }}
              aria-invalid={!!refError}
            />
            {refError && (
              <p className="text-[11px] text-rose-400 mt-1">{refError}</p>
            )}
          </div>
          <div>
            <label htmlFor="owner" className={labelClass}>
              Who owns this chat? (optional)
            </label>
            <input
              id="owner"
              className={inputClass}
              placeholder="e.g. Fruit Lovers community, Priya"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            />
          </div>

          {preview && (
            <div className="rounded-xl bg-newBgColor border border-newBgLineColor p-3 text-xs flex flex-col gap-1.5">
              {preview.valid ? (
                <>
                  <div className="font-semibold text-newTextColor">
                    {preview.title}{' '}
                    <span className="text-textItemBlur font-normal">
                      ({preview.type})
                    </span>
                  </div>
                  <div
                    className={
                      preview.botIsAdmin ? 'text-emerald-400' : 'text-amber-400'
                    }
                  >
                    {preview.botIsAdmin
                      ? 'The bot is an administrator here.'
                      : 'The bot is not an administrator yet. Add it as one before authorizing.'}
                  </div>
                  <div
                    className={
                      preview.canPostMessages
                        ? 'text-emerald-400'
                        : 'text-amber-400'
                    }
                  >
                    {preview.canPostMessages
                      ? 'It can post messages.'
                      : 'It cannot post messages yet.'}
                  </div>
                </>
              ) : (
                <div className="text-amber-400">{preview.error}</div>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Btn
              type="button"
              disabled={!trimmed || !!refError}
              busy={busy === 'check'}
              onClick={check}
            >
              Check chat
            </Btn>
            <Btn
              type="submit"
              variant="primary"
              disabled={!trimmed || !!refError}
              busy={busy === 'register'}
            >
              Get authorization code
            </Btn>
          </div>
        </form>
      )}
    </Card>
  );
};

const DestinationRow: FC<{
  d: DestinationView;
  canManage: boolean;
  onChanged: () => void;
  onInstructions: (i: Instructions) => void;
}> = ({ d, canManage, onChanged, onInstructions }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toaster.show(done, 'success');
      onChanged();
    } catch (e: any) {
      toaster.show(e.message, 'warning');
    } finally {
      setBusy(false);
    }
  };

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
  return (
    <tr className="hover:bg-newBgColor/40 transition-colors align-top">
      <td className="py-3 px-3">
        <div className="font-semibold text-newTextColor">{d.title}</div>
        <div className="font-mono text-[11px] text-textItemBlur">
          {d.chatId}
        </div>
      </td>
      <td className="py-3 px-3">
        <StatusBadge status={status} />
        <div className="text-[11px] text-textItemBlur mt-1 max-w-xs">
          {statusDetail(d)}
        </div>
        {d.lastError && status === 'ACTIVE' && (
          <div className="text-[11px] text-amber-400 mt-1 max-w-xs">
            Last problem: {d.lastError}
          </div>
        )}
      </td>
      <td className="py-3 px-3 text-textItemBlur">
        {d.lastSuccessfulPostAt
          ? timeAgo(d.lastSuccessfulPostAt)
          : 'No posts yet'}
        <div className="text-[11px]">
          {d._count.campaignDestinations} campaign(s)
        </div>
      </td>
      <td className="py-3 px-3">
        {canManage && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {status === 'ACTIVE' && (
              <>
                <Btn
                  busy={busy}
                  onClick={() =>
                    run(async () => {
                      await api.post(
                        `/agency/telegram/destinations/${d.id}/refresh`
                      );
                    }, 'Checked just now')
                  }
                >
                  Check health
                </Btn>
                <Btn
                  busy={busy}
                  onClick={() =>
                    confirmThen(
                      `Pause posting to "${d.title}"? Queued posts wait until you resume.`,
                      'Yes, pause it',
                      async () => {
                        await api.post(
                          `/agency/telegram/destinations/${d.id}/suspend`,
                          {}
                        );
                      },
                      'Destination paused'
                    )
                  }
                >
                  Pause
                </Btn>
                <Btn
                  variant="danger"
                  busy={busy}
                  onClick={() =>
                    confirmThen(
                      `Revoke authorization for "${d.title}"? Queued posts are blocked and a group admin must authorize again.`,
                      'Yes, revoke',
                      async () => {
                        await api.post(
                          `/agency/telegram/destinations/${d.id}/revoke`,
                          {}
                        );
                      },
                      'Authorization revoked'
                    )
                  }
                >
                  Revoke
                </Btn>
              </>
            )}
            {status === 'SUSPENDED' && (
              <Btn
                variant="primary"
                busy={busy}
                onClick={() =>
                  run(async () => {
                    await api.post(
                      `/agency/telegram/destinations/${d.id}/resume`
                    );
                  }, 'Destination resumed')
                }
              >
                Resume
              </Btn>
            )}
            {(status === 'PENDING_VERIFICATION' ||
              status === 'REVOKED' ||
              status === 'EXPIRED' ||
              status === 'DISCONNECTED') && (
              <Btn variant="primary" busy={busy} onClick={newCode}>
                {status === 'PENDING_VERIFICATION'
                  ? 'New code'
                  : 'Re-authorize'}
              </Btn>
            )}
            <Btn
              variant="ghost"
              busy={busy}
              onClick={() =>
                confirmThen(
                  `Remove "${d.title}" from your registry? Its history stays in your reports.`,
                  'Yes, remove it',
                  async () => {
                    await api.del(`/agency/telegram/destinations/${d.id}`);
                  },
                  'Destination removed'
                )
              }
            >
              Remove
            </Btn>
          </div>
        )}
      </td>
    </tr>
  );
};

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
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Filter queue"
      >
        <button
          onClick={() => setFilter('')}
          className={
            'px-2.5 py-1 rounded-lg text-[11px] font-semibold border ' +
            (filter === ''
              ? 'bg-blue-600 text-white border-blue-600'
              : 'border-newBgLineColor text-textItemBlur hover:text-newTextColor')
          }
        >
          All
        </button>
        {QUEUE_CHIPS.map((chip) => (
          <button
            key={chip.status}
            onClick={() => setFilter(chip.status)}
            className={
              'px-2.5 py-1 rounded-lg text-[11px] font-semibold border ' +
              (filter === chip.status
                ? 'bg-blue-600 text-white border-blue-600'
                : 'border-newBgLineColor text-textItemBlur hover:text-newTextColor')
            }
          >
            {chip.label} · {data?.counts?.[chip.status] ?? 0}
          </button>
        ))}
      </div>
      {error ? (
        <LoadError error={error} onRetry={() => mutate()} />
      ) : !data ? (
        <Loading />
      ) : data.jobs.length === 0 ? (
        <EmptyState
          title="Nothing in the queue"
          hint="Scheduled and published campaigns show up here."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-textItemBlur font-medium border-b border-newBgLineColor">
              <tr>
                <th className="py-2 px-3">Campaign</th>
                <th className="py-2 px-3">Destination</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3">Attempts</th>
                <th className="py-2 px-3">Next / finished</th>
                <th className="py-2 px-3">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-newBgLineColor/50">
              {data.jobs.map((j) => (
                <tr key={j.id}>
                  <td className="py-2.5 px-3">
                    <Link
                      href={`/agency/campaigns/${j.campaign?.id}`}
                      className="text-newTextColor hover:text-blue-400 font-medium"
                    >
                      {j.campaign?.name}
                    </Link>
                  </td>
                  <td className="py-2.5 px-3 text-textItemBlur">
                    {j.telegramDestination?.title ?? '—'}
                  </td>
                  <td className="py-2.5 px-3">
                    <StatusBadge status={j.status} />
                  </td>
                  <td className="py-2.5 px-3 text-textItemBlur">
                    {j.attempts}/{j.maxAttempts}
                  </td>
                  <td className="py-2.5 px-3 text-textItemBlur">
                    {j.status === 'PENDING'
                      ? timeAgo(j.nextAttemptAt)
                      : timeAgo(j.completedAt)}
                  </td>
                  <td className="py-2.5 px-3 text-textItemBlur max-w-xs">
                    {j.releaseUrl ? (
                      <a
                        href={j.releaseUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-400 hover:underline"
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
      {!data || data.length === 0 ? (
        <EmptyState title="No delivery attempts yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-textItemBlur font-medium border-b border-newBgLineColor">
              <tr>
                <th className="py-2 px-3">When</th>
                <th className="py-2 px-3">Campaign</th>
                <th className="py-2 px-3">Destination</th>
                <th className="py-2 px-3">Message ID</th>
                <th className="py-2 px-3">Result</th>
                <th className="py-2 px-3">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-newBgLineColor/50">
              {data.map((evt) => (
                <tr key={evt.id}>
                  <td className="py-2.5 px-3 text-textItemBlur">
                    {formatDateTime(evt.executedAt)}
                  </td>
                  <td className="py-2.5 px-3 text-newTextColor font-medium">
                    {evt.campaign?.name}
                  </td>
                  <td className="py-2.5 px-3 text-textItemBlur">
                    {evt.telegramDestination?.title ?? '—'}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-[11px] text-textItemBlur">
                    {evt.externalMessageId || '—'}
                  </td>
                  <td className="py-2.5 px-3">
                    <StatusBadge status={evt.status} />
                  </td>
                  <td className="py-2.5 px-3 text-textItemBlur max-w-xs">
                    {evt.releaseUrl ? (
                      <a
                        href={evt.releaseUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-400 hover:underline"
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
  const canManage = can('destination:manage');

  return (
    <PageShell>
      <PageHeader
        crumb="Telegram"
        title="Telegram destinations"
        subtitle="A chat can receive your ads only after one of its administrators authorizes it, and they can withdraw that at any time."
      />
      <SystemBanner />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {canManage && (
          <div className="lg:col-span-5 flex flex-col gap-4">
            <RegisterPanel onRegistered={() => mutate()} />
            {instructions && (
              <InstructionsCard
                info={instructions}
                onDone={() => setInstructions(null)}
              />
            )}
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
              title="No destinations yet"
              hint={
                canManage
                  ? 'Connect your first group or channel on the left.'
                  : 'A campaign manager can connect a group or channel here.'
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-textItemBlur font-medium border-b border-newBgLineColor">
                  <tr>
                    <th className="py-2 px-3">Chat</th>
                    <th className="py-2 px-3">Authorization</th>
                    <th className="py-2 px-3">Last post</th>
                    <th className="py-2 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-newBgLineColor/50">
                  {destinations.map((d) => (
                    <DestinationRow
                      key={d.id}
                      d={d}
                      canManage={canManage}
                      onChanged={() => mutate()}
                      onInstructions={setInstructions}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <QueuePanel />
      <ReceiptsPanel />
    </PageShell>
  );
};
