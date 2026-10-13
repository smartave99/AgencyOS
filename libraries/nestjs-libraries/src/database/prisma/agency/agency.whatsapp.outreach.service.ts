import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, WhatsappTaskStatus } from '@prisma/client';
import {
  AgencyWhatsappRepository,
  WhatsappSegmentFilter,
  WhatsappTaskRow,
} from './agency.whatsapp.repository';
import {
  chatLink,
  DEFAULT_OPT_OUT_LINE,
  maskPhone,
  normaliseLanguage,
  normaliseTags,
} from './agency.whatsapp.service';
import { AgencyRepository } from './agency.repository';
import { AgencyAccessService, AgencyActor } from './agency.access.service';
import {
  AgencyAiGatewayService,
  AiProviderError,
} from './agency.ai.gateway.service';
import {
  DraftWhatsappTasksDto,
  PreviewWhatsappSegmentDto,
  PreviewWhatsappTemplateDto,
  SaveWhatsappSegmentDto,
  SaveWhatsappTemplateDto,
  SetWhatsappTaskStatusDto,
  SuggestWhatsappWordingDto,
  UpdateWhatsappTaskDto,
  WHATSAPP_LIMITS,
  WHATSAPP_PLACEHOLDERS,
} from '@gitroom/nestjs-libraries/dtos/agency/whatsapp.dto';

// ---------------------------------------------------------------------------------------------
// Message text
// ---------------------------------------------------------------------------------------------
const PLACEHOLDER = /\{\{\s*([A-Za-z_]+)\s*\}\}/g;
const ALLOWED: readonly string[] = WHATSAPP_PLACEHOLDERS;

const NO_OPT_OUT_WARNING =
  'This message has no way to opt out. Keep a line such as “Reply STOP to opt out.” unless you have a good reason to leave it out.';

/** What is wrong with a message's wording, in words a person can act on. Empty means fine. */
export function templateProblems(body: string): string[] {
  const problems: string[] = [];
  if (!body.trim()) problems.push('Write the message.');
  const unknown = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER)) {
    if (!ALLOWED.includes(match[1].toLowerCase())) unknown.add(match[1]);
  }
  if (unknown.size) {
    problems.push(
      `${[...unknown].map((u) => `{{${u}}}`).join(', ')} ${
        unknown.size === 1 ? 'is' : 'are'
      } not a placeholder AgencyOS knows. Use ${ALLOWED.map(
        (a) => `{{${a}}}`
      ).join(', ')}.`
    );
  }
  const rest = body.replace(PLACEHOLDER, '');
  if (rest.includes('{{') || rest.includes('}}')) {
    problems.push('A {{placeholder}} is not closed.');
  }
  return problems;
}

/**
 * The finished message: the wording with the person's details filled in, then the link, then the
 * opt-out line. A placeholder with nothing to fill it is reported, never replaced by a guess.
 */
export function renderMessage(
  template: { body: string; link: string | null; optOutLine: string },
  person: { name: string; company: string | null },
  agency: string
) {
  const values: Record<string, string> = {
    name: person.name,
    first_name: person.name.split(' ')[0] ?? '',
    company: person.company ?? '',
    agency,
  };
  const missing = new Set<string>();
  const text = template.body.replace(PLACEHOLDER, (_all, key: string) => {
    const name = key.toLowerCase();
    if (!values[name]) missing.add(name);
    return values[name] ?? '';
  });
  const parts = [
    text.trim(),
    template.link?.trim(),
    template.optOutLine.trim(),
  ];
  return {
    message: parts.filter(Boolean).join('\n\n'),
    missing: [...missing],
  };
}

const STATUS_WORDS: Record<WhatsappTaskStatus, string> = {
  PENDING: 'waiting',
  SENT_BY_USER: 'marked sent by you',
  REPLIED: 'replied',
  SKIPPED: 'skipped',
};

