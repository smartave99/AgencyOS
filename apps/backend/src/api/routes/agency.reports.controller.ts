import { Controller, Get, Query, UseGuards, UsePipes } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgencyService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.service';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency Reports')
@Controller('/agency/reports')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyReportsController {
  constructor(private readonly agencyService: AgencyService) {}

  /** GET /agency/reports/publishing?from=2026-03-01&to=2026-03-31&customerId=... */
  @Get('/publishing')
  async publishing(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('customerId') customerId?: string
  ) {
    return this.agencyService.getPublishingReport(actor, {
      from,
      to,
      customerId,
    });
  }
}
