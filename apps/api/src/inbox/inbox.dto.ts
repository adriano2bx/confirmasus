import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MAX_HUMAN_TEXT_LENGTH, MAX_NOTE_LENGTH } from '@confirma/domain';
import { CONVERSATION_VIEWS, MAX_PAGE_LIMIT, type ConversationView } from './inbox.helpers.js';

const CONVERSATION_STATUSES = ['OPEN', 'WAITING_CONTACT', 'SNOOZED', 'RESOLVED'] as const;
type ConversationStatusInput = (typeof CONVERSATION_STATUSES)[number];

/** Prioridade da conversa: 0 normal, 1 alta, 2 muito alta, 3 urgente. */
export const MAX_CONVERSATION_PRIORITY = 3;

export class ListConversationsQueryDto {
  @IsOptional() @IsIn(CONVERSATION_VIEWS) view?: ConversationView;
  @IsOptional() @IsUUID() teamId?: string;
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @IsIn(CONVERSATION_STATUSES) status?: ConversationStatusInput;
  @IsOptional() @IsString() @MaxLength(40) q?: string;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_CONVERSATION_PRIORITY)
  priority?: number;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsString() @MaxLength(200) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_PAGE_LIMIT) limit?: number;
}

export class TimelineQueryDto {
  @IsOptional() @IsString() @MaxLength(200) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_PAGE_LIMIT) limit?: number;
}

export class VersionDto {
  @IsInt() @Min(0) version!: number;
}

export class AssignConversationDto extends VersionDto {
  @IsUUID() assigneeId!: string;
}

export class TransferConversationDto extends VersionDto {
  @IsOptional() @IsUUID() toTeamId?: string;
  @IsOptional() @IsUUID() toUserId?: string;
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class UpdateConversationStatusDto extends VersionDto {
  @IsIn(CONVERSATION_STATUSES) status!: ConversationStatusInput;
  @IsOptional() @IsISO8601() snoozedUntil?: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class UpdateConversationPriorityDto extends VersionDto {
  @IsInt() @Min(0) @Max(MAX_CONVERSATION_PRIORITY) priority!: number;
}

export class SendHumanMessageDto {
  @IsString() @MinLength(1) @MaxLength(MAX_HUMAN_TEXT_LENGTH) body!: string;
  @IsUUID() idempotencyKey!: string;
}

export class CreateNoteDto {
  @IsString() @MinLength(1) @MaxLength(MAX_NOTE_LENGTH) body!: string;
}

export class LinkContextDto {
  @IsUUID() convocationId!: string;
}

export class ResumeAutomationDto extends VersionDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  convocationIds!: string[];
}

export class MarkReadDto {
  @IsOptional() @IsUUID() lastReadMessageId?: string;
}

export class ContactOptOutDto {
  @IsBoolean() optedOut!: boolean;
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class CreateTeamDto {
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsOptional() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @MaxLength(60) slug?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class UpdateTeamDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class AddTeamMemberDto {
  @IsUUID() userId!: string;
  @IsIn(['AGENT', 'SUPERVISOR']) role!: 'AGENT' | 'SUPERVISOR';
}
