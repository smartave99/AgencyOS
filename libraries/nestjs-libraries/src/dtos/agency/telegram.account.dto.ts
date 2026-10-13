import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Signing a Telegram user account in: the phone, then the code Telegram sends, then maybe a password. */
export class StartAccountLoginDto {
  @ApiPropertyOptional({ description: 'What the team calls this account' })
  @IsString()
  @IsOptional()
  @MaxLength(80)
  label?: string;

  @ApiProperty({ description: 'api id from my.telegram.org' })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  apiId: number;

  @ApiProperty({ description: 'api hash from my.telegram.org (32 characters)' })
  @IsString()
  @Matches(/^[0-9a-fA-F]{32}$/, {
    message: 'The api hash is 32 letters and digits from my.telegram.org',
  })
  apiHash: string;

  @ApiProperty({ description: 'Phone number with country code' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(24)
  phone: string;
}

export class AccountLoginCodeDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  loginId: string;

  @ApiProperty({ description: 'The code Telegram sent' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(12)
  code: string;
}

export class AccountLoginPasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  loginId: string;

  @ApiProperty({ description: 'The account’s two-step verification password' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  password: string;
}

export class AccountLoginCancelDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  loginId: string;
}

export class UpdateTelegramAccountDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(80)
  label?: string;

  @ApiPropertyOptional({ description: 'May look up public communities' })
  @IsBoolean()
  @IsOptional()
  canResearch?: boolean;

  @ApiPropertyOptional({ description: 'May join and leave communities' })
  @IsBoolean()
  @IsOptional()
  canJoin?: boolean;

  @ApiPropertyOptional({ description: 'May post advertisements' })
  @IsBoolean()
  @IsOptional()
  canPublish?: boolean;

  @ApiPropertyOptional({ description: 'May create and manage communities' })
  @IsBoolean()
  @IsOptional()
  canManage?: boolean;
}
