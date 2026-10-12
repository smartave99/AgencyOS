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
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { CampaignStatus } from '@prisma/client';
import { AgencyService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.service';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import {
  CancelCampaignDto,
  CreateCampaignDto,
  CreateTrackingLinkDto,
  PreviewAdDto,
  ResolveJobDto,
  UpdateCampaignDestinationsDto,
  UpdateCampaignDto,
} from '@gitroom/nestjs-libraries/dtos/agency/campaign.dto';
import { SubmitApprovalDto } from '@gitroom/nestjs-libraries/dtos/agency/approval.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

const toDate = (value?: string) => (value ? new Date(value) : undefined);
const mapDestinations = (destinations?: CreateCampaignDto['destinations']) =>
  destinations?.map((d) => ({
    destinationType: d.destinationType,
    telegramDestinationId: d.telegramDestinationId,
    integrationId: d.integrationId,
    customSettings: d.customSettings,
    scheduledAt: toDate(d.scheduledAt),
  }));

@ApiTags('Agency Campaigns')
@Controller('/agency/campaigns')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyCampaignsController {
  constructor(private agencyService: AgencyService) {}

  @Get('/')
  async getCampaigns(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Query('status') status?: CampaignStatus,
    @Query('customerId') customerId?: string,
    @Query('search') search?: string
  ) {
    return this.agencyService.getCampaigns(actor, {
      status,
      customerId,
      search,
    });
  }

  /** What Telegram would actually receive for this content. */
  @Post('/preview')
  async preview(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: PreviewAdDto
  ) {
    return this.agencyService.previewAd(actor, body);
  }

  @Get('/:id')
  async getCampaignById(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.agencyService.getCampaignById(actor, id);
  }

  @Post('/')
  async createCampaign(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: CreateCampaignDto
  ) {
    return this.agencyService.createCampaign(actor, {
      ...body,
      startDate: toDate(body.startDate),
      endDate: toDate(body.endDate),
      destinations: mapDestinations(body.destinations),
    });
  }

  @Put('/:id')
  async updateCampaign(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: UpdateCampaignDto
  ) {
    return this.agencyService.updateCampaign(actor, id, {
      ...body,
      startDate: toDate(body.startDate),
      endDate: toDate(body.endDate),
    });
  }

  @Put('/:id/destinations')
  async updateDestinations(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: UpdateCampaignDestinationsDto
  ) {
    return this.agencyService.updateCampaignDestinations(
      actor,
      id,
      mapDestinations(body.destinations)!
    );
  }

  @Post('/:id/duplicate')
  async duplicate(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.agencyService.duplicateCampaign(actor, id);
  }

  @Post('/:id/submit')
  async submitForApproval(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: SubmitApprovalDto
  ) {
    return this.agencyService.submitForApproval(actor, id, body.notes);
  }

  @Post('/:id/schedule')
  async scheduleCampaign(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.agencyService.scheduleCampaign(actor, id);
  }

  @Post('/:id/publish')
  async publishCampaign(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.agencyService.publishCampaignNow(actor, id);
  }

  @Post('/:id/pause')
  async pause(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.agencyService.pauseCampaign(actor, id);
  }

  @Post('/:id/resume')
  async resume(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.agencyService.resumeCampaign(actor, id);
  }

  @Post('/:id/cancel')
  async cancel(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: CancelCampaignDto
  ) {
    return this.agencyService.cancelCampaign(actor, id, body.reason);
  }

  @Post('/:id/reopen')
  async reopen(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.agencyService.reopenCampaign(actor, id);
  }

  @Post('/:id/archive')
  async archive(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.agencyService.archiveCampaign(actor, id);
  }

  @Post('/:id/retry')
  async retry(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.agencyService.retryCampaign(actor, id);
  }

  @Get('/:id/jobs')
  async jobs(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.agencyService.getCampaignJobs(actor, id);
  }

  @Post('/jobs/:jobId/resolve')
  async resolveJob(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('jobId') jobId: string,
    @Body() body: ResolveJobDto
  ) {
    return this.agencyService.resolveUncertainJob(
      actor,
      jobId,
      body.outcome,
      body.note
    );
  }

  @Delete('/:id')
  async deleteCampaign(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.agencyService.deleteCampaign(actor, id);
  }

  @Get('/:id/export/csv')
  async exportCsv(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Res() res: Response
  ) {
    const csv = await this.agencyService.generateCampaignCsvReport(actor, id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="campaign-${id.replace(/[^\w-]/g, '')}-report.csv"`
    );
    return res.send(csv);
  }

  @Post('/:id/tracking-links')
  async createTrackingLink(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: CreateTrackingLinkDto
  ) {
    return this.agencyService.createTrackingLink(actor, id, body);
  }

  @Get('/:id/tracking-links')
  async getTrackingLinks(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.agencyService.getCampaignTrackingLinks(actor, id);
  }
}
