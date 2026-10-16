import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@confirma/database';
import {
  HUMAN_REPLY_BLOCK_LABELS,
  visibleTeamIds,
  type HumanReplyBlockReason,
  type InboxActor,
} from '@confirma/domain';

/**
 * Funções puras do inbox (sem banco), testadas em inbox.helpers.test.ts.
 * Contrato: docs/planning/whatsapp-human-inbox-contract.md (seção 7).
 */

/** Convocações nesses estados não recebem mais envios: não entram em pausa nem em candidatos. */
export const TERMINAL_CONVOCATION_STATUSES = [
  'CONFIRMED',
  'CANCELLED',
  'FINISHED_NO_RESPONSE',
  'SEND_ERROR',
] as const;

export const MAX_PAGE_LIMIT = 50;
export const MAX_UNREAD_COUNT = 99;

export const CONVERSATION_VIEWS = [
  'unassigned',
  'mine',
  'team',
  'waiting_contact',
  'snoozed',
  'resolved',
  'all',
] as const;
export type ConversationView = (typeof CONVERSATION_VIEWS)[number];

export interface KeysetCursor {
  at: Date;
  id: string;
}

/** Cursor opaco (base64url) sobre (data, id). */
export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.at.toISOString(), i: cursor.id })).toString(
    'base64url',
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(value: string | undefined | null): KeysetCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) throw new Error('cursor');
    const { t, i } = parsed as { t?: unknown; i?: unknown };
    if (typeof t !== 'string' || typeof i !== 'string' || !UUID_PATTERN.test(i)) {
      throw new Error('cursor');
    }
    const at = new Date(t);
    if (Number.isNaN(at.getTime())) throw new Error('cursor');
    return { at, id: i.toLowerCase() };
  } catch {
    throw new BadRequestException('Cursor inválido');
  }
}

/** Mascara o wa_id para listas: mantém DDI (2) e os 4 últimos dígitos. */
export function maskWaId(waId: string): string {
  const digits = waId.replace(/\D/g, '');
  if (digits.length <= 6) return '*'.repeat(digits.length);
  return `${digits.slice(0, 2)}${'*'.repeat(digits.length - 6)}${digits.slice(-4)}`;
}

export function clampLimit(limit: number | undefined, fallback = 20): number {
  if (!limit || !Number.isFinite(limit)) return fallback;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.trunc(limit)));
}

export interface ConversationFilters {
  view?: ConversationView | undefined;
  teamId?: string | undefined;
  assigneeId?: string | undefined;
  status?: 'OPEN' | 'WAITING_CONTACT' | 'SNOOZED' | 'RESOLVED' | undefined;
  q?: string | undefined;
  priority?: number | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

/**
 * Monta o where da listagem já restrito às equipes visíveis do ator.
 * Retorna null quando o filtro pedido está fora da visibilidade (resultado vazio).
 */
export function buildConversationWhere(
  actor: InboxActor,
  filters: ConversationFilters,
  cursor: KeysetCursor | null,
): Prisma.ConversationWhereInput | null {
  const visible = visibleTeamIds(actor);
  const and: Prisma.ConversationWhereInput[] = [];

  if (filters.teamId) {
    if (visible !== null && !visible.includes(filters.teamId)) return null;
    and.push({ teamId: filters.teamId });
  } else if (visible !== null) {
    if (visible.length === 0) return null;
    and.push({ teamId: { in: visible } });
  }

  switch (filters.view ?? 'team') {
    case 'unassigned':
      and.push({ assigneeId: null, status: { not: 'RESOLVED' } });
      break;
    case 'mine':
      and.push({ assigneeId: actor.userId, status: { not: 'RESOLVED' } });
      break;
    case 'team':
      and.push({ status: { not: 'RESOLVED' } });
      break;
    case 'waiting_contact':
      and.push({ status: 'WAITING_CONTACT' });
      break;
    case 'snoozed':
      and.push({ status: 'SNOOZED' });
      break;
    case 'resolved':
      and.push({ status: 'RESOLVED' });
      break;
    case 'all':
      break;
  }

  if (filters.status) and.push({ status: filters.status });
  if (filters.assigneeId) and.push({ assigneeId: filters.assigneeId });
  if (filters.priority !== undefined) and.push({ priority: filters.priority });
  if (filters.from || filters.to) {
    and.push({
      lastActivityAt: {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      },
    });
  }

  const search = filters.q?.trim();
  if (search) {
    if (/^ATD-/i.test(search)) {
      and.push({ protocol: { startsWith: search.toUpperCase() } });
    } else {
      const digits = search.replace(/\D/g, '');
      if (digits.length < 4) {
        throw new BadRequestException(
          'Busque pelo protocolo ou por ao menos 4 dígitos do WhatsApp',
        );
      }
      and.push({ contact: { waId: { contains: digits } } });
    }
  }

  if (cursor) {
    and.push({
      OR: [
        { lastActivityAt: { lt: cursor.at } },
        { lastActivityAt: cursor.at, id: { lt: cursor.id } },
      ],
    });
  }

  return and.length ? { AND: and } : {};
}

/** Filtro keyset (createdAt, id) desc para itens da timeline. */
export function beforeCursorWhere(cursor: KeysetCursor | null): {
  OR?: Array<{ createdAt: { lt: Date } } | { createdAt: Date; id: { lt: string } }>;
} {
  if (!cursor) return {};
  return {
    OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }],
  };
}

