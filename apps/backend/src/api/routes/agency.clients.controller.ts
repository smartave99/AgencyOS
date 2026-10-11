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
import { AgencyService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.service';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import {
  CreateClientDto,
  UpdateClientDto,
} from '@gitroom/nestjs-libraries/dtos/agency/client.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency Clients')
@Controller('/agency/clients')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyClientsController {
  constructor(private agencyService: AgencyService) {}

  @Get('/')
  async getClients(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Query('search') search?: string
  ) {
    return this.agencyService.getClients(actor, search);
  }

  @Get('/:id')
  async getClientById(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.agencyService.getClientById(actor, id);
  }

  @Post('/')
  async createClient(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: CreateClientDto
  ) {
    return this.agencyService.createClient(actor, body);
  }

  @Put('/:id')
  async updateClient(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: UpdateClientDto
  ) {
    return this.agencyService.updateClient(actor, id, body);
  }

  @Delete('/:id')
  async deleteClient(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.agencyService.deleteClient(actor, id);
  }
}
