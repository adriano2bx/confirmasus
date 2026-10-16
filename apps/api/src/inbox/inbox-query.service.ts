import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@confirma/database';
import { canPerform, type InboxActor } from '@confirma/domain';
import { INBOX_PRISMA } from './inbox.constants.js';
import type { ListConversationsQueryDto, MarkReadDto, TimelineQueryDto } from './inbox.dto.js';
import {
  beforeCursorWhere,
  buildConversationWhere,
  clampLimit,
  decodeCursor,
  encodeCursor,
  mergeTimeline,
  TERMINAL_CONVOCATION_STATUSES,
} from './inbox.helpers.js';
import {
  assertInboxAccess,
  buildSummaries,
  loadActor,
  SUMMARY_SELECT,
  type Db,
  type RequestUser,
} from './inbox-summary.js';

/** Busca a conversa e exige permissão de visualização; inexistente ou invisível => 404. */
export async function findVisibleConversation(db: Db, actor: InboxActor, conversationId: string) {
  const row = await db.conversation.findUnique({
    where: { id: conversationId },
    select: SUMMARY_SELECT,
  });
  if (!row || !canPerform(actor, 'view', row)) {
    throw new NotFoundException('Conversa não encontrada');
  }
  return row;
}

const CONVOCATION_CONTEXT_SELECT = {
  id: true,
  status: true,
  stage: true,
  nextActionAt: true,
  humanHoldAt: true,
  humanHoldConversationId: true,
  patientId: true,
  patient: { select: { id: true, displayName: true } },
  campaign: { select: { id: true, name: true } },
} as const;

@Injectable()
export class InboxQueryService {
  constructor(@Inject(INBOX_PRISMA) private readonly db: PrismaClient) {}

  async actor(user: RequestUser): Promise<InboxActor> {
    const actor = await loadActor(this.db, user);
    assertInboxAccess(actor);
    return actor;
  }

  async me(user: RequestUser) {
    const memberships = await this.db.teamMember.findMany({
      where: { userId: user.sub, team: { active: true } },
      select: { role: true, team: { select: { id: true, name: true } } },
      orderBy: { team: { name: 'asc' } },
    });
    return {
      userId: user.sub,
      globalRole: user.role,
      teams: memberships.map((item) => ({
        id: item.team.id,
        name: item.team.name,
        role: item.role,
      })),
    };
  }

