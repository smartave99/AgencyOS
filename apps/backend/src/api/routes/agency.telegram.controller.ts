import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PostingJobStatus } from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import { AgencyService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.service';
import { AgencyTelegramService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.telegram.service';
import { AgencyTelegramBotsService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.telegram.bots.service';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import { TelegramInboundUpdate } from '@gitroom/nestjs-libraries/integrations/telegram/telegram.gateway';
import {
  AddTelegramBotDto,
  MakeMainBotDto,
  UpdateChatBotsDto,
  UpdateTelegramBotDto,
  DestinationReasonDto,
  RegisterTelegramDestinationDto,
  UpdateTelegramDestinationDto,
  VerifyTelegramChatDto,
} from '@gitroom/nestjs-libraries/dtos/agency/telegram.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency Telegram Management')
@Controller('/agency/telegram')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyTelegramController {
  constructor(
    private telegramService: AgencyTelegramService,
    private botsService: AgencyTelegramBotsService,
    private agencyService: AgencyService
  ) {}

  // ----- bots: any number can be connected; the token is never returned -----
  @Get('/bots')
  async getBots(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.botsService.list(actor);
  }

  @Post('/bots')
  async addBot(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: AddTelegramBotDto
  ) {
    return this.botsService.add(actor, body);
  }

  @Put('/bots/:id')
  async updateBot(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: UpdateTelegramBotDto
  ) {
    if (body.label !== undefined)
      await this.botsService.rename(actor, id, body);
    if (body.enabled !== undefined) {
      return this.telegramService.setBotEnabled(actor, id, body.enabled);
    }
    return this.botsService.check(actor, id);
  }

  /** Asks Telegram whether the token still works. */
  @Post('/bots/:id/check')
  async checkBot(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.botsService.check(actor, id);
  }

  @Delete('/bots/:id')
  async removeBot(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.telegramService.removeBot(actor, id);
  }

  @Get('/destinations')
  async getDestinations(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.telegramService.listDestinations(actor);
  }

  /** Live look at a chat (nothing is saved). */
  @Post('/verify')
  async verifyChat(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: VerifyTelegramChatDto
  ) {
    return this.telegramService.previewChat(actor, body.chatId, body.botId);
  }

  @Post('/destinations')
  async registerDestination(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: RegisterTelegramDestinationDto
  ) {
    return this.telegramService.registerDestination(actor, body);
  }

  @Put('/destinations/:id')
  async updateDestination(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: UpdateTelegramDestinationDto
  ) {
    return this.telegramService.updateSettings(actor, id, body);
  }

  /** Backup bots for a chat and how its bots share the work. */
  @Put('/destinations/:id/bots')
  async updateChatBots(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: UpdateChatBotsDto
  ) {
    return this.telegramService.updateChatBots(actor, id, body);
  }

  /** The manual switch of a chat's main bot. */
  @Post('/destinations/:id/main-bot')
  async makeMainBot(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: MakeMainBotDto
  ) {
    return this.telegramService.makeMainBot(actor, id, body.botId);
  }

  /** New one-time code, e.g. after revoke/expiry/disconnect or a lost code. */
  @Post('/destinations/:id/reauthorize')
  async reauthorize(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.telegramService.restartVerification(actor, id);
  }

  @Post('/destinations/:id/refresh')
  async refresh(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.telegramService.refreshHealth(actor, id);
  }

  @Post('/destinations/:id/suspend')
  async suspend(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: DestinationReasonDto
  ) {
    return this.telegramService.suspend(actor, id, body.reason);
  }

  @Post('/destinations/:id/resume')
  async resume(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.telegramService.resume(actor, id);
  }

  @Post('/destinations/:id/revoke')
  async revoke(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: DestinationReasonDto
  ) {
    return this.telegramService.revoke(actor, id, body.reason);
  }

  @Delete('/destinations/:id')
  async deleteDestination(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.telegramService.remove(actor, id);
  }

  /** Live publishing queue: what is waiting, sending, blocked or dead. */
  @Get('/jobs')
  async getJobs(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Query('status') status?: PostingJobStatus,
    @Query('campaignId') campaignId?: string
  ) {
    return this.agencyService.listJobs(actor, { status, campaignId });
  }

  @Get('/events')
  async getPublishingEvents(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.agencyService.getPublishingEvents(actor);
  }
}

/**
 * Receives bot updates when AGENCY_TELEGRAM_WEBHOOK_URL is used. Public (Telegram is
 * the caller) but authenticated by Telegram's secret-token header, and it must never
 * throw: any failure is logged inside the service and Telegram still gets a 200, so it
 * never enters a retry storm.
 */
@ApiTags('Agency Telegram Webhook')
@Controller('/agency/telegram')
export class AgencyTelegramWebhookController {
  constructor(private telegramService: AgencyTelegramService) {}

  @Post('/webhook')
  @HttpCode(200)
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') token: string | undefined,
    @Body() update: TelegramInboundUpdate
  ) {
    try {
      const secret = process.env.AGENCY_TELEGRAM_WEBHOOK_SECRET;
      if (!secret || !token) return { ok: true };
      const a = Buffer.from(token);
      const b = Buffer.from(secret);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: true };
      // A webhook is only ever set for the server's bot (bots connected in the app poll).
      await this.telegramService.handleUpdate(update);
    } catch {
      // handleUpdate already logs; swallowing here is the point.
    }
    return { ok: true };
  }
}
