'use client';

import React, { FC, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  useAgencyApi,
  useCan,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  CommunityView,
  TelegramUserAccountView,
  useCommunity,
  useTelegramUserAccounts,
} from '@gitroom/frontend/components/agency/telegram.users.hooks';
import {
  members,
  stageLabel,
} from '@gitroom/frontend/components/agency/communities.component';
import {
  Btn,
  Card,
  CheckField,
  Dialog,
  formatDateTime,
  humanize,
  LoadError,
  Loading,
  Menu,
  Notice,
  PageHeader,
  PageShell,
  SelectField,
  StatusBadge,
  TextArea,
  TextField,
  timeAgo,
  useBusy,
} from '@gitroom/frontend/components/agency/agency.ui';

type Need = 'canResearch' | 'canJoin' | 'canPublish' | 'canManage';

/** The accounts that may do this right now: allowed, and in good standing. */
const useAccountsFor = (need: Need) => {
  const accounts = useTelegramUserAccounts();
  return (accounts.data ?? []).filter(
    (a: TelegramUserAccountView) => a.permissions[need] && a.status === 'ACTIVE'
  );
};

const AccountSelect: FC<{
  need: Need;
  value: string;
  onChange: (id: string) => void;
  preferred?: string | null;
  error?: string;
}> = ({ need, value, onChange, preferred, error }) => {
  const choices = useAccountsFor(need);
  const chosen =
    value ||
    (preferred && choices.some((c) => c.id === preferred)
      ? preferred
      : choices[0]?.id) ||
    '';
  React.useEffect(() => {
    if (chosen && chosen !== value) onChange(chosen);
  }, [chosen, value, onChange]);
  if (choices.length === 0) {
    return (
      <Notice tone="warn">
        No connected account is allowed to do this right now.{' '}
        <Link
          href="/agency/telegram/accounts"
          className="font-medium text-[color:var(--ag-accent-text)] hover:underline"
        >
          Telegram accounts
        </Link>
      </Notice>
    );
  }
  return (
    <SelectField
      label="Account"
      value={chosen}
      onChange={(e) => onChange(e.target.value)}
      error={error}
    >
      {choices.map((c) => (
        <option key={c.id} value={c.id}>
          {c.label}
          {c.username ? ` (@${c.username})` : ''}
        </option>
      ))}
    </SelectField>
  );
};

