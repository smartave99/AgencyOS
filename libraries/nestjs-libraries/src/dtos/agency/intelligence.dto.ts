import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsIn,
  IsBoolean,
  MaxLength,
  Max,
  Min,
} from 'class-validator';

export class IngestDocumentDto {
  @IsString()
  @MaxLength(300)
  title: string;

  @IsString()
  @MaxLength(20000)
  content: string;

  /** The uploader attests the source authorized collection and participants were notified. */
  @IsBoolean()
  authorizationConfirmed: boolean;

  @IsOptional()
  @IsString()
  @IsIn(['DISCUSSION', 'CAMPAIGN_BRIEF', 'FAQ', 'SOP', 'MARKET_RESEARCH'])
  category?: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  telegramDestId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class SearchIntelligenceDto {
  @IsString()
  @MaxLength(1000)
  query: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  threshold?: number;
}
