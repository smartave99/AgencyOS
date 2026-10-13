import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CopyTone } from '@gitroom/nestjs-libraries/dtos/agency/ai.dto';

/** The only {{placeholders}} a message may use. Anything else is refused, never guessed. */
export const WHATSAPP_PLACEHOLDERS = [
  'name',
  'first_name',
  'company',
  'agency',
] as const;

/** What a person marked a task as. There is no "delivered": AgencyOS cannot see delivery. */
export const WHATSAPP_TASK_STATUSES = [
  'PENDING',
  'SENT_BY_USER',
  'REPLIED',
  'SKIPPED',
] as const;

/** How a withdrawal reached the agency. */
export const WHATSAPP_WITHDRAW_METHODS = [
  'REPLIED_STOP',
  'PHONE_CALL',
  'EMAIL',
  'IN_PERSON',
  'OTHER',
] as const;

/**
 * Limits that keep the workspace a human-sized job. The API's JSON body limit is 100 KB, so an import
 * is bounded in characters as well as rows; a longer list goes up in parts.
 */
export const WHATSAPP_LIMITS = {
  maxImportRows: 2000,
  maxImportChars: 90000,
  maxTasksPerDraft: 500,
} as const;

// Cleared form fields arrive as ''; they mean "no value".
const HTTP_URL = { protocols: ['http', 'https'], require_protocol: true };

export class CreateWhatsappContactDto {
  @ApiProperty({ description: 'What the person is called' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({
    description: 'WhatsApp number with the country code, e.g. +4915112345678',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  phone: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(120)
  company?: string;

  @ApiPropertyOptional({ description: 'Language code, e.g. en or de' })
  @IsString()
  @IsOptional()
  @MaxLength(12)
  language?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  notes?: string;

  @ApiProperty({
    description: 'How the person agreed, e.g. “Web form” or “In person”',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  consentSource: string;

  @ApiPropertyOptional({ description: 'What shows they agreed' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  consentEvidence?: string;

  @ApiProperty({ description: 'The day they agreed (ISO date)' })
  @IsDateString()
  consentedAt: string;
}

/** Number and consent are not editable: a different number is a different person to ask. */
export class UpdateWhatsappContactDto {
  @ApiPropertyOptional()
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(120)
  company?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(12)
  language?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  notes?: string;
}

export class WithdrawWhatsappConsentDto {
  @ApiProperty({ enum: WHATSAPP_WITHDRAW_METHODS })
  @IsIn(WHATSAPP_WITHDRAW_METHODS as unknown as string[])
  method: (typeof WHATSAPP_WITHDRAW_METHODS)[number];

  @ApiPropertyOptional({ description: 'When the person asked (ISO date)' })
  @IsDateString()
  @IsOptional()
  receivedAt?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}

export class PreviewWhatsappImportDto {
  @ApiProperty({
    description:
      'The CSV as text. Columns: name, phone, consent_source, consent_date (and optionally language, tags, company, notes, consent_evidence)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(WHATSAPP_LIMITS.maxImportChars)
  csv: string;
}

export class CommitWhatsappImportDto extends PreviewWhatsappImportDto {
  @ApiProperty({
    description:
      'The operator confirms the people in the file agreed to be contacted on WhatsApp',
  })
  @IsBoolean()
  @Equals(true, {
    message:
      'Confirm that the people in this file agreed to be contacted on WhatsApp.',
  })
  attested: boolean;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(200)
  fileName?: string;
}

export class SaveWhatsappSegmentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ type: [String], description: 'Any of these tags' })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(12, { each: true })
  @IsOptional()
  languages?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @IsOptional()
  consentSources?: string[];
}

export class PreviewWhatsappSegmentDto {
  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(12, { each: true })
  @IsOptional()
  languages?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @IsOptional()
  consentSources?: string[];
}

export class SaveWhatsappTemplateDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({
    description:
      'The message, with {{name}}, {{first_name}}, {{company}}, {{agency}}',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  body: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(12)
  language?: string;

  @ApiPropertyOptional({
    description: 'A link added under the message (http/https)',
  })
  @ValidateIf((o) => o.link !== undefined && o.link !== '')
  @IsUrl(HTTP_URL)
  @MaxLength(500)
  link?: string;

  @ApiPropertyOptional({
    description:
      'Added to every message. Left out, the agency default is used; an empty line removes it',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  optOutLine?: string;
}

export class PreviewWhatsappTemplateDto {
  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  body: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.link !== undefined && o.link !== '')
  @IsUrl(HTTP_URL)
  @MaxLength(500)
  link?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(200)
  optOutLine?: string;

  @ApiPropertyOptional({
    description: 'Show it for this contact; a sample otherwise',
  })
  @IsString()
  @IsOptional()
  contactId?: string;
}

export class SuggestWhatsappWordingDto {
  @ApiPropertyOptional({ description: 'What the message is about' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  brief?: string;

  @ApiPropertyOptional({ description: 'Wording to improve' })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  body?: string;

  @ApiPropertyOptional({ enum: CopyTone })
  @IsEnum(CopyTone)
  @IsOptional()
  tone?: CopyTone;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(12)
  language?: string;
}

export class DraftWhatsappTasksDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  templateId: string;

  @ApiPropertyOptional({
    description: 'Everyone in this segment who is opted in',
  })
  @IsString()
  @IsOptional()
  segmentId?: string;

  @ApiPropertyOptional({ description: 'Or one contact' })
  @IsString()
  @IsOptional()
  contactId?: string;
}

export class SetWhatsappTaskStatusDto {
  @ApiProperty({ enum: WHATSAPP_TASK_STATUSES })
  @IsIn(WHATSAPP_TASK_STATUSES as unknown as string[])
  status: (typeof WHATSAPP_TASK_STATUSES)[number];

  @ApiPropertyOptional({ description: 'Why it was skipped' })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  skipReason?: string;
}

export class UpdateWhatsappTaskDto {
  @ApiPropertyOptional({ description: 'An empty note clears it' })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  note?: string;

  @ApiPropertyOptional({
    description: 'Remind me on this day; null clears the reminder',
    nullable: true,
  })
  @IsDateString()
  @IsOptional()
  followUpAt?: string | null;
}

export class UpdateWhatsappSettingsDto {
  @ApiPropertyOptional({ description: 'Added to new templates and previews' })
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @MaxLength(200)
  defaultOptOutLine?: string;

  @ApiPropertyOptional({
    description: 'Cannot be turned on in this version; asking says so',
  })
  @IsBoolean()
  @IsOptional()
  businessApiEnabled?: boolean;
}
