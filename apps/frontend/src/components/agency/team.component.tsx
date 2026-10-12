'use client';

import React, { FC, useState } from 'react';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  TeamMember,
  useAgencyApi,
  useAuditLog,
  useCan,
  useClients,
  useTeam,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Card,
  Dialog,
  EmptyState,
  formatDateTime,
  humanize,
  Icon,
  LoadError,
  Loading,
  PageHeader,
  PageShell,
  prettySummary,
  ROLE_LABEL,
  roleLabel,
  SelectField,
  tableClass,
  useBusy,
  useTouched,
} from '@gitroom/frontend/components/agency/agency.ui';

const ROLES: Array<{ key: string; summary: string }> = [
  {
    key: 'AGENCY_OWNER',
    summary: 'Everything, including granting the Owner role.',
  },
  {
    key: 'AGENCY_ADMIN',
    summary: 'Everything except granting the Owner role.',
  },
  {
    key: 'SALES_MANAGER',
    summary: 'Clients, pipeline (all reps), billing, approvals and scheduling.',
  },
  {
    key: 'SALES_EXECUTIVE',
    summary: 'Own pipeline, clients and drafting campaigns. Cannot approve.',
  },
  {
    key: 'CAMPAIGN_MANAGER',
    summary:
      'Approves, schedules and publishes campaigns; manages destinations.',
  },
  {
    key: 'CONTENT_EDITOR',
    summary: 'Drafts and edits campaign content. Cannot approve or publish.',
  },
  {
    key: 'ANALYST',
    summary: 'Read-only access to reports and the knowledge base.',
  },
  {
    key: 'CLIENT',
    summary: 'Sees only their own portal and can approve their own ads.',
  },
];

const RoleDialog: FC<{
  member: TeamMember;
  onClose: () => void;
  onSaved: () => void;
}> = ({ member, onClose, onSaved }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const clients = useClients();
  const touched = useTouched();
  const { busy, run } = useBusy();
  const [role, setRole] = useState(member.agencyRole);
  const [customerId, setCustomerId] = useState(member.customerId ?? '');

  const clientError =
    role === 'CLIENT' && !customerId
      ? 'Choose which client this person represents.'
      : undefined;
  const unchanged =
    role === member.agencyRole &&
    (role !== 'CLIENT' || customerId === (member.customerId ?? ''));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    touched.all(['client']);
    if (clientError || unchanged) return;
    const label = roleLabel(role);
    if (
      !(await deleteDialog(
        `Change ${
          member.name || member.email
        } to ${label}? Their access changes immediately.`,
        'Change role',
        undefined,
        undefined,
        true
      ))
    )
      return;
    await run(async () => {
      try {
        await api.put(`/agency/team/${member.userId}/role`, {
          role,
          customerId: role === 'CLIENT' ? customerId : undefined,
        });
        toaster.show(
          `${member.name || member.email} is now ${label}`,
          'success'
        );
        onSaved();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  return (
    <Dialog
      size="sm"
      title="Change role"
      description={member.name || member.email}
      onClose={onClose}
      busy={busy}
      onSubmit={submit}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn type="submit" variant="primary" busy={busy} disabled={unchanged}>
            Change role
          </Btn>
        </>
      }
    >
      <SelectField
        autoFocus
        label="Role"
        value={role}
        onChange={(e) => setRole(e.target.value)}
        hint={ROLES.find((r) => r.key === role)?.summary}
      >
        {ROLES.map((r) => (
          <option key={r.key} value={r.key}>
            {roleLabel(r.key)}
          </option>
        ))}
      </SelectField>
      {role === 'CLIENT' && (
        <SelectField
          label="Client"
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          onBlur={touched.blur('client')}
          error={touched.show('client', clientError)}
        >
          <option value="">Select…</option>
          {(clients.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.companyName || c.name}
            </option>
          ))}
        </SelectField>
      )}
    </Dialog>
  );
};

