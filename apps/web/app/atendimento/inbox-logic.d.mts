// Tipos de inbox-logic.mjs (o web usa allowJs: false; este arquivo é a fonte de tipos para o TSX).

export type HumanReplyBlockReason =
  | 'NO_ELIGIBLE_INBOUND'
  | 'WINDOW_EXPIRED'
  | 'CONTACT_OPTED_OUT'
  | 'CONTACT_BLOCKED'
  | 'CONVERSATION_RESOLVED'
  | 'NOT_ASSIGNEE';

export type InboundIneligibilityReason =
  | 'NO_CONTEXT'
  | 'CONTEXT_NOT_FOUND'
  | 'CONTEXT_NOT_CAMPAIGN_TEMPLATE'
  | 'RECIPIENT_MISMATCH'
  | 'SENDER_MISMATCH'
  | 'TEMPLATE_NOT_SUBMITTED';

export type InboxView =
  | 'unassigned'
  | 'mine'
  | 'team'
  | 'waiting_contact'
  | 'snoozed'
  | 'resolved'
  | 'all';
export type StatusTone = 'info' | 'success' | 'warning' | 'danger';

export interface ReplyPolicyLike {
  allowed: boolean;
  reasons: string[];
  windowExpiresAt: string | null;
}

export interface ComposerState {
  enabled: boolean;
  reasons: string[];
  windowExpiresAt: string | null;
  remainingMs: number | null;
}

export interface ConversationFilters {
  view?: string;
  q?: string;
  teamId?: string;
  assigneeId?: string;
  status?: string;
  priority?: number | string | null;
  from?: string;
  to?: string;
  cursor?: string | null;
  limit?: number;
}

export interface InboxStreamEvent {
  id?: string | number | null;
  type: string;
  conversationId: string;
  entityId?: string | null;
}

export interface InboxStreamState {
  lastEventId: string | null;
  refreshList: boolean;
  affectedConversationIds: string[];
  refreshSelected: boolean;
  refreshSelectedTimeline: boolean;
  announcement: string | null;
}

export interface SendAttempt {
  body: string;
  idempotencyKey: string;
}

export interface UiPermissions {
  claim: boolean;
  assign: boolean;
  transfer: boolean;
  changeStatus: boolean;
  reopen: boolean;
  priority: boolean;
  note: boolean;
  linkContext: boolean;
  resumeAutomation: boolean;
  optOut: boolean;
}

export const MAX_HUMAN_TEXT_LENGTH: number;
export const MAX_NOTE_LENGTH: number;
export const HUMAN_REPLY_BLOCK_LABELS: Readonly<Record<HumanReplyBlockReason, string>>;
export const INBOUND_INELIGIBILITY_LABELS: Readonly<Record<InboundIneligibilityReason, string>>;
export const CONVERSATION_STATUS_LABELS: Readonly<
  Record<'OPEN' | 'WAITING_CONTACT' | 'SNOOZED' | 'RESOLVED', string>
>;
export const PRIORITY_OPTIONS: ReadonlyArray<{ value: number; label: string }>;
export const INBOX_VIEWS: ReadonlyArray<{ value: InboxView; label: string }>;
export const ACTIVITY_LABELS: Readonly<Record<string, string>>;

export function messageStatusInfo(status: string): {
  label: string;
  tone: StatusTone;
  description: string;
};
export function activityLabel(type: string): string;
export function conversationStatusLabel(status: string): string;
export function priorityLabel(priority: number): string;
export function blockReasonLabel(reason: string): string;
export function ineligibilityLabel(reason: string | null | undefined): string;
export function formatRemaining(ms: number): string;
export function composerState(
  policy: ReplyPolicyLike | null | undefined,
  now?: number,
): ComposerState;
export function normalizeSearch(raw: string | null | undefined): string;
export function buildConversationQuery(filters: ConversationFilters): string;
export function timelineKey(item: { kind: string; id: string }): string;
export function mergeTimeline<T extends { kind: string; id: string; createdAt: string }>(
  existing: T[],
  incoming: T[],
): T[];
export function appendConversationPage<T extends { id: string }>(existing: T[], page: T[]): T[];
export function mergeListHead<T extends { id: string }>(
  existing: T[],
  head: { items: T[]; nextCursor: string | null },
  affectedIds?: Iterable<string>,
): T[];
export function initialStreamState(): InboxStreamState;
export function reduceInboxEvent(
  state: InboxStreamState,
  event: InboxStreamEvent,
  selectedConversationId: string | null,
): InboxStreamState;
export function clearStreamPending(state: InboxStreamState): InboxStreamState;
export function parseInboxEvent(
  data: string,
  lastEventId?: string,
): { id: string | null; type: string; conversationId: string; entityId: string | null } | null;
export function streamUrl(apiBase: string, cursor: string | null): string;
export function prepareSend(
  pending: SendAttempt | null,
  body: string,
  newKey: () => string,
): SendAttempt;
export function pendingAfterSend(
  attempt: SendAttempt,
  httpStatus: number | null,
): SendAttempt | null;
export function uiPermissions(
  me: { userId: string; globalRole: string; teams: { id: string; role: string }[] } | null,
  target: { teamId: string | null; assigneeId: string | null },
): UiPermissions;
export function campaignRefLabel(
  campaign:
    | {
        stage?: string | null;
        attemptNumber?: number | null;
        convocationId?: string | null;
        patientName?: string | null;
      }
    | null
    | undefined,
  linkedConvocationIds: Iterable<string>,
): { title: string; patient: string | null; linked: boolean };
export function isSearchInvalid(raw: string | null | undefined): boolean;
export function activityDetail(type: string, metadata: unknown): string;
export function timelineItemFromSent<T extends { id: string; kind: string; createdAt: string }>(
  message: T,
): Omit<T, 'kind'> & { kind: 'message'; messageKind: T['kind'] };
