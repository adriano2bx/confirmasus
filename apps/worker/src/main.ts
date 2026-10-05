import { readFile, unlink } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { prisma } from '@confirma/database';
import {
  QUEUES,
  createRedisConnection,
  type ParseImportJob,
  type SendMessageJob,
  type MessagingJob,
  type SendAutomaticReplyJob,
  type ProcessHandoffJob,
  type ProcessWebhookJob,
} from '@confirma/queue';
import { Queue, Worker, type Job } from 'bullmq';
import { processSendMessage } from './message-worker.js';
import { processAutomaticReply } from './automatic-reply-worker.js';
import { AUTOMATIC_REPLY_TEMPLATE_ID, automaticReplyEnabled } from './automatic-reply.js';
import { processWebhook } from './webhook-worker.js';
import { processHandoff } from './handoff-worker.js';
import { parseSisregPdf } from './sisreg-parser.js';
import { parseRegulamtXlsx } from './regulamt-parser.js';
import { applySisregAiFallback } from './sisreg-ai-fallback.js';

const timezone = process.env.APP_TIMEZONE ?? 'America/Sao_Paulo';
process.env.TZ = timezone;
let shuttingDown = false;

const importConnection = createRedisConnection();
const worker = new Worker<ParseImportJob>(
  QUEUES.imports,
  async (job) => {
    if (job.name !== 'parse-import') return;
    const { importId, importFileId, temporaryPath } = job.data;
    const current = await prisma.import.findUnique({
      where: { id: importId },
      select: { status: true },
    });
    if (!current || current.status === 'CANCELLED') {
      await unlink(temporaryPath).catch(() => undefined);
      return;
    }
    const data = await readFile(temporaryPath);
    const sourceFile = await prisma.importFile.findUnique({
      where: { id: importFileId },
      select: { mimeType: true, originalName: true },
    });
    const isSpreadsheet =
      sourceFile?.mimeType.includes('spreadsheet') ||
      sourceFile?.mimeType === 'application/zip' ||
      sourceFile?.originalName.toLowerCase().endsWith('.xlsx');
    let parsed = isSpreadsheet
      ? await parseRegulamtXlsx(new Uint8Array(data))
      : await parseSisregPdf(new Uint8Array(data));
    try {
      // The spreadsheet is structured already; its missing demographic fields
      // are genuinely absent, so do not spend an AI fallback call on them.
      if (parsed.layout !== 'REGULAMT_XLSX') parsed = await applySisregAiFallback(parsed);
    } catch (error) {
      parsed = {
        ...parsed,
        warnings: [
          ...parsed.warnings,
          `Fallback de IA não aplicado: ${error instanceof Error ? error.message : 'erro desconhecido'}`,
        ],
      };
    }

    await prisma.$transaction(async (transaction) => {
      const latest = await transaction.import.findUnique({
        where: { id: importId },
        select: { status: true },
      });
      if (!latest || latest.status === 'CANCELLED') return;
      await transaction.importRow.deleteMany({ where: { importFileId } });
      if (parsed.rows.length > 0) {
        await transaction.importRow.createMany({
          data: parsed.rows.map((row) => ({
            importId,
            importFileId,
            rowNumber: row.rowNumber,
            rawData: { text: row.rawText },
            normalizedData: {
              extractionSource: row.issues.includes('AI_FALLBACK_REVIEW')
                ? 'AI_FALLBACK'
                : 'PARSER',
              codigoConvocacaoOrigem: row.codigoConvocacaoOrigem,
              nome: row.nome,
              dataNascimento: row.dataNascimento,
              cpf: row.cpf,
              cns: row.cns,
              telefones: row.telefones,
              dataHora: row.dataHora,
              procedimentos: row.procedimentos,
            },
            validationStatus: row.issues.length === 0 ? 'VALID' : 'WARNING',
            validationIssues: row.issues,
          })),
        });
      }

      await transaction.import.update({
        where: { id: importId },
        data: {
          layout: parsed.layout,
          totalReported: parsed.totalReported,
          recordsFound: parsed.rows.length,
          warnings: parsed.warnings,
          validationSummary: {
            valid: parsed.rows.filter((row) => row.issues.length === 0).length,
            warning: parsed.rows.filter((row) => row.issues.length > 0).length,
            invalid: 0,
          },
          status:
            (parsed.layout === 'SISREG_V1' || parsed.layout === 'REGULAMT_XLSX') &&
            parsed.rows.length > 0
              ? 'READY_FOR_REVIEW'
              : 'REVIEW_REQUIRED',
        },
      });

      await transaction.importFile.update({
        where: { id: importFileId },
        data: { temporaryKey: null, deletedAt: new Date() },
      });
    });

    await unlink(temporaryPath).catch(() => undefined);
  },
  {
    connection: importConnection,
    concurrency: Number(process.env.IMPORT_WORKER_CONCURRENCY ?? 2),
  },
);

const messageQueueConnection = createRedisConnection();
const messageWorkerConnection = createRedisConnection();
const messageQueue = new Queue<MessagingJob>(QUEUES.messages, {
  connection: messageQueueConnection,
});

