import { Injectable } from '@nestjs/common';
import {
  Prisma,
  TelegramAccountEventKind,
  TelegramUserAccountStatus,
} from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

@Injectable()
export class AgencyTelegramUsersRepository {
  constructor(private prisma: PrismaService) {}

  async list(orgId: string) {
    const accounts = await this.prisma.telegramUserAccount.findMany({
      where: { orgId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    const [destinations, communities] = await Promise.all([
      this.prisma.telegramDestination.groupBy({
        by: ['userAccountId'],
        where: {
          orgId,
          deletedAt: null,
          userAccountId: { in: accounts.map((a) => a.id) },
        },
        _count: { _all: true },
      }),
      this.prisma.community.groupBy({
        by: ['operatingAccountId'],
        where: {
          orgId,
          operatingAccountId: { in: accounts.map((a) => a.id) },
        },
        _count: { _all: true },
      }),
    ]);
    return accounts.map((a) => ({
      ...a,
      destinationCount:
        destinations.find((d) => d.userAccountId === a.id)?._count._all ?? 0,
      communityCount:
        communities.find((c) => c.operatingAccountId === a.id)?._count._all ??
        0,
    }));
  }

  async get(orgId: string, id: string) {
    return this.prisma.telegramUserAccount.findFirst({
      where: { id, orgId, deletedAt: null },
    });
  }

  async findByTelegramUser(orgId: string, telegramUserId: string) {
    return this.prisma.telegramUserAccount.findFirst({
      where: { orgId, telegramUserId, deletedAt: null },
    });
  }

  async create(
    orgId: string,
    data: Omit<
      Prisma.TelegramUserAccountUncheckedCreateInput,
      'orgId' | 'id' | 'createdAt' | 'updatedAt'
    >
  ) {
    return this.prisma.telegramUserAccount.create({ data: { orgId, ...data } });
  }

  /** Org-scoped write; returns the fresh row, or null when it is not this agency's. */
  async update(
    orgId: string,
    id: string,
    data: Prisma.TelegramUserAccountUncheckedUpdateManyInput
  ) {
    const { count } = await this.prisma.telegramUserAccount.updateMany({
      where: { id, orgId, deletedAt: null },
      data,
    });
    return count ? this.get(orgId, id) : null;
  }

  async setStatus(
    orgId: string,
    id: string,
    status: TelegramUserAccountStatus,
    extra: {
      statusReason?: string | null;
      rateLimitedUntil?: Date | null;
      lastError?: string | null;
      lastErrorCode?: string | null;
      lastCheckedAt?: Date;
    } = {}
  ) {
    return this.update(orgId, id, { status, ...extra });
  }

  async softDelete(orgId: string, id: string) {
    const { count } = await this.prisma.telegramUserAccount.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date(), sealed: '' },
    });
    return count > 0;
  }

  async addEvent(
    orgId: string,
    accountId: string,
    event: {
      kind: TelegramAccountEventKind;
      code?: string | null;
      message: string;
      actorUserId?: string | null;
    }
  ) {
    return this.prisma.telegramAccountEvent.create({
      data: {
        orgId,
        accountId,
        kind: event.kind,
        code: event.code ?? null,
        message: event.message.slice(0, 500),
        actorUserId: event.actorUserId ?? null,
      },
    });
  }

  async events(orgId: string, accountId: string, take = 50) {
    return this.prisma.telegramAccountEvent.findMany({
      where: { orgId, accountId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /** Destinations that post through this account: they stop when it does. */
  async destinationIds(orgId: string, accountId: string) {
    const rows = await this.prisma.telegramDestination.findMany({
      where: { orgId, userAccountId: accountId, deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
