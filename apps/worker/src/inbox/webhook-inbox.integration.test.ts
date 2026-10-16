import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Job } from 'bullmq';
import type { ProcessWebhookJob } from '@confirma/queue';

/**
 * Integração com PostgreSQL (migrações aplicadas). Pulado sem INTEGRATION_DATABASE_URL.
 * Roda somente na VPS de testes; usa dados sintéticos com identificadores aleatórios.
 */
const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

type Database = typeof import('@confirma/database');
type WebhookWorker = typeof import('../webhook-worker.js');

let db: Database;
let worker: WebhookWorker;
let contextWaitAttempts: number;
const PHONE_NUMBER_ID = `pn-test-${randomBytes(4).toString('hex')}`;

describe('webhook → timeline do inbox (integração)', { skip: !databaseUrl }, () => {
  before(async () => {
    db = await import('@confirma/database');
    worker = await import('../webhook-worker.js');
    contextWaitAttempts = (await import('./retry.js')).WEBHOOK_CONTEXT_WAIT_ATTEMPTS;
  });
  after(async () => {
    await db?.prisma.$disconnect();
  });

  it('resposta a template com context.id abre a janela e cria contexto', async () => {
    const waId = randomPhone();
    const campaign = await seedCampaignMessage(waId);
    const at = new Date('2026-10-16T12:00:00Z');
    const event = await processEnvelope(
      inbound(waId, { contextId: campaign.wamid, at, text: 'Dúvida' }),
    );

    const conversation = await conversationOf(waId);
    assert.equal(conversation.lastEligibleInboundAt?.toISOString(), at.toISOString());
    const messages = await db.prisma.conversationMessage.findMany({
      where: { conversationId: conversation.id, kind: 'INBOUND' },
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.replyEligibility, 'ELIGIBLE_TEMPLATE_REPLY');
    assert.equal(messages[0]?.repliedCampaignMessageId, campaign.messageId);
    assert.equal(messages[0]?.sourceEventId, event.id);
    const context = await db.prisma.conversationContext.findUnique({
      where: {
        conversationId_convocationId: {
          conversationId: conversation.id,
          convocationId: campaign.convocationId,
        },
      },
    });
    assert.equal(context?.source, 'TEMPLATE_REPLY');
    const ref = await db.prisma.conversationMessage.findUnique({
      where: { campaignMessageId: campaign.messageId },
    });
    assert.equal(ref?.kind, 'CAMPAIGN_REF');
    assert.equal(ref?.conversationId, conversation.id);
    assert.equal(await responsesOf(campaign.convocationId), 1);
    const feed = await db.prisma.inboxEvent.count({
      where: { conversationId: conversation.id, type: 'message.created' },
    });
    assert.equal(feed, 1);
  });

  it('inbound espontâneo sem context persiste uma vez e não é elegível', async () => {
    const waId = randomPhone();
    const envelope = inbound(waId, { text: 'Oi' });
    const first = await processEnvelope(envelope);
    assert.equal((await reload(first.id)).processingStatus, 'PROCESSED');
    await processEnvelope(envelope); // mesmo WAMID em outro evento

    const conversation = await conversationOf(waId);
    assert.equal(conversation.lastEligibleInboundAt, null);
    assert.notEqual(conversation.lastInboundAt, null);
    const messages = await db.prisma.conversationMessage.findMany({
      where: { conversationId: conversation.id, kind: 'INBOUND' },
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.replyEligibility, 'NOT_ELIGIBLE');
    assert.equal(messages[0]?.eligibilityReason, 'NO_CONTEXT');
    assert.equal(
      await db.prisma.conversationContext.count({ where: { conversationId: conversation.id } }),
      0,
    );
  });

  it('replay do mesmo evento não duplica mensagem nem MessageResponse', async () => {
    const waId = randomPhone();
    const campaign = await seedCampaignMessage(waId);
    const envelope = inbound(waId, { contextId: campaign.wamid, text: 'Ok' });
    const event = await processEnvelope(envelope);
    await db.prisma.messageEvent.update({
      where: { id: event.id },
      data: { processingStatus: 'PENDING' },
    });
    await run(event.id);
    await processEnvelope(envelope); // reentrega com outro evento e mesmo WAMID

    assert.equal(await responsesOf(campaign.convocationId), 1);
    const conversation = await conversationOf(waId);
    assert.equal(
      await db.prisma.conversationMessage.count({
        where: { conversationId: conversation.id, kind: 'INBOUND' },
      }),
      1,
    );
    assert.equal((await reload(event.id)).processingStatus, 'PROCESSED');
  });

  it('evento atrasado não reduz lastInboundAt nem lastEligibleInboundAt', async () => {
    const waId = randomPhone();
    const first = await seedCampaignMessage(waId);
    const second = await seedCampaignMessage(waId);
    const late = new Date('2026-10-16T10:00:00Z');
    const recent = new Date('2026-10-16T11:00:00Z');
    await processEnvelope(inbound(waId, { contextId: first.wamid, at: recent }));
    await processEnvelope(inbound(waId, { contextId: second.wamid, at: late }));

    const conversation = await conversationOf(waId);
    assert.equal(conversation.lastInboundAt?.toISOString(), recent.toISOString());
    assert.equal(conversation.lastEligibleInboundAt?.toISOString(), recent.toISOString());
  });

  it('CONFIRM e CANCEL continuam alterando a convocação e criando resposta automática', async () => {
    for (const action of ['CONFIRM', 'CANCEL'] as const) {
      const waId = randomPhone();
      const campaign = await seedCampaignMessage(waId);
      await processEnvelope(
        inbound(waId, { contextId: campaign.wamid, button: action, text: 'Botão' }),
      );
      const convocation = await db.prisma.convocation.findUniqueOrThrow({
        where: { id: campaign.convocationId },
      });
      assert.equal(convocation.status, action === 'CONFIRM' ? 'CONFIRMED' : 'CANCELLED');
      const reply = await db.prisma.message.findUnique({
        where: { idempotencyKey: `automatic-reply:${campaign.convocationId}:${action}` },
      });
      assert.equal(reply?.templateId, 'SESSION_TEXT');
      const response = await db.prisma.messageResponse.findFirst({
        where: { convocationId: campaign.convocationId },
      });
      assert.equal(response?.action, action);
    }
  });

  it('status fora de ordem de mensagem humana não regride', async () => {
    const waId = randomPhone();
    await processEnvelope(inbound(waId, { text: 'Oi' }));
    const conversation = await conversationOf(waId);
    const wamid = `wamid.human.${randomUUID()}`;
    const human = await db.prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        direction: 'OUTBOUND',
        kind: 'HUMAN_TEXT',
        status: 'READ',
        contentType: 'text',
        body: 'Resposta sintética',
        waMessageId: wamid,
      },
    });
    await processEnvelope(statusEvent(wamid, 'delivered'));
    const current = await db.prisma.conversationMessage.findUniqueOrThrow({
      where: { id: human.id },
    });
    assert.equal(current.status, 'READ');
    assert.notEqual(current.deliveredAt, null);
  });

  it('status antes do WAMID (bizOpaque) reconcilia UNKNOWN', async () => {
    const waId = randomPhone();
    await processEnvelope(inbound(waId, { text: 'Oi' }));
    const conversation = await conversationOf(waId);
    const human = await db.prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        direction: 'OUTBOUND',
        kind: 'HUMAN_TEXT',
        status: 'UNKNOWN',
        contentType: 'text',
        body: 'Resposta sintética',
      },
    });
    const wamid = `wamid.human.${randomUUID()}`;
    await processEnvelope(statusEvent(wamid, 'sent', human.id));
    const current = await db.prisma.conversationMessage.findUniqueOrThrow({
      where: { id: human.id },
    });
    assert.equal(current.status, 'SENT');
    assert.equal(current.waMessageId, wamid);
  });

  it('status desconhecido em ambas as tabelas falha para retry com erro minimizado', async () => {
    const event = await createEvent(statusEvent(`wamid.none.${randomUUID()}`, 'sent'));
    await assert.rejects(run(event.id));
    const failed = await reload(event.id);
    assert.equal(failed.processingStatus, 'FAILED');
    assert.equal(failed.attempts, 1);
    assert.notEqual(failed.nextAttemptAt, null);
    assert.equal(failed.processingError, 'MENSAGEM_NAO_PERSISTIDA');
  });

  it('context.id desconhecido: espera curta e depois entra uma vez como CONTEXT_NOT_FOUND', async () => {
    const waId = randomPhone();
    const envelope = inbound(waId, { contextId: `wamid.unknown.${randomUUID()}`, text: 'Oi' });
    const event = await createEvent(envelope, contextWaitAttempts - 1);
    await assert.rejects(run(event.id));
    const waiting = await reload(event.id);
    assert.equal(waiting.processingStatus, 'FAILED');
    assert.equal(waiting.processingError, 'MENSAGEM_DE_CONTEXTO_NAO_PERSISTIDA');
    assert.equal(waiting.attempts, contextWaitAttempts);

    await run(event.id); // espera esgotada: persiste sem retry
    assert.equal((await reload(event.id)).processingStatus, 'PROCESSED');
    await db.prisma.messageEvent.update({
      where: { id: event.id },
      data: { processingStatus: 'PENDING' },
    });
    await run(event.id); // replay do mesmo evento
    await processEnvelope(envelope, contextWaitAttempts); // reentrega com outro evento

    const conversation = await conversationOf(waId);
    assert.equal(conversation.lastEligibleInboundAt, null);
    const messages = await db.prisma.conversationMessage.findMany({
      where: { conversationId: conversation.id, kind: 'INBOUND' },
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.replyEligibility, 'NOT_ELIGIBLE');
    assert.equal(messages[0]?.eligibilityReason, 'CONTEXT_NOT_FOUND');
    assert.equal(messages[0]?.sourceEventId, event.id);
    assert.equal(
      await db.prisma.conversationContext.count({ where: { conversationId: conversation.id } }),
      0,
    );
  });

  it('resposta com context.id conhecido continua elegível mesmo após a espera', async () => {
    const waId = randomPhone();
    const campaign = await seedCampaignMessage(waId);
    const event = await processEnvelope(
      inbound(waId, { contextId: campaign.wamid, text: 'Ok' }),
      contextWaitAttempts + 1,
    );
    assert.equal((await reload(event.id)).processingStatus, 'PROCESSED');
    const message = await db.prisma.conversationMessage.findUniqueOrThrow({
      where: { sourceEventId: event.id },
    });
    assert.equal(message.replyEligibility, 'ELIGIBLE_TEMPLATE_REPLY');
    assert.notEqual((await conversationOf(waId)).lastEligibleInboundAt, null);
    assert.equal(await responsesOf(campaign.convocationId), 1);
  });

  it('nova conversa após RESOLVED gera novo protocolo', async () => {
    const waId = randomPhone();
    await processEnvelope(inbound(waId, { text: 'Primeira' }));
    const first = await conversationOf(waId);
    await db.prisma.conversation.update({
      where: { id: first.id },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });
    await processEnvelope(inbound(waId, { text: 'Segunda' }));
    const second = await conversationOf(waId);
    assert.notEqual(second.id, first.id);
    assert.notEqual(second.protocol, first.protocol);
    assert.equal(second.status, 'OPEN');
  });
});

