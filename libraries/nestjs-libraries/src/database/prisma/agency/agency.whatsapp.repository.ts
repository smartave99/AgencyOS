import { Injectable } from '@nestjs/common';
import {
  Prisma,
  WhatsappConsentStatus,
  WhatsappTaskStatus,
} from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export interface WhatsappContactFilters {
  search?: string;
  status?: WhatsappConsentStatus;
  tag?: string;
  language?: string;
  limit?: number;
}

/** The people a segment holds: opted in, and matching every filter that is set. */
export interface WhatsappSegmentFilter {
  tags: string[];
  languages: string[];
  consentSources: string[];
}

export interface WhatsappTaskFilters {
  status?: WhatsappTaskStatus;
  templateId?: string;
  contactId?: string;
  limit?: number;
}

const taskInclude = {
  contact: {
    select: { id: true, name: true, phone: true, consentStatus: true },
  },
  template: { select: { id: true, name: true } },
} satisfies Prisma.WhatsappTaskInclude;

export type WhatsappTaskRow = Prisma.WhatsappTaskGetPayload<{
  include: typeof taskInclude;
}>;

@Injectable()
export class AgencyWhatsappRepository {
  constructor(private prisma: PrismaService) {}

  // ---- contacts ------------------------------------------------------------------------

  async createContact(
    orgId: string,
    data: Omit<Prisma.WhatsappContactUncheckedCreateInput, 'orgId'>
  ) {
    return this.prisma.whatsappContact.create({ data: { orgId, ...data } });
  }

  async getContact(orgId: string, id: string) {
    return this.prisma.whatsappContact.findFirst({ where: { id, orgId } });
  }

