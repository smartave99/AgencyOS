import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AGENCY_PERMISSIONS,
  AgencyAccessService,
  AgencyActor,
} from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import { SetAgencyRoleDto } from '@gitroom/nestjs-libraries/dtos/agency/team.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency Team & Audit')
@Controller('/agency')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyTeamController {
  constructor(private access: AgencyAccessService) {}

  /** The caller's own agency role, so the UI can hide actions they can't take. */
  @Get('/me')
  me(@AgencyActorFromRequest() actor: AgencyActor) {
    return {
      role: actor.role,
      customerId: actor.customerId,
      permissions: Object.entries(AGENCY_PERMISSIONS)
        .filter(([, roles]) => roles.includes(actor.role))
        .map(([permission]) => permission),
    };
  }

  @Get('/team')
  async team(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.access.listTeam(actor);
  }

  @Put('/team/:userId/role')
  async setRole(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('userId') userId: string,
    @Body() body: SetAgencyRoleDto
  ) {
    return this.access.setRole(actor, userId, body.role, body.customerId);
  }

  @Get('/audit')
  async audit(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('limit') limit?: string
  ) {
    return this.access.listAudit(actor, {
      entityType,
      entityId,
      limit: limit ? Number.parseInt(limit, 10) || undefined : undefined,
    });
  }
}
