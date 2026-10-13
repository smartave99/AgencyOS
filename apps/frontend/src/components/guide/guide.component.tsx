'use client';

import React, { FC, ReactNode, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import {
  useCan,
  useDashboard,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Card,
  Icon,
  LinkBtn,
  PageHeader,
  PageShell,
  TextField,
  Tone,
  TONE_CLASS,
} from '@gitroom/frontend/components/agency/agency.ui';
import { openCommandPalette } from '@gitroom/frontend/components/agency/command-palette.component';
import { openCopilot } from '@gitroom/frontend/components/new-layout/copilot.panel';
import {
  CURRENT_VERSION,
  ChangeType,
  FEATURES,
  FEATURE_GROUPS,
  Feature,
  RELEASES,
  useWhatsNew,
} from '@gitroom/frontend/components/guide/guide.data';

const TABS = [
  { href: '/guide', label: 'Get started' },
  { href: '/guide/features', label: 'Features' },
  { href: '/guide/changelog', label: 'What’s new' },
];

const GuideTabs: FC = () => {
  const pathname = usePathname();
  const { unseen } = useWhatsNew();
  return (
    <nav
      aria-label="Guide"
      className="-mt-2 flex gap-1 overflow-x-auto border-b border-[color:var(--ag-hairline)]"
    >
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={clsx(
              '-mb-px flex h-10 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-[14px] font-medium transition-colors',
              active
                ? 'border-[color:var(--ag-accent)] text-newTextColor'
                : 'border-transparent text-textItemBlur hover:text-newTextColor'
            )}
          >
            {tab.label}
            {tab.href === '/guide/changelog' && unseen && (
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--ag-accent)]" />
            )}
          </Link>
        );
      })}
    </nav>
  );
};

const GuideShell: FC<{
  title: string;
  subtitle: string;
  children: ReactNode;
}> = ({ title, subtitle, children }) => (
  <div className="flex-1 min-w-0 bg-newBgColor">
    <PageShell>
      <PageHeader title={title} subtitle={subtitle} />
      <GuideTabs />
      {children}
    </PageShell>
  </div>
);

const Code: FC<{ children: ReactNode }> = ({ children }) => (
  <code className="rounded-md bg-[var(--ag-neutral-bg)] px-1.5 py-0.5 font-mono text-[12px] text-newTextColor">
    {children}
  </code>
);

const Steps: FC<{ items: ReactNode[] }> = ({ items }) => (
  <ol className="flex flex-col gap-3">
    {items.map((item, i) => (
      <li key={i} className="flex gap-3 text-[13px] leading-relaxed">
        <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--ag-accent-soft)] text-[11px] font-semibold text-[color:var(--ag-accent-text)]">
          {i + 1}
        </span>
        <span className="min-w-0">{item}</span>
      </li>
    ))}
  </ol>
);

const Section: FC<{
  id: string;
  title: string;
  intro?: string;
  children: ReactNode;
}> = ({ id, title, intro, children }) => (
  <section id={id} className="scroll-mt-20">
    <Card title={title} subtitle={intro}>
      {children}
    </Card>
  </section>
);

// ---------------------------------------------------------------------------
// Get started
// ---------------------------------------------------------------------------
const WorkflowStep: FC<{
  n: number;
  title: string;
  body: string;
  href: string;
  cta: string;
  done?: boolean;
}> = ({ n, title, body, href, cta, done }) => (
  <li className="flex flex-col gap-2 rounded-2xl border border-[color:var(--ag-hairline)] p-4">
    <div className="flex items-center gap-2.5">
      <span
        className={clsx(
          'flex h-6 w-6 items-center justify-center rounded-full text-[12px] font-semibold',
          done
            ? 'bg-[var(--ag-good-bg)] text-[color:var(--ag-good-fg)]'
            : 'bg-[var(--ag-accent-soft)] text-[color:var(--ag-accent-text)]'
        )}
      >
        {done ? <Icon name="tick" size={13} /> : n}
      </span>
      <h3 className="text-[14px] font-semibold">{title}</h3>
    </div>
    <p className="text-[13px] leading-relaxed text-textItemBlur">{body}</p>
    <Link
      href={href}
      className="mt-auto inline-flex items-center gap-1 text-[13px] font-medium text-[color:var(--ag-accent-text)] hover:underline"
    >
      {cta}
      <Icon name="arrow" size={13} />
    </Link>
  </li>
);

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl K  ·  ⌘K', 'Search every page, setting and campaign'],
  ['Ctrl J  ·  ⌘J', 'Open or close the Copilot'],
  ['↑  ↓  Enter', 'Move through and open search results'],
  ['Esc', 'Close search, the Copilot or a menu'],
];

