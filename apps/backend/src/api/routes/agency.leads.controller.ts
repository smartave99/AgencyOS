import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { AgencyLeadsService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.leads.service';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import {
  CreateLeadLinkDto,
  UpdateLeadDto,
} from '@gitroom/nestjs-libraries/dtos/agency/lead.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency Leads')
@Controller('/agency/leads')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyLeadsController {
  constructor(private leads: AgencyLeadsService) {}

  @Get('/links')
  async links(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.leads.listLinks(actor);
  }

  @Post('/links')
  async createLink(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: CreateLeadLinkDto
  ) {
    return this.leads.createLink(actor, body);
  }

  @Delete('/links/:id')
  async removeLink(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.leads.removeLink(actor, id);
  }

  @Get('/')
  async list(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Query('linkId') linkId?: string,
    @Query('campaignId') campaignId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string
  ) {
    return this.leads.list(actor, { linkId, campaignId, status, search });
  }

  @Get('/export')
  async export(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('linkId') linkId?: string,
    @Query('campaignId') campaignId?: string
  ) {
    const filters = { linkId, campaignId };
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="leads.json"');
      return res.send(
        JSON.stringify(await this.leads.exportRows(actor, filters), null, 2)
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    return res.send(await this.leads.exportCsv(actor, filters));
  }

  @Put('/:id')
  async update(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: UpdateLeadDto
  ) {
    return this.leads.update(actor, id, body);
  }

  @Delete('/:id')
  async erase(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.leads.erase(actor, id);
  }
}
