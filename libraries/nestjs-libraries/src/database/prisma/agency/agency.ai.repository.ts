import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

@Injectable()
export class AgencyAiRepository {
  constructor(private prisma: PrismaService) {}

  get(orgId: string) {
    return this.prisma.agencyAiConfig.findUnique({ where: { orgId } });
  }

  save(
    orgId: string,
    data: {
      activeProvider: string;
      thinking: string;
      providers: Prisma.InputJsonValue;
    }
  ) {
    return this.prisma.agencyAiConfig.upsert({
      where: { orgId },
      create: { orgId, ...data },
      update: data,
    });
  }

  // ----- command-line tools (machine-wide, one row each) -----

  listTools() {
    return this.prisma.agencyAiTool.findMany();
  }

  async setToolsAutoUpdate(ids: string[], autoUpdate: boolean) {
    await Promise.all(
      ids.map((id) =>
        this.prisma.agencyAiTool.upsert({
          where: { id },
          create: { id, autoUpdate },
          update: { autoUpdate },
        })
      )
    );
  }

  /**
   * Wins the right to check one tool, once per period, across every process that shares the
   * database: the row is only touched if it is not yet checked since the cutoff.
   */
  async claimToolCheck(id: string, cutoff: Date): Promise<boolean> {
    await this.prisma.agencyAiTool.createMany({
      data: [{ id }],
      skipDuplicates: true,
    });
    const won = await this.prisma.agencyAiTool.updateMany({
      where: {
        id,
        autoUpdate: true,
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: cutoff } }],
      },
      data: { lastCheckedAt: new Date() },
    });
    return won.count === 1;
  }

  async recordTool(
    id: string,
    data: {
      version?: string | null;
      status: string;
      message: string | null;
      updated?: boolean;
    }
  ) {
    const now = new Date();
    const values = {
      version: data.version ?? null,
      status: data.status,
      message: data.message,
      lastCheckedAt: now,
      ...(data.updated ? { lastUpdatedAt: now } : {}),
    };
    await this.prisma.agencyAiTool.upsert({
      where: { id },
      create: { id, ...values },
      update: values,
    });
  }
}
