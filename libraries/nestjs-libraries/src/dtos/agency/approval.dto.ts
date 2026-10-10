import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitApprovalDto {
  @ApiPropertyOptional({ description: 'Submission notes for the Campaign Manager' })
  @IsString()
  @IsOptional()
  notes?: string;
}

export class ReviewApprovalDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'], description: 'Manager review decision' })
  @IsEnum(['APPROVE', 'REJECT'])
  @IsNotEmpty()
  decision: 'APPROVE' | 'REJECT';

  @ApiPropertyOptional({ description: 'Feedback or explanation notes for the submitter' })
  @IsString()
  @IsOptional()
  notes?: string;
}
