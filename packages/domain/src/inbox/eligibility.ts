/**
 * Regra de produto obrigatória (Adriano): o atendente humano NUNCA inicia conversa.
 * Só pode responder depois que o contato respondeu a um template de campanha enviado
 * pelo sistema, e somente dentro da janela Meta aberta por essa resposta.
 *
 * Esta é a ÚNICA implementação da regra. API (gate imediatamente antes de aceitar o
 * envio), sender (revalidação imediatamente antes de chamar a Meta) e UI (exibição)
 * devem usar estas funções, nunca reimplementar a regra.
 *
 * Gate fechado: só há correlação segura quando o inbound traz `context.id` (WAMID)
 * apontando para um template de campanha enviado pelo sistema ao MESMO wa_id, pelo
 * MESMO phone_number_id. Texto livre sem `context.id`, correlação por telefone,
 * por horário ou por "última convocação" NÃO autorizam resposta humana.
 */

export const HUMAN_REPLY_WINDOW_MS = 24 * 60 * 60 * 1_000;
/** Margem de segurança contra relógio/latência: fecha a janela antes do limite Meta. */
export const HUMAN_REPLY_WINDOW_SAFETY_MS = 5 * 60 * 1_000;

export type InboundIneligibilityReason =
  | 'NO_CONTEXT'
  | 'CONTEXT_NOT_FOUND'
  | 'CONTEXT_NOT_CAMPAIGN_TEMPLATE'
  | 'RECIPIENT_MISMATCH'
  | 'SENDER_MISMATCH'
  | 'TEMPLATE_NOT_SUBMITTED';

export type InboundEligibility =
  | { eligible: true; reason: 'TEMPLATE_REPLY' }
  | { eligible: false; reason: InboundIneligibilityReason };

/** Linha de `messages` referenciada pelo context.id do inbound. */
export interface ReferencedCampaignMessage {
  stage: string;
  attemptNumber: number;
  templateId: string;
  /** Telefone normalizado (dígitos) para o qual o template foi enviado. */
  phone: string;
  /** phone_number_id que enviou; nulo em registros legados. */
  senderPhoneNumberId: string | null;
  providerMessageId: string | null;
  status: string;
}

export interface InboundForEligibility {
  /** wa_id normalizado do remetente. */
  waId: string;
  /** phone_number_id empresarial que recebeu o inbound. */
  phoneNumberId: string;
  contextWaMessageId: string | null;
}

/** Estágios cujos envios são templates de campanha (a resposta automática é texto de sessão). */
const CAMPAIGN_TEMPLATE_STAGES = new Set(['FIRST', 'SECOND', 'THIRD']);
const AUTOMATIC_REPLY_TEMPLATE_ID = 'SESSION_TEXT';

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Avalia se um inbound é resposta segura a template de campanha.
 * @param referenced linha de `messages` cujo providerMessageId/providerWhatsAppId == context.id
 *   (null se não encontrada).
 * @param legacySenderPhoneNumberId phone_number_id configurado para comparar registros legados
 *   sem `senderPhoneNumberId`. Se ausente, registro legado é inelegível (gate fechado).
 */
export function evaluateInboundEligibility(
  inbound: InboundForEligibility,
  referenced: ReferencedCampaignMessage | null,
  legacySenderPhoneNumberId?: string | null,
): InboundEligibility {
  if (!inbound.contextWaMessageId) return { eligible: false, reason: 'NO_CONTEXT' };
  if (!referenced) return { eligible: false, reason: 'CONTEXT_NOT_FOUND' };
  if (
    !CAMPAIGN_TEMPLATE_STAGES.has(referenced.stage) ||
    referenced.attemptNumber < 1 ||
    referenced.attemptNumber > 3 ||
    referenced.templateId === AUTOMATIC_REPLY_TEMPLATE_ID
  ) {
    return { eligible: false, reason: 'CONTEXT_NOT_CAMPAIGN_TEMPLATE' };
  }
  if (!referenced.providerMessageId || ['QUEUED', 'PROCESSING'].includes(referenced.status)) {
    return { eligible: false, reason: 'TEMPLATE_NOT_SUBMITTED' };
  }
  if (digitsOnly(referenced.phone) !== digitsOnly(inbound.waId)) {
    return { eligible: false, reason: 'RECIPIENT_MISMATCH' };
  }
  const sender = referenced.senderPhoneNumberId ?? legacySenderPhoneNumberId ?? null;
  if (!sender || sender !== inbound.phoneNumberId) {
    return { eligible: false, reason: 'SENDER_MISMATCH' };
  }
  return { eligible: true, reason: 'TEMPLATE_REPLY' };
}

