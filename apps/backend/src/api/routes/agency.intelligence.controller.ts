import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization } from '@prisma/client';
import { AgencyIntelligenceService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.intelligence.service';
import { IngestDocumentDto, SearchIntelligenceDto } from '@gitroom/nestjs-libraries/dtos/agency/intelligence.dto';

@ApiTags('Agency Intelligence')
@Controller('/agency/intelligence')
export class AgencyIntelligenceController {
  constructor(private readonly intelligenceService: AgencyIntelligenceService) {}

  @Get('/')
  async getAnalytics(@GetOrgFromRequest() org: Organization) {
    return this.intelligenceService.getIntelligenceAnalytics(org.id);
  }

  @Post('/ingest')
  async ingestDocument(
    @GetOrgFromRequest() org: Organization,
    @Body() dto: IngestDocumentDto
  ) {
    return this.intelligenceService.ingestDocument(org.id, dto);
  }

  @Post('/search')
  async searchKnowledge(
    @GetOrgFromRequest() org: Organization,
    @Body() dto: SearchIntelligenceDto
  ) {
    return this.intelligenceService.searchKnowledge(org.id, dto);
  }

  @Delete('/:id')
  async deleteDocument(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this.intelligenceService.deleteDocument(org.id, id);
  }
}
