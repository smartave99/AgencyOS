'use client';

import React, { FC, useEffect, useState } from 'react';
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
  EmptyState,
  formatDateTime,
  humanize,
  inputClass,
  labelClass,
  LoadError,
  Loading,
  PageHeader,
  PageShell,
} from '@gitroom/frontend/components/agency/agency.ui';

const ROLES: Array<{ key: string; label: string; summary: string }> = [
  {
    key: 'AGENCY_OWNER',
    label: 'Owner',
    summary: 'Everything, including granting the Owner role.',
  },
  {
    key: 'AGENCY_ADMIN',
    label: 'Admin',
    summary: 'Everything except granting the Owner role.',
  },
  {
    key: 'SALES_MANAGER',
    label: 'Sales manager',
    summary: 'Clients, pipeline (all reps), billing, approvals and scheduling.',
  },
  {
    key: 'SALES_EXECUTIVE',
    label: 'Sales executive',
    summary: 'Own pipeline, clients and drafting campaigns. Cannot approve.',
  },
  {
    key: 'CAMPAIGN_MANAGER',
    label: 'Campaign manager',
    summary:
      'Approves, schedules and publishes campaigns; manages destinations.',
  },
  {
    key: 'CONTENT_EDITOR',
    label: 'Content editor',
    summary: 'Drafts and edits campaign content. Cannot approve or publish.',
  },
  {
    key: 'ANALYST',
    label: 'Analyst',
    summary: 'Read-only access to reports and the knowledge base.',
  },
  {
    key: 'CLIENT',
    label: 'Client',
    summary: 'Sees only their own portal and can approve their own ads.',
  },
];

const roleLabel = (key: string) =>
  ROLES.find((r) => r.key === key)?.label ?? humanize(key);

const RoleDialog: FC<{
  member: TeamMember;
  onClose: () => void;
  onSaved: () => void;
}> = ({ member, onClose, onSaved }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const clients = useClients();
  const [role, setRole] = useState(member.agencyRole);
  const [customerId, setCustomerId] = useState(member.customerId ?? '');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const clientError =
    role === 'CLIENT' && !customerId
      ? 'Choose which client this person represents.'
      : null;
  const unchanged =
    role === member.agencyRole &&
    (role !== 'CLIENT' || customerId === (member.customerId ?? ''));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
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
    setBusy(true);
    try {
      await api.put(`/agency/team/${member.userId}/role`, {
        role,
        customerId: role === 'CLIENT' ? customerId : undefined,
      });
      toaster.show(`${member.name || member.email} is now ${label}`, 'success');
      onSaved();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="role-title"
    >
      <form
        onSubmit={submit}
        className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-6 max-w-md w-full shadow-2xl flex flex-col gap-4"
      >
        <div>
          <h3 id="role-title" className="text-base font-bold text-newTextColor">
            Change role
          </h3>
          <p className="text-xs text-textItemBlur mt-1">
            {member.name || member.email}
          </p>
        </div>

        <div>
          <label htmlFor="role-select" className={labelClass}>
            Role
          </label>
          <select
            id="role-select"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className={inputClass}
          >
            {ROLES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-textItemBlur mt-1">
            {ROLES.find((r) => r.key === role)?.summary}
          </p>
        </div>

        {role === 'CLIENT' && (
          <div>
            <label htmlFor="role-client" className={labelClass}>
              Client
            </label>
            <select
              id="role-client"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              aria-invalid={touched && !!clientError}
              className={inputClass}
            >
              <option value="">Select…</option>
              {(clients.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.companyName || c.name}
                </option>
              ))}
            </select>
            {touched && clientError && (
              <p className="text-[11px] text-rose-400 mt-1">{clientError}</p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-3 border-t border-newBgLineColor">
          <Btn type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn type="submit" variant="primary" busy={busy} disabled={unchanged}>
            Change role
          </Btn>
        </div>
      </form>
    </div>
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
        crumb="Team"
        title="Team and roles"
        subtitle="Who can do what in AgencyOS. People are added to the workspace in Settings; here you decide their agency role."
      />

      {team.error ? (
        <LoadError error={team.error} onRetry={() => team.mutate()} />
      ) : !team.data ? (
        <Loading />
      ) : team.data.length === 0 ? (
        <div className="bg-newBgColorInner border border-newBgLineColor rounded-2xl">
          <EmptyState title="No team members" />
        </div>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-newBgLineColor text-[11px] uppercase text-textItemBlur">
                <tr>
                  <th className="py-2.5 px-3">Person</th>
                  <th className="py-2.5 px-3">Agency role</th>
                  <th className="py-2.5 px-3">How it was set</th>
                  <th className="py-2.5 px-3 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-newBgLineColor">
                {team.data.map((m) => (
                  <tr key={m.userId}>
                    <td className="py-3 px-3">
                      <div className="font-semibold text-newTextColor">
                        {m.name || m.email}
                        {m.userId === userId && (
                          <span className="ml-2 text-[11px] font-normal text-textItemBlur">
                            you
                          </span>
                        )}
                      </div>
                      {m.name && (
                        <div className="text-[11px] text-textItemBlur">
                          {m.email}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-3 text-newTextColor">
                      {roleLabel(m.agencyRole)}
                    </td>
                    <td className="py-3 px-3 text-textItemBlur">
                      {m.roleSource === 'ASSIGNED'
                        ? 'Assigned here'
                        : `Default from workspace role (${humanize(
                            m.workspaceRole
                          )})`}
                    </td>
                    <td className="py-3 px-3 text-right">
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

      <details className="bg-newBgColorInner border border-newBgLineColor rounded-2xl p-5">
        <summary className="text-sm font-bold text-newTextColor cursor-pointer">
          What each role can do
        </summary>
        <dl className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 text-xs">
          {ROLES.map((r) => (
            <div key={r.key}>
              <dt className="font-semibold text-newTextColor">{r.label}</dt>
              <dd className="text-textItemBlur">{r.summary}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[11px] text-textItemBlur mt-4">
          People who have no assigned role get a role from their workspace role:
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
            <Loading />
          ) : audit.data.length === 0 ? (
            <EmptyState title="Nothing recorded yet" />
          ) : (
            <ul className="flex flex-col divide-y divide-newBgLineColor">
              {audit.data.map((a) => (
                <li
                  key={a.id}
                  className="py-2.5 flex flex-wrap items-baseline justify-between gap-2"
                >
                  <div className="text-xs text-newTextColor">
                    <span className="font-semibold">
                      {humanize(a.action.replace('.', ' '))}
                    </span>
                    {a.summary && (
                      <span className="text-textItemBlur"> · {a.summary}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-textItemBlur">
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
