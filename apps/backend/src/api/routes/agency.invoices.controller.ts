import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgencyService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.service';
import { AgencyActor } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.access.service';
import { CreateInvoiceDto } from '@gitroom/nestjs-libraries/dtos/agency/invoice.dto';
import {
  AgencyActorFromRequest,
  AgencyActorGuard,
  agencyValidationPipe,
} from '@gitroom/backend/services/auth/permissions/agency.actor';

@ApiTags('Agency Invoices')
@Controller('/agency/invoices')
@UseGuards(AgencyActorGuard)
@UsePipes(agencyValidationPipe)
export class AgencyInvoicesController {
  constructor(private agencyService: AgencyService) {}

  @Get('/')
  async getInvoices(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Query('status') status?: string
  ) {
    return this.agencyService.getInvoices(actor, status);
  }

  @Post('/')
  async createInvoice(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Body() body: CreateInvoiceDto
  ) {
    return this.agencyService.createInvoice(actor, {
      customerId: body.customerId,
      amount: body.amount,
      currency: body.currency,
      dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
      items: body.items,
      notes: body.notes,
    });
  }

  @Post('/:id/pay')
  async markPaid(
    @AgencyActorFromRequest() actor: AgencyActor,
    @Param('id') id: string
  ) {
    return this.agencyService.markInvoicePaid(actor, id);
  }
}
