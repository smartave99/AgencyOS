'use client';

import React, { FC, useState } from 'react';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  TelegramBotView,
  useAgencyApi,
  useCan,
  useTelegramBots,
} from '@gitroom/frontend/components/agency/agency.hooks';
import {
  Btn,
  Card,
  EmptyState,
  Loading,
  LoadError,
  Menu,
  MenuItem,
  Notice,
  StatusBadge,
  TextField,
  TONE_TEXT,
  timeAgo,
  useBusy,
  useTouched,
} from '@gitroom/frontend/components/agency/agency.ui';

// What @BotFather hands out: 123456789:AAH…
const BOT_TOKEN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

/**
 * These panels sit inside the Settings page's own form, and forms cannot be nested: Enter in a
 * field submits the panel through this instead.
 */
const onEnter = (submit: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
    e.preventDefault();
    submit();
  }
};

const BADGE: Record<TelegramBotView['status'], string> = {
  ACTIVE: 'Connected',
  DISABLED: 'Paused',
  INVALID: 'Needs attention',
};

const BotRow: FC<{
  bot: TelegramBotView;
  canManage: boolean;
  onChanged: () => void;
}> = ({ bot, canManage, onChanged }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const { busy, run: runBusy } = useBusy();
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(bot.label);

  const run = (fn: () => Promise<unknown>, done?: string) =>
    runBusy(async () => {
      try {
        await fn();
        if (done) toaster.show(done, 'success');
        onChanged();
      } catch (e) {
        toaster.show((e as Error).message, 'warning');
      }
    });

  const menu: MenuItem[] = [
    {
      label: 'Rename',
      onClick: () => {
        setLabel(bot.label);
        setRenaming(true);
      },
    },
    bot.status === 'DISABLED'
      ? {
          label: 'Resume',
          onClick: () =>
            void run(
              () =>
                api.put(`/agency/telegram/bots/${bot.id}`, { enabled: true }),
              'Bot resumed'
            ),
        }
      : {
          label: 'Pause',
          onClick: async () => {
            if (
              await deleteDialog(
                `Pause "${bot.label}"? It stops listening and posting. ${
                  bot.destinationCount
                    ? `Posts for its ${bot.destinationCount} chat${
                        bot.destinationCount === 1 ? '' : 's'
                      } wait until you resume it.`
                    : ''
                }`,
                'Yes, pause it',
                undefined,
                undefined,
                true
              )
            ) {
              await run(
                () =>
                  api.put(`/agency/telegram/bots/${bot.id}`, {
                    enabled: false,
                  }),
                'Bot paused'
              );
            }
          },
        },
    {
      label: 'Remove',
      danger: true,
      onClick: async () => {
        if (
          await deleteDialog(
            `Remove "${bot.label}" (@${
              bot.username
            })? Its token is erased from this computer. ${
              bot.destinationCount
                ? `The ${bot.destinationCount} chat${
                    bot.destinationCount === 1 ? '' : 's'
                  } it serves stop posting; they are never handed to another bot.`
                : ''
            }`,
            'Yes, remove it',
            undefined,
            undefined,
            true
          )
        ) {
          await run(
            () => api.del(`/agency/telegram/bots/${bot.id}`),
            'Bot removed'
          );
        }
      },
    },
  ];

  const saveName = async () => {
    if (!label.trim()) return;
    await run(
      () => api.put(`/agency/telegram/bots/${bot.id}`, { label: label.trim() }),
      'Renamed'
    );
    setRenaming(false);
  };

  return (
    <li className="flex flex-col gap-3 py-4 border-t first:border-t-0 border-[color:var(--ag-hairline)] sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        {renaming ? (
          <div
            className="flex items-end gap-2"
            onKeyDown={onEnter(() => void saveName())}
          >
            <TextField
              label="Name"
              wrapperClassName="flex-1"
              value={label}
              maxLength={80}
              autoFocus
              onChange={(e) => setLabel(e.target.value)}
            />
            <Btn variant="primary" busy={busy} onClick={() => void saveName()}>
              Save
            </Btn>
            <Btn onClick={() => setRenaming(false)}>Cancel</Btn>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-semibold tracking-tight text-newTextColor">
                {bot.label}
              </span>
              <StatusBadge status={bot.status} label={BADGE[bot.status]} />
            </div>
            <div className="mt-0.5 text-xs text-textItemBlur">
              @{bot.username} · {bot.destinationCount} chat
              {bot.destinationCount === 1 ? '' : 's'}
              {bot.lastCheckedAt
                ? ` · checked ${timeAgo(bot.lastCheckedAt)}`
                : ''}
            </div>
            {bot.lastError && bot.status !== 'ACTIVE' && (
              <p className={`mt-1.5 text-[13px] ${TONE_TEXT.warn}`}>
                {bot.lastError}
              </p>
            )}
          </>
        )}
      </div>
      {canManage && !renaming && (
        <div className="flex shrink-0 items-center gap-2">
          <Btn
            busy={busy}
            onClick={() =>
              void run(
                () => api.post(`/agency/telegram/bots/${bot.id}/check`, {}),
                'Checked just now'
              )
            }
          >
            Check
          </Btn>
          <Menu items={menu} />
        </div>
      )}
    </li>
  );
};

