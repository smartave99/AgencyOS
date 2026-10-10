import { IsString, IsOptional, IsArray, IsNumber, IsIn } from 'class-validator';

export class IngestDocumentDto {
  @IsString()
  title: string;

  @IsString()
  content: string;

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
  tags?: string[];
}

export class SearchIntelligenceDto {
  @IsString()
  query: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsNumber()
  threshold?: number;
}
