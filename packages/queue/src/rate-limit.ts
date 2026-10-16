import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Limiter COMPARTILHADO por phone_number_id da Meta (ADR-23).
 * Campanha, resposta automática e envio humano devem chamar `acquireSendPermit`
 * imediatamente antes de cada chamada à Cloud API. O limite é agregado entre
 * todas as réplicas de worker (estado no Redis), então prioridade humana não
 * multiplica o limite total.
 *
 * Algoritmo: janela deslizante (log em ZSET) avaliada atomicamente por script Lua
 * na chave `confirma:ratelimit:wa:<phoneNumberId>`. O relógio é o do Redis
 * (`TIME`), portanto réplicas com relógios diferentes compartilham a mesma janela.
 * Prioridade: envios `campaign` só ocupam até `max - humanReserve` vagas da janela;
 * envios `human` podem usar todas as `max` vagas (a reserva nunca soma ao total).
 */
export interface SendPermitOptions {
  /** Máximo de envios por janela, por phone_number_id. */
  max: number;
  /** Duração da janela em ms. */
  durationMs: number;
  /** Tempo máximo esperando permissão antes de desistir (o job é reprogramado). */
  maxWaitMs?: number;
  priority?: 'human' | 'campaign';
  /** Vagas da janela reservadas a envios humanos (padrão 0: sem reserva). */
  humanReserve?: number;
}

export interface SendPermit {
  granted: boolean;
  /** Se não concedido: quanto esperar antes de tentar de novo. */
  retryAfterMs: number;
}

/** Subconjunto do cliente Redis usado pelo limiter (facilita stub em testes). */
export type SendPermitRedis = Pick<Redis, 'eval'>;

export function sendPermitKey(phoneNumberId: string): string {
  return `confirma:ratelimit:wa:${phoneNumberId}`;
}

/**
 * KEYS[1] = chave do número; ARGV = limite efetivo, duração (ms), membro único.
 * Retorna {1, 0} se concedido; {0, retryAfterMs} caso contrário.
 */
export const SEND_PERMIT_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local duration = tonumber(ARGV[2])
local member = ARGV[3]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - duration)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, duration)
  return {1, 0}
end
local index = count - limit
local entry = redis.call('ZRANGE', key, index, index, 'WITHSCORES')
local retry = duration
if entry[2] then retry = tonumber(entry[2]) + duration - now end
if retry < 1 then retry = 1 end
return {0, retry}
`;

export async function acquireSendPermit(
  redis: SendPermitRedis,
  phoneNumberId: string,
  options: SendPermitOptions,
): Promise<SendPermit> {
  if (!/^[\w-]{1,64}$/.test(phoneNumberId)) {
    throw new Error('phone_number_id inválido para o limiter de envio');
  }
  const { max, durationMs } = options;
  if (!Number.isInteger(max) || max < 1 || !Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('Configuração inválida do limiter de envio');
  }
  const reserve = Math.min(Math.max(0, Math.floor(options.humanReserve ?? 0)), max - 1);
  const limit = options.priority === 'human' ? max : max - reserve;
  const maxWaitMs = Math.max(0, options.maxWaitMs ?? 0);
  const deadline = Date.now() + maxWaitMs;
  const key = sendPermitKey(phoneNumberId);

  for (;;) {
    const result = (await redis.eval(
      SEND_PERMIT_SCRIPT,
      1,
      key,
      limit,
      Math.ceil(durationMs),
      `${Date.now()}:${randomUUID()}`,
    )) as unknown;
    const [granted, retryAfter] = parseScriptResult(result);
    if (granted) return { granted: true, retryAfterMs: 0 };
    const remaining = deadline - Date.now();
    if (remaining <= 0 || retryAfter > remaining) {
      return { granted: false, retryAfterMs: retryAfter };
    }
    // Pequeno jitter evita que réplicas acordem juntas e disputem a mesma vaga.
    await sleep(retryAfter + Math.floor(Math.random() * 10));
  }
}

function parseScriptResult(result: unknown): [boolean, number] {
  if (!Array.isArray(result) || result.length < 2) {
    throw new Error('Resposta inesperada do limiter de envio');
  }
  const retryAfter = Number(result[1]);
  return [Number(result[0]) === 1, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sendPermitOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SendPermitOptions {
  return {
    max: Number(env.MESSAGE_RATE_LIMIT_MAX ?? 20),
    durationMs: Number(env.MESSAGE_RATE_LIMIT_DURATION_MS ?? 1_000),
    maxWaitMs: Number(env.MESSAGE_RATE_LIMIT_MAX_WAIT_MS ?? 5_000),
    humanReserve: Number(env.MESSAGE_RATE_LIMIT_HUMAN_RESERVE ?? 0),
  };
}
