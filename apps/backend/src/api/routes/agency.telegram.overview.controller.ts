import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgencyTelegramOverviewService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.telegram.overview.service';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency Telegram overview')
@Controller('/agency/telegram/overview')
@UseGuards(AgencyActorGuard)
export class AgencyTelegramOverviewController {
  constructor(private overview: AgencyTelegramOverviewService) {}

  @Get('/')
  async get(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.overview.overview(actor);
  }
}
