import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AgencyRole, Prisma } from '@prisma/client';
import { AgencyAccessRepository } from './agency.access.repository';
import { AgencyRepository } from './agency.repository';

export type AgencyPermission =
  | 'dashboard:read'
  | 'client:read'
  | 'client:write'
  | 'client:delete'
  | 'campaign:read'
  | 'campaign:write'
  | 'campaign:approve'
  | 'campaign:schedule'
  | 'campaign:publish'
  | 'campaign:control'
  | 'campaign:delete'
  | 'destination:read'
  | 'destination:manage'
  | 'bot:manage'
  | 'accounts:read'
  | 'accounts:manage'
  | 'crm:read'
  | 'crm:write'
  | 'crm:delete'
  | 'whatsapp:read'
  | 'whatsapp:write'
  | 'whatsapp:delete'
  | 'whatsapp:manage'
  | 'billing:read'
  | 'billing:write'
  | 'analytics:read'
  | 'intelligence:read'
  | 'intelligence:manage'
  | 'ai:use'
  | 'ai:configure'
  | 'team:read'
  | 'team:manage'
  | 'audit:read'
  | 'portal:view'
  | 'portal:review';

export interface AgencyActor {
  userId: string;
  orgId: string;
  role: AgencyRole;
  /** Set only for CLIENT actors: the single customer they may see. */
  customerId: string | null;
  isSuperAdmin: boolean;
}

const OWNER = AgencyRole.AGENCY_OWNER;
const ADMIN = AgencyRole.AGENCY_ADMIN;
const SALES_MANAGER = AgencyRole.SALES_MANAGER;
const SALES_EXEC = AgencyRole.SALES_EXECUTIVE;
const CAMPAIGN_MANAGER = AgencyRole.CAMPAIGN_MANAGER;
const EDITOR = AgencyRole.CONTENT_EDITOR;
const ANALYST = AgencyRole.ANALYST;
const CLIENT = AgencyRole.CLIENT;

const ALL_STAFF: AgencyRole[] = [
  OWNER,
  ADMIN,
  SALES_MANAGER,
  SALES_EXEC,
  CAMPAIGN_MANAGER,
  EDITOR,
  ANALYST,
];

/**
 * The single source of truth for who may do what. Anything not listed for a role is
 * denied. Reviewers (approve) are deliberately a smaller set than authors (write).
 */
export const AGENCY_PERMISSIONS: Record<AgencyPermission, AgencyRole[]> = {
  'dashboard:read': ALL_STAFF,
  'client:read': ALL_STAFF,
  'client:write': [OWNER, ADMIN, SALES_MANAGER, SALES_EXEC],
  'client:delete': [OWNER, ADMIN, SALES_MANAGER],
  'campaign:read': ALL_STAFF,
  'campaign:write': [
    OWNER,
    ADMIN,
    SALES_MANAGER,
    SALES_EXEC,
    CAMPAIGN_MANAGER,
    EDITOR,
  ],
  'campaign:approve': [OWNER, ADMIN, SALES_MANAGER, CAMPAIGN_MANAGER],
  'campaign:schedule': [OWNER, ADMIN, SALES_MANAGER, CAMPAIGN_MANAGER],
  'campaign:publish': [OWNER, ADMIN, CAMPAIGN_MANAGER],
  'campaign:control': [OWNER, ADMIN, SALES_MANAGER, CAMPAIGN_MANAGER],
  'campaign:delete': [OWNER, ADMIN, CAMPAIGN_MANAGER],
  'destination:read': ALL_STAFF,
  'destination:manage': [OWNER, ADMIN, CAMPAIGN_MANAGER],
  // A bot's token is a password for it, so only owners and admins connect or remove bots.
  'bot:manage': [OWNER, ADMIN],
  'accounts:read': ALL_STAFF,
  'accounts:manage': [OWNER, ADMIN, CAMPAIGN_MANAGER],
  'crm:read': [OWNER, ADMIN, SALES_MANAGER, SALES_EXEC],
  'crm:write': [OWNER, ADMIN, SALES_MANAGER, SALES_EXEC],
  'crm:delete': [OWNER, ADMIN, SALES_MANAGER],
  // WhatsApp is worked by hand by sales and marketing staff. Everyone on the staff can see the lists
  // (numbers masked); only those who work the contacts see a full number or get a chat link.
  'whatsapp:read': ALL_STAFF,
  'whatsapp:write': [
    OWNER,
    ADMIN,
    SALES_MANAGER,
    SALES_EXEC,
    CAMPAIGN_MANAGER,
    EDITOR,
  ],
  'whatsapp:delete': [OWNER, ADMIN, SALES_MANAGER],
  'whatsapp:manage': [OWNER, ADMIN],
  'billing:read': [OWNER, ADMIN, SALES_MANAGER],
  'billing:write': [OWNER, ADMIN, SALES_MANAGER],
  'analytics:read': ALL_STAFF,
  'intelligence:read': [OWNER, ADMIN, SALES_MANAGER, CAMPAIGN_MANAGER, ANALYST],
  'intelligence:manage': [OWNER, ADMIN, CAMPAIGN_MANAGER],
  'ai:use': ALL_STAFF,
  'ai:configure': [OWNER, ADMIN],
  'team:read': ALL_STAFF,
  'team:manage': [OWNER, ADMIN],
  'audit:read': [OWNER, ADMIN],
  'portal:view': [...ALL_STAFF, CLIENT],
  'portal:review': [CLIENT],
};

