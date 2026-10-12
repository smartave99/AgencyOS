import { Injectable } from '@nestjs/common';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { AgencyRole, Prisma } from '@prisma/client';

export interface CreateAuditEventParams {
  orgId: string;
  actorUserId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string | null;
  metadata?: Prisma.InputJsonValue;
}

@Injectable()
export class AgencyAccessRepository {
  constructor(private prisma: PrismaService) {}

  // ==========================================
  // AGENCY MEMBERS (roles layered on AgencyOS org membership)
  // ==========================================
  async getMember(orgId: string, userId: string) {
    return this.prisma.agencyMember.findUnique({
      where: { orgId_userId: { orgId, userId } },
      select: { role: true, customerId: true },
    });
  }

  async isActiveOrgMember(orgId: string, userId: string) {
    const membership = await this.prisma.userOrganization.findFirst({
      where: { organizationId: orgId, userId, disabled: false },
      select: { id: true },
    });
    return !!membership;
  }

  async listOrgUsers(orgId: string) {
    return this.prisma.userOrganization.findMany({
      where: { organizationId: orgId, disabled: false },
      select: {
        role: true,
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async listMembers(orgId: string) {
    return this.prisma.agencyMember.findMany({
      where: { orgId },
      select: { userId: true, role: true, customerId: true },
    });
  }

  async upsertMember(
    orgId: string,
    userId: string,
    role: AgencyRole,
    customerId: string | null
  ) {
    return this.prisma.agencyMember.upsert({
      where: { orgId_userId: { orgId, userId } },
      create: { orgId, userId, role, customerId },
      update: { role, customerId },
      select: { userId: true, role: true, customerId: true },
    });
  }

  async countMembersWithRole(orgId: string, role: AgencyRole) {
    return this.prisma.agencyMember.count({ where: { orgId, role } });
  }

  // ==========================================
  // AUDIT TRAIL
  // ==========================================
  async createAuditEvent(params: CreateAuditEventParams) {
    return this.prisma.auditEvent.create({
      data: {
        orgId: params.orgId,
        actorUserId: params.actorUserId ?? null,
        actorRole: params.actorRole ?? null,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId ?? null,
        summary: params.summary ?? null,
        ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      },
    });
  }

  async listAuditEvents(
    orgId: string,
    filters: { entityType?: string; entityId?: string; limit?: number }
  ) {
    return this.prisma.auditEvent.findMany({
      where: {
        orgId,
        ...(filters.entityType ? { entityType: filters.entityType } : {}),
        ...(filters.entityId ? { entityId: filters.entityId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.limit ?? 100, 500),
    });
  }
}
