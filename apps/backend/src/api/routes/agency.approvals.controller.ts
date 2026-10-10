import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgencyService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { Organization, User } from '@prisma/client';
import { ReviewApprovalDto } from '@gitroom/nestjs-libraries/dtos/agency/approval.dto';

@ApiTags('Agency Approvals')
@Controller('/agency/approvals')
export class AgencyApprovalsController {
  constructor(private agencyService: AgencyService) {}

  @Get('/')
  async getApprovals(
    @GetOrgFromRequest() org: Organization,
    @Query('status') status?: string
  ) {
    return this.agencyService.getApprovals(org.id, status);
  }

  @Post('/:id/review')
  async reviewApproval(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ReviewApprovalDto
  ) {
    return this.agencyService.reviewCampaign(
      org.id,
      id,
      user.id,
      body.decision,
      body.notes
    );
  }
}
