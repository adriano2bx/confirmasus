import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  appendInboxEvent,
  isUniqueViolation,
  lockConversation,
  type Prisma,
  type PrismaClient,
} from '@confirma/database';
import {
  canPerform,
  canTransition,
  evaluateHumanReplyPolicy,
  type ConversationStatusValue,
  type HumanReplyBlockReason,
  type InboxAction,
  type InboxActor,
} from '@confirma/domain';
import { humanMessageJobId, type SendHumanMessageJob } from '@confirma/queue';
import type { Queue } from 'bullmq';
import { HUMAN_MESSAGE_QUEUE, INBOX_PRISMA, QUEUE_PUBLISH_TIMEOUT_MS } from './inbox.constants.js';
import type {
  AssignConversationDto,
  ContactOptOutDto,
  CreateNoteDto,
  LinkContextDto,
  ResumeAutomationDto,
  SendHumanMessageDto,
  TransferConversationDto,
  UpdateConversationPriorityDto,
  UpdateConversationStatusDto,
} from './inbox.dto.js';
import {
  describeBlockReasons,
  replyBlockReasons,
  TERMINAL_CONVOCATION_STATUSES,
} from './inbox.helpers.js';
import { findVisibleConversation } from './inbox-query.service.js';
import {
  assertInboxAccess,
  loadActor,
  loadSummary,
  type ConversationSummary,
  type Db,
  type RequestUser,
  type SummaryRow,
} from './inbox-summary.js';

class VersionConflict extends Error {}

const HUMAN_MESSAGE_SELECT = {
  id: true,
  conversationId: true,
  direction: true,
  kind: true,
  status: true,
  contentType: true,
  body: true,
  authorId: true,
  idempotencyKey: true,
  createdAt: true,
} satisfies Prisma.ConversationMessageSelect;

type HumanMessage = Prisma.ConversationMessageGetPayload<{ select: typeof HUMAN_MESSAGE_SELECT }>;

type SendResult =
  | { kind: 'queued'; message: HumanMessage; created: boolean }
  | { kind: 'blocked'; reasons: HumanReplyBlockReason[] };

/**
 * Convocações ativas a pausar quando a conversa é assumida/atribuída: vinculadas por
 * ConversationContext E com telefone selecionado igual ao wa_id (supressão operacional,
 * não vínculo clínico). Não sobrescreve pausa de outra conversa.
 */
export async function pauseAutomation(
  tx: Db,
  input: { conversationId: string; waId: string; actorId: string; now: Date },
): Promise<string[]> {
  const targets = await tx.convocation.findMany({
    where: {
      status: { notIn: [...TERMINAL_CONVOCATION_STATUSES] },
      humanHoldAt: null,
      OR: [
        { conversationContexts: { some: { conversationId: input.conversationId } } },
        { selectedPhone: { normalizedValue: input.waId } },
      ],
    },
    select: { id: true },
  });
  if (!targets.length) return [];
  const ids = targets.map((item) => item.id);
  await tx.convocation.updateMany({
    where: { id: { in: ids }, humanHoldAt: null },
    data: { humanHoldAt: input.now, humanHoldConversationId: input.conversationId },
  });
  await tx.conversationActivity.create({
    data: {
      conversationId: input.conversationId,
      actorId: input.actorId,
      type: 'AUTOMATION_PAUSED',
      metadata: { convocationIds: ids },
    },
  });
  return ids;
}

@Injectable()
export class InboxActionsService {
  private readonly logger = new Logger(InboxActionsService.name);

  constructor(
    @Inject(INBOX_PRISMA) private readonly db: PrismaClient,
    @Inject(HUMAN_MESSAGE_QUEUE) private readonly queue: Queue<SendHumanMessageJob>,
  ) {}

  private async actor(user: RequestUser): Promise<InboxActor> {
    const actor = await loadActor(this.db, user);
    assertInboxAccess(actor);
    return actor;
  }

