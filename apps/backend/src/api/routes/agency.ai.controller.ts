import { Body, Controller, Post, UseGuards, UsePipes } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgencyAiService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.ai.service';
import {
  AgencyAccessService,
  AgencyActor,
} from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import {
  GenerateAdCopyDto,
  ImproveTextDto,
} from '@gitroom/nestjs-libraries/dtos/agency/ai.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency AI')
@Controller('/agency/ai')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyAiController {
  constructor(
    private readonly aiService: AgencyAiService,
    private readonly access: AgencyAccessService
  ) {}

  @Post('/generate-copy')
  async generateCopy(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: GenerateAdCopyDto
  ) {
    this.access.assert(actor, 'ai:use');
    return this.aiService.generateCopy(body);
  }

  @Post('/improve-text')
  async improveText(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: ImproveTextDto
  ) {
    this.access.assert(actor, 'ai:use');
    return this.aiService.improveText(body);
  }
}
