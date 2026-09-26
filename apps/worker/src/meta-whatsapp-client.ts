import type { MessageStage } from '@confirma/domain';

interface MetaSuccessResponse {
  messages?: Array<{ id?: string }>;
  error?: { message?: string; code?: number; error_subcode?: number };
}

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export async function sendMetaTemplate(input: {
  destination: string;
  stage: MessageStage;
  templateName: string;
  patientName: string;
}): Promise<{ providerMessageId: string }> {
  const destination = input.destination.replace(/\D/g, '');
  if (!/^\d{8,15}$/.test(destination)) {
    throw new WhatsAppApiError('Número de destino inválido.', 'INVALID_PHONE', false);
  }
  const parameters = [{ type: 'text', text: input.patientName }];
  return send({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: destination,
    type: 'template',
    template: {
      name: input.templateName,
      language: { code: process.env.META_WHATSAPP_LANGUAGE ?? 'pt_BR' },
      components: [
        { type: 'body', parameters },
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
}

export async function sendMetaText(input: {
  destination: string;
  text: string;
}): Promise<{ providerMessageId: string }> {
  const destination = input.destination.replace(/\D/g, '');
  const text = input.text.trim();
  if (!/^\d{8,15}$/.test(destination)) {
    throw new WhatsAppApiError('Número de destino inválido.', 'INVALID_PHONE', false);
  }
  if (!text)
    throw new WhatsAppApiError('O texto da resposta automática está vazio.', 'INVALID_TEXT', false);
  return send({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: destination,
    type: 'text',
    text: { preview_url: false, body: text },
  });
}

async function send(payload: Record<string, unknown>): Promise<{ providerMessageId: string }> {
  const token = required('META_WHATSAPP_ACCESS_TOKEN');
  const phoneNumberId = required('META_WHATSAPP_PHONE_NUMBER_ID');
  const version = process.env.META_GRAPH_API_VERSION ?? 'v22.0';
  let response: Response;
  try {
    response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new WhatsAppApiError('Não foi possível conectar à API da Meta.', 'NETWORK_ERROR', true);
  }

  const body = (await response.json().catch(() => ({}))) as MetaSuccessResponse;
  if (!response.ok || body.error) {
    const code = body.error?.code ? String(body.error.code) : `HTTP_${response.status}`;
    throw new WhatsAppApiError(
      body.error?.message?.slice(0, 300) ?? 'A API da Meta recusou o envio.',
      code,
      response.status >= 500 || response.status === 429,
    );
  }
  const providerMessageId = body.messages?.[0]?.id;
  if (!providerMessageId) {
    throw new WhatsAppApiError(
      'Resposta da Meta sem identificador da mensagem.',
      'MALFORMED_RESPONSE',
      true,
    );
  }
  return { providerMessageId };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new WhatsAppApiError(
      `Configuração obrigatória ausente: ${name}.`,
      'CONFIGURATION_ERROR',
      false,
    );
  return value;
}