const messageWorker = new Worker<MessagingJob>(
  QUEUES.messages,
  async (job) => {
    if (job.name === 'send-automatic-reply') {
      return processAutomaticReply(job as Job<SendAutomaticReplyJob>);
    }
    return processSendMessage(job as Job<SendMessageJob>);
  },
  {
    connection: messageWorkerConnection,
    concurrency: Number(process.env.MESSAGE_WORKER_CONCURRENCY ?? 5),
    limiter: {
      max: Number(process.env.MESSAGE_RATE_LIMIT_MAX ?? 20),
      duration: Number(process.env.MESSAGE_RATE_LIMIT_DURATION_MS ?? 1_000),
    },
  },
);
const webhookConnection = createRedisConnection();
const webhookWorker = new Worker<ProcessWebhookJob>(QUEUES.webhooks, processWebhook, {
  connection: webhookConnection,
  concurrency: Number(process.env.WEBHOOK_WORKER_CONCURRENCY ?? 10),
});
const handoffQueueConnection = createRedisConnection();
const handoffWorkerConnection = createRedisConnection();
const handoffQueue = new Queue<ProcessHandoffJob>(QUEUES.handoffs, {
  connection: handoffQueueConnection,
});
const handoffWorker = new Worker<ProcessHandoffJob>(QUEUES.handoffs, processHandoff, {
  connection: handoffWorkerConnection,
  concurrency: Number(process.env.HANDOFF_WORKER_CONCURRENCY ?? 3),
});

