/**
 * Backfill do inbox a partir do histórico de campanhas (ADR-18).
 *
 * DRY-RUN por padrão: só lê e imprime relatório JSON agregado (sem PII).
 *   pnpm --filter @confirma/database exec tsx scripts/backfill-inbox.ts
 *
 * Gravação (somente em cópia de staging ou com autorização explícita):
 *   META_WHATSAPP_PHONE_NUMBER_ID=<id> pnpm --filter @confirma/database exec \
 *     tsx scripts/backfill-inbox.ts --apply [--batch-size=500] [--cutoff=2026-10-16T12:00:00Z] \
 *     [--report=/caminho/relatorio.json]
 *
 * O que o --apply grava (idempotente; reexecutar não duplica):
 *   - WhatsAppContact por telefone normalizado (somente dígitos) das mensagens/respostas;
 *   - uma Conversation RESOLVED "histórica" por contato + phone_number_id (marcada pela
 *     atividade CONVERSATION_OPENED com reason BACKFILL_HISTORICAL);
 *   - CAMPAIGN_REF para cada linha de `messages` (único por campaignMessageId);
 *   - INBOUND para cada MessageResponse anterior ao corte, com idempotencyKey
 *     backfill:response:<id>, replyEligibility NOT_ELIGIBLE e eligibilityReason
 *     BACKFILL_HISTORICAL. Histórico NUNCA concede permissão de resposta humana.
 * O que NÃO faz: não cria ConversationContext (sem vínculo automático), não define
 * lastEligibleInboundAt e não altera messages, convocations, message_responses nem billing.
 */
import { PrismaClient, Prisma, type ConversationMessageStatus } from '@prisma/client';
import { writeFile } from 'node:fs/promises';
import { allocateProtocol, appendInboxEvent, defaultTeamId } from '../src/inbox.js';
import {
  BACKFILL_MARKER,
  BACKFILL_RESPONSE_KEY_PREFIX,
  countQuery,
  minimizeError,
  runIntegrityChecks,
  tableTotals,
} from './inbox-integrity.js';

interface Options {
  apply: boolean;
  batchSize: number;
  cutoff: Date | null;
  reportPath: string | null;
}

const LOCK_KEY = 'confirma:backfill-inbox';
const MIN_WA_ID_DIGITS = 8;

function parseOptions(argv: readonly string[]): Options {
  const options: Options = { apply: false, batchSize: 500, cutoff: null, reportPath: null };
  for (const argument of argv) {
    const [flag, value] = argument.split('=', 2);
    if (flag === '--apply') options.apply = true;
    else if (flag === '--dry-run') options.apply = false;
    else if (flag === '--batch-size') {
      const size = Number(value);
      if (!Number.isInteger(size) || size < 1 || size > 5_000) {
        throw new Error('--batch-size deve ser inteiro entre 1 e 5000');
      }
      options.batchSize = size;
    } else if (flag === '--cutoff') {
      const date = new Date(value ?? '');
      if (Number.isNaN(date.getTime())) throw new Error('--cutoff deve ser data ISO válida');
      options.cutoff = date;
    } else if (flag === '--report') {
      if (!value) throw new Error('--report exige caminho');
      options.reportPath = value;
    } else {
      throw new Error(`Argumento desconhecido: ${flag ?? ''}`);
    }
  }
  return options;
}

export function normalizeWaId(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= MIN_WA_ID_DIGITS ? digits : null;
}

/** Uma conexão só: o advisory lock de sessão precisa ficar na mesma conexão. */
function singleConnectionUrl(url: string | undefined): string {
  if (!url) throw new Error('DATABASE_URL não configurada');
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', '1');
  return parsed.toString();
}

const options = parseOptions(process.argv.slice(2));
const defaultPhoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID?.trim() || null;
if (options.apply && !defaultPhoneNumberId) {
  throw new Error('META_WHATSAPP_PHONE_NUMBER_ID é obrigatório com --apply');
}

