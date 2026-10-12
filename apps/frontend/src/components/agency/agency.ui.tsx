'use client';

import React, {
  FC,
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import clsx from 'clsx';
import {
  CommandPalette,
  PaletteHint,
} from '@gitroom/frontend/components/agency/command-palette.component';

// ===========================================================================
// AgencyOS design system
//
// One accent, semantic status colours that keep their contrast in light and dark,
// sentence-case labels, generous whitespace, motion that is short and respects
// prefers-reduced-motion, and keyboard focus that is always visible. Every agency
// screen composes these pieces so a status, a button or a dialog looks and behaves the
// same everywhere.
// ===========================================================================

import {
  Icon,
  type IconName,
} from '@gitroom/frontend/components/agency/agency.icons';

export { Icon };
export type { IconName };

// ---------------------------------------------------------------------------
// Tone and status
// ---------------------------------------------------------------------------
export type Tone = 'good' | 'info' | 'warn' | 'bad' | 'neutral';

export const TONE_CLASS: Record<Tone, string> = {
  good: 'text-[color:var(--ag-good-fg)] bg-[var(--ag-good-bg)] border-[color:var(--ag-good-line)]',
  info: 'text-[color:var(--ag-info-fg)] bg-[var(--ag-info-bg)] border-[color:var(--ag-info-line)]',
  warn: 'text-[color:var(--ag-warn-fg)] bg-[var(--ag-warn-bg)] border-[color:var(--ag-warn-line)]',
  bad: 'text-[color:var(--ag-bad-fg)] bg-[var(--ag-bad-bg)] border-[color:var(--ag-bad-line)]',
  neutral:
    'text-[color:var(--ag-neutral-fg)] bg-[var(--ag-neutral-bg)] border-[color:var(--ag-neutral-line)]',
};

export const TONE_TEXT: Record<Tone, string> = {
  good: 'text-[color:var(--ag-good-fg)]',
  info: 'text-[color:var(--ag-info-fg)]',
  warn: 'text-[color:var(--ag-warn-fg)]',
  bad: 'text-[color:var(--ag-bad-fg)]',
  neutral: 'text-[color:var(--ag-neutral-fg)]',
};

const TONE_DOT: Record<Tone, string> = {
  good: 'bg-[color:var(--ag-good-fg)]',
  info: 'bg-[color:var(--ag-info-fg)]',
  warn: 'bg-[color:var(--ag-warn-fg)]',
  bad: 'bg-[color:var(--ag-bad-fg)]',
  neutral: 'bg-[color:var(--ag-neutral-fg)]',
};

const STATUS_TONE: Record<string, Tone> = {
  // campaign
  DRAFT: 'neutral',
  SUBMITTED: 'warn',
  UNDER_REVIEW: 'warn',
  CHANGES_REQUESTED: 'warn',
  APPROVED: 'good',
  SCHEDULED: 'info',
  PUBLISHING: 'info',
  COMPLETED: 'good',
  PARTIALLY_FAILED: 'warn',
  PAUSED: 'neutral',
  FAILED: 'bad',
  CANCELLED: 'neutral',
  ARCHIVED: 'neutral',
  // posting job
  PENDING: 'info',
  SENDING: 'info',
  SUCCEEDED: 'good',
  BLOCKED: 'warn',
  DEAD: 'bad',
  UNCERTAIN: 'bad',
  // destination authorization
  ACTIVE: 'good',
  PENDING_VERIFICATION: 'warn',
  SUSPENDED: 'neutral',
  REVOKED: 'bad',
  EXPIRED: 'bad',
  DISCONNECTED: 'bad',
  // publishing event
  SUCCESS: 'good',
  SKIPPED: 'neutral',
  // deals
  PROSPECT: 'neutral',
  CONTACTED: 'info',
  PROPOSAL_SENT: 'warn',
  WON: 'good',
  LOST: 'bad',
  // invoices
  PAID: 'good',
  OVERDUE: 'bad',
};

const LABELS: Record<string, string> = {
  PENDING_VERIFICATION: 'Awaiting admin',
  PENDING: 'Queued',
  SENDING: 'Sending',
  SUCCEEDED: 'Delivered',
  BLOCKED: 'Paused',
  DEAD: 'Failed',
  UNCERTAIN: 'Needs check',
  ACTIVE: 'Authorized',
  PROPOSAL_SENT: 'Proposal sent',
};

export const humanize = (value: string) =>
  LABELS[value] ??
  value
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

export const ROLE_LABEL: Record<string, string> = {
  AGENCY_OWNER: 'Owner',
  AGENCY_ADMIN: 'Admin',
  SALES_MANAGER: 'Sales manager',
  SALES_EXECUTIVE: 'Sales executive',
  CAMPAIGN_MANAGER: 'Campaign manager',
  CONTENT_EDITOR: 'Content editor',
  ANALYST: 'Analyst',
  CLIENT: 'Client',
};
export const roleLabel = (key: string) => ROLE_LABEL[key] ?? humanize(key);

export const StatusBadge: FC<{
  status: string;
  /** Overrides the default wording where a status means something else in context. */
  label?: string;
  className?: string;
}> = ({ status, label, className }) => {
  const tone = STATUS_TONE[status] ?? 'neutral';
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border whitespace-nowrap',
        TONE_CLASS[tone],
        className
      )}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full', TONE_DOT[tone])} />
      {label ?? humanize(status)}
    </span>
  );
};

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-[var(--ag-accent)] hover:bg-[var(--ag-accent-hover)] text-[color:var(--ag-accent-fg)] border border-transparent',
  secondary:
    'bg-[var(--ag-surface-raised)] hover:bg-[var(--ag-neutral-bg)] text-newTextColor border border-[color:var(--ag-hairline)]',
  danger:
    'bg-transparent hover:bg-[var(--ag-bad-bg)] text-[color:var(--ag-bad-fg)] border border-[color:var(--ag-bad-line)]',
  ghost:
    'bg-transparent hover:bg-[var(--ag-neutral-bg)] text-textItemBlur hover:text-newTextColor border border-transparent',
};

