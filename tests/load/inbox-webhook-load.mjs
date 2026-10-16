#!/usr/bin/env node
/**
 * Carga sintética do webhook Meta do inbox (ADR-29). Somente dados SINTÉTICOS.
 *
 * Gera lotes assinados (HMAC SHA-256 com TEST_META_APP_SECRET) contendo inbound (com e sem
 * context.id) e status (incluindo duplicados e fora de ordem) para wa_ids sintéticos
 * 55999000xxxx, envia para TEST_API_BASE_URL/webhooks/meta e mede o ACK (p50/p95/p99),
 * códigos HTTP e vazão. Ao final, opcionalmente lê /api/ops/metrics (backlog e idade).
 *
 * Pré-requisitos (ver docs/inbox-validacao.md): API + worker em staging na VPS com
 * MESSAGING_MODE=DRY_RUN, META_APP_SECRET = TEST_META_APP_SECRET, e TEST_PHONE_NUMBER_ID
 * presente em META_ACCEPTED_PHONE_NUMBER_IDS. NUNCA aponte para produção.
 *
 * Variáveis:
 *   LOAD_TEST_CONFIRM=SYNTHETIC_ONLY   obrigatório
 *   TEST_API_BASE_URL                  ex.: http://confirma-staging:3001/api
 *   TEST_META_APP_SECRET               segredo do app usado SOMENTE no staging
 *   TEST_PHONE_NUMBER_ID               phone_number_id aceito pelo staging
 *   RATE_PER_MIN=5000  DURATION_S=60  BATCH_SIZE=10  CONCURRENCY=50  TIMEOUT_MS=10000
 *   INBOUND_RATIO=0.5  CONTEXT_RATIO=0.5  DUPLICATE_RATIO=0.1  OUT_OF_ORDER_RATIO=0.2
 *   OPS_METRICS_TOKEN                  opcional: lê /ops/metrics ao final
 *   RESULT_PATH                        opcional: grava o resumo JSON
 */
