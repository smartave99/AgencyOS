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
import { AgencyWhatsappService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.whatsapp.service';
import { AgencyWhatsappOutreachService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.whatsapp.outreach.service';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import {
  CommitWhatsappImportDto,
  CreateWhatsappContactDto,
  DraftWhatsappTasksDto,
  PreviewWhatsappImportDto,
  PreviewWhatsappSegmentDto,
  PreviewWhatsappTemplateDto,
  SaveWhatsappSegmentDto,
  SaveWhatsappTemplateDto,
  SetWhatsappTaskStatusDto,
  SuggestWhatsappWordingDto,
  UpdateWhatsappContactDto,
  UpdateWhatsappSettingsDto,
  UpdateWhatsappTaskDto,
  WithdrawWhatsappConsentDto,
} from '@gitroom/nestjs-libraries/dtos/agency/whatsapp.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency WhatsApp')
@Controller('/agency/whatsapp')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyWhatsappController {
  constructor(
    private contacts: AgencyWhatsappService,
    private outreach: AgencyWhatsappOutreachService
  ) {}

  // ---- settings and what the screens need to know ----------------------------------------
  @Get('/settings')
  async settings(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.contacts.getSettings(actor);
  }

  @Put('/settings')
  async updateSettings(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: UpdateWhatsappSettingsDto
  ) {
    return this.contacts.updateSettings(actor, body);
  }

  @Get('/facets')
  async facets(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.contacts.facets(actor);
  }

  // ---- contacts ---------------------------------------------------------------------------
  @Get('/contacts')
  async list(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('tag') tag?: string,
    @Query('language') language?: string
  ) {
    return this.contacts.list(actor, {
      search,
      status: status as 'OPTED_IN' | 'OPTED_OUT' | undefined,
      tag,
      language,
    });
  }

  @Post('/contacts')
  async create(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: CreateWhatsappContactDto
  ) {
    return this.contacts.create(actor, body);
  }

  @Get('/contacts/:id')
  async get(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.contacts.get(actor, id);
  }

  @Put('/contacts/:id')
  async update(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: UpdateWhatsappContactDto
  ) {
    return this.contacts.update(actor, id, body);
  }

  @Post('/contacts/:id/withdraw')
  async withdraw(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: WithdrawWhatsappConsentDto
  ) {
    return this.contacts.withdraw(actor, id, body);
  }

  @Delete('/contacts/:id')
  async erase(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.contacts.erase(actor, id);
  }

  // ---- imports ----------------------------------------------------------------------------
  @Get('/imports')
  async imports(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.contacts.listImports(actor);
  }

  @Post('/imports/preview')
  async previewImport(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: PreviewWhatsappImportDto
  ) {
    return this.contacts.previewImport(actor, body.csv);
  }

  @Post('/imports')
  async commitImport(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: CommitWhatsappImportDto
  ) {
    return this.contacts.commitImport(actor, body);
  }

  // ---- the unsubscribe ledger: read only, by design ---------------------------------------
  @Get('/unsubscribes')
  async unsubscribes(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.contacts.listUnsubscribes(actor);
  }

  // ---- segments ---------------------------------------------------------------------------
  @Get('/segments')
  async segments(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.outreach.listSegments(actor);
  }

  @Post('/segments/preview')
  async previewSegment(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: PreviewWhatsappSegmentDto
  ) {
    return this.outreach.previewSegment(actor, body);
  }

  @Post('/segments')
  async createSegment(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: SaveWhatsappSegmentDto
  ) {
    return this.outreach.createSegment(actor, body);
  }

  @Put('/segments/:id')
  async updateSegment(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: SaveWhatsappSegmentDto
  ) {
    return this.outreach.updateSegment(actor, id, body);
  }

  @Delete('/segments/:id')
  async deleteSegment(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.outreach.deleteSegment(actor, id);
  }

  // ---- templates --------------------------------------------------------------------------
  @Get('/templates')
  async templates(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.outreach.listTemplates(actor);
  }

  @Post('/templates/preview')
  async previewTemplate(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: PreviewWhatsappTemplateDto
  ) {
    return this.outreach.previewTemplate(actor, body);
  }

  @Post('/templates/suggest')
  async suggest(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: SuggestWhatsappWordingDto
  ) {
    return this.outreach.suggestWording(actor, body);
  }

  @Post('/templates')
  async createTemplate(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: SaveWhatsappTemplateDto
  ) {
    return this.outreach.createTemplate(actor, body);
  }

  @Put('/templates/:id')
  async updateTemplate(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: SaveWhatsappTemplateDto
  ) {
    return this.outreach.updateTemplate(actor, id, body);
  }

  @Delete('/templates/:id')
  async deleteTemplate(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.outreach.deleteTemplate(actor, id);
  }

  // ---- tasks: one message, one person, one deliberate click -------------------------------
  @Get('/tasks')
  async tasks(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Query('status') status?: string,
    @Query('templateId') templateId?: string,
    @Query('contactId') contactId?: string,
    @Query('limit') limit?: string
  ) {
    return this.outreach.listTasks(actor, {
      status,
      templateId,
      contactId,
      limit: limit ? Number.parseInt(limit, 10) || undefined : undefined,
    });
  }

  @Get('/tasks/due')
  async due(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Query('until') until?: string
  ) {
    return this.outreach.listDue(actor, until);
  }

  @Post('/tasks/draft')
  async draft(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: DraftWhatsappTasksDto
  ) {
    return this.outreach.draft(actor, body);
  }

  @Post('/tasks/:id/open')
  async open(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.outreach.openChat(actor, id);
  }

  @Put('/tasks/:id/status')
  async setStatus(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: SetWhatsappTaskStatusDto
  ) {
    return this.outreach.setStatus(actor, id, body);
  }

  @Put('/tasks/:id')
  async updateTask(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: UpdateWhatsappTaskDto
  ) {
    return this.outreach.updateTask(actor, id, body);
  }
}
