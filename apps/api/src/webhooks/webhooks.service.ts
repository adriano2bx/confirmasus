import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Prisma, prisma } from '@confirma/database';
import { webhookJobId, type ProcessWebhookJob } from '@confirma/queue';
import type { Queue } from 'bullmq';
import {
  WEBHOOK_JOB_OPTIONS,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_MAX_EVENTS,
  WEBHOOK_PUBLISH_WAIT_MS,
  WEBHOOK_QUEUE,
} from './webhooks.constants.js';

type JsonRecord = Record<string, unknown>;

const MEDIA_TYPES = new Set(['image', 'document', 'audio', 'video', 'sticker']);
const KNOWN_INBOUND_TYPES = new Set(['text', 'button', 'interactive', 'location', ...MEDIA_TYPES]);
const PROFILE_NAME_MAX_LENGTH = 120;

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(@Inject(WEBHOOK_QUEUE) private readonly queue: Queue<ProcessWebhookJob>) {}

  verify(mode?: string, token?: string, challenge?: string): string {
    if (
      mode !== 'subscribe' ||
      !token ||
      !challenge ||
      !safeEqual(token, process.env.META_WEBHOOK_VERIFY_TOKEN ?? '')
    ) {
      throw new ForbiddenException('Verificação do webhook Meta inválida');
    }
    return challenge;
  }

  /**
   * Persiste o lote inteiro numa única transação e só retorna (2xx) após o commit.
   * Falha de banco propaga (5xx, a Meta reenvia). A publicação no BullMQ é best-effort:
   * eventos não publicados ficam PENDING e o despachante de outbox do worker os entrega.
   */
  async receive(value: unknown, signature: string | undefined, rawBody: Buffer | undefined) {
    if (rawBody && rawBody.length > WEBHOOK_MAX_BODY_BYTES) {
      throw new PayloadTooLargeException('Notificação do webhook Meta excede o tamanho permitido');
    }
    this.verifySignature(signature, rawBody);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('Payload de webhook inválido');
    }
    const normalized = normalizeMetaEvents(value as JsonRecord);
    if (normalized.length > WEBHOOK_MAX_EVENTS) {
      throw new BadRequestException(
        'Lote do webhook Meta excede a quantidade permitida de eventos',
      );
    }
    const events = this.acceptedEvents(normalized);
    if (events.length === 0) return;

    const rows = new Map<string, Prisma.MessageEventCreateManyInput>();
    for (const event of events) {
      const row = messageEventRow(event);
      if (!rows.has(row.deduplicationKey)) rows.set(row.deduplicationKey, row);
    }
    const stored = await prisma.$transaction(async (transaction) => {
      await transaction.messageEvent.createMany({ data: [...rows.values()], skipDuplicates: true });
      return transaction.messageEvent.findMany({
        where: { deduplicationKey: { in: [...rows.keys()] } },
        select: { id: true, processingStatus: true },
      });
    });

    // Replays FAILED não são republicados aqui: o despachante respeita nextAttemptAt.
    const pending = stored
      .filter((event) => event.processingStatus === 'PENDING')
      .map((event) => event.id);
    if (pending.length > 0) await this.publishBestEffort(pending);
  }

  private acceptedEvents(events: JsonRecord[]): JsonRecord[] {
    const accepted = acceptedPhoneNumberIds();
    if (!accepted) return events;
    const kept = events.filter((event) => {
      const phoneNumberId = event.phoneNumberId;
      return typeof phoneNumberId === 'string' && accepted.has(phoneNumberId);
    });
    if (kept.length < events.length) {
      this.logger.warn(
        `Descartados ${events.length - kept.length} evento(s) de phone_number_id não aceito`,
      );
    }
    return kept;
  }

  private async publishBestEffort(eventIds: string[]) {
    let timer: NodeJS.Timeout | undefined;
    const publishing = this.publish(eventIds).catch((error: unknown) => {
      this.logger.warn(
        `Falha ao publicar ${eventIds.length} evento(s) do webhook no BullMQ; ficam para o despachante de outbox: ${errorName(error)}`,
      );
    });
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn(
          `Publicação de ${eventIds.length} evento(s) do webhook no BullMQ excedeu ${WEBHOOK_PUBLISH_WAIT_MS} ms`,
        );
        resolve();
      }, WEBHOOK_PUBLISH_WAIT_MS);
      timer.unref();
    });
    try {
      await Promise.race([publishing, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async publish(eventIds: string[]) {
    for (const messageEventId of eventIds) {
      await this.queue.add(
        'process-webhook',
        { messageEventId },
        { jobId: webhookJobId(messageEventId), ...WEBHOOK_JOB_OPTIONS },
      );
    }
  }

  private verifySignature(signature: string | undefined, rawBody: Buffer | undefined) {
    const appSecret = process.env.META_APP_SECRET;
    if (!appSecret || !signature || !rawBody) {
      throw new ForbiddenException('Assinatura do webhook Meta ausente');
    }
    const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    if (!safeEqual(signature, expected))
      throw new ForbiddenException('Assinatura do webhook inválida');
  }
}

/** Chave determinística de deduplicação (sem hash do payload inteiro). */
export function webhookDeduplicationKey(envelope: JsonRecord): string {
  const payload = record(envelope.payload);
  const id = String(payload.id ?? '');
  if (envelope.type === 'message') return `message:${id}`;
  if (envelope.type === 'message-event') {
    return `status:${id}:${String(payload.type ?? 'unknown')}:${String(envelope.timestamp ?? 'unknown')}`;
  }
  if (envelope.type === 'billing-event') {
    const details = record(payload.payload);
    return `billing:${id}:${String(details.status ?? 'unknown')}:${String(envelope.timestamp ?? 'unknown')}`;
  }
  throw new BadRequestException('Tipo de evento do webhook desconhecido');
}

export function messageEventRow(envelope: JsonRecord): Prisma.MessageEventCreateManyInput {
  const payload = record(envelope.payload);
  const identity = typeof payload.id === 'string' ? payload.id : null;
  const type = String(envelope.type ?? 'unknown');
  return {
    providerMessageId: identity,
    providerEventId: identity,
    eventType: type,
    deduplicationKey: webhookDeduplicationKey(envelope),
    phoneNumberId: stringOrNull(envelope.phoneNumberId),
    waId: type === 'message' ? stringOrNull(envelope.waId) : stringOrNull(payload.recipientId),
    payload: envelope as Prisma.InputJsonValue,
  };
}

export function normalizeMetaEvents(body: JsonRecord): JsonRecord[] {
  if (body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
    throw new BadRequestException('Evento recebido não é uma notificação WhatsApp da Meta');
  }
  const events: JsonRecord[] = [];
  let items = 0;
  for (const entryValue of body.entry) {
    const entry = record(entryValue);
    for (const changeValue of Array.isArray(entry.changes) ? entry.changes : []) {
      const change = record(changeValue);
      if (change.field !== 'messages') continue;
      const value = record(change.value);
      const phoneNumberId = stringOrUndefined(record(value.metadata).phone_number_id);
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      const messages = Array.isArray(value.messages) ? value.messages : [];
      items += statuses.length + messages.length;
      if (items > WEBHOOK_MAX_EVENTS) {
        throw new BadRequestException(
          'Lote do webhook Meta excede a quantidade permitida de eventos',
        );
      }
      for (const statusValue of statuses) {
        const status = record(statusValue);
        if (!stringOrUndefined(status.id) || !stringOrUndefined(status.status)) {
          throw new BadRequestException('Status do webhook Meta sem identificador');
        }
        const errors = Array.isArray(status.errors) ? record(status.errors[0]) : {};
        const pricing = record(status.pricing);
        events.push(
          compact({
            type: 'message-event',
            timestamp: status.timestamp,
            phoneNumberId,
            payload: {
              id: status.id,
              type: status.status,
              recipientId: status.recipient_id,
              bizOpaque: status.biz_opaque_callback_data,
              payload: {
                ts: status.timestamp,
                code: errors.code,
                reason: record(errors.error_data).details ?? errors.title ?? errors.message,
              },
            },
          }),
        );
        if (Object.keys(pricing).length > 0) {
          events.push(
            compact({
              type: 'billing-event',
              timestamp: status.timestamp,
              phoneNumberId,
              payload: {
                id: status.id,
                providerEventId: `${String(status.id ?? 'unknown')}:${String(status.status ?? 'unknown')}:${String(status.timestamp ?? 'unknown')}`,
                payload: {
                  status: status.status,
                  billable: pricing.billable,
                  category: pricing.category,
                  pricing_model: pricing.pricing_model,
                  pricing,
                },
              },
            }),
          );
        }
      }
      const contacts = (Array.isArray(value.contacts) ? value.contacts : []).map(record);
      for (const messageValue of messages) {
        const message = record(messageValue);
        if (!stringOrUndefined(message.id)) {
          throw new BadRequestException('Mensagem do webhook Meta sem identificador');
        }
        events.push(normalizeInboundMessage(message, contacts, phoneNumberId));
      }
    }
  }
  return events;
}

function normalizeInboundMessage(
  message: JsonRecord,
  contacts: JsonRecord[],
  phoneNumberId: string | undefined,
): JsonRecord {
  const from = stringOrUndefined(message.from);
  const contact = from ? contacts.find((item) => item.wa_id === from) : undefined;
  const waId = stringOrUndefined(contact?.wa_id) ?? from;
  const profileName = stringOrUndefined(record(contact?.profile).name)?.slice(
    0,
    PROFILE_NAME_MAX_LENGTH,
  );
  const rawType = stringOrUndefined(message.type);
  const knownType = rawType && KNOWN_INBOUND_TYPES.has(rawType) ? rawType : 'unknown';
  const context = record(message.context);
  const isButton = knownType === 'button' || knownType === 'interactive';

  let text = '';
  let buttonPayload: unknown;
  let media: JsonRecord | undefined;
  if (isButton) {
    const button = record(message.button);
    const interactive = record(message.interactive);
    const buttonReply = record(interactive.button_reply);
    const listReply = record(interactive.list_reply);
    text = String(
      button.text ?? buttonReply.title ?? buttonReply.id ?? listReply.title ?? listReply.id ?? '',
    );
    buttonPayload = button.payload ?? buttonReply.id;
  } else if (knownType === 'text') {
    text = String(record(message.text).body ?? '');
  } else if (MEDIA_TYPES.has(knownType)) {
    const content = record(message[knownType]);
    text = typeof content.caption === 'string' ? content.caption : '';
    media = {
      id: content.id,
      mimeType: content.mime_type,
      sha256: content.sha256,
      filename: content.filename,
    };
  }
  // location: somente o tipo, sem coordenadas, nome ou endereço (minimização).

  return compact({
    type: 'message',
    timestamp: message.timestamp,
    phoneNumberId,
    waId,
    profileName,
    payload: {
      id: message.id,
      source: from,
      context: { id: context.id },
      type: isButton ? 'button_reply' : knownType,
      payload: {
        type: isButton ? 'button' : knownType,
        text,
        title: text,
        buttonPayload,
        media,
      },
    },
  });
}

function acceptedPhoneNumberIds(): Set<string> | null {
  const ids = (process.env.META_ACCEPTED_PHONE_NUMBER_IDS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringOrNull(value: unknown): string | null {
  return stringOrUndefined(value) ?? null;
}

function compact(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [
        key,
        item && typeof item === 'object' && !Array.isArray(item) ? compact(item) : item,
      ]),
  );
}

function errorName(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message.slice(0, 200)}`
    : 'Erro desconhecido';
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
