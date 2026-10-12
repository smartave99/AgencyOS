import {
  HttpException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AgencyAiRepository } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.ai.repository';
import { AgencyAiGatewayService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.ai.gateway.service';
import {
  AgencyAccessService,
  AgencyActor,
} from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import { AiProviderId } from '@gitroom/nestjs-libraries/dtos/agency/ai.settings.dto';

export type ToolStatus =
  | 'unknown'
  | 'current'
  | 'updated'
  | 'failed'
  | 'skipped'
  | 'manual';

export interface ToolView {
  id: AiProviderId;
  label: string;
  installed: boolean;
  version: string | null;
  autoUpdate: boolean;
  /** AgencyOS can run the tool's own updater. */
  canUpdate: boolean;
  status: ToolStatus;
  message: string | null;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
  manualHint: string;
}

/**
 * Only each tool's own updater is ever run: fixed arguments, no downloads and no package
 * manager of ours. Antigravity has no documented update command, so it is shown, not
 * touched (running an unknown word through it could start a chat instead).
 */
const UPDATERS: Partial<Record<AiProviderId, string[]>> = {
  'claude-cli': ['update'],
  'codex-cli': ['update'],
};

const MANUAL_HINT: Partial<Record<AiProviderId, string>> = {
  'claude-cli': 'Run “claude update” in a terminal.',
  'codex-cli':
    'Run “codex update” in a terminal, or update it the way you installed it (npm, Homebrew or winget).',
  'antigravity-cli':
    'AgencyOS has no documented update command for it. Update it the way you installed it, for example by running its installer again.',
};

const UPDATE_TIMEOUT_MS = 5 * 60_000;
const CHECK_EVERY_MS = 24 * 60 * 60_000;
const WAKE_EVERY_MS = 60 * 60_000;
const FIRST_CHECK_AFTER_MS = 3 * 60_000;

@Injectable()
export class AgencyAiToolsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgencyAiToolsService.name);
  private first: NodeJS.Timeout | null = null;
  private every: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly repo: AgencyAiRepository,
    private readonly gateway: AgencyAiGatewayService,
    private readonly access: AgencyAccessService
  ) {}

  private get enabledHere() {
    return (
      process.env.AGENCYOS_LOCAL === 'true' &&
      process.env.AGENCY_AI_TOOL_UPDATES !== 'off'
    );
  }

  onModuleInit() {
    if (!this.enabledHere) return;
    // Not at start-up, so opening the app is never slower; then hourly, acting once a day.
    this.first = setTimeout(() => void this.runDue(), FIRST_CHECK_AFTER_MS);
    this.every = setInterval(() => void this.runDue(), WAKE_EVERY_MS);
    this.first.unref();
    this.every.unref();
  }

  onModuleDestroy() {
    if (this.first) clearTimeout(this.first);
    if (this.every) clearInterval(this.every);
  }

  /** The daily pass: every installed tool whose own switch is on and that is due. */
  async runDue(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const cutoff = new Date(Date.now() - CHECK_EVERY_MS);
      for (const tool of this.gateway.cliTools()) {
        if (!(await this.gateway.findBinary(tool.binary))) continue;
        if (!(await this.repo.claimToolCheck(tool.id, cutoff))) continue;
        await this.update(tool.id);
      }
    } catch (error: any) {
      this.logger.warn(`Tool update pass failed: ${error?.message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Brings one tool up to date and records what happened. Never throws. */
  async update(id: AiProviderId): Promise<void> {
    const tool = this.gateway.cliTools().find((t) => t.id === id);
    if (!tool) return;
    const args = UPDATERS[id];
    try {
      if (!(await this.gateway.findBinary(tool.binary))) {
        await this.repo.recordTool(id, {
          status: 'unknown',
          message: 'Not installed.',
        });
        return;
      }
      const before = await this.gateway.toolVersion(id);
      if (!args) {
        await this.repo.recordTool(id, {
          version: before,
          status: 'manual',
          message: MANUAL_HINT[id] ?? null,
        });
        return;
      }
      if (this.gateway.activeCliRuns() > 0) {
        await this.repo.recordTool(id, {
          version: before,
          status: 'skipped',
          message: 'In use right now. AgencyOS will try again later.',
        });
        return;
      }
      // No await between the check above and this line: a request cannot slip in between.
      this.gateway.setUpdating(id, true);
      try {
        await this.gateway.runTool(id, args, UPDATE_TIMEOUT_MS);
      } finally {
        this.gateway.setUpdating(id, false);
      }
      const after = await this.gateway.toolVersion(id);
      const changed = !!before && !!after && before !== after;
      this.logger.log(
        `${id}: ${
          changed ? `updated ${before} -> ${after}` : 'already up to date'
        }`
      );
      await this.repo.recordTool(id, {
        version: after ?? before,
        status: changed ? 'updated' : 'current',
        message: changed
          ? `Updated from ${before} to ${after}.`
          : 'Up to date.',
        updated: changed,
      });
    } catch (error: any) {
      this.logger.warn(`${id}: update failed: ${error?.message}`);
      await this.repo
        .recordTool(id, {
          status: 'failed',
          message: `${String(error?.message ?? 'The update failed.').slice(
            0,
            240
          )} ${MANUAL_HINT[id] ?? ''}`.trim(),
        })
        .catch(() => undefined);
    }
  }

  // ----- what the settings page shows and does -----

  async list(actor: AgencyActor): Promise<{
    available: boolean;
    autoUpdate: boolean;
    tools: ToolView[];
  }> {
    this.access.assert(actor, 'ai:use');
    const local = process.env.AGENCYOS_LOCAL === 'true';
    const rows = new Map((await this.repo.listTools()).map((r) => [r.id, r]));
    const tools = await Promise.all(
      this.gateway.cliTools().map(async (tool): Promise<ToolView> => {
        const row = rows.get(tool.id);
        const installed =
          local && !!(await this.gateway.findBinary(tool.binary));
        const version = installed
          ? await this.gateway.toolVersion(tool.id)
          : undefined;
        return {
          id: tool.id,
          label: tool.label,
          installed,
          version: version ?? row?.version ?? null,
          autoUpdate: row?.autoUpdate ?? true,
          canUpdate: !!UPDATERS[tool.id],
          status: (row?.status as ToolStatus) ?? 'unknown',
          message: row?.message ?? null,
          lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
          lastUpdatedAt: row?.lastUpdatedAt?.toISOString() ?? null,
          manualHint: MANUAL_HINT[tool.id] ?? '',
        };
      })
    );
    return {
      available: local && process.env.AGENCY_AI_TOOL_UPDATES !== 'off',
      autoUpdate: tools.every((t) => t.autoUpdate),
      tools,
    };
  }

  async setAutoUpdate(actor: AgencyActor, enabled: boolean) {
    this.access.assert(actor, 'ai:configure');
    await this.repo.setToolsAutoUpdate(
      this.gateway.cliTools().map((t) => t.id),
      enabled
    );
    await this.access.audit(actor, {
      action: 'ai.tools_auto_update',
      entityType: 'AgencyAiTool',
      summary: enabled
        ? 'Automatic tool updates on'
        : 'Automatic tool updates off',
    });
    return this.list(actor);
  }

  /** The "Update now" button: one tool, or every installed one. */
  async updateNow(actor: AgencyActor, id?: AiProviderId) {
    this.access.assert(actor, 'ai:configure');
    if (process.env.AGENCYOS_LOCAL !== 'true') {
      throw new HttpException(
        'Command-line tools can only be updated in the AgencyOS desktop app',
        400
      );
    }
    const ids = id ? [id] : this.gateway.cliTools().map((t) => t.id);
    for (const one of ids) {
      if (!this.gateway.cliTools().some((t) => t.id === one)) {
        throw new HttpException('That is not a command-line tool', 400);
      }
      await this.update(one);
    }
    return this.list(actor);
  }
}
