import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Empty strings arrive from cleared form fields; treat them as "not provided".
const HTTP_URL = { protocols: ['http', 'https'], require_protocol: true };

export class CampaignDestinationItemDto {
  @ApiProperty({ enum: ['TELEGRAM', 'SOCIAL'] })
  @IsIn(['TELEGRAM', 'SOCIAL'])
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

  @ApiPropertyOptional({
    description: 'Start for this destination only (ISO 8601)',
  })
  @IsDateString()
  @IsOptional()
  scheduledAt?: string;
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
  @Min(0)
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
  @MaxLength(10000)
  contentBody: string;

  @ApiPropertyOptional({ description: 'JSON array of media URLs or IDs' })
  @IsString()
  @IsOptional()
  contentMedia?: string;

  @ApiPropertyOptional({ description: 'Landing page or CTA link (http/https)' })
  @ValidateIf((o) => o.ctaLink !== undefined && o.ctaLink !== '')
  @IsUrl(HTTP_URL)
  ctaLink?: string;

  @ApiPropertyOptional({ description: 'Call to Action button text' })
  @IsString()
  @IsOptional()
  ctaText?: string;

  @ApiPropertyOptional({
    description: 'Direct Telegram channel link (http/https)',
  })
  @ValidateIf(
    (o) => o.telegramChannelLink !== undefined && o.telegramChannelLink !== ''
  )
  @IsUrl(HTTP_URL)
  telegramChannelLink?: string;

  @ApiPropertyOptional({
    description: 'Require the client to approve before the agency can',
  })
  @IsBoolean()
  @IsOptional()
  requiresClientApproval?: boolean;

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
  @Min(0)
  @IsOptional()
  budget?: number;

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
  @MaxLength(10000)
  contentBody?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  contentMedia?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.ctaLink !== undefined && o.ctaLink !== '')
  @IsUrl(HTTP_URL)
  ctaLink?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  ctaText?: string;

  @ApiPropertyOptional()
  @ValidateIf(
    (o) => o.telegramChannelLink !== undefined && o.telegramChannelLink !== ''
  )
  @IsUrl(HTTP_URL)
  telegramChannelLink?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  requiresClientApproval?: boolean;

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

export class CancelCampaignDto {
  @ApiPropertyOptional({ description: 'Why the campaign is being cancelled' })
  @IsString()
  @IsOptional()
  @MaxLength(300)
  reason?: string;
}

export class ResolveJobDto {
  @ApiProperty({
    enum: ['POSTED', 'NOT_POSTED'],
    description: 'What you found when checking the destination',
  })
  @IsIn(['POSTED', 'NOT_POSTED'])
  outcome: 'POSTED' | 'NOT_POSTED';

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(300)
  note?: string;
}

export class CreateTrackingLinkDto {
  @ApiProperty({
    description: 'Landing page the short link redirects to (http/https)',
  })
  @IsUrl(HTTP_URL)
  destinationUrl: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(100)
  utmSource?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(100)
  utmMedium?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(100)
  utmCampaign?: string;
}

export class PreviewAdDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(300)
  contentTitle?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(20000)
  contentBody?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  ctaLink?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(200)
  ctaText?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  telegramChannelLink?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  media?: string[];
}