const SIZE: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-4 text-sm',
};

export const btnClass = (variant: Variant = 'secondary', size: Size = 'sm') =>
  clsx(
    'inline-flex items-center justify-center gap-1.5 rounded-[10px] font-medium whitespace-nowrap select-none',
    'active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
    SIZE[size],
    VARIANT[variant]
  );

export const Btn: FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant;
    size?: Size;
    busy?: boolean;
  }
> = ({
  variant = 'secondary',
  size = 'sm',
  busy,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}) => (
  <button
    {...rest}
    type={type}
    disabled={disabled || busy}
    aria-busy={busy || undefined}
    className={clsx(btnClass(variant, size), className)}
  >
    {busy ? (
      <>
        <span
          className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin"
          aria-hidden="true"
        />
        <span>Working…</span>
      </>
    ) : (
      children
    )}
  </button>
);

/** A navigation link that looks like a button. */
export const LinkBtn: FC<{
  href: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
}> = ({ href, variant = 'secondary', size = 'sm', className, children }) => (
  <Link href={href} className={clsx(btnClass(variant, size), className)}>
    {children}
  </Link>
);

export const inputClass =
  'w-full rounded-[10px] bg-newBgColor border border-[color:var(--ag-hairline)] px-3 py-2 text-[13px] text-newTextColor ' +
  'placeholder:text-textItemBlur/70 hover:border-[color:var(--ag-neutral-line)] focus:border-[color:var(--ag-accent)] ' +
  'aria-[invalid=true]:border-[color:var(--ag-bad-fg)] disabled:opacity-60 transition-colors';

export const labelClass = 'block text-xs font-medium text-textItemBlur mb-1.5';

/** Which fields to show errors for: only after the person has touched them (or tried to submit). */
export const useTouched = () => {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  return {
    /** The error to display for `key`, or undefined while the field is still untouched. */
    show: (key: string, error?: string | null) =>
      touched[key] && error ? error : undefined,
    blur: (key: string) => () => setTouched((t) => ({ ...t, [key]: true })),
    all: (keys: string[]) =>
      setTouched(Object.fromEntries(keys.map((k) => [k, true]))),
  };
};

type FieldBase = {
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
};

const FieldShell: FC<
  FieldBase & { id: string; children: ReactNode; className?: string }
> = ({ id, label, hint, error, optional, children, className }) => (
  <div className={className}>
    <label htmlFor={id} className={labelClass}>
      {label}
      {optional && (
        <span className="font-normal text-textItemBlur/70"> · optional</span>
      )}
    </label>
    {children}
    {error ? (
      <p
        id={`${id}-msg`}
        role="alert"
        className="mt-1.5 text-xs text-[color:var(--ag-bad-fg)]"
      >
        {error}
      </p>
    ) : (
      hint && (
        <p id={`${id}-msg`} className="mt-1.5 text-xs text-textItemBlur">
          {hint}
        </p>
      )
    )}
  </div>
);

