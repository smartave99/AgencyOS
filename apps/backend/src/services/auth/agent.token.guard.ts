import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import {
  AgencyAgentGatewayService,
  AgentPrincipal,
} from '@gitroom/nestjs-libraries/database/prisma/agency/agency.agent.gateway.service';

/**
 * Authenticates an outside agent by its key (`Authorization: Bearer agt_…`) and nothing else: no cookie,
 * no session header. It is used by the agent gateway's controller only. That controller is deliberately
 * not behind AuthMiddleware, and no other controller accepts these keys, so a key opens exactly the
 * gateway's three routes and nothing else in the API.
 */
@Injectable()
export class AgentTokenGuard implements CanActivate {
  constructor(private readonly gateway: AgencyAgentGatewayService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    request.agentPrincipal = await this.gateway.authenticate(
      request.headers.authorization
    );
    return true;
  }
}

export const AgentPrincipalFromRequest = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AgentPrincipal =>
    ctx.switchToHttp().getRequest().agentPrincipal
);
