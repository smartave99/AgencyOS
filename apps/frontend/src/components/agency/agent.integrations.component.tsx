'use client';

import React, { FC, useCallback, useState } from 'react';
import Link from 'next/link';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  useAgencyApi,
  useCan,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  AgentConfig,
  AgentProposalView,
  AgentScope,
  AgentTokenView,
  NewAgentToken,
  useAgentConfig,
  useAgentProposals,
  useAgentTokens,
} from '@gitroom/frontend/components/agency/agent.integrations.hooks';
import {
  Btn,
  Card,
  CheckField,
  Dialog,
  EmptyState,
  formatDate,
  humanize,
  LoadError,
  Loading,
  Notice,
  PageHeader,
  PageShell,
  Segmented,
  SelectField,
  StatusBadge,
  tableClass,
  TextArea,
  TextField,
  timeAgo,
  useBusy,
  useTouched,
} from '@gitroom/frontend/components/agency/agency.ui';

const BASE = '/agency/agent-integrations';

const SCOPE_LABEL: Record<AgentScope, string> = {
  READ: 'Read only',
  DRAFT: 'Read and draft',
};
const TOKEN_STATE_LABEL: Record<AgentTokenView['state'], string> = {
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  REVOKED: 'Revoked',
};
const SCOPE_HINT: Record<AgentScope, string> = {
  READ: 'Can look at your clients, campaigns, destinations, reports and the community directory. Cannot change anything.',
  DRAFT:
    'Can also prepare drafts. Each one waits for you to approve it here; nothing is sent and nothing changes before you do.',
};
const EXPIRY = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days (recommended)' },
  { value: '365', label: '1 year' },
  { value: '0', label: 'Never expires' },
];
const ARG_LABEL: Record<string, string> = {
  clientId: 'Client',
  companyName: 'Company',
  contentTitle: 'Title',
  contentBody: 'Ad text',
  ctaLink: 'Link',
  ctaText: 'Button text',
  destinationIds: 'Telegram destinations',
  id: 'Campaign',
};
const argLabel = (key: string) =>
  ARG_LABEL[key] ?? humanize(key.replace(/([A-Z])/g, '_$1'));
const argValue = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value);

const CAN = [
  'Look at your clients, campaigns, approvals, destinations, reports and sales pipeline',
  'Read the community directory (title, @username, member counts, labels, stage) and the health of your Telegram accounts (label, status, masked phone number)',
  'Suggest ad text',
  'With a draft token: propose a new client, a draft campaign, an edit to a draft, its destinations, or sending a draft to review. Every proposal waits for you.',
];
const CANNOT = [
  'Send, schedule, publish or approve anything',
  'Join or leave a community, or authorize a chat',
  'Connect, change or sign out Telegram accounts and bots',
  'Delete anything, change roles or settings',
  'Read passwords, tokens, sessions, client e-mail addresses or Telegram messages',
];

const useCopy = () => {
  const toaster = useToaster();
  return useCallback(
    async (text: string, done: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toaster.show(done, 'success');
      } catch {
        toaster.show(
          'Copying is not allowed here. Select the text instead.',
          'warning'
        );
      }
    },
    [toaster]
  );
};

