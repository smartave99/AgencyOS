import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AgencyRole } from '@prisma/client';
import { AgencyLeadsRepository, LeadFilters } from './agency.leads.repository';
import { AgencyRepository } from './agency.repository';
import { AgencyAccessService, AgencyActor } from './agency.access.service';
import {
  AgencyTelegramBotsService,
  BotHandle,
  SERVER_BOT,
} from './agency.telegram.bots.service';
import {
  CreateLeadLinkDto,
  UpdateLeadDto,
} from '@gitroom/nestjs-libraries/dtos/agency/lead.dto';

/** The message Telegram sends the bot when someone taps Start on a link. */
export interface StartedChat {
  chat: { id: number; type: string };
  from?: {
    id: number;
    is_bot?: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
}

const EXPORT_COLUMNS = [
  'Name',
  'Telegram username',
  'Source',
  'Campaign',
  'Status',
  'Started',
  'Notes',
] as const;

/**
 * Leads are people who asked to hear from the agency: they tapped Start on one of its bot links.
 * Nothing here collects anyone who did not, and there is no way to message or add people in bulk.
 * Every person can send /stop to the bot to have their details deleted and be left alone.
 */
@Injectable()
export class AgencyLeadsService {
  private readonly logger = new Logger(AgencyLeadsService.name);

  constructor(
    private readonly leads: AgencyLeadsRepository,
    private readonly agencyRepo: AgencyRepository,
    private readonly access: AgencyAccessService,
    private readonly bots: AgencyTelegramBotsService
  ) {}

  /** Sales executives work the leads from their own links; managers, admins and owners see all. */
  private scope(actor: AgencyActor) {
    return actor.role === AgencyRole.SALES_EXECUTIVE ? actor.userId : undefined;
  }

  private async requireLead(actor: AgencyActor, id: string) {
    const lead = await this.leads.getLead(actor.orgId, id);
    const mine = this.scope(actor);
    if (!lead || (mine && lead.leadLink?.createdById !== mine)) {
      throw new NotFoundException('Lead not found');
    }
    return lead;
  }

  // ==========================================
  // LINKS
  // ==========================================
  async createLink(actor: AgencyActor, dto: CreateLeadLinkDto) {
    this.access.assert(actor, 'crm:write');
    const label = dto.label.trim();
    if (!label) throw new BadRequestException('Give the link a name.');
    if (dto.campaignId) {
      const campaign = await this.agencyRepo.getCampaignById(
        actor.orgId,
        dto.campaignId
      );
      if (!campaign) throw new NotFoundException('Campaign not found');
    }
    const bot = await this.bots.chooseFor(actor.orgId, dto.botId);
    const link = await this.leads.createLink(actor.orgId, actor.userId, {
      label,
      code: randomBytes(8).toString('base64url'),
      campaignId: dto.campaignId,
      botId: bot.id,
      welcomeMessage: dto.welcomeMessage?.trim() || undefined,
    });
    await this.access.audit(actor, {
      action: 'lead_link.created',
      entityType: 'LeadLink',
      entityId: link.id,
      summary: label,
    });
    return { ...link, url: this.urlFor(bot.username, link.code) };
  }

  async listLinks(actor: AgencyActor) {
    this.access.assert(actor, 'crm:read');
    const [links, bots] = await Promise.all([
      this.leads.listLinks(actor.orgId, this.scope(actor)),
      this.bots.list(actor),
    ]);
    const names = new Map<string, string | null>([
      [SERVER_BOT, bots.server.username],
      ...bots.bots.map((b) => [b.id, b.username] as [string, string]),
    ]);
    return links.map((link) => {
      const username = names.get(link.botId ?? SERVER_BOT);
      return {
        ...link,
        url: username ? this.urlFor(username, link.code) : null,
      };
    });
  }

  async removeLink(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'crm:write');
    const link = await this.leads.getLinkById(actor.orgId, id);
    const mine = this.scope(actor);
    if (!link || (mine && link.createdById !== mine)) {
      throw new NotFoundException('Link not found');
    }
    await this.leads.deleteLink(actor.orgId, id);
    await this.access.audit(actor, {
      action: 'lead_link.deleted',
      entityType: 'LeadLink',
      entityId: id,
      summary: link.label,
    });
    return { deleted: true };
  }

  private urlFor(username: string, code: string) {
    return `https://t.me/${username}?start=${code}`;
  }

  // ==========================================
  // PEOPLE
  // ==========================================
  async list(actor: AgencyActor, filters: LeadFilters = {}) {
    this.access.assert(actor, 'crm:read');
    return this.leads.listLeads(actor.orgId, {
      ...filters,
      createdById: this.scope(actor),
    });
  }

