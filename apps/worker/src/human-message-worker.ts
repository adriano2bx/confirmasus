import { randomUUID } from 'node:crypto';
import {
  appendInboxEvent,
  lockConversation,
  prisma as defaultPrisma,
  type ConversationMessageStatus,
  type Prisma,
  type PrismaClient,
} from '@confirma/database';
import {
  canPerform,
  evaluateHumanReplyPolicy,
  monotonicMax,
  nextOutboundStatus,
  type InboxActor,
} from '@confirma/domain';
import { humanMessageJobId, type SendHumanMessageJob, type SendPermit } from '@confirma/queue';
import type { Job, JobsOptions, Queue } from 'bullmq';
import {
  WhatsAppApiError,
  acquireMetaSendPermit,
  deferJobForSendPermit,
  sendMetaText,
} from './meta-whatsapp-client.js';

/**
 * Sender de mensagens humanas do inbox (ADR-23). Contrato:
 * docs/planning/whatsapp-human-inbox-contract.md, seção 5.
 *
 * - Lê somente `conversation_messages` kind HUMAN_TEXT. Notas internas
 *   (`conversation_notes`) nunca são consultadas aqui e nunca chegam à Meta.
 * - Revalida a regra de produto com `evaluateHumanReplyPolicy` (conversa e contato
 *   relidos sob lock) e `canPerform('reply')` com as equipes atuais do autor,
 *   imediatamente antes da chamada à Meta. Bloqueado => BLOCKED, nada é enviado.
 * - Nunca envia template: só texto de sessão.
 * - Falha ambígua (o request pode ter chegado à Meta) => UNKNOWN sem retry;
 *   reconciliação pelo status webhook via `biz_opaque_callback_data`.
 */

export interface HumanSenderDeps {
  prisma: PrismaClient;
  acquirePermit: (phoneNumberId: string, priority: 'human' | 'campaign') => Promise<SendPermit>;
  sendText: typeof sendMetaText;
  mode: () => string;
  now: () => Date;
  /** Token do job BullMQ: permite adiar por limite de envio sem consumir tentativa. */
  token?: string;
}

/** Motivos de bloqueio do sender além dos da política de domínio. */
export type SenderOnlyBlockReason = 'NO_AUTHOR' | 'AUTHOR_INACTIVE' | 'NOT_TEAM_MEMBER';

export const HUMAN_MESSAGE_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: 1_000,
  removeOnFail: 1_000,
};

type Tx = Prisma.TransactionClient;

type SendOutcome =
  | { kind: 'submitted'; waMessageId: string }
  | { kind: 'unknown'; error: WhatsAppApiError }
  | { kind: 'failed'; error: WhatsAppApiError }
  | { kind: 'retry'; error: WhatsAppApiError };

function defaultDeps(): HumanSenderDeps {
  return {
    prisma: defaultPrisma,
    acquirePermit: acquireMetaSendPermit,
    sendText: sendMetaText,
    mode: () => process.env.MESSAGING_MODE ?? 'DRY_RUN',
    now: () => new Date(),
  };
}

