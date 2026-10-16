import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { prisma } from '@confirma/database';
import type { ProcessWebhookJob } from '@confirma/queue';
import type { Queue } from 'bullmq';
import {
  messageEventRow,
  normalizeMetaEvents,
  webhookDeduplicationKey,
  WebhooksService,
} from './webhooks.service.js';

const originalAppSecret = process.env.META_APP_SECRET;
const originalVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
const originalAccepted = process.env.META_ACCEPTED_PHONE_NUMBER_IDS;
const db = prisma as unknown as { $transaction: unknown };
const originalTransaction = db.$transaction;

afterEach(() => {
  restore('META_APP_SECRET', originalAppSecret);
  restore('META_WEBHOOK_VERIFY_TOKEN', originalVerifyToken);
  restore('META_ACCEPTED_PHONE_NUMBER_IDS', originalAccepted);
  db.$transaction = originalTransaction;
});

describe('webhook da Meta', () => {
  it('normaliza status e resposta de botão do payload oficial', () => {
    const events = normalizeMetaEvents(
      notification({
        statuses: [
          {
            id: 'wamid.sent',
            status: 'delivered',
            timestamp: '1725000001',
            recipient_id: '5511999990000',
            biz_opaque_callback_data: 'conversation-message-1',
            pricing: { billable: true, category: 'utility', pricing_model: 'PMP' },
          },
        ],
        messages: [
          {
            id: 'wamid.inbound',
            from: '5511999990000',
            timestamp: '1725000002',
            type: 'button',
            context: { id: 'wamid.sent' },
            button: { text: 'Confirmar', payload: 'CONFIRM' },
          },
        ],
      }),
    );

    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((event) => event.type),
      ['message-event', 'billing-event', 'message'],
    );
    assert.deepEqual(events[0], {
      type: 'message-event',
      timestamp: '1725000001',
      phoneNumberId: 'phone-1',
      payload: {
        id: 'wamid.sent',
        type: 'delivered',
        recipientId: '5511999990000',
        bizOpaque: 'conversation-message-1',
        payload: { ts: '1725000001' },
      },
    });
    assert.equal(events[1]?.phoneNumberId, 'phone-1');
    assert.deepEqual(events[1]?.payload, {
      id: 'wamid.sent',
      providerEventId: 'wamid.sent:delivered:1725000001',
      payload: {
        status: 'delivered',
        billable: true,
        category: 'utility',
        pricing_model: 'PMP',
        pricing: { billable: true, category: 'utility', pricing_model: 'PMP' },
      },
    });
    assert.equal(events[2]?.phoneNumberId, 'phone-1');
    assert.equal(events[2]?.waId, '5511999990000');
    assert.equal(events[2]?.profileName, 'Contato Teste');
    assert.deepEqual(events[2]?.payload, {
      id: 'wamid.inbound',
      source: '5511999990000',
      context: { id: 'wamid.sent' },
      type: 'button_reply',
      payload: { type: 'button', text: 'Confirmar', title: 'Confirmar', buttonPayload: 'CONFIRM' },
    });
  });

  it('normaliza texto, mídia, localização sem coordenadas e tipo desconhecido', () => {
    const events = normalizeMetaEvents(
      notification({
        contacts: [{ wa_id: '5511999990001', profile: { name: 'N'.repeat(200) } }],
        messages: [
          { id: 'wamid.text', from: '5511999990001', type: 'text', text: { body: 'Olá' } },
          {
            id: 'wamid.image',
            from: '5511999990001',
            type: 'image',
            image: { id: 'media-1', mime_type: 'image/jpeg', sha256: 'abc', caption: 'foto' },
          },
          {
            id: 'wamid.doc',
            from: '5511999990002',
            type: 'document',
            document: { id: 'media-2', mime_type: 'application/pdf', filename: 'guia.pdf' },
          },
          {
            id: 'wamid.location',
            from: '5511999990001',
            type: 'location',
            location: { latitude: -23.5, longitude: -46.6, name: 'Casa' },
          },
          {
            id: 'wamid.reaction',
            from: '5511999990001',
            type: 'reaction',
            reaction: { emoji: 'x' },
          },
        ],
      }),
    );

    assert.equal(events.length, 5);
    const [text, image, doc, location, unknown] = events;
    assert.equal(text?.profileName, 'N'.repeat(120));
    assert.deepEqual(record(text?.payload).payload, { type: 'text', text: 'Olá', title: 'Olá' });
    assert.deepEqual(record(record(image?.payload).payload).media, {
      id: 'media-1',
      mimeType: 'image/jpeg',
      sha256: 'abc',
    });
    assert.equal(record(record(image?.payload).payload).text, 'foto');
    // contato diferente do remetente: waId cai para o `from` e sem nome de perfil.
    assert.equal(doc?.waId, '5511999990002');
    assert.equal(doc?.profileName, undefined);
    assert.deepEqual(record(record(doc?.payload).payload).media, {
      id: 'media-2',
      mimeType: 'application/pdf',
      filename: 'guia.pdf',
    });
    assert.deepEqual(record(location?.payload).payload, {
      type: 'location',
      text: '',
      title: '',
    });
    assert.doesNotMatch(JSON.stringify(location), /-23\.5|-46\.6|Casa/);
    assert.equal(record(unknown?.payload).type, 'unknown');
    assert.deepEqual(record(unknown?.payload).payload, { type: 'unknown', text: '', title: '' });
  });

  it('gera chaves determinísticas iguais em replay', () => {
    const body = notification({
      statuses: [
        {
          id: 'wamid.sent',
          status: 'read',
          timestamp: '1725000009',
          pricing: { billable: true },
        },
      ],
      messages: [{ id: 'wamid.inbound', from: '5511999990000', type: 'text', text: { body: 'a' } }],
    });
    const first = normalizeMetaEvents(body).map(webhookDeduplicationKey);
    const replay = normalizeMetaEvents(structuredClone(body)).map(webhookDeduplicationKey);
    assert.deepEqual(first, [
      'status:wamid.sent:read:1725000009',
      'billing:wamid.sent:read:1725000009',
      'message:wamid.inbound',
    ]);
    assert.deepEqual(replay, first);

    const row = messageEventRow(normalizeMetaEvents(body)[2] ?? {});
    assert.equal(row.phoneNumberId, 'phone-1');
    assert.equal(row.waId, '5511999990000');
    assert.equal(row.providerMessageId, 'wamid.inbound');
    assert.equal(row.eventType, 'message');
  });

  it('rejeita eventos sem identificador obrigatório', () => {
    assert.throws(
      () => normalizeMetaEvents(notification({ messages: [{ from: '5511999990000' }] })),
      /sem identificador/,
    );
    assert.throws(
      () => normalizeMetaEvents(notification({ statuses: [{ id: 'wamid.x' }] })),
      /sem identificador/,
    );
  });

  it('exige token de verificação e assinatura correta antes de persistir', async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify-secret';
    process.env.META_APP_SECRET = 'app-secret';
    let transactions = 0;
    db.$transaction = async () => {
      transactions += 1;
      return [];
    };
    const service = new WebhooksService({} as Queue<ProcessWebhookJob>);
    assert.equal(service.verify('subscribe', 'verify-secret', 'challenge'), 'challenge');
    assert.throws(() => service.verify('subscribe', 'wrong', 'challenge'));
    const rawBody = Buffer.from('{}');
    await assert.rejects(service.receive({}, 'sha256=wrong', rawBody), { status: 403 });
    await assert.rejects(
      service.receive({}, signed(rawBody), rawBody),
      /notificação WhatsApp da Meta/,
    );
    assert.equal(transactions, 0);
  });

  it('rejeita corpo grande (413) e lote grande (400)', async () => {
    process.env.META_APP_SECRET = 'app-secret';
    const service = new WebhooksService({} as Queue<ProcessWebhookJob>);
    const huge = Buffer.alloc(1_048_577, 32);
    await assert.rejects(service.receive({}, signed(huge), huge), { status: 413 });

    const body = notification({
      messages: Array.from({ length: 1_001 }, (_, index) => ({ id: `wamid.${index}` })),
    });
    const raw = Buffer.from(JSON.stringify(body));
    await assert.rejects(service.receive(body, signed(raw), raw), { status: 400 });
  });

  it('grava o lote numa única transação e publica após o commit', async () => {
    process.env.META_APP_SECRET = 'app-secret';
    const calls: string[] = [];
    const store = stubTransaction(calls, [{ key: 'message:wamid.old', status: 'FAILED' }]);
    const added: Array<{ id: string; options: Record<string, unknown> }> = [];
    const queue = {
      add: async (_name: string, data: ProcessWebhookJob, options: Record<string, unknown>) => {
        calls.push('queue.add');
        added.push({ id: data.messageEventId, options });
      },
    } as unknown as Queue<ProcessWebhookJob>;
    const service = new WebhooksService(queue);
    const body = notification({
      statuses: [
        { id: 'wamid.sent', status: 'sent', timestamp: '1', pricing: { billable: false } },
      ],
      messages: [
        { id: 'wamid.new', from: '5511999990000', type: 'text', text: { body: 'oi' } },
        { id: 'wamid.old', from: '5511999990000', type: 'text', text: { body: 'oi' } },
      ],
    });
    const raw = Buffer.from(JSON.stringify(body));
    await service.receive(body, signed(raw), raw);

    assert.equal(store.transactions, 1);
    assert.equal(store.createManyCalls.length, 1);
    assert.equal(store.createManyCalls[0]?.skipDuplicates, true);
    assert.equal(store.createManyCalls[0]?.data.length, 4);
    assert.deepEqual(calls.slice(0, 3), ['transaction', 'createMany', 'findMany']);
    assert.ok(calls.indexOf('commit') < calls.indexOf('queue.add'));
    // replay FAILED não é republicado no request.
    assert.deepEqual(added.map((job) => job.id).sort(), [
      'id:billing:wamid.sent:sent:1',
      'id:message:wamid.new',
      'id:status:wamid.sent:sent:1',
    ]);
    assert.equal(added[0]?.options.jobId, `webhook:${added[0]?.id}`);
    assert.equal(added[0]?.options.attempts, 5);
  });

  it('responde 2xx mesmo com Redis indisponível', async () => {
    process.env.META_APP_SECRET = 'app-secret';
    const store = stubTransaction([], []);
    const queue = {
      add: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    } as unknown as Queue<ProcessWebhookJob>;
    const service = new WebhooksService(queue);
    const body = notification({ messages: [{ id: 'wamid.1', from: '5511999990000' }] });
    const raw = Buffer.from(JSON.stringify(body));
    await service.receive(body, signed(raw), raw);
    assert.equal(store.transactions, 1);
  });

  it('propaga falha de banco para a Meta reenviar', async () => {
    process.env.META_APP_SECRET = 'app-secret';
    let enqueued = false;
    db.$transaction = async () => {
      throw new Error('database unavailable');
    };
    const queue = {
      add: async () => {
        enqueued = true;
      },
    } as unknown as Queue<ProcessWebhookJob>;
    const service = new WebhooksService(queue);
    const body = notification({ messages: [{ id: 'wamid.1', from: '5511999990000' }] });
    const raw = Buffer.from(JSON.stringify(body));
    await assert.rejects(service.receive(body, signed(raw), raw), /database unavailable/);
    assert.equal(enqueued, false);
  });

  it('descarta eventos de phone_number_id não aceito sem erro', async () => {
    process.env.META_APP_SECRET = 'app-secret';
    process.env.META_ACCEPTED_PHONE_NUMBER_IDS = 'outro-numero, mais-um';
    const store = stubTransaction([], []);
    const service = new WebhooksService({} as Queue<ProcessWebhookJob>);
    const body = notification({ messages: [{ id: 'wamid.1', from: '5511999990000' }] });
    const raw = Buffer.from(JSON.stringify(body));
    await service.receive(body, signed(raw), raw);
    assert.equal(store.transactions, 0);

    process.env.META_ACCEPTED_PHONE_NUMBER_IDS = 'phone-1';
    const accepted = stubTransaction([], []);
    const queue = { add: async () => undefined } as unknown as Queue<ProcessWebhookJob>;
    await new WebhooksService(queue).receive(body, signed(raw), raw);
    assert.equal(accepted.transactions, 1);
  });
});