export const AgencyTeamComponent = () => {
  const { can, userId } = useCan();
  const team = useTeam();
  const audit = useAuditLog(can('audit:read'));
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const canManage = can('team:manage');

  return (
    <PageShell>
      <PageHeader
        title="Team and roles"
        subtitle="Who can do what in AgencyOS. People are added to the workspace in Settings; here you decide their agency role."
      />

      {team.error ? (
        <LoadError error={team.error} onRetry={() => team.mutate()} />
      ) : !team.data ? (
        <Loading />
      ) : team.data.length === 0 ? (
        <div className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)]">
          <EmptyState icon="users" title="No team members" />
        </div>
      ) : (
        <Card>
          <div className={tableClass.wrap}>
            <table className={tableClass.table}>
              <thead className={tableClass.head}>
                <tr>
                  <th className={tableClass.th}>Person</th>
                  <th className={tableClass.th}>Agency role</th>
                  <th className={tableClass.th}>How it was set</th>
                  <th className={tableClass.th}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {team.data.map((m) => (
                  <tr key={m.userId} className={tableClass.row}>
                    <td className={tableClass.td}>
                      <div className="font-semibold text-newTextColor">
                        {m.name || m.email}
                        {m.userId === userId && (
                          <span className="ml-2 text-xs font-normal text-textItemBlur">
                            you
                          </span>
                        )}
                      </div>
                      {m.name && (
                        <div className="text-xs text-textItemBlur">
                          {m.email}
                        </div>
                      )}
                    </td>
                    <td className={`${tableClass.td} text-newTextColor`}>
                      {roleLabel(m.agencyRole)}
                    </td>
                    <td className={`${tableClass.td} text-textItemBlur`}>
                      {m.roleSource === 'ASSIGNED'
                        ? 'Assigned here'
                        : `Default from workspace role (${humanize(
                            m.workspaceRole
                          )})`}
                    </td>
                    <td className={`${tableClass.td} text-right`}>
                      {canManage && m.userId !== userId && (
                        <Btn onClick={() => setEditing(m)}>Change role</Btn>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <details className="group rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)] shadow-[var(--ag-shadow)] p-5 sm:p-6">
        <summary className="flex cursor-pointer list-none items-center justify-between text-[15px] font-semibold tracking-tight text-newTextColor">
          What each role can do
          <Icon
            name="chevron"
            size={16}
            className="text-textItemBlur transition-transform group-open:rotate-180"
          />
        </summary>
        <dl className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-4 text-[13px]">
          {ROLES.map((r) => (
            <div key={r.key}>
              <dt className="font-semibold text-newTextColor">
                {ROLE_LABEL[r.key]}
              </dt>
              <dd className="mt-0.5 text-textItemBlur">{r.summary}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-5 text-xs leading-relaxed text-textItemBlur">
          People who have no assigned role get one from their workspace role:
          workspace admins become Admin, everyone else Sales executive, who can
          never approve a campaign. Client users also remain workspace members,
          so only invite a client you are comfortable giving a workspace login.
        </p>
      </details>

      {can('audit:read') && (
        <Card
          title="Recent activity"
          subtitle="The last 50 recorded actions in this workspace."
        >
          {audit.error ? (
            <LoadError error={audit.error} onRetry={() => audit.mutate()} />
          ) : !audit.data ? (
            <Loading rows={3} />
          ) : audit.data.length === 0 ? (
            <EmptyState icon="doc" title="Nothing recorded yet" />
          ) : (
            <ul className="flex flex-col">
              {audit.data.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-t first:border-t-0 border-[color:var(--ag-hairline)] py-2.5 text-[13px]"
                >
                  <div className="text-newTextColor">
                    <span className="font-medium">
                      {humanize(a.action.replace('.', ' '))}
                    </span>
                    {a.summary && (
                      <span className="text-textItemBlur">
                        {' '}
                        · {prettySummary(a.summary)}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-textItemBlur">
                    {a.actorRole ? `${roleLabel(a.actorRole)} · ` : ''}
                    {formatDateTime(a.createdAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {editing && (
        <RoleDialog
          member={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void team.mutate();
          }}
        />
      )}
    </PageShell>
  );
};
