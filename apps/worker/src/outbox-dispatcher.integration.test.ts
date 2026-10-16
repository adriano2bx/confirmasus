import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { ProcessWebhookJob } from '@confirma/queue';
import type { Queue } from 'bullmq';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

describe('despachante de outbox (PostgreSQL)', { skip: !databaseUrl }, () => {
  const marker = `outbox-it:${randomUUID()}`;

  after(async () => {
    const { prisma } = await import('@confirma/database');
    await prisma.messageEvent.deleteMany({ where: { deduplicationKey: { startsWith: marker } } });
    await prisma.$disconnect();
  });

  it('reivindica com SKIP LOCKED sem duplicar entre despachantes e respeita o lease', async () => {
    const { prisma } = await import('@confirma/database');
    const { dispatchWebhookOutbox } = await import('./outbox-dispatcher.js');
    const old = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60 * 60_000);
    await prisma.messageEvent.createMany({
      data: [
        ...Array.from({ length: 6 }, (_, index) => ({
          eventType: 'message',
          deduplicationKey: `${marker}:pending:${index}`,
          payload: {},
          receivedAt: old,
        })),
        {
          eventType: 'message',
          deduplicationKey: `${marker}:failed-due`,
          payload: {},
          receivedAt: old,
          processingStatus: 'FAILED' as const,
          nextAttemptAt: old,
        },
        {
          eventType: 'message',
          deduplicationKey: `${marker}:failed-later`,
          payload: {},
          receivedAt: old,
          processingStatus: 'FAILED' as const,
          nextAttemptAt: future,
        },
        {
          eventType: 'message',
          deduplicationKey: `${marker}:dead`,
          payload: {},
          receivedAt: old,
          processingStatus: 'DEAD_LETTER' as const,
        },
        {
          eventType: 'message',
          deduplicationKey: `${marker}:fresh`,
          payload: {},
        },
      ],
    });
    const ours = await prisma.messageEvent.findMany({
      where: { deduplicationKey: { startsWith: marker } },
      select: { id: true, deduplicationKey: true },
    });
    const ourIds = new Set(ours.map((event) => event.id));
    const expected = new Set(
      ours
        .filter((event) => /:(pending:\d|failed-due)$/.test(event.deduplicationKey))
        .map((event) => event.id),
    );

    const published: string[] = [];
    const queue = {
      getJob: async () => undefined,
      add: async (_name: string, data: ProcessWebhookJob) => {
        published.push(data.messageEventId);
      },
    } as unknown as Queue<ProcessWebhookJob>;

    // Outros eventos pendentes do banco de teste também podem ser reivindicados; filtramos os nossos.
    for (let round = 0; round < 20; round += 1) {
      const counts = await Promise.all([
        dispatchWebhookOutbox(queue, { batchSize: 2 }),
        dispatchWebhookOutbox(queue, { batchSize: 2 }),
      ]);
      if (counts[0] === 0 && counts[1] === 0) break;
    }
    const mine = published.filter((id) => ourIds.has(id));
    assert.equal(new Set(mine).size, mine.length, 'evento publicado mais de uma vez');
    assert.deepEqual(new Set(mine), expected);

    const again = await dispatchWebhookOutbox(queue, { batchSize: 100 });
    assert.equal(
      published.slice(published.length - again).filter((id) => ourIds.has(id)).length,
      0,
    );
  });
});
