import type { MessageStage } from '@confirma/domain';
import {
  acquireSendPermit,
  createRedisConnection,
  sendPermitOptionsFromEnv,
  type SendPermit,
} from '@confirma/queue';
import { DelayedError, type Job } from 'bullmq';

interface MetaSuccessResponse {
  messages?: Array<{ id?: string }>;
  error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean };
}

const RETRYABLE_META_ERROR_CODES = new Set([130429, 131048, 131056]);
/** Falhas em que a conexão nunca foi estabelecida: o request não saiu, repetir é seguro. */
const PRE_CONNECT_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    /**
     * true quando o request pode ter chegado à Meta (timeout/abort/reset após conectar,
     * resposta ilegível). A campanha mantém a política atual (`retryable`); o envio humano
     * não repete e marca a mensagem como UNKNOWN.
     */
    readonly ambiguous = false,
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
  /** Devolvido pela Meta nos status (`biz_opaque_callback_data`); máx. 512 caracteres. */
  bizOpaqueCallbackData?: string;
  /** phone_number_id remetente; padrão META_WHATSAPP_PHONE_NUMBER_ID. */
  phoneNumberId?: string;
}): Promise<{ providerMessageId: string }> {
  const destination = input.destination.replace(/\D/g, '');
  const text = input.text.trim();
  if (!/^\d{8,15}$/.test(destination)) {
    throw new WhatsAppApiError('Número de destino inválido.', 'INVALID_PHONE', false);
  }
  if (!text)
    throw new WhatsAppApiError('O texto da resposta automática está vazio.', 'INVALID_TEXT', false);
  if (input.bizOpaqueCallbackData !== undefined && input.bizOpaqueCallbackData.length > 512) {
    throw new WhatsAppApiError(
      'biz_opaque_callback_data excede 512 caracteres.',
      'INVALID_TEXT',
      false,
    );
  }
  return send(
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: destination,
      type: 'text',
      text: { preview_url: false, body: text },
      ...(input.bizOpaqueCallbackData !== undefined
        ? { biz_opaque_callback_data: input.bizOpaqueCallbackData }
        : {}),
    },
    input.phoneNumberId,
  );
}

async function send(
  payload: Record<string, unknown>,
  phoneNumberIdOverride?: string,
): Promise<{ providerMessageId: string }> {
  const token = required('META_WHATSAPP_ACCESS_TOKEN');
  const phoneNumberId = phoneNumberIdOverride?.trim() || required('META_WHATSAPP_PHONE_NUMBER_ID');
  const version = process.env.META_GRAPH_API_VERSION ?? 'v22.0';
  let response: Response;
  try {
    response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (isPreConnectFailure(error)) {
      throw new WhatsAppApiError('Não foi possível conectar à API da Meta.', 'NETWORK_ERROR', true);
    }
    // Timeout, abort ou reset depois de conectar: a Meta pode ter aceitado o envio.
    throw new WhatsAppApiError(
      'Sem resposta conclusiva da API da Meta; o envio pode ter ocorrido.',
      'AMBIGUOUS_TIMEOUT',
      true,
      true,
    );
  }

  let body: MetaSuccessResponse;
  try {
    body = JSON.parse(await response.text()) as MetaSuccessResponse;
  } catch {
    if (response.ok) {
      throw new WhatsAppApiError(
        'Resposta ilegível da API da Meta; o envio pode ter ocorrido.',
        'AMBIGUOUS_TIMEOUT',
        true,
        true,
      );
    }
    body = {};
  }
  if (!response.ok || body.error) {
    const code = body.error?.code ? String(body.error.code) : `HTTP_${response.status}`;
    throw new WhatsAppApiError(
      body.error?.message?.slice(0, 300) ?? 'A API da Meta recusou o envio.',
      code,
      response.status >= 500 ||
        response.status === 429 ||
        body.error?.is_transient === true ||
        (body.error?.code !== undefined && RETRYABLE_META_ERROR_CODES.has(body.error.code)),
    );
  }
  const providerMessageId = body.messages?.[0]?.id;
  if (!providerMessageId) {
    throw new WhatsAppApiError(
      'Resposta da Meta sem identificador da mensagem.',
      'MALFORMED_RESPONSE',
      true,
      true,
    );
  }
  return { providerMessageId };
}

/** true somente se todas as causas conhecidas indicam que a conexão nunca foi aberta. */
export function isPreConnectFailure(error: unknown): boolean {
  const codes: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || typeof value !== 'object' || value === null) return;
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    if (value instanceof AggregateError) value.errors.forEach((item) => visit(item, depth + 1));
    visit((value as { cause?: unknown }).cause, depth + 1);
  };
  visit(error, 0);
  return codes.length > 0 && codes.every((code) => PRE_CONNECT_ERROR_CODES.has(code));
}

let limiterConnection: ReturnType<typeof createRedisConnection> | undefined;

/**
 * Permissão do limiter compartilhado (Redis) por phone_number_id. Usado por campanha,
 * resposta automática e envio humano imediatamente antes da Cloud API.
 */
export async function acquireMetaSendPermit(
  phoneNumberId: string,
  priority: 'human' | 'campaign',
): Promise<SendPermit> {
  limiterConnection ??= createRedisConnection();
  return acquireSendPermit(limiterConnection, phoneNumberId, {
    ...sendPermitOptionsFromEnv(),
    priority,
  });
}

export async function closeMetaSendLimiter(): Promise<void> {
  const connection = limiterConnection;
  limiterConnection = undefined;
  await connection?.quit();
}

/** phone_number_id configurado para envios de campanha e resposta automática. */
export function configuredPhoneNumberId(): string | null {
  return process.env.META_WHATSAPP_PHONE_NUMBER_ID?.trim() || null;
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

/** O limiter compartilhado não concedeu vaga dentro de maxWaitMs. Nada foi enviado. */
export class SendPermitDeniedError extends WhatsAppApiError {
  constructor(readonly retryAfterMs: number) {
    super('Limite de envio do número atingido; envio reprogramado.', 'SEND_RATE_LIMITED', true);
  }
}

/**
 * Reprograma o job sem consumir tentativa do BullMQ (moveToDelayed + DelayedError).
 * Sem token (ex.: testes), relança `SendPermitDeniedError` para o retry normal do job.
 * Sempre lança.
 */
export async function deferJobForSendPermit(
  job: Pick<Job, 'moveToDelayed'>,
  token: string | undefined,
  retryAfterMs: number,
): Promise<never> {
  if (!token) throw new SendPermitDeniedError(retryAfterMs);
  await job.moveToDelayed(Date.now() + Math.max(1, retryAfterMs), token);
  throw new DelayedError();
}
