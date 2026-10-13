import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export const AI_PROVIDER_IDS = [
  'local',
  'claude-cli',
  'codex-cli',
  'antigravity-cli',
  'anthropic',
  'openai',
  'gemini',
  'openai-compatible',
] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export const THINKING_LEVELS = [
  'auto',
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** The jobs that can each use their own model and thinking level. */
export const AI_TASKS = ['copy', 'improve', 'copilot', 'agent'] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** What a person may type as a model name: letters, digits and . _ : / - only. */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

export class UpdateAiSettingsDto {
  @IsOptional()
  @IsIn(AI_PROVIDER_IDS as unknown as string[])
  activeProvider?: AiProviderId;

  @IsOptional()
  @IsIn(THINKING_LEVELS as unknown as string[])
  thinking?: ThinkingLevel;

  /**
   * Per provider: { model?, baseUrl?, apiKey? }. An empty string clears a value. The shape
   * of each entry is checked by the service, which also knows which providers exist.
   */
  @IsOptional()
  @IsObject()
  providers?: Record<
    string,
    { model?: string; baseUrl?: string; apiKey?: string }
  >;

  /**
   * Per job (copy, improve, copilot, agent): { provider?, model?, thinking? }. An empty value, or
   * null for the whole job, goes back to "same as the default". The service checks each entry.
   */
  @IsOptional()
  @IsObject()
  tasks?: Record<
    string,
    { provider?: string; model?: string; thinking?: string } | null
  >;
}

export class AiProviderRefDto {
  @IsOptional()
  @IsIn(AI_PROVIDER_IDS as unknown as string[])
  provider?: AiProviderId;

  /** Test the way a particular job is set up. */
  @IsOptional()
  @IsIn(AI_TASKS as unknown as string[])
  task?: AiTask;
}

export class AiChatMessageDto {
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  @MaxLength(8000)
  content: string;
}

export class AiChatDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => AiChatMessageDto)
  messages: AiChatMessageDto[];

  /** The page the person is on, so answers can point at the right place. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  page?: string;
}

export class AiToolsDto {
  @IsBoolean()
  autoUpdate: boolean;
}

export class AgentMessageDto {
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  @MaxLength(14000)
  content: string;
}

export class AgentStepDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => AgentMessageDto)
  messages: AgentMessageDto[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  page?: string;
}

export class AgentActDto {
  @IsString()
  @MaxLength(80)
  tool: string;

  @IsObject()
  args: Record<string, unknown>;
}