function randomPhone(): string {
  return `5511${Math.floor(100_000_000 + Math.random() * 899_999_999)}`;
}

async function seedCampaignMessage(phone: string) {
  const suffix = randomUUID();
  const importRow = await db.prisma.import.create({ data: { status: 'APPROVED' } });
  const campaign = await db.prisma.campaign.create({
    data: { importId: importRow.id, name: `Teste inbox ${suffix}`, status: 'RUNNING' },
  });
  const patient = await db.prisma.patient.create({
    data: { normalizedName: 'PACIENTE TESTE', displayName: 'Paciente Teste' },
  });
  const convocation = await db.prisma.convocation.create({
    data: { campaignId: campaign.id, patientId: patient.id, status: 'WAITING_RESPONSE' },
  });
  const wamid = `wamid.campaign.${suffix}`;
  const message = await db.prisma.message.create({
    data: {
      convocationId: convocation.id,
      stage: 'FIRST',
      attemptNumber: 1,
      templateName: 'convocacao_teste',
      templateId: 'template-teste',
      phone,
      senderPhoneNumberId: PHONE_NUMBER_ID,
      status: 'SENT',
      providerMessageId: wamid,
      idempotencyKey: `inbox-test:${suffix}`,
      submittedAt: new Date('2026-10-16T09:00:00Z'),
    },
  });
  return { convocationId: convocation.id, messageId: message.id, wamid };
}