  async listContacts(orgId: string, filters: WhatsappContactFilters) {
    const search = filters.search?.trim();
    return this.prisma.whatsappContact.findMany({
      where: {
        orgId,
        ...(filters.status ? { consentStatus: filters.status } : {}),
        ...(filters.tag ? { tags: { has: filters.tag } } : {}),
        ...(filters.language ? { language: filters.language } : {}),
        // Numbers are never searched: a search term travels in the address and ends up in logs.
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { company: { contains: search, mode: 'insensitive' as const } },
                { tags: { has: search.toLowerCase() } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: filters.limit ?? 1000,
    });
  }

  async updateContact(
    orgId: string,
    id: string,
    data: Prisma.WhatsappContactUncheckedUpdateManyInput
  ) {
    await this.prisma.whatsappContact.updateMany({
      where: { id, orgId },
      data,
    });
    return this.getContact(orgId, id);
  }

  /** Which of these numbers are already contacts of this agency. */
  async findExistingPhones(orgId: string, phones: string[]) {
    const rows = await this.prisma.whatsappContact.findMany({
      where: { orgId, phone: { in: phones } },
      select: { phone: true },
    });
    return new Set(rows.map((r) => r.phone));
  }

  /** When each of these numbers (as hashes) was withdrawn, if it ever was. */
  async findWithdrawn(orgId: string, hashes: string[]) {
    const rows = await this.prisma.whatsappUnsubscribe.findMany({
      where: { orgId, phoneHash: { in: hashes } },
      orderBy: { receivedAt: 'desc' },
      select: { phoneHash: true, receivedAt: true, method: true },
    });
    const byHash = new Map<string, { receivedAt: Date; method: string }>();
    for (const row of rows) {
      if (!byHash.has(row.phoneHash)) byHash.set(row.phoneHash, row);
    }
    return byHash;
  }

  /**
   * Withdraws consent: the contact is marked, the ledger gets its row, and everything still waiting
   * for that person is closed, all or nothing. Returns null when the contact was not opted in.
   */
  async withdrawContact(
    orgId: string,
    id: string,
    withdrawal: {
      receivedAt: Date;
      method: string;
      reason: string | null;
      phoneHash: string;
      recordedById: string;
    }
  ) {
    return this.prisma.$transaction(async (tx) => {
      const marked = await tx.whatsappContact.updateMany({
        where: { id, orgId, consentStatus: 'OPTED_IN' },
        data: {
          consentStatus: 'OPTED_OUT',
          optedOutAt: withdrawal.receivedAt,
          optOutMethod: withdrawal.method,
          optOutReason: withdrawal.reason,
        },
      });
      if (marked.count === 0) return null;
      await tx.whatsappUnsubscribe.create({
        data: {
          orgId,
          phoneHash: withdrawal.phoneHash,
          receivedAt: withdrawal.receivedAt,
          method: withdrawal.method,
          recordedById: withdrawal.recordedById,
        },
      });
      const closed = await tx.whatsappTask.updateMany({
        where: { orgId, contactId: id, status: 'PENDING' },
        data: {
          status: 'SKIPPED',
          skipReason: 'The contact withdrew consent',
          followUpAt: null,
        },
      });
      await tx.whatsappTask.updateMany({
        where: { orgId, contactId: id, followUpAt: { not: null } },
        data: { followUpAt: null },
      });
      return { tasksClosed: closed.count };
    });
  }

  /** Deletes the person's details and, with them, every task prepared for them. The ledger stays. */
  async eraseContact(orgId: string, id: string) {
    return this.prisma.whatsappContact.deleteMany({ where: { id, orgId } });
  }

  async listContactTasks(orgId: string, contactId: string) {
    return this.prisma.whatsappTask.findMany({
      where: { orgId, contactId },
      include: { template: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  /** What segments can be built from: the tags, languages and consent sources in use. */
  async facets(orgId: string) {
    const [tagRows, languages, sources] = await Promise.all([
      this.prisma.whatsappContact.findMany({
        where: { orgId, consentStatus: 'OPTED_IN' },
        select: { tags: true },
        take: 20000,
      }),
      this.prisma.whatsappContact.groupBy({
        by: ['language'],
        where: { orgId, consentStatus: 'OPTED_IN', language: { not: null } },
      }),
      this.prisma.whatsappContact.groupBy({
        by: ['consentSource'],
        where: { orgId, consentStatus: 'OPTED_IN' },
      }),
    ]);
    return {
      tags: [...new Set(tagRows.flatMap((r) => r.tags))].sort(),
      languages: languages.map((r) => r.language as string).sort(),
      consentSources: sources.map((r) => r.consentSource).sort(),
    };
  }

  // ---- imports -------------------------------------------------------------------------

  /** Records the batch and adds its contacts together, or neither. */
  async commitImport(
    orgId: string,
    batch: {
      fileName: string | null;
      totalRows: number;
      duplicateRows: number;
      invalidRows: number;
      missingConsentRows: number;
      withdrawnRows: number;
      attestation: string;
      attestedById: string;
    },
    contacts: Array<
      Omit<Prisma.WhatsappContactCreateManyInput, 'orgId' | 'importId'>
    >
  ) {
    return this.prisma.$transaction(async (tx) => {
      const record = await tx.whatsappImport.create({
        data: { orgId, ...batch, importedRows: 0 },
      });
      const created = await tx.whatsappContact.createMany({
        data: contacts.map((c) => ({ ...c, orgId, importId: record.id })),
        skipDuplicates: true,
      });
      // A number that arrived from somewhere else while this ran counts as a duplicate.
      const raced = contacts.length - created.count;
      const saved = await tx.whatsappImport.update({
        where: { id: record.id },
        data: {
          importedRows: created.count,
          duplicateRows: batch.duplicateRows + raced,
        },
      });
      return saved;
    });
  }

  async listImports(orgId: string) {
    return this.prisma.whatsappImport.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // ---- unsubscribe ledger: rows are only ever added -------------------------------------

  async listUnsubscribes(orgId: string) {
    const rows = await this.prisma.whatsappUnsubscribe.findMany({
      where: { orgId },
      orderBy: { receivedAt: 'desc' },
      take: 1000,
    });
    // The ledger holds no name or number; a contact that still exists is found by the hash.
    const contacts = await this.prisma.whatsappContact.findMany({
      where: { orgId, phoneHash: { in: rows.map((r) => r.phoneHash) } },
      select: { id: true, name: true, phone: true, phoneHash: true },
    });
    return { rows, contacts };
  }

  // ---- segments --------------------------------------------------------------------------

  private memberWhere(
    orgId: string,
    filter: WhatsappSegmentFilter
  ): Prisma.WhatsappContactWhereInput {
    return {
      orgId,
      // Opted-out people are never members, whatever the filter says.
      consentStatus: 'OPTED_IN',
      ...(filter.tags.length ? { tags: { hasSome: filter.tags } } : {}),
      ...(filter.languages.length
        ? { language: { in: filter.languages } }
        : {}),
      ...(filter.consentSources.length
        ? { consentSource: { in: filter.consentSources } }
        : {}),
    };
  }

  async countMembers(orgId: string, filter: WhatsappSegmentFilter) {
    return this.prisma.whatsappContact.count({
      where: this.memberWhere(orgId, filter),
    });
  }

  async listMembers(
    orgId: string,
    filter: WhatsappSegmentFilter,
    limit: number
  ) {
    return this.prisma.whatsappContact.findMany({
      where: this.memberWhere(orgId, filter),
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  async listSegments(orgId: string) {
    return this.prisma.whatsappSegment.findMany({
      where: { orgId },
      orderBy: { name: 'asc' },
    });
  }

  async getSegment(orgId: string, id: string) {
    return this.prisma.whatsappSegment.findFirst({ where: { id, orgId } });
  }

  async createSegment(
    orgId: string,
    data: Omit<Prisma.WhatsappSegmentUncheckedCreateInput, 'orgId'>
  ) {
    return this.prisma.whatsappSegment.create({ data: { orgId, ...data } });
  }

  async updateSegment(
    orgId: string,
    id: string,
    data: Prisma.WhatsappSegmentUncheckedUpdateManyInput
  ) {
    await this.prisma.whatsappSegment.updateMany({
      where: { id, orgId },
      data,
    });
    return this.getSegment(orgId, id);
  }

  async deleteSegment(orgId: string, id: string) {
    return this.prisma.whatsappSegment.deleteMany({ where: { id, orgId } });
  }

  // ---- templates -------------------------------------------------------------------------

  async listTemplates(orgId: string) {
    return this.prisma.whatsappTemplate.findMany({
      where: { orgId },
      orderBy: { name: 'asc' },
    });
  }

  async getTemplate(orgId: string, id: string) {
    return this.prisma.whatsappTemplate.findFirst({ where: { id, orgId } });
  }

  async createTemplate(
    orgId: string,
    data: Omit<Prisma.WhatsappTemplateUncheckedCreateInput, 'orgId'>
  ) {
    return this.prisma.whatsappTemplate.create({ data: { orgId, ...data } });
  }

  async updateTemplate(
    orgId: string,
    id: string,
    data: Prisma.WhatsappTemplateUncheckedUpdateManyInput
  ) {
    await this.prisma.whatsappTemplate.updateMany({
      where: { id, orgId },
      data,
    });
    return this.getTemplate(orgId, id);
  }

  async deleteTemplate(orgId: string, id: string) {
    return this.prisma.whatsappTemplate.deleteMany({ where: { id, orgId } });
  }

  // ---- tasks -----------------------------------------------------------------------------

  async createTasks(
    orgId: string,
    tasks: Array<Omit<Prisma.WhatsappTaskCreateManyInput, 'orgId'>>
  ) {
    const created = await this.prisma.whatsappTask.createMany({
      data: tasks.map((t) => ({ ...t, orgId })),
    });
    return created.count;
  }

  /** Contacts that already have this template waiting for them. */
  async findContactsWithOpenTask(
    orgId: string,
    templateId: string,
    contactIds: string[]
  ) {
    const rows = await this.prisma.whatsappTask.findMany({
      where: {
        orgId,
        templateId,
        status: 'PENDING',
        contactId: { in: contactIds },
      },
      select: { contactId: true },
    });
    return new Set(rows.map((r) => r.contactId));
  }

  async listTasks(orgId: string, filters: WhatsappTaskFilters) {
    return this.prisma.whatsappTask.findMany({
      where: {
        orgId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.templateId ? { templateId: filters.templateId } : {}),
        ...(filters.contactId ? { contactId: filters.contactId } : {}),
      },
      include: taskInclude,
      // Waiting work comes in the order it was prepared; finished work shows the latest first.
      orderBy:
        filters.status === 'PENDING'
          ? { createdAt: 'asc' }
          : { updatedAt: 'desc' },
      take: filters.limit ?? 300,
    });
  }

  /** Follow-ups that have come due, for people who are still opted in. */
  async listDue(orgId: string, until: Date) {
    return this.prisma.whatsappTask.findMany({
      where: {
        orgId,
        followUpAt: { not: null, lte: until },
        status: { in: ['PENDING', 'SENT_BY_USER'] },
        contact: { consentStatus: 'OPTED_IN' },
      },
      include: taskInclude,
      orderBy: { followUpAt: 'asc' },
      take: 200,
    });
  }

  async getTask(orgId: string, id: string) {
    return this.prisma.whatsappTask.findFirst({
      where: { id, orgId },
      include: taskInclude,
    });
  }

  /** Changes the status only if it is still what the caller saw. Returns whether it changed. */
  async transitionTask(
    orgId: string,
    id: string,
    from: WhatsappTaskStatus,
    data: Prisma.WhatsappTaskUncheckedUpdateManyInput
  ) {
    const result = await this.prisma.whatsappTask.updateMany({
      where: { id, orgId, status: from },
      data,
    });
    return result.count > 0;
  }

  async updateTask(
    orgId: string,
    id: string,
    data: Prisma.WhatsappTaskUncheckedUpdateManyInput
  ) {
    await this.prisma.whatsappTask.updateMany({ where: { id, orgId }, data });
    return this.getTask(orgId, id);
  }

  /** Names for the people who recorded something, from this agency's own members. */
  async userNames(orgId: string, ids: string[]) {
    const rows = await this.prisma.userOrganization.findMany({
      where: { organizationId: orgId, userId: { in: ids } },
      select: { user: { select: { id: true, name: true } } },
    });
    return new Map(
      rows.map((r) => [r.user.id, r.user.name ?? 'A team member'])
    );
  }

  // ---- settings --------------------------------------------------------------------------

  async getSettings(orgId: string) {
    return this.prisma.whatsappSettings.findUnique({ where: { orgId } });
  }

  async saveSettings(
    orgId: string,
    updatedById: string,
    data: { defaultOptOutLine?: string }
  ) {
    return this.prisma.whatsappSettings.upsert({
      where: { orgId },
      create: { orgId, updatedById, ...data },
      update: { updatedById, ...data },
    });
  }
}
