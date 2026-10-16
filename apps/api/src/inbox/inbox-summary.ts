import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@confirma/database';
import {
  evaluateHumanReplyPolicy,
  type HumanReplyBlockReason,
  type InboxActor,
  type TeamRole,
} from '@confirma/domain';
import { hasInboxAccess, maskWaId, MAX_UNREAD_COUNT } from './inbox.helpers.js';

export type Db = Prisma.TransactionClient;

export interface RequestUser {
  sub: string;
  role: 'ADMIN' | 'OPERATOR';
}

/** Papéis do usuário a partir de TeamMember (somente equipes ativas). */
export async function loadActor(db: Db, user: RequestUser): Promise<InboxActor> {
  const memberships = await db.teamMember.findMany({
    where: { userId: user.sub, team: { active: true } },
    select: { teamId: true, role: true },
  });
  return {
    userId: user.sub,
    globalRole: user.role,
    teams: new Map<string, TeamRole>(memberships.map((item) => [item.teamId, item.role])),
  };
}

export function assertInboxAccess(actor: InboxActor): void {
  if (!hasInboxAccess(actor)) {
    throw new ForbiddenException('Seu usuário não pertence a nenhuma equipe de atendimento');
  }
}

export const SUMMARY_SELECT = {
  id: true,
  protocol: true,
  status: true,
  priority: true,
  version: true,
  teamId: true,
  assigneeId: true,
  phoneNumberId: true,
  lastActivityAt: true,
  lastInboundAt: true,
  lastEligibleInboundAt: true,
  snoozedUntil: true,
  team: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
  contact: {
    select: { id: true, waId: true, profileName: true, optedOutAt: true, blockedAt: true },
  },
} satisfies Prisma.ConversationSelect;

export type SummaryRow = Prisma.ConversationGetPayload<{ select: typeof SUMMARY_SELECT }>;

export interface ConversationSummary {
  id: string;
  protocol: string;
  status: SummaryRow['status'];
  priority: number;
  version: number;
  team: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  contact: { id: string; waIdMasked: string; profileName: string | null; optedOut: boolean };
  phoneNumberId: string;
  lastActivityAt: Date;
  lastInboundAt: Date | null;
  snoozedUntil: Date | null;
  unreadCount: number;
  automationPaused: boolean;
  replyPolicy: { allowed: boolean; reasons: HumanReplyBlockReason[]; windowExpiresAt: Date | null };
}

/** Monta o summary (pura). replyPolicy é avaliada para o usuário que consulta. */
export function toSummary(
  row: SummaryRow,
  actor: InboxActor,
  extra: { unreadCount: number; automationPaused: boolean },
  now: Date = new Date(),
): ConversationSummary {
  const policy = evaluateHumanReplyPolicy(
    {
      lastEligibleInboundAt: row.lastEligibleInboundAt,
      contactOptedOutAt: row.contact.optedOutAt,
      contactBlockedAt: row.contact.blockedAt,
      conversationStatus: row.status,
      assigneeId: row.assigneeId,
      actorId: actor.userId,
    },
    now,
  );
  return {
    id: row.id,
    protocol: row.protocol,
    status: row.status,
    priority: row.priority,
    version: row.version,
    team: row.team,
    assignee: row.assignee,
    contact: {
      id: row.contact.id,
      waIdMasked: maskWaId(row.contact.waId),
      profileName: row.contact.profileName,
      optedOut: row.contact.optedOutAt !== null,
    },
    phoneNumberId: row.phoneNumberId,
    lastActivityAt: row.lastActivityAt,
    lastInboundAt: row.lastInboundAt,
    snoozedUntil: row.snoozedUntil,
    unreadCount: Math.min(MAX_UNREAD_COUNT, extra.unreadCount),
    automationPaused: extra.automationPaused,
    replyPolicy: policy,
  };
}

/** Não lidos (INBOUND após o último lido do usuário), limitado a 99 por conversa. */
export async function unreadCounts(
  db: Db,
  userId: string,
  conversationIds: string[],
): Promise<Map<string, number>> {
  if (!conversationIds.length) return new Map();
  const rows = await db.$queryRaw<Array<{ id: string; unread: number }>>(Prisma.sql`
    SELECT c.id::text AS id,
      (SELECT COUNT(*)::int FROM (
        SELECT 1 FROM conversation_messages m
        WHERE m.conversation_id = c.id
          AND m.direction = 'INBOUND'
          AND m.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)
        LIMIT ${MAX_UNREAD_COUNT}
      ) s) AS unread
    FROM unnest(${conversationIds}::uuid[]) AS c(id)
    LEFT JOIN conversation_read_states r
      ON r.conversation_id = c.id AND r.user_id = ${userId}::uuid
  `);
  return new Map(rows.map((row) => [row.id, Number(row.unread)]));
}

export async function pausedConversationIds(
  db: Db,
  conversationIds: string[],
): Promise<Set<string>> {
  if (!conversationIds.length) return new Set();
  const rows = await db.convocation.findMany({
    where: { humanHoldConversationId: { in: conversationIds }, humanHoldAt: { not: null } },
    select: { humanHoldConversationId: true },
    distinct: ['humanHoldConversationId'],
  });
  return new Set(
    rows.flatMap((row) => (row.humanHoldConversationId ? [row.humanHoldConversationId] : [])),
  );
}

export async function buildSummaries(
  db: Db,
  actor: InboxActor,
  rows: SummaryRow[],
  now: Date = new Date(),
): Promise<ConversationSummary[]> {
  const ids = rows.map((row) => row.id);
  const [unread, paused] = await Promise.all([
    unreadCounts(db, actor.userId, ids),
    pausedConversationIds(db, ids),
  ]);
  return rows.map((row) =>
    toSummary(
      row,
      actor,
      { unreadCount: unread.get(row.id) ?? 0, automationPaused: paused.has(row.id) },
      now,
    ),
  );
}

export async function loadSummary(
  db: Db,
  actor: InboxActor,
  conversationId: string,
): Promise<ConversationSummary | null> {
  const row = await db.conversation.findUnique({
    where: { id: conversationId },
    select: SUMMARY_SELECT,
  });
  if (!row) return null;
  const [summary] = await buildSummaries(db, actor, [row]);
  return summary ?? null;
}
