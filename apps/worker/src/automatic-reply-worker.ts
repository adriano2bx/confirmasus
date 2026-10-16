import { randomUUID } from 'node:crypto';
import { prisma as defaultPrisma, type PrismaClient } from '@confirma/database';
import { QUEUES, type SendAutomaticReplyJob, type SendPermit } from '@confirma/queue';
import type { Job } from 'bullmq';
import { automaticReplyDefinition } from './automatic-reply.js';
import {
  SendPermitDeniedError,
  WhatsAppApiError,
  acquireMetaSendPermit,
  configuredPhoneNumberId,
  deferJobForSendPermit,
  sendMetaText,
} from './meta-whatsapp-client.js';

export interface AutomaticReplyDeps {
  prisma: PrismaClient;
  acquirePermit: (phoneNumberId: string, priority: 'human' | 'campaign') => Promise<SendPermit>;
  sendText: typeof sendMetaText;
  mode: () => string;
  /** Token do job BullMQ: permite adiar por limite de envio sem consumir tentativa. */
  token?: string;
}

/**
 * Resposta automática ao clique CONFIRM/CANCEL. NÃO é suprimida pela pausa humana
 * (humanHoldAt): é resposta imediata a uma ação do próprio contato, dentro da janela
 * aberta por ele, e não é follow-up de campanha. Usa o limiter compartilhado (LIVE).
 */
export async function processAutomaticReply(
  job: Job<SendAutomaticReplyJob>,
  overrides: Partial<AutomaticReplyDeps> = {},
): Promise<void> {
  const deps: AutomaticReplyDeps = {
    prisma: defaultPrisma,
    acquirePermit: acquireMetaSendPermit,
    sendText: sendMetaText,
    mode: () => process.env.MESSAGING_MODE ?? 'DRY_RUN',
    ...overrides,
  };
  const prisma = deps.prisma;
  const claimed = await prisma.message.updateMany({
    where: { id: job.data.messageId, status: 'QUEUED' },
    data: { status: 'PROCESSING', failureCode: null, failureReason: null, failedAt: null },
  });
  if (!claimed.count) return;

  const message = await prisma.message.findUniqueOrThrow({ where: { id: job.data.messageId } });
  const mode = deps.mode();
  const definition = automaticReplyDefinition(job.data.action);
  let providerMessageId: string;

  try {
    if (mode === 'DRY_RUN') providerMessageId = `dry-run-automatic-reply-${randomUUID()}`;
    else if (mode === 'LIVE') {
      const senderPhoneNumberId = configuredPhoneNumberId();
      if (!senderPhoneNumberId) {
        throw new WhatsAppApiError(
          'Configuração obrigatória ausente: META_WHATSAPP_PHONE_NUMBER_ID.',
          'CONFIGURATION_ERROR',
          false,
        );
      }
      const permit = await deps.acquirePermit(senderPhoneNumberId, 'campaign');
      if (!permit.granted) throw new SendPermitDeniedError(permit.retryAfterMs);
      providerMessageId = (
        await deps.sendText({ destination: message.phone, text: definition.text })
      ).providerMessageId;
    } else {
      throw new WhatsAppApiError('MESSAGING_MODE deve ser DRY_RUN ou LIVE.', 'INVALID_MODE', false);
    }
  } catch (error) {
    const providerError =
      error instanceof WhatsAppApiError
        ? error
        : new WhatsAppApiError('Falha inesperada ao enviar.', 'UNKNOWN', true);
    const attempts = job.opts.attempts ?? 1;
    const rateLimited = providerError instanceof SendPermitDeniedError;
    // Limite de envio não é falha: nada saiu; volta a QUEUED mesmo na última tentativa.
    const willRetry = rateLimited || (providerError.retryable && job.attemptsMade + 1 < attempts);
    await prisma.message.update({
      where: { id: message.id },
      data: {
        status: willRetry ? 'QUEUED' : 'FAILED',
        ...(willRetry ? {} : { failedAt: new Date() }),
        failureCode: providerError.code,
        failureReason: providerError.message,
      },
    });
    if (rateLimited) {
      await deferJobForSendPermit(job, deps.token, providerError.retryAfterMs);
    }
    if (willRetry) throw providerError;
    return;
  }

  const submittedAt = new Date();
  await prisma.$transaction([
    prisma.message.update({
      where: { id: message.id },
      data: { status: 'SUBMITTED', providerMessageId, submittedAt },
    }),
    prisma.messageEvent.create({
      data: {
        messageId: message.id,
        providerMessageId,
        providerEventId: `${mode.toLowerCase()}-automatic-reply-${randomUUID()}`,
        eventType: mode === 'DRY_RUN' ? 'DRY_RUN_AUTO_REPLY_SUBMITTED' : 'AUTO_REPLY_SUBMITTED',
        deduplicationKey: `automatic-reply:${message.id}:submitted`,
        payload: { queue: QUEUES.messages, mode, action: job.data.action },
        processingStatus: 'PROCESSED',
        processedAt: submittedAt,
      },
    }),
  ]);
}
