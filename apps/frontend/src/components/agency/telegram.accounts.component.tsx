'use client';

import React, { FC, useState } from 'react';
import Link from 'next/link';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  useAgencyApi,
  useCan,
  useTelegramBots,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  AccountEvent,
  TelegramUserAccountView,
  useTelegramAccountEvents,
  useTelegramUserAccounts,
  useTelegramWorkerStatus,
} from '@gitroom/frontend/components/agency/telegram.users.hooks';
import {
  Btn,
  Card,
  CheckField,
  Dialog,
  EmptyState,
  formatDateTime,
  humanize,
  LoadError,
  Loading,
  Menu,
  MenuItem,
  Notice,
  PageHeader,
  PageShell,
  StatusBadge,
  TextField,
  timeAgo,
  useBusy,
  useTouched,
} from '@gitroom/frontend/components/agency/agency.ui';

const PERMISSIONS = [
  {
    key: 'canResearch',
    label: 'Look up public communities',
    hint: 'Search and read what Telegram shows publicly. On for every new account.',
  },
  {
    key: 'canJoin',
    label: 'Join and leave communities',
    hint: 'Only when a person chooses to, one community at a time, with a reason.',
  },
  {
    key: 'canPublish',
    label: 'Post advertisements',
    hint: 'Only in communities where a person recorded that advertising is allowed.',
  },
  {
    key: 'canManage',
    label: 'Create and manage communities',
    hint: 'Create groups and channels, read invite links, review join requests one by one.',
  },
] as const;

type PermissionKey = (typeof PERMISSIONS)[number]['key'];

