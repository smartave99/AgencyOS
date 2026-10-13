import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Empty strings arrive from cleared form fields; treat them as "not provided".
const HTTP_URL = { protocols: ['http', 'https'], require_protocol: true };

export class CreateAdTemplateDto {
  @ApiProperty({ description: 'Template name, unique in the workspace' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ description: 'Advertisement headline or title' })
  @IsString()
  @IsOptional()
  @MaxLength(300)
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
  @MaxLength(100)
  ctaText?: string;
}

export class UpdateAdTemplateDto {
  @ApiPropertyOptional()
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(300)
  contentTitle?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsNotEmpty()
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
  @MaxLength(100)
  ctaText?: string;
}
