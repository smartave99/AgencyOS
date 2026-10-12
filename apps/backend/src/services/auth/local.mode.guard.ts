import { CanActivate, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthService } from '@gitroom/backend/services/auth/auth.service';

/**
 * AgencyOS on a person's own computer has no sign-in, registration or password reset. Refusing
 * these routes means nothing can create a second account or try passwords against the local one.
 */
@Injectable()
export class DisabledInLocalModeGuard implements CanActivate {
  canActivate() {
    if (AuthService.isLocalMode()) {
      throw new ForbiddenException(
        'AgencyOS on this computer does not use sign-in.'
      );
    }
    return true;
  }
}
