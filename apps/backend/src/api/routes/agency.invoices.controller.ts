import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgencyService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization } from '@prisma/client';
import { CreateInvoiceDto } from '@gitroom/nestjs-libraries/dtos/agency/invoice.dto';

@ApiTags('Agency Invoices')
@Controller('/agency/invoices')
export class AgencyInvoicesController {
  constructor(private agencyService: AgencyService) {}

  @Get('/')
  async getInvoices(
    @GetOrgFromRequest() org: Organization,
    @Query('status') status?: string
  ) {
    return this.agencyService.getInvoices(org.id, status);
  }

  @Post('/')
  async createInvoice(
    @GetOrgFromRequest() org: Organization,
    @Body() body: CreateInvoiceDto
  ) {
    return this.agencyService.createInvoice(org.id, {
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
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this.agencyService.markInvoicePaid(org.id, id);
  }
}
