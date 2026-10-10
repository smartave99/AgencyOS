import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { AgencyService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { CampaignStatus, Organization, User } from '@prisma/client';
import {
  CreateCampaignDto,
  UpdateCampaignDestinationsDto,
  UpdateCampaignDto,
} from '@gitroom/nestjs-libraries/dtos/agency/campaign.dto';
import { SubmitApprovalDto } from '@gitroom/nestjs-libraries/dtos/agency/approval.dto';

@ApiTags('Agency Campaigns')
@Controller('/agency/campaigns')
export class AgencyCampaignsController {
  constructor(private agencyService: AgencyService) {}

  @Get('/')
  async getCampaigns(
    @GetOrgFromRequest() org: Organization,
    @Query('status') status?: CampaignStatus,
    @Query('customerId') customerId?: string,
    @Query('search') search?: string
  ) {
    return this.agencyService.getCampaigns(org.id, {
      status,
      customerId,
      search,
    });
  }

  @Get('/:id')
  async getCampaignById(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this.agencyService.getCampaignById(org.id, id);
  }

  @Post('/')
  async createCampaign(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateCampaignDto
  ) {
    return this.agencyService.createCampaign(org.id, user.id, {
      ...body,
      startDate: body.startDate ? new Date(body.startDate) : undefined,
      endDate: body.endDate ? new Date(body.endDate) : undefined,
    });
  }

  @Put('/:id')
  async updateCampaign(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateCampaignDto
  ) {
    return this.agencyService.updateCampaign(org.id, id, {
      ...body,
      startDate: body.startDate ? new Date(body.startDate) : undefined,
      endDate: body.endDate ? new Date(body.endDate) : undefined,
    });
  }

  @Put('/:id/destinations')
  async updateDestinations(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateCampaignDestinationsDto
  ) {
    return this.agencyService.updateCampaignDestinations(
      org.id,
      id,
      body.destinations
    );
  }

  @Post('/:id/submit')
  async submitForApproval(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: SubmitApprovalDto
  ) {
    return this.agencyService.submitForApproval(
      org.id,
      id,
      user.id,
      body.notes
    );
  }

  @Post('/:id/schedule')
  async scheduleCampaign(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this.agencyService.scheduleCampaign(org.id, id);
  }

  @Post('/:id/publish')
  async publishCampaign(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this.agencyService.publishCampaignNow(org.id, id);
  }

  @Delete('/:id')
  async deleteCampaign(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this.agencyService.deleteCampaign(org.id, id);
  }

  @Get('/:id/export/csv')
  async exportCsv(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Res() res: Response
  ) {
    const csv = await this.agencyService.generateCampaignCsvReport(org.id, id);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="campaign-${id}-report.csv"`
    );
    return res.send(csv);
  }

  @Post('/:id/tracking-links')
  async createTrackingLink(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body()
    body: {
      destinationUrl: string;
      utmSource?: string;
      utmMedium?: string;
      utmCampaign?: string;
    }
  ) {
    return this.agencyService.createTrackingLink(org.id, id, body);
  }

  @Get('/:id/tracking-links')
  async getTrackingLinks(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this.agencyService.getCampaignTrackingLinks(org.id, id);
  }
}
