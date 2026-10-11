import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgencyService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.service';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import { ReviewApprovalDto } from '@gitroom/nestjs-libraries/dtos/agency/approval.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency Approvals')
@Controller('/agency/approvals')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyApprovalsController {
  constructor(private agencyService: AgencyService) {}

  @Get('/')
  async getApprovals(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Query('status') status?: string
  ) {
    return this.agencyService.getApprovals(actor, status);
  }

  @Post('/:id/review')
  async reviewApproval(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: ReviewApprovalDto
  ) {
    return this.agencyService.reviewCampaign(
      actor,
      id,
      body.decision,
      body.notes
    );
  }
}
