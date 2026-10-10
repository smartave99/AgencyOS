import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VerifyTelegramChatDto {
  @ApiProperty({ description: 'Telegram chat ID or @channelusername' })
  @IsString()
  @IsNotEmpty()
  chatId: string;
}

export class RegisterTelegramDestinationDto {
  @ApiProperty({ description: 'Telegram Chat ID (e.g. -100123456789 or @channelname)' })
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty({ description: 'Friendly title for the destination' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional({ enum: ['channel', 'group', 'supergroup'], default: 'channel' })
  @IsString()
  @IsOptional()
  type?: string;

  @ApiPropertyOptional({ description: 'Bot username managing the destination' })
  @IsString()
  @IsOptional()
  botUsername?: string;

  @ApiPropertyOptional({ description: 'Allow text and media posting' })
  @IsBoolean()
  @IsOptional()
  canPostMessages?: boolean;

  @ApiPropertyOptional({ description: 'Allow message deletion for moderation' })
  @IsBoolean()
  @IsOptional()
  canDeleteMessages?: boolean;

  @ApiPropertyOptional({ description: 'Allow invite links creation' })
  @IsBoolean()
  @IsOptional()
  canInviteUsers?: boolean;

  @ApiPropertyOptional({ description: 'JSON array of allowed content categories' })
  @IsString()
  @IsOptional()
  permittedCategories?: string;

  @ApiPropertyOptional({ description: 'Posting frequency limitations' })
  @IsString()
  @IsOptional()
  postingFrequencyRules?: string;

  @ApiPropertyOptional({ description: 'Allowed posting hours / windows' })
  @IsString()
  @IsOptional()
  allowedPostingWindows?: string;
}
