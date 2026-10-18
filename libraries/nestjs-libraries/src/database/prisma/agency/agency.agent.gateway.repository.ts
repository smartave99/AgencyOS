import { Injectable } from '@nestjs/common';
import { AgentProposalStatus, AgentScope, Prisma } from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

/** Never includes the token hash: no list or detail ever sees it. */
const tokenView = {
  id: true,
  label: true,
  scope: true,
  prefix: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
  createdById: true,
} satisfies Prisma.AgentTokenSelect;

const proposalView = {
  id: true,
  tool: true,
  args: true,
  summary: true,
  status: true,
  expiresAt: true,
  decidedAt: true,
  outcome: true,
  createdAt: true,
  token: { select: { id: true, label: true, scope: true } },
} satisfies Prisma.AgentProposalSelect;

@Injectable()
export class AgencyAgentGatewayRepository {
  constructor(private prisma: PrismaService) {}

  // ---- tokens --------------------------------------------------------------------------

  async createToken(data: {
    orgId: string;
    label: string;
    scope: AgentScope;
    tokenHash: string;
    prefix: string;
    createdById: string;
    expiresAt: Date | null;
  }) {
    return this.prisma.agentToken.create({ data, select: tokenView });
  }

  /** The only place a hash is read: to find whose key was presented. */
  async findTokenByHash(tokenHash: string) {
    return this.prisma.agentToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        orgId: true,
        label: true,
        scope: true,
        createdById: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
  }

  async listTokens(orgId: string) {
    return this.prisma.agentToken.findMany({
      where: { orgId },
      select: tokenView,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async getToken(orgId: string, id: string) {
    return this.prisma.agentToken.findFirst({
      where: { id, orgId },
      select: tokenView,
    });
  }

  /** Keys that still work: not revoked and not past their expiry. */
  async countActiveTokens(orgId: string, now: Date) {
    return this.prisma.agentToken.count({
      where: {
        orgId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
  }

  /** True when this call is the one that revoked it. */
  async revokeToken(orgId: string, id: string, byUserId: string, now: Date) {
    const { count } = await this.prisma.agentToken.updateMany({
      where: { id, orgId, revokedAt: null },
      data: { revokedAt: now, revokedById: byUserId },
    });
    return count > 0;
  }

  /** Only for a key that lost a race for the last free place and was never shown to anyone. */
  async deleteUnusedToken(orgId: string, id: string) {
    await this.prisma.agentToken.deleteMany({ where: { id, orgId } });
  }

  async touchToken(id: string, now: Date) {
    await this.prisma.agentToken.updateMany({
      where: { id },
      data: { lastUsedAt: now },
    });
  }

  /** The person behind a key, as the workspace knows them today. */
  async memberContext(orgId: string, userId: string) {
    return this.prisma.userOrganization.findFirst({
      where: {
        organizationId: orgId,
        userId,
        disabled: false,
        organization: { deletedAt: null },
        user: { activated: true, deletedAt: null },
      },
      select: {
        role: true,
        user: { select: { id: true, isSuperAdmin: true } },
      },
    });
  }

  // ---- proposals -----------------------------------------------------------------------

  async createProposal(data: {
    orgId: string;
    tokenId: string;
    tool: string;
    args: Prisma.InputJsonValue;
    summary: string;
    expiresAt: Date;
  }) {
    return this.prisma.agentProposal.create({ data, select: proposalView });
  }

  async getProposal(orgId: string, id: string) {
    return this.prisma.agentProposal.findFirst({
      where: { id, orgId },
      select: proposalView,
    });
  }

  /** An agent may only look at what its own key proposed. */
  async getProposalForToken(orgId: string, tokenId: string, id: string) {
    return this.prisma.agentProposal.findFirst({
      where: { id, orgId, tokenId },
      select: proposalView,
    });
  }

  async listProposals(orgId: string, status?: AgentProposalStatus) {
    return this.prisma.agentProposal.findMany({
      where: { orgId, ...(status ? { status } : {}) },
      select: proposalView,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async pendingForToken(tokenId: string) {
    return this.prisma.agentProposal.findMany({
      where: { tokenId, status: 'PENDING' },
      select: { id: true, tool: true, args: true },
    });
  }

  async countPending(orgId: string) {
    return this.prisma.agentProposal.count({
      where: { orgId, status: 'PENDING' },
    });
  }

  /** Nothing expires in the background: old waiting proposals are closed whenever someone looks. */
  async expireStale(orgId: string, now: Date) {
    await this.prisma.agentProposal.updateMany({
      where: { orgId, status: 'PENDING', expiresAt: { lte: now } },
      data: {
        status: 'EXPIRED',
        decidedAt: now,
        outcome: { ok: false, error: 'Nobody decided in time, so it expired.' },
      },
    });
  }

  /** A revoked token's waiting proposals are withdrawn with it. */
  async withdrawForToken(tokenId: string, now: Date) {
    await this.prisma.agentProposal.updateMany({
      where: { tokenId, status: 'PENDING' },
      data: {
        status: 'EXPIRED',
        decidedAt: now,
        outcome: { ok: false, error: 'Withdrawn: the token was revoked.' },
      },
    });
  }

  /**
   * The one guarded move out of PENDING. It succeeds for exactly one caller and only while the
   * proposal is still waiting and not past its expiry, which is what makes a proposal run at most once.
   */
  async decide(
    orgId: string,
    id: string,
    status: 'APPROVED' | 'DECLINED',
    byUserId: string,
    now: Date,
    outcome?: Prisma.InputJsonValue
  ) {
    const { count } = await this.prisma.agentProposal.updateMany({
      where: { id, orgId, status: 'PENDING', expiresAt: { gt: now } },
      data: {
        status,
        decidedAt: now,
        decidedById: byUserId,
        ...(outcome ? { outcome } : {}),
      },
    });
    return count > 0;
  }

  async saveOutcome(orgId: string, id: string, outcome: Prisma.InputJsonValue) {
    await this.prisma.agentProposal.updateMany({
      where: { id, orgId },
      data: { outcome },
    });
  }
}