import { createHmac, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

if (process.env.LOAD_TEST_CONFIRM !== 'SYNTHETIC_ONLY') {
  console.error(
    'Recusado: defina LOAD_TEST_CONFIRM=SYNTHETIC_ONLY (somente staging, dados sintéticos).',
  );
  process.exit(2);
}

const baseUrl = required('TEST_API_BASE_URL').replace(/\/$/, '');
const appSecret = required('TEST_META_APP_SECRET');
const phoneNumberId = required('TEST_PHONE_NUMBER_ID');
const ratePerMin = positiveNumber('RATE_PER_MIN', 5_000);
const durationS = positiveNumber('DURATION_S', 60);
const batchSize = positiveNumber('BATCH_SIZE', 10);
const concurrency = positiveNumber('CONCURRENCY', 50);
const timeoutMs = positiveNumber('TIMEOUT_MS', 10_000);
const inboundRatio = ratio('INBOUND_RATIO', 0.5);
const contextRatio = ratio('CONTEXT_RATIO', 0.5);
const duplicateRatio = ratio('DUPLICATE_RATIO', 0.1);
const outOfOrderRatio = ratio('OUT_OF_ORDER_RATIO', 0.2);
const metricsToken = process.env.OPS_METRICS_TOKEN ?? '';
const resultPath = process.env.RESULT_PATH ?? '';

const SYNTHETIC_WA_ID = /^55999000\d{4}$/;
const runId = randomBytes(4).toString('hex');
const intervalMs = (60_000 * batchSize) / ratePerMin;
const totalBatches = Math.max(1, Math.floor((durationS * 1_000) / intervalMs));
const results = [];
const sentStatuses = [];
let sequence = 0;
let inFlight = 0;
const waiters = [];

console.log(
  JSON.stringify({
    evento: 'inicio',
    alvo: `${baseUrl}/webhooks/meta`,
    run_id: runId,
    eventos_por_minuto: ratePerMin,
    duracao_s: durationS,
    tamanho_lote: batchSize,
    concorrencia: concurrency,
    lotes_planejados: totalBatches,
  }),
);

const startedAt = Date.now();
const pending = [];
for (let index = 0; index < totalBatches; index += 1) {
  const scheduledAt = startedAt + index * intervalMs;
  const wait = scheduledAt - Date.now();
  if (wait > 0) await sleep(wait);
  await acquire();
  const lagMs = Math.max(0, Date.now() - scheduledAt);
  pending.push(
    sendBatch(buildBatch(), lagMs).finally(() => {
      release();
    }),
  );
}
await Promise.all(pending);
const elapsedS = Math.max((Date.now() - startedAt) / 1_000, 0.001);

const ok = results.filter((item) => item.status >= 200 && item.status < 300);
// Latência de ACK só das respostas 2xx; erros aparecem em codigos_http/taxa_erro.
const latencies = ok.map((item) => item.latencyMs).sort((a, b) => a - b);
const codes = {};
for (const item of results) {
  const key = item.error ? `erro:${item.error}` : String(item.status);
  codes[key] = (codes[key] ?? 0) + 1;
}
const p95 = percentile(latencies, 0.95);
const p99 = percentile(latencies, 0.99);
const summary = {
  evento: 'resultado',
  run_id: runId,
  requisicoes: results.length,
  eventos_enviados: results.reduce((sum, item) => sum + item.events, 0),
  eventos_aceitos: ok.reduce((sum, item) => sum + item.events, 0),
  codigos_http: codes,
  taxa_erro: results.length ? Number((1 - ok.length / results.length).toFixed(4)) : 0,
  vazao_eventos_por_minuto: Number(
    ((ok.reduce((s, i) => s + i.events, 0) / elapsedS) * 60).toFixed(1),
  ),
  ack_ms: {
    p50: percentile(latencies, 0.5),
    p95,
    p99,
    maximo: latencies.at(-1) ?? 0,
  },
  atraso_agendamento_ms: {
    p95: percentile(
      results.map((item) => item.lagMs).sort((a, b) => a - b),
      0.95,
    ),
    lotes_atrasados_mais_de_1s: results.filter((item) => item.lagMs > 1_000).length,
  },
  // Metas do plano: a MEDIR, não capacidade comprovada.
  metas: {
    ack_p95_ate_750ms: ok.length > 0 && p95 <= 750,
    ack_p99_ate_2s: ok.length > 0 && p99 <= 2_000,
    taxa_erro_zero: ok.length === results.length,
    taxa_alvo_atingida: (ok.reduce((s, i) => s + i.events, 0) / elapsedS) * 60 >= ratePerMin * 0.95,
  },
  duracao_s: Number(elapsedS.toFixed(1)),
};
if (metricsToken) summary.metricas_pos_carga = await readOpsMetrics();
console.log(JSON.stringify(summary, null, 2));
if (resultPath) await writeFile(resultPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

// ---------------------------------------------------------------------------

function buildBatch() {
  const messages = [];
  const statuses = [];
  const contacts = new Map();
  const timestamp = Math.floor(Date.now() / 1_000);
  for (let index = 0; index < batchSize; index += 1) {
    sequence += 1;
    const waId = syntheticWaId(sequence);
    if (Math.random() < inboundRatio) {
      contacts.set(waId, { profile: { name: 'Contato Sintetico' }, wa_id: waId });
      const message = {
        from: waId,
        id: `wamid.SYNTH.${runId}.IN.${sequence}`,
        timestamp: String(timestamp),
        type: 'text',
        text: { body: `mensagem sintetica ${sequence}` },
      };
      if (Math.random() < contextRatio) {
        // context.id sintético: não corresponde a template real => inbound NÃO elegível.
        message.context = { from: phoneNumberId, id: `wamid.SYNTH.${runId}.CTX.${sequence}` };
      }
      messages.push(message);
    } else {
      statuses.push(...syntheticStatuses(waId, timestamp));
    }
  }
  const value = {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '550000000000', phone_number_id: phoneNumberId },
    ...(contacts.size ? { contacts: [...contacts.values()] } : {}),
    ...(messages.length ? { messages } : {}),
    ...(statuses.length ? { statuses } : {}),
  };
  return {
    events: messages.length + statuses.length,
    body: {
      object: 'whatsapp_business_account',
      entry: [{ id: 'SYNTHETIC_WABA', changes: [{ field: 'messages', value }] }],
    },
  };
}

function syntheticStatuses(waId, timestamp) {
  const roll = Math.random();
  if (roll < duplicateRatio && sentStatuses.length > 0) {
    // Duplicado exato de um status já enviado.
    return [sentStatuses[Math.floor(Math.random() * sentStatuses.length)]];
  }
  const outboundId = `wamid.SYNTH.${runId}.OUT.${sequence}`;
  const chain = ['sent', 'delivered', 'read'].map((status, offset) => ({
    id: outboundId,
    status,
    timestamp: String(timestamp + offset),
    recipient_id: waId,
  }));
  const picked = roll < duplicateRatio + outOfOrderRatio ? [chain[2], chain[0]] : [chain[0]];
  for (const item of picked) {
    sentStatuses.push(item);
    if (sentStatuses.length > 1_000) sentStatuses.shift();
  }
  return picked;
}

async function sendBatch(batch, lagMs) {
  const raw = JSON.stringify(batch.body);
  const signature = `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`;
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}/webhooks/meta`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: raw,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.arrayBuffer();
    results.push({
      status: response.status,
      latencyMs: Math.round(performance.now() - started),
      lagMs,
      events: batch.events,
    });
  } catch (error) {
    results.push({
      status: 0,
      error: error?.name === 'TimeoutError' ? 'timeout' : 'rede',
      latencyMs: Math.round(performance.now() - started),
      lagMs,
      events: batch.events,
    });
  }
}

async function readOpsMetrics() {
  try {
    const response = await fetch(`${baseUrl}/ops/metrics`, {
      headers: { authorization: `Bearer ${metricsToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { erro: `HTTP ${response.status}` };
    const text = await response.text();
    const wanted = [
      'confirma_db_up',
      'confirma_redis_up',
      'confirma_webhook_events',
      'confirma_webhook_oldest_age_seconds',
      'confirma_webhook_dead_letters',
      'confirma_queue_jobs',
      'confirma_inbox_unassigned_open_conversations',
    ];
    return Object.fromEntries(
      text
        .split('\n')
        .filter(
          (line) => line && !line.startsWith('#') && wanted.some((name) => line.startsWith(name)),
        )
        .map((line) => {
          const index = line.lastIndexOf(' ');
          return [line.slice(0, index), Number(line.slice(index + 1))];
        }),
    );
  } catch (error) {
    return { erro: error?.name ?? 'erro' };
  }
}

function syntheticWaId(index) {
  const waId = `55999000${String(index % 10_000).padStart(4, '0')}`;
  if (!SYNTHETIC_WA_ID.test(waId)) throw new Error('wa_id fora da faixa sintética');
  return waId;
}

function acquire() {
  if (inFlight < concurrency) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  const next = waiters.shift();
  if (next) next();
  else inFlight -= 1;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
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

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} deve ser positivo`);
  return value;
}

function ratio(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`${name} deve estar entre 0 e 1`);
  return value;
}