export const GuideComponent: FC = () => {
  const { can } = useCan();
  const dashboard = useDashboard(can('dashboard:read'));
  const d = dashboard.data;

  return (
    <GuideShell
      title="Guide"
      subtitle="From a client's brief to an ad delivered to Telegram, and the results, in one place."
    >
      <div className="flex flex-wrap gap-2 text-[13px]">
        {[
          ['workflow', 'Your first campaign'],
          ['local-model', 'Set up a local model'],
          ['agent', 'Copilot and agent'],
          ['other-ai', 'Other AI providers'],
          ['scope', 'What AgencyOS does'],
          ['shortcuts', 'Shortcuts'],
          ['help', 'If something looks wrong'],
        ].map(([id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            className="rounded-full border border-[color:var(--ag-hairline)] px-3 py-1 text-textItemBlur hover:bg-boxHover hover:text-newTextColor"
          >
            {label}
          </a>
        ))}
      </div>

      <Section
        id="workflow"
        title="Your first campaign"
        intro="Six steps, about five minutes. A tick means AgencyOS can see you have already done it."
      >
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <WorkflowStep
            n={1}
            title="Add a client"
            body="Every ad belongs to a client. Only the company name is required."
            href="/agency/clients"
            cta="Open Clients"
            done={d ? d.activeClientsCount > 0 : undefined}
          />
          <WorkflowStep
            n={2}
            title="Connect a Telegram chat"
            body="Press Connect a Telegram bot on the Dashboard and paste your bot token (from @BotFather) once. Then connect a group or channel and have its administrator send the code with /authorize."
            href="/agency/telegram"
            cta="Open Telegram"
            done={d ? d.telegramDestinationsCount > 0 : undefined}
          />
          <WorkflowStep
            n={3}
            title="Write the ad"
            body="Write it yourself or press Suggest copy. The preview is exactly what Telegram will show."
            href="/agency/campaigns/new"
            cta="New campaign"
            done={d ? d.totalCampaignsCount > 0 : undefined}
          />
          <WorkflowStep
            n={4}
            title="Get it approved"
            body="Submit it for review. Someone approves, or sends it back with a note. Nothing is delivered before approval."
            href="/agency/approvals"
            cta="Open Approvals"
          />
          <WorkflowStep
            n={5}
            title="Schedule and deliver"
            body="Pick the authorized chats and a time. AgencyOS retries when Telegram is busy and tells you plainly when something fails."
            href="/agency/campaigns"
            cta="Open Campaigns"
            done={d ? d.successfulPosts > 0 : undefined}
          />
          <WorkflowStep
            n={6}
            title="Check the results"
            body="See what was delivered and what failed, by day, campaign and chat. Export CSV or save as PDF for your client."
            href="/agency/reports"
            cta="Open Reports"
          />
        </ol>
        {can('campaign:write') && (
          <div>
            <LinkBtn href="/agency/campaigns/new" variant="primary" size="md">
              Start a campaign
            </LinkBtn>
          </div>
        )}
      </Section>

      <Section
        id="local-model"
        title="Set up a local model"
        intro="A local model runs on this computer: private, free and it works offline. For most people there is nothing to do."
      >
        <Steps
          items={[
            <>
              <strong>It sets itself up.</strong> The first time AgencyOS starts
              it looks at your memory, processor and graphics card and downloads
              a model that fits (a one-time download of roughly 2 to 6 GB).
              Until it finishes, ad copy uses templates and the Copilot says the
              model is not ready. Progress is under the tray icon →{' '}
              <em>Status and settings</em>.
            </>,
            <>
              <strong>Check that it works.</strong> Open{' '}
              <Link
                className="font-medium text-[color:var(--ag-accent-text)] hover:underline"
                href="/settings?tab=ai"
              >
                Settings → AI and Copilot
              </Link>
              , choose <em>Local model (Ollama)</em> and press <em>Test</em>.
              “Working” means it answered; anything else says what to fix.
            </>,
            <>
              <strong>Too slow?</strong> Use a smaller model. In a terminal run{' '}
              <Code>ollama pull qwen2.5:3b</Code>, then in Settings press{' '}
              <em>Check again</em> and pick it under <em>Model</em>.
            </>,
            <>
              <strong>Want a different or bigger model?</strong> Run{' '}
              <Code>ollama pull &lt;name&gt;</Code> with any name from
              ollama.com/library, then choose it under <em>Model</em>. Bigger
              models write better but need more memory.
            </>,
            <>
              <strong>Thinking level.</strong> Leave it on <em>Auto</em> for ad
              copy. Models that can “think first” are slower when they do, so
              use Low, Medium or High only for hard questions.
            </>,
            <>
              <strong>Where are the files?</strong> The engine and models live
              in the AI folder shown under{' '}
              <Link
                className="font-medium text-[color:var(--ag-accent-text)] hover:underline"
                href="/settings?tab=storage"
              >
                Settings → Storage
              </Link>
              , where you can move them to another drive.
            </>,
          ]}
        />
        <p className="text-[12px] leading-relaxed text-textItemBlur">
          The <Code>ollama</Code> command comes from the free Ollama app
          (ollama.com). AgencyOS and that command use the same address, so a
          model you pull appears in AgencyOS. If you already run Ollama,
          AgencyOS uses yours instead of starting a second one.
        </p>
      </Section>

      <Section
        id="agent"
        title="Ask, or let the agent do it"
        intro="Press Ctrl+J (⌘J on a Mac) for the Copilot. It has two modes."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-[color:var(--ag-hairline)] p-4">
            <h3 className="text-[14px] font-semibold">Ask</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-textItemBlur">
              Questions and drafts: “How do I get an ad approved?”, “Write three
              headlines for a bakery’s spring sale”. It explains and writes. It
              never changes anything.
            </p>
          </div>
          <div className="rounded-2xl border border-[color:var(--ag-hairline)] p-4">
            <h3 className="text-[14px] font-semibold">Agent</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-textItemBlur">
              Work: “What needs my attention today?”, “Draft a campaign for Nair
              Foods”. It looks things up in AgencyOS, shows each step, and
              proposes changes.
            </p>
          </div>
        </div>
        <Steps
          items={[
            <>
              <strong>How it works.</strong> The agent asks the AI one step at a
              time: look something up, or answer. Each look-up runs with{' '}
              <em>your</em> permissions, so it can only see what you can see.
            </>,
            <>
              <strong>Changes need you.</strong> When it wants to add a client,
              create or edit a draft campaign, choose its Telegram destinations
              or submit it for review, it shows exactly what will change.
              Nothing happens until you press <em>Approve</em>, and every
              approved change is in the audit trail under your name.
            </>,
            <>
              <strong>What it can never do.</strong> Approve a campaign,
              schedule or send anything, delete anything, authorize a Telegram
              chat, or change who may do what. Those stay with people, so the
              review and authorization rules cannot be bypassed.
            </>,
            <>
              <strong>Pick a capable model for it.</strong> Agents need a model
              that follows instructions well. In{' '}
              <Link
                className="font-medium text-[color:var(--ag-accent-text)] hover:underline"
                href="/settings?tab=ai"
              >
                Settings → AI and Copilot
              </Link>{' '}
              you can choose a different provider, model and thinking level for
              the agent than for ad copy: for example a fast local model for
              copy and Claude Code for the agent.
            </>,
          ]}
        />
        <div className="flex flex-wrap gap-2">
          <Btn onClick={() => openCopilot(undefined, 'ask')}>Open Ask</Btn>
          <Btn onClick={() => openCopilot(undefined, 'agent')}>
            Open the agent
          </Btn>
        </div>
      </Section>

      <Section
        id="other-ai"
        title="Use Claude Code, Codex, Antigravity or an API"
        intro="One setting decides which AI answers everywhere: ad copy, text improvement and the Copilot."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            [
              'Claude Code',
              'Install it, open a terminal, run claude once and sign in. Then pick it in Settings and press Test. AgencyOS uses your sign-in; it never sees your password.',
            ],
            [
              'Codex CLI',
              'Install it, run codex once and sign in. Leave the model empty to use Codex’s own default.',
            ],
            [
              'Antigravity CLI (experimental)',
              'Install it, run agy once and sign in. Support follows the program’s documented options and some versions hang when started by another program, so always press Test.',
            ],
            [
              'APIs',
              'Anthropic, OpenAI, Google Gemini or any OpenAI-compatible service: paste a key, pick a model from the live list and a thinking level. Keys are stored encrypted and are never shown again.',
            ],
          ].map(([title, text]) => (
            <div
              key={title}
              className="rounded-2xl border border-[color:var(--ag-hairline)] p-4"
            >
              <h3 className="text-[14px] font-semibold">{title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-textItemBlur">
                {text}
              </p>
            </div>
          ))}
        </div>
        <p className="text-[12px] leading-relaxed text-textItemBlur">
          Command-line tools run only in the desktop app, in an empty folder
          with their tools switched off, so an answer can never change your
          files. AgencyOS also keeps Claude Code, Codex CLI and Antigravity CLI
          up to date by running their own update command once a day; you can
          turn that off or press Update now in the same settings. The model list
          and the thinking levels shown come from the tool itself. Only owners
          and admins can change these settings.
        </p>
        <div>
          <LinkBtn href="/settings?tab=ai">
            Open AI and Copilot settings
          </LinkBtn>
        </div>
      </Section>

      <Section
        id="scope"
        title="What AgencyOS does, and what it does not"
        intro="Built for agencies that advertise honestly and with permission."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-[color:var(--ag-hairline)] p-4">
            <h3 className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[color:var(--ag-good-fg)]">
              <Icon name="tick" size={15} /> Does
            </h3>
            <ul className="flex list-disc flex-col gap-1.5 ps-5 text-[13px] leading-relaxed text-textItemBlur">
              <li>
                Create ads with a true Telegram preview and AI suggestions.
              </li>
              <li>Review and approve them, with the client if you want.</li>
              <li>
                Deliver to chats whose administrators authorized you, with
                retries and a clear failure list.
              </li>
              <li>
                Report what was delivered, and keep leads, knowledge and
                invoices beside it.
              </li>
            </ul>
          </div>
          <div className="rounded-2xl border border-[color:var(--ag-hairline)] p-4">
            <h3 className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[color:var(--ag-bad-fg)]">
              <Icon name="x" size={15} /> Does not, by design
            </h3>
            <ul className="flex list-disc flex-col gap-1.5 ps-5 text-[13px] leading-relaxed text-textItemBlur">
              <li>
                Join groups on its own, or post where nobody authorized it.
              </li>
              <li>Scrape members or usernames, or add people to groups.</li>
              <li>Switch accounts to get around a block or a limit.</li>
            </ul>
            <p className="mt-2 text-[12px] leading-relaxed text-textItemBlur">
              Those break Telegram’s terms and anti-spam and privacy laws, and
              they would put your clients at risk. A chat that removes the bot
              is paused, not worked around.
            </p>
          </div>
        </div>
      </Section>

      <Section id="shortcuts" title="Keyboard shortcuts">
        <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys} className="flex items-center gap-3 text-[13px]">
              <dt>
                <kbd className="rounded-md border border-[color:var(--ag-hairline)] bg-[var(--ag-neutral-bg)] px-2 py-1 text-[12px]">
                  {keys}
                </kbd>
              </dt>
              <dd className="text-textItemBlur">{what}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap gap-2">
          <Btn onClick={openCommandPalette}>Try search</Btn>
          <Btn onClick={() => openCopilot()}>Open the Copilot</Btn>
        </div>
      </Section>

      <Section id="help" title="If something looks wrong">
        <Steps
          items={[
            <>
              <strong>“No Telegram bot is configured”</strong> on the Dashboard:
              paste your bot token under the tray icon → Status and settings.
            </>,
            <>
              <strong>“No publishing dispatcher is running”:</strong> scheduled
              campaigns wait until it starts. Restart AgencyOS from the tray
              icon.
            </>,
            <>
              <strong>A delivery says “Needs check”:</strong> it was interrupted
              while sending. AgencyOS never resends it on its own. Look in the
              chat, then retry from the campaign if it is missing.
            </>,
            <>
              <strong>AI says it is not working:</strong> Settings → AI and
              Copilot → Test names the exact problem and what to do.
            </>,
          ]}
        />
      </Section>
    </GuideShell>
  );
};

