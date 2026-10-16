import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Consultas de integridade do inbox (somente leitura, só contagens; nunca conteúdo,
 * telefone ou nome). Usadas por verify-inbox-integrity.ts e pelo relatório do backfill.
 * Contrato: docs/planning/whatsapp-human-inbox-contract.md
 */

export const BACKFILL_MARKER = 'BACKFILL_HISTORICAL';
export const BACKFILL_RESPONSE_KEY_PREFIX = 'backfill:response:';

export interface IntegrityCheck {
  name: string;
  description: string;
  /** violation: deve ser 0, senão exit code != 0. warning: apenas informativo. */
  severity: 'violation' | 'warning';
  count: number;
}

interface CheckDefinition {
  name: string;
  description: string;
  severity: IntegrityCheck['severity'];
  sql: Prisma.Sql;
}

const SENT_STATUSES = Prisma.sql`('SUBMITTED','SENT','DELIVERED','READ')`;

const CHECKS: CheckDefinition[] = [
  {
    name: 'duplicate_wa_message_id',
    description: 'conversation_messages com waMessageId repetido',
    severity: 'violation',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM (
      SELECT wa_message_id FROM conversation_messages WHERE wa_message_id IS NOT NULL
      GROUP BY wa_message_id HAVING count(*) > 1) d`,
  },
  {
    name: 'duplicate_campaign_message_id',
    description: 'CAMPAIGN_REF repetida para a mesma linha de messages',
    severity: 'violation',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM (
      SELECT campaign_message_id FROM conversation_messages WHERE campaign_message_id IS NOT NULL
      GROUP BY campaign_message_id HAVING count(*) > 1) d`,
  },
  {
    name: 'duplicate_active_conversations',
    description: 'mais de uma conversa ativa (não RESOLVED) por contato + número',
    severity: 'violation',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM (
      SELECT contact_id, phone_number_id FROM conversations WHERE status <> 'RESOLVED'
      GROUP BY contact_id, phone_number_id HAVING count(*) > 1) d`,
  },
  {
    name: 'duplicate_backfill_conversations',
    description: 'mais de uma conversa histórica do backfill por contato + número',
    severity: 'violation',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM (
      SELECT c.contact_id, c.phone_number_id FROM conversations c
      JOIN conversation_activities a ON a.conversation_id = c.id
        AND a.type = 'CONVERSATION_OPENED' AND a.reason = ${BACKFILL_MARKER}
      GROUP BY c.contact_id, c.phone_number_id HAVING count(DISTINCT c.id) > 1) d`,
  },
  {
    name: 'human_sent_without_eligibility',
    description:
      'HUMAN_TEXT enviada (SUBMITTED/SENT/DELIVERED/READ) em conversa sem lastEligibleInboundAt',
    severity: 'violation',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM conversation_messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.kind = 'HUMAN_TEXT' AND m.status IN ${SENT_STATUSES}
        AND c.last_eligible_inbound_at IS NULL`,
  },
  {
    name: 'human_sent_without_eligible_inbound',
    description: 'HUMAN_TEXT enviada em conversa sem nenhum INBOUND ELIGIBLE_TEMPLATE_REPLY',
    severity: 'violation',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM conversation_messages m
      WHERE m.kind = 'HUMAN_TEXT' AND m.status IN ${SENT_STATUSES}
        AND NOT EXISTS (SELECT 1 FROM conversation_messages i
          WHERE i.conversation_id = m.conversation_id AND i.kind = 'INBOUND'
            AND i.reply_eligibility = 'ELIGIBLE_TEMPLATE_REPLY')`,
  },
  {
    name: 'human_sent_without_author',
    description: 'HUMAN_TEXT sem autor (todo envio humano precisa de responsável)',
    severity: 'violation',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM conversation_messages
      WHERE kind = 'HUMAN_TEXT' AND author_id IS NULL`,
  },
  {
    name: 'eligible_window_without_eligible_inbound',
    description: 'conversa com lastEligibleInboundAt sem INBOUND elegível correspondente',
    severity: 'violation',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM conversations c
      WHERE c.last_eligible_inbound_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM conversation_messages i
          WHERE i.conversation_id = c.id AND i.kind = 'INBOUND'
            AND i.reply_eligibility = 'ELIGIBLE_TEMPLATE_REPLY')`,
  },
  {
    name: 'eligible_inbound_without_context',
    description: 'INBOUND marcado elegível sem context.id ou sem template referenciado',
    severity: 'violation',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM conversation_messages
      WHERE kind = 'INBOUND' AND reply_eligibility = 'ELIGIBLE_TEMPLATE_REPLY'
        AND (context_wa_message_id IS NULL OR replied_campaign_message_id IS NULL)`,
  },
  {
    name: 'backfill_granted_eligibility',
    description: 'INBOUND de backfill marcado como elegível (histórico nunca concede permissão)',
    severity: 'violation',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM conversation_messages
      WHERE idempotency_key LIKE ${`${BACKFILL_RESPONSE_KEY_PREFIX}%`}
        AND (reply_eligibility IS DISTINCT FROM 'NOT_ELIGIBLE'
          OR eligibility_reason IS DISTINCT FROM ${BACKFILL_MARKER})`,
  },
  {
    name: 'backfill_conversation_reopened',
    description: 'conversa histórica do backfill fora de RESOLVED (reabertura manual)',
    severity: 'warning',
    sql: Prisma.sql`SELECT count(DISTINCT c.id)::bigint AS count FROM conversations c
      JOIN conversation_activities a ON a.conversation_id = c.id
        AND a.type = 'CONVERSATION_OPENED' AND a.reason = ${BACKFILL_MARKER}
      WHERE c.status <> 'RESOLVED'`,
  },
  {
    name: 'template_reply_context_without_eligible_inbound',
    description:
      'ConversationContext TEMPLATE_REPLY sem INBOUND elegível que responda a template da convocação',
    severity: 'violation',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM conversation_contexts x
      WHERE x.source = 'TEMPLATE_REPLY' AND NOT EXISTS (
        SELECT 1 FROM conversation_messages i JOIN messages t ON t.id = i.replied_campaign_message_id
        WHERE i.conversation_id = x.conversation_id AND i.kind = 'INBOUND'
          AND i.reply_eligibility = 'ELIGIBLE_TEMPLATE_REPLY' AND t.convocation_id = x.convocation_id)`,
  },
  {
    name: 'campaign_ref_without_message',
    description: 'CAMPAIGN_REF sem campaignMessageId (referência órfã)',
    severity: 'violation',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM conversation_messages
      WHERE kind = 'CAMPAIGN_REF' AND campaign_message_id IS NULL`,
  },
  {
    name: 'campaign_ref_contact_mismatch',
    description: 'CAMPAIGN_REF em conversa de contato diferente do telefone da linha de messages',
    severity: 'violation',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM conversation_messages m
      JOIN messages t ON t.id = m.campaign_message_id
      JOIN conversations c ON c.id = m.conversation_id
      JOIN whatsapp_contacts w ON w.id = c.contact_id
      WHERE m.kind = 'CAMPAIGN_REF' AND regexp_replace(t.phone, '\\D', '', 'g') <> w.wa_id`,
  },
  {
    name: 'note_copied_to_message',
    description:
      'HUMAN_TEXT com mesmo texto de nota interna da conversa criada em até 60 s (possível vazamento de nota)',
    severity: 'warning',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM conversation_messages m
      WHERE m.kind = 'HUMAN_TEXT' AND EXISTS (SELECT 1 FROM conversation_notes n
        WHERE n.conversation_id = m.conversation_id AND n.body = m.body
          AND abs(extract(epoch FROM (m.created_at - n.created_at))) <= 60)`,
  },
  {
    name: 'conversations_without_messages',
    description: 'conversas sem nenhuma mensagem na timeline',
    severity: 'warning',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM conversations c
      WHERE NOT EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id)`,
  },
  {
    name: 'contacts_without_conversation',
    description: 'contatos WhatsApp sem conversa',
    severity: 'warning',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM whatsapp_contacts w
      WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id = w.id)`,
  },
  {
    name: 'media_without_message',
    description: 'media_assets apontando para mensagem inexistente',
    severity: 'violation',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM media_assets a
      WHERE NOT EXISTS (SELECT 1 FROM conversation_messages m WHERE m.id = a.conversation_message_id)`,
  },
  {
    name: 'human_messages_unknown',
    description: 'HUMAN_TEXT em UNKNOWN aguardando reconciliação manual',
    severity: 'warning',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM conversation_messages
      WHERE kind = 'HUMAN_TEXT' AND status = 'UNKNOWN'`,
  },
  {
    name: 'webhook_dead_letters',
    description: 'message_events em DEAD_LETTER',
    severity: 'warning',
    sql: Prisma.sql`SELECT count(*)::bigint AS count FROM message_events
      WHERE processing_status = 'DEAD_LETTER'`,
  },
];