/**
 * Where a task may go. Every step is something a person did or said; there is no state for
 * "delivered" or "read", because AgencyOS cannot see either and would only be guessing.
 */
export const TASK_TRANSITIONS: Record<
  WhatsappTaskStatus,
  WhatsappTaskStatus[]
> = {
  PENDING: ['SENT_BY_USER', 'SKIPPED'],
  SENT_BY_USER: ['REPLIED', 'PENDING'],
  REPLIED: ['SENT_BY_USER'],
  SKIPPED: ['PENDING'],
};

const SUGGEST_SYSTEM = `You write short WhatsApp messages for an advertising agency that only contacts people who already agreed to hear from it.
Write plain text: no HTML, no markdown, no hashtags. Be friendly and brief, under 600 characters.
You may use only these placeholders, written exactly like this: ${ALLOWED.map(
  (a) => `{{${a}}}`
).join(', ')}.
Do not invent offers, prices, dates or facts that are not in the brief. Do not add an opt-out line or a signature: the app adds the opt-out line.
Reply with the message text only.`;

export function cleanSuggestion(raw: string) {
  return raw
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(PLACEHOLDER, (all, key: string) =>
      ALLOWED.includes(key.toLowerCase()) ? `{{${key.toLowerCase()}}}` : ''
    )
    .trim()
    .replace(/^["“”]+|["“”]+$/g, '')
    .trim()
    .slice(0, 1000);
}

type SegmentRow = NonNullable<
  Awaited<ReturnType<AgencyWhatsappRepository['getSegment']>>
>;
type TemplateRow = NonNullable<
  Awaited<ReturnType<AgencyWhatsappRepository['getTemplate']>>
>;

const filterOf = (s: {
  tags: string[];
  languages: string[];
  consentSources: string[];
}): WhatsappSegmentFilter => ({
  tags: s.tags,
  languages: s.languages,
  consentSources: s.consentSources,
});

/**
 * Segments, wording and the work list. A person prepares the message here and sends it themselves
 * in WhatsApp: AgencyOS makes the click-to-chat link on request, for one task at a time, and the
 * only record of what happened is what the person marks. There is no sender, no timer, and no way
 * to open many chats at once.
 */
@Injectable()
export class AgencyWhatsappOutreachService {
  private readonly logger = new Logger(AgencyWhatsappOutreachService.name);

  constructor(
    private readonly repo: AgencyWhatsappRepository,
    private readonly agencyRepo: AgencyRepository,
    private readonly access: AgencyAccessService,
    private readonly ai: AgencyAiGatewayService
  ) {}

  // ==========================================================================================
  // SEGMENTS
  // ==========================================================================================
  private normaliseFilter(
    dto: PreviewWhatsappSegmentDto
  ): WhatsappSegmentFilter {
    const languages = (dto.languages ?? []).map((l) => {
      const parsed = normaliseLanguage(l);
      if ('error' in parsed) throw new BadRequestException(parsed.error);
      return parsed.language;
    });
    return {
      tags: normaliseTags(dto.tags),
      languages: [...new Set(languages.filter(Boolean))] as string[],
      consentSources: [
        ...new Set(
          (dto.consentSources ?? []).map((s) => s.trim()).filter(Boolean)
        ),
      ],
    };
  }

  private async segmentView(orgId: string, segment: SegmentRow) {
    return {
      id: segment.id,
      name: segment.name,
      tags: segment.tags,
      languages: segment.languages,
      consentSources: segment.consentSources,
      // Counted now, from the contacts who are opted in now.
      memberCount: await this.repo.countMembers(orgId, filterOf(segment)),
      createdAt: segment.createdAt,
    };
  }

  async listSegments(actor: AgencyActor) {
    this.access.assert(actor, 'whatsapp:read');
    const segments = await this.repo.listSegments(actor.orgId);
    return Promise.all(segments.map((s) => this.segmentView(actor.orgId, s)));
  }

