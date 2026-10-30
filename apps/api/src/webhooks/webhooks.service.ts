import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Prisma, prisma } from '@confirma/database';
import type { ProcessWebhookJob } from '@confirma/queue';
import type { Queue } from 'bullmq';
import { WEBHOOK_QUEUE } from './webhooks.constants.js';

type JsonRecord = Record<string, unknown>;

@Injectable()
export class WebhooksService {
  constructor(@Inject(WEBHOOK_QUEUE) private readonly queue: Queue<ProcessWebhookJob>) {}

  verify(mode?: string, token?: string, challenge?: string): string {
    if (
      mode !== 'subscribe' ||
      !token ||
      !challenge ||
      !safeEqual(token, process.env.META_WEBHOOK_VERIFY_TOKEN ?? '')
    ) {
      throw new ForbiddenException('Verificação do webhook Meta inválida');
    }
    return challenge;
  }

  async receive(value: unknown, signature: string | undefined, rawBody: Buffer | undefined) {
    this.verifySignature(signature, rawBody);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('Payload de webhook inválido');
    }
    const events = normalizeMetaEvents(value as JsonRecord);
    for (const event of events) await this.persistAndQueue(event);
  }

  private verifySignature(signature: string | undefined, rawBody: Buffer | undefined) {
    const appSecret = process.env.META_APP_SECRET;
    if (!appSecret || !signature || !rawBody) {
      throw new ForbiddenException('Assinatura do webhook Meta ausente');
    }
    const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    if (!safeEqual(signature, expected))
      throw new ForbiddenException('Assinatura do webhook inválida');
  }

  private async persistAndQueue(value: JsonRecord) {
    const type = String(value.type ?? 'unknown');
    const payload = record(value.payload);
    const identity = String(payload.id ?? '');
    const timestamp = String(value.timestamp ?? '');
    const deduplicationKey = createHash('sha256')
      .update(JSON.stringify({ type, identity, timestamp, payload }))
      .digest('hex');
    let stored = await prisma.messageEvent.findUnique({ where: { deduplicationKey } });
    if (!stored) {
      try {
        stored = await prisma.messageEvent.create({
          data: {
            providerMessageId: identity || null,
            providerEventId: identity || null,
            eventType: type,
            deduplicationKey,
            payload: value as Prisma.InputJsonValue,
          },
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
          throw error;
        stored = await prisma.messageEvent.findUnique({ where: { deduplicationKey } });
      }
    }
    if (!stored) throw new Error('Não foi possível persistir o evento do webhook');

    if (stored.processingStatus === 'FAILED') {
      const reset = await prisma.messageEvent.updateMany({
        where: { id: stored.id, processingStatus: 'FAILED' },
        data: { processingStatus: 'PENDING', processingError: null, processedAt: null },
      });
      if (reset.count) {
        stored = await prisma.messageEvent.findUnique({ where: { id: stored.id } });
      }
    }
    if (!stored) throw new Error('Não foi possível recuperar o evento do webhook');

    if (stored.processingStatus === 'PENDING') {
      const jobId = `webhook:${stored.id}`;
      const existingJob = await this.queue.getJob(jobId);
      if (existingJob) {
        const state = await existingJob.getState();
        if (state === 'failed' || state === 'completed') await existingJob.remove();
      }
      await this.queue.add(
        'process-webhook',
        { messageEventId: stored.id },
        {
          jobId,
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: 1_000,
          removeOnFail: 1_000,
        },
      );
    }
  }
}

export function normalizeMetaEvents(body: JsonRecord): JsonRecord[] {
  if (body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
    throw new BadRequestException('Evento recebido não é uma notificação WhatsApp da Meta');
  }
  const events: JsonRecord[] = [];
  for (const entryValue of body.entry) {
    const entry = record(entryValue);
    for (const changeValue of Array.isArray(entry.changes) ? entry.changes : []) {
      const change = record(changeValue);
      if (change.field !== 'messages') continue;
      const value = record(change.value);
      for (const statusValue of Array.isArray(value.statuses) ? value.statuses : []) {
        const status = record(statusValue);
        const errors = Array.isArray(status.errors) ? record(status.errors[0]) : {};
        const pricing = record(status.pricing);
        events.push(
          compact({
            type: 'message-event',
            timestamp: status.timestamp,
            payload: {
              id: status.id,
              type: status.status,
              payload: {
                ts: status.timestamp,
                code: errors.code,
                reason: record(errors.error_data).details ?? errors.title ?? errors.message,
              },
            },
          }),
        );
        if (Object.keys(pricing).length > 0) {
          events.push(
            compact({
              type: 'billing-event',
              timestamp: status.timestamp,
              payload: {
                id: status.id,
                providerEventId: `${String(status.id ?? 'unknown')}:${String(status.status ?? 'unknown')}:${String(status.timestamp ?? 'unknown')}`,
                payload: {
                  status: status.status,
                  billable: pricing.billable,
                  category: pricing.category,
                  pricing_model: pricing.pricing_model,
                  pricing,
                },
              },
            }),
          );
        }
      }
      for (const messageValue of Array.isArray(value.messages) ? value.messages : []) {
        const message = record(messageValue);
        const interactive = record(message.interactive);
        const button = record(message.button);
        const buttonReply = record(interactive.button_reply);
        const listReply = record(interactive.list_reply);
        const context = record(message.context);
        const textBody = record(message.text);
        const isButton = message.type === 'button' || message.type === 'interactive';
        const text = String(
          button.text ??
            buttonReply.title ??
            buttonReply.id ??
            listReply.title ??
            listReply.id ??
            textBody.body ??
            '',
        );
        events.push(
          compact({
            type: 'message',
            timestamp: message.timestamp,
            payload: {
              id: message.id,
              source: message.from,
              context: { id: context.id },
              type: isButton ? 'button_reply' : message.type,
              payload: {
                type: isButton ? 'button' : message.type,
                text,
                title: text,
                buttonPayload: button.payload ?? buttonReply.id,
              },
            },
          }),
        );
      }
    }
  }
  return events;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function compact(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [
        key,
        item && typeof item === 'object' && !Array.isArray(item) ? compact(item) : item,
      ]),
  );
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
