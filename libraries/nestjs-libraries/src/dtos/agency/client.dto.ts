import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateClientDto {
  @ApiProperty({ description: 'Client contact or company representative name' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ description: 'Primary contact email' })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ description: 'Contact phone number' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ description: 'Company or business legal name' })
  @IsString()
  @IsOptional()
  companyName?: string;

  @ApiPropertyOptional({ description: 'Industry or business category' })
  @IsString()
  @IsOptional()
  industry?: string;

  @ApiPropertyOptional({ description: 'Client official website' })
  @IsUrl()
  @IsOptional()
  website?: string;

  @ApiPropertyOptional({ description: 'Internal account notes' })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({ description: 'Assigned salesperson User ID' })
  @IsString()
  @IsOptional()
  assignedSalesUserId?: string;
}

export class UpdateClientDto {
  @ApiPropertyOptional({ description: 'Client contact name' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: 'Primary email' })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ description: 'Phone number' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ description: 'Company name' })
  @IsString()
  @IsOptional()
  companyName?: string;

  @ApiPropertyOptional({ description: 'Industry' })
  @IsString()
  @IsOptional()
  industry?: string;

  @ApiPropertyOptional({ description: 'Website URL' })
  @IsUrl()
  @IsOptional()
  website?: string;

  @ApiPropertyOptional({ description: 'Account status (ACTIVE, INACTIVE, PAUSED)' })
  @IsString()
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({ description: 'Internal notes' })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({ description: 'Assigned salesperson ID' })
  @IsString()
  @IsOptional()
  assignedSalesUserId?: string;
}
