import {
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CampaignStatus } from '@prisma/client';

export class CampaignDestinationItemDto {
  @ApiProperty({ enum: ['TELEGRAM', 'SOCIAL'] })
  @IsString()
  destinationType: 'TELEGRAM' | 'SOCIAL';

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  telegramDestinationId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  integrationId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  customSettings?: string;
}

export class CreateCampaignDto {
  @ApiProperty({ description: 'Target Client / Customer ID' })
  @IsString()
  @IsNotEmpty()
  customerId: string;

  @ApiProperty({ description: 'Campaign Name' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ description: 'Campaign description or brief' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Campaign Objective' })
  @IsString()
  @IsOptional()
  objective?: string;

  @ApiPropertyOptional({ description: 'Campaign Budget in USD' })
  @IsNumber()
  @IsOptional()
  budget?: number;

  @ApiPropertyOptional({ description: 'Start Date (ISO 8601)' })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End Date (ISO 8601)' })
  @IsDateString()
  @IsOptional()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Timezone', default: 'UTC' })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({ description: 'Posting frequency' })
  @IsString()
  @IsOptional()
  postingFrequency?: string;

  @ApiPropertyOptional({ description: 'JSON string of allowed windows' })
  @IsString()
  @IsOptional()
  postingWindows?: string;

  @ApiPropertyOptional({ description: 'Advertisement headline or title' })
  @IsString()
  @IsOptional()
  contentTitle?: string;

  @ApiProperty({ description: 'Advertisement primary promotional text' })
  @IsString()
  @IsNotEmpty()
  contentBody: string;

  @ApiPropertyOptional({ description: 'JSON array of media URLs or IDs' })
  @IsString()
  @IsOptional()
  contentMedia?: string;

  @ApiPropertyOptional({ description: 'Landing page or CTA link' })
  @IsString()
  @IsOptional()
  ctaLink?: string;

  @ApiPropertyOptional({ description: 'Call to Action button text' })
  @IsString()
  @IsOptional()
  ctaText?: string;

  @ApiPropertyOptional({ description: 'Direct Telegram channel link' })
  @IsString()
  @IsOptional()
  telegramChannelLink?: string;

  @ApiPropertyOptional({ description: 'Internal team notes' })
  @IsString()
  @IsOptional()
  internalNotes?: string;

  @ApiPropertyOptional({ type: [CampaignDestinationItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CampaignDestinationItemDto)
  @IsOptional()
  destinations?: CampaignDestinationItemDto[];
}

export class UpdateCampaignDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  objective?: string;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  budget?: number;

  @ApiPropertyOptional({ enum: CampaignStatus })
  @IsEnum(CampaignStatus)
  @IsOptional()
  status?: CampaignStatus;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  endDate?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  postingFrequency?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  postingWindows?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  contentTitle?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  contentBody?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  contentMedia?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  ctaLink?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  ctaText?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  telegramChannelLink?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  internalNotes?: string;
}

export class UpdateCampaignDestinationsDto {
  @ApiProperty({ type: [CampaignDestinationItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CampaignDestinationItemDto)
  destinations: CampaignDestinationItemDto[];
}