export async function processHumanMessage(
  job: Job<SendHumanMessageJob>,
  overrides: Partial<HumanSenderDeps> = {},
): Promise<void> {
  const deps: HumanSenderDeps = { ...defaultDeps(), ...overrides };
  const db = deps.prisma;
  const id = job.data.conversationMessageId;

  const claimed = await db.conversationMessage.updateMany({
    where: { id, kind: 'HUMAN_TEXT', status: 'QUEUED' },
    data: { status: 'PROCESSING' },
  });
  if (claimed.count === 0) return;

  const message = await db.conversationMessage.findFirst({
    where: { id, kind: 'HUMAN_TEXT' },
    select: {
      id: true,
      conversationId: true,
      authorId: true,
      body: true,
      conversation: { select: { phoneNumberId: true } },
    },
  });
  if (!message) return;

  // Limiter antes da revalidação: o gate é avaliado depois de qualquer espera,
  // imediatamente antes da chamada à Meta.
  let permit: SendPermit;
  try {
    permit = await deps.acquirePermit(message.conversation.phoneNumberId, 'human');
  } catch (error) {
    await requeue(db, id);
    throw error;
  }
  if (!permit.granted) {
    await requeue(db, id);
    await deferJobForSendPermit(job, deps.token, permit.retryAfterMs);
  }

  const gate = await db.$transaction(async (tx) => {
    await lockConversation(tx, message.conversationId);
    const current = await tx.conversationMessage.findFirst({
      where: { id, kind: 'HUMAN_TEXT' },
      select: { status: true },
    });
    if (current?.status !== 'PROCESSING') return { kind: 'skip' as const };
    const conversation = await tx.conversation.findUnique({
      where: { id: message.conversationId },
      select: {
        id: true,
        teamId: true,
        assigneeId: true,
        status: true,
        phoneNumberId: true,
        lastEligibleInboundAt: true,
        contact: { select: { waId: true, optedOutAt: true, blockedAt: true } },
      },
    });
    if (!conversation) return { kind: 'skip' as const };
    const reasons = await evaluateSenderGate(tx, conversation, message.authorId, deps.now());
    if (reasons.length > 0) {
      await tx.conversationMessage.updateMany({
        where: { id, status: 'PROCESSING' },
        data: {
          status: 'BLOCKED',
          failureCode: 'HUMAN_REPLY_BLOCKED',
          failureReason: reasons.join(','),
        },
      });
      const activity = await tx.conversationActivity.create({
        data: {
          conversationId: conversation.id,
          actorId: message.authorId,
          type: 'HUMAN_SEND_BLOCKED',
          metadata: { conversationMessageId: id, reasons },
        },
        select: { id: true },
      });
      await appendInboxEvent(tx, {
        conversationId: conversation.id,
        teamId: conversation.teamId,
        type: 'message.updated',
        entityId: id,
      });
      await appendInboxEvent(tx, {
        conversationId: conversation.id,
        teamId: conversation.teamId,
        type: 'activity.created',
        entityId: activity.id,
      });
      return { kind: 'blocked' as const };
    }
    return {
      kind: 'allowed' as const,
      waId: conversation.contact.waId,
      phoneNumberId: conversation.phoneNumberId,
    };
  });
  if (gate.kind !== 'allowed') return;

  const outcome = await send(job, deps, {
    id,
    body: message.body,
    waId: gate.waId,
    phoneNumberId: gate.phoneNumberId,
  });
  await recordOutcome(db, id, message.authorId, outcome, deps.now());
  if (outcome.kind === 'retry') throw outcome.error;
}

/** Regra de produto (domínio) + RBAC atual do autor. Lista vazia = permitido. */
async function evaluateSenderGate(
  tx: Tx,
  conversation: {
    teamId: string | null;
    assigneeId: string | null;
    status: string;
    lastEligibleInboundAt: Date | null;
    contact: { optedOutAt: Date | null; blockedAt: Date | null };
  },
  authorId: string | null,
  now: Date,
): Promise<string[]> {
  const policy = evaluateHumanReplyPolicy(
    {
      lastEligibleInboundAt: conversation.lastEligibleInboundAt,
      contactOptedOutAt: conversation.contact.optedOutAt,
      contactBlockedAt: conversation.contact.blockedAt,
      conversationStatus: conversation.status,
      assigneeId: conversation.assigneeId,
      actorId: authorId,
    },
    now,
  );
  const reasons: string[] = [...policy.reasons];
  if (!authorId) {
    reasons.push('NO_AUTHOR' satisfies SenderOnlyBlockReason);
    return reasons;
  }
  const author = await tx.user.findUnique({
    where: { id: authorId },
    select: {
      role: true,
      active: true,
      deletedAt: true,
      teamMemberships: { select: { teamId: true, role: true } },
    },
  });
  if (!author || !author.active || author.deletedAt) {
    reasons.push('AUTHOR_INACTIVE' satisfies SenderOnlyBlockReason);
    return reasons;
  }
  const actor: InboxActor = {
    userId: authorId,
    globalRole: author.role,
    teams: new Map(author.teamMemberships.map((member) => [member.teamId, member.role])),
  };
  const target = { teamId: conversation.teamId, assigneeId: conversation.assigneeId };
  if (!canPerform(actor, 'reply', target) && !reasons.includes('NOT_ASSIGNEE')) {
    reasons.push('NOT_TEAM_MEMBER' satisfies SenderOnlyBlockReason);
  }
  return reasons;
}

