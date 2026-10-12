'use client';

import React, { FC, ReactNode } from 'react';
import Link from 'next/link';
import clsx from 'clsx';

// ---------------------------------------------------------------------------
// Status → colour. One place, so a status looks the same on every screen.
// ---------------------------------------------------------------------------
type Tone = 'good' | 'info' | 'warn' | 'bad' | 'neutral';

const TONE_CLASS: Record<Tone, string> = {
  good: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  info: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  warn: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  bad: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
  neutral: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
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

export const StatusBadge: FC<{ status: string; className?: string }> = ({
  status,
  className,
}) => (
  <span
    className={clsx(
      'inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border whitespace-nowrap',
      TONE_CLASS[STATUS_TONE[status] ?? 'neutral'],
      className
    )}
  >
    {humanize(status)}
  </span>
);

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
export const PageShell: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
    {children}
  </div>
);

export const PageHeader: FC<{
  crumb: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}> = ({ crumb, title, subtitle, actions }) => (
  <div className="flex flex-wrap items-center justify-between gap-4 border-b border-newBgLineColor pb-5">
    <div>
      <div className="flex items-center gap-2">
        <Link
          href="/agency/dashboard"
          className="text-xs text-blue-400 hover:underline"
        >
          ← Dashboard
        </Link>
        <span className="text-xs text-textItemBlur">/</span>
        <span className="text-xs text-textItemBlur">{crumb}</span>
      </div>
      <h1 className="text-2xl font-bold text-newTextColor tracking-tight mt-1">
        {title}
      </h1>
      {subtitle && (
        <p className="text-xs text-textItemBlur mt-0.5 max-w-2xl">{subtitle}</p>
      )}
    </div>
    {actions && <div className="flex items-center gap-2">{actions}</div>}
  </div>
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
      'bg-newBgColorInner border border-newBgLineColor rounded-2xl p-5 flex flex-col gap-4',
      className
    )}
  >
    {(title || right) && (
      <div className="flex items-center justify-between gap-3 border-b border-newBgLineColor pb-3">
        <div>
          {title && (
            <h2 className="text-sm font-bold text-newTextColor">{title}</h2>
          )}
          {subtitle && (
            <p className="text-xs text-textItemBlur mt-0.5">{subtitle}</p>
          )}
        </div>
        {right}
      </div>
    )}
    {children}
  </section>
);

export const EmptyState: FC<{
  title: string;
  hint?: string;
  action?: ReactNode;
}> = ({ title, hint, action }) => (
  <div className="py-12 flex flex-col items-center justify-center text-center">
    <p className="text-sm font-semibold text-newTextColor">{title}</p>
    {hint && <p className="text-xs text-textItemBlur mt-1 max-w-sm">{hint}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export const Loading: FC<{ label?: string }> = ({ label = 'Loading…' }) => (
  <div className="py-12 text-center text-xs text-textItemBlur" role="status">
    {label}
  </div>
);

/** A load failure the user can act on, instead of an eternal spinner. */
export const LoadError: FC<{ error: Error; onRetry?: () => void }> = ({
  error,
  onRetry,
}) => (
  <div
    role="alert"
    className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-4 text-xs text-rose-400 flex items-center justify-between gap-4"
  >
    <span>{error.message || 'Something went wrong loading this view.'}</span>
    {onRetry && (
      <button onClick={onRetry} className="underline font-semibold">
        Try again
      </button>
    )}
  </div>
);

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-blue-600 hover:bg-blue-500 text-white shadow-sm',
  secondary:
    'bg-newBgColor hover:bg-newBgColorInner text-newTextColor border border-newBgLineColor',
  danger:
    'bg-newBgColor hover:bg-rose-500/10 text-rose-400 border border-rose-500/30',
  ghost: 'text-textItemBlur hover:text-newTextColor',
};

export const Btn: FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant;
    busy?: boolean;
  }
> = ({
  variant = 'secondary',
  busy,
  className,
  children,
  disabled,
  ...rest
}) => (
  <button
    {...rest}
    disabled={disabled || busy}
    className={clsx(
      'px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed',
      VARIANT[variant],
      className
    )}
  >
    {busy ? 'Working…' : children}
  </button>
);

export const inputClass =
  'w-full bg-newBgColor border border-newBgLineColor rounded-lg px-3 py-2 text-xs text-newTextColor placeholder-textItemBlur focus:outline-none focus:border-blue-500';

export const labelClass =
  'block text-[11px] font-semibold text-textItemBlur uppercase mb-1';

// ---------------------------------------------------------------------------
// Time
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
  iso ? new Date(iso).toLocaleString() : '—';

export const formatDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString() : '—';

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