type PostizOrgRole = 'SUPERADMIN' | 'ADMIN' | 'USER' | undefined;

@Injectable()
export class AgencyAccessService {
  private readonly logger = new Logger(AgencyAccessService.name);

  constructor(
    private readonly accessRepo: AgencyAccessRepository,
    private readonly agencyRepo: AgencyRepository
  ) {}

  /**
   * An explicit AgencyMember row always wins. Without one, the role is derived from
   * AgencyOS's coarse organization role, defaulting to the least-privileged staff role
   * that can still do day-to-day work (never to an approver).
   */
  async resolveActor(
    org: { id: string },
    user: { id: string; isSuperAdmin?: boolean | null },
    orgRole?: PostizOrgRole
  ): Promise<AgencyActor> {
    const isSuperAdmin = !!user.isSuperAdmin;
    const member = await this.accessRepo.getMember(org.id, user.id);
    if (member) {
      return {
        userId: user.id,
        orgId: org.id,
        role: member.role,
        customerId: member.customerId,
        isSuperAdmin,
      };
    }
    const derived: AgencyRole = isSuperAdmin
      ? OWNER
      : orgRole === 'SUPERADMIN'
      ? OWNER
      : orgRole === 'ADMIN'
      ? ADMIN
      : SALES_EXEC;
    return {
      userId: user.id,
      orgId: org.id,
      role: derived,
      customerId: null,
      isSuperAdmin,
    };
  }

  can(actor: AgencyActor, permission: AgencyPermission): boolean {
    return AGENCY_PERMISSIONS[permission].includes(actor.role);
  }

  assert(actor: AgencyActor, permission: AgencyPermission): void {
    if (!this.can(actor, permission)) {
      throw new ForbiddenException(
        `Your role (${actor.role}) is not allowed to perform this action`
      );
    }
  }

  isClient(actor: AgencyActor): boolean {
    return actor.role === CLIENT;
  }

  /** CLIENT actors may only ever touch their own customer; staff are unrestricted. */
  assertCustomerScope(actor: AgencyActor, customerId: string): void {
    if (this.isClient(actor) && actor.customerId !== customerId) {
      throw new NotFoundException('Client not found');
    }
  }

  // ==========================================
  // TEAM MANAGEMENT
  // ==========================================
  private readonly clientCache = new Map<
    string,
    { client: boolean; at: number }
  >();

  /**
   * True when this person is a portal-only CLIENT in this agency. Used by the auth
   * middleware to keep clients out of the workspace's own APIs (connected accounts,
   * posts, notifications), which know nothing about agency roles. The answer is cached
   * for a few seconds so that a request does not pay for a lookup every time; a role
   * change takes effect here immediately and elsewhere within the cache window.
   */
  async isClientUser(orgId: string, userId: string) {
    const key = `${orgId}:${userId}`;
    const hit = this.clientCache.get(key);
    if (hit && Date.now() - hit.at < 15000) return hit.client;
    const member = await this.accessRepo.getMember(orgId, userId);
    const client = member?.role === AgencyRole.CLIENT;
    this.clientCache.set(key, { client, at: Date.now() });
    if (this.clientCache.size > 5000) this.clientCache.clear();
    return client;
  }