  async previewSegment(actor: AgencyActor, dto: PreviewWhatsappSegmentDto) {
    this.access.assert(actor, 'whatsapp:read');
    return {
      memberCount: await this.repo.countMembers(
        actor.orgId,
        this.normaliseFilter(dto)
      ),
    };
  }

  private async requireSegment(actor: AgencyActor, id: string) {
    const segment = await this.repo.getSegment(actor.orgId, id);
    if (!segment) throw new NotFoundException('Segment not found');
    return segment;
  }

  async createSegment(actor: AgencyActor, dto: SaveWhatsappSegmentDto) {
    this.access.assert(actor, 'whatsapp:write');
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Give the segment a name.');
    let segment: SegmentRow;
    try {
      segment = await this.repo.createSegment(actor.orgId, {
        name,
        ...this.normaliseFilter(dto),
        createdById: actor.userId,
      });
    } catch (err) {
      this.rethrowDuplicate(err, 'A segment with this name already exists.');
    }
    await this.access.audit(actor, {
      action: 'whatsapp_segment.created',
      entityType: 'WhatsappSegment',
      entityId: segment.id,
      summary: name,
    });
    return this.segmentView(actor.orgId, segment);
  }

  async updateSegment(
    actor: AgencyActor,
    id: string,
    dto: SaveWhatsappSegmentDto
  ) {
    this.access.assert(actor, 'whatsapp:write');
    await this.requireSegment(actor, id);
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Give the segment a name.');
    let segment: SegmentRow;
    try {
      segment = await this.repo.updateSegment(actor.orgId, id, {
        name,
        ...this.normaliseFilter(dto),
      });
    } catch (err) {
      this.rethrowDuplicate(err, 'A segment with this name already exists.');
    }
    await this.access.audit(actor, {
      action: 'whatsapp_segment.updated',
      entityType: 'WhatsappSegment',
      entityId: id,
      summary: name,
    });
    return this.segmentView(actor.orgId, segment);
  }

