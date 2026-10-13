import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgencyService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.service';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import {
  CreateAdTemplateDto,
  UpdateAdTemplateDto,
} from '@gitroom/nestjs-libraries/dtos/agency/template.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency Templates')
@Controller('/agency/templates')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyTemplatesController {
  constructor(private agencyService: AgencyService) {}

  @Get('/')
  async getTemplates(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.agencyService.getTemplates(actor);
  }

  @Post('/')
  async createTemplate(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: CreateAdTemplateDto
  ) {
    return this.agencyService.createTemplate(actor, body);
  }

  @Put('/:id')
  async updateTemplate(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: UpdateAdTemplateDto
  ) {
    return this.agencyService.updateTemplate(actor, id, body);
  }

  @Delete('/:id')
  async deleteTemplate(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.agencyService.deleteTemplate(actor, id);
  }
}
