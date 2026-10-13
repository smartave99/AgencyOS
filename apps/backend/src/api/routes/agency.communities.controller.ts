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
import { CommunityStage } from '@prisma/client';
import { AgencyCommunitiesService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.communities.service';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import {
  CommunityAccountDto,
  CommunityReasonDto,
  CreateCommunityDto,
  DecideJoinRequestDto,
  ImportCommunitiesDto,
  JoinCommunityDto,
  RefreshCommunitiesDto,
  ReviewAdvertisingDto,
  SearchCommunitiesDto,
  UpdateCommunityLabelsDto,
  UpdateManagedCommunityDto,
  ValidateLinksDto,
} from '@gitroom/nestjs-libraries/dtos/agency/community.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency Communities')
@Controller('/agency/communities')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyCommunitiesController {
  constructor(private communities: AgencyCommunitiesService) {}

  private filters(q: Record<string, string | undefined>) {
    return {
      search: q.search || undefined,
      stage: (q.stage as CommunityStage) || undefined,
      relation: (q.relation as any) || undefined,
      category: q.category || undefined,
      language: q.language || undefined,
      tag: q.tag || undefined,
      kind: q.kind || undefined,
      bookmarked: q.bookmarked === 'true' ? true : undefined,
      availableOnly: q.availableOnly === 'true' ? true : undefined,
      sort: (q.sort as any) || undefined,
    };
  }

  @Get('/')
  async list(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Query() query: Record<string, string>
  ) {
    return this.communities.list(actor, this.filters(query));
  }

  @Get('/export')
  async export(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Res() res: Response,
    @Query() query: Record<string, string>
  ) {
    const filters = this.filters(query);
    if (query.format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="communities.json"'
      );
      return res.send(
        JSON.stringify(
          await this.communities.exportRows(actor, filters),
          null,
          2
        )
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="communities.csv"'
    );
    return res.send(await this.communities.exportCsv(actor, filters));
  }

  @Get('/duplicates')
  async duplicates(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.communities.duplicates(actor);
  }

  @Post('/validate')
  async validate(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: ValidateLinksDto
  ) {
    return this.communities.validateLinks(actor, body.refs);
  }

  @Post('/search')
  async search(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: SearchCommunitiesDto
  ) {
    return this.communities.search(actor, body);
  }

  @Post('/import')
  async importRefs(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: ImportCommunitiesDto
  ) {
    return this.communities.importRefs(actor, body);
  }

  @Post('/refresh')
  async refresh(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: RefreshCommunitiesDto
  ) {
    return this.communities.refresh(actor, body);
  }

  @Post('/create')
  async create(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: CreateCommunityDto
  ) {
    return this.communities.createCommunity(actor, body);
  }

  @Post('/sync')
  async sync(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: CommunityAccountDto
  ) {
    return this.communities.syncMine(actor, body.accountId);
  }

  @Get('/:id')
  async get(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.communities.get(actor, id);
  }

  @Put('/:id')
  async update(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: UpdateCommunityLabelsDto
  ) {
    return this.communities.update(actor, id, body);
  }

  @Delete('/:id')
  async remove(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.communities.remove(actor, id);
  }

  @Get('/:id/messages')
  async messages(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Query('accountId') accountId: string
  ) {
    return this.communities.publicMessages(actor, id, accountId);
  }

  @Post('/:id/flag')
  async flag(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: CommunityReasonDto
  ) {
    return this.communities.flagForReview(actor, id, body.reason ?? '');
  }

  @Post('/:id/join')
  async join(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: JoinCommunityDto
  ) {
    return this.communities.join(actor, id, body);
  }

  @Post('/:id/leave')
  async leave(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: CommunityAccountDto
  ) {
    return this.communities.leave(actor, id, body.accountId);
  }

  @Post('/:id/check-membership')
  async checkMembership(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.communities.checkMembership(actor, id);
  }

  @Post('/:id/advertising-review')
  async review(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: ReviewAdvertisingDto
  ) {
    return this.communities.reviewAdvertising(actor, id, body);
  }

  @Post('/:id/authorize')
  async authorize(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: CommunityAccountDto
  ) {
    return this.communities.authorize(actor, id, body.accountId);
  }

  @Post('/:id/withdraw')
  async withdraw(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: CommunityReasonDto
  ) {
    return this.communities.withdraw(actor, id, body.reason ?? '');
  }

  @Post('/:id/reopen')
  async reopen(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: CommunityReasonDto
  ) {
    return this.communities.reopen(actor, id, body.reason ?? '');
  }

  @Post('/:id/not-eligible')
  async notEligible(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: CommunityReasonDto
  ) {
    return this.communities.markNotEligible(actor, id, body.reason ?? '');
  }

  @Put('/:id/managed')
  async managed(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: UpdateManagedCommunityDto
  ) {
    return this.communities.updateCommunity(actor, id, body);
  }

  @Get('/:id/invite-link')
  async inviteLink(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.communities.inviteLink(actor, id);
  }

  @Get('/:id/join-requests')
  async joinRequests(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.communities.joinRequests(actor, id);
  }

  @Post('/:id/join-requests/decide')
  async decide(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: DecideJoinRequestDto
  ) {
    return this.communities.decideJoinRequest(actor, id, body);
  }
}