async function enqueueDueConvocations(): Promise<void> {
  const now = new Date();
  await reconcileWaitingStages();
  await finalizeNoResponseDue(now);
  await promoteDueFollowUps(now);
  await enqueuePendingHandoffs(now);
  await enqueuePendingAutomaticReplies();
  const due = await prisma.convocation.findMany({
    where: {
      status: 'SCHEDULED',
      nextActionAt: { lte: now },
      campaign: { status: { in: ['SCHEDULED', 'RUNNING'] } },
    },
    select: { id: true, stage: true },
    take: 250,
  });
  for (const convocation of due) {
    if (!isSendableStage(convocation.stage)) continue;
    await messageQueue.add(
      'send-message',
      { convocationId: convocation.id, stage: convocation.stage },
      {
        jobId: `send:${convocation.id}:${convocation.stage}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1_000,
        removeOnFail: 1_000,
      },
    );
    await prisma.convocation.updateMany({
      where: { id: convocation.id, status: 'SCHEDULED' },
      data: { status: 'QUEUED' },
    });
  }
}

/** Repairs records created by older workers that advanced the visible stage
 * before the response window had expired. The last main message is the source
 * of truth while a convocation is waiting for a response. */
async function reconcileWaitingStages(): Promise<void> {
  const waiting = await prisma.convocation.findMany({
    where: { status: 'WAITING_RESPONSE', stage: { in: ['SECOND', 'THIRD'] } },
    select: {
      id: true,
      stage: true,
      messages: {
        where: { attemptNumber: { lte: 3 } },
        orderBy: { attemptNumber: 'desc' },
        take: 1,
        select: { stage: true },
      },
    },
    take: 500,
  });
  for (const item of waiting) {
    const latest = item.messages[0]?.stage;
    if ((latest === 'FIRST' || latest === 'SECOND') && latest !== item.stage) {
      await prisma.convocation.updateMany({
        where: { id: item.id, status: 'WAITING_RESPONSE' },
        data: { stage: latest },
      });
    }
  }
}

async function enqueuePendingAutomaticReplies(): Promise<void> {
  if (!automaticReplyEnabled()) return;
  const pending = await prisma.message.findMany({
    where: { stage: 'FINISHED', templateId: AUTOMATIC_REPLY_TEMPLATE_ID, status: 'QUEUED' },
    select: { id: true, templateName: true },
    take: 250,
  });
  for (const message of pending) {
    const action = message.templateName.endsWith('_confirmacao') ? 'CONFIRM' : 'CANCEL';
    await messageQueue.add(
      'send-automatic-reply',
      { messageId: message.id, action },
      {
        jobId: `automatic-reply:${message.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1_000,
        removeOnFail: 1_000,
      },
    );
  }
}

async function enqueuePendingHandoffs(now: Date): Promise<void> {
  if (process.env.HANDOFF_MODE !== 'LIVE') return;
  const pending = await prisma.handoffEvent.findMany({
    where: { status: 'PENDING', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    select: { id: true },
    take: 100,
  });
  for (const handoff of pending) {
    await handoffQueue.add(
      'process-handoff',
      { handoffEventId: handoff.id },
      { jobId: `handoff:${handoff.id}`, removeOnComplete: true, removeOnFail: true },
    );
    await prisma.handoffEvent.updateMany({
      where: { id: handoff.id, status: 'PENDING' },
      data: { status: 'PROCESSING' },
    });
  }
}

async function promoteDueFollowUps(now: Date): Promise<void> {
  await prisma.convocation.updateMany({
    where: {
      status: 'WAITING_RESPONSE',
      stage: 'FIRST',
      nextActionAt: { lte: now },
      campaign: { status: { in: ['SCHEDULED', 'RUNNING'] } },
    },
    data: { status: 'SCHEDULED', stage: 'SECOND' },
  });
  await prisma.convocation.updateMany({
    where: {
      status: 'WAITING_RESPONSE',
      stage: 'SECOND',
      nextActionAt: { lte: now },
      campaign: { status: { in: ['SCHEDULED', 'RUNNING'] } },
    },
    data: { status: 'SCHEDULED', stage: 'THIRD' },
  });
}

async function finalizeNoResponseDue(now: Date): Promise<void> {
  const finalizable = await prisma.convocation.findMany({
    where: {
      stage: 'THIRD',
      status: 'WAITING_RESPONSE',
      nextActionAt: { lte: now },
      campaign: { status: { in: ['SCHEDULED', 'RUNNING'] } },
    },
    select: { id: true, campaignId: true },
    take: 250,
  });
  for (const convocation of finalizable) {
    await prisma.$transaction(async (transaction) => {
      const updated = await transaction.convocation.updateMany({
        where: {
          id: convocation.id,
          stage: 'THIRD',
          status: 'WAITING_RESPONSE',
          nextActionAt: { lte: now },
        },
        data: {
          status: 'FINISHED_NO_RESPONSE',
          stage: 'FINISHED',
          finishedAt: now,
          nextActionAt: null,
        },
      });
      if (updated.count)
        await transaction.auditLog.create({
          data: {
            eventType: 'CONVOCATION_FINISHED_NO_RESPONSE',
            entityType: 'convocation',
            entityId: convocation.id,
          },
        });
    });
  }
  await prisma.campaign.updateMany({
    where: {
      status: { in: ['SCHEDULED', 'RUNNING'] },
      convocations: {
        every: { status: { in: ['CONFIRMED', 'CANCELLED', 'FINISHED_NO_RESPONSE', 'SEND_ERROR'] } },
      },
    },
    data: { status: 'COMPLETED', completedAt: now },
  });
}

const scheduler = setInterval(
  () => void enqueueDueConvocations().catch((error: unknown) => reportSchedulerError(error)),
  Number(process.env.SCHEDULER_INTERVAL_MS ?? 10_000),
);
const cleanupTimer = setInterval(
  () => void cleanupTemporaryFiles().catch((error: unknown) => reportCleanupError(error)),
  60 * 60 * 1_000,
);
void enqueueDueConvocations();
void cleanupTemporaryFiles();

async function cleanupTemporaryFiles(): Promise<void> {
  const olderThan = new Date(
    Date.now() - Number(process.env.TEMP_FILE_MAX_AGE_HOURS ?? 24) * 3_600_000,
  );
  const files = await prisma.importFile.findMany({
    where: { temporaryKey: { not: null }, createdAt: { lt: olderThan } },
    take: 100,
  });
  const root = resolve(process.env.UPLOAD_TEMP_DIR ?? '/tmp/confirma-sus');
  for (const file of files) {
    if (!file.temporaryKey) continue;
    await unlink(resolve(root, basename(file.temporaryKey))).catch(() => undefined);
    await prisma.importFile.update({
      where: { id: file.id },
      data: { temporaryKey: null, deletedAt: new Date() },
    });
  }
}

function reportSchedulerError(error: unknown): void {
  if (shuttingDown && isClosedConnectionError(error)) return;
  console.error(
    'Erro no scheduler:',
    error instanceof Error ? error.message : 'falha não identificada',
  );
}

function reportCleanupError(error: unknown): void {
  if (shuttingDown && isClosedConnectionError(error)) return;
  console.error(
    'Erro na limpeza temporária:',
    error instanceof Error ? error.message : 'falha não identificada',
  );
}

function isClosedConnectionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P1017'
  );
}

function isSendableStage(stage: string): stage is SendMessageJob['stage'] {
  return stage === 'FIRST' || stage === 'SECOND' || stage === 'THIRD';
}

worker.on('failed', async (job, error) => {
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  await prisma.import
    .updateMany({
      where: { id: job.data.importId, status: { not: 'CANCELLED' } },
      data: { status: 'FAILED', failureReason: error.message.slice(0, 500) },
    })
    .catch(() => undefined);
});

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(scheduler);
  clearInterval(cleanupTimer);
  await worker.close();
  await messageWorker.close();
  await webhookWorker.close();
  await handoffWorker.close();
  await messageQueue.close();
  await handoffQueue.close();
  await Promise.all([
    importConnection.quit(),
    messageQueueConnection.quit(),
    messageWorkerConnection.quit(),
    webhookConnection.quit(),
    handoffQueueConnection.quit(),
    handoffWorkerConnection.quit(),
  ]);
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

console.info(`Workers iniciados; modo de mensageria: ${process.env.MESSAGING_MODE ?? 'DRY_RUN'}`);
