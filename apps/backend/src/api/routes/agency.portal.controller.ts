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
import { AgencyPortalService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.portal.service';

export class ClientReviewDto {
  campaignId: string;
  action: 'APPROVE' | 'REQUEST_CHANGES';
  feedback?: string;
}

@ApiTags('Agency Client Portal')
@Controller('/agency/portal')
export class AgencyPortalController {
  constructor(private readonly portalService: AgencyPortalService) {}

  @Get('/:clientId')
  async getPortalOverview(
    @GetOrgFromRequest() org: Organization,
    @Param('clientId') clientId: string
  ) {
    return this.portalService.getClientPortalData(org.id, clientId);
  }

  @Post('/:clientId/review')
  async reviewCampaign(
    @GetOrgFromRequest() org: Organization,
    @Param('clientId') clientId: string,
    @Body() body: ClientReviewDto
  ) {
    return this.portalService.clientReviewCampaign(
      org.id,
      clientId,
      body.campaignId,
      body.action,
      body.feedback
    );
  }
}
