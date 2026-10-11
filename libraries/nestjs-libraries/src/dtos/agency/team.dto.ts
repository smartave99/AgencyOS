import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgencyRole } from '@prisma/client';

export class SetAgencyRoleDto {
  @ApiProperty({ enum: AgencyRole })
  @IsEnum(AgencyRole)
  role: AgencyRole;

  @ApiPropertyOptional({
    description: 'Required for CLIENT: the one client this user may see',
  })
  @IsString()
  @IsOptional()
  customerId?: string;
}

export class ClientReviewDto {
  @ApiProperty()
  @IsString()
  campaignId: string;

  @ApiProperty({ enum: ['APPROVE', 'REQUEST_CHANGES'] })
  @IsEnum({ APPROVE: 'APPROVE', REQUEST_CHANGES: 'REQUEST_CHANGES' })
  action: 'APPROVE' | 'REQUEST_CHANGES';

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  feedback?: string;
}
