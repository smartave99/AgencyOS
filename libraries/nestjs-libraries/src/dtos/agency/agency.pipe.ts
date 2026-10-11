import { ValidationPipe } from '@nestjs/common';

/** Unknown body properties are dropped, so a client can't smuggle fields (e.g. status) past a DTO. */
export const agencyValidationPipe = new ValidationPipe({
  whitelist: true,
  transform: true,
});
