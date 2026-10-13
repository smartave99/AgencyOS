import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VerifyTelegramChatDto {
  @ApiProperty({ description: 'Telegram chat ID or @channelusername' })
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiPropertyOptional({
    description: 'The connected bot to look through (omit for the server bot)',
  })
  @IsString()
  @IsOptional()
  @MaxLength(64)
  botId?: string;
}

/** What @BotFather hands out: 123456789:AAH… */
export const TELEGRAM_BOT_TOKEN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

export class AddTelegramBotDto {
  @ApiProperty({ description: 'Your own name for the bot, e.g. "Acme Ads"' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  label: string;

  @ApiProperty({ description: 'The bot token from @BotFather' })
  @IsString()
  @Matches(TELEGRAM_BOT_TOKEN, {
    message:
      'That does not look like a bot token. It looks like 123456789:AAH… and comes from @BotFather.',
  })
  token: string;
}

export class UpdateTelegramBotDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(80)
  label?: string;

  @ApiPropertyOptional({
    description: 'false pauses the bot without removing it',
  })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}

/**
 * Permissions are deliberately absent: what the bot may do is read from Telegram,
 * never accepted from the caller.
 */
export class RegisterTelegramDestinationDto {
  @ApiPropertyOptional({
    description:
      'Which connected bot posts here. Required when more than one bot is connected.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(64)
  botId?: string;

  @ApiProperty({
    description: 'Telegram Chat ID (e.g. -100123456789 or @channelname)',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^(-?\d{5,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/, {
    message:
      'Use a numeric chat ID (e.g. -1001234567890) or an @channelusername',
  })
  chatId: string;

  @ApiPropertyOptional({
    description: 'Friendly title (used until Telegram supplies the real one)',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({
    description: 'Name of the person/organization that owns the destination',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  ownerName?: string;

  @ApiPropertyOptional({ description: 'How to reach the destination owner' })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  ownerContact?: string;

  @ApiPropertyOptional({
    description: 'IANA time zone used for posting windows',
    default: 'UTC',
  })
  @IsString()
  @IsOptional()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({
    description: 'JSON array of permitted content categories',
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  permittedCategories?: string;

  @ApiPropertyOptional({
    description: 'JSON: {"maxPerDay":3,"minIntervalMinutes":60}',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  postingFrequencyRules?: string;

  @ApiPropertyOptional({
    description: 'JSON: [{"days":[1,2,3,4,5],"start":"09:00","end":"18:00"}]',
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  allowedPostingWindows?: string;
}

export class UpdateTelegramDestinationDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(200)
  ownerName?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(200)
  ownerContact?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  permittedCategories?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(500)
  postingFrequencyRules?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  allowedPostingWindows?: string;
}

export class DestinationReasonDto {
  @ApiPropertyOptional({
    description: 'Why the destination is being suspended or revoked',
  })
  @IsString()
  @IsOptional()
  @MaxLength(300)
  reason?: string;
}
