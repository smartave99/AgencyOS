'use client';

import React, { FC, useState } from 'react';
import { useToaster } from '@gitroom/react/toaster/toaster';
import {
  useAccounts,
  useAgencyApi,
  useCan,
  useCapabilities,
  useClients,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Card,
  Dialog,
  EmptyState,
  formatDate,
  humanize,
  LinkBtn,
  LoadError,
  Loading,
  Notice,
  PageHeader,
  PageShell,
  SelectField,
  StatusBadge,
  tableClass,
  useBusy,
  useTouched,
} from '@gitroom/frontend/components/agency/agency.ui';

const FORMATTING_LABEL: Record<string, string> = {
  MARKDOWN_HTML: 'HTML / Markdown',
  PLAIN_TEXT: 'Plain text',
  LIMITED: 'Limited',
};

const HEALTH_STATUS: Record<string, { status: string; label: string }> = {
  HEALTHY: { status: 'ACTIVE', label: 'Healthy' },
  NEEDS_REFRESH: { status: 'PENDING_VERIFICATION', label: 'Needs refresh' },
  EXPIRED: { status: 'EXPIRED', label: 'Expired' },
  DISABLED: { status: 'SUSPENDED', label: 'Disabled' },
};

const AssignDialog: FC<{
  account: any;
  onClose: () => void;
  onSaved: () => void;
}> = ({ account, onClose, onSaved }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const clients = useClients();
  const touched = useTouched();
  const { busy, run } = useBusy();
  const [customerId, setCustomerId] = useState<string>(
    account.client?.id ?? ''
  );
  const error = customerId ? undefined : 'Choose a client.';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    touched.all(['client']);
    if (error) return;
    await run(async () => {
      try {
        await api.post(`/agency/accounts/${account.id}/assign-client`, {
          customerId,
        });
        toaster.show('Account linked to client', 'success');
        onSaved();
      } catch (err) {
        toaster.show((err as Error).message, 'warning');
      }
    });
  };

  return (
    <Dialog
      size="sm"
      title="Assign to a client"
      description={`Choose the client that ${account.name} belongs to.`}
      onClose={onClose}
      busy={busy}
      onSubmit={submit}
      footer={
        <>
          <Btn onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn type="submit" variant="primary" busy={busy}>
            Save
          </Btn>
        </>
      }
    >
      <SelectField
        autoFocus
        label="Client"
        value={customerId}
        onChange={(e) => setCustomerId(e.target.value)}
        onBlur={touched.blur('client')}
        error={touched.show('client', error)}
      >
        <option value="">Select…</option>
        {(clients.data ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.companyName || c.name}
          </option>
        ))}
      </SelectField>
    </Dialog>
  );
};

