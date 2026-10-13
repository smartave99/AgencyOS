import { Injectable } from '@nestjs/common';
import { CommunityRelation, CommunityStage, Prisma } from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export interface CommunityFilters {
  search?: string;
  stage?: CommunityStage;
  relation?: CommunityRelation;
  category?: string;
  language?: string;
  tag?: string;
  kind?: string;
  bookmarked?: boolean;
  /** Hide communities Telegram no longer shows. */
  availableOnly?: boolean;
  sort?: 'title' | 'members' | 'recent' | 'refreshed';
  limit?: number;
}

/** Everything a screen shows about a community; no operator-secret fields exist on the row. */
export type CommunityMetadata = {
  telegramId: string | null;
  kind: string | null;
  username: string | null;
  title: string;
  description: string | null;
  memberCount: number | null;
  verified: boolean;
  scam: boolean;
  fake: boolean;
  joinRequestRequired: boolean;
  slowModeSeconds: number | null;
};

@Injectable()
export class AgencyCommunitiesRepository {
  constructor(private prisma: PrismaService) {}

  async list(orgId: string, f: CommunityFilters = {}) {
    const where: Prisma.CommunityWhereInput = {
      orgId,
      ...(f.stage ? { stage: f.stage } : {}),
      ...(f.relation ? { relation: f.relation } : {}),
      ...(f.category ? { category: f.category } : {}),
      ...(f.language ? { language: f.language } : {}),
      ...(f.kind ? { kind: f.kind } : {}),
      ...(f.tag ? { tags: { has: f.tag } } : {}),
      ...(f.bookmarked ? { bookmarked: true } : {}),
      ...(f.availableOnly ? { available: true } : {}),
      ...(f.search
        ? {
            OR: [
              { title: { contains: f.search, mode: 'insensitive' } },
              {
                username: {
                  contains: f.search.replace(/^@/, ''),
                  mode: 'insensitive',
                },
              },
              { description: { contains: f.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const orderBy: Prisma.CommunityOrderByWithRelationInput[] =
      f.sort === 'members'
        ? [{ memberCount: { sort: 'desc', nulls: 'last' } }, { title: 'asc' }]
        : f.sort === 'recent'
        ? [{ createdAt: 'desc' }]
        : f.sort === 'refreshed'
        ? [{ lastRefreshedAt: { sort: 'asc', nulls: 'first' } }]
        : [{ title: 'asc' }];
    return this.prisma.community.findMany({
      where,
      orderBy,
      take: Math.min(Math.max(f.limit ?? 200, 1), 500),
      include: {
        operatingAccount: { select: { id: true, label: true, username: true } },
      },
    });
  }

  async get(orgId: string, id: string) {
    return this.prisma.community.findFirst({
      where: { id, orgId },
      include: {
        operatingAccount: { select: { id: true, label: true, username: true } },
        destinations: {
          where: { deletedAt: null },
          select: { id: true, authorizationStatus: true, userAccountId: true },
        },
      },
    });
  }

  /** The directory keeps one row per community: matched by Telegram's id first, then by public name. */
  async findExisting(
    orgId: string,
    keys: { telegramId?: string | null; username?: string | null }
  ) {
    const or: Prisma.CommunityWhereInput[] = [];
    if (keys.telegramId) or.push({ telegramId: keys.telegramId });
    if (keys.username) {
      or.push({ username: { equals: keys.username, mode: 'insensitive' } });
    }
    if (!or.length) return null;
    return this.prisma.community.findFirst({ where: { orgId, OR: or } });
  }

  async create(
    orgId: string,
    data: Omit<
      Prisma.CommunityUncheckedCreateInput,
      'orgId' | 'id' | 'createdAt' | 'updatedAt'
    >
  ) {
    return this.prisma.community.create({ data: { orgId, ...data } });
  }

  async update(
    orgId: string,
    id: string,
    data: Prisma.CommunityUncheckedUpdateManyInput
  ) {
    const { count } = await this.prisma.community.updateMany({
      where: { id, orgId },
      data,
    });
    return count ? this.get(orgId, id) : null;
  }

  async remove(orgId: string, id: string) {
    const { count } = await this.prisma.community.deleteMany({
      where: { id, orgId },
    });
    return count > 0;
  }

  async addHistory(
    orgId: string,
    communityId: string,
    entry: {
      kind: string;
      summary: string;
      fromStage?: CommunityStage | null;
      toStage?: CommunityStage | null;
      changes?: Prisma.InputJsonValue;
      actorUserId?: string | null;
    }
  ) {
    return this.prisma.communityHistory.create({
      data: {
        orgId,
        communityId,
        kind: entry.kind,
        summary: entry.summary.slice(0, 500),
        fromStage: entry.fromStage ?? null,
        toStage: entry.toStage ?? null,
        changes: entry.changes,
        actorUserId: entry.actorUserId ?? null,
      },
    });
  }

  async history(orgId: string, communityId: string, take = 100) {
    return this.prisma.communityHistory.findMany({
      where: { orgId, communityId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /** How many joins an account made in the last day: the daily cap counts these. */
  async joinsSince(orgId: string, accountId: string, since: Date) {
    return this.prisma.communityHistory.count({
      where: {
        orgId,
        kind: 'JOIN',
        createdAt: { gte: since },
        community: { operatingAccountId: accountId },
      },
    });
  }

  async userName(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { name: true, email: true },
    });
    return user?.name || user?.email || null;
  }

  /** Communities worth looking at again: the oldest lookups first. */
  async dueForRefresh(orgId: string, olderThan: Date, take: number) {
    return this.prisma.community.findMany({
      where: {
        orgId,
        username: { not: null },
        OR: [{ lastRefreshedAt: null }, { lastRefreshedAt: { lt: olderThan } }],
      },
      orderBy: { lastRefreshedAt: { sort: 'asc', nulls: 'first' } },
      take,
    });
  }

  async orgsWithCommunities() {
    const rows = await this.prisma.community.groupBy({ by: ['orgId'] });
    return rows.map((r) => r.orgId);
  }

  async destinationForChat(orgId: string, chatId: string) {
    return this.prisma.telegramDestination.findFirst({
      where: { orgId, chatId, deletedAt: null },
    });
  }

  async createUserDestination(
    orgId: string,
    data: Omit<
      Prisma.TelegramDestinationUncheckedCreateInput,
      'orgId' | 'id' | 'createdAt' | 'updatedAt'
    >
  ) {
    return this.prisma.telegramDestination.create({ data: { orgId, ...data } });
  }
}
