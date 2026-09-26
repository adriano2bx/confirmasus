import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { sendMetaTemplate, sendMetaText, WhatsAppApiError } from './meta-whatsapp-client.js';

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  token: process.env.META_WHATSAPP_ACCESS_TOKEN,
  phoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID,
  version: process.env.META_GRAPH_API_VERSION,
  language: process.env.META_WHATSAPP_LANGUAGE,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  restore('META_WHATSAPP_ACCESS_TOKEN', originalEnvironment.token);
  restore('META_WHATSAPP_PHONE_NUMBER_ID', originalEnvironment.phoneNumberId);
  restore('META_GRAPH_API_VERSION', originalEnvironment.version);
  restore('META_WHATSAPP_LANGUAGE', originalEnvironment.language);
});

describe('WhatsApp Cloud API', () => {
  it('envia template com nome, idioma e parâmetro do paciente', async () => {
    configure();
    let request: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = async (url, init) => {
      request = { url: String(url), init: init ?? {} };
      return Response.json({ messages: [{ id: 'wamid.sent' }] });
    };

    const result = await sendMetaTemplate({
      destination: '+55 (11) 99999-9999',
      stage: 'FIRST',
      templateName: 'primeira_convocacao_sus_unico',
      patientName: 'Maria da Silva',
    });

    assert.deepEqual(result, { providerMessageId: 'wamid.sent' });
    assert.equal(request?.url, 'https://graph.facebook.com/v22.0/123456/messages');
    assert.equal(new Headers(request?.init.headers).get('authorization'), 'Bearer test-token');
    assert.deepEqual(JSON.parse(String(request?.init.body)), {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511999999999',
      type: 'template',
      template: {
        name: 'primeira_convocacao_sus_unico',
        language: { code: 'pt_BR' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: 'Maria da Silva' }] },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '0',
            parameters: [{ type: 'payload', payload: 'CONFIRM' }],
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '1',
            parameters: [{ type: 'payload', payload: 'CANCEL' }],
          },
        ],
      },
    });
  });

  it('envia resposta de texto pela mesma API', async () => {
    configure();
    let payload: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return Response.json({ messages: [{ id: 'wamid.reply' }] });
    };
    assert.deepEqual(await sendMetaText({ destination: '5511999999999', text: ' Confirmado. ' }), {
      providerMessageId: 'wamid.reply',
    });
    assert.equal(payload?.type, 'text');
    assert.deepEqual(payload?.text, { preview_url: false, body: 'Confirmado.' });
  });

  it('distingue falha temporária de configuração ausente', async () => {
    configure();
    globalThis.fetch = async () =>
      Response.json({ error: { code: 131000, message: 'Erro Meta' } }, { status: 503 });
    await assert.rejects(
      sendMetaText({ destination: '5511999999999', text: 'Oi' }),
      (error: unknown) =>
        error instanceof WhatsAppApiError && error.code === '131000' && error.retryable,
    );
    delete process.env.META_WHATSAPP_ACCESS_TOKEN;
    await assert.rejects(
      sendMetaText({ destination: '5511999999999', text: 'Oi' }),
      (error: unknown) =>
        error instanceof WhatsAppApiError &&
        error.code === 'CONFIGURATION_ERROR' &&
        !error.retryable,
    );
  });
});

function configure() {
  process.env.META_WHATSAPP_ACCESS_TOKEN = 'test-token';
  process.env.META_WHATSAPP_PHONE_NUMBER_ID = '123456';
  process.env.META_GRAPH_API_VERSION = 'v22.0';
  process.env.META_WHATSAPP_LANGUAGE = 'pt_BR';
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
