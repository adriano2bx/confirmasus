import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deduplicationKey,
  eventDate,
  inboundContent,
  nextMessageStatus,
  providerMessageId,
} from './webhook-events.js';

describe('normalização de eventos do WhatsApp', () => {
  it('reconhece a resposta de botão do webhook Meta', () => {
    const payload = inboundButton('Quero Confirmar');
    assert.equal(providerMessageId(payload), null);
    assert.deepEqual(inboundContent(payload), {
      text: 'Quero Confirmar',
      isButton: true,
      action: 'CONFIRM',
      source: '5511999999999',
    });
  });

  it('usa o payload do botão mesmo que o texto exibido seja alterado', () => {
    const payload = inboundButton('Sim');
    const withPayload = {
      ...payload,
      payload: {
        ...payload.payload,
        payload: { ...payload.payload.payload, buttonPayload: 'CONFIRM' },
      },
    };
    assert.equal(inboundContent(withPayload).action, 'CONFIRM');
  });

  it('diferencia delivered e read com o mesmo id do WhatsApp', () => {
    const delivered = messageEvent('delivered', 1_725_000_001);
    const read = messageEvent('read', 1_725_000_002);
    assert.notEqual(deduplicationKey(delivered), deduplicationKey(read));
    assert.equal(providerMessageId(delivered), 'wamid.original');
  });

  it('deduplica reentrega da mesma mensagem mesmo se o timestamp externo mudar', () => {
    const original = inboundButton('Cancelar');
    const retry = { ...original, timestamp: 1_725_999_999_999 };
    assert.equal(deduplicationKey(original), deduplicationKey(retry));
  });

  it('usa o horário do provedor e impede regressão de estado', () => {
    const payload = messageEvent('read', 1_725_000_002);
    assert.equal(eventDate(payload).toISOString(), '2024-08-30T06:40:02.000Z');
    assert.equal(nextMessageStatus('READ', 'DELIVERED'), 'READ');
    assert.equal(nextMessageStatus('DELIVERED', 'READ'), 'READ');
    assert.equal(nextMessageStatus('READ', 'FAILED'), 'READ');
  });

  it('classifica texto livre sem contexto e preserva o telefone de origem', () => {
    const payload = {
      type: 'message',
      payload: {
        id: 'inbound-free-1',
        source: '+55 (12) 97412-1245',
        type: 'text',
        payload: { text: 'Preciso de ajuda' },
      },
    };
    assert.equal(providerMessageId(payload), null);
    assert.deepEqual(inboundContent(payload), {
      text: 'Preciso de ajuda',
      isButton: false,
      action: 'UNKNOWN',
      source: '5512974121245',
    });
  });
});

function inboundButton(text: string) {
  return {
    timestamp: 1_725_000_000_000,
    type: 'message',
    payload: {
      id: 'inbound-message-999',
      source: '5511999999999',
      type: 'button_reply',
      payload: { text, type: 'button' },
    },
  };
}

function messageEvent(type: string, ts: number) {
  return {
    timestamp: ts * 1_000,
    type: 'message-event',
    payload: {
      id: 'wamid.original',
      type,
      destination: '5511999999999',
      payload: { ts },
    },
  };
}
