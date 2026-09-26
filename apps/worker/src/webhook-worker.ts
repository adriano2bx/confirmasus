import { Prisma, prisma, type MessageStatus } from '@confirma/database';
import type { Job } from 'bullmq';
import type { ProcessWebhookJob } from '@confirma/queue';
import {
  asRecord,
  eventDate,
  eventType,
  inboundContent,
  nextMessageStatus,
  providerMessageId,
  providerWhatsAppId,
  stringValue,
  type JsonRecord,
} from './webhook-events.js';
import {
  AUTOMATIC_REPLY_TEMPLATE_ID,
  automaticReplyDefinition,
  automaticReplyEnabled,
} from './automatic-reply.js';

const TERMINAL_CONVOCATION_STATUSES = ['CONFIRMED', 'CANCELLED', 'FINISHED_NO_RESPONSE'];

export async function processWebhook(job: Job<ProcessWebhookJob>): Promise<void> {
  const event = await prisma.messageEvent.findUniqueOrThrow({
    where: { id: job.data.messageEventId },
  });
  if (event.processingStatus === 'PROCESSED' || event.processingStatus === 'IGNORED') return;

  const envelope = asRecord(event.payload);
  const type = eventType(envelope);
  const payload = asRecord(envelope.payload);
  const messageId =
    providerMessageId(envelope) ?? (type === 'message' ? null : event.providerMessageId);
  const occurredAt = eventDate(envelope, event.receivedAt);

  try {
    if (type === 'message-event') {
      await processMessageEvent(event.id, envelope, payload, messageId, occurredAt);
    } else if (type === 'message') {
      await processInboundMessage(event.id, envelope, messageId, occurredAt);
    } else if (type === 'billing-event' || type === 'billing') {
      await processBillingEvent(event.id, payload, messageId, occurredAt);
    } else {
      await mark(event.id, 'IGNORED');
    }
  } catch (error) {
    await prisma.messageEvent.update({
      where: { id: event.id },
      data: {
        processingStatus: 'FAILED',
        processingError: error instanceof Error ? error.message.slice(0, 500) : 'Erro desconhecido',
      },
    });
    throw error;
  }
}

async function processBillingEvent(
  eventId: string,
  payload: JsonRecord,
  messageProviderId: string | null,
  occurredAt: Date,
) {
  if (!messageProviderId) return mark(eventId, 'IGNORED');
  const message = await findMessage(messageProviderId, stringValue(payload.id));
  if (!message) throw new Error(`Mensagem ${messageProviderId} ainda não foi persistida`);
  const details = asRecord(payload.payload);
  const cost = decimalValue(details.cost) ?? decimalValue(payload.cost);
  const currency = stringValue(details.currency) ?? stringValue(payload.currency);
  const pricing = asRecord(details.pricing);
  const category = stringValue(details.category) ?? stringValue(pricing.category);
  const billingProviderEventId = stringValue(payload.providerEventId) ?? stringValue(payload.id);
  if (!billingProviderEventId) return mark(eventId, 'IGNORED');

  await prisma.$transaction(async (transaction) => {
    await transaction.billingEvent.upsert({
      where: { providerEventId: billingProviderEventId },
      update: {},
      create: {
        messageId: message.id,
        providerMessageId: messageProviderId,
        providerEventId: billingProviderEventId,
        billable: typeof details.billable === 'boolean' ? details.billable : cost !== null,
        category,
        status: stringValue(details.status),
        cost,
        currency,
        billingAt: occurredAt,
        metadata: {
          pricingModel: stringValue(pricing.pricing_model),
          raw: pricing as Prisma.InputJsonObject,
        },
      },
    });
    await completeEvent(transaction, eventId, message.id);
  });
}

