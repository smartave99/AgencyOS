import {
  Controller,
  Get,
  Post,
  Body,
  Param,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization } from '@prisma/client';
import { AgencyPlatformsService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.platforms.service';
import { AssignClientDto } from '@gitroom/nestjs-libraries/dtos/agency/account.dto';

@ApiTags('Agency Platforms & Accounts')
@Controller('/agency')
export class AgencyPlatformsController {
  constructor(private readonly platformsService: AgencyPlatformsService) {}

  @Get('/platforms/capabilities')
  async getCapabilities() {
    return this.platformsService.getPlatformCapabilities();
  }

  @Get('/accounts')
  async getConnectedAccounts(@GetOrgFromRequest() org: Organization) {
    return this.platformsService.getConnectedAccounts(org.id);
  }

  @Post('/accounts/:id/assign-client')
  async assignClient(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() dto: AssignClientDto
  ) {
    return this.platformsService.assignAccountClient(org.id, id, dto.customerId);
  }

  @Post('/accounts/:id/test-connection')
  async testConnection(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this.platformsService.testAccountConnection(org.id, id);
  }
}
