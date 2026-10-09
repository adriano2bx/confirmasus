import { randomUUID } from 'node:crypto';
import { ConvocationStage, prisma } from '@confirma/database';
import { templateForStage, type MessageStage } from '@confirma/domain';
import { QUEUES, type SendMessageJob } from '@confirma/queue';
import type { Job } from 'bullmq';
import { WhatsAppApiError, sendMetaTemplate } from './meta-whatsapp-client.js';
import { nextResponseDeadline } from './follow-up-schedule.js';

function stageToMessageStage(stage: ConvocationStage): MessageStage | null {
  return stage === 'FIRST' || stage === 'SECOND' || stage === 'THIRD' ? stage : null;
}

export async function processSendMessage(job: Job<SendMessageJob>): Promise<void> {
  const created = await prisma.$transaction(async (transaction) => {
    const convocation = await transaction.convocation.findUnique({
      where: { id: job.data.convocationId },
      include: {
        campaign: true,
        selectedPhone: true,
        patient: { include: { phones: true } },
      },
    });
    if (!convocation || !['SCHEDULED', 'RUNNING'].includes(convocation.campaign.status))
      return null;
    if (convocation.status !== 'QUEUED' || convocation.stage !== job.data.stage) return null;

    const stage = stageToMessageStage(convocation.stage);
    const phone =
      (convocation.selectedPhone?.valid && convocation.selectedPhone.mobile
        ? convocation.selectedPhone
        : null) ??
      convocation.patient.phones.find(
        (item) => item.selectedForWhatsApp && item.valid && item.mobile,
      );
    if (!stage || !phone) {
      await transaction.convocation.update({
        where: { id: convocation.id },
        data: { status: 'SEND_ERROR', nextActionAt: null },
      });
      return null;
    }

    const claimed = await transaction.convocation.updateMany({
      where: { id: convocation.id, version: convocation.version, status: 'QUEUED' },
      data: { status: 'PROCESSING', version: { increment: 1 } },
    });
    if (claimed.count === 0) return null;

    const template = templateForStage(stage);
    const message = await transaction.message.upsert({
      where: {
        convocationId_stage_attemptNumber: {
          convocationId: convocation.id,
          stage: convocation.stage,
          attemptNumber: stage === 'FIRST' ? 1 : stage === 'SECOND' ? 2 : 3,
        },
      },
      update: {
        status: 'PROCESSING',
        templateName: template.name,
        templateId: process.env[template.idEnvironmentVariable] ?? template.defaultId,
        failureCode: null,
        failureReason: null,
        failedAt: null,
      },
      create: {
        convocationId: convocation.id,
        stage: convocation.stage,
        attemptNumber: stage === 'FIRST' ? 1 : stage === 'SECOND' ? 2 : 3,
        templateName: template.name,
        templateId: process.env[template.idEnvironmentVariable] ?? template.defaultId,
        phone: phone.normalizedValue,
        status: 'PROCESSING',
        idempotencyKey: `convocation:${convocation.id}:${stage}`,
      },
    });
    return { convocationId: convocation.id, messageId: message.id };
  });

  if (!created) return;
  const mode = process.env.MESSAGING_MODE ?? 'DRY_RUN';
  let providerMessageId: string;
  try {
    if (mode === 'DRY_RUN') providerMessageId = `dry-run-${randomUUID()}`;
    else if (mode === 'LIVE') {
      const message = await prisma.message.findUniqueOrThrow({
        where: { id: created.messageId },
        include: { convocation: { include: { patient: true } } },
      });
      const stage = stageToMessageStage(message.stage);
      if (!stage) throw new Error('Etapa de mensagem inválida');
      providerMessageId = (
        await sendMetaTemplate({
          destination: message.phone,
          stage,
          templateName: message.templateId,
          patientName: message.convocation.patient.displayName,
        })
      ).providerMessageId;
    } else {
      throw new WhatsAppApiError('MESSAGING_MODE deve ser DRY_RUN ou LIVE.', 'INVALID_MODE', false);
    }
  } catch (error) {
    const providerError =
      error instanceof WhatsAppApiError
        ? error
        : new WhatsAppApiError('Falha inesperada ao enviar.', 'UNKNOWN', true);
    await prisma.$transaction(async (transaction) => {
      await transaction.message.update({
        where: { id: created.messageId },
        data: {
          status: providerError.retryable ? 'QUEUED' : 'FAILED',
          ...(providerError.retryable ? {} : { failedAt: new Date() }),
          failureCode: providerError.code,
          failureReason: providerError.message,
        },
      });
      await transaction.convocation.updateMany({
        where: { id: created.convocationId, status: 'PROCESSING' },
        data: providerError.retryable
          ? { status: 'QUEUED' }
          : { status: 'SEND_ERROR', nextActionAt: null },
      });
    });
    if (providerError.retryable) throw providerError;
    return;
  }

  await prisma.$transaction(async (transaction) => {
    const message = await transaction.message.findUniqueOrThrow({
      where: { id: created.messageId },
      include: { convocation: { include: { campaign: true } } },
    });
    const submittedAt = new Date();
    const next = nextResponseDeadline(submittedAt, message.stage, message.convocation.campaign);
    await transaction.message.update({
      where: { id: created.messageId },
      data: { status: 'SUBMITTED', providerMessageId, submittedAt },
    });
    await transaction.messageEvent.create({
      data: {
        messageId: created.messageId,
        providerMessageId,
        providerEventId: `${mode.toLowerCase()}-submitted-${randomUUID()}`,
        eventType: mode === 'DRY_RUN' ? 'DRY_RUN_SUBMITTED' : 'META_SUBMITTED',
        deduplicationKey: `${mode.toLowerCase()}:${created.messageId}:submitted`,
        payload: { queue: QUEUES.messages, mode },
        processingStatus: 'PROCESSED',
        processedAt: submittedAt,
      },
    });
    await transaction.convocation.updateMany({
      where: { id: created.convocationId, status: 'PROCESSING' },
      data: next
        ? // Keep the current stage visible while its response window is open.
          // The scheduler advances the stage only when nextActionAt is due.
          { status: 'WAITING_RESPONSE', nextActionAt: next.at }
        : { status: 'WAITING_RESPONSE', nextActionAt: null },
    });
  });
}
