import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SEND_PERMIT_SCRIPT,
  acquireSendPermit,
  sendPermitOptionsFromEnv,
  type SendPermitRedis,
} from '@confirma/queue';

/** Stub da chamada `eval` do Redis: devolve as respostas na ordem e registra os argumentos. */
function stubRedis(responses: Array<[number, number]>) {
  const calls: unknown[][] = [];
  const redis = {
    eval: async (...args: unknown[]) => {
      calls.push(args);
      const next = responses.shift();
      if (!next) throw new Error('sem resposta configurada');
      return next;
    },
  } as unknown as SendPermitRedis;
  return { redis, calls };
}

describe('limiter compartilhado por phone_number_id', () => {
  it('usa script atômico na chave do número e concede quando há vaga', async () => {
    const { redis, calls } = stubRedis([[1, 0]]);
    const permit = await acquireSendPermit(redis, '123456', { max: 20, durationMs: 1_000 });
    assert.deepEqual(permit, { granted: true, retryAfterMs: 0 });
    assert.equal(calls.length, 1);
    const [script, numKeys, key, limit, duration] = calls[0] ?? [];
    assert.equal(script, SEND_PERMIT_SCRIPT);
    assert.equal(numKeys, 1);
    assert.equal(key, 'confirma:ratelimit:wa:123456');
    assert.equal(limit, 20);
    assert.equal(duration, 1_000);
  });

  it('espera retryAfter dentro de maxWaitMs e tenta de novo', async () => {
    const { redis, calls } = stubRedis([
      [0, 20],
      [1, 0],
    ]);
    const started = Date.now();
    const permit = await acquireSendPermit(redis, '123456', {
      max: 1,
      durationMs: 1_000,
      maxWaitMs: 500,
    });
    assert.equal(permit.granted, true);
    assert.equal(calls.length, 2);
    assert.ok(Date.now() - started >= 15);
  });

  it('desiste sem esperar quando retryAfter excede o tempo restante', async () => {
    const { redis, calls } = stubRedis([[0, 900]]);
    const permit = await acquireSendPermit(redis, '123456', {
      max: 1,
      durationMs: 1_000,
      maxWaitMs: 100,
    });
    assert.deepEqual(permit, { granted: false, retryAfterMs: 900 });
    assert.equal(calls.length, 1);
  });

  it('reserva vagas para envio humano sem aumentar o total', async () => {
    const campaign = stubRedis([[1, 0]]);
    await acquireSendPermit(campaign.redis, '1', {
      max: 10,
      durationMs: 1_000,
      humanReserve: 3,
      priority: 'campaign',
    });
    assert.equal(campaign.calls[0]?.[3], 7);
    const human = stubRedis([[1, 0]]);
    await acquireSendPermit(human.redis, '1', {
      max: 10,
      durationMs: 1_000,
      humanReserve: 3,
      priority: 'human',
    });
    assert.equal(human.calls[0]?.[3], 10);
  });

  it('rejeita configuração ou phone_number_id inválidos', async () => {
    const { redis } = stubRedis([]);
    await assert.rejects(acquireSendPermit(redis, '', { max: 1, durationMs: 1_000 }));
    await assert.rejects(acquireSendPermit(redis, '1', { max: Number.NaN, durationMs: 1_000 }));
  });

  it('lê padrões do ambiente', () => {
    assert.deepEqual(sendPermitOptionsFromEnv({}), {
      max: 20,
      durationMs: 1_000,
      maxWaitMs: 5_000,
      humanReserve: 0,
    });
  });
});
