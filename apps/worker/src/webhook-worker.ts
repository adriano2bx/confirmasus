import {
  Prisma,
  prisma,
  withActiveConversationRetry,
  type ConvocationStatus,
  type MessageEvent,
  type MessageStatus,
} from '@confirma/database';
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
import { inboundTimelineData } from './inbox/inbound.js';
import {
  shouldWaitForContext,
  webhookFailureUpdate,
  WebhookRetryableError,
} from './inbox/retry.js';
import {
  applyConversationMessageStatus,
  findOutboundConversationMessage,
  statusUpdate,
} from './inbox/status.js';
import {
  finalizeInboundTimeline,
  isDuplicateInbound,
  persistInboundTimeline,
  timelineTarget,
} from './inbox/timeline.js';

const TERMINAL_CONVOCATION_STATUSES: ConvocationStatus[] = [
  'CONFIRMED',
  'CANCELLED',
  'FINISHED_NO_RESPONSE',
  'SEND_ERROR',
];

export async function processWebhook(job: Job<ProcessWebhookJob>): Promise<void> {
  const event = await prisma.messageEvent.findUniqueOrThrow({
    where: { id: job.data.messageEventId },
  });
  if (['PROCESSED', 'IGNORED', 'DEAD_LETTER'].includes(event.processingStatus)) return;

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
      await processInboundMessage(event, envelope, messageId, occurredAt);
    } else if (type === 'billing-event' || type === 'billing') {
      await processBillingEvent(event.id, payload, messageId, occurredAt);
    } else {
      await mark(event.id, 'IGNORED');
    }
  } catch (error) {
    // Erro minimizado (sem conteúdo/telefone); DEAD_LETTER ao atingir WEBHOOK_MAX_ATTEMPTS.
    await prisma.messageEvent.update({
      where: { id: event.id },
      data: webhookFailureUpdate(event, error),
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
  if (!message) {
    // Billing de mensagem humana (texto de sessão) fica fora de billing_events neste corte.
    if (await findOutboundConversationMessage(messageProviderId, payload.bizOpaque)) {
      return mark(eventId, 'IGNORED');
    }
    throw new WebhookRetryableError('MENSAGEM_NAO_PERSISTIDA');
  }
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
  const update = statusUpdate(statusType, occurredAt, asRecord(payload.payload));
  if (!message) {
    return processConversationMessageEvent(eventId, payload, messageProviderId, update);
  }
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
    if (update.status === 'FAILED' && status === 'FAILED') {
      const stopped = await transaction.convocation.updateMany({
        where: {
          id: message.convocationId,
          status: { notIn: TERMINAL_CONVOCATION_STATUSES },
        },
        data: { status: 'SEND_ERROR', nextActionAt: null },
      });
      if (stopped.count > 0) {
        await transaction.auditLog.create({
          data: {
            eventType: 'CONVOCATION_SEND_FAILED',
            entityType: 'convocation',
            entityId: message.convocationId,
            metadata: {
              messageId: message.id,
              failureCode: update.failureCode,
              failureReason: update.failureReason,
            },
          },
        });
      }
    }
    await completeEvent(transaction, eventId, message.id);
  });
}

async function processConversationMessageEvent(
  eventId: string,
  payload: JsonRecord,
  waMessageId: string,
  update: ReturnType<typeof statusUpdate>,
) {
  const target = await findOutboundConversationMessage(waMessageId, payload.bizOpaque);
  // Status antes do WAMID ser conhecido: retry com backoff e reconciliação posterior.
  if (!target) throw new WebhookRetryableError('MENSAGEM_NAO_PERSISTIDA');
  if (!update) return mark(eventId, 'IGNORED');
  await prisma.$transaction(async (transaction) => {
    const applied = await applyConversationMessageStatus(
      transaction,
      target.id,
      update,
      waMessageId,
    );
    await completeEvent(transaction, eventId, null, applied ? 'PROCESSED' : 'IGNORED');
  });
}

async function processInboundMessage(
  event: MessageEvent,
  envelope: JsonRecord,
  messageProviderId: string | null,
  occurredAt: Date,
) {
  const eventId = event.id;
  const content = inboundContent(envelope);
  const legacyPhoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID ?? null;
  // Sem phone_number_id conhecido (nem no envelope, nem no evento, nem no ambiente), o inbound
  // segue só o fluxo legado da campanha: não há conversa para criar.
  const target = timelineTarget(
    inboundTimelineData(envelope, {
      eventPhoneNumberId: event.phoneNumberId,
      eventWaId: event.waId,
      legacyPhoneNumberId,
    }),
  );
  const message = await findInboundMessage(messageProviderId, content.source);
  if (!message && messageProviderId) {
    // context.id de mensagem humana do inbox não é campanha: segue só para a timeline.
    const repliedToInbox = await prisma.conversationMessage.findUnique({
      where: { waMessageId: messageProviderId },
      select: { id: true },
    });
    // Template ainda não persistido: retry curto (WEBHOOK_CONTEXT_WAIT_ATTEMPTS). Esgotada a
    // espera, o inbound entra na timeline uma vez como NOT_ELIGIBLE/CONTEXT_NOT_FOUND (gate
    // fechado; correlação tardia nunca torna elegível) e segue como inbound sem campanha: com
    // context.id o fallback legado por telefone nunca se aplicou, então não há MessageResponse.
    // Sem phone_number_id conhecido não há timeline e o evento fica IGNORED.
    if (!repliedToInbox && shouldWaitForContext(event.attempts)) {
      throw new WebhookRetryableError('MENSAGEM_DE_CONTEXTO_NAO_PERSISTIDA');
    }
  }
  if (!message && !target) return mark(eventId, 'IGNORED');

  // Timeline e campanha na mesma transação: retry nunca duplica um sem o outro.
  await withActiveConversationRetry(prisma, async (transaction) => {
    if (target && (await isDuplicateInbound(transaction, eventId, target.waMessageId))) {
      await completeEvent(transaction, eventId, null);
      return;
    }
    const persisted = target
      ? await persistInboundTimeline(transaction, {
          eventId,
          target,
          occurredAt,
          legacyPhoneNumberId,
        })
      : null;
    if (message) {
      await recordCampaignResponse(transaction, message, content, messageProviderId, occurredAt);
    }
    if (persisted) await finalizeInboundTimeline(transaction, persisted);
    await completeEvent(transaction, eventId, message?.id ?? null);
  });
}

async function recordCampaignResponse(
  transaction: Prisma.TransactionClient,
  message: CampaignMessage,
  content: ReturnType<typeof inboundContent>,
  messageProviderId: string | null,
  occurredAt: Date,
) {
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
}

type CampaignMessage = NonNullable<Awaited<ReturnType<typeof findMessage>>>;

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
  messageId: string | null,
  status: 'PROCESSED' | 'IGNORED' = 'PROCESSED',
) {
  await transaction.messageEvent.update({
    where: { id: eventId },
    data: {
      ...(messageId ? { messageId } : {}),
      processingStatus: status,
      processedAt: new Date(),
    },
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
