import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgencyService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization } from '@prisma/client';
import {
  RegisterTelegramDestinationDto,
  VerifyTelegramChatDto,
} from '@gitroom/nestjs-libraries/dtos/agency/telegram.dto';

@ApiTags('Agency Telegram Management')
@Controller('/agency/telegram')
export class AgencyTelegramController {
  constructor(private agencyService: AgencyService) {}

  @Get('/destinations')
  async getDestinations(@GetOrgFromRequest() org: Organization) {
    return this.agencyService.getTelegramDestinations(org.id);
  }

  @Post('/verify')
  async verifyChat(
    @GetOrgFromRequest() org: Organization,
    @Body() body: VerifyTelegramChatDto
  ) {
    return this.agencyService.verifyTelegramChat(body.chatId);
  }

  @Post('/destinations')
  async registerDestination(
    @GetOrgFromRequest() org: Organization,
    @Body() body: RegisterTelegramDestinationDto
  ) {
    return this.agencyService.registerTelegramDestination(org.id, body);
  }

  @Delete('/destinations/:id')
  async deleteDestination(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this.agencyService.deleteTelegramDestination(org.id, id);
  }

  @Get('/events')
  async getPublishingEvents(@GetOrgFromRequest() org: Organization) {
    return this.agencyService.getPublishingEvents(org.id);
  }
}
