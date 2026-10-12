'use client';

import React, { FC, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import {
  useCampaigns,
  useCan,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Icon,
  IconName,
} from '@gitroom/frontend/components/agency/agency.icons';
import { useNavigation } from '@gitroom/frontend/components/new-layout/nav.config';

type Entry = {
  id: string;
  group: 'Go to' | 'Create' | 'Settings' | 'Learn' | 'Campaigns';
  label: string;
  hint?: string;
  icon: IconName;
  href: string;
};

const OPEN_EVENT = 'agency:palette';

/** Opens the palette from anywhere (the top bar's search uses this). */
export const openCommandPalette = () =>
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));

const matches = (entry: Entry, query: string) => {
  const hay = `${entry.label} ${entry.hint ?? ''}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => hay.includes(token));
};

const Palette: FC<{ onClose: () => void }> = ({ onClose }) => {
  const router = useRouter();
  const { can } = useCan();
  const { groups, footer } = useNavigation();
  const campaigns = useCampaigns('ALL', '', can('campaign:read'));
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const create: Array<[string, string, IconName, string]> = [
      ['New campaign', '/agency/campaigns/new', 'plus', 'campaign:write'],
      [
        'Connect a Telegram chat',
        '/agency/telegram',
        'plus',
        'destination:manage',
      ],
    ];
    const settingsPages: Array<[string, string, IconName, string]> = [
      ['Appearance and theme', '/settings?tab=appearance', 'sun', 'Theme, light, dark'],
      ['AI and Copilot', '/settings?tab=ai', 'sparkles', 'Model, thinking level, local model, Claude Code, Codex, Antigravity, API key'],
      ['Storage and data folder', '/settings?tab=storage', 'folder', 'Move data, backups'],
    ];
    const learn: Array<[string, string, IconName, string]> = [
      ['Get started guide', '/guide', 'help', 'How to use AgencyOS, local model setup'],
      ['Features and how to use them', '/guide/features', 'book', 'Explainer, walkthrough'],
      ['What’s new', '/guide/changelog', 'flag', 'Changelog, versions, release notes'],
    ];
    return [
      ...groups.flatMap((group) =>
        group.items.map((item) => ({
          id: item.href,
          group: 'Go to' as const,
          label: item.label,
          hint: group.label,
          icon: item.icon,
          href: item.href,
        }))
      ),
      ...footer
        .filter((item) => item.id === 'settings')
        .map((item) => ({
          id: item.href,
          group: 'Go to' as const,
          label: item.label,
          icon: item.icon,
          href: item.href,
        })),
      ...create
        .filter(([, , , perm]) => can(perm))
        .map(([label, href, icon]) => ({
          id: `create-${label}`,
          group: 'Create' as const,
          label,
          icon,
          href,
        })),
      ...settingsPages.map(([label, href, icon, hint]) => ({
        id: href,
        group: 'Settings' as const,
        label,
        hint,
        icon,
        href,
      })),
      ...learn.map(([label, href, icon, hint]) => ({
        id: href,
        group: 'Learn' as const,
        label,
        hint,
        icon,
        href,
      })),
      ...(campaigns.data ?? []).slice(0, 50).map((c) => ({
        id: c.id,
        group: 'Campaigns' as const,
        label: c.name,
        hint: c.customer.companyName || c.customer.name,
        icon: 'megaphone' as IconName,
        href: `/agency/campaigns/${c.id}`,
      })),
    ];
  }, [can, groups, footer, campaigns.data]);

  const results = useMemo(
    () =>
      query.trim()
        ? entries.filter((e) => matches(e, query))
        : entries.filter((e) => e.group !== 'Campaigns'),
    [entries, query]
  );

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (entry?: Entry) => {
    if (!entry) return;
    onClose();
    router.push(entry.href);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup = '';
  return (
    <div
      className="ag-scope fixed inset-0 z-[160] flex items-start justify-center px-4 pt-[12vh] bg-[var(--ag-scrim)] backdrop-blur-sm ag-fade"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Jump to"
        className="ag-pop w-full max-w-xl overflow-hidden rounded-2xl bg-newBgColorInner text-newTextColor border border-[color:var(--ag-hairline)] shadow-[var(--ag-shadow-pop)]"
        onKeyDown={onKey}
      >
        <div className="flex items-center gap-3 px-5 border-b border-[color:var(--ag-hairline)]">
          <Icon name="search" size={18} className="text-textItemBlur shrink-0" />
          <input
            autoFocus
            data-bare
            role="combobox"
            aria-expanded="true"
            aria-controls="agency-palette-list"
            aria-activedescendant={
              results[active] ? `palette-${results[active].id}` : undefined
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a page or campaign"
            className="h-14 w-full bg-transparent text-[16px] text-newTextColor placeholder:text-textItemBlur outline-none ring-0 shadow-none"
          />
          <kbd className="hidden sm:block text-[11px] leading-none text-textItemBlur bg-[var(--ag-accent-soft)] rounded-md px-1.5 py-1">
            Esc
          </kbd>
        </div>
        <ul
          id="agency-palette-list"
          ref={list}
          role="listbox"
          className="max-h-[50vh] overflow-y-auto p-2 scrollbar-thin"
        >
          {results.length === 0 && (
            <li className="px-3 py-8 text-center text-[13px] text-textItemBlur">
              Nothing matches “{query}”.
            </li>
          )}
          {results.map((entry, i) => {
            const header = entry.group !== lastGroup;
            lastGroup = entry.group;
            return (
              <React.Fragment key={entry.id}>
                {header && (
                  <li
                    role="presentation"
                    className="px-3 pt-3 pb-1 text-[11px] font-medium text-textItemBlur"
                  >
                    {entry.group}
                  </li>
                )}
                <li
                  id={`palette-${entry.id}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(entry)}
                  className={clsx(
                    'flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer text-[13px]',
                    i === active
                      ? 'bg-[var(--ag-accent-soft)] text-newTextColor'
                      : 'text-newTextColor'
                  )}
                >
                  <Icon
                    name={entry.icon}
                    size={16}
                    className={
                      i === active
                        ? 'text-[color:var(--ag-accent-text)]'
                        : 'text-textItemBlur'
                    }
                  />
                  <span className="flex-1 truncate">{entry.label}</span>
                  {entry.hint && (
                    <span className="text-xs text-textItemBlur truncate max-w-40">
                      {entry.hint}
                    </span>
                  )}
                </li>
              </React.Fragment>
            );
          })}
        </ul>
        <div className="hidden sm:flex items-center gap-4 px-5 py-2.5 border-t border-[color:var(--ag-hairline)] text-[11px] text-textItemBlur">
          <span className="flex items-center gap-1.5">
            <kbd className="rounded bg-[var(--ag-accent-soft)] px-1.5 py-0.5">↑</kbd>
            <kbd className="rounded bg-[var(--ag-accent-soft)] px-1.5 py-0.5">↓</kbd>
            to move
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="rounded bg-[var(--ag-accent-soft)] px-1.5 py-0.5">Enter</kbd>
            to open
          </span>
        </div>
      </div>
    </div>
  );
};

export const CommandPalette: FC = () => {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  if (!mounted || !open) return null;
  return createPortal(
    <Palette onClose={() => setOpen(false)} />,
    document.body
  );
};
