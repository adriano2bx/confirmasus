#!/usr/bin/env node
/**
 * E2E do gate de resposta humana do inbox por HTTP (API + worker em DRY_RUN, staging na VPS).
 * Somente dados SINTÉTICOS (wa_id 55999000xxxx). Nunca apontar para produção.
 *
 * Cenários:
 *   1. Inbound espontâneo (sem context.id) => conversa criada; envio humano => 422 HUMAN_REPLY_BLOCKED.
 *   2. Inbound com context.id inexistente => continua 422 (correlação forjada não abre janela).
 *   3. (com template conhecido) inbound de OUTRO wa_id citando o template => 422 (RECIPIENT_MISMATCH).
 *   4. (com template conhecido) inbound do wa_id correto com context.id do template => assumir,
 *      responder => 202 e mensagem chega a SUBMITTED; nota interna => 201 e não gera envio.
 *
 * Pré-requisitos (detalhes em docs/inbox-validacao.md):
 *   - API e worker com MESSAGING_MODE=DRY_RUN; META_APP_SECRET = TEST_META_APP_SECRET;
 *     TEST_PHONE_NUMBER_ID em META_ACCEPTED_PHONE_NUMBER_IDS (e igual a META_WHATSAPP_PHONE_NUMBER_ID
 *     se o template for legado sem senderPhoneNumberId).
 *   - Usuário ADMIN de teste (E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD).
 *   - Para os cenários 3 e 4: um template de campanha já SUBMITTED em DRY_RUN para um wa_id
 *     sintético: TEST_KNOWN_PROVIDER_MESSAGE_ID e TEST_KNOWN_WA_ID. Sem eles, 3 e 4 são PULADOS.
 *
 * Variáveis obrigatórias: LOAD_TEST_CONFIRM=SYNTHETIC_ONLY, E2E_TARGET_IS_DRY_RUN=yes,
 *   TEST_API_BASE_URL (ex.: http://confirma-staging:3001/api), TEST_META_APP_SECRET,
 *   TEST_PHONE_NUMBER_ID, E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD.
 * Opcionais: E2E_TEAM_ID (usa equipe existente), E2E_TIMEOUT_MS=45000.
 * Exit code: 0 = todos os cenários executados passaram; 1 = falha; 2 = configuração.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

if (
  process.env.LOAD_TEST_CONFIRM !== 'SYNTHETIC_ONLY' ||
  process.env.E2E_TARGET_IS_DRY_RUN !== 'yes'
) {
  console.error(
    'Recusado: defina LOAD_TEST_CONFIRM=SYNTHETIC_ONLY e E2E_TARGET_IS_DRY_RUN=yes (staging em DRY_RUN).',
  );
  process.exit(2);
}

const SYNTHETIC_WA_ID = /^55999000\d{4}$/;
const baseUrl = required('TEST_API_BASE_URL').replace(/\/$/, '');
const appSecret = required('TEST_META_APP_SECRET');
const phoneNumberId = required('TEST_PHONE_NUMBER_ID');
const adminEmail = required('E2E_ADMIN_EMAIL');
const adminPassword = required('E2E_ADMIN_PASSWORD');
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 45_000);
const knownTemplateId = process.env.TEST_KNOWN_PROVIDER_MESSAGE_ID ?? '';
const knownWaId = process.env.TEST_KNOWN_WA_ID ?? '';
if (knownWaId && !SYNTHETIC_WA_ID.test(knownWaId)) {
  console.error('TEST_KNOWN_WA_ID deve ser sintético (55999000xxxx).');
  process.exit(2);
}

const runId = randomBytes(3).toString('hex');
const cookies = new Map();
const steps = [];
let adminUserId = null;

try {
  await login();
  const me = await api('GET', '/inbox/me', { expect: [200] });
  adminUserId = me.json?.userId ?? null;
  const teamId = await prepareTeam(adminUserId);

  // 1. Inbound espontâneo => bloqueado.
  let spontaneousWaId = randomSyntheticWaId();
  while (spontaneousWaId === knownWaId) spontaneousWaId = randomSyntheticWaId();
  await sendInbound(spontaneousWaId, null);
  let conversation = await waitConversation(spontaneousWaId);
  conversation = await takeOver(conversation, teamId);
  check(
    'espontaneo_politica_bloqueada',
    conversation.replyPolicy?.allowed === false,
    conversation.replyPolicy,
  );
  await expectBlocked('espontaneo_envio_422', conversation.id, 'NO_ELIGIBLE_INBOUND');

  // 2. context.id forjado => continua bloqueado.
  await sendInbound(spontaneousWaId, `wamid.SYNTH.${runId}.FORGED`);
  await sleep(2_000);
  await expectBlocked('context_forjado_envio_422', conversation.id, 'NO_ELIGIBLE_INBOUND');

  if (!knownTemplateId || !knownWaId) {
    skip(
      'outro_wa_id_citando_template',
      'TEST_KNOWN_PROVIDER_MESSAGE_ID/TEST_KNOWN_WA_ID ausentes',
    );
    skip('resposta_template_envio_202', 'TEST_KNOWN_PROVIDER_MESSAGE_ID/TEST_KNOWN_WA_ID ausentes');
  } else {
    // 3. Outro wa_id citando o template => bloqueado (RECIPIENT_MISMATCH no inbound).
    let otherWaId = randomSyntheticWaId();
    while (otherWaId === knownWaId) otherWaId = randomSyntheticWaId();
    await sendInbound(otherWaId, knownTemplateId);
    let other = await waitConversation(otherWaId);
    other = await takeOver(other, teamId);
    await expectBlocked('outro_wa_id_citando_template', other.id, 'NO_ELIGIBLE_INBOUND');

    // 4. Resposta legítima ao template => elegível.
    await sendInbound(knownWaId, knownTemplateId);
    let eligible = await waitConversation(knownWaId, (item) => item.replyPolicy?.windowExpiresAt);
    eligible = await takeOver(eligible, teamId);
    check(
      'resposta_template_politica_liberada',
      eligible.replyPolicy?.allowed === true,
      eligible.replyPolicy,
    );
    const sent = await api('POST', `/inbox/conversations/${eligible.id}/messages`, {
      body: { body: `Mensagem de teste sintético ${runId}`, idempotencyKey: randomUUID() },
      expect: [202],
    });
    const messageId = sent.json?.message?.id;
    check('resposta_template_envio_202', sent.status === 202 && Boolean(messageId), {
      status: sent.status,
    });
    const finalStatus = await waitMessageStatus(eligible.id, messageId, [
      'SUBMITTED',
      'SENT',
      'DELIVERED',
      'READ',
    ]);
    check(
      'resposta_template_submitted',
      ['SUBMITTED', 'SENT', 'DELIVERED', 'READ'].includes(finalStatus),
      {
        status: finalStatus,
      },
    );

    // Nota interna: 201 e nenhuma mensagem nova na timeline a partir da nota.
    const note = await api('POST', `/inbox/conversations/${eligible.id}/notes`, {
      body: { body: `Nota interna sintética ${runId}` },
      expect: [201],
    });
    check('nota_201', note.status === 201, { status: note.status });
    const noteAt = Date.parse(note.json?.note?.createdAt ?? note.json?.createdAt ?? '');
    await sleep(3_000);
    const newer = await messagesSince(
      eligible.id,
      Number.isNaN(noteAt) ? Date.now() - 3_000 : noteAt,
    );
    check('nota_nao_gera_envio', newer === 0, { mensagens_apos_nota: newer });
  }
} catch (error) {
  steps.push({
    passo: 'execucao',
    ok: false,
    detalhe: error instanceof Error ? error.message : String(error),
  });
}

const failed = steps.filter((step) => step.ok === false);
console.log(
  JSON.stringify(
    { evento: 'resultado_e2e_gate', run_id: runId, ok: failed.length === 0, passos: steps },
    null,
    2,
  ),
);
process.exitCode = failed.length === 0 ? 0 : 1;

// ---------------------------------------------------------------------------

async function login() {
  const response = await api('POST', '/auth/login', {
    body: { email: adminEmail, password: adminPassword },
    expect: [200, 201],
  });
  if (!cookies.get('confirma_access_token'))
    throw new Error(`Login sem cookie de sessão (HTTP ${response.status})`);
}

async function prepareTeam(userId) {
  if (process.env.E2E_TEAM_ID) return process.env.E2E_TEAM_ID;
  const team = await api('POST', '/inbox/teams', {
    body: { name: `E2E sintético ${runId}`, slug: `e2e-sintetico-${runId}` },
    expect: [200, 201],
  });
  const teamId = team.json?.id ?? team.json?.team?.id;
  if (!teamId) throw new Error('Criação de equipe não retornou id');
  await api('POST', `/inbox/teams/${teamId}/members`, {
    body: { userId, role: 'SUPERVISOR' },
    expect: [200, 201, 204],
  });
  steps.push({ passo: 'equipe_criada', ok: true });
  return teamId;
}

/** Garante a conversa na equipe de teste e atribuída ao admin (assumir). */
async function takeOver(conversation, teamId) {
  let current = conversation;
  if (current.team?.id !== teamId) {
    const moved = await api('POST', `/inbox/conversations/${current.id}/transfer`, {
      body: { version: current.version, toTeamId: teamId, reason: `e2e sintético ${runId}` },
      expect: [200, 201],
    });
    current = moved.json;
  }
  if (current.assignee?.id && current.assignee.id === adminUserId) return current;
  const claimed = await api('POST', `/inbox/conversations/${current.id}/claim`, {
    body: { version: current.version },
    expect: [200, 201],
  });
  return claimed.json;
}