  async deleteSegment(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'whatsapp:write');
    const segment = await this.requireSegment(actor, id);
    await this.repo.deleteSegment(actor.orgId, id);
    await this.access.audit(actor, {
      action: 'whatsapp_segment.deleted',
      entityType: 'WhatsappSegment',
      entityId: id,
      summary: segment.name,
    });
    return { deleted: true };
  }

  private rethrowDuplicate(err: unknown, message: string): never {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new ConflictException(message);
    }
    throw err;
  }

  // ==========================================================================================
  // TEMPLATES
  // ==========================================================================================
  private templateView(template: TemplateRow) {
    return {
      id: template.id,
      name: template.name,
      body: template.body,
      language: template.language,
      link: template.link,
      optOutLine: template.optOutLine,
      // Shown on the list: a template that leaves the opt-out out says so.
      optOutMissing: !template.optOutLine.trim(),
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    };
  }

  private async defaultOptOutLine(orgId: string) {
    return (
      (await this.repo.getSettings(orgId))?.defaultOptOutLine ??
      DEFAULT_OPT_OUT_LINE
    );
  }

  private checkWording(body: string) {
    const problems = templateProblems(body);
    if (problems.length) throw new BadRequestException(problems.join(' '));
  }

  async listTemplates(actor: AgencyActor) {
    this.access.assert(actor, 'whatsapp:read');
    return (await this.repo.listTemplates(actor.orgId)).map((t) =>
      this.templateView(t)
    );
  }

  async createTemplate(actor: AgencyActor, dto: SaveWhatsappTemplateDto) {
    this.access.assert(actor, 'whatsapp:write');
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Give the template a name.');
    this.checkWording(dto.body);
    const language = normaliseLanguage(dto.language);
    if ('error' in language) throw new BadRequestException(language.error);
    let template: TemplateRow;
    try {
      template = await this.repo.createTemplate(actor.orgId, {
        name,
        body: dto.body.trim(),
        language: language.language,
        link: dto.link?.trim() || null,
        optOutLine:
          dto.optOutLine === undefined
            ? await this.defaultOptOutLine(actor.orgId)
            : dto.optOutLine.trim(),
        createdById: actor.userId,
      });
    } catch (err) {
      this.rethrowDuplicate(err, 'A template with this name already exists.');
    }
    await this.access.audit(actor, {
      action: 'whatsapp_template.created',
      entityType: 'WhatsappTemplate',
      entityId: template.id,
      summary: name,
    });
    return this.templateView(template);
  }

  async updateTemplate(
    actor: AgencyActor,
    id: string,
    dto: SaveWhatsappTemplateDto
  ) {
    this.access.assert(actor, 'whatsapp:write');
    if (!(await this.repo.getTemplate(actor.orgId, id))) {
      throw new NotFoundException('Template not found');
    }
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Give the template a name.');
    this.checkWording(dto.body);
    const language = normaliseLanguage(dto.language);
    if ('error' in language) throw new BadRequestException(language.error);
    let template: TemplateRow;
    try {
      template = await this.repo.updateTemplate(actor.orgId, id, {
        name,
        body: dto.body.trim(),
        language: language.language,
        link: dto.link?.trim() || null,
        ...(dto.optOutLine === undefined
          ? {}
          : { optOutLine: dto.optOutLine.trim() }),
      });
    } catch (err) {
      this.rethrowDuplicate(err, 'A template with this name already exists.');
    }
    await this.access.audit(actor, {
      action: 'whatsapp_template.updated',
      entityType: 'WhatsappTemplate',
      entityId: id,
      summary: name,
    });
    return this.templateView(template);
  }

  async deleteTemplate(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'whatsapp:write');
    const template = await this.repo.getTemplate(actor.orgId, id);
    if (!template) throw new NotFoundException('Template not found');
    await this.repo.deleteTemplate(actor.orgId, id);
    await this.access.audit(actor, {
      action: 'whatsapp_template.deleted',
      entityType: 'WhatsappTemplate',
      entityId: id,
      summary: template.name,
    });
    return { deleted: true };
  }

  /**
   * The message as it would be prepared, for a chosen contact or a made-up one. The opt-out line is
   * always part of it; if the template leaves it out, the preview says so.
   */
  async previewTemplate(actor: AgencyActor, dto: PreviewWhatsappTemplateDto) {
    this.access.assert(actor, 'whatsapp:read');
    let person = {
      name: 'Alex Example',
      company: 'Example Ltd' as string | null,
    };
    if (dto.contactId) {
      const contact = await this.repo.getContact(actor.orgId, dto.contactId);
      if (!contact) throw new NotFoundException('Contact not found');
      if (contact.consentStatus !== 'OPTED_IN') {
        throw new BadRequestException(
          'This person withdrew consent, so no message is prepared for them.'
        );
      }
      person = { name: contact.name, company: contact.company };
    }
    const optOutLine =
      dto.optOutLine === undefined
        ? await this.defaultOptOutLine(actor.orgId)
        : dto.optOutLine.trim();
    const problems = templateProblems(dto.body);
    const rendered = renderMessage(
      { body: dto.body, link: dto.link?.trim() || null, optOutLine },
      person,
      await this.agencyRepo.getOrganizationName(actor.orgId)
    );
    const warnings: string[] = [];
    if (!optOutLine) warnings.push(NO_OPT_OUT_WARNING);
    if (dto.contactId && rendered.missing.length) {
      warnings.push(
        `This contact has no ${rendered.missing.join(
          ', '
        )}, so no task would be prepared for them with this wording.`
      );
    }
    return {
      message: problems.length ? '' : rendered.message,
      characters: problems.length ? 0 : rendered.message.length,
      problems,
      warnings,
      missing: rendered.missing,
      usedSample: !dto.contactId,
    };
  }

  /**
   * Suggested wording from the AI chosen in Settings, put in the editor for the person to change. It
   * never touches a contact and sends nothing; the request holds only the brief or draft wording.
   * When the AI cannot answer, this says so and the rest of the workspace carries on.
   */
  async suggestWording(actor: AgencyActor, dto: SuggestWhatsappWordingDto) {
    this.access.assert(actor, 'whatsapp:write');
    this.access.assert(actor, 'ai:use');
    const brief = dto.brief?.trim();
    const body = dto.body?.trim();
    if (!brief && !body) {
      throw new BadRequestException(
        'Say what the message is about, or write a first version to improve.'
      );
    }
    const prompt = [
      brief ? `What the message is about: ${brief}` : '',
      body ? `Wording to improve:\n${body}` : '',
      `Tone: ${(dto.tone ?? 'DIRECT_RESPONSE')
        .toLowerCase()
        .replace(/_/g, ' ')}`,
      dto.language ? `Language: ${dto.language}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    try {
      const result = await this.ai.complete(actor.orgId, {
        task: body ? 'improve' : 'copy',
        system: SUGGEST_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        thinkingWhenAuto: 'off',
        maxTokens: 600,
      });
      const text = cleanSuggestion(result.text);
      if (!text) {
        return {
          available: false as const,
          reason: 'The assistant answered, but with nothing usable. Try again.',
        };
      }
      return {
        available: true as const,
        text,
        provider: result.provider,
        model: result.model,
      };
    } catch (err: any) {
      this.logger.debug(
        `WhatsApp wording suggestion unavailable: ${err?.message}`
      );
      return {
        available: false as const,
        reason:
          err instanceof AiProviderError
            ? err.message
            : 'The AI could not be reached. Write the message yourself, or check the AI settings.',
      };
    }
  }

  // ==========================================================================================
  // TASKS: one message to prepare for one person
  // ==========================================================================================
  private taskView(task: WhatsappTaskRow) {
    return {
      id: task.id,
      status: task.status,
      label: task.label,
      message: task.message,
      skipReason: task.skipReason,
      note: task.note,
      followUpAt: task.followUpAt,
      openedAt: task.openedAt,
      sentAt: task.sentAt,
      repliedAt: task.repliedAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      contact: {
        id: task.contact.id,
        name: task.contact.name,
        maskedPhone: maskPhone(task.contact.phone),
        consentStatus: task.contact.consentStatus,
      },
      template: task.template,
    };
  }

  private async requireTask(actor: AgencyActor, id: string) {
    const task = await this.repo.getTask(actor.orgId, id);
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  /**
   * Prepares one task per person who is opted in: for everyone in a segment, or for one contact.
   * People who withdrew are never included, people who already have this wording waiting are left
   * alone, and anyone the wording cannot be filled in for is reported, not guessed.
   */
  async draft(actor: AgencyActor, dto: DraftWhatsappTasksDto) {
    this.access.assert(actor, 'whatsapp:write');
    if (!!dto.segmentId === !!dto.contactId) {
      throw new BadRequestException('Choose a segment, or one contact.');
    }
    const template = await this.repo.getTemplate(actor.orgId, dto.templateId);
    if (!template) throw new NotFoundException('Template not found');
    this.checkWording(template.body);

    let people: Array<{
      id: string;
      name: string;
      company: string | null;
    }>;
    let label: string;
    let segmentId: string | null = null;
    if (dto.segmentId) {
      const segment = await this.requireSegment(actor, dto.segmentId);
      segmentId = segment.id;
      label = `${template.name} · ${segment.name}`;
      people = await this.repo.listMembers(
        actor.orgId,
        filterOf(segment),
        WHATSAPP_LIMITS.maxTasksPerDraft + 1
      );
    } else {
      const contact = await this.repo.getContact(actor.orgId, dto.contactId);
      if (!contact) throw new NotFoundException('Contact not found');
      if (contact.consentStatus !== 'OPTED_IN') {
        throw new BadRequestException(
          'This person withdrew consent, so no message can be prepared for them.'
        );
      }
      label = `${template.name} · one contact`;
      people = [contact];
    }
    if (!people.length) {
      throw new BadRequestException(
        'Nobody in this segment has agreed to be contacted yet.'
      );
    }
    if (people.length > WHATSAPP_LIMITS.maxTasksPerDraft) {
      throw new BadRequestException(
        `That is more than ${WHATSAPP_LIMITS.maxTasksPerDraft} people. Narrow the segment: every message is sent by hand.`
      );
    }

    const waiting = await this.repo.findContactsWithOpenTask(
      actor.orgId,
      template.id,
      people.map((p) => p.id)
    );
    const agency = await this.agencyRepo.getOrganizationName(actor.orgId);
    const skipped = { alreadyWaiting: 0, missingDetails: 0 };
    const rows: Array<Omit<Prisma.WhatsappTaskCreateManyInput, 'orgId'>> = [];
    for (const person of people) {
      if (waiting.has(person.id)) {
        skipped.alreadyWaiting += 1;
        continue;
      }
      const { message, missing } = renderMessage(template, person, agency);
      if (missing.length) {
        skipped.missingDetails += 1;
        continue;
      }
      rows.push({
        contactId: person.id,
        templateId: template.id,
        segmentId,
        label,
        message,
        createdById: actor.userId,
      });
    }
    const created = rows.length
      ? await this.repo.createTasks(actor.orgId, rows)
      : 0;
    await this.access.audit(actor, {
      action: 'whatsapp_tasks.drafted',
      entityType: 'WhatsappTemplate',
      entityId: template.id,
      summary: `${created} tasks prepared`,
      metadata: { created, segmentId, ...skipped },
    });
    return { created, skipped, label };
  }

  async listTasks(
    actor: AgencyActor,
    filters: {
      status?: string;
      templateId?: string;
      contactId?: string;
      limit?: number;
    } = {}
  ) {
    this.access.assert(actor, 'whatsapp:read');
    const status = (
      ['PENDING', 'SENT_BY_USER', 'REPLIED', 'SKIPPED'] as const
    ).find((s) => s === filters.status);
    const tasks = await this.repo.listTasks(actor.orgId, {
      status,
      templateId: filters.templateId,
      contactId: filters.contactId,
      limit:
        filters.limit && filters.limit > 0
          ? Math.min(filters.limit, 500)
          : undefined,
    });
    return tasks.map((t) => this.taskView(t));
  }

  /** Follow-ups that have come due by `until` (the end of the person's day), for people still opted in. */
  async listDue(actor: AgencyActor, until?: string) {
    this.access.assert(actor, 'whatsapp:read');
    const parsed = until ? new Date(until) : new Date();
    const at = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    return (await this.repo.listDue(actor.orgId, at)).map((t) =>
      this.taskView(t)
    );
  }

  /**
   * The click-to-chat link for one task, made when the person asks for it. It is refused for anyone
   * who withdrew consent, and the message is only prefilled while the task is still waiting, so
   * opening the chat again for a follow-up cannot send the same words twice by accident.
   */
  async openChat(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'whatsapp:write');
    const task = await this.requireTask(actor, id);
    const contact = await this.repo.getContact(actor.orgId, task.contact.id);
    if (!contact) throw new NotFoundException('Contact not found');
    if (contact.consentStatus !== 'OPTED_IN') {
      throw new BadRequestException(
        `This person withdrew consent${
          contact.optedOutAt
            ? ` on ${contact.optedOutAt.toISOString().slice(0, 10)}`
            : ''
        }, so there is no chat link.`
      );
    }
    if (task.status === 'SKIPPED') {
      throw new BadRequestException(
        'This task was skipped. Reopen it first if you do want to write to this person.'
      );
    }
    const prefilled = task.status === 'PENDING';
    const openedAt = new Date();
    await this.repo.updateTask(actor.orgId, id, { openedAt });
    return {
      url: chatLink(contact.phone, prefilled ? task.message : undefined),
      prefilled,
      openedAt,
    };
  }

  /** The person says what they did. This is the only thing that moves a task. */
  async setStatus(
    actor: AgencyActor,
    id: string,
    dto: SetWhatsappTaskStatusDto
  ) {
    this.access.assert(actor, 'whatsapp:write');
    const task = await this.requireTask(actor, id);
    const from = task.status;
    const to = dto.status as WhatsappTaskStatus;
    if (from === to) return this.taskView(task);
    if (!TASK_TRANSITIONS[from].includes(to)) {
      throw new BadRequestException(
        `A task that is ${STATUS_WORDS[from]} cannot be changed to ${STATUS_WORDS[to]}.`
      );
    }
    if (to === 'PENDING' && task.contact.consentStatus !== 'OPTED_IN') {
      throw new BadRequestException(
        'This person withdrew consent, so the task cannot be reopened.'
      );
    }
    const now = new Date();
    const data: Prisma.WhatsappTaskUncheckedUpdateManyInput =
      to === 'SENT_BY_USER'
        ? { status: to, sentAt: now, repliedAt: null, skipReason: null }
        : to === 'REPLIED'
        ? { status: to, repliedAt: now, followUpAt: null }
        : to === 'SKIPPED'
        ? {
            status: to,
            skipReason: dto.skipReason?.trim() || 'Skipped by you',
            followUpAt: null,
          }
        : { status: to, sentAt: null, repliedAt: null, skipReason: null };
    if (!(await this.repo.transitionTask(actor.orgId, id, from, data))) {
      throw new ConflictException(
        'This task was just changed by someone else. Refresh and try again.'
      );
    }
    await this.access.audit(actor, {
      action: 'whatsapp_task.status_changed',
      entityType: 'WhatsappTask',
      entityId: id,
      summary: `${from} → ${to}`,
      metadata: { from, to },
    });
    return this.taskView(await this.requireTask(actor, id));
  }

  /** A note, and a reminder day that shows up under Today. Reminders are in the app only. */
  async updateTask(actor: AgencyActor, id: string, dto: UpdateWhatsappTaskDto) {
    this.access.assert(actor, 'whatsapp:write');
    const task = await this.requireTask(actor, id);
    const data: Prisma.WhatsappTaskUncheckedUpdateManyInput = {};
    if (dto.note !== undefined) data.note = dto.note.trim() || null;
    if (dto.followUpAt !== undefined) {
      if (dto.followUpAt === null) {
        data.followUpAt = null;
      } else {
        if (task.status !== 'PENDING' && task.status !== 'SENT_BY_USER') {
          throw new BadRequestException(
            'A reminder only makes sense for a task that is still open.'
          );
        }
        if (task.contact.consentStatus !== 'OPTED_IN') {
          throw new BadRequestException(
            'This person withdrew consent, so there is nothing to follow up.'
          );
        }
        const at = new Date(dto.followUpAt);
        if (Number.isNaN(at.getTime())) {
          throw new BadRequestException(
            'That reminder day is not a real date.'
          );
        }
        data.followUpAt = at;
      }
    }
    const updated = await this.repo.updateTask(actor.orgId, id, data);
    await this.access.audit(actor, {
      action: 'whatsapp_task.updated',
      entityType: 'WhatsappTask',
      entityId: id,
      summary: [
        dto.note !== undefined ? 'note' : '',
        dto.followUpAt === null
          ? 'reminder cleared'
          : dto.followUpAt !== undefined
          ? 'reminder set'
          : '',
      ]
        .filter(Boolean)
        .join(', '),
    });
    return this.taskView(updated);
  }
}
