#!/usr/bin/env node

import { createHmac, randomUUID } from 'node:crypto';

const baseUrl = (process.env.LOAD_TEST_BASE_URL ?? 'http://127.0.0.1:3001/api').replace(/\/$/, '');
const durationSeconds = positiveInt('LOAD_TEST_DURATION_SECONDS', 60);
const concurrency = positiveInt('LOAD_TEST_CONCURRENCY', 10);
const timeoutMs = positiveInt('LOAD_TEST_TIMEOUT_MS', 10_000);
const externalAllowed = process.env.LOAD_TEST_ALLOW_EXTERNAL === 'true';
const confirmation = process.env.LOAD_TEST_CONFIRM;
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(`${baseUrl}/`);

if (!isLocal && (!externalAllowed || confirmation !== 'I_UNDERSTAND')) {
  throw new Error(
    'Alvo externo bloqueado. Use um ambiente de homologação e defina LOAD_TEST_ALLOW_EXTERNAL=true e LOAD_TEST_CONFIRM=I_UNDERSTAND.',
  );
}

const email = process.env.LOAD_TEST_EMAIL;
const password = process.env.LOAD_TEST_PASSWORD;
const webhookSecret = process.env.LOAD_TEST_META_APP_SECRET;
const webhookMode = process.env.LOAD_TEST_WEBHOOK_MODE ?? 'unique';
const startedAt = Date.now();
const deadline = startedAt + durationSeconds * 1_000;
const results = [];
let accessToken = null;

if (email && password) {
  const login = await request('/auth/login', {
    method: 'POST',
    body: { email, password },
    count: false,
  });
  if (login.status < 200 || login.status >= 300 || !login.json?.accessToken) {
    throw new Error(`Falha no login de carga (HTTP ${login.status}).`);
  }
  accessToken = login.json.accessToken;
}

console.log(
  JSON.stringify({
    evento: 'inicio',
    alvo: baseUrl,
    duracao_segundos: durationSeconds,
    concorrencia: concurrency,
    endpoint_protegido: Boolean(accessToken),
    webhook_modo: webhookMode,
  }),
);

await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));

const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
const latencies = results.map((item) => item.latencyMs).sort((a, b) => a - b);
const errors = results.filter((item) => item.error || item.status < 200 || item.status >= 300);
const byEndpoint = Object.groupBy(results, (item) => item.endpoint);
const summary = {
  evento: 'resultado',
  requisicoes: results.length,
  erros: errors.length,
  taxa_erro: results.length ? Number((errors.length / results.length).toFixed(4)) : 0,
  requisicoes_por_segundo: Number((results.length / elapsedSeconds).toFixed(2)),
  latencia_ms: {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    maxima: latencies.at(-1) ?? 0,
  },
  por_endpoint: Object.fromEntries(
    Object.entries(byEndpoint).map(([endpoint, items]) => [
      endpoint,
      {
        requisicoes: items.length,
        erros: items.filter((item) => item.error || item.status < 200 || item.status >= 300).length,
        p95_ms: percentile(
          items.map((item) => item.latencyMs).sort((a, b) => a - b),
          0.95,
        ),
      },
    ]),
  ),
};
console.log(JSON.stringify(summary, null, 2));

if (errors.length > 0) process.exitCode = 1;

async function worker(index) {
  while (Date.now() < deadline) {
    const random = Math.random();
    if (accessToken && random < 0.55) {
      await request('/dashboard/overview', { headers: { authorization: `Bearer ${accessToken}` } });
    } else if (random < 0.95 && webhookSecret) {
      await request('/webhooks/meta', {
        method: 'POST',
        headers: {},
        body: webhookPayload(),
      });
    } else {
      await request('/health');
    }
  }
  if (index === 0) await request('/health');
}

function webhookPayload() {
  const id = webhookMode === 'duplicate' ? 'load-test-fixed-event' : `load-test-${randomUUID()}`;
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'load-test-waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'load-test-phone' },
              statuses: [
                {
                  id,
                  status: 'sent',
                  timestamp:
                    webhookMode === 'duplicate'
                      ? '1725000000'
                      : String(Math.floor(Date.now() / 1000)),
                  recipient_id: '5511999999999',
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function request(path, options = {}) {
  const started = performance.now();
  const headers = { accept: 'application/json', ...(options.headers ?? {}) };
  const init = { method: options.method ?? 'GET', headers, signal: AbortSignal.timeout(timeoutMs) };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
    if (path.endsWith('/webhooks/meta') && webhookSecret) {
      headers['x-hub-signature-256'] =
        `sha256=${createHmac('sha256', webhookSecret).update(init.body).digest('hex')}`;
    }
  }
  let status = 0;
  let json = null;
  let error = null;
  try {
    const response = await fetch(`${baseUrl}${path}`, init);
    status = response.status;
    json = await response.json().catch(() => null);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'erro desconhecido';
  }
  if (options.count !== false) {
    results.push({
      endpoint: path,
      status,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      ...(error ? { error } : {}),
    });
  }
  return { status, json, error };
}

function positiveInt(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} deve ser um inteiro positivo.`);
  return value;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)];
}
