import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, WhatsappConsentStatus } from '@prisma/client';
import { createHmac, hkdfSync } from 'crypto';
import {
  AgencyWhatsappRepository,
  WhatsappContactFilters,
} from './agency.whatsapp.repository';
import { AgencyAccessService, AgencyActor } from './agency.access.service';
import {
  CommitWhatsappImportDto,
  CreateWhatsappContactDto,
  UpdateWhatsappContactDto,
  UpdateWhatsappSettingsDto,
  WHATSAPP_LIMITS,
  WHATSAPP_PLACEHOLDERS,
  WHATSAPP_WITHDRAW_METHODS,
  WithdrawWhatsappConsentDto,
} from '@gitroom/nestjs-libraries/dtos/agency/whatsapp.dto';
import {
  WHATSAPP_BUSINESS_PROVIDER,
  WhatsappBusinessProvider,
} from '@gitroom/nestjs-libraries/integrations/whatsapp/whatsapp.business.provider';

/** What the operator agrees to when committing an import. The exact words are stored with the batch. */
export const WHATSAPP_IMPORT_ATTESTATION =
  'I confirm that the people in this file agreed to be contacted on WhatsApp, and that the consent source and date on each row are true.';

export const DEFAULT_OPT_OUT_LINE = 'Reply STOP to opt out.';

const FIRST_YEAR = 2009; // WhatsApp's launch: no consent can be older
const DAY_MS = 24 * 60 * 60 * 1000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// ---------------------------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------------------------
/**
 * Turns what people type into E.164 (+, country code, number; 8 to 15 digits). It checks the shape
 * only: a number's country-specific length is not known here, so a wrong but well-formed number
 * is the operator's to catch. A national number without a country code is refused, never guessed.
 */
export function normalisePhone(
  raw: string
): { phone: string } | { error: string } {
  let text = (raw ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/^(tel|whatsapp):/i, '');
  // "+49 (0) 170 ..." writes the local 0 that international format leaves out.
  text = text.replace(/\(\s*0\s*\)/g, '');
  text = text.replace(/[\s().\-/ ‐-―]/g, '');
  if (text.startsWith('00')) text = `+${text.slice(2)}`;
  if (!text.startsWith('+')) {
    return {
      error:
        'Start the number with + and the country code, for example +4915112345678.',
    };
  }
  const digits = text.slice(1);
  if (!/^\d+$/.test(digits)) {
    return { error: 'A phone number holds only digits after the +.' };
  }
  if (digits.startsWith('0')) {
    return { error: 'A country code does not start with 0.' };
  }
  if (digits.length < 8) {
    return { error: 'That number is too short to be a WhatsApp number.' };
  }
  if (digits.length > 15) {
    return {
      error:
        'That number is too long. International numbers have at most 15 digits.',
    };
  }
  return { phone: `+${digits}` };
}

/** +49•••••1234: enough to tell two people apart, not enough to call anyone. */
export function maskPhone(phone: string) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8) return '•••••';
  return `+${digits.slice(0, 2)}•••••${digits.slice(-4)}`;
}

