import { MAX_HUMAN_TEXT_LENGTH, monotonicMax, type InboundEligibility } from '@confirma/domain';
import { asRecord, inboundContent, stringValue, type JsonRecord } from '../webhook-events.js';

/** Dados do inbound extraídos do envelope normalizado (contrato §3). Sem coordenadas. */
export interface InboundTimelineData {
  waMessageId: string | null;
  waId: string | null;
  profileName: string | null;
  phoneNumberId: string | null;
  contextWaMessageId: string | null;
  contentType: string;
  body: string | null;
  media: { providerMediaId: string; declaredMimeType: string | null } | null;
}

export interface InboundFallbacks {
  /** Colunas `message_events.phone_number_id` / `wa_id` preenchidas pela API. */
  eventPhoneNumberId?: string | null;
  eventWaId?: string | null;
  /** META_WHATSAPP_PHONE_NUMBER_ID para eventos legados sem phoneNumberId. */
  legacyPhoneNumberId?: string | null;
}

const CONTENT_TYPE_PATTERN = /^[a-z_]{1,32}$/;

export function inboundTimelineData(
  envelope: JsonRecord,
  fallbacks: InboundFallbacks = {},
): InboundTimelineData {
  const payload = asRecord(envelope.payload);
  const content = asRecord(payload.payload);
  const media = asRecord(content.media);
  const contentType = inboundContentType(payload, content);
  const text = stringValue(content.text) ?? stringValue(content.title);
  const mediaId = stringValue(media.id);
  return {
    waMessageId: stringValue(payload.id),
    waId:
      normalizeWaId(stringValue(envelope.waId)) ??
      normalizeWaId(fallbacks.eventWaId ?? null) ??
      inboundContent(envelope).source,
    profileName: stringValue(envelope.profileName)?.slice(0, 120) ?? null,
    phoneNumberId:
      stringValue(envelope.phoneNumberId) ??
      stringValue(fallbacks.eventPhoneNumberId) ??
      stringValue(fallbacks.legacyPhoneNumberId) ??
      null,
    contextWaMessageId: stringValue(asRecord(payload.context).id),
    contentType,
    body: contentType === 'location' || !text ? null : text.slice(0, MAX_HUMAN_TEXT_LENGTH),
    media: mediaId
      ? {
          providerMediaId: mediaId,
          declaredMimeType: stringValue(media.mimeType)?.slice(0, 120) ?? null,
        }
      : null,
  };
}

function inboundContentType(payload: JsonRecord, content: JsonRecord): string {
  const inner = stringValue(content.type)?.toLowerCase();
  const outer = stringValue(payload.type)?.toLowerCase();
  const value = inner ?? outer ?? 'unknown';
  return CONTENT_TYPE_PATTERN.test(value) ? value : 'unknown';
}

function normalizeWaId(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}

/** Campos de elegibilidade gravados no inbound (resultado de `evaluateInboundEligibility`). */
export function eligibilityFields(
  result: InboundEligibility,
  referencedMessageId: string | null,
): {
  replyEligibility: 'ELIGIBLE_TEMPLATE_REPLY' | 'NOT_ELIGIBLE';
  eligibilityReason: string;
  repliedCampaignMessageId: string | null;
} {
  return result.eligible
    ? {
        replyEligibility: 'ELIGIBLE_TEMPLATE_REPLY',
        eligibilityReason: result.reason,
        repliedCampaignMessageId: referencedMessageId,
      }
    : {
        replyEligibility: 'NOT_ELIGIBLE',
        eligibilityReason: result.reason,
        repliedCampaignMessageId: null,
      };
}

export interface ConversationInboundState {
  status: string;
  lastInboundAt: Date | null;
  lastEligibleInboundAt: Date | null;
  lastActivityAt: Date;
}

/**
 * Atualização da conversa por inbound: carimbos só avançam (webhook atrasado não reduz a
 * janela) e WAITING_CONTACT/SNOOZED voltam para OPEN. A janela só é aberta por inbound elegível.
 */
export function conversationInboundPatch(
  current: ConversationInboundState,
  at: Date,
  eligible: boolean,
): {
  lastInboundAt: Date;
  lastActivityAt: Date;
  lastEligibleInboundAt?: Date;
  status?: 'OPEN';
  snoozedUntil?: null;
} {
  const reopen = current.status === 'WAITING_CONTACT' || current.status === 'SNOOZED';
  return {
    lastInboundAt: monotonicMax(current.lastInboundAt, at),
    lastActivityAt: monotonicMax(current.lastActivityAt, at),
    ...(eligible ? { lastEligibleInboundAt: monotonicMax(current.lastEligibleInboundAt, at) } : {}),
    ...(reopen ? { status: 'OPEN' as const, snoozedUntil: null } : {}),
  };
}
