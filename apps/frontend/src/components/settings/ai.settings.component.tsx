'use client';

import React, { FC, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { useToaster } from '@gitroom/react/toaster/toaster';
import {
  AiProviderId,
  AiModels,
  AiProviderView,
  AiSettings,
  AiTask,
  AiTestResult,
  AiToolView,
  AiTools,
  ThinkingLevel,
  useAgencyApi,
  useAiModels,
  useAiSettings,
  useAiStatus,
  useAiTools,
  useCan,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Card,
  Icon,
  IconName,
  Loading,
  LoadError,
  Notice,
  Segmented,
  SelectField,
  TextField,
  TONE_CLASS,
  timeAgo,
  useBusy,
} from '@gitroom/frontend/components/agency/agency.ui';

const KIND: Record<AiProviderView['kind'], { label: string; icon: IconName }> =
  {
    local: { label: 'On this computer', icon: 'cpu' },
    cli: { label: 'Command-line tool', icon: 'terminal' },
    api: { label: 'API', icon: 'globe' },
  };

const THINKING_LABEL: Record<ThinkingLevel, string> = {
  auto: 'Auto',
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

const THINKING_HELP: Record<ThinkingLevel, string> = {
  auto: 'The provider decides. Ad copy and chat run without extra reasoning to stay fast.',
  off: 'No extra reasoning. The quickest and cheapest answers.',
  low: 'A little reasoning before answering.',
  medium: 'Balanced: noticeably more careful, a bit slower.',
  high: 'Careful reasoning for hard questions. Slower, and costs more on an API.',
  xhigh: 'Even more reasoning than High, for the hardest questions.',
  max: 'The most reasoning the provider allows. Slowest and the most expensive.',
};

type Edit = { model?: string; baseUrl?: string; apiKey?: string };

const ProviderCard: FC<{
  provider: AiProviderView;
  selected: boolean;
  active: boolean;
  statusText?: string;
  ready?: boolean;
  onSelect: () => void;
}> = ({ provider, selected, active, statusText, ready, onSelect }) => (
  <button
    type="button"
    role="radio"
    aria-checked={selected}
    disabled={!provider.selectable}
    onClick={onSelect}
    className={clsx(
      'flex flex-col gap-2 rounded-2xl border p-4 text-start transition-colors',
      selected
        ? 'border-[color:var(--ag-accent)] bg-[var(--ag-accent-soft)]'
        : 'border-[color:var(--ag-hairline)] hover:border-[color:var(--ag-neutral-line)] hover:bg-boxHover',
      !provider.selectable && 'cursor-not-allowed opacity-50'
    )}
  >
    <div className="flex items-center gap-2.5">
      <span
        className={clsx(
          'flex h-8 w-8 items-center justify-center rounded-lg',
          selected
            ? 'bg-newBgColorInner text-[color:var(--ag-accent-text)]'
            : 'bg-[var(--ag-neutral-bg)] text-textItemBlur'
        )}
      >
        <Icon name={KIND[provider.kind].icon} size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold">
          {provider.label}
        </span>
        <span className="block text-[11px] text-textItemBlur">
          {KIND[provider.kind].label}
        </span>
      </span>
      {active && (
        <span className="rounded-md bg-[var(--ag-accent-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[color:var(--ag-accent-text)]">
          In use
        </span>
      )}
      {provider.experimental && (
        <span className="rounded-md bg-[var(--ag-warn-bg)] px-1.5 py-0.5 text-[11px] font-medium text-[color:var(--ag-warn-fg)]">
          Experimental
        </span>
      )}
    </div>
    <span className="text-[12px] leading-relaxed text-textItemBlur">
      {provider.summary}
    </span>
    <span className="flex items-center gap-1.5 text-[12px] text-textItemBlur">
      <span
        className={clsx(
          'h-1.5 w-1.5 rounded-full',
          !provider.selectable
            ? 'bg-[var(--ag-neutral-line)]'
            : ready
            ? 'bg-[var(--ag-good-fg)]'
            : 'bg-[var(--ag-neutral-line)]'
        )}
      />
      {provider.unavailable ?? statusText ?? 'Checking…'}
    </span>
  </button>
);

const TestResult: FC<{ result: AiTestResult }> = ({ result }) => (
  <div
    role={result.ok ? 'status' : 'alert'}
    className={clsx(
      'flex items-start gap-2.5 rounded-xl border px-4 py-3 text-[13px]',
      TONE_CLASS[result.ok ? 'good' : 'bad']
    )}
  >
    <Icon name={result.ok ? 'tick' : 'alert'} size={16} className="mt-0.5" />
    <div className="flex flex-col gap-1">
      {result.ok ? (
        <>
          <strong className="font-semibold">
            Working. {result.model ? `${result.model} ` : ''}answered in{' '}
            {(result.ms / 1000).toFixed(1)} s.
          </strong>
          {result.sample && <span>“{result.sample}”</span>}
        </>
      ) : (
        <>
          <strong className="font-semibold">That did not work.</strong>
          <span>{result.error}</span>
        </>
      )}
      {result.notes?.map((note) => (
        <span key={note}>{note}</span>
      ))}
    </div>
  </div>
);

const CUSTOM = '__custom__';

/** The levels a model accepts: what it reports itself, narrowed to what the provider supports. */
const levelsFor = (
  view: AiProviderView,
  models: AiModels | undefined,
  modelId: string
): ThinkingLevel[] => {
  const info =
    models?.models.find((m) => m.id === modelId) ??
    (modelId ? undefined : models?.models.find((m) => m.isDefault));
  const allowed = info?.thinkingLevels?.filter((l) =>
    view.thinkingLevels.includes(l)
  );
  return allowed?.length ? allowed : view.thinkingLevels;
};

/** Models come from the provider itself, with a way to type one it does not list. */
const ModelPicker: FC<{
  provider: AiProviderView;
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}> = ({ provider, value, onChange, disabled }) => {
  const api = useAgencyApi();
  const models = useAiModels(provider.id);
  const [typing, setTyping] = useState(false);
  const list = models.data?.models ?? [];
  const known = !value || list.some((m) => m.id === value);
  const custom = typing || !known;
  const chosen = list.find((m) => m.id === value);

  const refresh = async () => {
    try {
      models.mutate(
        await api.get<AiModels>(`/agency/ai/models/${provider.id}?refresh=1`),
        { revalidate: false }
      );
    } catch {
      /* the note under the list already says what is wrong */
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <SelectField
        label="Model"
        disabled={disabled}
        value={custom ? CUSTOM : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setTyping(true);
            return;
          }
          setTyping(false);
          onChange(e.target.value);
        }}
      >
        <option value="">Default (the provider’s own choice)</option>
        {list.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label === m.id ? m.id : `${m.label} (${m.id})`}
          </option>
        ))}
        <option value={CUSTOM}>Another model name…</option>
      </SelectField>
      {custom && (
        <TextField
          label="Model name"
          value={value}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          placeholder="Type the model name exactly"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {chosen?.description && (
        <p className="text-[12px] leading-relaxed text-textItemBlur">
          {chosen.description}
        </p>
      )}
      <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-textItemBlur">
        <span>
          {models.data?.note ??
            (models.data?.live
              ? `${list.length} model${
                  list.length === 1 ? '' : 's'
                } reported by ${provider.label}.`
              : models.isLoading
              ? 'Asking for the model list…'
              : 'Suggestions only.')}
        </span>
        <button
          type="button"
          onClick={refresh}
          className="font-medium text-[color:var(--ag-accent-text)] hover:underline"
        >
          Refresh the list
        </button>
      </p>
    </div>
  );
};

