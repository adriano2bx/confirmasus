import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { prisma } from '@confirma/database';
import type { ProcessWebhookJob } from '@confirma/queue';
import type { Queue } from 'bullmq';
import {
  dispatchWebhookOutbox,
  WEBHOOK_MAX_ATTEMPTS,
  webhookRetryDelayMs,
} from './outbox-dispatcher.js';

const db = prisma as unknown as { $queryRaw: unknown };
const originalQueryRaw = db.$queryRaw;

afterEach(() => {
  db.$queryRaw = originalQueryRaw;
});

describe('despachante de outbox do webhook', () => {
  it('calcula backoff exponencial com teto de 15 minutos', () => {
    assert.equal(webhookRetryDelayMs(0), 2_000);
    assert.equal(webhookRetryDelayMs(1), 2_000);
    assert.equal(webhookRetryDelayMs(2), 4_000);
    assert.equal(webhookRetryDelayMs(5), 32_000);
    assert.equal(webhookRetryDelayMs(10), 900_000);
    assert.equal(webhookRetryDelayMs(1_000), 900_000);
    assert.equal(WEBHOOK_MAX_ATTEMPTS, Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 12));
  });

  it('reivindica com lease e republica removendo job esgotado', async () => {
    let sql = '';
    let values: unknown[] = [];
    db.$queryRaw = async (strings: TemplateStringsArray, ...params: unknown[]) => {
      sql = strings.join('?');
      values = params;
      return [{ id: 'event-1' }, { id: 'event-2' }];
    };
    const removed: string[] = [];
    const added: Array<{ id: string; jobId: unknown }> = [];
    const queue = {
      getJob: async (jobId: string) =>
        jobId === 'webhook:event-1'
          ? {
              getState: async () => 'failed',
              remove: async () => {
                removed.push(jobId);
              },
            }
          : undefined,
      add: async (_name: string, data: ProcessWebhookJob, options: { jobId: unknown }) => {
        added.push({ id: data.messageEventId, jobId: options.jobId });
      },
    } as unknown as Queue<ProcessWebhookJob>;

    const now = new Date('2026-10-16T12:00:00.000Z');
    const count = await dispatchWebhookOutbox(queue, { batchSize: 10, leaseMs: 30_000, now });

    assert.equal(count, 2);
    assert.match(sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(sql, /processing_status IN \('PENDING', 'FAILED'\)/);
    assert.deepEqual(values, [
      '2026-10-16T12:00:30.000Z',
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      10,
    ]);
    assert.deepEqual(removed, ['webhook:event-1']);
    assert.deepEqual(added, [
      { id: 'event-1', jobId: 'webhook:event-1' },
      { id: 'event-2', jobId: 'webhook:event-2' },
    ]);
  });

  it('propaga erro do Redis para o lease expirar sem perder eventos', async () => {
    db.$queryRaw = async () => [{ id: 'event-1' }];
    const queue = {
      getJob: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      add: async () => undefined,
    } as unknown as Queue<ProcessWebhookJob>;
    await assert.rejects(dispatchWebhookOutbox(queue), /ECONNREFUSED/);
  });
});
