export const WEBHOOK_QUEUE = Symbol('WEBHOOK_QUEUE');

/** Tamanho máximo aceito para o corpo bruto de uma notificação da Meta. */
export const WEBHOOK_MAX_BODY_BYTES = 1_048_576;

/** Quantidade máxima de eventos normalizados por lote. */
export const WEBHOOK_MAX_EVENTS = 1_000;

/** Tempo máximo que a resposta espera pela publicação best-effort no BullMQ. */
export const WEBHOOK_PUBLISH_WAIT_MS = 1_500;

/** Mesmas opções usadas pelo despachante de outbox do worker. */
export const WEBHOOK_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: 1_000,
  removeOnFail: 1_000,
} as const;