async function processMessageEvent(
  eventId: string,
  envelope: JsonRecord,
  payload: JsonRecord,
  messageProviderId: string | null,
  occurredAt: Date,
) {
  const statusType = stringValue(payload.type)?.toLowerCase();
  const whatsAppId = providerWhatsAppId(envelope);
  if (!messageProviderId || !statusType) return mark(eventId, 'IGNORED');
  const message = await findMessage(messageProviderId, whatsAppId);
  if (!message) throw new Error(`Mensagem ${messageProviderId} ainda não foi persistida`);
  const update = statusUpdate(statusType, occurredAt, asRecord(payload.payload));
  if (!update) return mark(eventId, 'IGNORED', message.id);

  await prisma.$transaction(async (transaction) => {
    await lockRow(transaction, 'messages', message.id);
    const current = await transaction.message.findUniqueOrThrow({ where: { id: message.id } });
    const status = nextMessageStatus(current.status, update.status) as MessageStatus;
    await transaction.message.update({
      where: { id: message.id },
      data: {
        status,
        ...(update.status === 'SUBMITTED' && whatsAppId ? { providerWhatsAppId: whatsAppId } : {}),
        ...(update.status === 'SENT' ? { sentAt: current.sentAt ?? occurredAt } : {}),
        ...(update.status === 'DELIVERED'
          ? { deliveredAt: current.deliveredAt ?? occurredAt }
          : {}),
        ...(update.status === 'READ'
          ? {
              readAt: current.readAt ?? occurredAt,
              deliveredAt: current.deliveredAt ?? occurredAt,
            }
          : {}),
        ...(update.status === 'FAILED' && status === 'FAILED'
          ? {
              failedAt: current.failedAt ?? occurredAt,
              failureCode: update.failureCode,
              failureReason: update.failureReason,
            }
          : {}),
      },
    });
    await completeEvent(transaction, eventId, message.id);
  });
}

async function processInboundMessage(
  eventId: string,
  envelope: JsonRecord,
  messageProviderId: string | null,
  occurredAt: Date,
) {
  const content = inboundContent(envelope);
  const message = await findInboundMessage(messageProviderId, content.source);
  if (!message) {
    if (messageProviderId)
      throw new Error(`Mensagem ${messageProviderId} ainda não foi persistida`);
    return mark(eventId, 'IGNORED');
  }

  await prisma.$transaction(async (transaction) => {
    await lockRow(transaction, 'convocations', message.convocationId);
    const convocation = await transaction.convocation.findUniqueOrThrow({
      where: { id: message.convocationId },
    });
    const terminal = TERMINAL_CONVOCATION_STATUSES.includes(convocation.status);
    const responseAction = content.isButton
      ? content.action === 'CONFIRM'
        ? 'CONFIRM'
        : content.action === 'CANCEL'
          ? 'CANCEL'
          : 'UNKNOWN'
      : 'FREE_TEXT';

    await transaction.messageResponse.create({
      data: {
        messageId: message.id,
        convocationId: convocation.id,
        action: responseAction,
        sourceStage: message.stage,
        rawText: content.text.slice(0, 1_000),
        receivedAt: occurredAt,
      },
    });

    await transaction.auditLog.create({
      data: {
        eventType: 'PATIENT_RESPONSE_RECEIVED',
        entityType: 'convocation',
        entityId: convocation.id,
        metadata: {
          action: responseAction,
          sourceStage: message.stage,
          messageId: message.id,
          matchedBy: messageProviderId ? 'PROVIDER_MESSAGE_ID' : 'SOURCE_PHONE',
        },
      },
    });

    if (!terminal && (content.action === 'CONFIRM' || content.action === 'CANCEL')) {
      await transaction.convocation.update({
        where: { id: convocation.id },
        data:
          content.action === 'CONFIRM'
            ? {
                status: 'CONFIRMED',
                confirmedAt: occurredAt,
                nextActionAt: null,
                stage: 'FINISHED',
                version: { increment: 1 },
              }
            : {
                status: 'CANCELLED',
                cancelledAt: occurredAt,
                nextActionAt: null,
                stage: 'FINISHED',
                version: { increment: 1 },
              },
      });
      await transaction.auditLog.create({
        data: {
          eventType: content.action === 'CONFIRM' ? 'PATIENT_CONFIRMED' : 'PATIENT_CANCELLED',
          entityType: 'convocation',
          entityId: convocation.id,
          metadata: { sourceStage: message.stage, messageId: message.id },
        },
      });
      if (automaticReplyEnabled()) {
        const definition = automaticReplyDefinition(content.action);
        await transaction.message.upsert({
          where: { idempotencyKey: `automatic-reply:${convocation.id}:${content.action}` },
          update: {},
          create: {
            convocationId: convocation.id,
            stage: 'FINISHED',
            attemptNumber: definition.attemptNumber,
            templateName: definition.templateName,
            templateId: AUTOMATIC_REPLY_TEMPLATE_ID,
            phone: message.phone,
            status: 'QUEUED',
            idempotencyKey: `automatic-reply:${convocation.id}:${content.action}`,
          },
        });
      }
      if (content.action === 'CONFIRM' && process.env.HANDOFF_MODE === 'LIVE') {
        await transaction.handoffEvent.upsert({
          where: { convocationId: convocation.id },
          update: {},
          create: {
            convocationId: convocation.id,
            idempotencyKey: `handoff:${convocation.id}`,
            payload: {
              trigger: 'PATIENT_CONFIRMED',
              sourceStage: message.stage,
              confirmedAt: occurredAt.toISOString(),
            },
          },
        });
      }
    }
    await completeEvent(transaction, eventId, message.id);
  });
}

