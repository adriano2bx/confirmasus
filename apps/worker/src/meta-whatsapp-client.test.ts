import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  isPreConnectFailure,
  sendMetaTemplate,
  sendMetaText,
  WhatsAppApiError,
} from './meta-whatsapp-client.js';

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

  it('repete limite transitório da Meta retornado como HTTP 400 e não repete erro de template', async () => {
    configure();
    globalThis.fetch = async () =>
      Response.json({ error: { code: 130429, message: 'Rate limit hit' } }, { status: 400 });
    await assert.rejects(
      sendMetaText({ destination: '5511999999999', text: 'Oi' }),
      (error: unknown) =>
        error instanceof WhatsAppApiError && error.code === '130429' && error.retryable,
    );

    globalThis.fetch = async () =>
      Response.json(
        { error: { code: 132000, message: 'Parameter count mismatch' } },
        { status: 400 },
      );
    await assert.rejects(
      sendMetaText({ destination: '5511999999999', text: 'Oi' }),
      (error: unknown) =>
        error instanceof WhatsAppApiError && error.code === '132000' && !error.retryable,
    );
  });

  it('envia biz_opaque_callback_data e usa o phone_number_id informado', async () => {
    configure();
    let request: { url: string; body: Record<string, unknown> } | undefined;
    globalThis.fetch = async (url, init) => {
      request = { url: String(url), body: JSON.parse(String(init?.body)) };
      return Response.json({ messages: [{ id: 'wamid.human' }] });
    };
    await sendMetaText({
      destination: '5511999999999',
      text: 'Olá',
      bizOpaqueCallbackData: 'conversation-message-id',
      phoneNumberId: '999888',
    });
    assert.equal(request?.url, 'https://graph.facebook.com/v22.0/999888/messages');
    assert.equal(request?.body.biz_opaque_callback_data, 'conversation-message-id');

    await sendMetaText({ destination: '5511999999999', text: 'Olá' });
    assert.equal(request?.url, 'https://graph.facebook.com/v22.0/123456/messages');
    assert.equal('biz_opaque_callback_data' in (request?.body ?? {}), false);
  });

  it('falha antes de conectar é repetível e não ambígua', async () => {
    configure();
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }),
      });
    };
    await assert.rejects(
      sendMetaText({ destination: '5511999999999', text: 'Oi' }),
      (error: unknown) =>
        error instanceof WhatsAppApiError &&
        error.code === 'NETWORK_ERROR' &&
        error.retryable &&
        !error.ambiguous,
    );
    assert.equal(
      isPreConnectFailure(
        new TypeError('fetch failed', {
          cause: new AggregateError([
            Object.assign(new Error('a'), { code: 'ECONNREFUSED' }),
            Object.assign(new Error('b'), { code: 'EAI_AGAIN' }),
          ]),
        }),
      ),
      true,
    );
  });

  it('timeout, reset ou resposta ilegível após conectar são ambíguos (campanha segue repetível)', async () => {
    configure();
    globalThis.fetch = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    await assert.rejects(
      sendMetaText({ destination: '5511999999999', text: 'Oi' }),
      (error: unknown) =>
        error instanceof WhatsAppApiError &&
        error.code === 'AMBIGUOUS_TIMEOUT' &&
        error.ambiguous &&
        error.retryable,
    );
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      });
    };
    await assert.rejects(
      sendMetaText({ destination: '5511999999999', text: 'Oi' }),
      (error: unknown) => error instanceof WhatsAppApiError && error.ambiguous,
    );
    globalThis.fetch = async () => new Response('<html>', { status: 200 });
    await assert.rejects(
      sendMetaText({ destination: '5511999999999', text: 'Oi' }),
      (error: unknown) =>
        error instanceof WhatsAppApiError && error.code === 'AMBIGUOUS_TIMEOUT' && error.ambiguous,
    );
  });

  it('erro HTTP com corpo ilegível mantém a classificação por status', async () => {
    configure();
    globalThis.fetch = async () => new Response('bad gateway', { status: 502 });
    await assert.rejects(
      sendMetaText({ destination: '5511999999999', text: 'Oi' }),
      (error: unknown) =>
        error instanceof WhatsAppApiError &&
        error.code === 'HTTP_502' &&
        error.retryable &&
        !error.ambiguous,
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