export interface TimelineEntry {
  kind: 'message' | 'note' | 'activity';
  id: string;
  createdAt: Date;
}

/** Ordem desc por (createdAt, id) — a mesma usada pelos índices e pelo cursor. */
export function compareDesc(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
) {
  const diff = b.createdAt.getTime() - a.createdAt.getTime();
  if (diff !== 0) return diff;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Mescla as três fontes (cada uma já buscada com limit+1 após o cursor) e devolve
 * a página e o próximo cursor.
 */
export function mergeTimeline<S extends TimelineEntry[][]>(
  sources: [...S],
  limit: number,
): { items: Array<S[number][number]>; nextCursor: string | null } {
  const merged: Array<S[number][number]> = sources.flat().sort(compareDesc);
  const items = merged.slice(0, limit);
  const last = items.at(-1);
  const nextCursor =
    merged.length > limit && last ? encodeCursor({ at: last.createdAt, id: last.id }) : null;
  return { items, nextCursor };
}

/** Motivos de bloqueio do envio humano com rótulo em português para a UI. */
export function describeBlockReasons(reasons: readonly HumanReplyBlockReason[]) {
  return reasons.map((code) => ({ code, label: HUMAN_REPLY_BLOCK_LABELS[code] }));
}

/** canPerform('reply') falso para membro implica não ser o responsável: garante o motivo. */
export function replyBlockReasons(
  policyReasons: readonly HumanReplyBlockReason[],
  canReply: boolean,
): HumanReplyBlockReason[] {
  const reasons = [...policyReasons];
  if (!canReply && !reasons.includes('NOT_ASSIGNEE')) reasons.push('NOT_ASSIGNEE');
  return reasons;
}

/** Linha SSE: só tipo e IDs; BigInt como string. */
export function formatSseEvent(event: {
  id: bigint;
  type: string;
  conversationId: string;
  entityId: string | null;
}): string {
  const id = event.id.toString();
  const data = JSON.stringify({
    id,
    type: event.type,
    conversationId: event.conversationId,
    entityId: event.entityId,
  });
  return `id: ${id}\ndata: ${data}\n\n`;
}

/** Last-Event-ID / ?cursor= → BigInt; ausente = null; inválido = 400. */
export function parseStreamCursor(value: string | string[] | undefined | null): bigint | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') return null;
  if (!/^\d{1,19}$/.test(raw)) throw new BadRequestException('Cursor de eventos inválido');
  return BigInt(raw);
}

/** Slug simples para equipes: minúsculas, sem acento, hífens. */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Actor que não é ADMIN nem membro de equipe não acessa o inbox. */
export function hasInboxAccess(actor: InboxActor): boolean {
  return actor.globalRole === 'ADMIN' || actor.teams.size > 0;
}
