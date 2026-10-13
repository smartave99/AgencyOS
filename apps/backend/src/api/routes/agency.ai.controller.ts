import {
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgencyAiService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.ai.service';
import { AgencyAiDiscoveryService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.ai.discovery.service';
import { AgencyAiToolsService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.ai.tools.service';
import {
  AgencyAiGatewayService,
  AiProviderError,
} from '@gitroom/nestjs-libraries/database/prisma/agency/agency.ai.gateway.service';
import {
  AgencyAccessService,
  AgencyActor,
} from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import {
  GenerateAdCopyDto,
  ImproveTextDto,
} from '@gitroom/nestjs-libraries/dtos/agency/ai.dto';
import {
  AI_PROVIDER_IDS,
  AiChatDto,
  AiProviderId,
  AiProviderRefDto,
  AiToolsDto,
  UpdateAiSettingsDto,
} from '@gitroom/nestjs-libraries/dtos/agency/ai.settings.dto';
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
    private readonly gateway: AgencyAiGatewayService,
    private readonly tools: AgencyAiToolsService,
    private readonly discovery: AgencyAiDiscoveryService,
    private readonly access: AgencyAccessService
  ) {}

  @Post('/generate-copy')
  async generateCopy(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: GenerateAdCopyDto
  ) {
    this.access.assert(actor, 'ai:use');
    return this.aiService.generateCopy(actor.orgId, body);
  }

  @Post('/improve-text')
  async improveText(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: ImproveTextDto
  ) {
    this.access.assert(actor, 'ai:use');
    return this.aiService.improveText(actor.orgId, body);
  }

  @Post('/chat')
  async chat(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: AiChatDto
  ) {
    this.access.assert(actor, 'ai:use');
    try {
      return await this.aiService.chat(actor.orgId, body);
    } catch (error) {
      // Provider problems carry advice the person can act on, so they are shown as they are.
      if (error instanceof AiProviderError) {
        throw new HttpException(
          { message: error.message, code: error.code },
          502
        );
      }
      throw error;
    }
  }

  @Get('/settings')
  settings(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.gateway.getSettings(actor);
  }

  @Put('/settings')
  updateSettings(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: UpdateAiSettingsDto
  ) {
    return this.gateway.updateSettings(actor, body);
  }

  @Get('/status')
  status(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.gateway.status(actor);
  }

  @Get('/models/:provider')
  models(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('provider') provider: string,
    @Query('refresh') refresh?: string
  ) {
    if (!AI_PROVIDER_IDS.includes(provider as AiProviderId)) {
      throw new HttpException('Unknown AI provider', 400);
    }
    return this.discovery.models(
      actor,
      provider as AiProviderId,
      refresh === '1'
    );
  }

  @Post('/test')
  test(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: AiProviderRefDto
  ) {
    return this.gateway.test(actor, body.provider, body.task);
  }

  @Get('/tools')
  listTools(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.tools.list(actor);
  }

  @Put('/tools')
  setToolUpdates(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: AiToolsDto
  ) {
    return this.tools.setAutoUpdate(actor, body.autoUpdate);
  }

  @Post('/tools/update')
  updateTools(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: AiProviderRefDto
  ) {
    return this.tools.updateNow(actor, body.provider);
  }
}
