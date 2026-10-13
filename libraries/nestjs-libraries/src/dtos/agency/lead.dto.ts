import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** What a person who asked to hear from the agency is called in the pipeline. */
export const LEAD_STATUSES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'CONVERTED',
  'LOST',
] as const;

export class CreateLeadLinkDto {
  @ApiProperty({ description: 'What this link is for, e.g. “Spring offer”' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  label: string;

  @ApiPropertyOptional({ description: 'The campaign this link belongs to' })
  @IsString()
  @IsOptional()
  campaignId?: string;

  @ApiPropertyOptional({
    description: 'The bot the link opens: a connected bot’s id, or "server"',
  })
  @IsString()
  @IsOptional()
  botId?: string;

  @ApiPropertyOptional({
    description:
      'Said first when someone starts the bot. The notice about /stop is always added.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  welcomeMessage?: string;
}

export class UpdateLeadDto {
  @ApiPropertyOptional({ enum: LEAD_STATUSES })
  @IsIn(LEAD_STATUSES as unknown as string[])
  @IsOptional()
  status?: (typeof LEAD_STATUSES)[number];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  notes?: string;
}
