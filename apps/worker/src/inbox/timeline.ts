import {
  appendInboxEvent,
  findOrCreateActiveConversation,
  lockConversation,
  upsertContact,
  type Prisma,
} from '@confirma/database';
import { evaluateInboundEligibility } from '@confirma/domain';
import {
  conversationInboundPatch,
  eligibilityFields,
  type InboundTimelineData,
} from './inbound.js';
import { WebhookRetryableError } from './retry.js';

type Tx = Prisma.TransactionClient;

export interface InboundTimelineTarget extends InboundTimelineData {
  waId: string;
  phoneNumberId: string;
}

export interface PersistedInbound {
  conversationId: string;
  teamId: string | null;
  conversationMessageId: string;
  waId: string;
  phoneNumberId: string;
}

export function timelineTarget(data: InboundTimelineData): InboundTimelineTarget | null {
  return data.waId && data.phoneNumberId
    ? { ...data, waId: data.waId, phoneNumberId: data.phoneNumberId }
    : null;
}

/** Reentrega do mesmo inbound (mesmo WAMID ou mesmo evento) já presente na timeline. */
export async function isDuplicateInbound(
  tx: Tx,
  eventId: string,
  waMessageId: string | null,
): Promise<boolean> {
  const existing = await tx.conversationMessage.findFirst({
    where: { OR: [{ sourceEventId: eventId }, ...(waMessageId ? [{ waMessageId }] : [])] },
    select: { id: true },
  });
  return existing !== null;
}

/**
 * Grava o inbound na timeline canônica (contrato §4, passos 1–4 e 7). Deve rodar dentro de
 * `withActiveConversationRetry`, antes do fluxo de campanha (ordem de locks: conversa → convocação).
 * Elegibilidade SOMENTE por context.id via `evaluateInboundEligibility` (gate fechado).
 */
export async function persistInboundTimeline(
  tx: Tx,
  input: {
    eventId: string;
    target: InboundTimelineTarget;
    occurredAt: Date;
    legacyPhoneNumberId: string | null;
  },
): Promise<PersistedInbound> {
  const { target, occurredAt } = input;
  const contact = await upsertContact(tx, { waId: target.waId, profileName: target.profileName });
  const conversation = await lockActiveConversation(
    tx,
    contact.id,
    target.phoneNumberId,
    occurredAt,
  );

  const referenced = target.contextWaMessageId
    ? await tx.message.findFirst({
        where: {
          OR: [
            { providerMessageId: target.contextWaMessageId },
            { providerWhatsAppId: target.contextWaMessageId },
          ],
        },
      })
    : null;
  const eligibility = evaluateInboundEligibility(
    {
      waId: target.waId,
      phoneNumberId: target.phoneNumberId,
      contextWaMessageId: target.contextWaMessageId,
    },
    referenced,
    input.legacyPhoneNumberId,
  );

  const message = await tx.conversationMessage.create({
    data: {
      conversationId: conversation.id,
      direction: 'INBOUND',
      kind: 'INBOUND',
      status: 'RECEIVED',
      contentType: target.contentType,
      body: target.body,
      waMessageId: target.waMessageId,
      contextWaMessageId: target.contextWaMessageId,
      sourceEventId: input.eventId,
      providerTimestamp: occurredAt,
      ...eligibilityFields(eligibility, referenced?.id ?? null),
    },
    select: { id: true },
  });

  if (target.media) {
    await tx.mediaAsset.createMany({
      data: [
        {
          conversationMessageId: message.id,
          providerMediaId: target.media.providerMediaId,
          declaredMimeType: target.media.declaredMimeType,
          status: 'PENDING',
        },
      ],
      skipDuplicates: true,
    });
  }

  const patch = conversationInboundPatch(conversation, occurredAt, eligibility.eligible);
  await tx.conversation.update({
    where: { id: conversation.id },
    data: { ...patch, ...(patch.status ? { version: { increment: 1 } } : {}) },
  });
  if (patch.status) {
    const activity = await tx.conversationActivity.create({
      data: {
        conversationId: conversation.id,
        type: 'STATUS_CHANGED',
        reason: 'INBOUND_RECEIVED',
        metadata: { from: conversation.status, to: patch.status },
      },
      select: { id: true },
    });
    await appendInboxEvent(tx, {
      conversationId: conversation.id,
      teamId: conversation.teamId,
      type: 'activity.created',
      entityId: activity.id,
    });
  }

  if (eligibility.eligible && referenced) {
    await linkTemplateReplyContext(tx, conversation, referenced.convocationId, referenced.id);
  }

  await appendInboxEvent(tx, {
    conversationId: conversation.id,
    teamId: conversation.teamId,
    type: 'message.created',
    entityId: message.id,
  });

  return {
    conversationId: conversation.id,
    teamId: conversation.teamId,
    conversationMessageId: message.id,
    waId: target.waId,
    phoneNumberId: target.phoneNumberId,
  };
}

