import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export interface LeadFilters {
  linkId?: string;
  campaignId?: string;
  status?: string;
  search?: string;
  /** A sales executive sees the leads from links they made. */
  createdById?: string;
  includeOptedOut?: boolean;
}

const OPTED_OUT = 'OPTED_OUT';

const leadInclude = {
  leadLink: { select: { id: true, label: true, createdById: true } },
  campaign: { select: { id: true, name: true } },
} satisfies Prisma.LeadCaptureInclude;

@Injectable()
export class AgencyLeadsRepository {
  constructor(private prisma: PrismaService) {}

  // ---- links ---------------------------------------------------------------------------

  async createLink(
    orgId: string,
    createdById: string,
    data: {
      label: string;
      code: string;
      campaignId?: string;
      botId: string | null;
      welcomeMessage?: string;
    }
  ) {
    return this.prisma.leadLink.create({
      data: { orgId, createdById, ...data },
    });
  }

  async getLinkByCode(code: string) {
    return this.prisma.leadLink.findFirst({
      where: { code, deletedAt: null },
    });
  }

  async getLinkById(orgId: string, id: string) {
    return this.prisma.leadLink.findFirst({
      where: { id, orgId, deletedAt: null },
    });
  }

  async listLinks(orgId: string, createdById?: string) {
    const links = await this.prisma.leadLink.findMany({
      where: {
        orgId,
        deletedAt: null,
        ...(createdById ? { createdById } : {}),
      },
      include: { campaign: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const counts = await this.prisma.leadCapture.groupBy({
      by: ['leadLinkId', 'status'],
      where: { orgId, leadLinkId: { in: links.map((l) => l.id) } },
      _count: { _all: true },
    });
    return links.map((link) => {
      const mine = counts.filter((c) => c.leadLinkId === link.id);
      const stopped =
        mine.find((c) => c.status === OPTED_OUT)?._count._all ?? 0;
      const total = mine.reduce((sum, c) => sum + c._count._all, 0);
      return { ...link, people: total - stopped, stopped };
    });
  }

  async deleteLink(orgId: string, id: string) {
    return this.prisma.leadLink.updateMany({
      where: { id, orgId },
      data: { deletedAt: new Date() },
    });
  }

  // ---- people who started a bot ------------------------------------------------------

  async findLead(leadLinkId: string, telegramUserId: string) {
    return this.prisma.leadCapture.findUnique({
      where: { leadLinkId_telegramUserId: { leadLinkId, telegramUserId } },
    });
  }

  async saveStarted(
    link: { id: string; orgId: string; campaignId: string | null },
    person: {
      telegramUserId: string;
      name: string | null;
      handle: string | null;
    }
  ) {
    const now = new Date();
    const details = {
      name: person.name,
      telegramHandle: person.handle,
      // Starting again after /stop is a new request to hear from the agency.
      status: 'NEW',
      consentedAt: now,
      optedOutAt: null as Date | null,
    };
    const existing = await this.findLead(link.id, person.telegramUserId);
    if (existing && existing.status !== OPTED_OUT) {
      return this.prisma.leadCapture.update({
        where: { id: existing.id },
        data: { name: person.name, telegramHandle: person.handle },
      });
    }
    if (existing) {
      return this.prisma.leadCapture.update({
        where: { id: existing.id },
        data: details,
      });
    }
    return this.prisma.leadCapture.create({
      data: {
        orgId: link.orgId,
        campaignId: link.campaignId,
        leadLinkId: link.id,
        telegramUserId: person.telegramUserId,
        source: 'telegram-bot',
        ...details,
      },
    });
  }

  /** The person said /stop: forget their details and never contact them, until they ask again. */
  async optOut(botId: string | null, telegramUserId: string) {
    const result = await this.prisma.leadCapture.updateMany({
      where: {
        telegramUserId,
        status: { not: OPTED_OUT },
        leadLink: { botId },
      },
      data: {
        status: OPTED_OUT,
        optedOutAt: new Date(),
        name: null,
        telegramHandle: null,
        email: null,
        phone: null,
        notes: null,
      },
    });
    return result.count;
  }

  async listLeads(orgId: string, filters: LeadFilters) {
    const search = filters.search?.trim();
    return this.prisma.leadCapture.findMany({
      where: {
        orgId,
        ...(filters.linkId ? { leadLinkId: filters.linkId } : {}),
        ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
        ...(filters.status
          ? { status: filters.status }
          : filters.includeOptedOut
          ? {}
          : { status: { not: OPTED_OUT } }),
        ...(filters.createdById
          ? { leadLink: { createdById: filters.createdById } }
          : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                {
                  telegramHandle: {
                    contains: search,
                    mode: 'insensitive' as const,
                  },
                },
                { notes: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      include: leadInclude,
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
  }

  async getLead(orgId: string, id: string) {
    return this.prisma.leadCapture.findFirst({
      where: { id, orgId },
      include: leadInclude,
    });
  }

  async updateLead(
    orgId: string,
    id: string,
    data: { status?: string; notes?: string | null }
  ) {
    await this.prisma.leadCapture.updateMany({ where: { id, orgId }, data });
    return this.getLead(orgId, id);
  }

  async deleteLead(orgId: string, id: string) {
    return this.prisma.leadCapture.deleteMany({ where: { id, orgId } });
  }
}
