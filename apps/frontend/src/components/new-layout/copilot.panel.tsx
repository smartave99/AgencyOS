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
  AiChatReply,
  useAgencyApi,
  useAiSettings,
} from '@gitroom/frontend/components/agency/agency.hooks';
import { Btn, Icon } from '@gitroom/frontend/components/agency/agency.ui';
import { matchNav } from '@gitroom/frontend/components/new-layout/nav.config';

const OPEN_EVENT = 'agencyos:copilot';

/** Opens the Copilot from anywhere; a prompt starts the conversation with it. */
export const openCopilot = (prompt?: string) =>
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { prompt } }));

type Message = { role: 'user' | 'assistant'; content: string; meta?: string };

const SUGGESTIONS = [
  'How do I get an ad approved and delivered?',
  'Write three headlines for a bakery’s spring sale',
  'What does “Needs check” mean on a delivery?',
  'Which AI provider should I use?',
];

// A small, safe reading of the Markdown models like to answer in: paragraphs, lists,
// **bold** and `code`. Everything stays plain text, so a reply can never inject markup.
const inline = (text: string): ReactNode[] =>
  text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
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

/**
 * A side panel to ask how to do something or to get a draft. It answers with the provider
 * chosen in Settings → AI and Copilot, and it only ever talks: it cannot click or change data.
 */
export const CopilotPanel: FC = () => {
  const api = useAgencyApi();
  const settings = useAiSettings();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  const send = useCallback(
    async (text: string, history: Message[]) => {
      const next: Message[] = [...history, { role: 'user', content: text }];
      setMessages(next);
      setDraft('');
      setError(null);
      setBusy(true);
      const here = matchNav(pathname);
      try {
        const reply = await api.post<AiChatReply>('/agency/ai/chat', {
          messages: next.map(({ role, content }) => ({ role, content })),
          page: here ? `${here.item.label} (${pathname})` : pathname,
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
        setBusy(false);
      }
    },
    [api, pathname]
  );

  useEffect(() => {
    const onOpen = (e: Event) => {
      setOpen(true);
      const prompt = (e as CustomEvent<{ prompt?: string }>).detail?.prompt;
      if (prompt) setDraft(prompt);
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
  }, [messages, busy, error]);

  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [busy]);

  const submit = () => {
    const text = draft.trim();
    if (text && !busy) send(text, messages);
  };

  const retry = () => {
    const last = messages[messages.length - 1];
    if (last?.role === 'user') send(last.content, messages.slice(0, -1));
  };

  const provider = settings.data?.providers.find(
    (p) => p.id === settings.data?.activeProvider
  );

  return (
    <aside
      role="complementary"
      aria-label="Copilot"
      aria-hidden={!open}
      inert={!open}
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      className={clsx(
        'ag-scope fixed bottom-0 end-0 top-14 z-[300] flex w-[420px] max-w-full flex-col border-s border-[color:var(--ag-hairline)] bg-newBgColorInner text-newTextColor shadow-[var(--ag-shadow-pop)] transition-transform duration-200 mobile:top-0 mobile:w-full',
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
              ? `${provider.label}${
                  provider.model ? ` · ${provider.model}` : ''
                }`
              : 'Choose an AI in Settings'}
          </Link>
        </div>
        {messages.length > 0 && (
          <Btn
            size="sm"
            onClick={() => {
              setMessages([]);
              setError(null);
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

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-5">
        {messages.length === 0 && !busy && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-[16px] font-semibold tracking-tight">
                How can I help?
              </h2>
              <p className="mt-1 text-[13px] leading-relaxed text-textItemBlur">
                Ask how to do something in AgencyOS, or ask for a draft. I can
                explain and write, but I never change anything for you.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              {SUGGESTIONS.map((text) => (
                <button
                  key={text}
                  type="button"
                  onClick={() => send(text, [])}
                  className="rounded-xl border border-[color:var(--ag-hairline)] px-3 py-2.5 text-start text-[13px] hover:bg-boxHover"
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) =>
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
                <span className="text-[11px] text-textItemBlur">{m.meta}</span>
              )}
            </div>
          )
        )}

        {busy && (
          <div className="flex flex-col gap-1 text-[13px] text-textItemBlur">
            <span className="flex items-center gap-2">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Thinking…
            </span>
            {slow && (
              <span className="text-[12px]">
                A model on this computer can take up to a minute.
              </span>
            )}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-xl border border-[color:var(--ag-bad-line)] bg-[var(--ag-bad-bg)] px-3.5 py-3 text-[13px] text-[color:var(--ag-bad-fg)]"
          >
            <span>{error}</span>
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
            placeholder="Ask anything about AgencyOS"
            aria-label="Message the Copilot"
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