  async listTeam(actor: AgencyActor) {
    this.assert(actor, 'team:read');
    const [users, members] = await Promise.all([
      this.accessRepo.listOrgUsers(actor.orgId),
      this.accessRepo.listMembers(actor.orgId),
    ]);
    const byUser = new Map(members.map((m) => [m.userId, m]));
    return users.map((u) => {
      const explicit = byUser.get(u.user.id);
      return {
        userId: u.user.id,
        name: u.user.name,
        email: u.user.email,
        workspaceRole: u.role,
        agencyRole:
          explicit?.role ??
          (u.role === 'SUPERADMIN'
            ? OWNER
            : u.role === 'ADMIN'
            ? ADMIN
            : SALES_EXEC),
        customerId: explicit?.customerId ?? null,
        roleSource: explicit ? 'ASSIGNED' : 'DERIVED',
      };
    });
  }

  async setRole(
    actor: AgencyActor,
    targetUserId: string,
    role: AgencyRole,
    customerId?: string | null
  ) {
    this.assert(actor, 'team:manage');
    if (targetUserId === actor.userId) {
      throw new BadRequestException('You cannot change your own role');
    }
    if (role === OWNER && actor.role !== OWNER && !actor.isSuperAdmin) {
      throw new ForbiddenException(
        'Only an Agency Owner can grant the Owner role'
      );
    }
    if (!(await this.accessRepo.isActiveOrgMember(actor.orgId, targetUserId))) {
      throw new NotFoundException('User is not a member of this workspace');
    }
    if (role === CLIENT) {
      if (!customerId) {
        throw new BadRequestException(
          'A client user must be linked to a client'
        );
      }
      const customer = await this.agencyRepo.getClientById(
        actor.orgId,
        customerId
      );
      if (!customer) {
        throw new NotFoundException('Client not found');
      }
    }
    this.clientCache.delete(`${actor.orgId}:${targetUserId}`);
    const member = await this.accessRepo.upsertMember(
      actor.orgId,
      targetUserId,
      role,
      role === CLIENT ? customerId! : null
    );
    await this.accessRepo.createAuditEvent({
      orgId: actor.orgId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'team.role_changed',
      entityType: 'User',
      entityId: targetUserId,
      summary: `Role set to ${role}`,
      metadata: {
        role,
        customerId: member.customerId,
      } as Prisma.InputJsonValue,
    });
    return member;
  }

  // ==========================================
  // AUDIT TRAIL
  // ==========================================
  /**
   * Audit writes must never take down the action being audited, but a failure is
   * logged loudly so it cannot go unnoticed.
   */
  async audit(
    actor: Pick<AgencyActor, 'orgId' | 'userId' | 'role'> | null,
    entry: {
      orgId?: string;
      action: string;
      entityType: string;
      entityId?: string | null;
      summary?: string;
      metadata?: Prisma.InputJsonValue;
    }
  ): Promise<void> {
    const orgId = entry.orgId ?? actor?.orgId;
    if (!orgId) {
      this.logger.error(`Audit event ${entry.action} dropped: no organization`);
      return;
    }
    try {
      await this.accessRepo.createAuditEvent({
        orgId,
        actorUserId: actor?.userId ?? null,
        actorRole: actor?.role ?? 'SYSTEM',
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        summary: entry.summary,
        metadata: entry.metadata,
      });
    } catch (err: any) {
      this.logger.error(
        `Failed to write audit event ${entry.action}: ${err?.message}`
      );
    }
  }

  async listAudit(
    actor: AgencyActor,
    filters: { entityType?: string; entityId?: string; limit?: number }
  ) {
    this.assert(actor, 'audit:read');
    return this.accessRepo.listAuditEvents(actor.orgId, filters);
  }
}