const ThinkingPicker: FC<{
  levels: ThinkingLevel[];
  value: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
}> = ({ levels, value, onChange, disabled }) => (
  <div className="flex flex-col gap-1.5">
    <span className="block text-xs font-medium text-textItemBlur">
      Thinking level
    </span>
    <Segmented<ThinkingLevel>
      ariaLabel="Thinking level"
      value={levels.includes(value) ? value : 'auto'}
      onChange={(level) => !disabled && onChange(level)}
      options={levels.map((level) => ({
        value: level,
        label: THINKING_LABEL[level],
      }))}
    />
    <p className="text-[12px] leading-relaxed text-textItemBlur">
      {levels.length === 1
        ? 'This model has no thinking setting.'
        : THINKING_HELP[levels.includes(value) ? value : 'auto']}
    </p>
  </div>
);

const TASKS: Array<{ id: AiTask; title: string; hint: string }> = [
  {
    id: 'copy',
    title: 'Ad copy',
    hint: 'Headlines, bodies and calls to action in the campaign form.',
  },
  {
    id: 'improve',
    title: 'Text improvement',
    hint: 'Rewriting an ad’s text in a chosen tone.',
  },
  {
    id: 'copilot',
    title: 'Copilot chat',
    hint: 'Questions and drafts in the side panel.',
  },
  {
    id: 'agent',
    title: 'Agent',
    hint: 'The Copilot when it does the work: several steps over your data.',
  },
];