/**
 * Passos 5 e 8: referências de campanha (exibição do histórico do canal, sem vínculo clínico)
 * e evento da conversa. Rodar depois do fluxo de campanha para incluir a resposta automática.
 */
export async function finalizeInboundTimeline(tx: Tx, persisted: PersistedInbound): Promise<void> {
  await ensureCampaignRefs(tx, persisted.conversationId, persisted.waId, persisted.phoneNumberId);
  await appendInboxEvent(tx, {
    conversationId: persisted.conversationId,
    teamId: persisted.teamId,
    type: 'conversation.updated',
    entityId: persisted.conversationId,
  });
}

const CAMPAIGN_REF_BATCH = 100;

/**
 * Garante CAMPAIGN_REF para envios de campanha a esse wa_id pelo número (ou legados sem número).
 * Só exibição: NÃO cria ConversationContext. Cada linha de `messages` entra em uma única
 * conversa (campaignMessageId único); conversas antigas mantêm suas referências.
 */
export async function ensureCampaignRefs(
  tx: Tx,
  conversationId: string,
  waId: string,
  phoneNumberId: string,
): Promise<number> {
  const rows = await tx.message.findMany({
    where: {
      phone: waId,
      OR: [{ senderPhoneNumberId: phoneNumberId }, { senderPhoneNumberId: null }],
      timelineEntry: { is: null },
    },
    select: { id: true, status: true, templateId: true, createdAt: true, submittedAt: true },
    orderBy: { createdAt: 'asc' },
    take: CAMPAIGN_REF_BATCH,
  });
  if (rows.length === 0) return 0;
  const created = await tx.conversationMessage.createMany({
    data: rows.map((row) => ({
      conversationId,
      direction: 'OUTBOUND' as const,
      kind: 'CAMPAIGN_REF' as const,
      status: row.status,
      contentType: row.templateId === 'SESSION_TEXT' ? 'text' : 'template',
      campaignMessageId: row.id,
      createdAt: row.submittedAt ?? row.createdAt,
    })),
    skipDuplicates: true,
  });
  return created.count;
}

async function lockActiveConversation(tx: Tx, contactId: string, phoneNumberId: string, at: Date) {
  // Uma resolução concorrente entre a busca e o lock leva a uma nova conversa (novo protocolo).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { conversation } = await findOrCreateActiveConversation(tx, {
      contactId,
      phoneNumberId,
      at,
    });
    await lockConversation(tx, conversation.id);
    const current = await tx.conversation.findUniqueOrThrow({
      where: { id: conversation.id },
      select: {
        id: true,
        teamId: true,
        status: true,
        lastInboundAt: true,
        lastEligibleInboundAt: true,
        lastActivityAt: true,
      },
    });
    if (current.status !== 'RESOLVED') return current;
  }
  throw new WebhookRetryableError('CONVERSA_RESOLVIDA_DURANTE_PROCESSAMENTO');
}

async function linkTemplateReplyContext(
  tx: Tx,
  conversation: { id: string; teamId: string | null },
  convocationId: string,
  campaignMessageId: string,
): Promise<void> {
  const existing = await tx.conversationContext.findUnique({
    where: { conversationId_convocationId: { conversationId: conversation.id, convocationId } },
    select: { convocationId: true },
  });
  if (existing) return;
  await tx.conversationContext.create({
    data: { conversationId: conversation.id, convocationId, source: 'TEMPLATE_REPLY' },
  });
  const activity = await tx.conversationActivity.create({
    data: {
      conversationId: conversation.id,
      type: 'CONTEXT_LINKED',
      metadata: { convocationId, source: 'TEMPLATE_REPLY', campaignMessageId },
    },
    select: { id: true },
  });
  await appendInboxEvent(tx, {
    conversationId: conversation.id,
    teamId: conversation.teamId,
    type: 'activity.created',
    entityId: activity.id,
  });
}
