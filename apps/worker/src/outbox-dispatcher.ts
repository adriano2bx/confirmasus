import { prisma } from '@confirma/database';
import { webhookJobId, type ProcessWebhookJob } from '@confirma/queue';
import type { Queue } from 'bullmq';

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_LEASE_MS = 60_000;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 15 * 60_000;

/** Tentativas de processamento antes de marcar o evento como DEAD_LETTER. */
export const WEBHOOK_MAX_ATTEMPTS = positiveInteger(process.env.WEBHOOK_MAX_ATTEMPTS, 12);

/** Mesmas opções de job usadas pela API ao publicar eventos recém-gravados. */
const WEBHOOK_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: 1_000,
  removeOnFail: 1_000,
} as const;

/** Backoff exponencial (2 s, 4 s, 8 s, ...) com teto de 15 min; `attempts` = falhas até agora. */
export function webhookRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.floor(attempts) - 1);
  if (exponent >= 30) return RETRY_MAX_DELAY_MS;
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, RETRY_MAX_DELAY_MS);
}

/**
 * Despachante do outbox do webhook: reivindica eventos PENDING/FAILED vencidos com lease
 * (`FOR UPDATE SKIP LOCKED`, seguro com várias réplicas) e os publica no BullMQ.
 * Se o Redis falhar, o erro propaga e nada se perde: o lease expira e o evento volta a ser elegível.
 */
export async function dispatchWebhookOutbox(
  queue: Queue<ProcessWebhookJob>,
  options: { batchSize?: number; leaseMs?: number; now?: Date } = {},
): Promise<number> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
  const now = options.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS)).toISOString();
  const nowIso = now.toISOString();

  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE message_events
    SET dispatch_lease_until = ${leaseUntil}::timestamptz
    WHERE id IN (
      SELECT id
      FROM message_events
      WHERE processing_status IN ('PENDING', 'FAILED')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${nowIso}::timestamptz)
        AND (dispatch_lease_until IS NULL OR dispatch_lease_until < ${nowIso}::timestamptz)
        AND received_at < ${nowIso}::timestamptz - interval '5 seconds'
      ORDER BY received_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `;

  for (const { id } of claimed) {
    const jobId = webhookJobId(id);
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') await existing.remove();
    }
    await queue.add('process-webhook', { messageEventId: id }, { jobId, ...WEBHOOK_JOB_OPTIONS });
  }
  return claimed.length;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