type TaskDraft = {
  provider: '' | AiProviderId;
  model: string;
  thinking: '' | ThinkingLevel;
};
type TaskDrafts = Partial<Record<AiTask, TaskDraft | null>>;

const draftOf = (saved: AiSettings['tasks'][AiTask]): TaskDraft => ({
  provider: saved.provider ?? '',
  model: saved.model ?? '',
  thinking: saved.thinking ?? '',
});

const TaskRow: FC<{
  task: (typeof TASKS)[number];
  settings: AiSettings;
  draft: TaskDraft | null | undefined;
  canEdit: boolean;
  busy: boolean;
  result?: AiTestResult;
  onChange: (draft: TaskDraft | null) => void;
  onTest: () => void;
}> = ({ task, settings, draft, canEdit, busy, result, onChange, onTest }) => {
  const [open, setOpen] = useState(false);
  const current: TaskDraft =
    draft === null
      ? { provider: '', model: '', thinking: '' }
      : draft ?? draftOf(settings.tasks[task.id]);
  const usingProvider = current.provider || settings.activeProvider;
  const view = settings.providers.find((p) => p.id === usingProvider)!;
  const models = useAiModels(view.id);
  const levels = levelsFor(
    view,
    models.data,
    current.model || view.model || ''
  );
  const custom = !!(current.provider || current.model || current.thinking);

  const summary = custom
    ? [
        view.label,
        current.model || 'default model',
        current.thinking
          ? `thinking ${THINKING_LABEL[current.thinking].toLowerCase()}`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Uses the default above';

  return (
    <li className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium">{task.title}</div>
          <p className="text-[12px] text-textItemBlur">{task.hint}</p>
          <p
            className={clsx(
              'mt-0.5 text-[12px]',
              custom
                ? 'text-[color:var(--ag-accent-text)]'
                : 'text-textItemBlur'
            )}
          >
            {summary}
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            {custom && (
              <Btn onClick={() => onChange(null)}>Use the default</Btn>
            )}
            <Btn onClick={() => setOpen((o) => !o)}>
              {open ? 'Done' : custom ? 'Change' : 'Choose'}
            </Btn>
          </div>
        )}
      </div>

      {open && canEdit && (
        <div className="flex flex-col gap-4 rounded-xl bg-[var(--ag-neutral-bg)] p-4">
          <SelectField
            label="Provider"
            value={current.provider}
            onChange={(e) =>
              onChange({
                ...current,
                provider: e.target.value as TaskDraft['provider'],
                model: '',
                thinking: '',
              })
            }
          >
            <option value="">
              Default (
              {
                settings.providers.find((p) => p.id === settings.activeProvider)
                  ?.label
              }
              )
            </option>
            {settings.providers
              .filter((p) => p.selectable)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
          </SelectField>
          <div className="grid gap-4 sm:grid-cols-2">
            <ModelPicker
              provider={view}
              value={current.model}
              onChange={(model) =>
                onChange({
                  ...current,
                  model,
                  thinking: levelsFor(
                    view,
                    models.data,
                    model || view.model || ''
                  ).includes((current.thinking || 'auto') as ThinkingLevel)
                    ? current.thinking
                    : '',
                })
              }
            />
            <div className="flex flex-col gap-1.5">
              <span className="block text-xs font-medium text-textItemBlur">
                Thinking level
              </span>
              <Segmented<'' | ThinkingLevel>
                ariaLabel={`Thinking level for ${task.title}`}
                value={current.thinking}
                onChange={(thinking) => onChange({ ...current, thinking })}
                options={[
                  { value: '', label: 'Default' },
                  ...levels.map((level) => ({
                    value: level as '' | ThinkingLevel,
                    label: THINKING_LABEL[level],
                  })),
                ]}
              />
            </div>
          </div>
          <div>
            <Btn onClick={onTest} busy={busy}>
              Test this job
            </Btn>
          </div>
        </div>
      )}
      {result && <TestResult result={result} />}
    </li>
  );
};

