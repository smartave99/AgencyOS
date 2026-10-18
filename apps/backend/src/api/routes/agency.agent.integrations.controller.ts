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
import { AgencyAgentGatewayService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.agent.gateway.service';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import {
  CreateAgentTokenDto,
  DeclineAgentProposalDto,
} from '@gitroom/nestjs-libraries/dtos/agency/agent.integrations.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

/** For the signed-in owner or admin: make and revoke keys, and decide what an agent proposed. */
@ApiTags('Agency Agent integrations')
@Controller('/agency/agent-integrations')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyAgentIntegrationsController {
  constructor(private gateway: AgencyAgentGatewayService) {}

  @Get('/config')
  config(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.gateway.config(actor);
  }

  @Get('/tokens')
  tokens(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.gateway.listTokens(actor);
  }

  @Post('/tokens')
  createToken(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: CreateAgentTokenDto
  ) {
    return this.gateway.createToken(actor, body);
  }

  @Post('/tokens/:id/revoke')
  revokeToken(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.gateway.revokeToken(actor, id);
  }

  @Get('/proposals')
  proposals(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Query('status') status?: string
  ) {
    return this.gateway.listProposals(actor, status);
  }

  @Post('/proposals/:id/approve')
  approve(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.gateway.approve(actor, id);
  }

  @Post('/proposals/:id/decline')
  decline(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: DeclineAgentProposalDto
  ) {
    return this.gateway.decline(actor, id, body.reason);
  }
}
