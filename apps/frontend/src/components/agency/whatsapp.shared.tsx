'use client';

import React, { FC, useEffect, useState } from 'react';
import clsx from 'clsx';
import { mutate as globalMutate } from 'swr';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { StatusBadge } from '@gitroom/frontend/components/agency/agency.ui';
import type {
  WhatsappConsentStatus,
  WhatsappTaskStatus,
} from '@gitroom/frontend/components/agency/agency.hooks';

/** How the person agreed. The first five are the common cases; the server accepts any short text. */
export const CONSENT_SOURCES = [
  'Web form',
  'In person',
  'Customer list with consent',
  'Phone call',
  'Email',
  'Other',
];

export const WITHDRAW_METHODS: Record<string, string> = {
  REPLIED_STOP: 'They replied STOP',
  PHONE_CALL: 'They told us by phone',
  EMAIL: 'They told us by email',
  IN_PERSON: 'They told us in person',
  OTHER: 'Another way',
};

export const withdrawMethod = (key: string) => WITHDRAW_METHODS[key] ?? key;

// StatusBadge picks its colour from the status it is given. These borrow the colour of a status that
// means the same kind of thing (waiting, in progress, good, quiet) and say their own words.
const TASK_BADGE: Record<WhatsappTaskStatus, { tone: string; label: string }> =
  {
    PENDING: { tone: 'PROPOSAL_SENT', label: 'To send' },
    SENT_BY_USER: { tone: 'CONTACTED', label: 'Marked sent by you' },
    REPLIED: { tone: 'WON', label: 'Replied' },
    SKIPPED: { tone: 'SKIPPED', label: 'Skipped' },
  };

export const TaskBadge: FC<{ status: WhatsappTaskStatus }> = ({ status }) => (
  <StatusBadge
    status={TASK_BADGE[status].tone}
    label={TASK_BADGE[status].label}
  />
);

export const ConsentBadge: FC<{ status: WhatsappConsentStatus }> = ({
  status,
}) =>
  status === 'OPTED_IN' ? (
    <StatusBadge status="ACTIVE" label="Opted in" />
  ) : (
    <StatusBadge status="REVOKED" label="Opted out" />
  );

export const TagList: FC<{ tags: string[]; className?: string }> = ({
  tags,
  className,
}) =>
  tags.length ? (
    <span className={clsx('flex flex-wrap gap-1', className)}>
      {tags.map((tag) => (
        <span
          key={tag}
          className="px-2 py-0.5 rounded-full text-[11px] text-textItemBlur bg-[var(--ag-neutral-bg)] border border-[color:var(--ag-hairline)]"
        >
          {tag}
        </span>
      ))}
    </span>
  ) : null;

/** A set of toggles for choosing several of a few things (tags, languages, sources). */
export const ChipPicker: FC<{
  label: string;
  options: string[];
  value: string[];
  onChange: (value: string[]) => void;
  empty: string;
}> = ({ label, options, value, onChange, empty }) => {
  const all = [...new Set([...options, ...value])];
  return (
    <div role="group" aria-label={label}>
      <span className="block text-xs font-medium text-textItemBlur mb-1.5">
        {label}
      </span>
      {all.length === 0 ? (
        <p className="text-xs text-textItemBlur">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {all.map((option) => {
            const on = value.includes(option);
            return (
              <button
                key={option}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  onChange(
                    on ? value.filter((v) => v !== option) : [...value, option]
                  )
                }
                className={clsx(
                  'px-3 h-7 rounded-full text-[13px] border',
                  on
                    ? 'bg-[var(--ag-accent-soft)] text-[color:var(--ag-accent-text)] border-[color:var(--ag-accent)]'
                    : 'text-textItemBlur border-[color:var(--ag-hairline)] hover:text-newTextColor'
                )}
              >
                {option}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Days: a reminder is a day on the person's own calendar
// ---------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD in the person's own time zone, for date fields. */
export const dayValue = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const daysFromNow = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
};

/** The start of a YYYY-MM-DD day in the person's time zone, as an instant. */
export const startOfDayIso = (value: string) => {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).toISOString();
};

/** The last moment of today in the person's time zone: what "due today" means. */
export const endOfTodayIso = () => {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999
  ).toISOString();
};

/** A quick check while typing; the server has the last word. */
export const phoneProblem = (value: string) => {
  const text = value
    .replace(/\(\s*0\s*\)/g, '')
    .replace(/[\s().\-/]/g, '')
    .replace(/^00/, '+');
  if (!text) return 'Enter the WhatsApp number.';
  if (!text.startsWith('+')) {
    return 'Start with + and the country code, for example +4915112345678.';
  }
  if (!/^\+[1-9]\d{7,14}$/.test(text)) {
    return 'That does not look like a full international number (8 to 15 digits after the +).';
  }
  return null;
};

export const useCopy = () => {
  const toaster = useToaster();
  return async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toaster.show(done, 'success');
    } catch {
      toaster.show(
        'Copying is not allowed here. Select the text instead.',
        'warning'
      );
    }
  };
};

/** The value after it has stopped changing for `ms`: keeps live previews from asking on every key. */
export const useDebounced = <T,>(value: T, ms = 350) => {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(handle);
  }, [value, ms]);
  return settled;
};

/** After a change, every WhatsApp list (contacts, counts, tasks, ledger) is fetched again. */
export const refreshWhatsapp = () =>
  globalMutate(
    (key) => Array.isArray(key) && String(key[0]).startsWith('agency-whatsapp')
  );
