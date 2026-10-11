import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import { AgencyIntelligenceService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.intelligence.service';
import {
  IngestDocumentDto,
  SearchIntelligenceDto,
} from '@gitroom/nestjs-libraries/dtos/agency/intelligence.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency Intelligence')
@Controller('/agency/intelligence')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyIntelligenceController {
  constructor(
    private readonly intelligenceService: AgencyIntelligenceService
  ) {}

  @Get('/')
  async getAnalytics(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.intelligenceService.getIntelligenceAnalytics(actor);
  }

  @Post('/ingest')
  async ingestDocument(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() dto: IngestDocumentDto
  ) {
    return this.intelligenceService.ingestDocument(actor, dto);
  }

  @Post('/search')
  async searchKnowledge(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() dto: SearchIntelligenceDto
  ) {
    return this.intelligenceService.searchKnowledge(actor, dto);
  }

  @Post('/reindex')
  async reindex(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.intelligenceService.reindex(actor);
  }

  /** Retention: DELETE /agency/intelligence?category=DISCUSSION&olderThanDays=90 */
  @Delete('/')
  async purge(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Query('category') category?: string,
    @Query('olderThanDays') olderThanDays?: string
  ) {
    return this.intelligenceService.purge(actor, {
      category,
      olderThanDays: olderThanDays
        ? Number.parseInt(olderThanDays, 10) || undefined
        : undefined,
    });
  }

  @Delete('/:id')
  async deleteDocument(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.intelligenceService.deleteDocument(actor, id);
  }
}