const describe = (id: string, hint?: string, error?: string) =>
  hint || error ? `${id}-msg` : undefined;

export const TextField: FC<
  FieldBase &
    Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id'> & {
      id?: string;
      wrapperClassName?: string;
    }
> = ({
  label,
  hint,
  error,
  optional,
  id,
  wrapperClassName,
  autoFocus,
  ...rest
}) => {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldShell
      id={fid}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      className={wrapperClassName}
    >
      <input
        {...rest}
        id={fid}
        data-autofocus={autoFocus || undefined}
        aria-invalid={!!error}
        aria-describedby={describe(fid, hint, error)}
        className={clsx(inputClass, rest.className)}
      />
    </FieldShell>
  );
};

export const TextArea: FC<
  FieldBase &
    Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> & {
      id?: string;
      wrapperClassName?: string;
    }
> = ({
  label,
  hint,
  error,
  optional,
  id,
  wrapperClassName,
  autoFocus,
  ...rest
}) => {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldShell
      id={fid}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      className={wrapperClassName}
    >
      <textarea
        {...rest}
        id={fid}
        data-autofocus={autoFocus || undefined}
        aria-invalid={!!error}
        aria-describedby={describe(fid, hint, error)}
        className={clsx(inputClass, 'resize-none', rest.className)}
      />
    </FieldShell>
  );
};

export const SelectField: FC<
  FieldBase &
    Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'id'> & {
      id?: string;
      wrapperClassName?: string;
    }
> = ({
  label,
  hint,
  error,
  optional,
  id,
  wrapperClassName,
  autoFocus,
  children,
  ...rest
}) => {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldShell
      id={fid}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      className={wrapperClassName}
    >
      <select
        {...rest}
        id={fid}
        data-autofocus={autoFocus || undefined}
        aria-invalid={!!error}
        aria-describedby={describe(fid, hint, error)}
        className={clsx(inputClass, rest.className)}
      >
        {children}
      </select>
    </FieldShell>
  );
};

export const CheckField: FC<
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & {
    children: ReactNode;
    error?: string;
  }
> = ({ children, error, ...rest }) => (
  <div>
    <label className="flex items-start gap-2.5 text-[13px] text-newTextColor cursor-pointer">
      <input
        {...rest}
        type="checkbox"
        aria-invalid={!!error}
        className="mt-0.5 h-4 w-4 rounded border-[color:var(--ag-neutral-line)] accent-[color:var(--ag-accent)]"
      />
      <span>{children}</span>
    </label>
    {error && (
      <p role="alert" className="mt-1.5 text-xs text-[color:var(--ag-bad-fg)]">
        {error}
      </p>
    )}
  </div>
);

// ---------------------------------------------------------------------------
// Dialog: focus is trapped while open and handed back on close
// ---------------------------------------------------------------------------
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export const Dialog: FC<{
  title: string;
  description?: ReactNode;
  onClose: () => void;
  /** While true the dialog cannot be dismissed (a request is in flight). */
  busy?: boolean;
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  footer?: ReactNode;
  /** Wrap in a <form> so Enter submits. */
  onSubmit?: (e: React.FormEvent) => void;
}> = ({
  title,
  description,
  onClose,
  busy,
  size = 'md',
  children,
  footer,
  onSubmit,
}) => {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [mounted, setMounted] = useState(false);
  const closeRef = useRef(onClose);
  const busyRef = useRef(!!busy);
  closeRef.current = onClose;
  busyRef.current = !!busy;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusables = () =>
      Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    (
      panel.current?.querySelector<HTMLElement>(
        '[data-autofocus], input:not([type=checkbox]), select, textarea'
      ) ??
      focusables().find((el) => !el.hasAttribute('data-dialog-close')) ??
      panel.current
    )?.focus();

    const onKey = (e: KeyboardEvent) => {
      // A confirmation opened from this dialog lives in the app's modal layer above it;
      // keys pressed there are not ours to handle.
      const active = document.activeElement;
      if (
        active &&
        active !== document.body &&
        !panel.current?.contains(active)
      ) {
        return;
      }
      if (e.key === 'Escape' && !busyRef.current) {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [mounted]);

  if (!mounted) return null;

  const Body = onSubmit ? 'form' : 'div';
  return createPortal(
    <div
      className="ag-scope fixed inset-0 z-[150] flex items-end sm:items-center justify-center sm:p-4 bg-[var(--ag-scrim)] backdrop-blur-sm ag-fade"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busyRef.current)
          closeRef.current();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={clsx(
          'ag-pop w-full max-h-[92vh] overflow-y-auto bg-newBgColorInner text-newTextColor',
          'rounded-t-3xl sm:rounded-2xl shadow-[var(--ag-shadow-pop)]',
          size === 'sm' && 'sm:max-w-sm',
          size === 'md' && 'sm:max-w-md',
          size === 'lg' && 'sm:max-w-xl'
        )}
      >
        <Body
          {...(onSubmit ? { onSubmit, noValidate: true } : {})}
          className="flex flex-col gap-5 p-6"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2
                id={titleId}
                className="text-[17px] font-semibold tracking-tight text-newTextColor"
              >
                {title}
              </h2>
              {description && (
                <p className="mt-1 text-[13px] leading-relaxed text-textItemBlur">
                  {description}
                </p>
              )}
            </div>
            <button
              type="button"
              data-dialog-close
              aria-label="Close"
              disabled={busy}
              onClick={onClose}
              className="-mr-2 -mt-1 p-2 rounded-lg text-textItemBlur hover:text-newTextColor hover:bg-[var(--ag-neutral-bg)] disabled:opacity-40"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
          {children}
          {footer && (
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
              {footer}
            </div>
          )}
        </Body>
      </div>
    </div>,
    document.body
  );
};

