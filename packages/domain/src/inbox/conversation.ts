export type ConversationStatusValue = 'OPEN' | 'WAITING_CONTACT' | 'SNOOZED' | 'RESOLVED';

const TRANSITIONS: Record<ConversationStatusValue, readonly ConversationStatusValue[]> = {
  OPEN: ['WAITING_CONTACT', 'SNOOZED', 'RESOLVED'],
  WAITING_CONTACT: ['OPEN', 'SNOOZED', 'RESOLVED'],
  SNOOZED: ['OPEN', 'WAITING_CONTACT', 'RESOLVED'],
  RESOLVED: ['OPEN'],
};

export function canTransition(from: ConversationStatusValue, to: ConversationStatusValue): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Protocolo sem PII: ATD-AAAA-NNNNNNNN a partir do valor da sequência PostgreSQL. */
export function formatProtocol(sequenceValue: bigint | number, at: Date = new Date()): string {
  const value = BigInt(sequenceValue);
  if (value <= 0n) throw new Error('Sequência de protocolo inválida');
  return `ATD-${at.getUTCFullYear()}-${value.toString().padStart(8, '0')}`;
}

export const PROTOCOL_PATTERN = /^ATD-\d{4}-\d{8,}$/;

/** Tipos de evento do feed SSE (`inbox_events.type`). Payload SSE = { id, type, conversationId, entityId }. */
export const INBOX_EVENT_TYPES = [
  'conversation.created',
  'conversation.updated',
  'message.created',
  'message.updated',
  'note.created',
  'activity.created',
] as const;
export type InboxEventType = (typeof INBOX_EVENT_TYPES)[number];

/** Estados de mensagem de saída: não regredir por evento atrasado. UNKNOWN só sai por reconciliação. */
const OUTBOUND_RANK: Record<string, number> = {
  QUEUED: 0,
  PROCESSING: 1,
  UNKNOWN: 2,
  SUBMITTED: 3,
  SENT: 4,
  DELIVERED: 5,
  READ: 6,
};

export function nextOutboundStatus(current: string, incoming: string): string {
  if (current === 'BLOCKED') return current;
  if (incoming === 'FAILED') return ['DELIVERED', 'READ'].includes(current) ? current : 'FAILED';
  if (current === 'FAILED') return current;
  return (OUTBOUND_RANK[incoming] ?? -1) > (OUTBOUND_RANK[current] ?? -1) ? incoming : current;
}

export const MAX_HUMAN_TEXT_LENGTH = 4_096;
export const MAX_NOTE_LENGTH = 4_000;
