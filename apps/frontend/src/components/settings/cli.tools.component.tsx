'use client';

import React, { FC, useState } from 'react';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  CliToolId,
  CliToolView,
  systemRequest,
  useCliTools,
} from '@gitroom/frontend/components/settings/system.hooks';
import {
  Btn,
  Card,
  Loading,
  LoadError,
  Notice,
  StatusBadge,
} from '@gitroom/frontend/components/agency/agency.ui';

// Where each tool is downloaded from, said before anything is downloaded.
const SOURCE: Record<CliToolId, string> = {
  antigravity: 'Google (antigravity.google)',
  claude: 'Anthropic (claude.ai)',
  codex: 'OpenAI (chatgpt.com)',
};

const SUMMARY: Record<CliToolId, string> = {
  antigravity:
    'Installed with AgencyOS. The default for ad copy and the Copilot.',
  claude: 'Downloaded only when you press Download.',
  codex: 'Downloaded only when you press Download.',
};

/**
 * Antigravity, Claude Code and Codex on this computer. Claude Code and Codex are downloaded only on
 * request; each is signed in through the vendor's own page in the browser, so no terminal is ever needed.
 */
export const CliToolsCard: FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const toaster = useToaster();
  const { data, error, mutate } = useCliTools();
  const [dismissed, setDismissed] = useState<string | null>(null);

  const post = async (path: string, tool?: CliToolId) => {
    try {
      await systemRequest('POST', `cli/${path}`, tool ? { tool } : {});
      await mutate();
    } catch (err) {
      toaster.show((err as Error).message, 'warning');
    }
  };

  const signOut = async (tool: CliToolView) => {
    if (
      !(await deleteDialog(
        `Sign out of ${tool.label}? AgencyOS stops using it until you sign in again.`,
        'Sign out',
        undefined,
        undefined,
        true
      ))
    ) {
      return;
    }
    await post('signout', tool.id);
  };

  if (error) {
    return (
      <Card title="Tools on this computer">
        <LoadError error={error} onRetry={() => mutate()} />
      </Card>
    );
  }
  if (!data) {
    return (
      <Card title="Tools on this computer">
        <Loading rows={3} />
      </Card>
    );
  }

  const task = data.task;
  const busy = !!task && ['working', 'waiting'].includes(task.state);
  const taskKey = task ? `${task.tool}-${task.action}-${task.state}` : '';
  const showResult =
    !!task && !busy && taskKey !== dismissed && (task.error || task.message);

  return (
    <Card
      title="Tools on this computer"
      subtitle="Antigravity comes with AgencyOS. Claude Code and Codex are downloaded only when you press Download. Signing in opens your browser: no terminal is needed."
    >
      {busy && task && (
        <Notice
          tone="info"
          action={
            canEdit ? (
              <Btn onClick={() => void post('cancel')}>Cancel</Btn>
            ) : undefined
          }
        >
          <span>
            {task.message}
            {task.state === 'waiting' && task.url && (
              <>
                {' '}
                If your browser did not open,{' '}
                <a
                  href={task.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline"
                >
                  open the sign-in page
                </a>
                .
              </>
            )}
          </span>
        </Notice>
      )}
      {showResult && task && (
        <Notice
          tone={task.state === 'failed' ? 'bad' : 'good'}
          action={<Btn onClick={() => setDismissed(taskKey)}>Dismiss</Btn>}
        >
          {task.error || task.message}
        </Notice>
      )}
      <ul className="divide-y divide-[color:var(--ag-hairline)]">
        {data.tools.map((tool) => (
          <li
            key={tool.id}
            className="flex flex-wrap items-center justify-between gap-3 py-3.5 first:pt-0 last:pb-0"
          >
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-newTextColor">
                {tool.label}
                {tool.version && (
                  <span className="ml-2 text-xs font-normal text-textItemBlur">
                    {tool.version}
                  </span>
                )}
              </p>
              <p className="text-xs text-textItemBlur">
                {tool.installed
                  ? tool.signedIn === true
                    ? 'Signed in.'
                    : tool.signedIn === false
                    ? 'Not signed in yet.'
                    : 'Installed. Press Check to see whether it is signed in.'
                  : `${SUMMARY[tool.id]} From ${SOURCE[tool.id]}.`}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {tool.installed && tool.signedIn === true && (
                <StatusBadge status="ACTIVE" label="Signed in" />
              )}
              {canEdit && !tool.installed && (
                <Btn
                  variant="primary"
                  disabled={busy}
                  onClick={() => void post('install', tool.id)}
                >
                  Download
                </Btn>
              )}
              {canEdit && tool.installed && tool.signedIn !== true && (
                <>
                  <Btn
                    variant="primary"
                    disabled={busy}
                    onClick={() => void post('login', tool.id)}
                  >
                    Sign in with your browser
                  </Btn>
                  <Btn
                    disabled={busy}
                    onClick={() => void post('check', tool.id)}
                  >
                    Check
                  </Btn>
                </>
              )}
              {canEdit &&
                tool.installed &&
                tool.signedIn === true &&
                tool.canSignOut && (
                  <Btn disabled={busy} onClick={() => void signOut(tool)}>
                    Sign out
                  </Btn>
                )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
};
