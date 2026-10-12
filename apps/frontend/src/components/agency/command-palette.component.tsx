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

type Entry = {
  id: string;
  group: 'Go to' | 'Create' | 'Campaigns';
  label: string;
  hint?: string;
  icon: IconName;
  href: string;
};

const OPEN_EVENT = 'agency:palette';

/** Opens the palette from anywhere (the header button uses this). */
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
  const campaigns = useCampaigns('ALL', '', can('campaign:read'));
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const go: Array<[string, string, IconName, string | null, string?]> = [
      ['Dashboard', '/agency/dashboard', 'chart', 'dashboard:read'],
      ['Clients', '/agency/clients', 'users', 'client:read'],
      ['Campaigns', '/agency/campaigns', 'megaphone', 'campaign:read'],
      ['Approvals', '/agency/approvals', 'check', 'campaign:read'],
      ['Telegram destinations', '/agency/telegram', 'send', 'destination:read'],
      ['Sales pipeline', '/agency/crm', 'chart', 'crm:read'],
      ['Invoices', '/agency/billing', 'card', 'billing:read'],
      ['Knowledge base', '/agency/intelligence', 'book', 'intelligence:read'],
      ['Connected accounts', '/agency/accounts', 'link', 'accounts:read'],
      ['Team and roles', '/agency/team', 'shield', 'team:read'],
      ['Client portal', '/agency/portal', 'doc', 'portal:view'],
    ];
    const create: Array<[string, string, IconName, string]> = [
      ['New campaign', '/agency/campaigns/new', 'plus', 'campaign:write'],
      [
        'Connect a Telegram chat',
        '/agency/telegram',
        'plus',
        'destination:manage',
      ],
    ];
    return [
      ...go
        .filter(([, , , perm]) => !perm || can(perm))
        .map(([label, href, icon]) => ({
          id: href,
          group: 'Go to' as const,
          label,
          icon,
          href,
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
      ...(campaigns.data ?? []).slice(0, 50).map((c) => ({
        id: c.id,
        group: 'Campaigns' as const,
        label: c.name,
        hint: c.customer.companyName || c.customer.name,
        icon: 'megaphone' as IconName,
        href: `/agency/campaigns/${c.id}`,
      })),
    ];
  }, [can, campaigns.data]);

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
        className="ag-pop w-full max-w-lg overflow-hidden rounded-2xl bg-newBgColorInner text-newTextColor shadow-[var(--ag-shadow-pop)]"
        onKeyDown={onKey}
      >
        <div className="flex items-center gap-3 px-4 border-b border-[color:var(--ag-hairline)]">
          <Icon name="search" size={16} className="text-textItemBlur" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="agency-palette-list"
            aria-activedescendant={
              results[active] ? `palette-${results[active].id}` : undefined
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a page or campaign"
            className="h-12 w-full bg-transparent text-[15px] text-newTextColor placeholder:text-textItemBlur focus:outline-none"
          />
          <kbd className="hidden sm:block text-[11px] text-textItemBlur border border-[color:var(--ag-hairline)] rounded px-1.5 py-0.5">
            Esc
          </kbd>
        </div>
        <ul
          id="agency-palette-list"
          ref={list}
          role="listbox"
          className="max-h-[50vh] overflow-y-auto p-2"
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

/** The visible entry point; Cmd/Ctrl+K works too. */
export const PaletteHint: FC = () => {
  const [mac, setMac] = useState(true);
  useEffect(() => {
    setMac(/Mac|iPhone|iPad/i.test(navigator.platform));
  }, []);
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      className="hidden sm:inline-flex items-center gap-2 h-8 pl-2.5 pr-2 rounded-[10px] text-[13px] text-textItemBlur border border-[color:var(--ag-hairline)] hover:text-newTextColor hover:bg-[var(--ag-neutral-bg)]"
      aria-label="Jump to a page or campaign"
    >
      <Icon name="search" size={14} />
      Jump to
      <kbd className="text-[11px] border border-[color:var(--ag-hairline)] rounded px-1.5 py-px">
        {mac ? '⌘K' : 'Ctrl K'}
      </kbd>
    </button>
  );
};
