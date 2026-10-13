'use client';

import React, { FC } from 'react';
import { useDashboard } from './agency.hooks';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { LinkBtn, Notice } from './agency.ui';

/**
 * Tells the truth about whether anything can actually be sent. Without a dispatcher a
 * “scheduled” campaign just waits, and without a bot token no destination can be
 * authorized, so both are surfaced instead of implied.
 */
export const SystemBanner: FC = () => {
  const { data } = useDashboard();
  const { isLocal } = useVariables();
  if (!data?.system) return null;
  const { dispatcher, telegram } = data.system;

  // Bots are connected inside the app (Settings → Telegram bots), on a person's own computer and on
  // a server alike.
  const issues: Array<{
    tone: 'bad' | 'warn';
    text: string;
    action?: boolean;
  }> = [];
  if (!telegram.configured) {
    issues.push({
      tone: 'bad',
      text: 'No Telegram bot is connected yet, so no chat can be authorized and nothing can be sent. Add a bot token (from @BotFather) to connect one.',
      action: true,
    });
  } else if (!telegram.listening) {
    issues.push({
      tone: 'warn',
      text: isLocal
        ? 'AgencyOS is still connecting to Telegram. Until it is, a group admin’s /authorize or /revoke will not be seen. If this stays, restart AgencyOS from the tray icon.'
        : 'AgencyOS is not listening for Telegram updates, so a group admin’s /authorize or /revoke will not be seen. Start the scheduler (AGENCY_SCHEDULER_ENABLED=true) or configure the webhook.',
    });
  }
  if (!dispatcher.online) {
    issues.push({
      tone: 'warn',
      text: isLocal
        ? 'The part of AgencyOS that sends campaigns is not running, so scheduled campaigns will wait. Restart AgencyOS from the tray icon.'
        : 'No publishing dispatcher is running. Scheduled campaigns will wait until one starts (AGENCY_SCHEDULER_ENABLED=true).',
    });
  }
  if (issues.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {issues.map((issue) => (
        <Notice
          key={issue.text}
          tone={issue.tone}
          action={
            issue.action ? (
              <LinkBtn href="/settings?tab=telegram" variant="primary">
                Connect a Telegram bot
              </LinkBtn>
            ) : undefined
          }
        >
          {issue.text}
        </Notice>
      ))}
    </div>
  );
};
