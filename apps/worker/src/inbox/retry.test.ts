import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '@confirma/database';
import {
  minimizedProcessingError,
  webhookFailureUpdate,
  webhookRetryDelayMs,
  WebhookRetryableError,
  shouldWaitForContext,
  WEBHOOK_CONTEXT_WAIT_ATTEMPTS,
} from './retry.js';

describe('falhas de processamento de webhook', () => {
  it('usa o backoff do despachante de outbox (teto de 15 minutos)', () => {
    assert.ok(webhookRetryDelayMs(2) > webhookRetryDelayMs(1));
    assert.equal(webhookRetryDelayMs(50), 15 * 60 * 1_000);
  });

  it('agenda nova tentativa e move para DEAD_LETTER no limite', () => {
    const now = new Date('2026-10-16T12:00:00Z');
    const retry = webhookFailureUpdate({ attempts: 0 }, new Error('x'), now, 3);
    assert.equal(retry.processingStatus, 'FAILED');
    assert.equal(retry.attempts, 1);
    assert.equal(retry.nextAttemptAt?.getTime(), now.getTime() + webhookRetryDelayMs(1));
    const dead = webhookFailureUpdate({ attempts: 2 }, new Error('x'), now, 3);
    assert.equal(dead.processingStatus, 'DEAD_LETTER');
    assert.equal(dead.nextAttemptAt, null);
    assert.equal('deadLetteredAt' in dead && dead.deadLetteredAt, now);
  });

  it('nunca grava a mensagem de erro arbitrária (pode conter dados)', () => {
    assert.equal(minimizedProcessingError(new Error('telefone 5511999990000')), 'ERRO_Error');
    assert.equal(
      minimizedProcessingError(new WebhookRetryableError('MENSAGEM_NAO_PERSISTIDA')),
      'MENSAGEM_NAO_PERSISTIDA',
    );
    const prismaError = new Prisma.PrismaClientKnownRequestError('dado sensível', {
      code: 'P2002',
      clientVersion: 'test',
    });
    assert.equal(minimizedProcessingError(prismaError), 'PRISMA_P2002');
    assert.equal(minimizedProcessingError('x'), 'ERRO_DESCONHECIDO');
  });

  it('espera curta pelo context.id: attempts < limite repete, >= limite persiste', () => {
    if (!process.env.WEBHOOK_CONTEXT_WAIT_ATTEMPTS) assert.equal(WEBHOOK_CONTEXT_WAIT_ATTEMPTS, 4);
    assert.equal(shouldWaitForContext(0, 4, 12), true);
    assert.equal(shouldWaitForContext(3, 4, 12), true);
    assert.equal(shouldWaitForContext(4, 4, 12), false);
    assert.equal(shouldWaitForContext(9, 4, 12), false);
  });

  it('a espera nunca alcança o DEAD_LETTER', () => {
    assert.equal(shouldWaitForContext(2, 20, 3), false);
    assert.equal(shouldWaitForContext(1, 20, 3), true);
  });
});
