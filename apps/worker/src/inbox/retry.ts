import { Prisma } from '@confirma/database';
import { WEBHOOK_MAX_ATTEMPTS, webhookRetryDelayMs } from '../outbox-dispatcher.js';

export { WEBHOOK_MAX_ATTEMPTS, webhookRetryDelayMs };

/** Erro esperado e seguro para gravar em `processingError` (sem conteúdo nem telefone). */
export class WebhookRetryableError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'WebhookRetryableError';
  }
}

/** Minimiza o erro: nunca grava mensagens arbitrárias (podem conter dados da mensagem). */
export function minimizedProcessingError(error: unknown): string {
  if (error instanceof WebhookRetryableError) return error.message.slice(0, 200);
  if (error instanceof Prisma.PrismaClientKnownRequestError) return `PRISMA_${error.code}`;
  if (error instanceof Error) return `ERRO_${error.name}`.slice(0, 100);
  return 'ERRO_DESCONHECIDO';
}

export interface WebhookFailureState {
  attempts: number;
}

/** Dados da atualização de `message_events` após falha de processamento. */
export function webhookFailureUpdate(
  current: WebhookFailureState,
  error: unknown,
  now: Date = new Date(),
  maxAttempts: number = WEBHOOK_MAX_ATTEMPTS,
) {
  const attempts = current.attempts + 1;
  const processingError = minimizedProcessingError(error);
  if (attempts >= maxAttempts) {
    return {
      processingStatus: 'DEAD_LETTER' as const,
      attempts,
      nextAttemptAt: null,
      deadLetteredAt: now,
      processingError,
    };
  }
  return {
    processingStatus: 'FAILED' as const,
    attempts,
    nextAttemptAt: new Date(now.getTime() + webhookRetryDelayMs(attempts)),
    processingError,
  };
}

/**
 * Tentativas (nosso contador `attempts`) em que um inbound com context.id desconhecido aguarda a
 * correlação: cobre a corrida em que a resposta chega antes do commit do providerMessageId do
 * template. Depois disso o inbound entra na timeline como NOT_ELIGIBLE/CONTEXT_NOT_FOUND.
 */
export const WEBHOOK_CONTEXT_WAIT_ATTEMPTS = positiveInteger(
  process.env.WEBHOOK_CONTEXT_WAIT_ATTEMPTS,
  4,
);

/**
 * `true` enquanto ainda vale repetir à espera do template referenciado (attempts < limite).
 * O limite nunca passa de WEBHOOK_MAX_ATTEMPTS - 1: o inbound sempre entra antes do DEAD_LETTER.
 */
export function shouldWaitForContext(
  attemptsSoFar: number,
  waitAttempts: number = WEBHOOK_CONTEXT_WAIT_ATTEMPTS,
  maxAttempts: number = WEBHOOK_MAX_ATTEMPTS,
): boolean {
  return attemptsSoFar < Math.min(waitAttempts, maxAttempts - 1);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