// ---------------------------------------------------------------------------
// Sign in: phone → code → (password)
// ---------------------------------------------------------------------------
const ConnectDialog: FC<{
  onClose: () => void;
  onConnected: () => void;
}> = ({ onClose, onConnected }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const touched = useTouched();
  const { busy, run } = useBusy();
  const [step, setStep] = useState<'phone' | 'code' | 'password'>('phone');
  const [label, setLabel] = useState('');
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [phone, setPhone] = useState('');
  const [loginId, setLoginId] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');

  const errors = {
    apiId:
      /^\d{1,10}$/.test(apiId.trim()) && Number(apiId) > 0
        ? null
        : 'The api id is a number, from my.telegram.org.',
    apiHash: /^[0-9a-fA-F]{32}$/.test(apiHash.trim())
      ? null
      : 'The api hash is 32 letters and digits, from my.telegram.org.',
    phone: /^\+[1-9][\d\s()-]{6,18}$/.test(phone.trim())
      ? null
      : 'Enter the number with its country code, like +4915112345678.',
    code: /^\d{4,8}$/.test(code.replace(/\s/g, ''))
      ? null
      : 'Enter the digits Telegram sent.',
    password: password ? null : 'Enter the two-step verification password.',
  };

  const cancelLogin = async () => {
    if (loginId)
      await api
        .post('/agency/telegram/accounts/login/cancel', { loginId })
        .catch(() => undefined);
    onClose();
  };

  const start = async (e?: React.FormEvent) => {
    e?.preventDefault();
    touched.all(['apiId', 'apiHash', 'phone']);
    if (errors.apiId || errors.apiHash || errors.phone) return;
    await run(async () => {
      try {
        const res = await api.post<{ loginId: string }>(
          '/agency/telegram/accounts/login/start',
          {
            label: label.trim() || undefined,
            apiId: Number(apiId),
            apiHash: apiHash.trim(),
            phone: phone.trim(),
          }
        );
        setLoginId(res.loginId);
        // The hash is not needed in this screen any more.
        setApiHash('');
        setStep('code');
        touched.reset();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  const sendCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    touched.all(['code']);
    if (errors.code) return;
    await run(async () => {
      try {
        const res = await api.post<{ status: string }>(
          '/agency/telegram/accounts/login/code',
          { loginId, code: code.replace(/\s/g, '') }
        );
        if (res.status === 'password_required') {
          setStep('password');
          touched.reset();
          return;
        }
        toaster.show('Account connected.', 'success');
        onConnected();
        onClose();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  const sendPassword = async (e?: React.FormEvent) => {
    e?.preventDefault();
    touched.all(['password']);
    if (errors.password) return;
    await run(async () => {
      try {
        await api.post('/agency/telegram/accounts/login/password', {
          loginId,
          password,
        });
        toaster.show('Account connected.', 'success');
        onConnected();
        onClose();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  const footer = (primary: string) => (
    <>
      <Btn onClick={cancelLogin} disabled={busy}>
        Cancel
      </Btn>
      <Btn variant="primary" type="submit" busy={busy}>
        {primary}
      </Btn>
    </>
  );

  if (step === 'code') {
    return (
      <Dialog
        title="Enter the code"
        description="Telegram sent a login code to that account, usually inside the Telegram app."
        onClose={cancelLogin}
        busy={busy}
        onSubmit={sendCode}
        footer={footer('Continue')}
      >
        <TextField
          label="Code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onBlur={touched.blur('code')}
          error={touched.show('code', errors.code)}
          autoFocus
        />
      </Dialog>
    );
  }

  if (step === 'password') {
    return (
      <Dialog
        title="Two-step verification"
        description="This account asks for its extra password. It is sent to Telegram once and never kept."
        onClose={cancelLogin}
        busy={busy}
        onSubmit={sendPassword}
        footer={footer('Connect')}
      >
        <TextField
          label="Password"
          type="password"
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={touched.blur('password')}
          error={touched.show('password', errors.password)}
          autoFocus
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Connect a Telegram account"
      description="Sign in with a Telegram account that belongs to your agency and is allowed to be used for work."
      onClose={onClose}
      busy={busy}
      onSubmit={start}
      footer={footer('Send me the code')}
    >
      <div className="flex flex-col gap-4">
        <Notice>
          Get an api id and api hash for your agency at{' '}
          <a
            href="https://my.telegram.org"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[color:var(--ag-accent-text)] hover:underline"
          >
            my.telegram.org
          </a>{' '}
          (API development tools). AgencyOS keeps the login sealed on this
          computer. It never reads your chats or your contacts.
        </Notice>
        <TextField
          label="Name"
          optional
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Outreach account"
          autoFocus
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <TextField
            label="Api id"
            inputMode="numeric"
            value={apiId}
            onChange={(e) => setApiId(e.target.value)}
            onBlur={touched.blur('apiId')}
            error={touched.show('apiId', errors.apiId)}
          />
          <TextField
            label="Api hash"
            type="password"
            autoComplete="off"
            value={apiHash}
            onChange={(e) => setApiHash(e.target.value)}
            onBlur={touched.blur('apiHash')}
            error={touched.show('apiHash', errors.apiHash)}
          />
        </div>
        <TextField
          label="Phone number"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onBlur={touched.blur('phone')}
          error={touched.show('phone', errors.phone)}
          placeholder="+4915112345678"
          hint="Only used to ask Telegram for the code. AgencyOS keeps a masked version."
        />
      </div>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// What an account may do
// ---------------------------------------------------------------------------
const PermissionsDialog: FC<{
  account: TelegramUserAccountView;
  onClose: () => void;
  onSaved: () => void;
}> = ({ account, onClose, onSaved }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const [label, setLabel] = useState(account.label);
  const [perms, setPerms] = useState<Record<PermissionKey, boolean>>({
    ...account.permissions,
  });

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!label.trim()) return;
    await run(async () => {
      try {
        await api.put(`/agency/telegram/accounts/${account.id}`, {
          label: label.trim(),
          ...perms,
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
      title="What this account may do"
      description="Each permission is checked every time the account is used. Taking one away stops that use at once."
      onClose={onClose}
      busy={busy}
      onSubmit={save}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" type="submit" busy={busy}>
            Save
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField
          label="Name"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          error={label.trim() ? undefined : 'Give the account a name.'}
        />
        {PERMISSIONS.map((p) => (
          <div key={p.key}>
            <CheckField
              checked={perms[p.key]}
              onChange={(e) =>
                setPerms((cur) => ({ ...cur, [p.key]: e.target.checked }))
              }
            >
              {p.label}
            </CheckField>
            <p className="ml-7 text-xs text-textItemBlur">{p.hint}</p>
          </div>
        ))}
      </div>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
const ActivityDialog: FC<{
  account: TelegramUserAccountView;
  onClose: () => void;
}> = ({ account, onClose }) => {
  const events = useTelegramAccountEvents(account.id);
  return (
    <Dialog
      title="Activity"
      description={account.label}
      onClose={onClose}
      size="lg"
      footer={<Btn onClick={onClose}>Close</Btn>}
    >
      {!events.data ? (
        <Loading rows={3} />
      ) : events.data.length === 0 ? (
        <p className="text-[13px] text-textItemBlur">Nothing yet.</p>
      ) : (
        <ul className="flex flex-col">
          {events.data.map((e: AccountEvent) => (
            <li
              key={e.id}
              className="flex flex-wrap items-baseline justify-between gap-x-4 border-t first:border-t-0 border-[color:var(--ag-hairline)] py-2.5 text-[13px]"
            >
              <span className="text-newTextColor">
                <span className="font-medium">{humanize(e.kind)}</span>
                <span className="text-textItemBlur"> · {e.message}</span>
              </span>
              <span className="text-xs text-textItemBlur">
                {timeAgo(e.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// One account
// ---------------------------------------------------------------------------
const AccountRow: FC<{
  account: TelegramUserAccountView;
  canManage: boolean;
  onChanged: () => void;
  onSignInAgain: () => void;
}> = ({ account, canManage, onChanged, onSignInAgain }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const [permissions, setPermissions] = useState(false);
  const [activity, setActivity] = useState(false);
  const [busy, setBusy] = useState(false);

  const act = async (path: string, done?: string) => {
    setBusy(true);
    try {
      await api.post(`/agency/telegram/accounts/${account.id}/${path}`, {});
      if (done) toaster.show(done, 'success');
      onChanged();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    if (
      !(await deleteDialog(
        `Sign ${account.label} out? Telegram ends its login, AgencyOS forgets it, and chats that post through it stop. Nobody else is used in its place.`,
        'Sign out',
        undefined,
        undefined,
        true
      ))
    ) {
      return;
    }
    await act('logout', 'Signed out.');
  };

  const remove = async () => {
    if (
      !(await deleteDialog(
        `Remove ${account.label} from AgencyOS?`,
        'Remove account',
        undefined,
        undefined,
        true
      ))
    ) {
      return;
    }
    try {
      await api.del(`/agency/telegram/accounts/${account.id}`);
      onChanged();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  const menu: MenuItem[] = [
    { label: 'Activity', onClick: () => setActivity(true) },
  ];
  if (canManage) {
    menu.unshift(
      {
        label: 'Check now',
        onClick: () => void act('check', 'Checked.'),
        disabled: busy || account.status === 'LOGGED_OUT',
      },
      { label: 'What it may do…', onClick: () => setPermissions(true) }
    );
    if (account.status === 'PAUSED') {
      menu.push({ label: 'Resume', onClick: () => void act('resume') });
    } else if (
      ['ACTIVE', 'RATE_LIMITED', 'RESTRICTED'].includes(account.status)
    ) {
      menu.push({ label: 'Pause', onClick: () => void act('pause') });
    }
    if (account.status !== 'LOGGED_OUT') {
      menu.push({ label: 'Sign out', onClick: signOut, danger: true });
    } else {
      menu.push({ label: 'Remove', onClick: remove, danger: true });
    }
  }

  const granted = PERMISSIONS.filter((p) => account.permissions[p.key]);
  const problem =
    account.status === 'RATE_LIMITED' && account.rateLimitedUntil
      ? `Telegram asked this account to wait until ${formatDateTime(
          account.rateLimitedUntil
        )}.`
      : account.status === 'RESTRICTED'
      ? 'Telegram limited this account. It is not used until a person has looked into it, and nothing takes its place.'
      : account.status === 'SESSION_INVALID'
      ? 'Telegram ended this account’s login.'
      : account.status === 'LOGGED_OUT'
      ? 'Signed out. Connect it again to use it.'
      : account.status === 'PAUSED'
      ? 'Paused. Its queued posts wait until you resume it.'
      : null;

  return (
    <li className="flex flex-col gap-3 py-4 border-t first:border-t-0 border-[color:var(--ag-hairline)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold text-newTextColor">
              {account.label}
            </span>
            <StatusBadge
              status={account.status}
              label={account.status === 'ACTIVE' ? 'Connected' : undefined}
            />
          </div>
          <div className="mt-0.5 text-[13px] text-textItemBlur">
            {account.username ? `@${account.username} · ` : ''}
            {account.phoneMasked}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canManage && account.status === 'SESSION_INVALID' && (
            <Btn variant="primary" onClick={onSignInAgain}>
              Sign in again
            </Btn>
          )}
          <Menu items={menu} />
        </div>
      </div>
      {problem && <p className="text-[13px] text-textItemBlur">{problem}</p>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-textItemBlur">
        <span>
          May:{' '}
          {granted.map((p) => p.label.toLowerCase()).join(', ') || 'nothing'}
        </span>
        <span>
          {account.communityCount} communit
          {account.communityCount === 1 ? 'y' : 'ies'},{' '}
          {account.destinationCount} chat
          {account.destinationCount === 1 ? '' : 's'} posting
        </span>
        <span>
          Checked{' '}
          {account.lastCheckedAt ? timeAgo(account.lastCheckedAt) : 'never'}
        </span>
      </div>
      {account.lastError && account.status !== 'ACTIVE' && (
        <p className="text-xs text-textItemBlur">
          Last message from Telegram: {account.lastError}
        </p>
      )}
      {permissions && (
        <PermissionsDialog
          account={account}
          onClose={() => setPermissions(false)}
          onSaved={onChanged}
        />
      )}
      {activity && (
        <ActivityDialog account={account} onClose={() => setActivity(false)} />
      )}
    </li>
  );
};

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------
export const TelegramAccountsComponent: FC = () => {
  const { can } = useCan();
  const canManage = can('userAccount:manage');
  const [connecting, setConnecting] = useState(false);
  const worker = useTelegramWorkerStatus();
  const accounts = useTelegramUserAccounts();
  const bots = useTelegramBots();

  const refresh = () => {
    void accounts.mutate();
    void worker.mutate();
  };
  const ready = worker.data?.configured && worker.data.running;

  return (
    <PageShell>
      <PageHeader
        title="Telegram accounts"
        subtitle="The accounts and bots your agency works through, and how each one is doing."
        actions={
          canManage && (
            <Btn
              variant="primary"
              onClick={() => setConnecting(true)}
              disabled={!ready}
            >
              Connect an account
            </Btn>
          )
        }
      />

      {worker.data && !ready && (
        <Notice tone="warn">{worker.data.message}</Notice>
      )}

      <Card
        title="Accounts"
        subtitle="Signed in with a code Telegram sends. Each has its own permissions, and a limit or restriction pauses that account only."
      >
        {!accounts.data ? (
          accounts.error ? (
            <LoadError
              error={accounts.error}
              onRetry={() => accounts.mutate()}
            />
          ) : (
            <Loading rows={2} />
          )
        ) : accounts.data.length === 0 ? (
          <EmptyState
            icon="user"
            title="No account connected"
            hint="Connect an account to look up public communities, join the ones that fit and post where advertising is allowed. Your bots keep working as before."
            action={
              canManage && ready ? (
                <Btn variant="primary" onClick={() => setConnecting(true)}>
                  Connect an account
                </Btn>
              ) : undefined
            }
          />
        ) : (
          <ul>
            {accounts.data.map((a) => (
              <AccountRow
                key={a.id}
                account={a}
                canManage={canManage}
                onChanged={refresh}
                onSignInAgain={() => setConnecting(true)}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Bots"
        subtitle="Bots post in chats whose administrators authorized them."
        right={
          <Link
            href="/settings?tab=telegram"
            className="text-[13px] font-medium text-[color:var(--ag-accent-text)] hover:underline"
          >
            Manage bots
          </Link>
        }
      >
        {!bots.data ? (
          <Loading rows={1} />
        ) : bots.data.bots.length === 0 && !bots.data.server.configured ? (
          <p className="text-[13px] text-textItemBlur">No bot connected yet.</p>
        ) : (
          <ul className="flex flex-col">
            {bots.data.server.configured && (
              <li className="flex items-center justify-between gap-3 border-t first:border-t-0 border-[color:var(--ag-hairline)] py-2.5 text-[13px]">
                <span className="text-newTextColor">
                  {bots.data.server.label}
                </span>
                <StatusBadge status="ACTIVE" label="Server bot" />
              </li>
            )}
            {bots.data.bots.map((b) => (
              <li
                key={b.id}
                className="flex items-center justify-between gap-3 border-t first:border-t-0 border-[color:var(--ag-hairline)] py-2.5 text-[13px]"
              >
                <span className="text-newTextColor">
                  {b.label}{' '}
                  <span className="text-textItemBlur">@{b.username}</span>
                </span>
                <StatusBadge
                  status={b.status}
                  label={b.status === 'ACTIVE' ? 'Connected' : undefined}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="max-w-2xl text-xs leading-relaxed text-textItemBlur">
        AgencyOS does not create Telegram accounts, switch to another account
        when one is limited, or warm accounts up. A limit or restriction is
        shown here, the account is paused, and a person decides what happens
        next.
      </p>

      {connecting && (
        <ConnectDialog
          onClose={() => setConnecting(false)}
          onConnected={refresh}
        />
      )}
    </PageShell>
  );
};