async function findInboundMessage(messageProviderId: string | null, source: string | null) {
  if (messageProviderId) {
    return findMessage(messageProviderId, null);
  }
  if (!source) return null;
  return prisma.message.findFirst({
    where: { phone: source },
    orderBy: { createdAt: 'desc' },
  });
}

async function findMessage(messageProviderId: string, whatsAppId: string | null) {
  return prisma.message.findFirst({
    where: {
      OR: [
        { providerMessageId: messageProviderId },
        { providerWhatsAppId: messageProviderId },
        ...(whatsAppId
          ? [{ providerMessageId: whatsAppId }, { providerWhatsAppId: whatsAppId }]
          : []),
      ],
    },
  });
}

function statusUpdate(status: string, at: Date, details: JsonRecord) {
  if (status === 'enqueued') return { status: 'SUBMITTED' as const, at };
  if (status === 'sent') return { status: 'SENT' as const, at };
  if (status === 'delivered') return { status: 'DELIVERED' as const, at };
  if (status === 'read') return { status: 'READ' as const, at };
  if (status === 'failed') {
    return {
      status: 'FAILED' as const,
      at,
      failureCode: textValue(details.code) ?? 'META_FAILED',
      failureReason: textValue(details.reason) ?? 'Falha reportada pelo provedor',
    };
  }
  return null;
}

async function lockRow(
  transaction: Prisma.TransactionClient,
  table: 'messages' | 'convocations',
  id: string,
) {
  if (table === 'messages') {
    await transaction.$queryRaw(
      Prisma.sql`SELECT id FROM messages WHERE id = ${id}::uuid FOR UPDATE`,
    );
  } else {
    await transaction.$queryRaw(
      Prisma.sql`SELECT id FROM convocations WHERE id = ${id}::uuid FOR UPDATE`,
    );
  }
}

async function completeEvent(
  transaction: Prisma.TransactionClient,
  eventId: string,
  messageId: string,
) {
  await transaction.messageEvent.update({
    where: { id: eventId },
    data: { messageId, processingStatus: 'PROCESSED', processedAt: new Date() },
  });
}

async function mark(eventId: string, status: 'PROCESSED' | 'IGNORED', messageId?: string) {
  await prisma.messageEvent.update({
    where: { id: eventId },
    data: {
      ...(messageId ? { messageId } : {}),
      processingStatus: status,
      processedAt: new Date(),
    },
  });
}

function decimalValue(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)
      ? value
      : null;
}

function textValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return stringValue(value);
}
