import { randomUUID } from 'node:crypto';
import { prisma } from '@confirma/database';
import { QUEUES, type SendAutomaticReplyJob } from '@confirma/queue';
import type { Job } from 'bullmq';
import { automaticReplyDefinition } from './automatic-reply.js';
import { WhatsAppApiError, sendMetaText } from './meta-whatsapp-client.js';

export async function processAutomaticReply(job: Job<SendAutomaticReplyJob>): Promise<void> {
  const claimed = await prisma.message.updateMany({
    where: { id: job.data.messageId, status: 'QUEUED' },
    data: { status: 'PROCESSING', failureCode: null, failureReason: null, failedAt: null },
  });
  if (!claimed.count) return;

  const message = await prisma.message.findUniqueOrThrow({ where: { id: job.data.messageId } });
  const mode = process.env.MESSAGING_MODE ?? 'DRY_RUN';
  const definition = automaticReplyDefinition(job.data.action);
  let providerMessageId: string;

  try {
    if (mode === 'DRY_RUN') providerMessageId = `dry-run-automatic-reply-${randomUUID()}`;
    else if (mode === 'LIVE') {
      providerMessageId = (
        await sendMetaText({ destination: message.phone, text: definition.text })
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
    const willRetry = providerError.retryable && job.attemptsMade + 1 < attempts;
    await prisma.message.update({
      where: { id: message.id },
      data: {
        status: willRetry ? 'QUEUED' : 'FAILED',
        ...(willRetry ? {} : { failedAt: new Date() }),
        failureCode: providerError.code,
        failureReason: providerError.message,
      },
    });
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
