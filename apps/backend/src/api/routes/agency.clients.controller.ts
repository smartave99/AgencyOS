import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgencyService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization } from '@prisma/client';
import {
  CreateClientDto,
  UpdateClientDto,
} from '@gitroom/nestjs-libraries/dtos/agency/client.dto';

@ApiTags('Agency Clients')
@Controller('/agency/clients')
export class AgencyClientsController {
  constructor(private agencyService: AgencyService) {}

  @Get('/')
  async getClients(
    @GetOrgFromRequest() org: Organization,
    @Query('search') search?: string
  ) {
    return this.agencyService.getClients(org.id, search);
  }

  @Get('/:id')
  async getClientById(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this.agencyService.getClientById(org.id, id);
  }

  @Post('/')
  async createClient(
    @GetOrgFromRequest() org: Organization,
    @Body() body: CreateClientDto
  ) {
    return this.agencyService.createClient(org.id, body);
  }

  @Put('/:id')
  async updateClient(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateClientDto
  ) {
    return this.agencyService.updateClient(org.id, id, body);
  }

  @Delete('/:id')
  async deleteClient(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this.agencyService.deleteClient(org.id, id);
  }
}