const client = new PrismaClient({ datasourceUrl: singleConnectionUrl(process.env.DATABASE_URL) });
const startedAt = Date.now();
const phases: Record<string, number> = {};

async function timed<T>(name: string, work: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await work();
  } finally {
    phases[name] = Date.now() - start;
  }
}

/** Corte das respostas: evita duplicar inbound já criado pelo worker ao vivo (sem WAMID no legado). */
async function resolveCutoff(): Promise<{ cutoff: Date; source: string }> {
  if (options.cutoff) return { cutoff: options.cutoff, source: 'argumento --cutoff' };
  const rows = await client.$queryRaw<Array<{ first: Date | null }>>(Prisma.sql`
    SELECT min(created_at) AS first FROM conversation_messages
    WHERE kind = 'INBOUND'
      AND (idempotency_key IS NULL OR idempotency_key NOT LIKE ${`${BACKFILL_RESPONSE_KEY_PREFIX}%`})`);
  const first = rows[0]?.first ?? null;
  if (first) return { cutoff: first, source: 'primeiro INBOUND do worker ao vivo' };
  return { cutoff: new Date(startedAt), source: 'início da execução (sem inbound ao vivo)' };
}

const phoneDigits = (column: Prisma.Sql) => Prisma.sql`regexp_replace(${column}, '\\D', '', 'g')`;

/** CTE com (wa_id, phone_number_id) de mensagens e respostas elegíveis ao backfill. */
function sourcePairsSql(cutoff: Date): Prisma.Sql {
  const numberFallback = defaultPhoneNumberId ?? null;
  return Prisma.sql`
    WITH source_pairs AS (
      SELECT ${phoneDigits(Prisma.sql`m.phone`)} AS wa_id,
             coalesce(m.sender_phone_number_id, ${numberFallback}::text) AS phone_number_id
      FROM messages m
      UNION
      SELECT ${phoneDigits(Prisma.sql`coalesce(msg.phone, pp.normalized_value)`)} AS wa_id,
             coalesce(msg.sender_phone_number_id, ${numberFallback}::text) AS phone_number_id
      FROM message_responses r
      LEFT JOIN messages msg ON msg.id = r.message_id
      JOIN convocations c ON c.id = r.convocation_id
      LEFT JOIN patient_phones pp ON pp.id = c.selected_phone_id
      WHERE r.received_at < ${cutoff}
    ), valid_pairs AS (
      SELECT DISTINCT wa_id, phone_number_id FROM source_pairs
      WHERE length(wa_id) >= ${MIN_WA_ID_DIGITS}
    )`;
}