export const AgencyAccountsComponent = () => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { can } = useCan();
  const accounts = useAccounts();
  const capabilities = useCapabilities();
  const [testing, setTesting] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<any | null>(null);

  const test = async (id: string) => {
    setTesting(id);
    try {
      const res = await api.post<{ healthy: boolean; message: string }>(
        `/agency/accounts/${id}/test-connection`
      );
      toaster.show(res.message, res.healthy ? 'success' : 'warning');
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    } finally {
      setTesting(null);
    }
  };

  return (
    <PageShell>
      <PageHeader
        title="Connected accounts"
        subtitle="Social accounts connected to this workspace and what each network supports."
        actions={
          <LinkBtn href="/agency/telegram" variant="primary">
            Telegram destinations
          </LinkBtn>
        }
      />

      <Notice tone="warn">
        Publishing from AgencyOS campaigns is Telegram only today. Accounts for
        other networks are shown so you can see their stored status and which
        client they belong to, but campaigns cannot publish to them yet.
      </Notice>

      <Card
        title="Accounts"
        subtitle="Status is read from stored data. A check does not contact the network."
      >
        {accounts.error ? (
          <LoadError error={accounts.error} onRetry={() => accounts.mutate()} />
        ) : !accounts.data ? (
          <Loading rows={3} />
        ) : accounts.data.length === 0 ? (
          <EmptyState
            icon="link"
            title="No social accounts connected"
            hint="Telegram destinations are managed on their own page. Other networks can be connected from the workspace settings."
          />
        ) : (
          <div className={tableClass.wrap}>
            <table className={tableClass.table}>
              <thead className={tableClass.head}>
                <tr>
                  <th className={tableClass.th}>Account</th>
                  <th className={tableClass.th}>Network</th>
                  <th className={tableClass.th}>Client</th>
                  <th className={tableClass.th}>Stored status</th>
                  <th className={tableClass.th}>Token expires</th>
                  <th className={tableClass.th}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {accounts.data.map((acc) => {
                  const health =
                    HEALTH_STATUS[acc.healthStatus] ?? HEALTH_STATUS.DISABLED;
                  return (
                    <tr key={acc.id} className={tableClass.row}>
                      <td
                        className={`${tableClass.td} font-semibold text-newTextColor`}
                      >
                        {acc.name}
                        {acc.profile && (
                          <span className="block text-xs font-normal text-textItemBlur">
                            @{acc.profile}
                          </span>
                        )}
                      </td>
                      <td className={`${tableClass.td} text-textItemBlur`}>
                        {humanize(acc.provider)}
                      </td>
                      <td className={tableClass.td}>
                        {acc.client ? (
                          <span className="text-newTextColor">
                            {acc.client.companyName || acc.client.name}
                          </span>
                        ) : (
                          <span className="text-textItemBlur italic">
                            Unassigned
                          </span>
                        )}
                      </td>
                      <td className={tableClass.td}>
                        <StatusBadge
                          status={health.status}
                          label={health.label}
                        />
                      </td>
                      <td className={`${tableClass.td} text-textItemBlur`}>
                        {acc.tokenExpiration
                          ? formatDate(acc.tokenExpiration)
                          : 'No expiry on record'}
                      </td>
                      <td className={`${tableClass.td} text-right`}>
                        <div className="flex justify-end gap-2">
                          <Btn
                            busy={testing === acc.id}
                            onClick={() => void test(acc.id)}
                          >
                            Check status
                          </Btn>
                          {can('accounts:manage') && (
                            <Btn onClick={() => setAssigning(acc)}>
                              Assign client
                            </Btn>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <section className="flex flex-col gap-4">
        <h2 className="text-[15px] font-semibold tracking-tight text-newTextColor">
          What each network supports
        </h2>
        {capabilities.error ? (
          <LoadError
            error={capabilities.error}
            onRetry={() => capabilities.mutate()}
          />
        ) : !capabilities.data ? (
          <Loading rows={2} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {capabilities.data.map((cap) => (
              <div
                key={cap.identifier}
                className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)] shadow-[var(--ag-shadow)] p-5 flex flex-col gap-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-[15px] font-semibold tracking-tight text-newTextColor">
                    {cap.name}
                  </h3>
                  {cap.identifier === 'telegram' ? (
                    <StatusBadge status="ACTIVE" label="Publishing supported" />
                  ) : (
                    <StatusBadge status="SKIPPED" label="Not publishable yet" />
                  )}
                </div>
                <p className="text-[13px] leading-relaxed text-textItemBlur">
                  {cap.description}
                </p>
                {cap.catalogued ? (
                  <dl className="text-[13px] grid grid-cols-2 gap-y-2 border-t border-[color:var(--ag-hairline)] pt-3">
                    <dt className="text-textItemBlur">Max text</dt>
                    <dd className="text-newTextColor text-right tabular-nums">
                      {cap.maxTextLength.toLocaleString()}
                    </dd>
                    <dt className="text-textItemBlur">Formatting</dt>
                    <dd className="text-newTextColor text-right">
                      {FORMATTING_LABEL[cap.supportsFormatting] ??
                        humanize(cap.supportsFormatting)}
                    </dd>
                    <dt className="text-textItemBlur">Media</dt>
                    <dd className="text-newTextColor text-right">
                      {[
                        cap.supportsImages && 'Images',
                        cap.supportsVideos && 'Video',
                      ]
                        .filter(Boolean)
                        .join(', ') || 'None'}
                    </dd>
                    <dt className="text-textItemBlur">Destinations</dt>
                    <dd className="text-newTextColor text-right">
                      {cap.destinationTypes.map(humanize).join(', ')}
                    </dd>
                    {cap.rateLimitPerMinute && (
                      <>
                        <dt className="text-textItemBlur">Guideline</dt>
                        <dd className="text-newTextColor text-right">
                          ~{cap.rateLimitPerMinute}/min per group
                        </dd>
                      </>
                    )}
                  </dl>
                ) : (
                  <p className="text-xs text-textItemBlur border-t border-[color:var(--ag-hairline)] pt-3">
                    No verified capability data recorded for this network.
                  </p>
                )}
                <p className="text-xs leading-relaxed text-textItemBlur">
                  <span className="font-medium text-newTextColor">
                    Compliance:{' '}
                  </span>
                  {cap.complianceNotes}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {assigning && (
        <AssignDialog
          account={assigning}
          onClose={() => setAssigning(null)}
          onSaved={() => {
            setAssigning(null);
            void accounts.mutate();
          }}
        />
      )}
    </PageShell>
  );
};
