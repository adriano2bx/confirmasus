import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Helpers transacionais compartilhados do inbox (API, worker e backfill).
 * Contrato: docs/planning/whatsapp-human-inbox-contract.md
 */

type Tx = Prisma.TransactionClient;

export type InboxEventTypeName =
  | 'conversation.created'
  | 'conversation.updated'
  | 'message.created'
  | 'message.updated'
  | 'note.created'
  | 'activity.created';

/** Grava no feed monotônico usado pelo SSE. Chamar NA MESMA transação da mudança. */
export async function appendInboxEvent(
  tx: Tx,
  input: {
    conversationId: string;
    teamId: string | null;
    type: InboxEventTypeName;
    entityId?: string | null;
  },
): Promise<void> {
  await tx.inboxEvent.create({
    data: {
      conversationId: input.conversationId,
      teamId: input.teamId,
      type: input.type,
      entityId: input.entityId ?? null,
    },
  });
}

/** Próximo protocolo ATD-AAAA-NNNNNNNN (sequência PostgreSQL, sem PII). */
export async function allocateProtocol(tx: Tx, at: Date = new Date()): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ value: bigint }>>(
    Prisma.sql`SELECT nextval('conversation_protocol_seq') AS value`,
  );
  const value = rows[0]?.value;
  if (value === undefined) throw new Error('Sequência de protocolo indisponível');
  return `ATD-${at.getUTCFullYear()}-${value.toString().padStart(8, '0')}`;
}

export async function defaultTeamId(tx: Tx): Promise<string | null> {
  const team = await tx.team.findFirst({
    where: { isDefault: true, active: true },
    select: { id: true },
  });
  return team?.id ?? null;
}

export async function upsertContact(
  tx: Tx,
  input: { waId: string; profileName?: string | null },
): Promise<{ id: string; waId: string }> {
  const waId = input.waId.replace(/\D/g, '');
  if (waId.length < 8) throw new Error('wa_id inválido');
  return tx.whatsAppContact.upsert({
    where: { waId },
    update: input.profileName ? { profileName: input.profileName.slice(0, 120) } : {},
    create: { waId, profileName: input.profileName?.slice(0, 120) ?? null },
    select: { id: true, waId: true },
  });
}

export interface ActiveConversationResult {
  conversation: {
    id: string;
    teamId: string | null;
    assigneeId: string | null;
    status: string;
    protocol: string;
  };
  created: boolean;
}

/**
 * Retorna a conversa ativa (não RESOLVED) do contato no número empresarial, criando
 * uma nova (novo protocolo, fila padrão) se não houver. A unicidade é garantida pelo
 * índice parcial `conversations_one_active_per_contact_number`; em corrida, a
 * transação perdedora recebe P2002 e deve ser repetida pelo chamador
 * (use `withActiveConversationRetry`).
 */
export async function findOrCreateActiveConversation(
  tx: Tx,
  input: { contactId: string; phoneNumberId: string; at: Date; actorId?: string | null },
): Promise<ActiveConversationResult> {
  const select = {
    id: true,
    teamId: true,
    assigneeId: true,
    status: true,
    protocol: true,
  } as const;
  const existing = await tx.conversation.findFirst({
    where: {
      contactId: input.contactId,
      phoneNumberId: input.phoneNumberId,
      status: { not: 'RESOLVED' },
    },
    select,
  });
  if (existing) return { conversation: existing, created: false };
  const teamId = await defaultTeamId(tx);
  const conversation = await tx.conversation.create({
    data: {
      protocol: await allocateProtocol(tx, input.at),
      contactId: input.contactId,
      phoneNumberId: input.phoneNumberId,
      teamId,
      status: 'OPEN',
      lastActivityAt: input.at,
    },
    select,
  });
  await tx.conversationActivity.create({
    data: {
      conversationId: conversation.id,
      actorId: input.actorId ?? null,
      type: 'CONVERSATION_OPENED',
      toTeamId: teamId,
    },
  });
  await appendInboxEvent(tx, {
    conversationId: conversation.id,
    teamId,
    type: 'conversation.created',
    entityId: conversation.id,
  });
  return { conversation, created: true };
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Executa a transação repetindo em conflito de unicidade (corrida na criação de conversa). */
export async function withActiveConversationRetry<T>(
  client: PrismaClient,
  work: (tx: Tx) => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await client.$transaction(work);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** Bloqueio pessimista da conversa dentro da transação (serializa por conversa). */
export async function lockConversation(tx: Tx, conversationId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM conversations WHERE id = ${conversationId}::uuid FOR UPDATE`,
  );
}
