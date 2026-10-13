'use client';

import React, { FC, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  Btn,
  Card,
  CheckField,
  Dialog,
  Loading,
  LoadError,
  Notice,
  TextField,
  TONE_CLASS,
  Tone,
  useBusy,
} from '@gitroom/frontend/components/agency/agency.ui';
import {
  ServiceState,
  StoragePlan,
  StorageRequest,
  SystemAi,
  SystemService,
  SystemStorage,
  systemRequest,
  useSystemStatus,
} from '@gitroom/frontend/components/settings/system.hooks';

type Desktop = { pickFolder?: (current: string) => Promise<string | null> };
const desktop = () =>
  (window as unknown as { agencyos?: Desktop }).agencyos ?? {};

const bytes = (n?: number | null) => {
  if (!n) return '0 MB';
  return n > 1073741824
    ? `${(n / 1073741824).toFixed(1)} GB`
    : `${Math.round(n / 1048576)} MB`;
};

const SERVICE_STATE: Record<ServiceState, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting', tone: 'neutral' },
  starting: { label: 'Starting…', tone: 'info' },
  ready: { label: 'Running', tone: 'good' },
  restarting: { label: 'Restarting…', tone: 'info' },
  failed: { label: 'Needs attention', tone: 'bad' },
  done: { label: 'Done', tone: 'good' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  idle: { label: 'Not started', tone: 'neutral' },
};

