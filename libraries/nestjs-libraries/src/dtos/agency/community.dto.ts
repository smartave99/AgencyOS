import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SearchCommunitiesDto {
  @ApiProperty({ description: 'The Telegram account that searches' })
  @IsString()
  @IsNotEmpty()
  accountId: string;

  @ApiProperty({
    description: 'A word or name to search public communities for',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  query: string;

  @ApiPropertyOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  limit?: number;
}

export class ImportCommunitiesDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  accountId: string;

  @ApiProperty({ description: 'Public @names or t.me links, at most 50' })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  refs: string[];

  @ApiPropertyOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(60)
  category?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(30)
  language?: string;

  @ApiPropertyOptional({
    description: 'Where the list came from, e.g. "search"',
  })
  @IsString()
  @IsOptional()
  @MaxLength(60)
  source?: string;
}

export class ValidateLinksDto {
  @ApiProperty()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  refs: string[];
}

export class RefreshCommunitiesDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  accountId: string;

  @ApiProperty({ description: 'Saved communities, at most 20' })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  ids: string[];
}

export class UpdateCommunityLabelsDto {
  @ApiPropertyOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(60)
  category?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(30)
  language?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  bookmarked?: boolean;
}

export class JoinCommunityDto {
  @ApiProperty({
    description: 'The account that joins (it must be allowed to)',
  })
  @IsString()
  @IsNotEmpty()
  accountId: string;

  @ApiProperty({ description: 'Why this community is worth joining' })
  @IsString()
  @MaxLength(300)
  reason: string;

  @ApiProperty({ description: 'The person confirms they are choosing to join' })
  @IsBoolean()
  confirmed: boolean;
}

export class CommunityAccountDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  accountId: string;
}

export class CommunityReasonDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(300)
  reason?: string;
}

export class ReviewAdvertisingDto {
  @ApiProperty({ enum: ['ALLOWED', 'NOT_ALLOWED'] })
  @IsIn(['ALLOWED', 'NOT_ALLOWED'])
  decision: 'ALLOWED' | 'NOT_ALLOWED';

  @ApiProperty({
    description: 'What the community’s rules say about advertising',
  })
  @IsString()
  @MaxLength(1000)
  note: string;

  @ApiPropertyOptional({ description: 'A link to the rules, as evidence' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  evidenceUrl?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  rulesRead?: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  advertisingPermitted?: boolean;
}

export class CreateCommunityDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  accountId: string;

  @ApiProperty({ enum: ['group', 'channel'] })
  @IsIn(['group', 'channel'])
  kind: 'group' | 'channel';

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  title: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(255)
  about?: string;

  @ApiPropertyOptional({ description: 'A public @name, if it should have one' })
  @IsString()
  @IsOptional()
  @MaxLength(33)
  username?: string;
}

export class UpdateManagedCommunityDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(128)
  title?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(255)
  about?: string;
}

export class DecideJoinRequestDto {
  @ApiProperty({ description: 'The one person whose request this is' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  userId: string;

  @ApiProperty()
  @Type(() => Boolean)
  @IsBoolean()
  approve: boolean;
}