// ---------------------------------------------------------------------------
// Features: how to use what
// ---------------------------------------------------------------------------
const STATUS: Record<Feature['status'], { label: string; tone: Tone }> = {
  ready: { label: 'Ready to use', tone: 'good' },
  'needs-setup': { label: 'Needs setup', tone: 'warn' },
  partial: { label: 'Partly built', tone: 'info' },
  experimental: { label: 'Experimental', tone: 'warn' },
};

const FeatureCard: FC<{ feature: Feature }> = ({ feature }) => {
  const status = STATUS[feature.status];
  const action =
    feature.id === 'copilot' ? (
      <Btn onClick={() => openCopilot()}>Open the Copilot</Btn>
    ) : feature.id === 'search' ? (
      <Btn onClick={openCommandPalette}>Try search</Btn>
    ) : (
      <LinkBtn href={feature.href}>Open {feature.title}</LinkBtn>
    );
  return (
    <article
      id={feature.id}
      className="scroll-mt-20 flex flex-col gap-3 rounded-2xl border border-[color:var(--ag-hairline)] bg-newBgColorInner p-5"
    >
      <header className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--ag-accent-soft)] text-[color:var(--ag-accent-text)]">
          <Icon name={feature.icon} size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold tracking-tight">
            {feature.title}
          </h3>
          <p className="mt-0.5 text-[13px] leading-relaxed text-textItemBlur">
            {feature.summary}
          </p>
        </div>
        <span
          className={clsx(
            'shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium',
            TONE_CLASS[status.tone]
          )}
        >
          {status.label}
        </span>
      </header>
      <details className="group">
        <summary className="cursor-pointer select-none text-[13px] font-medium text-[color:var(--ag-accent-text)] hover:underline">
          How to use it
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <Steps items={feature.steps} />
          {feature.needs && (
            <p className="text-[12px] leading-relaxed text-textItemBlur">
              <strong className="font-medium text-newTextColor">
                You need:
              </strong>{' '}
              {feature.needs.join(' ')}
            </p>
          )}
          {feature.tips?.map((tip) => (
            <p
              key={tip}
              className="text-[12px] leading-relaxed text-textItemBlur"
            >
              <strong className="font-medium text-newTextColor">
                Good to know:
              </strong>{' '}
              {tip}
            </p>
          ))}
        </div>
      </details>
      <div className="mt-auto">{action}</div>
    </article>
  );
};

