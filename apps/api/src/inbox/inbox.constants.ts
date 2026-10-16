export const INBOX_PRISMA = Symbol('INBOX_PRISMA');
export const HUMAN_MESSAGE_QUEUE = Symbol('HUMAN_MESSAGE_QUEUE');

/** Tempo máximo para publicar o job após o commit; Redis fora não falha a requisição. */
export const QUEUE_PUBLISH_TIMEOUT_MS = 2_000;