/** The chat link a person clicks themselves. The text, if any, is only prefilled in the box. */
export function chatLink(phone: string, text?: string) {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits}${
    text ? `?text=${encodeURIComponent(text)}` : ''
  }`;
}

// ---------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------
const clean = (value: unknown) =>
  typeof value === 'string'
    ? value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
    : '';

export function normaliseTags(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags : [];
  return [
    ...new Set(
      list
        .map((t) => clean(t).toLowerCase())
        .filter((t) => t.length > 0 && t.length <= 40)
    ),
  ].slice(0, 20);
}

/** "de", "pt-br": a short language code, or nothing. */
export function normaliseLanguage(
  raw: unknown
): { language: string | null } | { error: string } {
  const text = clean(raw).toLowerCase();
  if (!text) return { language: null };
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(text)) {
    return { error: 'Use a language code such as en, de or pt-br.' };
  }
  return { language: text };
}

/** An ISO date or date and time. Not in the future, and not before WhatsApp existed. */
export function parseConsentDate(
  raw: unknown
): { date: Date } | { error: string } {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      text
    );
  if (!match) {
    return {
      error: 'Write the consent date as YYYY-MM-DD, for example 2026-03-14.',
    };
  }
  const date = new Date(text.length === 10 ? `${text}T00:00:00.000Z` : text);
  const [year, month, day] = [match[1], match[2], match[3]].map(Number);
  if (
    Number.isNaN(date.getTime()) ||
    (text.length === 10 &&
      (date.getUTCFullYear() !== year ||
        date.getUTCMonth() + 1 !== month ||
        date.getUTCDate() !== day))
  ) {
    return { error: 'That consent date is not a real date.' };
  }
  if (date.getTime() > Date.now() + DAY_MS) {
    return { error: 'The consent date is in the future.' };
  }
  if (date.getUTCFullYear() < FIRST_YEAR) {
    return { error: `The consent date cannot be before ${FIRST_YEAR}.` };
  }
  return { date };
}

// ---------------------------------------------------------------------------------------------
// CSV: quotes, both kinds of line ending, a spreadsheet's semicolons, a leading byte-order mark
// ---------------------------------------------------------------------------------------------
export function parseCsv(
  text: string
): Array<{ line: number; cells: string[] }> {
  const src = text.replace(/^﻿/, '');
  let head = src.length;
  for (let i = 0, quoted = false; i < src.length; i++) {
    if (src[i] === '"') quoted = !quoted;
    else if (!quoted && (src[i] === '\n' || src[i] === '\r')) {
      head = i;
      break;
    }
  }
  const delimiter = [',', ';', '\t']
    .map((d) => {
      let n = 0;
      let quoted = false;
      for (const c of src.slice(0, head)) {
        if (c === '"') quoted = !quoted;
        else if (!quoted && c === d) n += 1;
      }
      return { d, n };
    })
    .sort((a, b) => b.n - a.n)[0] ?? { d: ',', n: 0 };
  const sep = delimiter.n > 0 ? delimiter.d : ',';

  const rows: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const endRow = () => {
    cells.push(field);
    if (cells.some((c) => c.trim() !== '')) rows.push({ line: rowLine, cells });
    cells = [];
    field = '';
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else {
        if (c === '\n') line += 1;
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === sep) {
      cells.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      endRow();
      line += 1;
      rowLine = line;
    } else {
      field += c;
    }
  }
  if (quoted) {
    throw new BadRequestException(
      `A quote opened near line ${rowLine} is never closed. Check that line.`
    );
  }
  if (field !== '' || cells.length) endRow();
  return rows;
}

const COLUMN_ALIASES: Record<string, string[]> = {
  name: ['name', 'full_name', 'contact', 'contact_name'],
  phone: [
    'phone',
    'phone_number',
    'mobile',
    'whatsapp',
    'whatsapp_number',
    'number',
    'tel',
  ],
  language: ['language', 'lang'],
  tags: ['tags', 'tag', 'labels'],
  company: ['company', 'organisation', 'organization', 'business'],
  notes: ['notes', 'note', 'comment'],
  consentSource: ['consent_source', 'consent_how', 'opt_in_source', 'source'],
  consentDate: [
    'consent_date',
    'consented_at',
    'consent_on',
    'opt_in_date',
    'consent_timestamp',
  ],
  consentEvidence: [
    'consent_evidence',
    'evidence',
    'consent_note',
    'consent_proof',
  ],
};

export type ImportRowStatus =
  | 'VALID'
  | 'DUPLICATE'
  | 'INVALID'
  | 'MISSING_CONSENT'
  | 'WITHDRAWN';

export interface ImportRowResult {
  line: number;
  status: ImportRowStatus;
  name: string;
  /** Masked; a number that could not be read is not echoed. */
  phone: string | null;
  reasons: string[];
}

interface PreparedContact {
  name: string;
  phone: string;
  company: string | null;
  language: string | null;
  tags: string[];
  notes: string | null;
  consentSource: string;
  consentEvidence: string | null;
  consentedAt: Date;
}

interface RawPerson {
  name?: unknown;
  phone?: unknown;
  company?: unknown;
  language?: unknown;
  tags?: unknown;
  notes?: unknown;
  consentSource?: unknown;
  consentEvidence?: unknown;
  consentedAt?: unknown;
}

/**
 * The contact workspace: people who agreed to be contacted on WhatsApp, the record of how and when,
 * and what happens when they change their mind. Nothing here sends a message to anyone.
 *
 * Contacts belong to the agency, not to the person who added them, so a withdrawal is seen by
 * everyone at once. Phone numbers are personal data: lists show them masked, and the full number is
 * shown only to staff who work the contacts (and goes only into the click-to-chat link). The audit
 * trail never contains a number.
 */
@Injectable()
export class AgencyWhatsappService {
  private hashKeyCache: { secret: string; key: Buffer } | null = null;

  constructor(
    private readonly repo: AgencyWhatsappRepository,
    private readonly access: AgencyAccessService,
    @Inject(WHATSAPP_BUSINESS_PROVIDER)
    private readonly business: WhatsappBusinessProvider
  ) {}

  // ==========================================================================================
  // THE LEDGER'S KEYED HASH
  // ==========================================================================================
  private hashKey(): Buffer {
    const secret =
      process.env.AGENCY_WHATSAPP_HASH_KEY || process.env.JWT_SECRET;
    if (!secret) {
      throw new HttpException(
        'The server has no secret to protect phone numbers',
        500
      );
    }
    if (this.hashKeyCache?.secret !== secret) {
      this.hashKeyCache = {
        secret,
        key: Buffer.from(
          hkdfSync(
            'sha256',
            Buffer.from(secret),
            Buffer.from('agencyos-whatsapp'),
            Buffer.from('phone-hash-v1'),
            32
          )
        ),
      };
    }
    return this.hashKeyCache.key;
  }

  /**
   * A keyed, per-agency hash of an E.164 number. The same number gives the same hash within one
   * agency (so a withdrawn person is recognised), a different one in another agency, and the number
   * cannot be read back from it or guessed without the install's secret.
   */
  hashPhone(orgId: string, phone: string) {
    return createHmac('sha256', this.hashKey())
      .update(`${orgId}:${phone}`)
      .digest('hex');
  }

  // ==========================================================================================
  // PREPARING A PERSON (one rule for a form and for a CSV row)
  // ==========================================================================================
  /**
   * Checks one person. Consent problems are kept apart from other problems: a row with no consent
   * is a different thing from a row with a typo.
   */
  private prepare(input: RawPerson) {
    const missingConsent: string[] = [];
    const invalid: string[] = [];

    const name = clean(input.name);
    if (!name) invalid.push('Give the person a name.');
    else if (name.length > 120)
      invalid.push('The name is longer than 120 characters.');

    let phone: string | null = null;
    const normalised = normalisePhone(String(input.phone ?? ''));
    if ('error' in normalised) invalid.push(normalised.error);
    else phone = normalised.phone;

    const company = clean(input.company);
    if (company.length > 120)
      invalid.push('The company is longer than 120 characters.');

    const language = normaliseLanguage(input.language);
    if ('error' in language) invalid.push(language.error);

    const tagList = Array.isArray(input.tags)
      ? input.tags
      : String(input.tags ?? '').split(/[|;,]/);
    const tags = normaliseTags(tagList);

    const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
    if (notes.length > 2000)
      invalid.push('The notes are longer than 2000 characters.');

    const consentSource = clean(input.consentSource);
    if (!consentSource) {
      missingConsent.push(
        'There is no consent source: say how the person agreed.'
      );
    } else if (consentSource.length > 100) {
      invalid.push('The consent source is longer than 100 characters.');
    }
    const consentEvidence = clean(input.consentEvidence);
    if (consentEvidence.length > 500) {
      invalid.push('The consent evidence is longer than 500 characters.');
    }

    let consentedAt: Date | null = null;
    if (typeof input.consentedAt === 'string' && input.consentedAt.trim()) {
      const parsed = parseConsentDate(input.consentedAt);
      if ('error' in parsed) invalid.push(parsed.error);
      else consentedAt = parsed.date;
    } else if (input.consentedAt instanceof Date) {
      consentedAt = input.consentedAt;
    } else {
      missingConsent.push(
        'There is no consent date: say when the person agreed.'
      );
    }

    const value: PreparedContact | undefined =
      !missingConsent.length && !invalid.length && phone && consentedAt
        ? {
            name,
            phone,
            company: company || null,
            language: 'language' in language ? language.language : null,
            tags,
            notes: notes || null,
            consentSource,
            consentEvidence: consentEvidence || null,
            consentedAt,
          }
        : undefined;
    return { missingConsent, invalid, value, name, phone };
  }

  // ==========================================================================================
  // VIEWS: what leaves the service
  // ==========================================================================================
  private canSeeNumbers(actor: AgencyActor) {
    return this.access.can(actor, 'whatsapp:write');
  }

  private listItem(contact: {
    id: string;
    name: string;
    phone: string;
    company: string | null;
    language: string | null;
    tags: string[];
    consentStatus: WhatsappConsentStatus;
    consentSource: string;
    consentedAt: Date;
    optedOutAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: contact.id,
      name: contact.name,
      maskedPhone: maskPhone(contact.phone),
      company: contact.company,
      language: contact.language,
      tags: contact.tags,
      consentStatus: contact.consentStatus,
      consentSource: contact.consentSource,
      consentedAt: contact.consentedAt,
      optedOutAt: contact.optedOutAt,
      createdAt: contact.createdAt,
    };
  }

  private async detail(
    actor: AgencyActor,
    contact: NonNullable<
      Awaited<ReturnType<AgencyWhatsappRepository['getContact']>>
    >
  ) {
    const tasks = await this.repo.listContactTasks(actor.orgId, contact.id);
    return {
      ...this.listItem(contact),
      // The full number is for staff who work the contacts; everyone else sees it masked.
      phone: this.canSeeNumbers(actor) ? contact.phone : null,
      notes: contact.notes,
      consentEvidence: contact.consentEvidence,
      optOutMethod: contact.optOutMethod,
      optOutReason: contact.optOutReason,
      importId: contact.importId,
      tasks: tasks.map((t) => ({
        id: t.id,
        status: t.status,
        label: t.label,
        templateName: t.template?.name ?? null,
        followUpAt: t.followUpAt,
        sentAt: t.sentAt,
        createdAt: t.createdAt,
      })),
    };
  }

  private async requireContact(actor: AgencyActor, id: string) {
    const contact = await this.repo.getContact(actor.orgId, id);
    if (!contact) throw new NotFoundException('Contact not found');
    return contact;
  }

  // ==========================================================================================
  // CONTACTS
  // ==========================================================================================
  async list(actor: AgencyActor, filters: WhatsappContactFilters = {}) {
    this.access.assert(actor, 'whatsapp:read');
    const contacts = await this.repo.listContacts(actor.orgId, {
      ...filters,
      status:
        filters.status === 'OPTED_IN' || filters.status === 'OPTED_OUT'
          ? filters.status
          : undefined,
    });
    return contacts.map((c) => this.listItem(c));
  }

  async get(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'whatsapp:read');
    return this.detail(actor, await this.requireContact(actor, id));
  }

  /** Adds one person, with the record of how and when they agreed. Without it nobody is added. */
  async create(actor: AgencyActor, dto: CreateWhatsappContactDto) {
    this.access.assert(actor, 'whatsapp:write');
    const prepared = this.prepare({
      name: dto.name,
      phone: dto.phone,
      company: dto.company,
      language: dto.language,
      tags: dto.tags ?? [],
      notes: dto.notes,
      consentSource: dto.consentSource,
      consentEvidence: dto.consentEvidence,
      consentedAt: dto.consentedAt,
    });
    const problems = [...prepared.missingConsent, ...prepared.invalid];
    if (!prepared.value) {
      throw new BadRequestException(problems.join(' '));
    }
    const person = prepared.value;
    const hash = this.hashPhone(actor.orgId, person.phone);
    const withdrawn = (await this.repo.findWithdrawn(actor.orgId, [hash])).get(
      hash
    );
    if (withdrawn) {
      throw new ConflictException(
        `This person withdrew consent on ${withdrawn.receivedAt
          .toISOString()
          .slice(0, 10)}, so they cannot be added again.`
      );
    }
    let contact;
    try {
      contact = await this.repo.createContact(actor.orgId, {
        ...person,
        phoneHash: hash,
        consentRecordedById: actor.userId,
        createdById: actor.userId,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'A contact with this number already exists.'
        );
      }
      throw err;
    }
    await this.access.audit(actor, {
      action: 'whatsapp_contact.consent_recorded',
      entityType: 'WhatsappContact',
      entityId: contact.id,
      summary: `Consent recorded (${person.consentSource})`,
      metadata: {
        source: person.consentSource,
        consentedAt: person.consentedAt.toISOString(),
        hasEvidence: !!person.consentEvidence,
      },
    });
    return this.detail(actor, contact);
  }

  async update(actor: AgencyActor, id: string, dto: UpdateWhatsappContactDto) {
    this.access.assert(actor, 'whatsapp:write');
    await this.requireContact(actor, id);
    const data: Prisma.WhatsappContactUncheckedUpdateManyInput = {};
    if (dto.name !== undefined) {
      const name = clean(dto.name);
      if (!name) throw new BadRequestException('Give the person a name.');
      data.name = name;
    }
    if (dto.company !== undefined) data.company = clean(dto.company) || null;
    if (dto.language !== undefined) {
      const language = normaliseLanguage(dto.language);
      if ('error' in language) throw new BadRequestException(language.error);
      data.language = language.language;
    }
    if (dto.tags !== undefined) data.tags = normaliseTags(dto.tags);
    if (dto.notes !== undefined) data.notes = dto.notes.trim() || null;
    const updated = await this.repo.updateContact(actor.orgId, id, data);
    await this.access.audit(actor, {
      action: 'whatsapp_contact.updated',
      entityType: 'WhatsappContact',
      entityId: id,
      summary: `Changed ${Object.keys(data).join(', ') || 'nothing'}`,
    });
    return this.detail(actor, updated);
  }

  /**
   * The person asked to stop. They are marked opted out, the withdrawal is added to the ledger (which
   * outlives the contact), and every message still waiting for them is closed.
   */
  async withdraw(
    actor: AgencyActor,
    id: string,
    dto: WithdrawWhatsappConsentDto
  ) {
    this.access.assert(actor, 'whatsapp:write');
    const contact = await this.requireContact(actor, id);
    if (contact.consentStatus === 'OPTED_OUT') {
      throw new ConflictException('This person has already withdrawn consent.');
    }
    if (!WHATSAPP_WITHDRAW_METHODS.includes(dto.method)) {
      throw new BadRequestException('Say how the request reached you.');
    }
    let receivedAt = new Date();
    if (dto.receivedAt) {
      const parsed = parseConsentDate(dto.receivedAt);
      if ('error' in parsed) {
        throw new BadRequestException(
          parsed.error.replace('consent date', 'date of the request')
        );
      }
      receivedAt = parsed.date;
    }
    const outcome = await this.repo.withdrawContact(actor.orgId, id, {
      receivedAt,
      method: dto.method,
      reason: dto.reason?.trim() || null,
      phoneHash: contact.phoneHash,
      recordedById: actor.userId,
    });
    if (!outcome) {
      throw new ConflictException('This person has already withdrawn consent.');
    }
    await this.access.audit(actor, {
      action: 'whatsapp_contact.consent_withdrawn',
      entityType: 'WhatsappContact',
      entityId: id,
      summary: `Consent withdrawn (${dto.method})`,
      metadata: {
        method: dto.method,
        receivedAt: receivedAt.toISOString(),
        tasksClosed: outcome.tasksClosed,
      },
    });
    return this.detail(
      actor,
      (await this.repo.getContact(actor.orgId, id)) ?? contact
    );
  }

  /**
   * Deletes the person's details and every message prepared for them. Only the ledger row of a
   * withdrawal stays, and it holds a hash, not the number.
   */
  async erase(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'whatsapp:delete');
    const contact = await this.requireContact(actor, id);
    await this.repo.eraseContact(actor.orgId, id);
    await this.access.audit(actor, {
      action: 'whatsapp_contact.erased',
      entityType: 'WhatsappContact',
      entityId: id,
      summary:
        contact.consentStatus === 'OPTED_OUT'
          ? 'Contact erased; the withdrawal stays in the ledger'
          : 'Contact erased',
      metadata: { wasOptedOut: contact.consentStatus === 'OPTED_OUT' },
    });
    return { deleted: true };
  }

  async facets(actor: AgencyActor) {
    this.access.assert(actor, 'whatsapp:read');
    return this.repo.facets(actor.orgId);
  }

  // ==========================================================================================
  // IMPORTS: only rows that carry their own consent, only after the operator attests
  // ==========================================================================================
  private async analyseImport(orgId: string, csv: string) {
    const parsed = parseCsv(csv);
    if (parsed.length < 2) {
      throw new BadRequestException(
        'The file needs a header row and at least one person.'
      );
    }
    const [header, ...dataRows] = parsed;
    if (dataRows.length > WHATSAPP_LIMITS.maxImportRows) {
      throw new BadRequestException(
        `This file has ${dataRows.length} rows. Import at most ${WHATSAPP_LIMITS.maxImportRows} at a time.`
      );
    }
    if (header.cells.length > 30) {
      throw new BadRequestException('The file has too many columns.');
    }
    const names = header.cells.map((h) =>
      h
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
    );
    const column: Record<string, number> = {};
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      const at = names.findIndex((n) => aliases.includes(n));
      if (at >= 0) column[field] = at;
    }
    const columnProblems: string[] = [];
    if (column.name === undefined)
      columnProblems.push('There is no “name” column.');
    if (column.phone === undefined)
      columnProblems.push('There is no “phone” column.');
    if (column.consentSource === undefined) {
      columnProblems.push(
        'There is no “consent_source” column, so no row can be imported. Add how each person agreed.'
      );
    }
    if (column.consentDate === undefined) {
      columnProblems.push(
        'There is no “consent_date” column, so no row can be imported. Add the day each person agreed (YYYY-MM-DD).'
      );
    }
    const cell = (cells: string[], field: string) =>
      column[field] === undefined ? undefined : cells[column[field]];

    const rows: ImportRowResult[] = [];
    const candidates: Array<{ at: number; person: PreparedContact }> = [];
    const firstLine = new Map<string, number>();
    for (const row of dataRows) {
      const prepared = this.prepare({
        name: cell(row.cells, 'name'),
        phone: cell(row.cells, 'phone'),
        company: cell(row.cells, 'company'),
        language: cell(row.cells, 'language'),
        tags: cell(row.cells, 'tags'),
        notes: cell(row.cells, 'notes'),
        consentSource: cell(row.cells, 'consentSource'),
        consentEvidence: cell(row.cells, 'consentEvidence'),
        consentedAt: cell(row.cells, 'consentDate'),
      });
      const result: ImportRowResult = {
        line: row.line,
        status: 'VALID',
        name: prepared.name,
        phone: prepared.phone ? maskPhone(prepared.phone) : null,
        reasons: [],
      };
      rows.push(result);
      if (prepared.missingConsent.length) {
        result.status = 'MISSING_CONSENT';
        result.reasons = [...prepared.missingConsent, ...prepared.invalid];
      } else if (prepared.invalid.length) {
        result.status = 'INVALID';
        result.reasons = prepared.invalid;
      } else if (prepared.value) {
        const seen = firstLine.get(prepared.value.phone);
        if (seen !== undefined) {
          result.status = 'DUPLICATE';
          result.reasons = [`The same number is already on line ${seen}.`];
        } else {
          firstLine.set(prepared.value.phone, row.line);
          candidates.push({ at: rows.length - 1, person: prepared.value });
        }
      }
    }

    if (candidates.length) {
      const hashes = new Map(
        candidates.map((c) => [
          c.person.phone,
          this.hashPhone(orgId, c.person.phone),
        ])
      );
      const [existing, withdrawn] = await Promise.all([
        this.repo.findExistingPhones(
          orgId,
          candidates.map((c) => c.person.phone)
        ),
        this.repo.findWithdrawn(orgId, [...hashes.values()]),
      ]);
      for (const { at, person } of candidates) {
        const gone = withdrawn.get(hashes.get(person.phone));
        if (gone) {
          rows[at].status = 'WITHDRAWN';
          rows[at].reasons = [
            `This person withdrew consent on ${gone.receivedAt
              .toISOString()
              .slice(0, 10)} and cannot be added again.`,
          ];
        } else if (existing.has(person.phone)) {
          rows[at].status = 'DUPLICATE';
          rows[at].reasons = ['This number is already one of your contacts.'];
        }
      }
    }

    const valid = candidates
      .filter(({ at }) => rows[at].status === 'VALID')
      .map(({ person }) => person);
    const count = (status: ImportRowStatus) =>
      rows.filter((r) => r.status === status).length;
    return {
      rows,
      valid,
      columnProblems,
      counts: {
        total: rows.length,
        valid: valid.length,
        duplicate: count('DUPLICATE'),
        invalid: count('INVALID'),
        missingConsent: count('MISSING_CONSENT'),
        withdrawn: count('WITHDRAWN'),
      },
    };
  }

  /** What would happen, row by row. Nothing is stored. */
  async previewImport(actor: AgencyActor, csv: string) {
    this.access.assert(actor, 'whatsapp:write');
    const analysis = await this.analyseImport(actor.orgId, csv);
    return {
      counts: analysis.counts,
      rows: analysis.rows,
      columnProblems: analysis.columnProblems,
      canImport: analysis.counts.valid > 0,
    };
  }

  /** Re-checks everything on the server and adds only the rows that carry their consent. */
  async commitImport(actor: AgencyActor, dto: CommitWhatsappImportDto) {
    this.access.assert(actor, 'whatsapp:write');
    if (dto.attested !== true) {
      throw new BadRequestException(
        'Confirm that the people in this file agreed to be contacted on WhatsApp.'
      );
    }
    const analysis = await this.analyseImport(actor.orgId, dto.csv);
    if (!analysis.valid.length) {
      throw new BadRequestException(
        'Nothing in this file can be imported. Run the check to see why.'
      );
    }
    const batch = await this.repo.commitImport(
      actor.orgId,
      {
        fileName: dto.fileName?.trim() || null,
        totalRows: analysis.counts.total,
        duplicateRows: analysis.counts.duplicate,
        invalidRows: analysis.counts.invalid,
        missingConsentRows: analysis.counts.missingConsent,
        withdrawnRows: analysis.counts.withdrawn,
        attestation: WHATSAPP_IMPORT_ATTESTATION,
        attestedById: actor.userId,
      },
      analysis.valid.map((person) => ({
        ...person,
        phoneHash: this.hashPhone(actor.orgId, person.phone),
        consentRecordedById: actor.userId,
        createdById: actor.userId,
      }))
    );
    await this.access.audit(actor, {
      action: 'whatsapp_import.committed',
      entityType: 'WhatsappImport',
      entityId: batch.id,
      summary: `${batch.importedRows} of ${batch.totalRows} rows imported, attested by the operator`,
      metadata: {
        total: batch.totalRows,
        imported: batch.importedRows,
        duplicate: batch.duplicateRows,
        invalid: batch.invalidRows,
        missingConsent: batch.missingConsentRows,
        withdrawn: batch.withdrawnRows,
      },
    });
    return this.importView(batch, new Map([[actor.userId, 'You']]));
  }

  private importView(
    batch: {
      id: string;
      fileName: string | null;
      totalRows: number;
      importedRows: number;
      duplicateRows: number;
      invalidRows: number;
      missingConsentRows: number;
      withdrawnRows: number;
      attestation: string;
      attestedById: string;
      createdAt: Date;
    },
    names: Map<string, string>
  ) {
    return {
      id: batch.id,
      fileName: batch.fileName,
      totalRows: batch.totalRows,
      importedRows: batch.importedRows,
      duplicateRows: batch.duplicateRows,
      invalidRows: batch.invalidRows,
      missingConsentRows: batch.missingConsentRows,
      withdrawnRows: batch.withdrawnRows,
      attestation: batch.attestation,
      attestedBy: names.get(batch.attestedById) ?? 'A team member',
      createdAt: batch.createdAt,
    };
  }

  async listImports(actor: AgencyActor) {
    this.access.assert(actor, 'whatsapp:read');
    const batches = await this.repo.listImports(actor.orgId);
    const names = await this.repo.userNames(
      actor.orgId,
      batches.map((b) => b.attestedById)
    );
    return batches.map((b) => this.importView(b, names));
  }

  // ==========================================================================================
  // THE UNSUBSCRIBE LEDGER (read only: nothing here can change or remove a row)
  // ==========================================================================================
  async listUnsubscribes(actor: AgencyActor) {
    this.access.assert(actor, 'whatsapp:read');
    const { rows, contacts } = await this.repo.listUnsubscribes(actor.orgId);
    const names = await this.repo.userNames(
      actor.orgId,
      rows.map((r) => r.recordedById)
    );
    const byHash = new Map(contacts.map((c) => [c.phoneHash, c]));
    return rows.map((row) => {
      const contact = byHash.get(row.phoneHash);
      return {
        id: row.id,
        receivedAt: row.receivedAt,
        method: row.method,
        recordedBy: names.get(row.recordedById) ?? 'A team member',
        // A contact that was erased leaves only the hash behind: nothing to show.
        contact: contact
          ? {
              id: contact.id,
              name: contact.name,
              maskedPhone: maskPhone(contact.phone),
            }
          : null,
      };
    });
  }

  // ==========================================================================================
  // SETTINGS, and the Business API that is not there yet
  // ==========================================================================================
  async getSettings(actor: AgencyActor) {
    this.access.assert(actor, 'whatsapp:read');
    const saved = await this.repo.getSettings(actor.orgId);
    return {
      defaultOptOutLine: saved?.defaultOptOutLine ?? DEFAULT_OPT_OUT_LINE,
      businessApi: {
        enabled: false,
        available: this.business.isEnabled(),
        message: 'Not available in this version',
      },
      placeholders: [...WHATSAPP_PLACEHOLDERS],
      withdrawMethods: [...WHATSAPP_WITHDRAW_METHODS],
      attestation: WHATSAPP_IMPORT_ATTESTATION,
      limits: { ...WHATSAPP_LIMITS },
    };
  }

  async updateSettings(actor: AgencyActor, dto: UpdateWhatsappSettingsDto) {
    this.access.assert(actor, 'whatsapp:manage');
    if (dto.businessApiEnabled) {
      throw new BadRequestException(
        'The WhatsApp Business API is not available in this version. Messages are sent by a person in WhatsApp.'
      );
    }
    const line = dto.defaultOptOutLine?.trim();
    if (dto.defaultOptOutLine !== undefined && !line) {
      throw new BadRequestException(
        'The default opt-out line cannot be empty.'
      );
    }
    await this.repo.saveSettings(actor.orgId, actor.userId, {
      ...(line ? { defaultOptOutLine: line } : {}),
    });
    await this.access.audit(actor, {
      action: 'whatsapp_settings.updated',
      entityType: 'WhatsappSettings',
      summary: 'Default opt-out line changed',
    });
    return this.getSettings(actor);
  }
}
