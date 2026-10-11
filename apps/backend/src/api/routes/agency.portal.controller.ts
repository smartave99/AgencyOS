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
import { AgencyPortalService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.portal.service';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import { ClientReviewDto } from '@gitroom/nestjs-libraries/dtos/agency/team.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency Client Portal')
@Controller('/agency/portal')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyPortalController {
  constructor(private readonly portalService: AgencyPortalService) {}

  /** A CLIENT user is pinned to their own client; staff may preview any client by id. */
  @Get('/me')
  async getMyPortal(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.portalService.getClientPortalData(actor);
  }

  @Get('/:clientId')
  async getPortalOverview(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('clientId') clientId: string
  ) {
    return this.portalService.getClientPortalData(actor, clientId);
  }

  @Post('/review')
  async reviewCampaign(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: ClientReviewDto
  ) {
    return this.portalService.clientReviewCampaign(
      actor,
      body.campaignId,
      body.action,
      body.feedback
    );
  }
}
