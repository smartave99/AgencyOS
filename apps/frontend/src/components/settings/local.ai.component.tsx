'use client';

import React, { FC, useState } from 'react';
import clsx from 'clsx';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  Btn,
  Card,
  Dialog,
  Loading,
  LoadError,
  Notice,
  TextField,
  useBusy,
} from '@gitroom/frontend/components/agency/agency.ui';
import {
  LocalAiModels,
  LocalModel,
  MODEL_NAME,
  SystemAi,
  systemRequest,
  useLocalModels,
} from '@gitroom/frontend/components/settings/system.hooks';

const gb = (n?: number | null) =>
  n == null
    ? ''
    : n < 0.1
    ? `${Math.max(1, Math.round(n * 1024))} MB`
    : `${n >= 10 ? Math.round(n) : n.toFixed(1)} GB`;
const bytesToGb = (n: number) => gb(n / 1073741824);

const ROLE = { copy: 'Ad copy', search: 'Search' } as const;

const Switch: FC<{
  on: boolean;
  label: string;
  busy?: boolean;
  onToggle: () => void;
}> = ({ on, label, busy, onToggle }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    disabled={busy}
    onClick={onToggle}
    className={clsx(
      'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
      on ? 'bg-[var(--ag-accent)]' : 'bg-[var(--ag-neutral-line)]'
    )}
  >
    <span
      className={clsx(
        'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
        on ? 'start-[22px]' : 'start-0.5'
      )}
    />
  </button>
);

