'use client';

import React, { FC } from 'react';
import { useDashboard } from './agency.hooks';

/**
 * Tells the truth about whether anything can actually be sent. Without a dispatcher a
 * "scheduled" campaign just waits, and without a bot token no destination can be
 * authorized, so both are surfaced instead of implied.
 */
export const SystemBanner: FC = () => {
  const { data } = useDashboard();
  if (!data?.system) return null;
  const { dispatcher, telegram } = data.system;

  const issues: Array<{ tone: 'bad' | 'warn'; text: string }> = [];
  if (!telegram.configured) {
    issues.push({
      tone: 'bad',
      text: 'No Telegram bot is configured on this server (set AGENCY_TELEGRAM_BOT_TOKEN). Destinations cannot be authorized and nothing can be sent.',
    });
  } else if (!telegram.listening) {
    issues.push({
      tone: 'warn',
      text: 'AgencyOS is not listening for Telegram updates, so a group admin’s /authorize or /revoke will not be seen. Start the scheduler (AGENCY_SCHEDULER_ENABLED=true) or configure the webhook.',
    });
  }
  if (!dispatcher.online) {
    issues.push({
      tone: 'warn',
      text: 'No publishing dispatcher is running. Scheduled campaigns will wait until one starts (AGENCY_SCHEDULER_ENABLED=true).',
    });
  }
  if (issues.length === 0) return null;

  return (
    <div className="flex flex-col gap-2" role="status">
      {issues.map((issue) => (
        <div
          key={issue.text}
          className={
            issue.tone === 'bad'
              ? 'rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-400'
              : 'rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-400'
          }
        >
          {issue.text}
        </div>
      ))}
    </div>
  );
};
