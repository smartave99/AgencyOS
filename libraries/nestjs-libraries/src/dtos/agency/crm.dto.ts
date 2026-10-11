import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DealStage } from '@prisma/client';

// Cleared form fields arrive as ''; they mean "no value".
const blank = (o: any, key: string) => o[key] !== undefined && o[key] !== '';

export class CreateDealDto {
  @ApiProperty({ description: 'Main contact at the prospect' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  contactName: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(200)
  companyName?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => blank(o, 'contactEmail'))
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(50)
  contactPhone?: string;

  @ApiPropertyOptional({ description: 'Expected campaign value' })
  @IsNumber()
  @Min(0)
  @IsOptional()
  value?: number;

  @ApiPropertyOptional({
    description: '3-letter currency code',
    default: 'USD',
  })
  @Matches(/^[A-Za-z]{3}$/)
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  expectedCloseDate?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(5000)
  notes?: string;

  @ApiPropertyOptional({
    description: 'Defaults to the creator; only managers may assign others',
  })
  @IsString()
  @IsOptional()
  ownerUserId?: string;
}

export class UpdateDealDto {
  @ApiPropertyOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @IsOptional()
  contactName?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(200)
  companyName?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => blank(o, 'contactEmail'))
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(50)
  contactPhone?: string;

  @ApiPropertyOptional()
  @IsNumber()
  @Min(0)
  @IsOptional()
  value?: number;

  @ApiPropertyOptional()
  @Matches(/^[A-Za-z]{3}$/)
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  expectedCloseDate?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(5000)
  notes?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  ownerUserId?: string;
}

export class MoveDealDto {
  @ApiProperty({ enum: DealStage })
  @IsEnum(DealStage)
  stage: DealStage;

  @ApiPropertyOptional({ description: 'Required when moving to LOST' })
  @IsString()
  @IsOptional()
  @MaxLength(300)
  lostReason?: string;
}