export async function runIntegrityChecks(client: PrismaClient): Promise<IntegrityCheck[]> {
  const results: IntegrityCheck[] = [];
  for (const check of CHECKS) {
    results.push({
      name: check.name,
      description: check.description,
      severity: check.severity,
      count: await countQuery(client, check.sql),
    });
  }
  return results;
}

export async function countQuery(client: PrismaClient, sql: Prisma.Sql): Promise<number> {
  const rows = await client.$queryRaw<Array<{ count: bigint | number }>>(sql);
  return Number(rows[0]?.count ?? 0);
}

export const TABLE_TOTALS = [
  'whatsapp_contacts',
  'conversations',
  'conversation_messages',
  'conversation_contexts',
  'conversation_activities',
  'inbox_events',
  'messages',
  'message_responses',
  'convocations',
  'billing_events',
] as const;

/** Totais por tabela (para relatório antes/depois). Nomes fixos, sem interpolação de entrada. */
export async function tableTotals(client: PrismaClient): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const table of TABLE_TOTALS) {
    totals[table] = await countQuery(
      client,
      Prisma.sql`SELECT count(*)::bigint AS count FROM ${Prisma.raw(`"${table}"`)}`,
    );
  }
  return totals;
}

/** Remove dígitos longos (telefones/ids) de mensagens de erro antes de imprimir. */
export function minimizeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.replace(/\d{6,}/g, '[digitos]').slice(0, 300);
}
