import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DealStage } from '@prisma/client';
import { AgencyCrmService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.crm.service';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import {
  CreateDealDto,
  MoveDealDto,
  UpdateDealDto,
} from '@gitroom/nestjs-libraries/dtos/agency/crm.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency CRM')
@Controller('/agency/crm')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyCrmController {
  constructor(private readonly crm: AgencyCrmService) {}

  @Get('/deals')
  async list(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Query('stage') stage?: DealStage
  ) {
    return this.crm.listDeals(actor, { stage });
  }

  @Get('/summary')
  async summary(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.crm.summary(actor);
  }

  @Post('/deals')
  async create(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: CreateDealDto
  ) {
    return this.crm.createDeal(actor, body);
  }

  @Put('/deals/:id')
  async update(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: UpdateDealDto
  ) {
    return this.crm.updateDeal(actor, id, body);
  }

  @Post('/deals/:id/stage')
  async move(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: MoveDealDto
  ) {
    return this.crm.moveStage(actor, id, body.stage, body.lostReason);
  }

  @Post('/deals/:id/convert')
  async convert(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.crm.convertToClient(actor, id);
  }

  @Delete('/deals/:id')
  async remove(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.crm.deleteDeal(actor, id);
  }
}
