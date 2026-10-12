'use client';

import React, { FC } from 'react';
import { useDashboard } from './agency.hooks';
import { Notice } from './agency.ui';

/**
 * Tells the truth about whether anything can actually be sent. Without a dispatcher a
 * “scheduled” campaign just waits, and without a bot token no destination can be
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
    <div className="flex flex-col gap-2">
      {issues.map((issue) => (
        <Notice key={issue.text} tone={issue.tone}>
          {issue.text}
        </Notice>
      ))}
    </div>
  );
};