function inbound(
  waId: string,
  options: { contextId?: string; text?: string; button?: string; at?: Date },
) {
  const at = options.at ?? new Date();
  return {
    type: 'message',
    timestamp: at.getTime(),
    phoneNumberId: PHONE_NUMBER_ID,
    waId,
    profileName: 'Perfil Teste',
    payload: {
      id: `wamid.inbound.${randomUUID()}`,
      source: waId,
      ...(options.contextId ? { context: { id: options.contextId } } : {}),
      type: options.button ? 'button_reply' : 'text',
      payload: {
        type: options.button ? 'button' : 'text',
        text: options.text ?? 'Mensagem',
        ts: Math.floor(at.getTime() / 1_000),
        ...(options.button ? { buttonPayload: options.button } : {}),
      },
    },
  };
}

function statusEvent(wamid: string, status: string, bizOpaque?: string) {
  const ts = Math.floor(Date.now() / 1_000);
  return {
    type: 'message-event',
    timestamp: ts * 1_000,
    phoneNumberId: PHONE_NUMBER_ID,
    payload: {
      id: wamid,
      type: status,
      ...(bizOpaque ? { bizOpaque } : {}),
      payload: { ts },
    },
  };
}

async function createEvent(envelope: Record<string, unknown>, attempts = 0) {
  const payload = envelope.payload as { id: string };
  return db.prisma.messageEvent.create({
    data: {
      eventType: String(envelope.type),
      providerMessageId: payload.id,
      deduplicationKey: `inbox-test:${randomUUID()}`,
      payload: envelope as never,
      phoneNumberId: PHONE_NUMBER_ID,
      waId: typeof envelope.waId === 'string' ? envelope.waId : null,
      attempts,
    },
  });
}

async function processEnvelope(envelope: Record<string, unknown>, attempts = 0) {
  const event = await createEvent(envelope, attempts);
  await run(event.id);
  return event;
}

function run(messageEventId: string) {
  return worker.processWebhook({ data: { messageEventId } } as Job<ProcessWebhookJob>);
}

function reload(id: string) {
  return db.prisma.messageEvent.findUniqueOrThrow({ where: { id } });
}

async function conversationOf(waId: string) {
  return db.prisma.conversation.findFirstOrThrow({
    where: { contact: { waId }, phoneNumberId: PHONE_NUMBER_ID },
    orderBy: { createdAt: 'desc' },
  });
}

function responsesOf(convocationId: string) {
  return db.prisma.messageResponse.count({ where: { convocationId } });
}
