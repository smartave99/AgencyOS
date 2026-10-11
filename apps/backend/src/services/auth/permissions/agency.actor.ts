import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { agencyValidationPipe } from '@gitroom/nestjs-libraries/dtos/agency/agency.pipe';
import { AgencyAccessService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import { HttpForbiddenException } from '@gitroom/nestjs-libraries/services/exception.filter';

/**
 * Resolves who the caller is within the agency (role, and for CLIENT users the one
 * customer they may see) and attaches it to the request. Authentication has already
 * happened in AuthMiddleware; permissions are then enforced in the services, which
 * receive this actor, so a route can't forget a check.
 */
@Injectable()
export class AgencyActorGuard implements CanActivate {
  constructor(private readonly access: AgencyAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const { org, user } = request;
    if (!org?.id || !user?.id) {
      throw new HttpForbiddenException();
    }
    request.agencyActor = await this.access.resolveActor(
      org,
      user,
      org.users?.[0]?.role
    );
    return true;
  }
}

export const AgencyActorFromRequest = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest().agencyActor
);

export { agencyValidationPipe };