const ServiceRow: FC<{ service: SystemService }> = ({ service }) => {
  const state = SERVICE_STATE[service.state] ?? SERVICE_STATE.idle;
  return (
    <li className="flex flex-col gap-1 py-3 border-t first:border-t-0 border-[color:var(--ag-hairline)]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[14px] text-newTextColor">
          {service.label}
          {!service.required && (
            <span className="text-textItemBlur"> · optional</span>
          )}
        </span>
        <span
          className={clsx(
            'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium',
            TONE_CLASS[state.tone]
          )}
        >
          {service.state === 'starting' && service.message
            ? service.message
            : state.label}
        </span>
      </div>
      {service.error && (
        <p className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-[color:var(--ag-bad-fg)]">
          {service.error}
        </p>
      )}
    </li>
  );
};

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
const StatusCard: FC<{
  services: SystemService[];
  attention: boolean;
}> = ({ services, attention }) => {
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const [restarting, setRestarting] = useState(false);

  // A restart stops the app's own server too: wait for it to answer again, then reload the page.
  useEffect(() => {
    if (!restarting) return;
    const timer = setInterval(async () => {
      try {
        const status = await systemRequest<{ ready: boolean }>('GET', 'status');
        if (status.ready) window.location.reload();
      } catch {
        /* the app server is still coming back */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [restarting]);

  const restart = async () => {
    if (
      !(await deleteDialog(
        'Restart everything? AgencyOS is unavailable for a minute. Scheduled campaigns are not lost.',
        'Yes, restart',
        undefined,
        undefined,
        true
      ))
    ) {
      return;
    }
    await run(async () => {
      try {
        await systemRequest('POST', 'restart', {});
        setRestarting(true);
      } catch (error) {
        toaster.show((error as Error).message, 'warning');
      }
    });
  };

  return (
    <Card
      title="What is running"
      subtitle="Everything AgencyOS needs runs on this computer."
      right={
        <Btn busy={busy || restarting} onClick={() => void restart()}>
          Restart everything
        </Btn>
      }
    >
      {restarting && (
        <Notice tone="info">
          Restarting. This page reloads by itself when AgencyOS is back.
        </Notice>
      )}
      {attention && !restarting && (
        <Notice tone="bad">
          Something did not start. The details are below; restarting tries
          again.
        </Notice>
      )}
      <ul className="-my-1.5 flex flex-col">
        {services.map((service) => (
          <ServiceRow key={service.name} service={service} />
        ))}
      </ul>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Local AI
// ---------------------------------------------------------------------------
const aiLine = (ai: SystemAi) => {
  if (ai.phase === 'ready') {
    const parts: string[] = [];
    if (ai.models?.embedding) parts.push(`Search: ${ai.models.embedding.id}`);
    if (ai.models?.text) {
      parts.push(
        `Copy suggestions: ${ai.models.text.id}${
          ai.models.text.tokensPerSecond
            ? ` (${ai.models.text.tokensPerSecond} tokens/s)`
            : ''
        }`
      );
    }
    return parts.length ? parts.join(' · ') : 'Ready';
  }
  if (ai.phase === 'off') return `Off. ${ai.message ?? ''}`.trim();
  return ai.message || 'Checking this computer…';
};

const LocalAiCard: FC<{ ai: SystemAi }> = ({ ai }) => {
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const progress = ai.progress;
  const downloading =
    !!progress && progress.fraction >= 0 && ai.phase !== 'ready';

  const retry = () =>
    run(async () => {
      try {
        await systemRequest('POST', 'ai/retry', {});
      } catch (error) {
        toaster.show((error as Error).message, 'warning');
      }
    });

  return (
    <Card
      title="Local AI"
      subtitle="The model on this computer that suggests ad copy and powers search. It works offline."
      right={
        ai.phase === 'error' ? (
          <Btn busy={busy} onClick={() => void retry()}>
            Try again
          </Btn>
        ) : undefined
      }
    >
      <p className="text-[14px] text-newTextColor">{aiLine(ai)}</p>
      {downloading && progress && (
        <div className="flex flex-col gap-1.5">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-[var(--ag-neutral-bg)]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(
              Math.max(0, Math.min(1, progress.fraction)) * 100
            )}
          >
            <div
              className="h-full bg-[var(--ag-accent)] transition-[width]"
              style={{
                width: `${Math.round(
                  Math.max(0, Math.min(1, progress.fraction)) * 100
                )}%`,
              }}
            />
          </div>
          <p className="text-xs text-textItemBlur">
            {bytes(progress.received)}
            {progress.total ? ` of ${bytes(progress.total)}` : ''}
            {progress.bytesPerSecond
              ? ` · ${(progress.bytesPerSecond / 1048576).toFixed(1)} MB/s`
              : ''}
          </p>
        </div>
      )}
      {!downloading && ai.tier && ai.label && (
        <p className="text-xs text-textItemBlur">Tier: {ai.label}</p>
      )}
      {!!ai.reasons?.length && (
        <ul className="ms-4 list-disc text-xs text-textItemBlur">
          {ai.reasons.slice(0, 4).map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Storage: where the data and the AI models live, and moving them safely
// ---------------------------------------------------------------------------
const FolderLine: FC<{ label: string; hint: string; folder: string }> = ({
  label,
  hint,
  folder,
}) => (
  <div className="flex flex-col gap-0.5">
    <div className="text-[14px] text-newTextColor">{label}</div>
    <div className="text-xs text-textItemBlur">{hint}</div>
    <div className="select-text break-all text-[13px]">{folder}</div>
  </div>
);

const FolderField: FC<{
  label: string;
  value: string;
  placeholder: string;
  error?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}> = ({ label, value, placeholder, error, disabled, onChange }) => {
  const canBrowse = typeof desktop().pickFolder === 'function';
  return (
    <div className="flex items-end gap-2">
      <TextField
        label={label}
        wrapperClassName="flex-1"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        error={error}
        onChange={(e) => onChange(e.target.value)}
      />
      {canBrowse && (
        <Btn
          disabled={disabled}
          onClick={async () => {
            const picked = await desktop().pickFolder?.(value);
            if (picked) onChange(picked);
          }}
        >
          Browse…
        </Btn>
      )}
    </div>
  );
};

/** What to ask the launcher for: only what differs from where things are now. */
const storageRequest = (
  storage: SystemStorage,
  data: string,
  keep: boolean,
  ai: string
): StorageRequest => {
  const out: StorageRequest = {};
  if (data.trim() && data.trim() !== storage.dataRoot) {
    out.dataRoot = data.trim();
  }
  if (keep) {
    if (storage.customAi) out.keepWithData = true;
  } else if (ai.trim() && ai.trim() !== storage.aiRoot) {
    out.aiRoot = ai.trim();
  }
  return out;
};

const MoveForm: FC<{
  storage: SystemStorage;
  onClose: () => void;
}> = ({ storage, onClose }) => {
  const toaster = useToaster();
  const [data, setData] = useState(storage.dataRoot);
  const [keep, setKeep] = useState(!storage.customAi);
  const [ai, setAi] = useState(storage.customAi ? storage.aiRoot : '');
  const [plan, setPlan] = useState<StoragePlan | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { busy, run } = useBusy();
  const sequence = useRef(0);

  // Every change is checked against the real disk before anything can be moved.
  useEffect(() => {
    const current = ++sequence.current;
    const asked = storageRequest(storage, data, keep, ai);
    if (!asked.dataRoot && !asked.aiRoot && !asked.keepWithData) {
      setPlan(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const checked = await systemRequest<StoragePlan>(
          'POST',
          'storage/check',
          asked
        );
        if (current === sequence.current) setPlan(checked);
      } catch (error) {
        if (current === sequence.current) {
          setPlan({
            ok: false,
            errors: { dataRoot: (error as Error).message },
          });
        }
      } finally {
        if (current === sequence.current) setChecking(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [storage, data, keep, ai]);

  const ready = !!plan && plan.ok && !!plan.changes && !checking;

  const move = () =>
    run(async () => {
      try {
        await systemRequest(
          'POST',
          'storage/move',
          storageRequest(storage, data, keep, ai)
        );
        setConfirming(false);
        onClose();
        toaster.show(
          'Moving. AgencyOS restarts by itself when the files are copied.',
          'success'
        );
      } catch (error) {
        setConfirming(false);
        toaster.show((error as Error).message, 'warning');
      }
    });

  return (
    <div className="flex flex-col gap-4 rounded-xl bg-[var(--ag-neutral-bg)] p-4">
      <FolderField
        label="Data folder"
        placeholder={'D:\\AgencyOS'}
        value={data}
        error={plan?.errors?.dataRoot}
        onChange={setData}
      />
      <CheckField checked={keep} onChange={(e) => setKeep(e.target.checked)}>
        Keep the AI models with my data
      </CheckField>
      {!keep && (
        <FolderField
          label="AI folder"
          placeholder={'E:\\AgencyOS-AI'}
          value={ai}
          error={plan?.errors?.aiRoot}
          onChange={setAi}
        />
      )}
      <p className="min-h-[18px] text-[13px] text-textItemBlur" role="status">
        {checking
          ? 'Checking…'
          : plan?.ok && plan.changes
          ? `Needs about ${bytes(plan.needBytes)} of free space${
              plan.freeBytes != null ? ` (${bytes(plan.freeBytes)} free)` : ''
            }. ${(plan.jobs ?? [])
              .map((job) => `${job.label}: ${bytes(job.bytes)}`)
              .join(' · ')}`
          : plan?.ok
          ? 'Those are the folders AgencyOS already uses.'
          : ''}
      </p>
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn
          variant="primary"
          disabled={!ready}
          onClick={() => setConfirming(true)}
        >
          Move…
        </Btn>
      </div>
      {confirming && plan && (
        <Dialog
          title="Move AgencyOS to its new location?"
          description="AgencyOS stops while the files are copied, then starts again by itself. Nothing is deleted from the old place; you can remove the old copy afterwards."
          busy={busy}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Btn onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Btn>
              <Btn variant="primary" busy={busy} onClick={() => void move()}>
                Move now
              </Btn>
            </>
          }
        >
          <ul className="flex flex-col gap-1 text-[13px]">
            {(plan.jobs ?? []).map((job) => (
              <li key={job.label}>
                <b>{job.label}</b> to{' '}
                <span className="break-all">{job.to}</span>
              </li>
            ))}
          </ul>
        </Dialog>
      )}
    </div>
  );
};

const StorageCard: FC<{ storage: SystemStorage }> = ({ storage }) => {
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const [moving, setMoving] = useState(false);

  const cleanup = async () => {
    if (
      !(await deleteDialog(
        'Delete the old copy? This frees the space but cannot be undone. AgencyOS is already running from the new location.',
        'Yes, delete it',
        undefined,
        undefined,
        true
      ))
    ) {
      return;
    }
    await run(async () => {
      try {
        await systemRequest('POST', 'storage/cleanup', {});
        toaster.show('The old copy was deleted', 'success');
      } catch (error) {
        toaster.show((error as Error).message, 'warning');
      }
    });
  };

  const failed = storage.move?.phase === 'failed';

  return (
    <Card
      title="Storage"
      subtitle="Where your files are kept. Files are copied and checked first, and nothing is deleted until you say so."
    >
      <FolderLine
        label="Your data"
        hint="Database, uploaded images and videos, and logs."
        folder={storage.dataRoot}
      />
      <FolderLine
        label="Local AI engine and models"
        hint="Downloaded once. Models can take several GB, so they can live on another drive."
        folder={
          storage.customAi
            ? storage.aiRoot
            : `With your data (${storage.aiRoot})`
        }
      />
      {failed && (
        <Notice tone="bad">
          The last move did not finish and nothing was changed.{' '}
          {storage.move?.message}
        </Notice>
      )}
      {storage.locked ? (
        <p className="text-xs text-textItemBlur">
          The location is fixed by the AGENCYOS_DATA setting on this computer.
        </p>
      ) : moving ? (
        <MoveForm storage={storage} onClose={() => setMoving(false)} />
      ) : (
        <div>
          <Btn onClick={() => setMoving(true)}>Change location…</Btn>
        </div>
      )}
      {storage.leftovers.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-[color:var(--ag-hairline)] pt-4">
          <p className="text-[13px] text-textItemBlur">
            The old copy is still on this computer, using space:
          </p>
          <ul className="select-text break-all text-[13px]">
            {storage.leftovers.map((left) => (
              <li key={left.path}>
                {left.path}
                {left.bytes ? ` (${bytes(left.bytes)})` : ''}
              </li>
            ))}
          </ul>
          <div>
            <Btn variant="danger" busy={busy} onClick={() => void cleanup()}>
              Delete the old copy…
            </Btn>
          </div>
        </div>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// This computer
// ---------------------------------------------------------------------------
const ComputerCard: FC<{ ai: SystemAi; dataDir: string; version: string }> = ({
  ai,
  dataDir,
  version,
}) => {
  const hw = ai.hardware;
  const line = hw
    ? [
        hw.os,
        hw.cpu,
        hw.threads ? `${hw.threads} threads` : '',
        hw.ramGB ? `${hw.ramGB} GB memory` : '',
        hw.gpu || 'no dedicated GPU',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  return (
    <Card title="This computer">
      {line && <p className="text-[13px] text-textItemBlur">{line}</p>}
      <p className="select-text break-all text-[13px] text-textItemBlur">
        Your data: {dataDir}
      </p>
      {version && (
        <p className="text-xs text-textItemBlur">AgencyOS {version}</p>
      )}
    </Card>
  );
};

export const SystemSettingsComponent: FC = () => {
  const { data, error, mutate } = useSystemStatus();

  return (
    <div className="ag-scope flex flex-col gap-6">
      <div>
        <h2 className="text-[20px] font-semibold tracking-tight">System</h2>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-textItemBlur">
          What is running on this computer, the local AI, and where your files
          are kept.
        </p>
      </div>
      {error && !data ? (
        <LoadError error={error} onRetry={() => mutate()} />
      ) : !data ? (
        <Loading rows={3} />
      ) : (
        <>
          <StatusCard services={data.services} attention={data.attention} />
          <LocalAiCard ai={data.ai ?? {}} />
          <StorageCard storage={data.storage} />
          <ComputerCard
            ai={data.ai ?? {}}
            dataDir={data.dataDir}
            version={data.version}
          />
        </>
      )}
    </div>
  );
};
