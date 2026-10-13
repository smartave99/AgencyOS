'use client';

import React, {
  FC,
  Fragment,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import {
  AgentActResult,
  AgentStepResult,
  AiChatReply,
  useAgencyApi,
  useAiSettings,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Icon,
  Segmented,
} from '@gitroom/frontend/components/agency/agency.ui';
import { matchNav } from '@gitroom/frontend/components/new-layout/nav.config';

const OPEN_EVENT = 'agencyos:copilot';
const MODE_KEY = 'agencyos.copilotMode';
const MAX_AGENT_STEPS = 10;

type Mode = 'ask' | 'agent';

/** Opens the Copilot from anywhere; a prompt (and a mode) starts the conversation with it. */
export const openCopilot = (prompt?: string, mode?: Mode) =>
  window.dispatchEvent(
    new CustomEvent(OPEN_EVENT, { detail: { prompt, mode } })
  );

type Message = { role: 'user' | 'assistant'; content: string; meta?: string };

const ASK_SUGGESTIONS = [
  'How do I get an ad approved and delivered?',
  'Write three headlines for a bakery’s spring sale',
  'What does “Needs check” mean on a delivery?',
  'Which AI provider should I use?',
];

const AGENT_SUGGESTIONS = [
  'What needs my attention today?',
  'Which campaigns have failed deliveries, and why?',
  'Draft a campaign for a bakery’s spring sale',
  'Add a client called Nair Foods',
];

// A small, safe reading of the Markdown models like to answer in: paragraphs, lists, **bold**,
// `code` and links inside AgencyOS. Everything stays plain text, so a reply can never inject markup.
const inline = (text: string): ReactNode[] =>
  text
    .split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(\/[^)\s]*\))/g)
    .map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        return (
          <code
            key={i}
            className="rounded bg-[var(--ag-neutral-bg)] px-1 py-0.5 font-mono text-[12px]"
          >
            {part.slice(1, -1)}
          </code>
        );
      }
      const link = /^\[([^\]]+)\]\((\/[^)\s]*)\)$/.exec(part);
      if (link && !link[2].startsWith('//')) {
        return (
          <Link
            key={i}
            href={link[2]}
            className="font-medium text-[color:var(--ag-accent-text)] hover:underline"
          >
            {link[1]}
          </Link>
        );
      }
      return <Fragment key={i}>{part}</Fragment>;
    });

