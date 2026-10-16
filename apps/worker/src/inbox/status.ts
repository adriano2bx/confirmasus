import {
  appendInboxEvent,
  Prisma,
  prisma,
  type ConversationMessageStatus,
} from '@confirma/database';
import { nextOutboundStatus } from '@confirma/domain';
import { stringValue, type JsonRecord } from '../webhook-events.js';

export type ProviderStatusUpdate =
  | { status: 'SUBMITTED' | 'SENT' | 'DELIVERED' | 'READ'; at: Date }
  | { status: 'FAILED'; at: Date; failureCode: string; failureReason: string };

export function statusUpdate(
  status: string,
  at: Date,
  details: JsonRecord,
): ProviderStatusUpdate | null {
  if (status === 'enqueued') return { status: 'SUBMITTED', at };
  if (status === 'sent') return { status: 'SENT', at };
  if (status === 'delivered') return { status: 'DELIVERED', at };
  if (status === 'read') return { status: 'READ', at };
  if (status === 'failed') {
    return {
      status: 'FAILED',
      at,
      failureCode: textValue(details.code) ?? 'META_FAILED',
      failureReason: textValue(details.reason) ?? 'Falha reportada pelo provedor',
    };
  }
  return null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `biz_opaque_callback_data` do envio humano = conversation_messages.id (uuid). */
export function conversationMessageIdFromBizOpaque(value: unknown): string | null {
  const text = stringValue(value)?.trim();
  return text && UUID_PATTERN.test(text) ? text.toLowerCase() : null;
}

export interface OutboundConversationMessageState {
  status: string;
  waMessageId: string | null;
  submittedAt: Date | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failedAt: Date | null;
}

/**
 * Patch de status de mensagem humana: não regride (nextOutboundStatus), preenche carimbos
 * uma única vez e reconcilia UNKNOWN preenchendo o WAMID quando o status chega por bizOpaque.
 * Retorna null quando o WAMID recebido conflita com o já gravado.
 */
export function conversationMessageStatusPatch(
  current: OutboundConversationMessageState,
  update: ProviderStatusUpdate,
  waMessageId: string,
) {
  if (current.waMessageId && current.waMessageId !== waMessageId) return null;
  const status = nextOutboundStatus(current.status, update.status);
  const at = update.at;
  return {
    status,
    ...(current.waMessageId ? {} : { waMessageId }),
    ...(update.status === 'SUBMITTED' ? { submittedAt: current.submittedAt ?? at } : {}),
    ...(update.status === 'SENT' ? { sentAt: current.sentAt ?? at } : {}),
    ...(update.status === 'DELIVERED' ? { deliveredAt: current.deliveredAt ?? at } : {}),
    ...(update.status === 'READ'
      ? { readAt: current.readAt ?? at, deliveredAt: current.deliveredAt ?? at }
      : {}),
    ...(update.status === 'FAILED' && status === 'FAILED'
      ? {
          failedAt: current.failedAt ?? at,
          failureCode: update.failureCode.slice(0, 100),
          failureReason: update.failureReason.slice(0, 500),
        }
      : {}),
  };
}

/** Localiza mensagem de saída do inbox por WAMID ou por bizOpaque (id da linha). */
export async function findOutboundConversationMessage(
  waMessageId: string,
  bizOpaque: unknown,
): Promise<{ id: string } | null> {
  const byOpaque = conversationMessageIdFromBizOpaque(bizOpaque);
  return prisma.conversationMessage.findFirst({
    where: {
      direction: 'OUTBOUND',
      OR: [{ waMessageId }, ...(byOpaque ? [{ id: byOpaque }] : [])],
    },
    select: { id: true },
  });
}

/**
 * Aplica status Meta a uma mensagem humana do inbox (SELECT FOR UPDATE da linha).
 * Status de mensagem humana nunca altera convocação. Retorna false se o WAMID conflitar.
 */
export async function applyConversationMessageStatus(
  transaction: Prisma.TransactionClient,
  conversationMessageId: string,
  update: ProviderStatusUpdate,
  waMessageId: string,
): Promise<boolean> {
  await transaction.$queryRaw(
    Prisma.sql`SELECT id FROM conversation_messages WHERE id = ${conversationMessageId}::uuid FOR UPDATE`,
  );
  const current = await transaction.conversationMessage.findUniqueOrThrow({
    where: { id: conversationMessageId },
    include: { conversation: { select: { id: true, teamId: true } } },
  });
  const patch = conversationMessageStatusPatch(current, update, waMessageId);
  if (!patch) return false;
  await transaction.conversationMessage.update({
    where: { id: current.id },
    data: { ...patch, status: patch.status as ConversationMessageStatus },
  });
  await appendInboxEvent(transaction, {
    conversationId: current.conversation.id,
    teamId: current.conversation.teamId,
    type: 'message.updated',
    entityId: current.id,
  });
  return true;
}

function textValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return stringValue(value);
}
