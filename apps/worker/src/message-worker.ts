import { randomUUID } from 'node:crypto';
import { ConvocationStage, prisma, type PrismaClient } from '@confirma/database';
import { templateForStage, type MessageStage } from '@confirma/domain';
import { QUEUES, type SendMessageJob, type SendPermit } from '@confirma/queue';
import type { Job } from 'bullmq';
import {
  SendPermitDeniedError,
  WhatsAppApiError,
  acquireMetaSendPermit,
  configuredPhoneNumberId,
  deferJobForSendPermit,
  sendMetaTemplate,
} from './meta-whatsapp-client.js';
import { nextResponseDeadline } from './follow-up-schedule.js';

function stageToMessageStage(stage: ConvocationStage): MessageStage | null {
  return stage === 'FIRST' || stage === 'SECOND' || stage === 'THIRD' ? stage : null;
}

export interface CampaignSenderDeps {
  prisma: PrismaClient;
  acquirePermit: (phoneNumberId: string, priority: 'human' | 'campaign') => Promise<SendPermit>;
  sendTemplate: typeof sendMetaTemplate;
  mode: () => string;
  /** Token do job BullMQ: permite adiar por limite de envio sem consumir tentativa. */
  token?: string;
}

function defaultDeps(): CampaignSenderDeps {
  return {
    prisma,
    acquirePermit: acquireMetaSendPermit,
    sendTemplate: sendMetaTemplate,
    mode: () => process.env.MESSAGING_MODE ?? 'DRY_RUN',
  };
}

/**
 * Pausa por atendimento humano (ADR-24): convocação com `humanHoldAt` não envia.
 * - Na transação de claim: volta QUEUED -> SCHEDULED sem criar linha de messages.
 * - Imediatamente antes da Meta (job já enfileirado + atribuição concorrente): a linha
 *   da etapa volta a QUEUED (sem providerMessageId; o upsert da etapa a reutiliza depois)
 *   e a convocação volta a SCHEDULED. Nenhuma tentativa é consumida e nada é enviado;
 *   ao retomar, o scheduler reenfileira (ver reconcileFailedMessageJobs em main.ts).
 * Resta uma janela mínima entre a releitura e a chamada HTTP; sem hold, o fluxo é o anterior.
 */
export async function processSendMessage(
  job: Job<SendMessageJob>,
  overrides: Partial<CampaignSenderDeps> = {},
): Promise<void> {
  const deps: CampaignSenderDeps = { ...defaultDeps(), ...overrides };
  const db = deps.prisma;
  const created = await db.$transaction(async (transaction) => {
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
    if (convocation.humanHoldAt) {
      await transaction.convocation.updateMany({
        where: { id: convocation.id, version: convocation.version, status: 'QUEUED' },
        data: { status: 'SCHEDULED', version: { increment: 1 } },
      });
      return null;
    }

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
    const senderPhoneNumberId = configuredPhoneNumberId();
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
        senderPhoneNumberId,
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
        senderPhoneNumberId,
        status: 'PROCESSING',
        idempotencyKey: `convocation:${convocation.id}:${stage}`,
      },
    });
    return { convocationId: convocation.id, messageId: message.id };
  });

  if (!created) return;
  const mode = deps.mode();
  let providerMessageId: string;
  try {
    if (mode === 'DRY_RUN') {
      if (await releaseIfHumanHold(db, created)) return;
      providerMessageId = `dry-run-${randomUUID()}`;
    } else if (mode === 'LIVE') {
      const message = await db.message.findUniqueOrThrow({
        where: { id: created.messageId },
        include: { convocation: { include: { patient: true } } },
      });
      const stage = stageToMessageStage(message.stage);
      if (!stage) throw new Error('Etapa de mensagem inválida');
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
      if (await releaseIfHumanHold(db, created)) return;
      providerMessageId = (
        await deps.sendTemplate({
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
    await db.$transaction(async (transaction) => {
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
    // Limite de envio: nada saiu; reprograma sem consumir tentativa quando há token.
    if (providerError instanceof SendPermitDeniedError) {
      await deferJobForSendPermit(job, deps.token, providerError.retryAfterMs);
    }
    if (providerError.retryable) throw providerError;
    return;
  }

  await db.$transaction(async (transaction) => {
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

/** Releitura da pausa humana imediatamente antes da Meta. true = não enviar. */
async function releaseIfHumanHold(
  db: PrismaClient,
  created: { convocationId: string; messageId: string },
): Promise<boolean> {
  const current = await db.convocation.findUnique({
    where: { id: created.convocationId },
    select: { humanHoldAt: true },
  });
  if (!current?.humanHoldAt) return false;
  await db.$transaction(async (transaction) => {
    await transaction.message.updateMany({
      where: { id: created.messageId, status: 'PROCESSING', providerMessageId: null },
      data: { status: 'QUEUED' },
    });
    await transaction.convocation.updateMany({
      where: { id: created.convocationId, status: 'PROCESSING' },
      data: { status: 'SCHEDULED', version: { increment: 1 } },
    });
  });
  return true;
}
