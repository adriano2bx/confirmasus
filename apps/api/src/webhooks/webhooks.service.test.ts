import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import type { ProcessWebhookJob } from '@confirma/queue';
import type { Queue } from 'bullmq';
import { normalizeMetaEvents, WebhooksService } from './webhooks.service.js';

const originalAppSecret = process.env.META_APP_SECRET;
const originalVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

afterEach(() => {
  restore('META_APP_SECRET', originalAppSecret);
  restore('META_WEBHOOK_VERIFY_TOKEN', originalVerifyToken);
});

describe('webhook da Meta', () => {
  it('normaliza status e resposta de botão do payload oficial', () => {
    const events = normalizeMetaEvents({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [
                  {
                    id: 'wamid.sent',
                    status: 'delivered',
                    timestamp: '1725000001',
                    pricing: { billable: true, category: 'utility', pricing_model: 'PMP' },
                  },
                ],
                messages: [
                  {
                    id: 'wamid.inbound',
                    from: '5511999999999',
                    timestamp: '1725000002',
                    type: 'button',
                    context: { id: 'wamid.sent' },
                    button: { text: 'Confirmar', payload: 'CONFIRM' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((event) => event.type),
      ['message-event', 'billing-event', 'message'],
    );
    assert.deepEqual(events[2]?.payload, {
      id: 'wamid.inbound',
      source: '5511999999999',
      context: { id: 'wamid.sent' },
      type: 'button_reply',
      payload: { type: 'button', text: 'Confirmar', title: 'Confirmar', buttonPayload: 'CONFIRM' },
    });
  });

  it('exige token de verificação e assinatura correta antes de persistir', async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify-secret';
    process.env.META_APP_SECRET = 'app-secret';
    const service = new WebhooksService({} as Queue<ProcessWebhookJob>);
    assert.equal(service.verify('subscribe', 'verify-secret', 'challenge'), 'challenge');
    assert.throws(() => service.verify('subscribe', 'wrong', 'challenge'));
    const rawBody = Buffer.from('{}');
    await assert.rejects(service.receive({}, 'sha256=wrong', rawBody));
    const signature = `sha256=${createHmac('sha256', 'app-secret').update(rawBody).digest('hex')}`;
    await assert.rejects(service.receive({}, signature, rawBody), /notificação WhatsApp da Meta/);
  });
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