async function send(
  job: Job<SendHumanMessageJob>,
  deps: HumanSenderDeps,
  input: { id: string; body: string | null; waId: string; phoneNumberId: string },
): Promise<SendOutcome> {
  const mode = deps.mode();
  try {
    const text = input.body?.trim() ?? '';
    if (!text) throw new WhatsAppApiError('Mensagem humana vazia.', 'INVALID_TEXT', false);
    if (mode === 'DRY_RUN') {
      return { kind: 'submitted', waMessageId: `dry-run-human-${randomUUID()}` };
    }
    if (mode !== 'LIVE') {
      throw new WhatsAppApiError('MESSAGING_MODE deve ser DRY_RUN ou LIVE.', 'INVALID_MODE', false);
    }
    const result = await deps.sendText({
      destination: input.waId,
      text,
      bizOpaqueCallbackData: input.id,
      phoneNumberId: input.phoneNumberId,
    });
    return { kind: 'submitted', waMessageId: result.providerMessageId };
  } catch (error) {
    // Erro inesperado durante o envio: não há como saber se saiu; trata como ambíguo.
    const providerError =
      error instanceof WhatsAppApiError
        ? error
        : new WhatsAppApiError('Falha inesperada ao enviar.', 'UNEXPECTED_ERROR', true, true);
    if (providerError.ambiguous) return { kind: 'unknown', error: providerError };
    const attempts = job.opts.attempts ?? 1;
    if (providerError.retryable && job.attemptsMade + 1 < attempts) {
      return { kind: 'retry', error: providerError };
    }
    return { kind: 'failed', error: providerError };
  }
}

async function recordOutcome(
  db: PrismaClient,
  id: string,
  authorId: string | null,
  outcome: SendOutcome,
  now: Date,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const current = await tx.conversationMessage.findFirst({
      where: { id, kind: 'HUMAN_TEXT' },
      select: {
        status: true,
        conversation: { select: { id: true, teamId: true, lastOutboundAt: true } },
      },
    });
    if (!current) return;
    const conversation = current.conversation;
    const events: Array<{
      type: 'message.updated' | 'activity.created' | 'conversation.updated';
      entityId: string;
    }> = [{ type: 'message.updated', entityId: id }];

    if (outcome.kind === 'submitted') {
      await tx.conversationMessage.update({
        where: { id },
        data: {
          status: nextOutboundStatus(current.status, 'SUBMITTED') as ConversationMessageStatus,
          waMessageId: outcome.waMessageId,
          submittedAt: now,
          failureCode: null,
          failureReason: null,
        },
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          lastOutboundAt: monotonicMax(conversation.lastOutboundAt, now),
          lastActivityAt: now,
        },
      });
      events.push({ type: 'conversation.updated', entityId: conversation.id });
    } else if (outcome.kind === 'unknown') {
      await tx.conversationMessage.update({
        where: { id },
        data: {
          status: nextOutboundStatus(current.status, 'UNKNOWN') as ConversationMessageStatus,
          failureCode: outcome.error.code,
          failureReason: outcome.error.message.slice(0, 300),
        },
      });
      const activity = await tx.conversationActivity.create({
        data: {
          conversationId: conversation.id,
          actorId: authorId,
          type: 'HUMAN_SEND_UNKNOWN',
          metadata: { conversationMessageId: id, code: outcome.error.code },
        },
        select: { id: true },
      });
      events.push({ type: 'activity.created', entityId: activity.id });
    } else if (outcome.kind === 'failed') {
      await tx.conversationMessage.update({
        where: { id },
        data: {
          status: nextOutboundStatus(current.status, 'FAILED') as ConversationMessageStatus,
          failedAt: now,
          failureCode: outcome.error.code,
          failureReason: outcome.error.message.slice(0, 300),
        },
      });
    } else {
      // A Meta respondeu (429/5xx/transitório) ou a conexão nem abriu: nada foi aceito.
      await tx.conversationMessage.updateMany({
        where: { id, status: 'PROCESSING' },
        data: {
          status: 'QUEUED',
          failureCode: outcome.error.code,
          failureReason: outcome.error.message.slice(0, 300),
        },
      });
    }
    for (const event of events) {
      await appendInboxEvent(tx, {
        conversationId: conversation.id,
        teamId: conversation.teamId,
        type: event.type,
        entityId: event.entityId,
      });
    }
  });
}

