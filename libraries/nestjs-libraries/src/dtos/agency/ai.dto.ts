import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

export enum CopyTone {
  DIRECT_RESPONSE = 'DIRECT_RESPONSE',
  PROFESSIONAL = 'PROFESSIONAL',
  CASUAL = 'CASUAL',
  URGENT = 'URGENT',
}

export enum CopyChannel {
  TELEGRAM = 'TELEGRAM',
  SOCIAL = 'SOCIAL',
}

export class GenerateAdCopyDto {
  @IsString()
  @MinLength(5, { message: 'Brief must be at least 5 characters long' })
  brief: string;

  @IsOptional()
  @IsString()
  objective?: string;

  @IsOptional()
  @IsString()
  clientName?: string;

  @IsOptional()
  @IsString()
  industry?: string;

  @IsOptional()
  @IsEnum(CopyTone)
  tone?: CopyTone;

  @IsOptional()
  @IsEnum(CopyChannel)
  channelType?: CopyChannel;

  @IsOptional()
  @IsString()
  targetAudience?: string;
}

export class ImproveTextDto {
  @IsString()
  text: string;

  @IsOptional()
  @IsEnum(CopyTone)
  targetTone?: CopyTone;

  @IsOptional()
  @IsString()
  instructions?: string;
}
