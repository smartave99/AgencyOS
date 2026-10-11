import { Injectable } from '@nestjs/common';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { DealStage, Prisma } from '@prisma/client';

export interface DealData {
  contactName: string;
  companyName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  value?: number | null;
  currency?: string;
  expectedCloseDate?: Date | null;
  notes?: string | null;
  ownerUserId?: string | null;
  customerId?: string | null;
}

const dealInclude = {
  owner: { select: { id: true, name: true, email: true } },
  customer: { select: { id: true, name: true, companyName: true } },
} satisfies Prisma.DealInclude;

@Injectable()
export class AgencyCrmRepository {
  constructor(private prisma: PrismaService) {}

  async listDeals(
    orgId: string,
    filters: { stage?: DealStage; ownerUserId?: string }
  ) {
    return this.prisma.deal.findMany({
      where: {
        orgId,
        deletedAt: null,
        ...(filters.stage ? { stage: filters.stage } : {}),
        ...(filters.ownerUserId ? { ownerUserId: filters.ownerUserId } : {}),
      },
      include: dealInclude,
      orderBy: { stageChangedAt: 'desc' },
      take: 500,
    });
  }

  async getDeal(orgId: string, id: string) {
    return this.prisma.deal.findFirst({
      where: { id, orgId, deletedAt: null },
      include: dealInclude,
    });
  }

  async createDeal(orgId: string, data: DealData) {
    return this.prisma.deal.create({
      data: { ...this.toColumns(data), orgId },
      include: dealInclude,
    });
  }

  async updateDeal(orgId: string, id: string, data: Partial<DealData>) {
    await this.prisma.deal.updateMany({
      where: { id, orgId, deletedAt: null },
      data: this.toColumns(data),
    });
    return this.getDeal(orgId, id);
  }

  async setStage(
    orgId: string,
    id: string,
    from: DealStage,
    stage: DealStage,
    lostReason: string | null
  ) {
    // Guarded on the stage the caller saw, so two people moving the same card don't
    // silently overwrite each other.
    const res = await this.prisma.deal.updateMany({
      where: { id, orgId, deletedAt: null, stage: from },
      data: { stage, lostReason, stageChangedAt: new Date() },
    });
    return res.count === 1;
  }

  async linkCustomer(orgId: string, id: string, customerId: string) {
    const res = await this.prisma.deal.updateMany({
      where: { id, orgId, deletedAt: null, customerId: null },
      data: { customerId },
    });
    return res.count === 1;
  }

  async deleteDeal(orgId: string, id: string) {
    return this.prisma.deal.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  async pipelineTotals(orgId: string, ownerUserId?: string) {
    return this.prisma.deal.groupBy({
      by: ['stage', 'currency'],
      where: {
        orgId,
        deletedAt: null,
        ...(ownerUserId ? { ownerUserId } : {}),
      },
      _count: { _all: true },
      _sum: { value: true },
    });
  }

  private toColumns(data: Partial<DealData>) {
    const out: Prisma.DealUncheckedUpdateManyInput = {};
    if (data.contactName !== undefined) out.contactName = data.contactName;
    if (data.companyName !== undefined) out.companyName = data.companyName;
    if (data.contactEmail !== undefined) out.contactEmail = data.contactEmail;
    if (data.contactPhone !== undefined) out.contactPhone = data.contactPhone;
    if (data.value !== undefined) {
      out.value = data.value === null ? null : new Prisma.Decimal(data.value);
    }
    if (data.currency !== undefined) out.currency = data.currency;
    if (data.expectedCloseDate !== undefined) {
      out.expectedCloseDate = data.expectedCloseDate;
    }
    if (data.notes !== undefined) out.notes = data.notes;
    if (data.ownerUserId !== undefined) out.ownerUserId = data.ownerUserId;
    if (data.customerId !== undefined) out.customerId = data.customerId;
    return out as Prisma.DealUncheckedCreateInput;
  }
}
