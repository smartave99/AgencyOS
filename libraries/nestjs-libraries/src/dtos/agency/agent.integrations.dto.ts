import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** What a token lets an agent do. There is no scope that can send, schedule, approve or delete. */
export const AGENT_SCOPES = ['READ', 'DRAFT'] as const;
export type AgentScopeName = (typeof AGENT_SCOPES)[number];

export const AGENT_PROPOSAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'DECLINED',
  'EXPIRED',
] as const;

/** A token that was not given an expiry lasts this long. */
export const AGENT_TOKEN_DEFAULT_DAYS = 90;

export class CreateAgentTokenDto {
  @ApiProperty({ description: 'What this key is for, e.g. “Antigravity”' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  label: string;

  @ApiProperty({
    enum: AGENT_SCOPES,
    description:
      'READ looks only. DRAFT also proposes changes that a person approves.',
  })
  @IsIn(AGENT_SCOPES as unknown as string[])
  scope: AgentScopeName;

  @ApiPropertyOptional({
    description: `Days until the key stops working (default ${AGENT_TOKEN_DEFAULT_DAYS}); 0 means it does not expire`,
  })
  @IsInt()
  @Min(0)
  @Max(365)
  @IsOptional()
  expiresInDays?: number;
}

/** One call from an agent: a tool by name and its arguments. */
export class AgentCallDto {
  @ApiProperty({ description: 'The tool name, from GET /agent-gateway/tools' })
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,63}$/, { message: 'tool is not a tool name' })
  tool: string;

  @ApiPropertyOptional({ description: 'The tool’s arguments' })
  @IsObject()
  @IsOptional()
  args?: Record<string, unknown>;
}

export class DeclineAgentProposalDto {
  @ApiPropertyOptional({ description: 'Why, for the record' })
  @IsString()
  @IsOptional()
  @MaxLength(300)
  reason?: string;
}