const Reply: FC<{ text: string }> = ({ text }) => {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="flex flex-col gap-2 text-[13px] leading-relaxed">
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
          return (
            <ul key={i} className="flex list-disc flex-col gap-1 ps-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>
              ))}
            </ul>
          );
        }
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
          return (
            <ol key={i} className="flex list-decimal flex-col gap-1 ps-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>
              ))}
            </ol>
          );
        }
        if (block.startsWith('```')) {
          return (
            <pre
              key={i}
              className="overflow-x-auto rounded-lg bg-[var(--ag-neutral-bg)] p-3 font-mono text-[12px]"
            >
              {block.replace(/^```\w*\n?/, '').replace(/```$/, '')}
            </pre>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l.replace(/^#{1,4}\s+/, ''))}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// The agent: it looks things up, proposes changes, and waits for approval
// ---------------------------------------------------------------------------
type ItemBody =
  | { kind: 'user'; text: string }
  | {
      kind: 'work';
      activity: string;
      ok: boolean;
      args: Record<string, unknown>;
      result: string;
    }
  | {
      kind: 'proposal';
      tool: string;
      summary: string;
      args: Record<string, unknown>;
      state: 'waiting' | 'running' | 'approved' | 'declined' | 'failed';
      note?: string;
      open?: string;
    }
  | { kind: 'answer'; text: string; meta?: string }
  | { kind: 'notice'; text: string };

type ThreadItem = { id: number } & ItemBody;
type Draft = ItemBody;

const shorten = (value: unknown, max = 600) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const useAgent = (page: string) => {
  const api = useAgencyApi();
  const [thread, setThread] = useState<ThreadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const history = useRef<
    Array<{ role: 'user' | 'assistant'; content: string }>
  >([]);
  const stopped = useRef(false);
  const counter = useRef(1);

  const add = useCallback((item: Draft) => {
    const withId = { id: counter.current++, ...item } as ThreadItem;
    setThread((current) => [...current, withId]);
    return withId.id;
  }, []);
  const update = useCallback(
    (id: number, patch: Partial<Extract<ThreadItem, { kind: 'proposal' }>>) =>
      setThread((current) =>
        current.map((item) =>
          item.id === id ? ({ ...item, ...patch } as ThreadItem) : item
        )
      ),
    []
  );

  /** Takes steps until the agent answers, proposes a change, is stopped, or reaches the limit. */
  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    stopped.current = false;
    try {
      for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
        if (stopped.current) {
          add({ kind: 'notice', text: 'Stopped.' });
          return;
        }
        const reply = await api.post<AgentStepResult>('/agency/ai/agent/step', {
          messages: history.current.slice(-40),
          page,
        });
        history.current.push({ role: 'assistant', content: reply.assistant });
        const turn = reply.turn;
        if (turn.type === 'final') {
          add({
            kind: 'answer',
            text: turn.text,
            meta: `${reply.model ?? reply.provider} · ${(
              reply.ms / 1000
            ).toFixed(1)} s`,
          });
          return;
        }
        if (turn.type === 'tool') {
          add({
            kind: 'work',
            activity: turn.activity,
            ok: turn.ok,
            args: turn.args,
            result: turn.result,
          });
          history.current.push({
            role: 'user',
            content: `TOOL RESULT (${turn.tool})${turn.ok ? '' : ' ERROR'}: ${
              turn.result
            }`,
          });
          continue;
        }
        add({
          kind: 'proposal',
          tool: turn.tool,
          summary: turn.summary,
          args: turn.args,
          state: 'waiting',
        });
        return;
      }
      add({
        kind: 'notice',
        text: `I stopped after ${MAX_AGENT_STEPS} steps. Ask me to carry on if there is more to do.`,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [add, api, page]);

  const send = useCallback(
    (text: string) => {
      history.current.push({ role: 'user', content: text });
      add({ kind: 'user', text });
      void run();
    },
    [add, run]
  );

  const decide = useCallback(
    async (
      item: Extract<ThreadItem, { kind: 'proposal' }>,
      approve: boolean
    ) => {
      if (!approve) {
        update(item.id, { state: 'declined' });
        history.current.push({
          role: 'user',
          content:
            'TOOL RESULT: The person declined this change, so it was not made. Ask what they would like instead, or carry on with the rest of the task.',
        });
        void run();
        return;
      }
      update(item.id, { state: 'running' });
      try {
        const done = await api.post<AgentActResult>('/agency/ai/agent/act', {
          tool: item.tool,
          args: item.args,
        });
        let open: string | undefined;
        let note: string | undefined;
        try {
          const parsed = JSON.parse(done.result);
          open = typeof parsed.open === 'string' ? parsed.open : undefined;
          note = done.ok ? undefined : parsed.error;
        } catch {
          note = done.ok ? undefined : done.result;
        }
        update(item.id, { state: done.ok ? 'approved' : 'failed', open, note });
        history.current.push({
          role: 'user',
          content: `TOOL RESULT (${
            item.tool
          }): The person approved and the change ${
            done.ok ? 'was made' : 'FAILED'
          }: ${done.result}`,
        });
      } catch (e) {
        update(item.id, { state: 'failed', note: (e as Error).message });
        history.current.push({
          role: 'user',
          content: `TOOL RESULT (${item.tool}): The change FAILED: ${
            (e as Error).message
          }`,
        });
      }
      void run();
    },
    [api, run, update]
  );

  const reset = useCallback(() => {
    history.current = [];
    stopped.current = true;
    setThread([]);
    setError(null);
  }, []);

  return {
    thread,
    busy,
    error,
    send,
    decide,
    reset,
    stop: (): void => {
      stopped.current = true;
    },
    retry: (): void => {
      void run();
    },
  };
};

const WorkLine: FC<{ item: Extract<ThreadItem, { kind: 'work' }> }> = ({
  item,
}) => (
  <details className="group text-[12px] text-textItemBlur">
    <summary className="flex cursor-pointer select-none list-none items-center gap-2 hover:text-newTextColor">
      <Icon
        name={item.ok ? 'tick' : 'alert'}
        size={13}
        className={
          item.ok
            ? 'text-[color:var(--ag-good-fg)]'
            : 'text-[color:var(--ag-warn-fg)]'
        }
      />
      <span>{item.activity}</span>
      <Icon
        name="chevron"
        size={12}
        className="transition-transform group-open:rotate-180"
      />
    </summary>
    <div className="mt-1.5 flex flex-col gap-1 rounded-lg bg-[var(--ag-neutral-bg)] p-2.5 font-mono text-[11px] leading-relaxed">
      {Object.keys(item.args).length > 0 && (
        <span>asked: {shorten(item.args, 300)}</span>
      )}
      <span className="break-words">{shorten(item.result, 700)}</span>
    </div>
  </details>
);

const ProposalCard: FC<{
  item: Extract<ThreadItem, { kind: 'proposal' }>;
  onDecide: (approve: boolean) => void;
}> = ({ item, onDecide }) => {
  const decided = item.state !== 'waiting';
  return (
    <div
      className={clsx(
        'flex flex-col gap-3 rounded-2xl border p-4',
        item.state === 'waiting'
          ? 'border-[color:var(--ag-accent)] bg-[var(--ag-accent-soft)]'
          : 'border-[color:var(--ag-hairline)]'
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          name="shield"
          size={16}
          className="mt-0.5 text-[color:var(--ag-accent-text)]"
        />
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-textItemBlur">
            {item.state === 'waiting'
              ? 'The agent would like to make a change'
              : 'Change'}
          </div>
          <div className="text-[14px] font-semibold">{item.summary}</div>
        </div>
      </div>
      <dl className="flex flex-col gap-1.5 text-[12px]">
        {Object.entries(item.args).map(([key, value]) => (
          <div key={key} className="grid grid-cols-[96px_1fr] gap-2">
            <dt className="text-textItemBlur">{key}</dt>
            <dd className="min-w-0 break-words">{shorten(value, 400)}</dd>
          </div>
        ))}
      </dl>
      {item.state === 'waiting' && (
        <div className="flex items-center gap-2">
          <Btn variant="primary" onClick={() => onDecide(true)}>
            Approve
          </Btn>
          <Btn onClick={() => onDecide(false)}>Decline</Btn>
          <span className="text-[11px] text-textItemBlur">
            Nothing changes until you approve.
          </span>
        </div>
      )}
      {decided && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
          {item.state === 'running' && (
            <span className="flex items-center gap-2 text-textItemBlur">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Making the change…
            </span>
          )}
          {item.state === 'approved' && (
            <span className="font-medium text-[color:var(--ag-good-fg)]">
              Approved and done
            </span>
          )}
          {item.state === 'declined' && (
            <span className="text-textItemBlur">Declined, nothing changed</span>
          )}
          {item.state === 'failed' && (
            <span className="font-medium text-[color:var(--ag-bad-fg)]">
              Could not be made{item.note ? `: ${item.note}` : ''}
            </span>
          )}
          {item.open && (
            <Link
              href={item.open}
              className="font-medium text-[color:var(--ag-accent-text)] hover:underline"
            >
              Open it
            </Link>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * A side panel with two ways of working. Ask answers questions and writes drafts. Agent does the
 * work: it looks things up in AgencyOS, proposes changes, and waits for you to approve each one.
 * Either way it uses the provider and model chosen for it in Settings → AI and Copilot, and it can
 * never approve, schedule, send or delete anything itself.
 */
export const CopilotPanel: FC = () => {
  const api = useAgencyApi();
  const settings = useAiSettings();
  const pathname = usePathname();
  const here = matchNav(pathname);
  const pageLabel = here ? `${here.item.label} (${pathname})` : pathname;
  const agent = useAgent(pageLabel);

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('ask');
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  const busy = mode === 'agent' ? agent.busy : asking;
  const shownError = mode === 'agent' ? agent.error : error;

  useEffect(() => {
    try {
      if (localStorage.getItem(MODE_KEY) === 'agent') setMode('agent');
    } catch {
      /* the panel simply starts in Ask */
    }
  }, []);
  const chooseMode = (next: Mode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* the choice still applies for this visit */
    }
  };

  const ask = useCallback(
    async (text: string, history: Message[]) => {
      const next: Message[] = [...history, { role: 'user', content: text }];
      setMessages(next);
      setDraft('');
      setError(null);
      setAsking(true);
      try {
        const reply = await api.post<AiChatReply>('/agency/ai/chat', {
          messages: next.map(({ role, content }) => ({ role, content })),
          page: pageLabel,
        });
        setMessages([
          ...next,
          {
            role: 'assistant',
            content: reply.reply,
            meta: `${reply.model ?? reply.provider} · ${(
              reply.ms / 1000
            ).toFixed(1)} s`,
          },
        ]);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setAsking(false);
      }
    },
    [api, pageLabel]
  );

  useEffect(() => {
    const onOpen = (e: Event) => {
      setOpen(true);
      const detail = (e as CustomEvent<{ prompt?: string; mode?: Mode }>)
        .detail;
      if (detail?.mode) chooseMode(detail.mode);
      if (detail?.prompt) setDraft(detail.prompt);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages, agent.thread, busy, shownError]);

  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [busy]);

  const submit = (text = draft.trim()) => {
    if (!text || busy) return;
    if (mode === 'agent') {
      agent.send(text);
      setDraft('');
    } else {
      ask(text, messages);
    }
  };

  const retry = () => {
    if (mode === 'agent') return agent.retry();
    const last = messages[messages.length - 1];
    if (last?.role === 'user') ask(last.content, messages.slice(0, -1));
  };

  const task = settings.data?.tasks[mode === 'agent' ? 'agent' : 'copilot'];
  const provider = settings.data?.providers.find(
    (p) => p.id === (task?.provider ?? settings.data?.activeProvider)
  );
  const model = task?.model ?? provider?.model;
  const empty =
    mode === 'agent' ? agent.thread.length === 0 : messages.length === 0;

  return (
    <aside
      role="complementary"
      aria-label="Copilot"
      aria-hidden={!open}
      inert={!open}
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      className={clsx(
        'ag-scope fixed bottom-0 end-0 top-14 z-[300] flex w-[440px] max-w-full flex-col border-s border-[color:var(--ag-hairline)] bg-newBgColorInner text-newTextColor shadow-[var(--ag-shadow-pop)] transition-transform duration-200 mobile:top-0 mobile:w-full',
        open ? 'translate-x-0' : 'translate-x-full rtl:-translate-x-full'
      )}
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[color:var(--ag-hairline)] px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--ag-accent-soft)] text-[color:var(--ag-accent-text)]">
          <Icon name="sparkles" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold leading-tight">Copilot</div>
          <Link
            href="/settings?tab=ai"
            className="block truncate text-[11px] text-textItemBlur hover:text-newTextColor"
            title="Change the AI provider, model and thinking level"
          >
            {provider
              ? `${provider.label}${model ? ` · ${model}` : ''}`
              : 'Choose an AI in Settings'}
          </Link>
        </div>
        {!empty && (
          <Btn
            size="sm"
            onClick={() => {
              if (mode === 'agent') agent.reset();
              else {
                setMessages([]);
                setError(null);
              }
            }}
          >
            New chat
          </Btn>
        )}
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close the Copilot"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-textItemBlur hover:bg-boxHover hover:text-newTextColor"
        >
          <Icon name="x" size={16} />
        </button>
      </header>

      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--ag-hairline)] px-4 py-2">
        <Segmented<Mode>
          ariaLabel="Copilot mode"
          value={mode}
          onChange={chooseMode}
          options={[
            { value: 'ask', label: 'Ask' },
            { value: 'agent', label: 'Agent' },
          ]}
        />
        <span className="text-[11px] text-textItemBlur">
          {mode === 'agent'
            ? 'Does the work; you approve changes'
            : 'Answers and drafts only'}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-5">
        {empty && !busy && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-[16px] font-semibold tracking-tight">
                {mode === 'agent' ? 'What should I do?' : 'How can I help?'}
              </h2>
              <p className="mt-1 text-[13px] leading-relaxed text-textItemBlur">
                {mode === 'agent'
                  ? 'I look things up in AgencyOS, draft work and propose changes. You approve each change before it happens. I cannot approve, send or delete anything.'
                  : 'Ask how to do something in AgencyOS, or ask for a draft. I explain and write, and I never change anything.'}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              {(mode === 'agent' ? AGENT_SUGGESTIONS : ASK_SUGGESTIONS).map(
                (text) => (
                  <button
                    key={text}
                    type="button"
                    onClick={() =>
                      mode === 'agent' ? agent.send(text) : ask(text, [])
                    }
                    className="rounded-xl border border-[color:var(--ag-hairline)] px-3 py-2.5 text-start text-[13px] hover:bg-boxHover"
                  >
                    {text}
                  </button>
                )
              )}
            </div>
            {mode === 'agent' && (
              <p className="text-[11px] leading-relaxed text-textItemBlur">
                Agents need a capable model. Pick one for “Agent” under{' '}
                <Link
                  href="/settings?tab=ai"
                  className="font-medium text-[color:var(--ag-accent-text)] hover:underline"
                >
                  Settings → AI and Copilot
                </Link>
                .
              </p>
            )}
          </div>
        )}

        {mode === 'ask' &&
          messages.map((m, i) =>
            m.role === 'user' ? (
              <div
                key={i}
                className="ms-8 self-end rounded-2xl rounded-ee-md bg-[var(--ag-accent-soft)] px-3.5 py-2.5 text-[13px] leading-relaxed"
              >
                {m.content}
              </div>
            ) : (
              <div key={i} className="flex flex-col gap-1.5">
                <Reply text={m.content} />
                {m.meta && (
                  <span className="text-[11px] text-textItemBlur">
                    {m.meta}
                  </span>
                )}
              </div>
            )
          )}

        {mode === 'agent' &&
          agent.thread.map((item) => {
            switch (item.kind) {
              case 'user':
                return (
                  <div
                    key={item.id}
                    className="ms-8 self-end rounded-2xl rounded-ee-md bg-[var(--ag-accent-soft)] px-3.5 py-2.5 text-[13px] leading-relaxed"
                  >
                    {item.text}
                  </div>
                );
              case 'work':
                return <WorkLine key={item.id} item={item} />;
              case 'proposal':
                return (
                  <ProposalCard
                    key={item.id}
                    item={item}
                    onDecide={(approve) => agent.decide(item, approve)}
                  />
                );
              case 'answer':
                return (
                  <div key={item.id} className="flex flex-col gap-1.5">
                    <Reply text={item.text} />
                    {item.meta && (
                      <span className="text-[11px] text-textItemBlur">
                        {item.meta}
                      </span>
                    )}
                  </div>
                );
              default:
                return (
                  <p key={item.id} className="text-[12px] text-textItemBlur">
                    {item.text}
                  </p>
                );
            }
          })}

        {busy && (
          <div className="flex flex-col gap-1 text-[13px] text-textItemBlur">
            <span className="flex items-center gap-2">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {mode === 'agent' ? 'Working…' : 'Thinking…'}
              {mode === 'agent' && (
                <button
                  type="button"
                  onClick={agent.stop}
                  className="ms-1 text-[12px] font-medium text-[color:var(--ag-accent-text)] hover:underline"
                >
                  Stop
                </button>
              )}
            </span>
            {slow && (
              <span className="text-[12px]">
                A model on this computer can take up to a minute for each step.
              </span>
            )}
          </div>
        )}

        {shownError && (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-xl border border-[color:var(--ag-bad-line)] bg-[var(--ag-bad-bg)] px-3.5 py-3 text-[13px] text-[color:var(--ag-bad-fg)]"
          >
            <span>{shownError}</span>
            <span className="flex gap-2">
              <Btn size="sm" onClick={retry}>
                Try again
              </Btn>
              <Link
                href="/settings?tab=ai"
                className="inline-flex h-8 items-center rounded-[10px] px-3 text-[13px] font-medium hover:underline"
              >
                Open AI settings
              </Link>
            </span>
          </div>
        )}
        <div ref={end} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="shrink-0 border-t border-[color:var(--ag-hairline)] p-3"
      >
        <div className="flex items-end gap-2 rounded-2xl border border-[color:var(--ag-hairline)] bg-newBgColor p-2 focus-within:border-[color:var(--ag-accent)]">
          <textarea
            ref={input}
            data-bare
            rows={1}
            value={draft}
            placeholder={
              mode === 'agent'
                ? 'Tell the agent what to do'
                : 'Ask anything about AgencyOS'
            }
            aria-label={
              mode === 'agent' ? 'Message the agent' : 'Message the Copilot'
            }
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(
                e.target.scrollHeight,
                140
              )}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            className="max-h-[140px] min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] text-newTextColor outline-none ring-0 placeholder:text-textItemBlur shadow-none"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            aria-label="Send"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--ag-accent)] text-[color:var(--ag-accent-fg)] hover:bg-[var(--ag-accent-hover)] disabled:opacity-40"
          >
            <Icon name="arrow" size={16} />
          </button>
        </div>
        <p className="mt-2 px-1 text-[11px] text-textItemBlur">
          Enter to send, Shift+Enter for a new line. Check answers before you
          rely on them.
        </p>
      </form>
    </aside>
  );
};
