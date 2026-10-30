import { createHash } from 'node:crypto';
import { normalizeButtonAction, type NormalizedResponseAction } from '@confirma/domain';

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function eventType(envelope: JsonRecord): string | null {
  return stringValue(envelope.type)?.toLowerCase() ?? null;
}

export function providerMessageId(envelope: JsonRecord): string | null {
  const type = eventType(envelope);
  const payload = asRecord(envelope.payload);
  if (type === 'message') return stringValue(asRecord(payload.context).id);
  return type === 'message-event' || type === 'billing-event' || type === 'billing'
    ? stringValue(payload.id)
    : null;
}

export function providerWhatsAppId(envelope: JsonRecord): string | null {
  const payload = asRecord(envelope.payload);
  return stringValue(payload.id);
}

export function deduplicationKey(envelope: JsonRecord): string {
  const type = eventType(envelope) ?? 'unknown';
  const payload = asRecord(envelope.payload);
  const details = asRecord(payload.payload);
  const subtype = stringValue(payload.type)?.toLowerCase() ?? '';
  const identity = stringValue(payload.id);
  const eventTime = numberOrString(details.ts) ?? numberOrString(payload.timestamp);
  const stable = identity ? { type, subtype, identity, eventTime } : { type, subtype, payload };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function eventDate(envelope: JsonRecord, fallback = new Date()): Date {
  const payload = asRecord(envelope.payload);
  const details = asRecord(payload.payload);
  const detailTimestamp = timestampDate(details.ts);
  if (detailTimestamp) return detailTimestamp;
  return timestampDate(envelope.timestamp) ?? timestampDate(payload.timestamp) ?? fallback;
}

export function inboundContent(envelope: JsonRecord): {
  text: string;
  isButton: boolean;
  action: NormalizedResponseAction;
  source: string | null;
} {
  const payload = asRecord(envelope.payload);
  const content = asRecord(payload.payload);
  const text = stringValue(content.text) ?? stringValue(content.title) ?? '';
  const outerType = stringValue(payload.type)?.toLowerCase();
  const innerType = stringValue(content.type)?.toLowerCase();
  const isButton = innerType === 'button' || outerType === 'button_reply';
  const buttonPayload = stringValue(content.buttonPayload)?.toUpperCase();
  return {
    text,
    isButton,
    action: isButton
      ? buttonPayload === 'CONFIRM' || buttonPayload === 'CANCEL'
        ? buttonPayload
        : normalizeButtonAction(text)
      : 'UNKNOWN',
    source: normalizePhone(
      stringValue(payload.source) ?? stringValue(asRecord(payload.sender).phone),
    ),
  };
}

export function nextMessageStatus(current: string, incoming: string): string {
  if (incoming === 'FAILED') {
    return ['DELIVERED', 'READ'].includes(current) ? current : 'FAILED';
  }
  if (current === 'FAILED') return current;
  const rank: Record<string, number> = {
    QUEUED: 0,
    PROCESSING: 1,
    SUBMITTED: 2,
    SENT: 3,
    DELIVERED: 4,
    READ: 5,
  };
  return (rank[incoming] ?? -1) > (rank[current] ?? -1) ? incoming : current;
}

function timestampDate(value: unknown): Date | null {
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function numberOrString(value: unknown): number | string | null {
  return typeof value === 'number' || (typeof value === 'string' && value.length > 0)
    ? value
    : null;
}

function normalizePhone(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}