// ---------------------------------------------------------------------------
// Segmented tabs (filters): arrow keys move between options
// ---------------------------------------------------------------------------
export const Segmented = <T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string; count?: number }>;
  ariaLabel: string;
  className?: string;
}) => {
  const move = (dir: number, from: number) => {
    const next = options[(from + dir + options.length) % options.length];
    onChange(next.value);
    requestAnimationFrame(() =>
      document.getElementById(`seg-${ariaLabel}-${next.value}`)?.focus()
    );
  };
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={clsx(
        'inline-flex max-w-full overflow-x-auto gap-0.5 p-0.5 rounded-[11px] bg-[var(--ag-neutral-bg)] border border-[color:var(--ag-hairline)]',
        className
      )}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            id={`seg-${ariaLabel}-${o.value}`}
            role="tab"
            type="button"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') {
                e.preventDefault();
                move(1, i);
              } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                move(-1, i);
              }
            }}
            className={clsx(
              'px-3 h-7 rounded-[9px] text-[13px] font-medium whitespace-nowrap',
              selected
                ? 'bg-[var(--ag-surface-raised)] text-newTextColor shadow-[var(--ag-shadow)]'
                : 'text-textItemBlur hover:text-newTextColor'
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <span className="ml-1.5 text-[11px] text-textItemBlur">
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Overflow menu: secondary actions out of the way, one primary action in view
// ---------------------------------------------------------------------------
export type MenuItem = {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
};

export const Menu: FC<{ label?: string; items: MenuItem[] }> = ({
  label = 'More actions',
  items,
}) => {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    list.current
      ?.querySelector<HTMLElement>('[role=menuitem]:not([disabled])')
      ?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  if (!items.length) return null;

  const onKey = (e: React.KeyboardEvent) => {
    const els = Array.from(
      list.current?.querySelectorAll<HTMLElement>(
        '[role=menuitem]:not([disabled])'
      ) ?? []
    );
    const at = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      setOpen(false);
      root.current?.querySelector('button')?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      els[(at + 1) % els.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      els[(at - 1 + els.length) % els.length]?.focus();
    }
  };

  return (
    <div ref={root} className="relative" onKeyDown={onKey}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={btnClass('secondary', 'sm') + ' !px-2.5'}
      >
        <Icon name="more" size={16} />
      </button>
      {open && (
        <div
          ref={list}
          role="menu"
          className="ag-pop absolute right-0 z-30 mt-2 min-w-48 p-1.5 rounded-xl bg-[var(--ag-surface-raised)] shadow-[var(--ag-shadow-pop)] origin-top-right"
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              type="button"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className={clsx(
                'w-full text-left px-3 py-2 rounded-lg text-[13px] disabled:opacity-40',
                item.danger
                  ? 'text-[color:var(--ag-bad-fg)] hover:bg-[var(--ag-bad-bg)]'
                  : 'text-newTextColor hover:bg-[var(--ag-neutral-bg)]'
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Lifecycle stepper
// ---------------------------------------------------------------------------
export const Stepper: FC<{
  steps: Array<{ key: string; label: string }>;
  /** Index of the current step; steps before it are complete. */
  current: number;
  /** A problem at the current step (shown in the warning tone). */
  attention?: boolean;
}> = ({ steps, current, attention }) => (
  <ol
    className="flex items-center gap-1 overflow-x-auto pb-1"
    aria-label="Campaign progress"
  >
    {steps.map((s, i) => {
      const done = i < current;
      const here = i === current;
      return (
        <li
          key={s.key}
          className="flex items-center gap-1 shrink-0"
          aria-current={here ? 'step' : undefined}
        >
          <span
            className={clsx(
              'flex items-center gap-2 rounded-full pl-1 pr-3 py-1 text-xs font-medium border',
              done && TONE_CLASS.good,
              here &&
                !attention &&
                'bg-[var(--ag-accent-soft)] text-[color:var(--ag-accent-text)] border-[color:var(--ag-accent)]',
              here && attention && TONE_CLASS.warn,
              !done &&
                !here &&
                'text-textItemBlur border-[color:var(--ag-hairline)]'
            )}
          >
            <span
              className={clsx(
                'flex h-5 w-5 items-center justify-center rounded-full text-[10px]',
                done && 'bg-[color:var(--ag-good-fg)] text-newBgColorInner',
                here &&
                  !attention &&
                  'bg-[var(--ag-accent)] text-[color:var(--ag-accent-fg)]',
                here &&
                  attention &&
                  'bg-[color:var(--ag-warn-fg)] text-newBgColorInner',
                !done && !here && 'bg-[var(--ag-neutral-bg)]'
              )}
            >
              {done ? <Icon name="tick" size={11} /> : i + 1}
            </span>
            {s.label}
          </span>
          {i < steps.length - 1 && (
            <span
              aria-hidden="true"
              className={clsx(
                'h-px w-4 sm:w-6',
                done
                  ? 'bg-[color:var(--ag-good-line)]'
                  : 'bg-[var(--ag-hairline)]'
              )}
            />
          )}
        </li>
      );
    })}
  </ol>
);

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
export const PageShell: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="ag-scope ag-fade flex flex-col gap-8 px-4 sm:px-6 lg:px-8 py-6 sm:py-8 max-w-[1240px] mx-auto w-full">
    {children}
    <CommandPalette />
  </div>
);

export const PageHeader: FC<{
  title: string;
  subtitle?: string;
  /** Secondary navigation on detail screens, e.g. back to the list. */
  back?: { href: string; label: string };
  /** Shown beside the title, e.g. a status badge. */
  badge?: ReactNode;
  actions?: ReactNode;
}> = ({ title, subtitle, back, badge, actions }) => (
  <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
    <div className="min-w-0">
      {back && (
        <Link
          href={back.href}
          className="inline-flex items-center gap-1 mb-2 text-[13px] text-[color:var(--ag-accent-text)] hover:underline"
        >
          <Icon name="back" size={14} />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.02em] text-newTextColor break-words">
          {title}
        </h1>
        {badge}
      </div>
      {subtitle && (
        <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-textItemBlur">
          {subtitle}
        </p>
      )}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      {actions}
      <PaletteHint />
    </div>
  </header>
);

export const Card: FC<{
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}> = ({ title, subtitle, right, children, className }) => (
  <section
    className={clsx(
      'rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)] shadow-[var(--ag-shadow)] p-5 sm:p-6 flex flex-col gap-4',
      className
    )}
  >
    {(title || right) && (
      <div className="flex items-start justify-between gap-3">
        <div>
          {title && (
            <h2 className="text-[15px] font-semibold tracking-tight text-newTextColor">
              {title}
            </h2>
          )}
          {subtitle && (
            <p className="mt-0.5 text-[13px] text-textItemBlur">{subtitle}</p>
          )}
        </div>
        {right}
      </div>
    )}
    {children}
  </section>
);

export const Stat: FC<{
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: Tone;
  href?: string;
  linkLabel?: string;
}> = ({ label, value, hint, tone, href, linkLabel }) => (
  <div className="rounded-2xl bg-newBgColorInner border border-[color:var(--ag-hairline)] shadow-[var(--ag-shadow)] p-5 flex flex-col gap-1">
    <span className="text-xs font-medium text-textItemBlur">{label}</span>
    <span
      className={clsx(
        'text-[30px] leading-none font-semibold tracking-tight tabular-nums mt-1',
        tone ? TONE_TEXT[tone] : 'text-newTextColor'
      )}
    >
      {value}
    </span>
    <div className="flex items-end justify-between gap-2 mt-2">
      {hint && <span className="text-xs text-textItemBlur">{hint}</span>}
      {href && (
        <Link
          href={href}
          className="shrink-0 text-xs font-medium text-[color:var(--ag-accent-text)] hover:underline"
        >
          {linkLabel ?? 'Open'}
        </Link>
      )}
    </div>
  </div>
);

/** A message that belongs to the whole screen, e.g. “no dispatcher is running”. */
export const Notice: FC<{
  tone?: Tone;
  children: ReactNode;
  action?: ReactNode;
}> = ({ tone = 'info', children, action }) => (
  <div
    role={tone === 'bad' ? 'alert' : 'status'}
    className={clsx(
      'flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-[13px]',
      TONE_CLASS[tone]
    )}
  >
    <span className="flex items-start gap-2.5">
      <Icon name="alert" size={16} className="mt-0.5" />
      <span>{children}</span>
    </span>
    {action}
  </div>
);

export const EmptyState: FC<{
  title: string;
  hint?: string;
  icon?: IconName;
  action?: ReactNode;
}> = ({ title, hint, icon = 'inbox', action }) => (
  <div className="py-14 px-6 flex flex-col items-center justify-center text-center">
    <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--ag-neutral-bg)] text-textItemBlur">
      <Icon name={icon} size={22} />
    </span>
    <p className="mt-4 text-[15px] font-semibold text-newTextColor">{title}</p>
    {hint && (
      <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-textItemBlur">
        {hint}
      </p>
    )}
    {action && <div className="mt-5">{action}</div>}
  </div>
);

// ---------------------------------------------------------------------------
// Loading and errors
// ---------------------------------------------------------------------------
export const Skeleton: FC<{ className?: string }> = ({ className }) => (
  <div
    aria-hidden="true"
    className={clsx('ag-skeleton rounded-lg h-4', className)}
  />
);

export const Loading: FC<{ label?: string; rows?: number }> = ({
  label = 'Loading',
  rows = 4,
}) => (
  <div role="status" aria-busy="true" className="flex flex-col gap-3 py-2">
    <span className="sr-only">{label}</span>
    {Array.from({ length: rows }, (_, i) => (
      <Skeleton
        key={i}
        className={clsx('h-12 rounded-xl', i % 2 ? 'w-11/12' : 'w-full')}
      />
    ))}
  </div>
);

/** A load failure the user can act on, instead of an eternal spinner. */
export const LoadError: FC<{ error: Error; onRetry?: () => void }> = ({
  error,
  onRetry,
}) => (
  <Notice
    tone="bad"
    action={
      onRetry && (
        <Btn variant="danger" onClick={onRetry}>
          Try again
        </Btn>
      )
    }
  >
    {error.message || 'Something went wrong loading this view.'}
  </Notice>
);

// ---------------------------------------------------------------------------
// Tables: one look for every list
// ---------------------------------------------------------------------------
export const tableClass = {
  // relative: keeps the sr-only header labels inside the scroll area instead of the page
  wrap: 'relative overflow-x-auto -mx-1 px-1',
  table: 'w-full text-left text-[13px]',
  head: 'text-xs font-medium text-textItemBlur',
  th: 'py-2.5 px-3 font-medium',
  row: 'border-t border-[color:var(--ag-hairline)]',
  td: 'py-3.5 px-3 align-middle',
};

// ---------------------------------------------------------------------------
// Time and money
// ---------------------------------------------------------------------------
const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export const timeAgo = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return RTF.format(seconds, 'second');
  if (abs < 3600) return RTF.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return RTF.format(Math.round(seconds / 3600), 'hour');
  return RTF.format(Math.round(seconds / 86400), 'day');
};

export const formatDateTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—';

export const formatDate = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })
    : '—';

/** Audit summaries carry raw ISO timestamps; show them the way the person reads dates. */
export const prettySummary = (text?: string | null) =>
  text
    ? text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (iso) =>
        formatDateTime(iso)
      )
    : '';

export const money = (
  value: number | string | null | undefined,
  currency = 'USD'
) =>
  value === null || value === undefined || value === ''
    ? '—'
    : new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
        maximumFractionDigits: 0,
      }).format(Number(value));

/** Run an async action once at a time; returns the busy flag and a guarded runner. */
export const useBusy = () => {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
};