// ---------------------------------------------------------------------------
// The deliberate steps, each its own small dialog
// ---------------------------------------------------------------------------
const JoinDialog: FC<{
  community: CommunityView;
  onClose: () => void;
  onDone: () => void;
}> = ({ community, onClose, onDone }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const [accountId, setAccountId] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [tried, setTried] = useState(false);
  const problems = {
    reason:
      reason.trim().length >= 5
        ? null
        : 'Say why this community is worth joining (a few words).',
    confirmed: confirmed ? null : 'Tick the box to confirm.',
  };
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setTried(true);
    if (problems.reason || problems.confirmed || !accountId) return;
    await run(async () => {
      try {
        const res = await api.post<CommunityView>(
          `/agency/communities/${community.id}/join`,
          {
            accountId,
            reason: reason.trim(),
            confirmed,
          }
        );
        toaster.show(
          res.stage === 'JOIN_REQUEST_PENDING'
            ? 'Join request sent.'
            : 'Joined.',
          'success'
        );
        onDone();
        onClose();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };
  return (
    <Dialog
      title={`Join ${community.title}`}
      description="One account joins one community, because you decided it should. AgencyOS never joins a list of communities by itself."
      onClose={onClose}
      busy={busy}
      onSubmit={submit}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            type="submit"
            busy={busy}
            disabled={!accountId}
          >
            Join
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <AccountSelect
          need="canJoin"
          value={accountId}
          onChange={setAccountId}
        />
        <TextArea
          label="Why this community"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={tried ? problems.reason ?? undefined : undefined}
          hint="Kept in the community's history, with your name."
        />
        <div>
          <CheckField
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          >
            I am choosing to join this community with this account.
          </CheckField>
          {tried && problems.confirmed && (
            <p
              role="alert"
              className="ml-7 text-xs text-[color:var(--ag-bad-fg)]"
            >
              {problems.confirmed}
            </p>
          )}
        </div>
        {community.joinRequestRequired && (
          <p className="text-xs text-textItemBlur">
            This community asks its administrators. The account waits until they
            accept.
          </p>
        )}
      </div>
    </Dialog>
  );
};

const ReviewDialog: FC<{
  community: CommunityView;
  onClose: () => void;
  onDone: () => void;
}> = ({ community, onClose, onDone }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const [decision, setDecision] = useState<'ALLOWED' | 'NOT_ALLOWED'>(
    'ALLOWED'
  );
  const [note, setNote] = useState(community.adReviewNote ?? '');
  const [evidence, setEvidence] = useState(community.adReviewEvidenceUrl ?? '');
  const [rulesRead, setRulesRead] = useState(false);
  const [permitted, setPermitted] = useState(false);
  const [tried, setTried] = useState(false);
  const problems = {
    note:
      note.trim().length >= 10
        ? null
        : 'Write what the rules say about advertising (at least a sentence).',
    evidence:
      !evidence.trim() || /^https?:\/\//i.test(evidence.trim())
        ? null
        : 'The link must start with https://',
    checks:
      decision === 'ALLOWED' && !(rulesRead && permitted)
        ? 'Tick both boxes to allow advertising.'
        : null,
  };
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setTried(true);
    if (problems.note || problems.evidence || problems.checks) return;
    await run(async () => {
      try {
        await api.post(
          `/agency/communities/${community.id}/advertising-review`,
          {
            decision,
            note: note.trim(),
            evidenceUrl: evidence.trim() || undefined,
            rulesRead,
            advertisingPermitted: permitted,
          }
        );
        toaster.show('Review recorded.', 'success');
        onDone();
        onClose();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };
  return (
    <Dialog
      title="Advertising rules"
      description="Read the community's rules from inside it, and record what they say. Nothing is posted here until you have said advertising is allowed."
      onClose={onClose}
      busy={busy}
      onSubmit={submit}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" type="submit" busy={busy}>
            Record review
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <SelectField
          label="Do the rules allow advertising?"
          value={decision}
          onChange={(e) =>
            setDecision(e.target.value as 'ALLOWED' | 'NOT_ALLOWED')
          }
        >
          <option value="ALLOWED">Yes, advertising is allowed</option>
          <option value="NOT_ALLOWED">No, it is not allowed</option>
        </SelectField>
        <TextArea
          label="What the rules say"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          error={tried ? problems.note ?? undefined : undefined}
          placeholder="Pinned rules: one promotional post per week is fine, no links in the first line."
        />
        <TextField
          label="Link to the rules"
          optional
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          error={tried ? problems.evidence ?? undefined : undefined}
          placeholder="https://t.me/…"
        />
        {decision === 'ALLOWED' && (
          <div className="flex flex-col gap-2">
            <CheckField
              checked={rulesRead}
              onChange={(e) => setRulesRead(e.target.checked)}
            >
              I read this community's rules.
            </CheckField>
            <CheckField
              checked={permitted}
              onChange={(e) => setPermitted(e.target.checked)}
            >
              They allow advertising like ours.
            </CheckField>
            {tried && problems.checks && (
              <p role="alert" className="text-xs text-[color:var(--ag-bad-fg)]">
                {problems.checks}
              </p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
};

const AuthorizeDialog: FC<{
  community: CommunityView;
  onClose: () => void;
  onDone: () => void;
}> = ({ community, onClose, onDone }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const [accountId, setAccountId] = useState('');
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!accountId) return;
    await run(async () => {
      try {
        await api.post(`/agency/communities/${community.id}/authorize`, {
          accountId,
        });
        toaster.show('Campaigns can now post here.', 'success');
        onDone();
        onClose();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };
  return (
    <Dialog
      title="Allow campaigns to post here"
      description="The account has to be a member who is allowed to write. This holds for 90 days, then the rules are looked at again. Every post still needs an approved campaign."
      onClose={onClose}
      busy={busy}
      onSubmit={submit}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            type="submit"
            busy={busy}
            disabled={!accountId}
          >
            Allow posting
          </Btn>
        </>
      }
    >
      <AccountSelect
        need="canPublish"
        value={accountId}
        onChange={setAccountId}
        preferred={community.operatingAccountId}
      />
    </Dialog>
  );
};

/** A step that ends something: a reason, then the action. */
const ReasonDialog: FC<{
  title: string;
  description: string;
  button: string;
  needsAccount?: Need;
  community: CommunityView;
  path: string;
  danger?: boolean;
  onClose: () => void;
  onDone: () => void;
}> = ({
  title,
  description,
  button,
  needsAccount,
  community,
  path,
  danger,
  onClose,
  onDone,
}) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const [reason, setReason] = useState('');
  const [accountId, setAccountId] = useState(
    community.operatingAccountId ?? ''
  );
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    await run(async () => {
      try {
        await api.post(
          `/agency/communities/${community.id}/${path}`,
          needsAccount ? { accountId } : { reason: reason.trim() || undefined }
        );
        onDone();
        onClose();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };
  return (
    <Dialog
      title={title}
      description={description}
      onClose={onClose}
      busy={busy}
      onSubmit={submit}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn
            variant={danger ? 'danger' : 'primary'}
            type="submit"
            busy={busy}
          >
            {button}
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {needsAccount && (
          <AccountSelect
            need={needsAccount}
            value={accountId}
            onChange={setAccountId}
            preferred={community.operatingAccountId}
          />
        )}
        {!needsAccount && (
          <TextArea
            label="Reason"
            optional
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </div>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// Communities the agency runs
// ---------------------------------------------------------------------------
const Managed: FC<{ community: CommunityView; onChanged: () => void }> = ({
  community,
  onChanged,
}) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const [title, setTitle] = useState(community.title);
  const [about, setAbout] = useState(community.description ?? '');
  const [link, setLink] = useState<string | null>(null);
  const [requests, setRequests] = useState<Array<{
    userId: string;
    username?: string | null;
    date: string;
    bio?: string | null;
  }> | null>(null);
  const saving = useBusy();

  const save = async () => {
    await saving.run(async () => {
      try {
        await api.put(`/agency/communities/${community.id}/managed`, {
          title: title.trim(),
          about,
        });
        toaster.show('Saved on Telegram.', 'success');
        onChanged();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };
  const showLink = async () => {
    try {
      setLink(
        (
          await api.get<{ link: string }>(
            `/agency/communities/${community.id}/invite-link`
          )
        ).link
      );
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };
  const load = async () => {
    try {
      setRequests(
        (
          await api.get<{ requests: NonNullable<typeof requests> }>(
            `/agency/communities/${community.id}/join-requests`
          )
        ).requests
      );
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };
  const decide = async (userId: string, approve: boolean) => {
    try {
      await api.post(
        `/agency/communities/${community.id}/join-requests/decide`,
        { userId, approve }
      );
      setRequests((r) => (r ? r.filter((x) => x.userId !== userId) : r));
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };
  return (
    <Card
      title="Run this community"
      subtitle="You own or administer it. Changes are made on Telegram through the account that runs it."
    >
      <TextField
        label="Name"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <TextArea
        label="About"
        rows={3}
        value={about}
        onChange={(e) => setAbout(e.target.value)}
        maxLength={255}
      />
      <div className="flex flex-wrap gap-2">
        <Btn
          variant="primary"
          busy={saving.busy}
          disabled={!title.trim()}
          onClick={save}
        >
          Save on Telegram
        </Btn>
        <Btn onClick={showLink}>Show the invite link</Btn>
        <Btn onClick={load}>Show join requests</Btn>
      </div>
      {link && (
        <div className="flex flex-wrap items-center gap-3 text-[13px]">
          <code className="rounded-lg bg-[var(--ag-neutral-bg)] px-2 py-1 font-mono text-xs break-all">
            {link}
          </code>
          <Btn
            variant="ghost"
            onClick={() =>
              void navigator.clipboard
                .writeText(link)
                .then(() => toaster.show('Copied.', 'success'))
            }
          >
            Copy
          </Btn>
        </div>
      )}
      {requests && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-textItemBlur">
            What Telegram shows administrators about people who asked to join.
            It is not saved here, and each request is decided on its own.
          </p>
          {requests.length === 0 ? (
            <p className="text-[13px] text-textItemBlur">No one is waiting.</p>
          ) : (
            <ul>
              {requests.map((r) => (
                <li
                  key={r.userId}
                  className="flex flex-wrap items-center justify-between gap-3 border-t first:border-t-0 border-[color:var(--ag-hairline)] py-2.5 text-[13px]"
                >
                  <span className="text-newTextColor">
                    {r.username ? `@${r.username}` : `Person ${r.userId}`}
                    {r.bio ? (
                      <span className="text-textItemBlur"> · {r.bio}</span>
                    ) : null}
                  </span>
                  <span className="flex gap-2">
                    <Btn onClick={() => decide(r.userId, true)}>Approve</Btn>
                    <Btn
                      variant="ghost"
                      onClick={() => decide(r.userId, false)}
                    >
                      Decline
                    </Btn>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------
type Step =
  | null
  | 'join'
  | 'review'
  | 'authorize'
  | 'flag'
  | 'leave'
  | 'withdraw'
  | 'reopen'
  | 'ineligible';

export const CommunityDetailComponent: FC<{ id: string }> = ({ id }) => {
  const api = useAgencyApi();
  const router = useRouter();
  const toaster = useToaster();
  const { can } = useCan();
  const view = useCommunity(id);
  const [step, setStep] = useState<Step>(null);
  const [messages, setMessages] = useState<Array<{
    id: string;
    date: string;
    text: string;
  }> | null>(null);
  const [labels, setLabels] = useState<{
    tags: string;
    category: string;
    language: string;
    notes: string;
  } | null>(null);
  const readers = useAccountsFor('canResearch');
  const reading = useBusy();
  const saving = useBusy();

  if (!view.data) {
    return (
      <PageShell>
        <PageHeader
          title="Community"
          back={{ href: '/agency/communities', label: 'Communities' }}
        />
        {view.error ? (
          <LoadError error={view.error} onRetry={() => view.mutate()} />
        ) : (
          <Loading rows={4} />
        )}
      </PageShell>
    );
  }
  const { community: c, history } = view.data;
  const manage = can('community:manage');
  const edit = can('research:run');
  const form = labels ?? {
    tags: c.tags.join(', '),
    category: c.category ?? '',
    language: c.language ?? '',
    notes: c.notes ?? '',
  };
  const refresh = (): void => {
    void view.mutate();
  };

  const saveLabels = async () => {
    await saving.run(async () => {
      try {
        await api.put(`/agency/communities/${c.id}`, {
          tags: form.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          category: form.category,
          language: form.language,
          notes: form.notes,
        });
        setLabels(null);
        refresh();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  const readMessages = async () => {
    await reading.run(async () => {
      try {
        const res = await api.get<{
          messages: Array<{ id: string; date: string; text: string }>;
        }>(`/agency/communities/${c.id}/messages?accountId=${readers[0].id}`);
        setMessages(res.messages);
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  const remove = async () => {
    if (
      !(await deleteDialog(
        `Remove “${c.title}” from your directory? Its history goes with it.`,
        'Remove',
        undefined,
        undefined,
        true
      ))
    ) {
      return;
    }
    try {
      await api.del(`/agency/communities/${c.id}`);
      router.push('/agency/communities');
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  const checkMembership = async () => {
    try {
      await api.post(`/agency/communities/${c.id}/check-membership`, {});
      refresh();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  const next: Array<{
    text: string;
    actions: Array<{ label: string; run: () => void; primary?: boolean }>;
  }> = [];
  const stage = c.stage;
  if (stage === 'DISCOVERED' || stage === 'REVIEW_REQUIRED') {
    next.push({
      text:
        stage === 'DISCOVERED'
          ? 'Found, not yet looked at. Decide whether it is worth joining.'
          : 'Marked for a closer look before anything is done.',
      actions: [
        { label: 'Join…', run: () => setStep('join'), primary: true },
        ...(stage === 'DISCOVERED'
          ? [{ label: 'Mark for review', run: () => setStep('flag') }]
          : []),
        { label: 'Not eligible…', run: () => setStep('ineligible') },
      ],
    });
  } else if (stage === 'JOIN_REQUEST_PENDING') {
    next.push({
      text: 'The community’s administrators have to accept the request.',
      actions: [
        { label: 'Check if accepted', run: checkMembership, primary: true },
      ],
    });
  } else if (stage === 'JOINED') {
    next.push({
      text: 'Joined. Read the rules from inside, then record whether advertising is allowed.',
      actions: [
        {
          label: 'Record the advertising rules…',
          run: () => setStep('review'),
          primary: true,
        },
        { label: 'Leave…', run: () => setStep('leave') },
      ],
    });
  } else if (stage === 'ADVERTISING_ALLOWED') {
    next.push({
      text: 'Advertising is allowed here. Allow campaigns to post, through an account that is a member.',
      actions: [
        {
          label: 'Allow campaigns to post…',
          run: () => setStep('authorize'),
          primary: true,
        },
        { label: 'Change the review…', run: () => setStep('review') },
        { label: 'Leave…', run: () => setStep('leave') },
      ],
    });
  } else if (stage === 'PUBLISHING_AUTHORIZED') {
    next.push({
      text: 'Campaigns can post here. Posts still need an approved campaign.',
      actions: [
        { label: 'Stop posting here…', run: () => setStep('withdraw') },
        { label: 'Change the review…', run: () => setStep('review') },
        { label: 'Leave…', run: () => setStep('leave') },
      ],
    });
  } else {
    next.push({
      text: c.stageReason ?? 'Not in use.',
      actions: [
        {
          label: 'Reopen for review…',
          run: () => setStep('reopen'),
          primary: true,
        },
      ],
    });
  }

  const done = () => {
    setStep(null);
    refresh();
  };

  return (
    <PageShell>
      <PageHeader
        back={{ href: '/agency/communities', label: 'Communities' }}
        title={c.title}
        badge={<StatusBadge status={c.stage} label={stageLabel(c.stage)} />}
        subtitle={[
          c.username ? `@${c.username}` : 'No public name',
          c.kind ? humanize(c.kind) : null,
          `${members(c.memberCount)} members`,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          edit ? (
            <Menu
              items={[
                {
                  label: 'Remove from directory',
                  danger: true,
                  onClick: remove,
                },
              ]}
            />
          ) : undefined
        }
      />

      {(c.scam || c.fake) && (
        <Notice tone="bad">
          Telegram marks this community as {c.scam ? 'a scam' : 'fake'}. It
          cannot be approved for advertising.
        </Notice>
      )}
      {!c.available && (
        <Notice tone="warn">
          Telegram no longer shows this community publicly.
        </Notice>
      )}
      {(c.stage === 'BLOCKED' || c.stage === 'NOT_ELIGIBLE') &&
        c.stageReason && <Notice tone="warn">{c.stageReason}</Notice>}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 flex flex-col gap-6 min-w-0">
          <Card title="Next step">
            {next.map((n) => (
              <div key={n.text} className="flex flex-col gap-3">
                <p className="text-[13px] text-textItemBlur">{n.text}</p>
                {manage ? (
                  <div className="flex flex-wrap gap-2">
                    {n.actions.map((a) => (
                      <Btn
                        key={a.label}
                        variant={a.primary ? 'primary' : 'secondary'}
                        onClick={a.run}
                      >
                        {a.label}
                      </Btn>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-textItemBlur">
                    Your role can look at this community but not change where it
                    is.
                  </p>
                )}
              </div>
            ))}
          </Card>

          {manage &&
            ['OWNED', 'ADMINISTERED'].includes(c.relation) &&
            c.operatingAccountId && (
              <Managed community={c} onChanged={refresh} />
            )}

          <Card
            title="Recent public messages"
            subtitle="Read on screen when you ask. Not saved, and never sent to any AI model."
          >
            {messages === null ? (
              <div>
                <Btn
                  onClick={readMessages}
                  busy={reading.busy}
                  disabled={!edit || readers.length === 0 || !c.username}
                >
                  Read the latest
                </Btn>
                {!c.username && (
                  <p className="mt-2 text-xs text-textItemBlur">
                    Only communities with a public name can be read.
                  </p>
                )}
              </div>
            ) : messages.length === 0 ? (
              <p className="text-[13px] text-textItemBlur">
                Telegram shows no public messages.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {messages.map((m) => (
                  <li
                    key={m.id}
                    className="rounded-xl bg-[var(--ag-neutral-bg)] p-3 text-[13px]"
                  >
                    <div className="mb-1 text-xs text-textItemBlur">
                      {formatDateTime(m.date)}
                    </div>
                    <p className="whitespace-pre-wrap break-words text-newTextColor">
                      {m.text}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="History">
            <ol className="flex flex-col gap-4">
              {history.map((h) => (
                <li
                  key={h.id}
                  className="flex flex-col gap-1 border-l-2 border-[color:var(--ag-hairline)] pl-4 text-[13px]"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-newTextColor">
                      {humanize(h.kind)}
                    </span>
                    {h.toStage && (
                      <StatusBadge
                        status={h.toStage}
                        label={stageLabel(h.toStage)}
                      />
                    )}
                    <span className="text-xs text-textItemBlur">
                      {timeAgo(h.createdAt)}
                    </span>
                  </div>
                  <p className="text-textItemBlur">{h.summary}</p>
                  {h.changes && (
                    <ul className="text-xs text-textItemBlur">
                      {Object.entries(h.changes).map(([field, [from, to]]) => (
                        <li key={field}>
                          {humanize(field)}: {String(from ?? 'not shown')} →{' '}
                          {String(to ?? 'not shown')}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="lg:col-span-5 flex flex-col gap-6 min-w-0">
          <Card title="What Telegram shows">
            <dl className="grid grid-cols-2 gap-y-3 text-[13px]">
              <dt className="text-textItemBlur">Members</dt>
              <dd className="text-right text-newTextColor tabular-nums">
                {members(c.memberCount)}
              </dd>
              <dt className="text-textItemBlur">Join requests</dt>
              <dd className="text-right text-newTextColor">
                {c.joinRequestRequired ? 'Needed' : 'Not needed'}
              </dd>
              <dt className="text-textItemBlur">Slow mode</dt>
              <dd className="text-right text-newTextColor">
                {c.slowModeSeconds ? `${c.slowModeSeconds} s` : 'Off'}
              </dd>
              <dt className="text-textItemBlur">Verified</dt>
              <dd className="text-right text-newTextColor">
                {c.verified ? 'Yes' : 'No'}
              </dd>
              <dt className="text-textItemBlur">Your account</dt>
              <dd className="text-right text-newTextColor">
                {c.operatingAccount ? c.operatingAccount.label : '—'}
                {c.operatingAccount
                  ? ` (${humanize(c.relation).toLowerCase()})`
                  : ''}
              </dd>
              <dt className="text-textItemBlur">Looked at</dt>
              <dd className="text-right text-newTextColor">
                {c.lastRefreshedAt ? timeAgo(c.lastRefreshedAt) : 'Never'}
              </dd>
            </dl>
            {c.description && (
              <p className="whitespace-pre-wrap border-t border-[color:var(--ag-hairline)] pt-4 text-[13px] text-textItemBlur">
                {c.description}
              </p>
            )}
          </Card>

          {c.adReview !== 'NOT_REVIEWED' && (
            <Card title="Advertising review">
              <div className="flex items-center gap-2">
                <StatusBadge
                  status={c.adReview === 'ALLOWED' ? 'ACTIVE' : 'REVOKED'}
                  label={c.adReview === 'ALLOWED' ? 'Allowed' : 'Not allowed'}
                />
                <span className="text-xs text-textItemBlur">
                  {c.adReviewedAt ? formatDateTime(c.adReviewedAt) : ''}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-[13px] text-textItemBlur">
                {c.adReviewNote}
              </p>
              {c.adReviewEvidenceUrl && (
                <a
                  href={c.adReviewEvidenceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[13px] font-medium text-[color:var(--ag-accent-text)] hover:underline"
                >
                  The rules ↗
                </a>
              )}
            </Card>
          )}

          <Card title="Your labels">
            <TextField
              label="Tags"
              optional
              value={form.tags}
              onChange={(e) => setLabels({ ...form, tags: e.target.value })}
              hint="Separated by commas"
              disabled={!edit}
            />
            <div className="grid grid-cols-2 gap-4">
              <TextField
                label="Category"
                optional
                value={form.category}
                onChange={(e) =>
                  setLabels({ ...form, category: e.target.value })
                }
                disabled={!edit}
              />
              <TextField
                label="Language"
                optional
                value={form.language}
                onChange={(e) =>
                  setLabels({ ...form, language: e.target.value })
                }
                disabled={!edit}
              />
            </div>
            <TextArea
              label="Notes"
              optional
              rows={3}
              value={form.notes}
              onChange={(e) => setLabels({ ...form, notes: e.target.value })}
              disabled={!edit}
              maxLength={2000}
            />
            {edit && labels && (
              <div>
                <Btn variant="primary" busy={saving.busy} onClick={saveLabels}>
                  Save labels
                </Btn>
              </div>
            )}
          </Card>
        </div>
      </div>

      {step === 'join' && (
        <JoinDialog community={c} onClose={() => setStep(null)} onDone={done} />
      )}
      {step === 'review' && (
        <ReviewDialog
          community={c}
          onClose={() => setStep(null)}
          onDone={done}
        />
      )}
      {step === 'authorize' && (
        <AuthorizeDialog
          community={c}
          onClose={() => setStep(null)}
          onDone={done}
        />
      )}
      {step === 'flag' && (
        <ReasonDialog
          title="Mark for review"
          description="It stays in the directory and is not joined."
          button="Mark for review"
          community={c}
          path="flag"
          onClose={() => setStep(null)}
          onDone={done}
        />
      )}
      {step === 'leave' && (
        <ReasonDialog
          title="Leave this community"
          description="The account leaves on Telegram, the advertising review ends, and chats that post here stop."
          button="Leave"
          needsAccount="canJoin"
          danger
          community={c}
          path="leave"
          onClose={() => setStep(null)}
          onDone={done}
        />
      )}
      {step === 'withdraw' && (
        <ReasonDialog
          title="Stop posting here"
          description="Campaigns stop posting in this community. Posts already queued here pause."
          button="Stop posting"
          danger
          community={c}
          path="withdraw"
          onClose={() => setStep(null)}
          onDone={done}
        />
      )}
      {step === 'reopen' && (
        <ReasonDialog
          title="Reopen for review"
          description="Takes it back to review so it can be looked at again."
          button="Reopen"
          community={c}
          path="reopen"
          onClose={() => setStep(null)}
          onDone={done}
        />
      )}
      {step === 'ineligible' && (
        <ReasonDialog
          title="Not eligible"
          description="Marks the community as one you will not join or post in."
          button="Mark not eligible"
          danger
          community={c}
          path="not-eligible"
          onClose={() => setStep(null)}
          onDone={done}
        />
      )}
    </PageShell>
  );
};