const ConnectCard: FC<{ onConnected: () => void }> = ({ onConnected }) => {
  const api = useAgencyApi();
  const toaster = useToaster();
  const touched = useTouched();
  const { busy, run } = useBusy();
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const trimmed = token.trim();
  const labelError = label.trim()
    ? null
    : 'Give the bot a name you will recognise.';
  const tokenError = !trimmed
    ? 'Paste the bot token.'
    : !BOT_TOKEN.test(trimmed)
    ? 'That does not look like a bot token. It looks like 123456789:AAH… and comes from @BotFather.'
    : null;

  const submit = () => {
    touched.all(['label', 'token']);
    setProblem(null);
    if (labelError || tokenError) return;
    void run(async () => {
      try {
        const bot = await api.post<TelegramBotView>('/agency/telegram/bots', {
          label: label.trim(),
          token: trimmed,
        });
        toaster.show(`Connected @${bot.username}`, 'success');
        setLabel('');
        setToken('');
        touched.reset();
        onConnected();
      } catch (err) {
        setProblem((err as Error).message);
      }
    });
  };

  return (
    <Card
      title="Connect a bot"
      subtitle="Each bot is made in Telegram with @BotFather. You can connect as many as you like."
    >
      <ol className="flex list-decimal flex-col gap-1 ps-5 text-[13px] text-textItemBlur">
        <li>
          In Telegram, open <b className="text-newTextColor">@BotFather</b> and
          send <code>/newbot</code>.
        </li>
        <li>Choose a name and a username. BotFather replies with a token.</li>
        <li>Paste the token below. It is stored encrypted on this computer.</li>
      </ol>
      <div className="flex flex-col gap-4" onKeyDown={onEnter(submit)}>
        <TextField
          label="Name"
          placeholder="e.g. Acme Ads"
          value={label}
          maxLength={80}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={touched.blur('label')}
          error={touched.show('label', labelError)}
        />
        <TextField
          label="Bot token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          placeholder="123456789:AAH…"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setProblem(null);
          }}
          onBlur={touched.blur('token')}
          error={touched.show('token', tokenError)}
        />
        {problem && <Notice tone="bad">{problem}</Notice>}
        <div className="flex justify-end">
          <Btn variant="primary" busy={busy} onClick={submit}>
            Connect bot
          </Btn>
        </div>
      </div>
    </Card>
  );
};

export const TelegramBotsComponent: FC = () => {
  const { data, error, mutate } = useTelegramBots();
  const { can } = useCan();
  const canManage = can('bot:manage');

  return (
    <div className="ag-scope flex flex-col gap-6">
      <div>
        <h2 className="text-[20px] font-semibold tracking-tight">
          Telegram bots
        </h2>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-textItemBlur">
          Ads are posted by Telegram bots. Connect one bot for everything, or a
          bot per client or brand. Each chat is served by exactly one bot: that
          bot hears the chat’s <code>/authorize</code>, posts its ads and
          answers in it.
        </p>
      </div>

      {error ? (
        <LoadError error={error} onRetry={() => mutate()} />
      ) : !data ? (
        <Loading rows={2} />
      ) : (
        <Card
          title="Your bots"
          right={
            <span className="text-xs text-textItemBlur">
              {data.bots.length + (data.server.configured ? 1 : 0)} connected
            </span>
          }
        >
          {data.bots.length === 0 && !data.server.configured ? (
            <EmptyState
              icon="send"
              title="No bot connected yet"
              hint={
                canManage
                  ? 'Connect your first bot below. Until then nothing can be authorized or sent.'
                  : 'An owner or admin can connect a bot here.'
              }
            />
          ) : (
            <ul className="flex flex-col -my-2">
              {data.server.configured && (
                <li className="flex flex-col gap-1 py-4 border-t first:border-t-0 border-[color:var(--ag-hairline)]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-semibold tracking-tight text-newTextColor">
                      {data.server.label}
                    </span>
                    <StatusBadge status="ACTIVE" label="Connected" />
                  </div>
                  <div className="text-xs text-textItemBlur">
                    {data.server.username ? `@${data.server.username} · ` : ''}
                    set in this computer’s settings file
                    (AGENCY_TELEGRAM_BOT_TOKEN), so it can’t be changed here.
                  </div>
                </li>
              )}
              {data.bots.map((bot) => (
                <BotRow
                  key={bot.id}
                  bot={bot}
                  canManage={canManage}
                  onChanged={() => mutate()}
                />
              ))}
            </ul>
          )}
        </Card>
      )}

      {canManage ? (
        <ConnectCard onConnected={() => mutate()} />
      ) : (
        data && (
          <Notice tone="info">
            Only an owner or admin can connect, pause or remove bots.
          </Notice>
        )
      )}
    </div>
  );
};
