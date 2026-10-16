import { Redis } from 'ioredis';

export const QUEUES = {
  imports: 'confirma.imports',
  messages: 'confirma.messages',
  webhooks: 'confirma.webhooks',
  handoffs: 'confirma.handoffs',
  reports: 'confirma.reports',
  /** Envio de mensagens humanas do inbox (texto livre dentro da janela elegível). */
  humanMessages: 'confirma.human-messages',
  /** Download/validação de mídia recebida. */
  media: 'confirma.media',
} as const;

export interface ParseImportJob {
  importId: string;
  importFileId: string;
  temporaryPath: string;
}

export interface SendMessageJob {
  convocationId: string;
  stage: 'FIRST' | 'SECOND' | 'THIRD';
}

export interface SendAutomaticReplyJob {
  messageId: string;
  action: 'CONFIRM' | 'CANCEL';
}

export type MessagingJob = SendMessageJob | SendAutomaticReplyJob;

export interface ProcessWebhookJob {
  messageEventId: string;
}

export interface SendHumanMessageJob {
  /** conversation_messages.id (kind HUMAN_TEXT, status QUEUED). */
  conversationMessageId: string;
}

export interface ProcessMediaJob {
  mediaAssetId: string;
}

/** jobId determinístico: evita job duplicado para a mesma mensagem humana. */
export function humanMessageJobId(conversationMessageId: string): string {
  return `human-message:${conversationMessageId}`;
}

export function webhookJobId(messageEventId: string): string {
  return `webhook:${messageEventId}`;
}

export function mediaJobId(mediaAssetId: string): string {
  return `media:${mediaAssetId}`;
}

export interface ProcessHandoffJob {
  handoffEventId: string;
}

export function createRedisConnection(redisUrl = process.env.REDIS_URL): Redis {
  if (!redisUrl) {
    throw new Error('REDIS_URL não configurada');
  }

  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

export * from './rate-limit.js';
