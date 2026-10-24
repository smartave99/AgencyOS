'use client';

import React, { FC, useState } from 'react';
import {
  DestinationView,
  TelegramBots,
  useCan,
  useTelegramBots,
  useTelegramDestinations,
} from '@gitroom/frontend/components/agency/agency.hooks';
import { useTelegramUserAccounts } from '@gitroom/frontend/components/agency/telegram.users.hooks';
import {
  BackupBotsDialog,
  botName,
  STRATEGY,
} from '@gitroom/frontend/components/agency/telegram.component';
import {
  Btn,
  Card,
  EmptyState,
  formatDateTime,
  LoadError,
  Loading,
  SelectField,
  StatusBadge,
  timeAgo,
} from '@gitroom/frontend/components/agency/agency.ui';

const MAIN = (d: DestinationView) => d.botId ?? 'server';

/** Until when Telegram asked this bot to wait, if the wait is still going. */
const slowedUntil = (bots: TelegramBots | undefined, key: string) => {
  const until = bots?.bots.find((b) => b.id === key)?.rateLimitedUntil;
  return until && new Date(until) > new Date() ? until : null;
};

/** Is the bot that serves this chat one that can post right now? */
const mainProblem = (d: DestinationView, bots: TelegramBots | undefined) => {
  if (d.senderKind === 'USER_ACCOUNT') return null;
  if (MAIN(d) === 'server') {
    return bots?.server.configured
      ? null
      : 'The bot from the settings is not set up.';
  }
  const bot = bots?.bots.find((b) => b.id === MAIN(d));
  if (!bot) return 'Its bot was removed. Connect the chat again.';
  if (bot.status === 'DISABLED') return 'Its bot is paused.';
  if (bot.status === 'INVALID') return 'Telegram no longer accepts its bot.';
  return null;
};

/**
 * Which bot or account posts to which chat, in one place: the main bot, the backups and how they share the
 * work, whether a bot is being slowed down by Telegram, and who sent the last post. Changing it uses the same
 * steps as the Telegram page; nothing here moves a chat by itself.
 */
export const BotAssignments: FC = () => {
  const { can } = useCan();
  const canManage = can('destination:manage');
  const destinations = useTelegramDestinations();
  const bots = useTelegramBots();
  const accounts = useTelegramUserAccounts();
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState<DestinationView | null>(null);

  const accountLabel = (id: string | null | undefined) =>
    accounts.data?.find((a) => a.id === id)?.label ?? 'A Telegram account';

  const rows = (destinations.data ?? []).filter((d) => {
    if (filter === 'all') return true;
    if (filter === 'attention') return !!mainProblem(d, bots.data);
    if (filter === 'accounts') return d.senderKind === 'USER_ACCOUNT';
    return d.senderKind !== 'USER_ACCOUNT' && MAIN(d) === filter;
  });

  const filterOptions = [
    { key: 'all', label: 'All chats' },
    { key: 'attention', label: 'Chats whose bot cannot post' },
    ...(bots.data?.server.configured
      ? [{ key: 'server', label: bots.data.server.label }]
      : []),
    ...(bots.data?.bots ?? []).map((b) => ({
      key: b.id,
      label: `${b.label} (@${b.username})`,
    })),
    { key: 'accounts', label: 'Chats posted to by an account' },
  ];

  return (
    <Card
      title="Which bot posts where"
      subtitle="The main bot of each chat, its backups and how they share the work. A bot that Telegram slowed down keeps its posts; they wait for it."
      right={
        <SelectField
          label="Show"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          {filterOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </SelectField>
      }
    >
      {!destinations.data || !bots.data ? (
        destinations.error || bots.error ? (
          <LoadError
            error={destinations.error ?? bots.error}
            onRetry={() => {
              void destinations.mutate();
              void bots.mutate();
            }}
          />
        ) : (
          <Loading rows={2} />
        )
      ) : destinations.data.length === 0 ? (
        <EmptyState
          icon="send"
          title="No chats yet"
          hint="Add a chat on the Telegram page. The bot that serves it is chosen there."
        />
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-textItemBlur">No chat matches.</p>
      ) : (
        <ul>
          {rows.map((d) => {
            const byAccount = d.senderKind === 'USER_ACCOUNT';
            const problem = mainProblem(d, bots.data);
            const slowed = byAccount ? null : slowedUntil(bots.data, MAIN(d));
            return (
              <li
                key={d.id}
                className="flex flex-col gap-1.5 border-t first:border-t-0 border-[color:var(--ag-hairline)] py-3 text-[13px]"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-newTextColor">
                    {d.title}
                  </span>
                  <span className="text-textItemBlur">{d.type}</span>
                  <StatusBadge status={d.authorizationStatus} />
                  {slowed && (
                    <StatusBadge
                      status="RATE_LIMITED"
                      label={`Slowed until ${formatDateTime(slowed)}`}
                    />
                  )}
                  <span className="grow" />
                  {canManage && !byAccount && (
                    <Btn onClick={() => setEditing(d)}>Change bots</Btn>
                  )}
                </div>
                {byAccount ? (
                  <span className="text-textItemBlur">
                    Posted to by{' '}
                    <b className="text-newTextColor">
                      {accountLabel(d.userAccountId)}
                    </b>
                    , a Telegram account. Its limits are on the Accounts list
                    above, and no bot takes over.
                  </span>
                ) : (
                  <>
                    <span className="text-textItemBlur">
                      Main bot:{' '}
                      <b className="text-newTextColor">
                        {botName(bots.data, MAIN(d))}
                      </b>
                      {d.backupBotIds.length > 0 && (
                        <>
                          {' · '}Backups:{' '}
                          {d.backupBotIds
                            .map((key) => {
                              const wait = slowedUntil(bots.data, key);
                              return `${botName(bots.data, key)}${
                                wait ? ' (slowed)' : ''
                              }`;
                            })
                            .join(', ')}{' '}
                          · {STRATEGY[d.botStrategy].short}
                        </>
                      )}
                      {d.lastBotId !== null && d.lastBotId !== undefined && (
                        <>
                          {' · '}Last post by {botName(bots.data, d.lastBotId)}
                          {d.lastSuccessfulPostAt
                            ? `, ${timeAgo(d.lastSuccessfulPostAt)}`
                            : ''}
                        </>
                      )}
                    </span>
                    {problem && (
                      <span className="text-[color:var(--ag-bad-fg)]">
                        {problem}
                      </span>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editing && bots.data && (
        <BackupBotsDialog
          d={editing}
          bots={bots.data}
          onClose={() => setEditing(null)}
          onChanged={() => {
            void destinations.mutate();
            void bots.mutate();
          }}
        />
      )}
    </Card>
  );
};