export type HumanReplyBlockReason =
  | 'NO_ELIGIBLE_INBOUND'
  | 'WINDOW_EXPIRED'
  | 'CONTACT_OPTED_OUT'
  | 'CONTACT_BLOCKED'
  | 'CONVERSATION_RESOLVED'
  | 'NOT_ASSIGNEE';

export interface HumanReplyPolicyInput {
  lastEligibleInboundAt: Date | null;
  contactOptedOutAt: Date | null;
  contactBlockedAt: Date | null;
  conversationStatus: string;
  assigneeId: string | null;
  /** Usuário que pretende enviar; null para avaliação apenas informativa (ex.: listagem). */
  actorId: string | null;
}

export interface HumanReplyPolicy {
  allowed: boolean;
  reasons: HumanReplyBlockReason[];
  /** Fim efetivo da janela humana (com margem de segurança) ou null se nunca aberta. */
  windowExpiresAt: Date | null;
}

export function humanReplyWindowExpiresAt(lastEligibleInboundAt: Date | null): Date | null {
  if (!lastEligibleInboundAt) return null;
  return new Date(
    lastEligibleInboundAt.getTime() + HUMAN_REPLY_WINDOW_MS - HUMAN_REPLY_WINDOW_SAFETY_MS,
  );
}

/**
 * Gate server-side do envio humano. Chamar na API (antes de aceitar) e no sender
 * (imediatamente antes da chamada à Meta). Envio humano de template não existe.
 */
export function evaluateHumanReplyPolicy(
  input: HumanReplyPolicyInput,
  now: Date = new Date(),
): HumanReplyPolicy {
  const reasons: HumanReplyBlockReason[] = [];
  const windowExpiresAt = humanReplyWindowExpiresAt(input.lastEligibleInboundAt);
  if (!windowExpiresAt) reasons.push('NO_ELIGIBLE_INBOUND');
  else if (now.getTime() >= windowExpiresAt.getTime()) reasons.push('WINDOW_EXPIRED');
  if (input.contactOptedOutAt) reasons.push('CONTACT_OPTED_OUT');
  if (input.contactBlockedAt) reasons.push('CONTACT_BLOCKED');
  if (input.conversationStatus === 'RESOLVED') reasons.push('CONVERSATION_RESOLVED');
  if (input.actorId !== null && input.assigneeId !== input.actorId) reasons.push('NOT_ASSIGNEE');
  return { allowed: reasons.length === 0, reasons, windowExpiresAt };
}

/** lastInboundAt / lastEligibleInboundAt só avançam (webhook atrasado não encurta a janela). */
export function monotonicMax(current: Date | null, incoming: Date): Date {
  return current && current.getTime() >= incoming.getTime() ? current : incoming;
}

export const HUMAN_REPLY_BLOCK_LABELS: Record<HumanReplyBlockReason, string> = {
  NO_ELIGIBLE_INBOUND:
    'O contato ainda não respondeu a um template de campanha. O atendimento humano não pode iniciar conversa.',
  WINDOW_EXPIRED:
    'A janela de 24 horas desde a última resposta elegível expirou. Envio humano bloqueado.',
  CONTACT_OPTED_OUT: 'O contato pediu para não receber mensagens.',
  CONTACT_BLOCKED: 'O contato está bloqueado.',
  CONVERSATION_RESOLVED: 'A conversa está resolvida.',
  NOT_ASSIGNEE: 'Somente o responsável atribuído pode responder.',
};
