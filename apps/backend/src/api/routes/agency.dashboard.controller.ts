import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgencyService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.service';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency Dashboard')
@Controller('/agency/dashboard')
@UseGuards(AgencyActorGuard)
export class AgencyDashboardController {
  constructor(private agencyService: AgencyService) {}

  @Get('/')
  async getDashboard(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.agencyService.getDashboard(actor);
  }
}