  async list(user: RequestUser, query: ListConversationsQueryDto) {
    const actor = await this.actor(user);
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const where = buildConversationWhere(
      actor,
      {
        view: query.view,
        teamId: query.teamId,
        assigneeId: query.assigneeId,
        status: query.status,
        q: query.q,
        priority: query.priority,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
      },
      cursor,
    );
    if (!where) return { items: [], nextCursor: null };
    const rows = await this.db.conversation.findMany({
      where,
      select: SUMMARY_SELECT,
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: await buildSummaries(this.db, actor, page),
      nextCursor:
        rows.length > limit && last ? encodeCursor({ at: last.lastActivityAt, id: last.id }) : null,
    };
  }

  async detail(user: RequestUser, conversationId: string) {
    const actor = await this.actor(user);
    const row = await findVisibleConversation(this.db, actor, conversationId);
    const [summary] = await buildSummaries(this.db, actor, [row]);
    const linked = await this.db.conversationContext.findMany({
      where: { conversationId },
      select: {
        source: true,
        createdAt: true,
        linkedById: true,
        convocation: { select: CONVOCATION_CONTEXT_SELECT },
      },
      orderBy: { createdAt: 'asc' },
    });
    const linkedIds = linked.map((item) => item.convocation.id);
    // Candidatos: mesmo telefone selecionado, NÃO vinculados. Exigem seleção humana.
    const candidates = await this.db.convocation.findMany({
      where: {
        status: { notIn: [...TERMINAL_CONVOCATION_STATUSES] },
        selectedPhone: { normalizedValue: row.contact.waId },
        ...(linkedIds.length ? { id: { notIn: linkedIds } } : {}),
      },
      select: CONVOCATION_CONTEXT_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const convocationIds = new Set([...linkedIds, ...candidates.map((item) => item.id)]);
    const patientIds = new Set([
      ...linked.map((item) => item.convocation.patientId),
      ...candidates.map((item) => item.patientId),
    ]);
    return {
      ...summary,
      contexts: linked.map((item) => ({
        ...mapConvocation(item.convocation),
        source: item.source,
        linkedAt: item.createdAt,
        linkedById: item.linkedById,
      })),
      candidates: candidates.map(mapConvocation),
      ambiguous: convocationIds.size > 1 || patientIds.size > 1,
    };
  }

  async timeline(user: RequestUser, conversationId: string, query: TimelineQueryDto) {
    const actor = await this.actor(user);
    await findVisibleConversation(this.db, actor, conversationId);
    const limit = clampLimit(query.limit, 30);
    const cursorWhere = beforeCursorWhere(decodeCursor(query.cursor));
    const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
    const [messages, notes, activities] = await Promise.all([
      this.db.conversationMessage.findMany({
        where: { conversationId, ...cursorWhere },
        orderBy,
        take: limit + 1,
        select: {
          id: true,
          direction: true,
          kind: true,
          status: true,
          contentType: true,
          body: true,
          replyEligibility: true,
          eligibilityReason: true,
          providerTimestamp: true,
          sentAt: true,
          deliveredAt: true,
          readAt: true,
          failedAt: true,
          failureCode: true,
          createdAt: true,
          author: { select: { id: true, name: true } },
          campaignMessage: {
            select: {
              id: true,
              templateName: true,
              stage: true,
              attemptNumber: true,
              status: true,
              sentAt: true,
              deliveredAt: true,
              readAt: true,
              failedAt: true,
              convocationId: true,
            },
          },
          media: {
            select: {
              id: true,
              status: true,
              declaredMimeType: true,
              detectedMimeType: true,
              sizeBytes: true,
            },
          },
        },
      }),
      this.db.conversationNote.findMany({
        where: { conversationId, ...cursorWhere },
        orderBy,
        take: limit + 1,
        select: {
          id: true,
          body: true,
          createdAt: true,
          author: { select: { id: true, name: true } },
        },
      }),
      this.db.conversationActivity.findMany({
        where: { conversationId, ...cursorWhere },
        orderBy,
        take: limit + 1,
        select: {
          id: true,
          type: true,
          fromTeamId: true,
          toTeamId: true,
          fromUserId: true,
          toUserId: true,
          reason: true,
          metadata: true,
          createdAt: true,
          actor: { select: { id: true, name: true } },
        },
      }),
    ]);
    const messageItems = messages.map(({ kind: messageKind, ...item }) => ({
      kind: 'message' as const,
      messageKind,
      ...item,
    }));
    const noteItems = notes.map((item) => ({ kind: 'note' as const, ...item }));
    const activityItems = activities.map((item) => ({ kind: 'activity' as const, ...item }));
    return mergeTimeline([messageItems, noteItems, activityItems], limit);
  }

  /** Prévia da automação pausada por esta conversa (convocações em hold e envios vencidos). */
  async automation(user: RequestUser, conversationId: string, now = new Date()) {
    const actor = await this.actor(user);
    const row = await findVisibleConversation(this.db, actor, conversationId);
    const held = await this.db.convocation.findMany({
      where: { humanHoldConversationId: conversationId, humanHoldAt: { not: null } },
      select: CONVOCATION_CONTEXT_SELECT,
      orderBy: { humanHoldAt: 'asc' },
    });
    return {
      conversationId,
      version: row.version,
      canResume: canPerform(actor, 'resume_automation', row),
      paused: held.map((item) => ({
        ...mapConvocation(item),
        overdue: item.nextActionAt !== null && item.nextActionAt.getTime() <= now.getTime(),
      })),
    };
  }

  async markRead(user: RequestUser, conversationId: string, input: MarkReadDto) {
    const actor = await this.actor(user);
    await findVisibleConversation(this.db, actor, conversationId);
    let lastReadAt = new Date();
    if (input.lastReadMessageId) {
      const message = await this.db.conversationMessage.findFirst({
        where: { id: input.lastReadMessageId, conversationId },
        select: { createdAt: true },
      });
      if (!message) throw new NotFoundException('Mensagem não encontrada nesta conversa');
      lastReadAt = message.createdAt;
    }
    const lastReadMessageId = input.lastReadMessageId ?? null;
    await this.db.conversationReadState.upsert({
      where: { conversationId_userId: { conversationId, userId: actor.userId } },
      create: { conversationId, userId: actor.userId, lastReadAt, lastReadMessageId },
      update: { lastReadAt, lastReadMessageId },
    });
  }
}

function mapConvocation(item: {
  id: string;
  status: string;
  stage: string;
  nextActionAt: Date | null;
  humanHoldAt: Date | null;
  humanHoldConversationId: string | null;
  patient: { id: string; displayName: string };
  campaign: { id: string; name: string };
}) {
  return {
    convocationId: item.id,
    status: item.status,
    stage: item.stage,
    nextActionAt: item.nextActionAt,
    humanHoldAt: item.humanHoldAt,
    humanHoldConversationId: item.humanHoldConversationId,
    patient: item.patient,
    campaign: item.campaign,
  };
}