async function requeue(db: PrismaClient, id: string): Promise<void> {
  await db.conversationMessage.updateMany({
    where: { id, kind: 'HUMAN_TEXT', status: 'PROCESSING' },
    data: { status: 'QUEUED' },
  });
}

export async function enqueueHumanMessageJob(
  queue: Pick<Queue<SendHumanMessageJob>, 'add'>,
  conversationMessageId: string,
): Promise<void> {
  await queue.add(
    'send-human-message',
    { conversationMessageId },
    { ...HUMAN_MESSAGE_JOB_OPTIONS, jobId: humanMessageJobId(conversationMessageId) },
  );
}

export interface SweepHumanMessagesOptions {
  prisma?: PrismaClient;
  now?: Date;
  /** QUEUED parado há mais que isso é republicado (outbox). Padrão 10 s. */
  queuedOlderThanMs?: number;
  /** PROCESSING parado há mais que isso (worker caiu) vira UNKNOWN, sem retry. Padrão 120 s. */
  processingStaleAfterMs?: number;
  limit?: number;
}

/**
 * Outbox do envio humano: a API publica o job em best-effort; aqui republicamos
 * QUEUED antigos (jobId determinístico evita duplicata). Jobs já concluídos/falhos
 * com a mensagem ainda QUEUED são removidos e recriados. PROCESSING órfão (worker
 * caiu durante o envio) pode ter saído: vira UNKNOWN + HUMAN_SEND_UNKNOWN, sem reenvio.
 */
export async function sweepQueuedHumanMessages(
  queue: Pick<Queue<SendHumanMessageJob>, 'add' | 'getJob'>,
  options: SweepHumanMessagesOptions = {},
): Promise<{ published: number; markedUnknown: number }> {
  const db = options.prisma ?? defaultPrisma;
  const now = options.now ?? new Date();
  const limit = options.limit ?? 100;
  const queuedBefore = new Date(now.getTime() - (options.queuedOlderThanMs ?? 10_000));
  const staleBefore = new Date(now.getTime() - (options.processingStaleAfterMs ?? 120_000));

  let published = 0;
  const queued = await db.conversationMessage.findMany({
    where: { kind: 'HUMAN_TEXT', status: 'QUEUED', updatedAt: { lt: queuedBefore } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  for (const item of queued) {
    const job = await queue.getJob(humanMessageJobId(item.id));
    if (job) {
      const state = await job.getState();
      if (state === 'completed' || state === 'failed') await job.remove();
      else if (state !== 'unknown') continue;
    }
    await enqueueHumanMessageJob(queue, item.id);
    published += 1;
  }

  let markedUnknown = 0;
  const stale = await db.conversationMessage.findMany({
    where: { kind: 'HUMAN_TEXT', status: 'PROCESSING', updatedAt: { lt: staleBefore } },
    select: { id: true, authorId: true, conversation: { select: { id: true, teamId: true } } },
    take: limit,
  });
  for (const item of stale) {
    const changed = await db.$transaction(async (tx) => {
      const updated = await tx.conversationMessage.updateMany({
        where: { id: item.id, status: 'PROCESSING', updatedAt: { lt: staleBefore } },
        data: { status: 'UNKNOWN', failureCode: 'SENDER_STALLED' },
      });
      if (updated.count === 0) return false;
      const activity = await tx.conversationActivity.create({
        data: {
          conversationId: item.conversation.id,
          actorId: item.authorId,
          type: 'HUMAN_SEND_UNKNOWN',
          metadata: { conversationMessageId: item.id, code: 'SENDER_STALLED' },
        },
        select: { id: true },
      });
      await appendInboxEvent(tx, {
        conversationId: item.conversation.id,
        teamId: item.conversation.teamId,
        type: 'message.updated',
        entityId: item.id,
      });
      await appendInboxEvent(tx, {
        conversationId: item.conversation.id,
        teamId: item.conversation.teamId,
        type: 'activity.created',
        entityId: activity.id,
      });
      return true;
    });
    if (changed) markedUnknown += 1;
  }
  return { published, markedUnknown };
}
