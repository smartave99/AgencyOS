import { Controller, Get, Headers, Ip, Param, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AgencyService } from '@gitroom/nestjs-libraries/database/prisma/agency/agency.service';

/**
 * Public by design: the people clicking a tracked link in an ad are not logged in.
 * This controller must NOT be registered under AuthMiddleware.
 */
@ApiTags('Agency Tracking')
@Controller('/')
export class AgencyTrackingController {
  constructor(private agencyService: AgencyService) {}

  @Get('/l/:code')
  async redirectShortLink(
    @Param('code') code: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    @Headers('referer') referer: string,
    @Res() res: Response
  ) {
    try {
      const destinationUrl =
        await this.agencyService.resolveTrackingLinkAndRecordClick(
          code,
          ip,
          userAgent,
          referer
        );
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return res.redirect(302, destinationUrl);
    } catch {
      return res.status(404).send('Tracking link not found or expired');
    }
  }

  @Get('/agency/track/:code')
  async redirectAgencyTrack(
    @Param('code') code: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    @Headers('referer') referer: string,
    @Res() res: Response
  ) {
    return this.redirectShortLink(code, ip, userAgent, referer, res);
  }
}