const Editor: FC<{
  settings: AiSettings;
  canEdit: boolean;
  onSaved: (saved: AiSettings) => void;
}> = ({ settings, canEdit, onSaved }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const status = useAiStatus();
  const { busy, run } = useBusy();
  const [provider, setProvider] = useState<AiProviderId>(
    settings.activeProvider
  );
  const [thinking, setThinking] = useState<ThinkingLevel>(settings.thinking);
  const [edits, setEdits] = useState<Partial<Record<AiProviderId, Edit>>>({});
  const [taskDrafts, setTaskDrafts] = useState<TaskDrafts>({});
  const [result, setResult] = useState<AiTestResult | null>(null);
  const [taskResults, setTaskResults] = useState<
    Partial<Record<AiTask, AiTestResult>>
  >({});
  const [testing, setTesting] = useState<AiTask | null>(null);
  const models = useAiModels(provider);

  const view = settings.providers.find((p) => p.id === provider)!;
  const edit = edits[provider] ?? {};
  const model = edit.model ?? view.model ?? '';
  const baseUrl = edit.baseUrl ?? view.baseUrl;
  const removingKey = edit.apiKey === '';
  const levels = levelsFor(view, models.data, model);
  const dirty =
    provider !== settings.activeProvider ||
    thinking !== settings.thinking ||
    Object.keys(edits).length > 0 ||
    Object.keys(taskDrafts).length > 0;

  const choose = (id: AiProviderId) => {
    setProvider(id);
    setResult(null);
    const next = settings.providers.find((p) => p.id === id)!;
    if (!next.thinkingLevels.includes(thinking)) setThinking('auto');
  };

  const change = (patch: Edit) => {
    setResult(null);
    setEdits((current) => ({
      ...current,
      [provider]: { ...current[provider], ...patch },
    }));
    // A different model may not offer the chosen thinking level.
    if (patch.model !== undefined) {
      const allowed = levelsFor(view, models.data, patch.model);
      if (!allowed.includes(thinking)) setThinking('auto');
    }
  };

  const save = () =>
    run(async () => {
      const tasks = Object.fromEntries(
        Object.entries(taskDrafts).map(([task, draft]) => [
          task,
          draft === null || draft === undefined
            ? null
            : {
                provider: draft.provider,
                model: draft.model,
                thinking: draft.thinking,
              },
        ])
      );
      const saved = await api.put<AiSettings>('/agency/ai/settings', {
        activeProvider: provider,
        thinking,
        providers: edits,
        tasks,
      });
      setEdits({});
      setTaskDrafts({});
      setThinking(saved.thinking);
      onSaved(saved);
      await status.mutate();
    });

  const saveClicked = async () => {
    try {
      await save();
      toaster.show('AI settings saved', 'success');
    } catch (error) {
      toaster.show((error as Error).message, 'warning');
    }
  };

  const testClicked = async () => {
    setResult(null);
    try {
      if (dirty) await save();
      const outcome = await run(() =>
        api.post<AiTestResult>('/agency/ai/test', { provider })
      );
      setResult(outcome);
    } catch (error) {
      setResult({
        ok: false,
        provider,
        ms: 0,
        error: (error as Error).message,
      });
    }
  };

  const testTask = async (task: AiTask) => {
    setTesting(task);
    try {
      if (dirty) await save();
      const outcome = await api.post<AiTestResult>('/agency/ai/test', {
        task,
      });
      setTaskResults((current) => ({ ...current, [task]: outcome }));
    } catch (error) {
      setTaskResults((current) => ({
        ...current,
        [task]: {
          ok: false,
          provider,
          ms: 0,
          error: (error as Error).message,
        },
      }));
    } finally {
      setTesting(null);
    }
  };

  const ready = (id: AiProviderId) => status.data?.find((s) => s.id === id);
  const keyHint =
    view.keySource === 'environment' && !edit.apiKey
      ? 'Using the key found on this computer. Paste one here to use a different key.'
      : view.hasKey && !removingKey
      ? 'A key is saved. Paste a new one to replace it.'
      : removingKey
      ? 'The saved key will be removed when you save.'
      : view.needsKey
      ? 'Required for this provider.'
      : 'Only if the service asks for one.';

  return (
    <div className="flex flex-col gap-6">
      {!canEdit && (
        <Notice tone="info">
          You can see these settings, but only an owner or admin can change
          them.
        </Notice>
      )}

      <Card
        title="Which AI answers"
        subtitle="The default for ad copy, text improvement, the Copilot and the agent."
      >
        <div
          role="radiogroup"
          aria-label="AI provider"
          className="grid gap-3 sm:grid-cols-2"
        >
          {settings.providers.map((p) => {
            const st = ready(p.id);
            return (
              <ProviderCard
                key={p.id}
                provider={p}
                selected={p.id === provider}
                active={p.id === settings.activeProvider}
                ready={st?.ready}
                statusText={
                  st
                    ? `${st.detail}${st.version ? ` ${st.version}` : ''}`
                    : status.isLoading
                    ? 'Checking…'
                    : undefined
                }
                onSelect={() => canEdit && choose(p.id)}
              />
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-3 text-[12px] text-textItemBlur">
          <span>{view.setup}</span>
          <button
            type="button"
            onClick={() => status.mutate()}
            className="shrink-0 font-medium text-[color:var(--ag-accent-text)] hover:underline"
          >
            Check again
          </button>
        </div>
        {view.id === 'local' && (
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {settings.localMode && (
              <Link
                href="/settings?tab=system"
                className="text-[13px] font-medium text-[color:var(--ag-accent-text)] hover:underline"
              >
                Manage local models: download, start, stop, delete
              </Link>
            )}
            <Link
              href="/guide#local-model"
              className="text-[13px] font-medium text-[color:var(--ag-accent-text)] hover:underline"
            >
              Step by step: set up a local model
            </Link>
          </div>
        )}
      </Card>

      <Card
        title="Default model and thinking"
        subtitle={`For ${view.label}. Every job below follows this unless you choose otherwise.`}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <ModelPicker
            provider={view}
            value={model}
            disabled={!canEdit}
            onChange={(next) => change({ model: next })}
          />
          <ThinkingPicker
            levels={levels}
            value={thinking}
            disabled={!canEdit}
            onChange={(level) => {
              setResult(null);
              setThinking(level);
            }}
          />
        </div>

        {(view.needsKey || view.keyOptional) && (
          <div className="flex flex-col gap-2">
            <TextField
              label="API key"
              type="password"
              autoComplete="off"
              value={removingKey ? '' : edit.apiKey ?? ''}
              disabled={!canEdit}
              placeholder={view.hasKey ? '••••••••••••••••' : 'Paste your key'}
              onChange={(e) => change({ apiKey: e.target.value })}
              hint={keyHint}
            />
            {view.hasKey && view.keySource === 'saved' && canEdit && (
              <button
                type="button"
                onClick={() => change({ apiKey: removingKey ? undefined : '' })}
                className="self-start text-[12px] font-medium text-[color:var(--ag-accent-text)] hover:underline"
              >
                {removingKey ? 'Keep the saved key' : 'Remove the saved key'}
              </button>
            )}
          </div>
        )}

        {view.baseUrlEditable && view.id === 'openai-compatible' && (
          <TextField
            label="Service address"
            value={baseUrl}
            disabled={!canEdit}
            spellCheck={false}
            placeholder="http://localhost:1234/v1"
            onChange={(e) => change({ baseUrl: e.target.value })}
          />
        )}
        {view.baseUrlEditable && view.id === 'local' && (
          <details className="group text-[13px]">
            <summary className="cursor-pointer select-none text-textItemBlur hover:text-newTextColor">
              Advanced: server address
            </summary>
            <div className="mt-3">
              <TextField
                label="Ollama address"
                value={baseUrl}
                disabled={!canEdit}
                spellCheck={false}
                hint="Change this only if Ollama runs on another port or computer."
                onChange={(e) => change({ baseUrl: e.target.value })}
              />
            </div>
          </details>
        )}
      </Card>

      {result && <TestResult result={result} />}

      <Card
        title="A different model for each job"
        subtitle="Use a quick local model for ad copy and a stronger one for the agent, for example. Anything you leave on the default follows the settings above."
      >
        <ul className="-my-4 divide-y divide-[color:var(--ag-hairline)]">
          {TASKS.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              settings={settings}
              draft={taskDrafts[task.id]}
              canEdit={canEdit}
              busy={testing === task.id}
              result={taskResults[task.id]}
              onChange={(draft) => {
                setTaskResults((current) => ({
                  ...current,
                  [task.id]: undefined,
                }));
                setTaskDrafts((current) => ({ ...current, [task.id]: draft }));
              }}
              onTest={() => testTask(task.id)}
            />
          ))}
        </ul>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Btn onClick={testClicked} busy={busy}>
          {dirty && canEdit ? 'Save and test default' : 'Test default'}
        </Btn>
        <Btn
          variant="primary"
          onClick={saveClicked}
          busy={busy}
          disabled={!canEdit || !dirty}
        >
          Save
        </Btn>
      </div>
    </div>
  );
};

const ToolRow: FC<{
  tool: AiToolView;
  canEdit: boolean;
  busy: boolean;
  onUpdate: () => void;
}> = ({ tool, canEdit, busy, onUpdate }) => {
  const tone =
    tool.status === 'failed'
      ? 'text-[color:var(--ag-bad-fg)]'
      : tool.status === 'updated'
      ? 'text-[color:var(--ag-good-fg)]'
      : 'text-textItemBlur';
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[14px] font-medium">
          {tool.label}
          {tool.version && (
            <span className="text-[12px] font-normal text-textItemBlur">
              {tool.version}
            </span>
          )}
        </div>
        <p className={clsx('mt-0.5 text-[12px] leading-relaxed', tone)}>
          {!tool.installed
            ? 'Not installed on this computer.'
            : tool.message ??
              (tool.canUpdate ? 'Not checked yet.' : tool.manualHint)}
          {tool.installed && tool.lastCheckedAt && tool.canUpdate && (
            <span className="text-textItemBlur">
              {' '}
              Checked {timeAgo(tool.lastCheckedAt)}.
            </span>
          )}
        </p>
        {tool.installed && !tool.canUpdate && tool.message && (
          <p className="mt-0.5 text-[12px] text-textItemBlur">
            {tool.manualHint}
          </p>
        )}
      </div>
      {tool.installed && tool.canUpdate && canEdit && (
        <Btn onClick={onUpdate} busy={busy}>
          Update now
        </Btn>
      )}
    </li>
  );
};

const ToolsCard: FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const tools = useAiTools();
  const { busy, run } = useBusy();
  const [updating, setUpdating] = useState<string | null>(null);
  const data = tools.data;
  if (!data?.available) return null;

  const apply = (next: AiTools) => tools.mutate(next, { revalidate: false });

  const toggle = () =>
    run(async () => {
      try {
        apply(
          await api.put<AiTools>('/agency/ai/tools', {
            autoUpdate: !data.autoUpdate,
          })
        );
      } catch (error) {
        toaster.show((error as Error).message, 'warning');
      }
    });

  const update = async (id?: string) => {
    setUpdating(id ?? 'all');
    try {
      apply(
        await api.post<AiTools>('/agency/ai/tools/update', { provider: id })
      );
    } catch (error) {
      toaster.show((error as Error).message, 'warning');
    } finally {
      setUpdating(null);
    }
  };

  return (
    <Card
      title="Keep command-line tools up to date"
      subtitle="Claude Code, Codex CLI and Antigravity CLI. AgencyOS checks once a day and runs each tool’s own updater. Nothing else is downloaded or installed."
      right={
        <button
          type="button"
          role="switch"
          aria-checked={data.autoUpdate}
          aria-label="Update automatically"
          disabled={!canEdit || busy}
          onClick={toggle}
          className={clsx(
            'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
            data.autoUpdate
              ? 'bg-[var(--ag-accent)]'
              : 'bg-[var(--ag-neutral-line)]'
          )}
        >
          <span
            className={clsx(
              'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
              data.autoUpdate ? 'start-[22px]' : 'start-0.5'
            )}
          />
        </button>
      }
    >
      <p className="-mt-2 text-[12px] text-textItemBlur">
        {data.autoUpdate
          ? 'Automatic updates are on.'
          : 'Automatic updates are off. You can still update a tool yourself below.'}
      </p>
      <ul className="divide-y divide-[color:var(--ag-hairline)]">
        {data.tools.map((tool) => (
          <ToolRow
            key={tool.id}
            tool={tool}
            canEdit={canEdit}
            busy={updating === tool.id || updating === 'all'}
            onUpdate={() => update(tool.id)}
          />
        ))}
      </ul>
    </Card>
  );
};

export const AiSettingsComponent: FC = () => {
  const settings = useAiSettings();
  const { can } = useCan();

  return (
    <div className="ag-scope flex flex-col gap-6">
      <div>
        <h2 className="text-[20px] font-semibold tracking-tight">
          AI and Copilot
        </h2>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-textItemBlur">
          Choose the model that writes your ad copy and answers in the Copilot:
          one on this computer, a tool you already use such as Claude Code or
          Codex, or an API.
        </p>
      </div>
      {settings.error ? (
        <LoadError error={settings.error} onRetry={() => settings.mutate()} />
      ) : !settings.data ? (
        <Loading rows={3} />
      ) : (
        <Editor
          settings={settings.data}
          canEdit={can('ai:configure')}
          onSaved={(saved) => settings.mutate(saved, { revalidate: false })}
        />
      )}
      {settings.data?.localMode && <ToolsCard canEdit={can('ai:configure')} />}
    </div>
  );
};