// ---------------------------------------------------------------------------
// New token
// ---------------------------------------------------------------------------
const NewTokenDialog: FC<{
  onClose: () => void;
  onCreated: (token: NewAgentToken) => void;
}> = ({ onClose, onCreated }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const touched = useTouched();
  const { busy, run } = useBusy();
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<AgentScope>('READ');
  const [expiry, setExpiry] = useState('90');

  const errors = {
    label: !label.trim()
      ? 'Give the token a name, such as the program that will use it.'
      : label.trim().length > 60
      ? 'Use at most 60 characters.'
      : null,
  };

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    touched.all(['label']);
    if (errors.label) return;
    await run(async () => {
      try {
        const made = await api.post<NewAgentToken>(`${BASE}/tokens`, {
          label: label.trim(),
          scope,
          expiresInDays: Number(expiry),
        });
        onCreated(made);
        onClose();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  return (
    <Dialog
      title="New token"
      description="A token lets one program connect to AgencyOS. You can revoke it at any time."
      onClose={onClose}
      busy={busy}
      onSubmit={save}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" type="submit" busy={busy}>
            Create token
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField
          label="Name"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={touched.blur('label')}
          error={touched.show('label', errors.label)}
          placeholder="Antigravity"
          maxLength={60}
          autoFocus
        />
        <SelectField
          label="What it may do"
          value={scope}
          onChange={(e) => setScope(e.target.value as AgentScope)}
          hint={SCOPE_HINT[scope]}
        >
          <option value="READ">{SCOPE_LABEL.READ}</option>
          <option value="DRAFT">{SCOPE_LABEL.DRAFT}</option>
        </SelectField>
        <SelectField
          label="Stops working after"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          hint={
            expiry === '0'
              ? 'It works until you revoke it. Prefer an expiry: a forgotten token is a risk.'
              : undefined
          }
        >
          {EXPIRY.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
      </div>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// The token, shown once
// ---------------------------------------------------------------------------
const TokenShownDialog: FC<{
  made: NewAgentToken;
  config?: AgentConfig;
  onClose: () => void;
}> = ({ made, config, onClose }) => {
  const copy = useCopy();
  const [saved, setSaved] = useState(false);
  return (
    <Dialog
      title="Copy your token now"
      description="This is the only time it is shown. AgencyOS keeps a fingerprint of it, not the token, so it cannot show it again. If you lose it, revoke it and make a new one."
      size="lg"
      // The dialog stays open until the person says they have copied it.
      busy={!saved}
      onClose={onClose}
      footer={
        <Btn variant="primary" disabled={!saved} onClick={onClose}>
          Done
        </Btn>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField
          label={`Token for “${made.label}”`}
          value={made.token}
          readOnly
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono"
          autoFocus
        />
        <div className="flex flex-wrap gap-2">
          <Btn onClick={() => void copy(made.token, 'Token copied.')}>
            Copy token
          </Btn>
          {config && (
            <Btn
              onClick={() =>
                void copy(
                  config.configText.replace(config.placeholder, made.token),
                  'Configuration copied, with this token in it.'
                )
              }
            >
              Copy configuration with this token
            </Btn>
          )}
        </div>
        <CheckField
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        >
          I have copied the token and understand it cannot be shown again.
        </CheckField>
      </div>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
const TokensCard: FC<{ onNew: () => void }> = ({ onNew }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const tokens = useAgentTokens();
  const proposals = useAgentProposals();

  const revoke = async (token: AgentTokenView) => {
    if (
      !(await deleteDialog(
        `Revoke “${token.label}”? Anything using it stops working immediately, and proposals it made that are still waiting are withdrawn.`,
        'Revoke token',
        undefined,
        undefined,
        true
      ))
    ) {
      return;
    }
    try {
      await api.post(`${BASE}/tokens/${token.id}/revoke`);
      toaster.show('Token revoked.', 'success');
      void tokens.mutate();
      void proposals.mutate();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  return (
    <Card
      title="Tokens"
      subtitle="Each program you connect gets its own token, so you can switch one off without touching the others."
    >
      {tokens.error ? (
        <LoadError error={tokens.error} onRetry={() => tokens.mutate()} />
      ) : !tokens.data ? (
        <Loading rows={2} />
      ) : tokens.data.length === 0 ? (
        <EmptyState
          icon="cpu"
          title="No tokens yet"
          hint="Make a token for the program you want to connect. It is shown once, so you copy it straight away."
          action={
            <Btn variant="primary" onClick={onNew}>
              Make the first token
            </Btn>
          }
        />
      ) : (
        <div className={tableClass.wrap}>
          <table className={tableClass.table}>
            <thead className={tableClass.head}>
              <tr>
                <th className={tableClass.th}>Name</th>
                <th className={tableClass.th}>May</th>
                <th className={tableClass.th}>Status</th>
                <th className={tableClass.th}>Last used</th>
                <th className={tableClass.th}>Expires</th>
                <th className={tableClass.th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tokens.data.map((token) => (
                <tr key={token.id} className={tableClass.row}>
                  <td className={`${tableClass.td} font-medium`}>
                    {token.label}
                    <span className="block font-mono text-xs font-normal text-textItemBlur">
                      {token.preview}
                    </span>
                  </td>
                  <td className={tableClass.td}>
                    <StatusBadge
                      status={token.scope}
                      label={SCOPE_LABEL[token.scope]}
                    />
                  </td>
                  <td className={tableClass.td}>
                    <StatusBadge
                      status={token.state}
                      label={TOKEN_STATE_LABEL[token.state]}
                    />
                  </td>
                  <td className={`${tableClass.td} text-textItemBlur`}>
                    {token.lastUsedAt ? timeAgo(token.lastUsedAt) : 'Never'}
                  </td>
                  <td className={`${tableClass.td} text-textItemBlur`}>
                    {token.expiresAt ? formatDate(token.expiresAt) : 'Never'}
                  </td>
                  <td className={`${tableClass.td} text-right`}>
                    {token.state === 'ACTIVE' && (
                      <Btn
                        variant="danger"
                        aria-label={`Revoke ${token.label}`}
                        onClick={() => void revoke(token)}
                      >
                        Revoke
                      </Btn>
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

// ---------------------------------------------------------------------------
// Connecting a program
// ---------------------------------------------------------------------------
const ConnectCard: FC = () => {
  const config = useAgentConfig();
  const copy = useCopy();
  const data = config.data;
  return (
    <Card
      title="Connect your agent"
      subtitle="Paste this into the program’s MCP settings, then replace the placeholder with the token you copied."
    >
      {config.error ? (
        <LoadError error={config.error} onRetry={() => config.mutate()} />
      ) : !data ? (
        <Loading rows={2} />
      ) : (
        <div className="flex flex-col gap-4">
          <Notice tone="warn">
            The file name and layout below follow the common convention for MCP
            programs. They have <strong>not</strong> been checked against
            Antigravity’s own documentation or an installed Antigravity, so
            compare them with what your program expects. The{' '}
            <em>command and the two settings</em> are what matter.
          </Notice>
          {!data.serverFound && (
            <Notice tone="warn">
              AgencyOS could not find the MCP server file on this computer, so
              the path below is a guess. Check that{' '}
              <span className="font-mono break-all">{data.serverPath}</span>{' '}
              exists.
            </Notice>
          )}
          <div>
            <p className="mb-1.5 text-xs font-medium text-textItemBlur">
              Save as <span className="font-mono">{data.fileName}</span>
            </p>
            <pre
              tabIndex={0}
              aria-label="MCP configuration"
              className="max-w-full overflow-x-auto rounded-xl border border-[color:var(--ag-hairline)] bg-[var(--ag-neutral-bg)] p-4 font-mono text-xs leading-relaxed text-newTextColor"
            >
              {data.configText}
            </pre>
          </div>
          <div className="flex flex-wrap gap-2">
            <Btn
              onClick={() =>
                void copy(data.configText, 'Configuration copied.')
              }
            >
              Copy configuration
            </Btn>
          </div>
          <details className="group">
            <summary className="cursor-pointer text-[13px] font-medium text-[color:var(--ag-accent-text)]">
              Another program, or set it up by hand
            </summary>
            <div className="mt-3 flex flex-col gap-3 text-[13px] text-textItemBlur">
              <p>
                Any MCP client that can start a program and talk to it over
                standard input and output can use it. Run this command with the
                two settings in its environment:
              </p>
              <pre
                tabIndex={0}
                className="max-w-full overflow-x-auto rounded-xl border border-[color:var(--ag-hairline)] bg-[var(--ag-neutral-bg)] p-4 font-mono text-xs text-newTextColor"
              >
                {[
                  data.genericCommand,
                  ...Object.entries(data.environment).map(
                    ([name, value]) => `${name}=${value}`
                  ),
                ].join('\n')}
              </pre>
              <p>
                The program talks only to AgencyOS on this computer ({data.url}
                ). It has no tools of its own: it offers exactly what the token
                allows.
              </p>
            </div>
          </details>
        </div>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// What a proposal says it will do, and how it ended
// ---------------------------------------------------------------------------
const Outcome: FC<{ proposal: AgentProposalView }> = ({ proposal }) => {
  const { outcome } = proposal;
  if (proposal.status === 'PENDING') return null;
  if (proposal.status === 'APPROVED' && outcome?.ok) {
    const open = (outcome.result as { open?: string } | undefined)?.open;
    return (
      <p className="text-[13px] text-textItemBlur">
        Done, as you.{' '}
        {typeof open === 'string' && open.startsWith('/') && (
          <Link
            href={open}
            className="font-medium text-[color:var(--ag-accent-text)] hover:underline"
          >
            Open it
          </Link>
        )}
      </p>
    );
  }
  if (proposal.status === 'APPROVED') {
    return (
      <Notice tone="bad">
        You approved it, but it could not be applied
        {outcome?.error ? `: ${outcome.error}` : '.'} Nothing was changed. The
        agent can propose it again.
      </Notice>
    );
  }
  return (
    <p className="text-[13px] text-textItemBlur">
      {outcome?.error ?? humanize(proposal.status)}
    </p>
  );
};

const DeclineDialog: FC<{
  proposal: AgentProposalView;
  onClose: () => void;
  onDone: () => void;
}> = ({ proposal, onClose, onDone }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const [reason, setReason] = useState('');

  const decline = async (e?: React.FormEvent) => {
    e?.preventDefault();
    await run(async () => {
      try {
        await api.post(`${BASE}/proposals/${proposal.id}/decline`, {
          reason: reason.trim() || undefined,
        });
        toaster.show('Declined. Nothing was changed.', 'success');
        onDone();
        onClose();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  return (
    <Dialog
      title="Decline this proposal?"
      description={proposal.summary}
      onClose={onClose}
      busy={busy}
      onSubmit={decline}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Keep waiting
          </Btn>
          <Btn variant="danger" type="submit" busy={busy}>
            Decline
          </Btn>
        </>
      }
    >
      <TextArea
        label="Why"
        optional
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={300}
        hint="The agent can read this when it checks the proposal."
        autoFocus
      />
    </Dialog>
  );
};

const ProposalItem: FC<{
  proposal: AgentProposalView;
  onChanged: () => void;
}> = ({ proposal, onChanged }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const [declining, setDeclining] = useState(false);
  const waiting = proposal.status === 'PENDING';

  const approve = async () => {
    if (
      !(await deleteDialog(
        `${proposal.summary}. It runs now, as you, with your permissions. Nothing is sent: any campaign still needs the normal review before it can go out.`,
        'Approve',
        'Approve this change?',
        'Not yet'
      ))
    ) {
      return;
    }
    await run(async () => {
      try {
        const done = await api.post<AgentProposalView>(
          `${BASE}/proposals/${proposal.id}/approve`
        );
        if (done.outcome?.ok) toaster.show('Approved and done.', 'success');
        else
          toaster.show(
            `Approved, but it could not be applied: ${
              done.outcome?.error ?? 'unknown reason'
            }`,
            'warning'
          );
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      } finally {
        onChanged();
      }
    });
  };

  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-[color:var(--ag-hairline)] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold tracking-tight text-newTextColor break-words">
            {proposal.summary}
          </p>
          <p className="mt-0.5 text-xs text-textItemBlur">
            From “{proposal.from.label}” · {timeAgo(proposal.createdAt)}
            {waiting && ` · expires ${timeAgo(proposal.expiresAt)}`}
          </p>
        </div>
        <StatusBadge
          status={proposal.status}
          label={waiting ? 'Waiting for you' : undefined}
        />
      </div>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[10rem_1fr]">
        {Object.entries(proposal.args).map(([key, value]) => (
          <React.Fragment key={key}>
            <dt className="text-textItemBlur">{argLabel(key)}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words text-newTextColor">
              {argValue(value)}
            </dd>
          </React.Fragment>
        ))}
      </dl>

      {waiting ? (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Btn onClick={() => setDeclining(true)} disabled={busy}>
            Decline
          </Btn>
          <Btn variant="primary" busy={busy} onClick={() => void approve()}>
            Approve
          </Btn>
        </div>
      ) : (
        <Outcome proposal={proposal} />
      )}

      {declining && (
        <DeclineDialog
          proposal={proposal}
          onClose={() => setDeclining(false)}
          onDone={onChanged}
        />
      )}
    </li>
  );
};

const ProposalsCard: FC = () => {
  const proposals = useAgentProposals();
  const [show, setShow] = useState<'WAITING' | 'DECIDED'>('WAITING');
  const all = proposals.data ?? [];
  const waiting = all.filter((p) => p.status === 'PENDING');
  const decided = all.filter((p) => p.status !== 'PENDING');
  const shown = show === 'WAITING' ? waiting : decided;

  return (
    <Card
      title="Proposals"
      subtitle="Changes an agent asked for. Nothing happens until you approve it, and it runs as you."
      right={
        <Segmented
          ariaLabel="Proposals"
          value={show}
          onChange={setShow}
          options={[
            { value: 'WAITING', label: 'Waiting', count: waiting.length },
            { value: 'DECIDED', label: 'Decided', count: decided.length },
          ]}
        />
      }
    >
      {proposals.error ? (
        <LoadError error={proposals.error} onRetry={() => proposals.mutate()} />
      ) : !proposals.data ? (
        <Loading rows={2} />
      ) : shown.length === 0 ? (
        <EmptyState
          icon="inbox"
          title={
            show === 'WAITING' ? 'Nothing is waiting' : 'Nothing decided yet'
          }
          hint={
            show === 'WAITING'
              ? 'When an agent with a draft token proposes a change, it appears here for you to approve or decline.'
              : 'Approved, declined and expired proposals are kept here.'
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((proposal) => (
            <ProposalItem
              key={proposal.id}
              proposal={proposal}
              onChanged={() => void proposals.mutate()}
            />
          ))}
        </ul>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// What an agent can and cannot do
// ---------------------------------------------------------------------------
const AboutCard: FC = () => {
  const config = useAgentConfig();
  return (
    <Card
      title="What an agent can and cannot do"
      subtitle="AgencyOS works exactly the same when no agent is connected. An agent never runs on its own schedule: it acts only while a program you started is talking to it."
    >
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div>
          <h3 className="mb-2 text-[13px] font-semibold text-newTextColor">
            It can
          </h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-textItemBlur">
            {CAN.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mb-2 text-[13px] font-semibold text-newTextColor">
            It can never
          </h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-textItemBlur">
            {CANNOT.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="text-[13px] text-textItemBlur">
        There is no setting that gives an agent more than this. Text the agent
        reads in your workspace, such as an ad written by someone else, is data
        to it: it still cannot send or approve anything.
      </p>
      {config.data && (
        <details>
          <summary className="cursor-pointer text-[13px] font-medium text-[color:var(--ag-accent-text)]">
            Every tool an agent is offered ({config.data.tools.length})
          </summary>
          <ul className="mt-3 flex flex-col gap-2 text-[13px]">
            {config.data.tools.map((tool) => (
              <li
                key={tool.name}
                className="flex flex-col gap-0.5 sm:flex-row sm:gap-3"
              >
                <span className="shrink-0 font-mono text-xs text-newTextColor sm:w-56 break-all">
                  {tool.name}
                </span>
                <span className="text-textItemBlur">
                  {tool.scope === 'DRAFT' ? 'Draft: ' : ''}
                  {tool.description}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------
const Body: FC = () => {
  const proposals = useAgentProposals();
  const config = useAgentConfig();
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<NewAgentToken | null>(null);
  const tokens = useAgentTokens();
  const waiting = (proposals.data ?? []).filter(
    (p) => p.status === 'PENDING'
  ).length;

  return (
    <PageShell>
      <PageHeader
        title="Agent integrations"
        subtitle="Let an AI agent you trust look at your work and prepare drafts. It can never send, approve, schedule or delete anything: you stay in control."
        actions={
          <Btn
            variant={waiting ? 'secondary' : 'primary'}
            onClick={() => setCreating(true)}
          >
            New token
          </Btn>
        }
      />

      {waiting > 0 && (
        <Notice tone="info">
          {waiting === 1
            ? 'An agent has a proposal waiting for you.'
            : `An agent has ${waiting} proposals waiting for you.`}
        </Notice>
      )}

      {waiting > 0 && <ProposalsCard />}
      <TokensCard onNew={() => setCreating(true)} />
      <ConnectCard />
      {waiting === 0 && <ProposalsCard />}
      <AboutCard />

      {creating && (
        <NewTokenDialog
          onClose={() => setCreating(false)}
          onCreated={(token) => {
            setMade(token);
            void tokens.mutate();
          }}
        />
      )}
      {made && (
        <TokenShownDialog
          made={made}
          config={config.data}
          onClose={() => setMade(null)}
        />
      )}
    </PageShell>
  );
};

export const AgencyAgentIntegrationsComponent: FC = () => {
  const { can, isLoading } = useCan();
  if (isLoading) {
    return (
      <PageShell>
        <Loading rows={3} />
      </PageShell>
    );
  }
  if (!can('ai:configure')) {
    return (
      <PageShell>
        <PageHeader title="Agent integrations" />
        <Notice tone="warn">
          Only owners and admins can connect AI agents to AgencyOS.
        </Notice>
      </PageShell>
    );
  }
  return <Body />;
};
