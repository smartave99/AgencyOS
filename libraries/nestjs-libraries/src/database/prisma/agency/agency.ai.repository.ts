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
}