  async update(actor: AgencyActor, id: string, dto: UpdateLeadDto) {
    this.access.assert(actor, 'crm:write');
    const lead = await this.requireLead(actor, id);
    if (lead.status === 'OPTED_OUT') {
      throw new BadRequestException(
        'This person asked to be left alone, so there is nothing to update.'
      );
    }
    const updated = await this.leads.updateLead(actor.orgId, id, {
      status: dto.status,
      notes: dto.notes === undefined ? undefined : dto.notes.trim() || null,
    });
    await this.access.audit(actor, {
      action: 'lead.updated',
      entityType: 'LeadCapture',
      entityId: id,
      summary: dto.status ?? 'notes',
    });
    return updated;
  }

  /** Deletes a person's details on request. */
  async erase(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'crm:write');
    await this.requireLead(actor, id);
    await this.leads.deleteLead(actor.orgId, id);
    await this.access.audit(actor, {
      action: 'lead.erased',
      entityType: 'LeadCapture',
      entityId: id,
    });
    return { deleted: true };
  }

  /** The people who are still happy to hear from the agency, as rows for CSV or JSON. */
  async exportRows(actor: AgencyActor, filters: LeadFilters = {}) {
    const rows = await this.list(actor, { ...filters, includeOptedOut: false });
    return rows.map((lead) => ({
      Name: lead.name ?? '',
      // Usernames are letters, digits and underscores, so the @ is left off: it would only be defused as a formula.
      'Telegram username': (lead.telegramHandle ?? '').replace(/^@/, ''),
      Source: lead.leadLink?.label ?? '',
      Campaign: lead.campaign?.name ?? '',
      Status: lead.status,
      Started: (lead.consentedAt ?? lead.createdAt).toISOString(),
      Notes: lead.notes ?? '',
    }));
  }

  async exportCsv(actor: AgencyActor, filters: LeadFilters = {}) {
    const rows = await this.exportRows(actor, filters);
    const cell = (value: string) => {
      let text = value;
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    return [
      EXPORT_COLUMNS.map(cell).join(','),
      ...rows.map((row) => EXPORT_COLUMNS.map((c) => cell(row[c])).join(',')),
    ].join('\r\n');
  }

  // ==========================================
  // WHAT THE BOT HEARS
  // ==========================================
  /** Someone tapped Start on a link. They asked to hear from the agency, so they are recorded. */
  async onStart(msg: StartedChat, code: string, bot: BotHandle) {
    const from = msg.from;
    if (msg.chat.type !== 'private' || !from || from.is_bot) return;
    const chatId = String(msg.chat.id);
    const link = await this.leads.getLinkByCode(code);
    // A link only works through the bot it was made for.
    if (
      !link ||
      link.botId !== bot.id ||
      (bot.orgId !== null && bot.orgId !== link.orgId)
    ) {
      await this.reply(bot, chatId, 'This link is not active any more.');
      return;
    }
    const name =
      [from.first_name, from.last_name].filter(Boolean).join(' ').trim() ||
      null;
    await this.leads.saveStarted(link, {
      telegramUserId: String(from.id),
      name,
      handle: from.username ? `@${from.username}` : null,
    });
    const agency = await this.agencyRepo.getOrganizationName(link.orgId);
    await this.reply(
      bot,
      chatId,
      [
        link.welcomeMessage,
        `Thanks for getting in touch with ${agency}. We saved your name and Telegram username so we can follow up about “${link.label}”. Send /stop at any time and we will delete them and leave you alone.`,
      ]
        .filter(Boolean)
        .join('\n\n')
    );
  }

  /** Someone sent /stop: their details go and they are not contacted. */
  async onStop(msg: StartedChat, bot: BotHandle) {
    const from = msg.from;
    if (msg.chat.type !== 'private' || !from || from.is_bot) return;
    const stopped = await this.leads.optOut(bot.id, String(from.id));
    await this.reply(
      bot,
      String(msg.chat.id),
      stopped > 0
        ? 'Done. We deleted your details and will not contact you. Tap Start on a link again if you change your mind.'
        : 'You are not on any list here, so there is nothing to delete.'
    );
  }

  private async reply(bot: BotHandle, chatId: string, text: string) {
    try {
      await bot.gateway.sendNotice(chatId, text);
    } catch (err: any) {
      this.logger.warn(`Could not reply in chat ${chatId}: ${err?.message}`);
    }
  }
}
