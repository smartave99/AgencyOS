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
import { AgencyTelegramUsersService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.telegram.users.service';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import {
  AccountLoginCancelDto,
  AccountLoginCodeDto,
  AccountLoginPasswordDto,
  StartAccountLoginDto,
  UpdateTelegramAccountDto,
} from '@gitroom/nestjs-libraries/dtos/agency/telegram.account.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency Telegram accounts')
@Controller('/agency/telegram/accounts')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyTelegramAccountsController {
  constructor(private accounts: AgencyTelegramUsersService) {}

  @Get('/status')
  async status(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.accounts.workerStatus(actor);
  }

  @Get('/')
  async list(@AgencyActorFromRequest() actor: AgencyActor) {
    return this.accounts.list(actor);
  }

  @Post('/login/start')
  async start(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: StartAccountLoginDto
  ) {
    return this.accounts.startLogin(actor, body);
  }

  @Post('/login/code')
  async code(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: AccountLoginCodeDto
  ) {
    return this.accounts.submitCode(actor, body.loginId, body.code);
  }

  @Post('/login/password')
  async password(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: AccountLoginPasswordDto
  ) {
    return this.accounts.submitPassword(actor, body.loginId, body.password);
  }

  @Post('/login/cancel')
  async cancel(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: AccountLoginCancelDto
  ) {
    return this.accounts.cancelLogin(actor, body.loginId);
  }

  @Put('/:id')
  async update(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string,
    @Body() body: UpdateTelegramAccountDto
  ) {
    return this.accounts.update(actor, id, body);
  }

  @Post('/:id/pause')
  async pause(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.accounts.pause(actor, id);
  }

  @Post('/:id/resume')
  async resume(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.accounts.resume(actor, id);
  }

  @Post('/:id/check')
  async check(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.accounts.check(actor, id);
  }

  @Post('/:id/logout')
  async logout(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.accounts.logout(actor, id);
  }

  @Get('/:id/events')
  async events(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.accounts.events(actor, id);
  }

  @Delete('/:id')
  async remove(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.accounts.remove(actor, id);
  }
}