async function planReport(cutoff: Date) {
  const pairs = sourcePairsSql(cutoff);
  const responseKey = (alias: string) =>
    Prisma.sql`${BACKFILL_RESPONSE_KEY_PREFIX} || ${Prisma.raw(alias)}.id::text`;
  return {
    mensagens_total: await countQuery(
      client,
      Prisma.sql`SELECT count(*)::bigint AS count FROM messages`,
    ),
    mensagens_sem_telefone_valido: await countQuery(
      client,
      Prisma.sql`SELECT count(*)::bigint AS count FROM messages m
        WHERE length(${phoneDigits(Prisma.sql`m.phone`)}) < ${MIN_WA_ID_DIGITS}`,
    ),
    mensagens_legadas_sem_numero_emissor: await countQuery(
      client,
      Prisma.sql`SELECT count(*)::bigint AS count FROM messages WHERE sender_phone_number_id IS NULL`,
    ),
    campaign_ref_existentes: await countQuery(
      client,
      Prisma.sql`SELECT count(*)::bigint AS count FROM conversation_messages WHERE kind = 'CAMPAIGN_REF'`,
    ),
    campaign_ref_a_criar: await countQuery(
      client,
      Prisma.sql`SELECT count(*)::bigint AS count FROM messages m
        WHERE length(${phoneDigits(Prisma.sql`m.phone`)}) >= ${MIN_WA_ID_DIGITS}
          AND NOT EXISTS (SELECT 1 FROM conversation_messages cm WHERE cm.campaign_message_id = m.id)`,
    ),
    contatos_distintos_no_historico: await countQuery(
      client,
      Prisma.sql`${pairs} SELECT count(DISTINCT wa_id)::bigint AS count FROM valid_pairs`,
    ),
    contatos_a_criar: await countQuery(
      client,
      Prisma.sql`${pairs} SELECT count(DISTINCT v.wa_id)::bigint AS count FROM valid_pairs v
        WHERE NOT EXISTS (SELECT 1 FROM whatsapp_contacts w WHERE w.wa_id = v.wa_id)`,
    ),
    conversas_historicas_contato_numero: await countQuery(
      client,
      Prisma.sql`${pairs} SELECT count(*)::bigint AS count FROM valid_pairs WHERE phone_number_id IS NOT NULL`,
    ),
    conversas_historicas_a_criar: await countQuery(
      client,
      Prisma.sql`${pairs} SELECT count(*)::bigint AS count FROM valid_pairs v
        WHERE v.phone_number_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM conversations c
          JOIN whatsapp_contacts w ON w.id = c.contact_id
          JOIN conversation_activities a ON a.conversation_id = c.id
            AND a.type = 'CONVERSATION_OPENED' AND a.reason = ${BACKFILL_MARKER}
          WHERE w.wa_id = v.wa_id AND c.phone_number_id = v.phone_number_id)`,
    ),
    pares_sem_numero_emissor: await countQuery(
      client,
      Prisma.sql`${pairs} SELECT count(*)::bigint AS count FROM valid_pairs WHERE phone_number_id IS NULL`,
    ),
    respostas_legadas_total: await countQuery(
      client,
      Prisma.sql`SELECT count(*)::bigint AS count FROM message_responses`,
    ),
    respostas_legadas_antes_do_corte: await countQuery(
      client,
      Prisma.sql`SELECT count(*)::bigint AS count FROM message_responses WHERE received_at < ${cutoff}`,
    ),
    respostas_ja_migradas: await countQuery(
      client,
      Prisma.sql`SELECT count(*)::bigint AS count FROM conversation_messages
        WHERE idempotency_key LIKE ${`${BACKFILL_RESPONSE_KEY_PREFIX}%`}`,
    ),
    respostas_a_criar: await countQuery(
      client,
      Prisma.sql`SELECT count(*)::bigint AS count FROM message_responses r
        LEFT JOIN messages msg ON msg.id = r.message_id
        JOIN convocations c ON c.id = r.convocation_id
        LEFT JOIN patient_phones pp ON pp.id = c.selected_phone_id
        WHERE r.received_at < ${cutoff}
          AND length(${phoneDigits(Prisma.sql`coalesce(msg.phone, pp.normalized_value)`)}) >= ${MIN_WA_ID_DIGITS}
          AND NOT EXISTS (SELECT 1 FROM conversation_messages cm
            WHERE cm.idempotency_key = ${responseKey('r')})`,
    ),
    respostas_sem_telefone: await countQuery(
      client,
      Prisma.sql`SELECT count(*)::bigint AS count FROM message_responses r
        LEFT JOIN messages msg ON msg.id = r.message_id
        JOIN convocations c ON c.id = r.convocation_id
        LEFT JOIN patient_phones pp ON pp.id = c.selected_phone_id
        WHERE r.received_at < ${cutoff}
          AND length(coalesce(${phoneDigits(Prisma.sql`coalesce(msg.phone, pp.normalized_value)`)}, '')) < ${MIN_WA_ID_DIGITS}`,
    ),
    telefones_com_multiplos_pacientes: await countQuery(
      client,
      Prisma.sql`SELECT count(*)::bigint AS count FROM (
        SELECT pp.normalized_value FROM convocations c
        JOIN patient_phones pp ON pp.id = c.selected_phone_id
        GROUP BY pp.normalized_value HAVING count(DISTINCT c.patient_id) > 1) d`,
    ),
    telefones_com_multiplas_convocacoes: await countQuery(
      client,
      Prisma.sql`SELECT count(*)::bigint AS count FROM (
        SELECT pp.normalized_value FROM convocations c
        JOIN patient_phones pp ON pp.id = c.selected_phone_id
        GROUP BY pp.normalized_value HAVING count(DISTINCT c.id) > 1) d`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

const contactCache = new Map<string, string>();
const conversationCache = new Map<string, string>();
const counters = {
  contatos_criados: 0,
  conversas_criadas: 0,
  campaign_ref_criadas: 0,
  inbound_criados: 0,
  mensagens_ignoradas_sem_telefone: 0,
  respostas_ignoradas_sem_telefone: 0,
  lotes: 0,
};

async function ensureContacts(waIds: readonly string[]): Promise<void> {
  const missing = [...new Set(waIds)].filter((waId) => !contactCache.has(waId));
  if (missing.length === 0) return;
  const created = await client.whatsAppContact.createMany({
    data: missing.map((waId) => ({ waId })),
    skipDuplicates: true,
  });
  counters.contatos_criados += created.count;
  const rows = await client.whatsAppContact.findMany({
    where: { waId: { in: missing } },
    select: { id: true, waId: true },
  });
  for (const row of rows) contactCache.set(row.waId, row.id);
}

async function ensureHistoricalConversation(
  waId: string,
  phoneNumberId: string,
  firstAt: Date,
): Promise<string> {
  const key = `${waId}|${phoneNumberId}`;
  const cached = conversationCache.get(key);
  if (cached) return cached;
  const contactId = contactCache.get(waId);
  if (!contactId) throw new Error('Contato não materializado no lote');
  const existing = await client.conversation.findFirst({
    where: {
      contactId,
      phoneNumberId,
      activities: { some: { type: 'CONVERSATION_OPENED', reason: BACKFILL_MARKER } },
    },
    select: { id: true },
  });
  if (existing) {
    conversationCache.set(key, existing.id);
    return existing.id;
  }
  const now = new Date();
  // Conversa + atividade-marcador + evento na mesma transação: sem marcador órfão em falha.
  const id = await client.$transaction(async (tx) => {
    const teamId = await defaultTeamId(tx);
    const conversation = await tx.conversation.create({
      data: {
        protocol: await allocateProtocol(tx, firstAt),
        contactId,
        phoneNumberId,
        teamId,
        status: 'RESOLVED',
        resolvedAt: now,
        lastActivityAt: firstAt,
      },
      select: { id: true },
    });
    await tx.conversationActivity.create({
      data: {
        conversationId: conversation.id,
        type: 'CONVERSATION_OPENED',
        toTeamId: teamId,
        reason: BACKFILL_MARKER,
        metadata: { backfill: true },
      },
    });
    await appendInboxEvent(tx, {
      conversationId: conversation.id,
      teamId,
      type: 'conversation.created',
      entityId: conversation.id,
    });
    return conversation.id;
  });
  counters.conversas_criadas += 1;
  conversationCache.set(key, id);
  return id;
}

async function backfillCampaignMessages(batchSize: number): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await client.message.findMany({
      where: { ...(cursor ? { id: { gt: cursor } } : {}), timelineEntry: { is: null } },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: {
        id: true,
        phone: true,
        senderPhoneNumberId: true,
        status: true,
        submittedAt: true,
        createdAt: true,
      },
    });
    if (rows.length === 0) return;
    cursor = rows.at(-1)?.id;
    counters.lotes += 1;
    const valid = rows.flatMap((row) => {
      const waId = normalizeWaId(row.phone);
      if (!waId) {
        counters.mensagens_ignoradas_sem_telefone += 1;
        return [];
      }
      const phoneNumberId = row.senderPhoneNumberId ?? (defaultPhoneNumberId as string);
      return [{ row, waId, phoneNumberId, at: row.submittedAt ?? row.createdAt }];
    });
    await ensureContacts(valid.map((item) => item.waId));
    const data: Prisma.ConversationMessageCreateManyInput[] = [];
    for (const item of valid) {
      const conversationId = await ensureHistoricalConversation(
        item.waId,
        item.phoneNumberId,
        item.at,
      );
      data.push({
        conversationId,
        direction: 'OUTBOUND',
        kind: 'CAMPAIGN_REF',
        // Snapshot do estado; a fonte de verdade continua sendo `messages`.
        status: item.row.status as ConversationMessageStatus,
        contentType: 'template',
        body: null,
        campaignMessageId: item.row.id,
        providerTimestamp: item.row.submittedAt,
        createdAt: item.at,
      });
    }
    if (data.length > 0) {
      const created = await client.conversationMessage.createMany({ data, skipDuplicates: true });
      counters.campaign_ref_criadas += created.count;
    }
  }
}

async function backfillResponses(batchSize: number, cutoff: Date): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await client.messageResponse.findMany({
      where: { ...(cursor ? { id: { gt: cursor } } : {}), receivedAt: { lt: cutoff } },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: {
        id: true,
        rawText: true,
        receivedAt: true,
        message: { select: { phone: true, senderPhoneNumberId: true } },
        convocation: { select: { selectedPhone: { select: { normalizedValue: true } } } },
      },
    });
    if (rows.length === 0) return;
    cursor = rows.at(-1)?.id;
    counters.lotes += 1;
    const keys = rows.map((row) => `${BACKFILL_RESPONSE_KEY_PREFIX}${row.id}`);
    const done = new Set(
      (
        await client.conversationMessage.findMany({
          where: { idempotencyKey: { in: keys } },
          select: { idempotencyKey: true },
        })
      ).map((row) => row.idempotencyKey),
    );
    const valid = rows.flatMap((row) => {
      if (done.has(`${BACKFILL_RESPONSE_KEY_PREFIX}${row.id}`)) return [];
      const waId = normalizeWaId(
        row.message?.phone ?? row.convocation.selectedPhone?.normalizedValue,
      );
      if (!waId) {
        counters.respostas_ignoradas_sem_telefone += 1;
        return [];
      }
      const phoneNumberId = row.message?.senderPhoneNumberId ?? (defaultPhoneNumberId as string);
      return [{ row, waId, phoneNumberId }];
    });
    await ensureContacts(valid.map((item) => item.waId));
    const data: Prisma.ConversationMessageCreateManyInput[] = [];
    for (const item of valid) {
      const conversationId = await ensureHistoricalConversation(
        item.waId,
        item.phoneNumberId,
        item.row.receivedAt,
      );
      data.push({
        conversationId,
        direction: 'INBOUND',
        kind: 'INBOUND',
        status: 'RECEIVED',
        contentType: item.row.rawText ? 'text' : 'unknown',
        body: item.row.rawText?.slice(0, 4_096) ?? null,
        // Histórico NUNCA concede permissão: sem context.id/WAMID verificável.
        replyEligibility: 'NOT_ELIGIBLE',
        eligibilityReason: BACKFILL_MARKER,
        idempotencyKey: `${BACKFILL_RESPONSE_KEY_PREFIX}${item.row.id}`,
        providerTimestamp: item.row.receivedAt,
        createdAt: item.row.receivedAt,
      });
    }
    if (data.length > 0) {
      const created = await client.conversationMessage.createMany({ data, skipDuplicates: true });
      counters.inbound_criados += created.count;
    }
  }
}

