import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import { AgencyPlatformsService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.platforms.service';
import { AssignClientDto } from '@gitroom/nestjs-libraries/dtos/agency/account.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency Platforms & Accounts')
@Controller('/agency')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyPlatformsController {
  constructor(private readonly platformsService: AgencyPlatformsService) {}

  @Get('/platforms/capabilities')
  async getCapabilities() {
    return this.platformsService.getPlatformCapabilities();
  }

  @Get('/accounts')
  async getConnectedAccounts(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.platformsService.getConnectedAccounts(actor);
  }

  @Post('/accounts/:id/assign-client')
  async assignClient(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() dto: AssignClientDto
  ) {
    return this.platformsService.assignAccountClient(actor, id, dto.customerId);
  }

  @Post('/accounts/:id/test-connection')
  async testConnection(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.platformsService.testAccountConnection(actor, id);
  }
}
