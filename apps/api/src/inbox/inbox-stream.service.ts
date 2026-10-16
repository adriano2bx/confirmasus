import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@confirma/database';
import { visibleTeamIds, type InboxActor } from '@confirma/domain';
import type { Request, Response } from 'express';
import { INBOX_PRISMA } from './inbox.constants.js';
import { formatSseEvent } from './inbox.helpers.js';
import type { Db } from './inbox-summary.js';

export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_MAX_CONNECTION_MS = 5 * 60_000;
/** Ids BIGSERIAL podem ser confirmados fora de ordem: revisita eventos recentes já abaixo do cursor. */
export const SSE_LATE_COMMIT_WINDOW_MS = 10_000;
const SSE_BATCH = 200;

export function ssePollIntervalMs(value = process.env.INBOX_SSE_POLL_MS): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 200 ? Math.trunc(parsed) : 1_000;
}

export interface StreamState {
  /** Maior id já enviado (Last-Event-ID). */
  cursor: bigint;
  /** Cursor inicial: nada abaixo dele é enviado (o cliente refaz a busca por HTTP). */
  floor: bigint;
  /** ids enviados recentemente (id -> instante) para não repetir na revisita. */
  sent: Map<string, number>;
}

export interface StreamEvent {
  id: bigint;
  type: string;
  conversationId: string;
  entityId: string | null;
}

/** Lê eventos novos visíveis ao ator (ADMIN: todos; demais: equipes do ator). */
export async function pollInboxEvents(
  db: Db,
  actor: InboxActor,
  state: StreamState,
  now: Date = new Date(),
): Promise<StreamEvent[]> {
  const visible = visibleTeamIds(actor);
  if (visible !== null && visible.length === 0) return [];
  const teamFilter = visible === null ? {} : { teamId: { in: visible } };
  const select = { id: true, type: true, conversationId: true, entityId: true } as const;
  const sentIds = [...state.sent.keys()].map((id) => BigInt(id));
  const [fresh, late] = await Promise.all([
    db.inboxEvent.findMany({
      where: { ...teamFilter, id: { gt: state.cursor } },
      select,
      orderBy: { id: 'asc' },
      take: SSE_BATCH,
    }),
    state.cursor > state.floor
      ? db.inboxEvent.findMany({
          where: {
            ...teamFilter,
            id: {
              gt: state.floor,
              lte: state.cursor,
              ...(sentIds.length ? { notIn: sentIds } : {}),
            },
            createdAt: { gte: new Date(now.getTime() - SSE_LATE_COMMIT_WINDOW_MS) },
          },
          select,
          orderBy: { id: 'asc' },
          take: SSE_BATCH,
        })
      : Promise.resolve([]),
  ]);
  const events = [...late, ...fresh];
  const stamp = now.getTime();
  for (const event of events) {
    state.sent.set(event.id.toString(), stamp);
    if (event.id > state.cursor) state.cursor = event.id;
  }
  for (const [id, at] of state.sent) {
    if (stamp - at > SSE_LATE_COMMIT_WINDOW_MS * 2) state.sent.delete(id);
  }
  return events;
}

@Injectable()
export class InboxStreamService {
  private readonly logger = new Logger(InboxStreamService.name);

  constructor(@Inject(INBOX_PRISMA) private readonly db: PrismaClient) {}

  async startCursor(requested: bigint | null): Promise<bigint> {
    if (requested !== null) return requested;
    const last = await this.db.inboxEvent.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    return last?.id ?? 0n;
  }

  async open(request: Request, response: Response, actor: InboxActor, requested: bigint | null) {
    const cursor = await this.startCursor(requested);
    const state: StreamState = { cursor, floor: cursor, sent: new Map() };
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    response.write(`retry: 3000\n: cursor ${cursor.toString()}\n\n`);

    let closed = false;
    let polling = false;
    const poll = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        const events = await pollInboxEvents(this.db, actor, state);
        for (const event of events) if (!closed) response.write(formatSseEvent(event));
      } catch {
        this.logger.warn(`Falha ao ler inbox_events (userId=${actor.userId})`);
      } finally {
        polling = false;
      }
    };
    const pollTimer = setInterval(() => void poll(), ssePollIntervalMs());
    const heartbeatTimer = setInterval(() => {
      if (!closed) response.write(': ping\n\n');
    }, SSE_HEARTBEAT_MS);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      clearTimeout(maxTimer);
    };
    const maxTimer = setTimeout(() => {
      close();
      response.end();
    }, SSE_MAX_CONNECTION_MS);
    request.on('close', close);
    response.on('close', close);
    void poll();
  }
}
