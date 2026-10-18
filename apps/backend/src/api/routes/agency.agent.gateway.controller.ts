import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AgencyAgentGatewayService,
  AgentPrincipal,
} from '@gitroom/nestjs-libraries/database/prisma/agency/agency.agent.gateway.service';
import { AgentCallDto } from '@gitroom/nestjs-libraries/dtos/agency/agent.integrations.dto';
import {
  AgentPrincipalFromRequest,
  AgentTokenGuard,
} from '@gitroom/backend/services/auth/agent.token.guard';
import { agencyValidationPipe } from '@gitroom/backend/services/auth/permissions/agency.actor';

/**
 * The door for an outside AI agent. It is NOT behind AuthMiddleware (no cookie works here) and it is
 * guarded by an agent key instead. It has exactly these three routes; nothing else answers under
 * /agent-gateway.
 */
@ApiTags('Agent gateway')
@Controller('/agent-gateway')
@UseGuards(AgentTokenGuard)
@UsePipes(agencyValidationPipe)
export class AgentGatewayController {
  constructor(private gateway: AgencyAgentGatewayService) {}

  @Get('/health')
  @Header('Cache-Control', 'no-store')
  health(@AgentPrincipalFromRequest() principal: AgentPrincipal) {
    return this.gateway.health(principal);
  }

  @Get('/tools')
  @Header('Cache-Control', 'no-store')
  tools(@AgentPrincipalFromRequest() principal: AgentPrincipal) {
    return this.gateway.tools(principal);
  }

  @Post('/call')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async call(
    @AgentPrincipalFromRequest() principal: AgentPrincipal,
    @Body() body: AgentCallDto
  ) {
    return {
      tool: body.tool,
      result: await this.gateway.call(principal, body.tool, body.args),
    };
  }
}