async function expectBlocked(name, conversationId, reason) {
  const response = await api('POST', `/inbox/conversations/${conversationId}/messages`, {
    body: { body: `Tentativa bloqueada ${runId}`, idempotencyKey: randomUUID() },
  });
  const reasons = response.json?.reasons ?? [];
  check(
    name,
    response.status === 422 &&
      response.json?.code === 'HUMAN_REPLY_BLOCKED' &&
      reasons.includes(reason),
    { status: response.status, code: response.json?.code ?? null, reasons },
  );
}

async function waitConversation(waId, predicate = () => true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await api('GET', `/inbox/conversations?view=all&q=${waId}&limit=10`, {
      expect: [200],
    });
    const match = (list.json?.items ?? []).find(
      (item) => item.status !== 'RESOLVED' && predicate(item),
    );
    if (match) return match;
    await sleep(1_000);
  }
  throw new Error('Conversa não apareceu no prazo (verifique worker/outbox)');
}

async function waitMessageStatus(conversationId, messageId, finals) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  while (Date.now() < deadline) {
    const timeline = await api('GET', `/inbox/conversations/${conversationId}/timeline?limit=50`, {
      expect: [200],
    });
    status = (timeline.json?.items ?? []).find((item) => item.id === messageId)?.status ?? null;
    if (finals.includes(status) || ['FAILED', 'BLOCKED', 'UNKNOWN'].includes(status)) return status;
    await sleep(1_000);
  }
  return status;
}

