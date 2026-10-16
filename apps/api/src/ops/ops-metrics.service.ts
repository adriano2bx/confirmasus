import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Prisma, prisma } from '@confirma/database';
import { QUEUES } from '@confirma/queue';
import { Queue, type ConnectionOptions } from 'bullmq';
import {
  ageSeconds,
  formatPrometheus,
  type MetricFamily,
  type MetricSample,
} from './prometheus.js';

const WEBHOOK_STATUSES = ['PENDING', 'PROCESSING', 'FAILED', 'DEAD_LETTER'] as const;
const HUMAN_STATUSES = ['QUEUED', 'PROCESSING', 'UNKNOWN', 'BLOCKED', 'FAILED'] as const;
const MEDIA_STATUSES = ['PENDING', 'QUARANTINED', 'AVAILABLE', 'REJECTED', 'EXPIRED'] as const;
const JOB_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;
const QUEUE_TIMEOUT_MS = 1_500;

/** Conexão BullMQ que falha rápido (sem fila offline) para não travar o scrape com Redis fora. */
export function metricsRedisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const db = Number(url.pathname.replace('/', '') || 0);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(Number.isInteger(db) ? { db } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    connectTimeout: QUEUE_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
    retryStrategy: (times: number) => Math.min(times * 500, 5_000),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function statusSamples(
  statuses: readonly string[],
  rows: ReadonlyArray<{ status: string; count: bigint | number }>,
): MetricSample[] {
  const counts = new Map(rows.map((row) => [row.status, Number(row.count)]));
  return statuses.map((status) => ({ labels: { status }, value: counts.get(status) ?? 0 }));
}

@Injectable()
export class OpsMetricsService implements OnModuleDestroy {
  private readonly logger = new Logger(OpsMetricsService.name);
  private queues: Array<{ name: string; queue: Queue }> | null = null;

  async render(now = new Date()): Promise<string> {
    const started = Date.now();
    const [database, queues] = await Promise.all([this.databaseMetrics(now), this.queueMetrics()]);
    const families = [
      ...database,
      ...queues,
      {
        name: 'confirma_ops_scrape_duration_seconds',
        help: 'Duração da coleta de métricas operacionais.',
        type: 'gauge' as const,
        samples: [{ value: (Date.now() - started) / 1_000 }],
      },
    ];
    return formatPrometheus(families);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled((this.queues ?? []).map(({ queue }) => queue.close()));
  }

  private async databaseMetrics(now: Date): Promise<MetricFamily[]> {
    try {
      // Consultas agregadas sobre índices de status (sem varrer PROCESSED/IGNORED).
      const [events, eventAges, human, humanAge, unassigned, inboxMax, media] = await Promise.all([
        prisma.$queryRaw<Array<{ status: string; count: bigint }>>(Prisma.sql`
          SELECT processing_status::text AS status, count(*)::bigint AS count FROM message_events
          WHERE processing_status IN ('PENDING','PROCESSING','FAILED','DEAD_LETTER')
          GROUP BY processing_status`),
        prisma.$queryRaw<Array<{ status: string; oldest: Date | null }>>(Prisma.sql`
          SELECT processing_status::text AS status, min(received_at) AS oldest FROM message_events
          WHERE processing_status IN ('PENDING','FAILED') GROUP BY processing_status`),
        prisma.$queryRaw<Array<{ status: string; count: bigint }>>(Prisma.sql`
          SELECT status::text AS status, count(*)::bigint AS count FROM conversation_messages
          WHERE kind = 'HUMAN_TEXT' AND status IN ('QUEUED','PROCESSING','UNKNOWN','BLOCKED','FAILED')
          GROUP BY status`),
        prisma.$queryRaw<Array<{ oldest: Date | null }>>(Prisma.sql`
          SELECT min(created_at) AS oldest FROM conversation_messages
          WHERE kind = 'HUMAN_TEXT' AND status = 'QUEUED'`),
        prisma.$queryRaw<
          Array<{ team: string | null; count: bigint; oldest: Date | null }>
        >(Prisma.sql`
          SELECT t.slug AS team, count(*)::bigint AS count,
                 min(coalesce(c.last_inbound_at, c.created_at)) AS oldest
          FROM conversations c LEFT JOIN teams t ON t.id = c.team_id
          WHERE c.status = 'OPEN' AND c.assignee_id IS NULL
          GROUP BY t.slug`),
        prisma.$queryRaw<Array<{ max: bigint | null }>>(
          Prisma.sql`SELECT max(id) AS max FROM inbox_events`,
        ),
        prisma.$queryRaw<Array<{ status: string; count: bigint }>>(Prisma.sql`
          SELECT status::text AS status, count(*)::bigint AS count FROM media_assets GROUP BY status`),
      ]);
      const ages = new Map(eventAges.map((row) => [row.status, row.oldest]));
      return [
        {
          name: 'confirma_db_up',
          help: 'Banco acessível na coleta (1/0).',
          type: 'gauge',
          samples: [{ value: 1 }],
        },
        {
          name: 'confirma_webhook_events',
          help: 'message_events não finalizados por status de processamento.',
          type: 'gauge',
          samples: statusSamples(WEBHOOK_STATUSES, events),
        },
        {
          name: 'confirma_webhook_oldest_age_seconds',
          help: 'Idade do message_event mais antigo por status (PENDING/FAILED).',
          type: 'gauge',
          samples: ['PENDING', 'FAILED'].map((status) => ({
            labels: { status },
            value: ageSeconds(ages.get(status), now),
          })),
        },
        {
          name: 'confirma_webhook_dead_letters',
          help: 'message_events em DEAD_LETTER (exigem análise e replay manual).',
          type: 'gauge',
          samples: [
            { value: Number(events.find((row) => row.status === 'DEAD_LETTER')?.count ?? 0) },
          ],
        },
        {
          name: 'confirma_inbox_human_messages',
          help: 'Mensagens humanas (HUMAN_TEXT) em estados não finais ou de atenção.',
          type: 'gauge',
          samples: statusSamples(HUMAN_STATUSES, human),
        },
        {
          name: 'confirma_inbox_human_queued_oldest_age_seconds',
          help: 'Idade da mensagem humana QUEUED mais antiga.',
          type: 'gauge',
          samples: [{ value: ageSeconds(humanAge[0]?.oldest, now) }],
        },
        {
          name: 'confirma_inbox_unassigned_open_conversations',
          help: 'Conversas OPEN sem responsável por equipe.',
          type: 'gauge',
          samples: unassigned.map((row) => ({
            labels: { team: row.team ?? 'sem_equipe' },
            value: Number(row.count),
          })),
        },
        {
          name: 'confirma_inbox_unassigned_oldest_age_seconds',
          help: 'Idade da conversa OPEN sem responsável mais antiga por equipe (desde o último inbound).',
          type: 'gauge',
          samples: unassigned.map((row) => ({
            labels: { team: row.team ?? 'sem_equipe' },
            value: ageSeconds(row.oldest, now),
          })),
        },
        {
          name: 'confirma_inbox_events_max_id',
          help: 'Maior id do feed inbox_events (cursor SSE).',
          type: 'gauge',
          samples: [{ value: Number(inboxMax[0]?.max ?? 0) }],
        },
        {
          name: 'confirma_media_assets',
          help: 'Mídias recebidas por status.',
          type: 'gauge',
          samples: statusSamples(MEDIA_STATUSES, media),
        },
      ];
    } catch (error) {
      this.logger.warn(
        `Métricas do banco indisponíveis: ${error instanceof Error ? error.name : 'erro'}`,
      );
      return [
        {
          name: 'confirma_db_up',
          help: 'Banco acessível na coleta (1/0).',
          type: 'gauge',
          samples: [{ value: 0 }],
        },
      ];
    }
  }

  private queueList(): Array<{ name: string; queue: Queue }> {
    if (this.queues) return this.queues;
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) return (this.queues = []);
    const connection = metricsRedisConnection(redisUrl);
    this.queues = Object.values(QUEUES).map((name) => {
      const queue = new Queue(name, { connection });
      // Sem handler, erro de conexão do Redis derrubaria o processo.
      queue.on('error', () => undefined);
      return { name, queue };
    });
    return this.queues;
  }

  private async queueMetrics(): Promise<MetricFamily[]> {
    const queues = this.queueList();
    const results = await Promise.allSettled(
      queues.map(async ({ name, queue }) => ({
        name,
        counts: await withTimeout(queue.getJobCounts(...JOB_STATES), QUEUE_TIMEOUT_MS),
      })),
    );
    const samples: MetricSample[] = [];
    let up = queues.length > 0;
    for (const result of results) {
      if (result.status === 'rejected') {
        up = false;
        continue;
      }
      for (const state of JOB_STATES) {
        samples.push({
          labels: { queue: result.value.name, state },
          value: result.value.counts[state] ?? 0,
        });
      }
    }
    return [
      {
        name: 'confirma_redis_up',
        help: 'Redis acessível na coleta (1/0).',
        type: 'gauge',
        samples: [{ value: up ? 1 : 0 }],
      },
      {
        name: 'confirma_queue_jobs',
        help: 'Jobs BullMQ por fila e estado.',
        type: 'gauge',
        samples,
      },
    ];
  }
}
