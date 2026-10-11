import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AgencyRole, DealStage } from '@prisma/client';
import { AgencyCrmRepository } from './agency.crm.repository';
import { AgencyRepository } from './agency.repository';
import { AgencyAccessService, AgencyActor } from './agency.access.service';
import {
  CreateDealDto,
  UpdateDealDto,
} from '@gitroom/nestjs-libraries/dtos/agency/crm.dto';

type DealRow = NonNullable<Awaited<ReturnType<AgencyCrmRepository['getDeal']>>>;

@Injectable()
export class AgencyCrmService {
  constructor(
    private readonly crm: AgencyCrmRepository,
    private readonly agencyRepo: AgencyRepository,
    private readonly access: AgencyAccessService
  ) {}

  /** Sales executives work their own pipeline; managers, admins and owners see everyone's. */
  private sees(actor: AgencyActor, deal: { ownerUserId: string | null }) {
    return (
      actor.role !== AgencyRole.SALES_EXECUTIVE ||
      deal.ownerUserId === actor.userId
    );
  }

  private ownerFilter(actor: AgencyActor) {
    return actor.role === AgencyRole.SALES_EXECUTIVE ? actor.userId : undefined;
  }

  private async requireDeal(actor: AgencyActor, id: string): Promise<DealRow> {
    const deal = await this.crm.getDeal(actor.orgId, id);
    if (!deal || !this.sees(actor, deal)) {
      throw new NotFoundException('Deal not found');
    }
    return deal;
  }

  async listDeals(actor: AgencyActor, filters: { stage?: DealStage } = {}) {
    this.access.assert(actor, 'crm:read');
    return this.crm.listDeals(actor.orgId, {
      stage: filters.stage,
      ownerUserId: this.ownerFilter(actor),
    });
  }

  /** Counts and value per stage, computed from stored deals (never estimated). */
  async summary(actor: AgencyActor) {
    this.access.assert(actor, 'crm:read');
    const rows = await this.crm.pipelineTotals(
      actor.orgId,
      this.ownerFilter(actor)
    );
    const stages = Object.values(DealStage).map((stage) => {
      const mine = rows.filter((r) => r.stage === stage);
      return {
        stage,
        count: mine.reduce((n, r) => n + r._count._all, 0),
        // Values in different currencies are never added together.
        totals: Object.fromEntries(
          mine.map((r) => [r.currency, Number(r._sum.value ?? 0)])
        ),
      };
    });
    return { stages };
  }

  async createDeal(actor: AgencyActor, dto: CreateDealDto) {
    this.access.assert(actor, 'crm:write');
    const ownerUserId = await this.resolveOwner(actor, dto.ownerUserId);
    const deal = await this.crm.createDeal(actor.orgId, {
      contactName: dto.contactName.trim(),
      companyName: dto.companyName?.trim() || null,
      contactEmail: dto.contactEmail || null,
      contactPhone: dto.contactPhone || null,
      value: dto.value ?? null,
      currency: dto.currency?.toUpperCase(),
      expectedCloseDate: dto.expectedCloseDate
        ? new Date(dto.expectedCloseDate)
        : null,
      notes: dto.notes || null,
      ownerUserId,
    });
    await this.access.audit(actor, {
      action: 'deal.created',
      entityType: 'Deal',
      entityId: deal.id,
      summary: deal.companyName || deal.contactName,
    });
    return deal;
  }

  async updateDeal(actor: AgencyActor, id: string, dto: UpdateDealDto) {
    this.access.assert(actor, 'crm:write');
    await this.requireDeal(actor, id);
    const ownerUserId =
      dto.ownerUserId !== undefined
        ? await this.resolveOwner(actor, dto.ownerUserId)
        : undefined;
    const updated = await this.crm.updateDeal(actor.orgId, id, {
      contactName: dto.contactName?.trim(),
      companyName: dto.companyName?.trim(),
      contactEmail: dto.contactEmail,
      contactPhone: dto.contactPhone,
      value: dto.value,
      currency: dto.currency?.toUpperCase(),
      expectedCloseDate: dto.expectedCloseDate
        ? new Date(dto.expectedCloseDate)
        : undefined,
      notes: dto.notes,
      ownerUserId,
    });
    await this.access.audit(actor, {
      action: 'deal.updated',
      entityType: 'Deal',
      entityId: id,
    });
    return updated;
  }

  async moveStage(
    actor: AgencyActor,
    id: string,
    stage: DealStage,
    lostReason?: string
  ) {
    this.access.assert(actor, 'crm:write');
    const deal = await this.requireDeal(actor, id);
    if (deal.stage === stage) return deal;
    if (stage === DealStage.LOST && !lostReason?.trim()) {
      throw new BadRequestException(
        'Say why the deal was lost so the team can learn from it'
      );
    }
    const moved = await this.crm.setStage(
      actor.orgId,
      id,
      deal.stage,
      stage,
      stage === DealStage.LOST ? lostReason!.trim() : null
    );
    if (!moved) {
      throw new ConflictException(
        'Someone else just moved this deal; reload and try again'
      );
    }
    await this.access.audit(actor, {
      action: 'deal.stage_changed',
      entityType: 'Deal',
      entityId: id,
      summary: `${deal.stage} → ${stage}`,
    });
    return this.crm.getDeal(actor.orgId, id);
  }

  /** Turns a deal into a client (once), carrying over the contact details and owner. */
  async convertToClient(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'crm:write');
    this.access.assert(actor, 'client:write');
    const deal = await this.requireDeal(actor, id);
    if (deal.customerId) {
      throw new ConflictException('This deal already has a client');
    }
    const client = await this.agencyRepo.createClient(actor.orgId, {
      name: (deal.companyName || deal.contactName).trim(),
      email: deal.contactEmail ?? undefined,
      phone: deal.contactPhone ?? undefined,
      companyName: deal.companyName ?? undefined,
      notes: deal.notes ?? undefined,
      assignedSalesUserId: deal.ownerUserId ?? undefined,
    });
    if (!(await this.crm.linkCustomer(actor.orgId, id, client.id))) {
      throw new ConflictException('This deal already has a client');
    }
    await this.access.audit(actor, {
      action: 'deal.converted',
      entityType: 'Deal',
      entityId: id,
      summary: `Created client ${client.name}`,
      metadata: { customerId: client.id },
    });
    return { deal: await this.crm.getDeal(actor.orgId, id), client };
  }

  async deleteDeal(actor: AgencyActor, id: string) {
    this.access.assert(actor, 'crm:delete');
    await this.requireDeal(actor, id);
    await this.crm.deleteDeal(actor.orgId, id);
    await this.access.audit(actor, {
      action: 'deal.deleted',
      entityType: 'Deal',
      entityId: id,
    });
    return { deleted: true };
  }

  /** Executives own what they create; only managers and above may hand a deal to someone else. */
  private async resolveOwner(actor: AgencyActor, requested?: string | null) {
    if (!requested || requested === actor.userId) return actor.userId;
    if (actor.role === AgencyRole.SALES_EXECUTIVE) {
      throw new BadRequestException(
        'Only a sales manager can assign a deal to someone else'
      );
    }
    if (!(await this.agencyRepo.isActiveOrgMember(actor.orgId, requested))) {
      throw new BadRequestException(
        'The owner is not a member of this workspace'
      );
    }
    return requested;
  }
}