const Progress: FC<{ fraction: number; label: string }> = ({
  fraction,
  label,
}) => {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full bg-[var(--ag-neutral-bg)]"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div
        className="h-full bg-[var(--ag-accent)] transition-[width]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// The engine (Ollama): install, start, stop
// ---------------------------------------------------------------------------
const EngineRow: FC<{
  data: LocalAiModels;
  ai: SystemAi;
  onChanged: () => void;
}> = ({ data, ai, onChanged }) => {
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const { engine, engineTask } = data;
  const working = engineTask?.state === 'working';

  const act = (action: 'install' | 'start' | 'stop') =>
    run(async () => {
      try {
        await systemRequest('POST', 'ai/engine', { action });
        onChanged();
      } catch (error) {
        toaster.show((error as Error).message, 'warning');
      }
    });

  const installing = ai.phase === 'installing-runtime' && ai.progress;
  const state = working
    ? engineTask?.message || 'Working…'
    : engine.running
    ? `Running${engine.version ? ` (Ollama ${engine.version})` : ''}${
        engine.external ? ', started outside AgencyOS' : ''
      }`
    : engine.installed
    ? 'Stopped'
    : 'Not installed';

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-[var(--ag-neutral-bg)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[14px] font-medium text-newTextColor">
            Engine
          </div>
          <div className="text-xs text-textItemBlur">{state}</div>
        </div>
        <div className="flex gap-2">
          {!engine.installed && !engine.running && (
            <Btn
              variant="primary"
              busy={busy || working}
              onClick={() => void act('install')}
            >
              Install and start
            </Btn>
          )}
          {engine.installed && !engine.running && (
            <Btn
              variant="primary"
              busy={busy || working}
              onClick={() => void act('start')}
            >
              Start
            </Btn>
          )}
          {engine.running && !engine.external && (
            <Btn busy={busy || working} onClick={() => void act('stop')}>
              Stop
            </Btn>
          )}
        </div>
      </div>
      {!engine.installed && !engine.running && !working && (
        <p className="text-xs text-textItemBlur">
          The engine (Ollama) runs models on this computer. It is about 1.4 GB,
          downloaded once, and can be stopped at any time.
        </p>
      )}
      {working && installing && (
        <Progress
          fraction={ai.progress!.fraction}
          label="Downloading the engine"
        />
      )}
      {engineTask?.state === 'failed' && engineTask.error && (
        <Notice tone="bad">{engineTask.error}</Notice>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// What is installed: try it, delete it
// ---------------------------------------------------------------------------
const ModelRow: FC<{ model: LocalModel; onChanged: () => void }> = ({
  model,
  onChanged,
}) => {
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const [result, setResult] = useState<string | null>(null);

  const tryIt = () =>
    run(async () => {
      setResult(null);
      try {
        const r = await systemRequest<{
          ok: boolean;
          kind?: string;
          sample?: string;
          tokensPerSecond?: number;
          seconds?: number;
          dimensions?: number;
          error?: string;
        }>('POST', 'ai/try', { model: model.name });
        setResult(
          r.ok
            ? r.kind === 'embedding'
              ? `Works: returned a ${r.dimensions}-number vector in ${r.seconds}s.`
              : `Works: “${r.sample || '…'}” at ${
                  r.tokensPerSecond
                } tokens/s (${r.seconds}s).`
            : `Did not answer: ${r.error}`
        );
      } catch (error) {
        setResult((error as Error).message);
      }
    });

  const remove = async () => {
    const used = model.roles.map((r) => ROLE[r].toLowerCase()).join(' and ');
    if (
      !(await deleteDialog(
        `Delete ${model.name} (${bytesToGb(model.sizeBytes)})? ${
          used
            ? `AgencyOS uses it for ${used}; until you download another, that falls back to templates and keyword search. `
            : ''
        }It frees the disk space and is not downloaded again unless you ask.`,
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
        await systemRequest('POST', 'ai/delete', { model: model.name });
        toaster.show(`Deleted ${model.name}`, 'success');
        onChanged();
      } catch (error) {
        toaster.show((error as Error).message, 'warning');
      }
    });
  };

  return (
    <li className="flex flex-col gap-1.5 border-t border-[color:var(--ag-hairline)] py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <span className="font-mono text-[13px] text-newTextColor">
            {model.name}
          </span>
          {model.roles.map((role) => (
            <span
              key={role}
              className="ms-2 rounded-full border border-[color:var(--ag-hairline)] px-2 py-0.5 text-[11px] text-textItemBlur"
            >
              {ROLE[role]}
            </span>
          ))}
          <div className="text-xs text-textItemBlur">
            {bytesToGb(model.sizeBytes)}
            {model.parameterSize ? ` · ${model.parameterSize}` : ''}
            {model.quantization ? ` · ${model.quantization}` : ''}
          </div>
        </div>
        <div className="flex gap-2">
          <Btn busy={busy} onClick={() => void tryIt()}>
            Try it
          </Btn>
          <Btn variant="danger" disabled={busy} onClick={() => void remove()}>
            Delete
          </Btn>
        </div>
      </div>
      {result && <p className="text-xs text-textItemBlur">{result}</p>}
    </li>
  );
};

// ---------------------------------------------------------------------------
// Download a model by name
// ---------------------------------------------------------------------------
const DownloadPanel: FC<{ data: LocalAiModels; onChanged: () => void }> = ({
  data,
  onChanged,
}) => {
  const toaster = useToaster();
  const { busy, run } = useBusy();
  const [name, setName] = useState('');
  const { download } = data;
  const active =
    download?.state === 'starting' || download?.state === 'downloading';
  const trimmed = name.trim();
  const nameError =
    trimmed && !MODEL_NAME.test(trimmed)
      ? 'Use a model name such as gemma3:4b.'
      : undefined;

  const start = (model: string) =>
    run(async () => {
      try {
        await systemRequest('POST', 'ai/pull', { model });
        setName('');
        onChanged();
      } catch (error) {
        toaster.show((error as Error).message, 'warning');
      }
    });

  const cancel = () =>
    run(async () => {
      try {
        await systemRequest('POST', 'ai/cancel', {});
        onChanged();
      } catch (error) {
        toaster.show((error as Error).message, 'warning');
      }
    });

  const installedNames = new Set(data.installed.map((m) => m.name));
  const offered = data.suggestions.filter(
    (s) => !installedNames.has(s.id) && !installedNames.has(`${s.id}:latest`)
  );

  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex items-end gap-2"
        onKeyDown={(e) => {
          if (
            e.key === 'Enter' &&
            trimmed &&
            !nameError &&
            !active &&
            (e.target as HTMLElement).tagName === 'INPUT'
          ) {
            e.preventDefault();
            void start(trimmed);
          }
        }}
      >
        <TextField
          label="Download a model"
          wrapperClassName="flex-1"
          spellCheck={false}
          autoComplete="off"
          placeholder="gemma3:4b"
          list="agencyos-model-suggestions"
          value={name}
          error={nameError}
          onChange={(e) => setName(e.target.value)}
        />
        <Btn
          variant="primary"
          busy={busy}
          disabled={!trimmed || !!nameError || active}
          onClick={() => void start(trimmed)}
        >
          Download
        </Btn>
        <datalist id="agencyos-model-suggestions">
          {offered.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
              {s.sizeGB ? ` · ${gb(s.sizeGB)}` : ''}
            </option>
          ))}
        </datalist>
      </div>

      {active && download && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span>
              Downloading <b className="font-mono">{download.model}</b>
            </span>
            <Btn onClick={() => void cancel()} disabled={busy}>
              Cancel
            </Btn>
          </div>
          <Progress
            fraction={download.fraction ?? 0}
            label={`Downloading ${download.model}`}
          />
          <p className="text-xs text-textItemBlur">
            {download.total
              ? `${bytesToGb(download.received ?? 0)} of ${bytesToGb(
                  download.total
                )}`
              : 'Starting…'}
            {download.bytesPerSecond
              ? ` · ${(download.bytesPerSecond / 1048576).toFixed(1)} MB/s`
              : ''}
          </p>
        </div>
      )}
      {download?.state === 'failed' && (
        <Notice tone="bad">
          The download of {download.model} stopped: {download.error}
        </Notice>
      )}
      {download?.state === 'cancelled' && (
        <p className="text-xs text-textItemBlur">
          The download of {download.model} was cancelled.
        </p>
      )}

      {offered.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {offered.slice(0, 8).map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={active || busy}
              onClick={() => setName(s.id)}
              className={clsx(
                'rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-50',
                s.recommended
                  ? 'border-[color:var(--ag-accent)] text-[color:var(--ag-accent-text)]'
                  : 'border-[color:var(--ag-hairline)] text-textItemBlur hover:text-newTextColor'
              )}
              title={s.label}
            >
              {s.recommended ? '★ ' : ''}
              {s.id}
              {s.sizeGB ? ` · ${gb(s.sizeGB)}` : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------
export const LocalAiCard: FC<{ ai: SystemAi }> = ({ ai }) => {
  const toaster = useToaster();
  const { data, error, mutate } = useLocalModels();
  const { busy, run } = useBusy();
  const [asking, setAsking] = useState(false);

  const setAuto = (enabled: boolean) =>
    run(async () => {
      try {
        await systemRequest('POST', 'ai/auto', { enabled });
        setAsking(false);
        await mutate();
      } catch (e) {
        toaster.show((e as Error).message, 'warning');
      }
    });

  const recommended = (data?.suggestions ?? []).filter((s) => s.recommended);
  const recommendedGb = recommended.reduce((n, s) => n + (s.sizeGB ?? 0), 0);

  return (
    <Card
      title="Local AI"
      subtitle="Optional. A model on this computer is private, free and works offline. By default AgencyOS uses the Antigravity CLI and downloads nothing."
      right={
        data && (
          <div className="flex items-center gap-2 text-xs text-textItemBlur">
            <span>Set up automatically</span>
            <Switch
              on={data.auto}
              label="Set up local AI automatically"
              busy={busy}
              onToggle={() =>
                data.auto ? void setAuto(false) : setAsking(true)
              }
            />
          </div>
        )
      }
    >
      {error && !data ? (
        <LoadError error={error} onRetry={() => mutate()} />
      ) : !data ? (
        <Loading rows={2} />
      ) : (
        <>
          {data.auto && ai.message && (
            <p className="text-[13px] text-textItemBlur">
              {ai.phase === 'ready'
                ? [
                    ai.models?.embedding && `Search: ${ai.models.embedding.id}`,
                    ai.models?.text &&
                      `Copy suggestions: ${ai.models.text.id}${
                        ai.models.text.tokensPerSecond
                          ? ` (${ai.models.text.tokensPerSecond} tokens/s)`
                          : ''
                      }`,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'Ready'
                : ai.message}
            </p>
          )}
          {data.auto && ai.phase === 'error' && (
            <div>
              <Btn
                onClick={() =>
                  void systemRequest('POST', 'ai/retry', {}).then(() =>
                    mutate()
                  )
                }
              >
                Try again
              </Btn>
            </div>
          )}

          <EngineRow data={data} ai={ai} onChanged={() => void mutate()} />

          <div>
            <div className="mb-1 text-[14px] font-medium text-newTextColor">
              Models on this computer
            </div>
            {data.installed.length === 0 ? (
              <p className="text-[13px] text-textItemBlur">
                {data.engine.running
                  ? 'None yet. Download one below.'
                  : 'Start the engine to see the models on this computer.'}
              </p>
            ) : (
              <ul className="flex flex-col">
                {data.installed.map((model) => (
                  <ModelRow
                    key={model.name}
                    model={model}
                    onChanged={() => void mutate()}
                  />
                ))}
              </ul>
            )}
            {data.listError && (
              <p className="mt-1 text-xs text-[color:var(--ag-bad-fg)]">
                {data.listError}
              </p>
            )}
          </div>

          <DownloadPanel data={data} onChanged={() => void mutate()} />

          <p className="select-text break-all text-xs text-textItemBlur">
            {data.freeDiskGB != null
              ? `${gb(data.freeDiskGB)} free on this drive. `
              : ''}
            Models are kept in {data.modelsDir}. Which model writes your ad copy
            is chosen in Settings → AI and Copilot.
          </p>
        </>
      )}

      {asking && (
        <Dialog
          title="Set up local AI automatically?"
          description={`AgencyOS will download the engine (about 1.4 GB) and the models it picks for this computer${
            recommendedGb ? ` (about ${gb(recommendedGb)} more)` : ''
          }, and start the engine whenever AgencyOS starts. You can turn this off or delete anything later.`}
          busy={busy}
          onClose={() => setAsking(false)}
          footer={
            <>
              <Btn onClick={() => setAsking(false)} disabled={busy}>
                Cancel
              </Btn>
              <Btn
                variant="primary"
                busy={busy}
                onClick={() => void setAuto(true)}
              >
                Download and set up
              </Btn>
            </>
          }
        >
          <p className="text-[13px] text-textItemBlur">
            Prefer to choose yourself? Cancel, then use “Install and start” and
            “Download a model” below: nothing downloads until you press a
            button.
          </p>
        </Dialog>
      )}
    </Card>
  );
};