  /**
   * Transição de estado: lock da conversa, visibilidade (404), versão (409), permissão (403),
   * trabalho, version+1, lastActivityAt e evento SSE na mesma transação.
   */
  private async transition(
    user: RequestUser,
    conversationId: string,
    version: number,
    action: InboxAction | null,
    work: (
      tx: Db,
      row: SummaryRow,
      actor: InboxActor,
      now: Date,
    ) => Promise<{ teamIds?: (string | null)[] } | void>,
  ): Promise<ConversationSummary> {
    const actor = await this.actor(user);
    try {
      await this.db.$transaction(async (tx) => {
        await lockConversation(tx, conversationId);
        const row = await findVisibleConversation(tx, actor, conversationId);
        if (row.version !== version) throw new VersionConflict();
        if (action && !canPerform(actor, action, row)) {
          throw new ForbiddenException('Você não tem permissão para esta ação nesta conversa');
        }
        const now = new Date();
        const result = await work(tx, row, actor, now);
        const updated = await tx.conversation.update({
          where: { id: conversationId },
          data: { version: { increment: 1 }, lastActivityAt: now },
          select: { teamId: true },
        });
        const teamIds = new Set<string | null>([updated.teamId, ...(result?.teamIds ?? [])]);
        for (const teamId of teamIds) {
          await appendInboxEvent(tx, {
            conversationId,
            teamId,
            type: 'conversation.updated',
            entityId: conversationId,
          });
        }
      });
    } catch (error) {
      if (error instanceof VersionConflict) {
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          message: 'A conversa foi alterada por outra pessoa. Atualize e tente novamente.',
          conversation: await loadSummary(this.db, actor, conversationId),
        });
      }
      throw error;
    }
    const summary = await loadSummary(this.db, actor, conversationId);
    if (!summary) throw new NotFoundException('Conversa não encontrada');
    return summary;
  }

  claim(user: RequestUser, conversationId: string, version: number) {
    return this.transition(user, conversationId, version, null, async (tx, row, actor, now) => {
      if (row.status === 'RESOLVED') {
        throw new UnprocessableEntityException({
          code: 'CONVERSATION_RESOLVED',
          message: 'Conversa resolvida não pode ser assumida; reabra antes.',
        });
      }
      if (!canPerform(actor, 'claim', row)) {
        throw new ForbiddenException(
          row.assigneeId ? 'A conversa já tem responsável' : 'Você não pode assumir esta conversa',
        );
      }
      await tx.conversation.update({ where: { id: row.id }, data: { assigneeId: actor.userId } });
      await tx.conversationActivity.create({
        data: {
          conversationId: row.id,
          actorId: actor.userId,
          type: 'ASSIGNED',
          fromTeamId: row.teamId,
          toTeamId: row.teamId,
          fromUserId: null,
          toUserId: actor.userId,
          metadata: { via: 'claim' },
        },
      });
      await pauseAutomation(tx, {
        conversationId: row.id,
        waId: row.contact.waId,
        actorId: actor.userId,
        now,
      });
    });
  }

  assign(user: RequestUser, conversationId: string, input: AssignConversationDto) {
    return this.transition(
      user,
      conversationId,
      input.version,
      'assign',
      async (tx, row, actor, now) => {
        if (row.status === 'RESOLVED') {
          throw new UnprocessableEntityException({
            code: 'CONVERSATION_RESOLVED',
            message: 'Conversa resolvida não pode ser atribuída; reabra antes.',
          });
        }
        if (!row.teamId)
          throw new BadRequestException('Transfira a conversa para uma equipe antes de atribuir');
        await assertTeamMember(tx, row.teamId, input.assigneeId);
        await tx.conversation.update({
          where: { id: row.id },
          data: { assigneeId: input.assigneeId },
        });
        await tx.conversationActivity.create({
          data: {
            conversationId: row.id,
            actorId: actor.userId,
            type: 'ASSIGNED',
            fromTeamId: row.teamId,
            toTeamId: row.teamId,
            fromUserId: row.assigneeId,
            toUserId: input.assigneeId,
          },
        });
        await pauseAutomation(tx, {
          conversationId: row.id,
          waId: row.contact.waId,
          actorId: actor.userId,
          now,
        });
      },
    );
  }

  transfer(user: RequestUser, conversationId: string, input: TransferConversationDto) {
    return this.transition(
      user,
      conversationId,
      input.version,
      'transfer',
      async (tx, row, actor, now) => {
        const reason = input.reason.trim();
        if (reason.length < 3) throw new BadRequestException('Informe o motivo da transferência');
        if (!input.toTeamId && !input.toUserId) {
          throw new BadRequestException('Informe a equipe ou o usuário de destino');
        }
        if (row.status === 'RESOLVED') {
          throw new UnprocessableEntityException({
            code: 'CONVERSATION_RESOLVED',
            message: 'Conversa resolvida não pode ser transferida; reabra antes.',
          });
        }
        const toTeamId = input.toTeamId ?? row.teamId;
        if (!toTeamId) throw new BadRequestException('Informe a equipe de destino');
        const team = await tx.team.findUnique({
          where: { id: toTeamId },
          select: { active: true },
        });
        if (!team?.active) throw new NotFoundException('Equipe de destino não encontrada');
        const toUserId = input.toUserId ?? null;
        if (toUserId) await assertTeamMember(tx, toTeamId, toUserId);
        if (toTeamId === row.teamId && toUserId === row.assigneeId) {
          throw new BadRequestException('O destino é igual à equipe e ao responsável atuais');
        }
        await tx.conversation.update({
          where: { id: row.id },
          data: { teamId: toTeamId, assigneeId: toUserId },
        });
        await tx.conversationActivity.create({
          data: {
            conversationId: row.id,
            actorId: actor.userId,
            type: 'TRANSFERRED',
            fromTeamId: row.teamId,
            toTeamId,
            fromUserId: row.assigneeId,
            toUserId,
            reason,
          },
        });
        if (toUserId) {
          await pauseAutomation(tx, {
            conversationId: row.id,
            waId: row.contact.waId,
            actorId: actor.userId,
            now,
          });
        }
        // A equipe de origem também recebe o evento (a conversa sai da fila dela).
        return { teamIds: [row.teamId] };
      },
    );
  }

  updateStatus(user: RequestUser, conversationId: string, input: UpdateConversationStatusDto) {
    return this.transition(
      user,
      conversationId,
      input.version,
      null,
      async (tx, row, actor, now) => {
        const from = row.status as ConversationStatusValue;
        const to = input.status;
        if (!canTransition(from, to)) {
          throw new UnprocessableEntityException({
            code: 'INVALID_TRANSITION',
            message: `Transição de ${from} para ${to} não permitida`,
          });
        }
        const reopen = from === 'RESOLVED' && to === 'OPEN';
        const action: InboxAction = reopen ? 'reopen' : to === 'SNOOZED' ? 'snooze' : 'resolve';
        if (!canPerform(actor, action, row)) {
          throw new ForbiddenException(
            'Você não tem permissão para alterar o estado desta conversa',
          );
        }
        let snoozedUntil: Date | null = null;
        if (to === 'SNOOZED') {
          snoozedUntil = input.snoozedUntil ? new Date(input.snoozedUntil) : null;
          if (!snoozedUntil || snoozedUntil.getTime() <= now.getTime()) {
            throw new BadRequestException('Informe uma data futura para adiar');
          }
        }
        try {
          await tx.conversation.update({
            where: { id: row.id },
            data: {
              status: to,
              snoozedUntil,
              // Resolver NÃO retoma a automação: humanHoldAt permanece até resume explícito.
              ...(to === 'RESOLVED' ? { resolvedAt: now } : reopen ? { resolvedAt: null } : {}),
            },
          });
        } catch (error) {
          if (reopen && isUniqueViolation(error)) {
            throw new ConflictException({
              code: 'ACTIVE_CONVERSATION_EXISTS',
              message: 'Já existe outra conversa ativa para este contato e número.',
            });
          }
          throw error;
        }
        await tx.conversationActivity.create({
          data: {
            conversationId: row.id,
            actorId: actor.userId,
            type: reopen ? 'CONVERSATION_REOPENED' : 'STATUS_CHANGED',
            reason: input.reason?.trim() || null,
            metadata: {
              from,
              to,
              ...(snoozedUntil ? { snoozedUntil: snoozedUntil.toISOString() } : {}),
            },
          },
        });
      },
    );
  }

  updatePriority(user: RequestUser, conversationId: string, input: UpdateConversationPriorityDto) {
    // Mesma regra de resolver/adiar: supervisor da equipe ou responsável.
    return this.transition(
      user,
      conversationId,
      input.version,
      'snooze',
      async (tx, row, actor) => {
        await tx.conversation.update({ where: { id: row.id }, data: { priority: input.priority } });
        await tx.conversationActivity.create({
          data: {
            conversationId: row.id,
            actorId: actor.userId,
            type: 'PRIORITY_CHANGED',
            metadata: { from: row.priority, to: input.priority },
          },
        });
      },
    );
  }

  async resumeAutomation(user: RequestUser, conversationId: string, input: ResumeAutomationDto) {
    let resumed: string[] = [];
    const conversation = await this.transition(
      user,
      conversationId,
      input.version,
      'resume_automation',
      async (tx, row, actor, now) => {
        const held = await tx.convocation.findMany({
          where: {
            id: { in: input.convocationIds },
            humanHoldConversationId: row.id,
            humanHoldAt: { not: null },
          },
          select: { id: true, humanHoldAt: true, status: true, nextActionAt: true },
        });
        if (held.length !== input.convocationIds.length) {
          throw new UnprocessableEntityException({
            code: 'CONVOCATION_NOT_HELD',
            message: 'Uma ou mais convocações não estão pausadas por esta conversa',
          });
        }
        await tx.convocation.updateMany({
          where: { id: { in: input.convocationIds }, humanHoldConversationId: row.id },
          data: { humanHoldAt: null, humanHoldConversationId: null },
        });
        await tx.auditLog.createMany({
          data: held.map((item) => ({
            userId: actor.userId,
            eventType: 'INBOX_AUTOMATION_RESUMED',
            entityType: 'convocation',
            entityId: item.id,
            previousData: {
              humanHoldAt: item.humanHoldAt?.toISOString() ?? null,
              humanHoldConversationId: row.id,
            },
            newData: { humanHoldAt: null },
            metadata: {
              conversationId: row.id,
              status: item.status,
              overdue: item.nextActionAt !== null && item.nextActionAt.getTime() <= now.getTime(),
            },
          })),
        });
        await tx.conversationActivity.create({
          data: {
            conversationId: row.id,
            actorId: actor.userId,
            type: 'AUTOMATION_RESUMED',
            metadata: { convocationIds: input.convocationIds },
          },
        });
        resumed = held.map((item) => item.id);
      },
    );
    return { resumedConvocationIds: resumed, conversation };
  }

  /** Nota interna: tabela própria; nunca grava em conversation_messages nem publica fila. */
  async addNote(user: RequestUser, conversationId: string, input: CreateNoteDto) {
    const body = input.body.trim();
    if (!body) throw new BadRequestException('A nota não pode ficar vazia');
    const actor = await this.actor(user);
    const note = await this.db.$transaction(async (tx) => {
      const row = await findVisibleConversation(tx, actor, conversationId);
      if (!canPerform(actor, 'note', row))
        throw new ForbiddenException('Sem permissão para anotar');
      const created = await tx.conversationNote.create({
        data: { conversationId, authorId: actor.userId, body },
        select: {
          id: true,
          body: true,
          createdAt: true,
          author: { select: { id: true, name: true } },
        },
      });
      await appendInboxEvent(tx, {
        conversationId,
        teamId: row.teamId,
        type: 'note.created',
        entityId: created.id,
      });
      return created;
    });
    return { note: { kind: 'note' as const, ...note } };
  }

  /**
   * Envio humano. Gate server-side dentro da transação, após o lock da conversa, com conversa
   * e contato relidos (evaluateHumanReplyPolicy, ator = usuário). Só existe texto livre.
   */
  async sendMessage(user: RequestUser, conversationId: string, input: SendHumanMessageDto) {
    const body = input.body.trim();
    if (!body) throw new BadRequestException('A mensagem não pode ficar vazia');
    const actor = await this.actor(user);
    let result: SendResult;
    try {
      result = await this.db.$transaction(async (tx): Promise<SendResult> => {
        await lockConversation(tx, conversationId);
        const existing = await tx.conversationMessage.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: HUMAN_MESSAGE_SELECT,
        });
        const row = await findVisibleConversation(tx, actor, conversationId);
        if (existing) {
          if (existing.conversationId !== conversationId || existing.authorId !== actor.userId) {
            throw new ConflictException({
              code: 'IDEMPOTENCY_KEY_REUSED',
              message: 'Chave de idempotência já usada em outra mensagem',
            });
          }
          return { kind: 'queued', message: existing, created: false };
        }
        const now = new Date();
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
        const canReply = canPerform(actor, 'reply', row);
        if (!canReply || !policy.allowed) {
          const reasons = replyBlockReasons(policy.reasons, canReply);
          const activity = await tx.conversationActivity.create({
            data: {
              conversationId,
              actorId: actor.userId,
              type: 'HUMAN_SEND_BLOCKED',
              metadata: { reasons, source: 'api' },
            },
            select: { id: true },
          });
          await appendInboxEvent(tx, {
            conversationId,
            teamId: row.teamId,
            type: 'activity.created',
            entityId: activity.id,
          });
          return { kind: 'blocked', reasons };
        }
        const message = await tx.conversationMessage.create({
          data: {
            conversationId,
            direction: 'OUTBOUND',
            kind: 'HUMAN_TEXT',
            status: 'QUEUED',
            contentType: 'text',
            body,
            authorId: actor.userId,
            idempotencyKey: input.idempotencyKey,
          },
          select: HUMAN_MESSAGE_SELECT,
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: { lastActivityAt: now },
        });
        await appendInboxEvent(tx, {
          conversationId,
          teamId: row.teamId,
          type: 'message.created',
          entityId: message.id,
        });
        return { kind: 'queued', message, created: true };
      });
    } catch (error) {
      // Corrida da mesma chave em outra conversa (lock é por conversa): unicidade decide.
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Chave de idempotência já usada em outra mensagem',
        });
      }
      throw error;
    }
    if (result.kind === 'blocked') {
      throw new UnprocessableEntityException({
        code: 'HUMAN_REPLY_BLOCKED',
        message: 'Envio humano bloqueado',
        reasons: result.reasons,
        details: describeBlockReasons(result.reasons),
      });
    }
    if (result.message.status === 'QUEUED') await this.publishHumanMessage(result.message.id);
    return { message: result.message };
  }

  /** Best-effort após o commit: o varredor do worker republica QUEUED antigos. */
  private async publishHumanMessage(conversationMessageId: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.queue.add(
          'send-human-message',
          { conversationMessageId },
          {
            jobId: humanMessageJobId(conversationMessageId),
            removeOnComplete: 1_000,
            removeOnFail: 1_000,
          },
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), QUEUE_PUBLISH_TIMEOUT_MS);
        }),
      ]);
    } catch {
      this.logger.warn(
        `Publicação adiada para o varredor (conversationMessageId=${conversationMessageId})`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async linkContext(user: RequestUser, conversationId: string, input: LinkContextDto) {
    const actor = await this.actor(user);
    await this.db.$transaction(async (tx) => {
      await lockConversation(tx, conversationId);
      const row = await findVisibleConversation(tx, actor, conversationId);
      if (!canPerform(actor, 'link_context', row)) {
        throw new ForbiddenException('Sem permissão para vincular convocações');
      }
      const convocation = await tx.convocation.findUnique({
        where: { id: input.convocationId },
        select: { id: true },
      });
      if (!convocation) throw new NotFoundException('Convocação não encontrada');
      const existing = await tx.conversationContext.findUnique({
        where: {
          conversationId_convocationId: { conversationId, convocationId: input.convocationId },
        },
        select: { source: true },
      });
      if (existing) {
        throw new ConflictException({
          code: 'CONTEXT_ALREADY_LINKED',
          message: 'Convocação já vinculada',
        });
      }
      await tx.conversationContext.create({
        data: {
          conversationId,
          convocationId: input.convocationId,
          source: 'MANUAL',
          linkedById: actor.userId,
        },
      });
      const activity = await tx.conversationActivity.create({
        data: {
          conversationId,
          actorId: actor.userId,
          type: 'CONTEXT_LINKED',
          metadata: { convocationId: input.convocationId, source: 'MANUAL' },
        },
        select: { id: true },
      });
      // Conversa já em atendimento: a convocação vinculada também entra em pausa.
      if (row.assigneeId && row.status !== 'RESOLVED') {
        await pauseAutomation(tx, {
          conversationId,
          waId: row.contact.waId,
          actorId: actor.userId,
          now: new Date(),
        });
      }
      await appendInboxEvent(tx, {
        conversationId,
        teamId: row.teamId,
        type: 'activity.created',
        entityId: activity.id,
      });
    });
  }

  async unlinkContext(user: RequestUser, conversationId: string, convocationId: string) {
    const actor = await this.actor(user);
    await this.db.$transaction(async (tx) => {
      await lockConversation(tx, conversationId);
      const row = await findVisibleConversation(tx, actor, conversationId);
      if (!canPerform(actor, 'link_context', row)) {
        throw new ForbiddenException('Sem permissão para desvincular convocações');
      }
      const removed = await tx.conversationContext.deleteMany({
        where: { conversationId, convocationId },
      });
      if (!removed.count) throw new NotFoundException('Vínculo não encontrado');
      const activity = await tx.conversationActivity.create({
        data: {
          conversationId,
          actorId: actor.userId,
          type: 'CONTEXT_UNLINKED',
          metadata: { convocationId },
        },
        select: { id: true },
      });
      await appendInboxEvent(tx, {
        conversationId,
        teamId: row.teamId,
        type: 'activity.created',
        entityId: activity.id,
      });
    });
  }

  /** Opt-out/opt-in do contato: supervisor de alguma equipe com conversa do contato (ou ADMIN). */
  async setOptOut(user: RequestUser, contactId: string, input: ContactOptOutDto) {
    const actor = await this.actor(user);
    const reason = input.reason.trim();
    if (reason.length < 3) throw new BadRequestException('Informe o motivo');
    await this.db.$transaction(async (tx) => {
      const contact = await tx.whatsAppContact.findUnique({
        where: { id: contactId },
        select: { id: true, optedOutAt: true },
      });
      const conversations = contact
        ? await tx.conversation.findMany({
            where: { contactId },
            select: { id: true, teamId: true, assigneeId: true, status: true },
          })
        : [];
      const visible = conversations.filter((item) => canPerform(actor, 'view', item));
      if (!contact || (actor.globalRole !== 'ADMIN' && !visible.length)) {
        throw new NotFoundException('Contato não encontrado');
      }
      if (
        !visible.some((item) => canPerform(actor, 'set_opt_out', item)) &&
        actor.globalRole !== 'ADMIN'
      ) {
        throw new ForbiddenException('Somente supervisores alteram o opt-out do contato');
      }
      const now = new Date();
      const optedOutAt = input.optedOut ? (contact.optedOutAt ?? now) : null;
      await tx.whatsAppContact.update({ where: { id: contactId }, data: { optedOutAt } });
      await tx.auditLog.create({
        data: {
          userId: actor.userId,
          eventType: input.optedOut ? 'INBOX_CONTACT_OPTED_OUT' : 'INBOX_CONTACT_OPTED_IN',
          entityType: 'whatsapp_contact',
          entityId: contactId,
          previousData: { optedOut: contact.optedOutAt !== null },
          newData: { optedOut: input.optedOut },
          reason,
        },
      });
      for (const conversation of conversations.filter((item) => item.status !== 'RESOLVED')) {
        await tx.conversationActivity.create({
          data: {
            conversationId: conversation.id,
            actorId: actor.userId,
            type: input.optedOut ? 'CONTACT_OPTED_OUT' : 'CONTACT_OPTED_IN',
            reason,
          },
        });
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { lastActivityAt: now },
        });
        await appendInboxEvent(tx, {
          conversationId: conversation.id,
          teamId: conversation.teamId,
          type: 'conversation.updated',
          entityId: conversation.id,
        });
      }
    });
  }
}

/** Destino de atribuição precisa ser usuário ativo e membro da equipe destino. */
async function assertTeamMember(tx: Db, teamId: string, userId: string): Promise<void> {
  const member = await tx.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { user: { select: { active: true, deletedAt: true } } },
  });
  if (!member || !member.user.active || member.user.deletedAt) {
    throw new UnprocessableEntityException({
      code: 'ASSIGNEE_NOT_TEAM_MEMBER',
      message: 'O usuário de destino não é membro ativo da equipe',
    });
  }
}