export const FeaturesComponent: FC = () => {
  const { isLocal } = useVariables();
  const [query, setQuery] = useState('');

  // A link such as /guide/features#copilot opens that feature's steps.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    const el = id ? document.getElementById(id) : null;
    el?.querySelector('details')?.setAttribute('open', '');
    el?.scrollIntoView({ block: 'start' });
  }, []);

  const visible = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return FEATURES.filter((f) => !(isLocal && f.hideWhenLocal)).filter((f) => {
      const hay = `${f.title} ${f.summary} ${f.steps.join(' ')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [query, isLocal]);

  return (
    <GuideShell
      title="Features"
      subtitle="What every part of AgencyOS is for, how to use it step by step, and what it needs."
    >
      <div className="max-w-md">
        <TextField
          label="Find a feature"
          placeholder="For example: approve, invoice, thinking level"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {visible.length === 0 && (
        <p className="text-[13px] text-textItemBlur">
          Nothing matches “{query}”. Try a shorter word.
        </p>
      )}
      {FEATURE_GROUPS.map((group) => {
        const items = visible.filter((f) => f.group === group.id);
        if (!items.length) return null;
        return (
          <section key={group.id} className="flex flex-col gap-3">
            <div>
              <h2 className="text-[16px] font-semibold tracking-tight">
                {group.title}
              </h2>
              <p className="text-[13px] text-textItemBlur">{group.blurb}</p>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {items.map((feature) => (
                <FeatureCard key={feature.id} feature={feature} />
              ))}
            </div>
          </section>
        );
      })}
    </GuideShell>
  );
};

// ---------------------------------------------------------------------------
// What's new: every version
// ---------------------------------------------------------------------------
const CHANGE_LABEL: Record<ChangeType, { label: string; tone: Tone }> = {
  added: { label: 'Added', tone: 'good' },
  improved: { label: 'Improved', tone: 'info' },
  changed: { label: 'Changed', tone: 'neutral' },
  fixed: { label: 'Fixed', tone: 'warn' },
  security: { label: 'Security', tone: 'bad' },
};

const formatReleaseDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

export const ChangelogComponent: FC = () => {
  const { markSeen } = useWhatsNew();
  useEffect(() => {
    markSeen();
  }, [markSeen]);

  return (
    <GuideShell
      title="What’s new"
      subtitle={`Every change in every version of AgencyOS. You are on version ${CURRENT_VERSION}.`}
    >
      <div className="flex flex-col gap-6">
        {RELEASES.map((release, index) => (
          <article
            key={release.version}
            id={`v${release.version}`}
            className="scroll-mt-20 flex flex-col gap-4 rounded-2xl border border-[color:var(--ag-hairline)] bg-newBgColorInner p-5 sm:p-6"
          >
            <header className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[20px] font-semibold tracking-tight">
                  {release.version}
                </h2>
                {index === 0 && (
                  <span
                    className={clsx(
                      'rounded-full border px-2.5 py-0.5 text-[11px] font-medium',
                      TONE_CLASS.info
                    )}
                  >
                    Current
                  </span>
                )}
                <span className="text-[13px] text-textItemBlur">
                  {formatReleaseDate(release.date)}
                </span>
              </div>
              <p className="text-[15px] font-medium">{release.title}</p>
              <p className="max-w-3xl text-[13px] leading-relaxed text-textItemBlur">
                {release.summary}
              </p>
            </header>
            <ul className="flex flex-col gap-2.5">
              {release.changes.map((change) => {
                const kind = CHANGE_LABEL[change.type];
                return (
                  <li
                    key={`${change.type}-${change.text}`}
                    className="flex items-start gap-3 text-[13px] leading-relaxed"
                  >
                    <span
                      className={clsx(
                        'mt-px w-[72px] shrink-0 rounded-md border px-2 py-0.5 text-center text-[11px] font-medium',
                        TONE_CLASS[kind.tone]
                      )}
                    >
                      {kind.label}
                    </span>
                    <span>
                      <strong className="font-medium">{change.area}: </strong>
                      <span className="text-textItemBlur">{change.text}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
            {release.notes && release.notes.length > 0 && (
              <div className="rounded-xl bg-[var(--ag-neutral-bg)] px-4 py-3">
                <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-textItemBlur">
                  Good to know
                </h3>
                <ul className="flex list-disc flex-col gap-1 ps-5 text-[13px] leading-relaxed text-textItemBlur">
                  {release.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        ))}
      </div>
    </GuideShell>
  );
};
