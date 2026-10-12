import { Controller, Headers, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { RealIP } from 'nestjs-real-ip';
import { AuthService } from '@gitroom/backend/services/auth/auth.service';
import { UserAgent } from '@gitroom/nestjs-libraries/user/user.agent';

@ApiTags('Auth')
@Controller('/auth')
export class AuthLocalController {
  constructor(private _authService: AuthService) {}

  // Called by the AgencyOS app server on this computer, never by the browser: the key travels
  // server to server and the session comes back to the app server, which sets the cookie.
  @Post('/local-session')
  async localSession(
    @Headers('x-agencyos-local-key') key: string,
    @Res({ passthrough: false }) response: Response,
    @RealIP() ip: string,
    @UserAgent() userAgent: string
  ) {
    if (!AuthService.isLocalMode() || !this._authService.isLocalKey(key)) {
      return response.status(403).json({ error: 'Not allowed' });
    }

    try {
      return response
        .status(200)
        .json({ jwt: await this._authService.localSession(ip, userAgent) });
    } catch (e) {
      return response
        .status(500)
        .json({ error: 'Could not open the workspace' });
    }
  }
}
