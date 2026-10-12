import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
  'max',
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

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
  providers?: Record<string, { model?: string; baseUrl?: string; apiKey?: string }>;
}

export class AiProviderRefDto {
  @IsOptional()
  @IsIn(AI_PROVIDER_IDS as unknown as string[])
  provider?: AiProviderId;
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
