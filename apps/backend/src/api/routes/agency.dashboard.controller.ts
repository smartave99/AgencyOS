import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgencyService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization } from '@prisma/client';

@ApiTags('Agency Dashboard')
@Controller('/agency/dashboard')
export class AgencyDashboardController {
  constructor(private agencyService: AgencyService) {}

  @Get('/')
  async getDashboard(@GetOrgFromRequest() org: Organization) {
    return this.agencyService.getDashboard(org.id);
  }
}