/** Ajusta datas das conversas históricas. Nunca toca lastEligibleInboundAt. */
async function refreshHistoricalConversations(): Promise<number> {
  return client.$executeRaw(Prisma.sql`
    UPDATE conversations c SET
      last_inbound_at = greatest(c.last_inbound_at, agg.last_inbound),
      last_outbound_at = greatest(c.last_outbound_at, agg.last_outbound),
      last_activity_at = greatest(c.last_activity_at, agg.last_inbound, agg.last_outbound),
      updated_at = now()
    FROM (
      SELECT m.conversation_id,
        max(coalesce(m.provider_timestamp, m.created_at)) FILTER (WHERE m.kind = 'INBOUND') AS last_inbound,
        max(coalesce(m.provider_timestamp, m.created_at)) FILTER (WHERE m.kind = 'CAMPAIGN_REF') AS last_outbound
      FROM conversation_messages m GROUP BY m.conversation_id
    ) agg
    WHERE agg.conversation_id = c.id AND c.status = 'RESOLVED'
      AND EXISTS (SELECT 1 FROM conversation_activities a WHERE a.conversation_id = c.id
        AND a.type = 'CONVERSATION_OPENED' AND a.reason = ${BACKFILL_MARKER})`);
}

async function main(): Promise<void> {
  const { cutoff, source } = await resolveCutoff();
  const before = await timed('totais_antes', () => tableTotals(client));
  const plan = await timed('plano', () => planReport(cutoff));
  const report: Record<string, unknown> = {
    evento: 'backfill_inbox',
    modo: options.apply ? 'APPLY' : 'DRY_RUN',
    corte_respostas: cutoff.toISOString(),
    origem_corte: source,
    numero_emissor_padrao_configurado: Boolean(defaultPhoneNumberId),
    tamanho_lote: options.batchSize,
    plano: plan,
    totais_antes: before,
  };

  if (options.apply) {
    const locked = await client.$queryRaw<Array<{ locked: boolean }>>(
      Prisma.sql`SELECT pg_try_advisory_lock(hashtext(${LOCK_KEY})) AS locked`,
    );
    if (!locked[0]?.locked) throw new Error('Outro backfill do inbox está em execução');
    try {
      await timed('campaign_ref', () => backfillCampaignMessages(options.batchSize));
      await timed('respostas', () => backfillResponses(options.batchSize, cutoff));
      report.conversas_atualizadas = await timed('datas_conversas', refreshHistoricalConversations);
    } finally {
      await client.$queryRaw(Prisma.sql`SELECT pg_advisory_unlock(hashtext(${LOCK_KEY}))`);
    }
    report.resultado = counters;
    report.totais_depois = await timed('totais_depois', () => tableTotals(client));
    const checks = await timed('integridade', () => runIntegrityChecks(client));
    report.verificacao = checks;
    report.violacoes = checks
      .filter((check) => check.severity === 'violation' && check.count > 0)
      .map((check) => check.name);
    // Tabelas de campanha/billing não são escritas pelo backfill. Em cópia estática as contagens
    // devem ser iguais; em base viva a campanha pode mudá-las (informativo, não altera o exit code).
    const after = report.totais_depois as Record<string, number>;
    report.tabelas_legadas_inalteradas = (
      ['messages', 'message_responses', 'convocations', 'billing_events'] as const
    ).every((table) => before[table] === after[table]);
  }

  report.duracao_ms = Date.now() - startedAt;
  report.duracao_por_fase_ms = phases;
  const output = JSON.stringify(report, null, 2);
  console.log(output);
  if (options.reportPath) await writeFile(options.reportPath, `${output}\n`, 'utf8');
  if (options.apply && (report.violacoes as string[]).length > 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({ evento: 'erro', erro: minimizeError(error), contadores: counters }),
  );
  process.exitCode = 2;
} finally {
  await client.$disconnect();
}