async function messagesSince(conversationId, sinceMs) {
  const timeline = await api('GET', `/inbox/conversations/${conversationId}/timeline?limit=50`, {
    expect: [200],
  });
  return (timeline.json?.items ?? []).filter(
    (item) => item.kind === 'message' && Date.parse(item.createdAt ?? '') >= sinceMs,
  ).length;
}

async function sendInbound(waId, contextId) {
  if (!SYNTHETIC_WA_ID.test(waId)) throw new Error('wa_id fora da faixa sintética');
  const message = {
    from: waId,
    id: `wamid.SYNTH.${runId}.${randomBytes(6).toString('hex')}`,
    timestamp: String(Math.floor(Date.now() / 1_000)),
    type: 'text',
    text: { body: `Texto sintético ${runId}` },
    ...(contextId ? { context: { from: phoneNumberId, id: contextId } } : {}),
  };
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'SYNTHETIC_WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '550000000000', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Contato Sintetico' }, wa_id: waId }],
              messages: [message],
            },
          },
        ],
      },
    ],
  });
  const response = await fetch(`${baseUrl}/webhooks/meta`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`,
    },
    body: raw,
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status < 200 || response.status >= 300)
    throw new Error(`Webhook HTTP ${response.status}`);
}

async function api(method, path, { body, expect } = {}) {
  const headers = { accept: 'application/json' };
  if (cookies.size)
    headers.cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  if (method !== 'GET' && cookies.get('confirma_csrf_token'))
    headers['x-csrf-token'] = cookies.get('confirma_csrf_token');
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const index = pair.indexOf('=');
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (expect && !expect.includes(response.status)) {
    throw new Error(
      `${method} ${path.split('?')[0]} => HTTP ${response.status} (esperado ${expect.join('/')})`,
    );
  }
  return { status: response.status, json };
}

function check(name, ok, detail) {
  steps.push({
    passo: name,
    ok: Boolean(ok),
    ...(detail === undefined ? {} : { detalhe: detail }),
  });
}

function skip(name, reason) {
  steps.push({ passo: name, ok: null, pulado: reason });
}

function randomSyntheticWaId() {
  return `55999000${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Variável obrigatória ausente: ${name}`);
    process.exit(2);
  }
  return value;
}