interface CreateManyArgs {
  data: Array<{ deduplicationKey: string }>;
  skipDuplicates?: boolean;
}

/** Simula prisma.$transaction: linhas existentes mantêm o status; novas entram PENDING. */
function stubTransaction(calls: string[], existing: Array<{ key: string; status: string }>) {
  const rows = new Map(existing.map((row) => [row.key, row.status]));
  const state = { transactions: 0, createManyCalls: [] as CreateManyArgs[] };
  const transaction = {
    messageEvent: {
      createMany: async (args: CreateManyArgs) => {
        calls.push('createMany');
        state.createManyCalls.push(args);
        for (const row of args.data) {
          if (!rows.has(row.deduplicationKey)) rows.set(row.deduplicationKey, 'PENDING');
        }
        return { count: args.data.length };
      },
      findMany: async (args: { where: { deduplicationKey: { in: string[] } } }) => {
        calls.push('findMany');
        return args.where.deduplicationKey.in.map((key) => ({
          id: `id:${key}`,
          processingStatus: rows.get(key),
        }));
      },
    },
  };
  db.$transaction = async (callback: (tx: typeof transaction) => Promise<unknown>) => {
    state.transactions += 1;
    calls.push('transaction');
    const result = await callback(transaction);
    calls.push('commit');
    return result;
  };
  return state;
}

function notification(value: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'phone-1', display_phone_number: '551100000000' },
              contacts: [{ wa_id: '5511999990000', profile: { name: 'Contato Teste' } }],
              ...value,
            },
          },
        ],
      },
    ],
  };
}

function signed(rawBody: Buffer) {
  return `sha256=${createHmac('sha256', 'app-secret').update(rawBody).digest('hex')}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
