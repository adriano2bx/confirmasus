import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@confirma/database';
import type { SendHumanMessageJob } from '@confirma/queue';
import type { Queue } from 'bullmq';
import { InboxActionsService } from './inbox-actions.service.js';
import { InboxQueryService } from './inbox-query.service.js';
import { pollInboxEvents } from './inbox-stream.service.js';
import { loadActor, type RequestUser } from './inbox-summary.js';

/**
 * Integração com PostgreSQL real (migrações aplicadas). Pulado sem INTEGRATION_DATABASE_URL;
 * roda na VPS. Dados sintéticos, removidos ao final.
 */
const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;

describe('inbox (integração PostgreSQL)', { skip: !DATABASE_URL }, () => {
  const db = new PrismaClient({ datasourceUrl: DATABASE_URL ?? '' });
  const added: unknown[] = [];
  const queue = {
    add: async (...args: unknown[]) => void added.push(args),
  } as unknown as Queue<SendHumanMessageJob>;
  const actions = new InboxActionsService(db, queue);
  const query = new InboxQueryService(db);
  const suffix = randomUUID().slice(0, 8);
  const ids = {
    users: [] as string[],
    teams: [] as string[],
    contacts: [] as string[],
    conversations: [] as string[],
    patients: [] as string[],
    imports: [] as string[],
  };
  let teamA = '';
  let teamB = '';
  let agentA1: RequestUser;
  let agentA2: RequestUser;
  let supervisorA: RequestUser;
  let agentB: RequestUser;

  async function user(label: string): Promise<RequestUser> {
    const created = await db.user.create({
      data: {
        name: `Teste ${label}`,
        email: `inbox-${label}-${suffix}@example.invalid`,
        passwordHash: 'x',
      },
    });
    ids.users.push(created.id);
    return { sub: created.id, role: 'OPERATOR' };
  }

  function waId(): string {
    return `5599${Math.floor(Math.random() * 1e9)
      .toString()
      .padStart(9, '0')}`;
  }

  async function conversation(input: {
    teamId: string;
    assigneeId?: string | null;
    lastEligibleInboundAt?: Date | null;
    contactWaId?: string;
  }) {
    const contact = await db.whatsAppContact.create({
      data: { waId: input.contactWaId ?? waId() },
    });
    ids.contacts.push(contact.id);
    const created = await db.conversation.create({
      data: {
        protocol: `ATD-2099-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        contactId: contact.id,
        phoneNumberId: 'pn-integration',
        teamId: input.teamId,
        assigneeId: input.assigneeId ?? null,
        lastEligibleInboundAt: input.lastEligibleInboundAt ?? null,
      },
    });
    ids.conversations.push(created.id);
    return { ...created, waId: contact.waId };
  }

  async function status(promise: Promise<unknown>): Promise<number> {
    try {
      await promise;
      return 200;
    } catch (error) {
      if (error instanceof HttpException) return error.getStatus();
      throw error;
    }
  }

  before(async () => {
    const a = await db.team.create({
      data: { name: `Equipe A ${suffix}`, slug: `int-a-${suffix}` },
    });
    const b = await db.team.create({
      data: { name: `Equipe B ${suffix}`, slug: `int-b-${suffix}` },
    });
    teamA = a.id;
    teamB = b.id;
    ids.teams.push(teamA, teamB);
    agentA1 = await user('a1');
    agentA2 = await user('a2');
    supervisorA = await user('sa');
    agentB = await user('b1');
    await db.teamMember.createMany({
      data: [
        { teamId: teamA, userId: agentA1.sub, role: 'AGENT' },
        { teamId: teamA, userId: agentA2.sub, role: 'AGENT' },
        { teamId: teamA, userId: supervisorA.sub, role: 'SUPERVISOR' },
        { teamId: teamB, userId: agentB.sub, role: 'AGENT' },
      ],
    });
  });

  after(async () => {
    const conversationId = { in: ids.conversations };
    await db.inboxEvent.deleteMany({ where: { conversationId } });
    await db.conversationActivity.deleteMany({ where: { conversationId } });
    await db.conversationNote.deleteMany({ where: { conversationId } });
    await db.conversationMessage.deleteMany({ where: { conversationId } });
    await db.conversationContext.deleteMany({ where: { conversationId } });
    await db.conversation.deleteMany({ where: { id: conversationId } });
    await db.convocation.deleteMany({ where: { patientId: { in: ids.patients } } });
    await db.patient.deleteMany({ where: { id: { in: ids.patients } } });
    await db.campaign.deleteMany({ where: { importId: { in: ids.imports } } });
    await db.import.deleteMany({ where: { id: { in: ids.imports } } });
    await db.whatsAppContact.deleteMany({ where: { id: { in: ids.contacts } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids.users } } });
    await db.team.deleteMany({ where: { id: { in: ids.teams } } });
    await db.user.deleteMany({ where: { id: { in: ids.users } } });
    await db.$disconnect();
  });

  const send = (who: RequestUser, conversationId: string, key = randomUUID()) =>
    actions.sendMessage(who, conversationId, { body: 'Mensagem de teste', idempotencyKey: key });

  const countMessages = (conversationId: string) =>
    db.conversationMessage.count({ where: { conversationId } });

  it('POST messages sem inbound elegível => 422 e nenhuma mensagem', async () => {
    const conv = await conversation({ teamId: teamA, assigneeId: agentA1.sub });
    assert.equal(await status(send(agentA1, conv.id)), 422);
    assert.equal(await countMessages(conv.id), 0);
    const blocked = await db.conversationActivity.count({
      where: { conversationId: conv.id, type: 'HUMAN_SEND_BLOCKED' },
    });
    assert.equal(blocked, 1);
  });

  it('janela expirada => 422', async () => {
    const conv = await conversation({
      teamId: teamA,
      assigneeId: agentA1.sub,
      lastEligibleInboundAt: new Date(Date.now() - 24 * 60 * 60_000),
    });
    assert.equal(await status(send(agentA1, conv.id)), 422);
    assert.equal(await countMessages(conv.id), 0);
  });

  it('não responsável => 422 e usuário de outra equipe => 404', async () => {
    const conv = await conversation({
      teamId: teamA,
      assigneeId: agentA1.sub,
      lastEligibleInboundAt: new Date(Date.now() - 60_000),
    });
    assert.equal(await status(send(agentA2, conv.id)), 422);
    assert.equal(await status(send(supervisorA, conv.id)), 422);
    assert.equal(await status(send(agentB, conv.id)), 404);
    assert.equal(await status(query.detail(agentB, conv.id)), 404);
    assert.equal(await countMessages(conv.id), 0);
  });

  it('idempotencyKey repetido (inclusive concorrente) não duplica', async () => {
    const conv = await conversation({
      teamId: teamA,
      assigneeId: agentA1.sub,
      lastEligibleInboundAt: new Date(Date.now() - 60_000),
    });
    const key = randomUUID();
    const [first, second] = await Promise.all([
      send(agentA1, conv.id, key),
      send(agentA1, conv.id, key),
    ]);
    const third = await send(agentA1, conv.id, key);
    assert.equal(first.message.id, second.message.id);
    assert.equal(first.message.id, third.message.id);
    assert.equal(first.message.status, 'QUEUED');
    assert.equal(await countMessages(conv.id), 1);
  });

  it('claim concorrente: um vence, outro 409', async () => {
    const conv = await conversation({ teamId: teamA });
    const results = await Promise.allSettled([
      actions.claim(agentA1, conv.id, conv.version),
      actions.claim(agentA2, conv.id, conv.version),
    ]);
    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    const rejected = results.filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    );
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.reason instanceof HttpException);
    assert.equal((rejected[0].reason as HttpException).getStatus(), 409);
    const stored = await db.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    assert.equal(stored.version, conv.version + 1);
    assert.ok(stored.assigneeId);
    const assigned = await db.conversationActivity.count({
      where: { conversationId: conv.id, type: 'ASSIGNED' },
    });
    assert.equal(assigned, 1);
  });

  it('transferência registra atividade com motivo; destino fora da equipe é rejeitado', async () => {
    const conv = await conversation({ teamId: teamA, assigneeId: agentA1.sub });
    assert.equal(
      await status(
        actions.transfer(agentA1, conv.id, {
          version: conv.version,
          toTeamId: teamA,
          toUserId: agentB.sub,
          reason: 'Teste',
        }),
      ),
      422,
    );
    const summary = await actions.transfer(agentA1, conv.id, {
      version: conv.version,
      toTeamId: teamB,
      reason: 'Encaminhar para equipe B',
    });
    assert.equal(summary.team?.id, teamB);
    assert.equal(summary.assignee, null);
    const activity = await db.conversationActivity.findFirstOrThrow({
      where: { conversationId: conv.id, type: 'TRANSFERRED' },
    });
    assert.equal(activity.fromTeamId, teamA);
    assert.equal(activity.toTeamId, teamB);
    assert.equal(activity.fromUserId, agentA1.sub);
    assert.equal(activity.reason, 'Encaminhar para equipe B');
  });

  it('nota não cria conversation_message nem job', async () => {
    const conv = await conversation({ teamId: teamA });
    added.length = 0;
    await actions.addNote(agentA2, conv.id, { body: 'Nota interna de teste' });
    assert.equal(await countMessages(conv.id), 0);
    assert.equal(await db.conversationNote.count({ where: { conversationId: conv.id } }), 1);
    assert.equal(added.length, 0);
  });

  it('claim pausa convocações pelo telefone; resolver não limpa; resume limpa com auditoria', async () => {
    const contactWaId = waId();
    const imported = await db.import.create({ data: {} });
    ids.imports.push(imported.id);
    const campaign = await db.campaign.create({
      data: { importId: imported.id, name: `Campanha ${suffix}` },
    });
    const patient = await db.patient.create({
      data: {
        normalizedName: 'paciente ficticio',
        displayName: 'Paciente Fictício',
        phones: {
          create: {
            originalValue: contactWaId,
            normalizedValue: contactWaId,
            valid: true,
            mobile: true,
          },
        },
      },
      include: { phones: true },
    });
    ids.patients.push(patient.id);
    const convocation = await db.convocation.create({
      data: {
        campaignId: campaign.id,
        patientId: patient.id,
        selectedPhoneId: patient.phones[0]?.id ?? null,
        status: 'WAITING_RESPONSE',
        nextActionAt: new Date(Date.now() - 60_000),
      },
    });
    const conv = await conversation({ teamId: teamA, contactWaId });

    const detail = await query.detail(agentA1, conv.id);
    assert.deepEqual(
      detail.candidates.map((item) => item.convocationId),
      [convocation.id],
    );
    assert.equal(detail.contexts.length, 0, 'candidato por telefone não é vínculo');

    const claimed = await actions.claim(agentA1, conv.id, conv.version);
    assert.equal(claimed.automationPaused, true);
    let held = await db.convocation.findUniqueOrThrow({ where: { id: convocation.id } });
    assert.ok(held.humanHoldAt);
    assert.equal(held.humanHoldConversationId, conv.id);

    const resolved = await actions.updateStatus(agentA1, conv.id, {
      version: claimed.version,
      status: 'RESOLVED',
    });
    held = await db.convocation.findUniqueOrThrow({ where: { id: convocation.id } });
    assert.ok(held.humanHoldAt, 'resolver não retoma');

    const preview = await query.automation(supervisorA, conv.id);
    assert.equal(preview.paused[0]?.overdue, true);
    assert.equal(
      await status(
        actions.resumeAutomation(agentA1, conv.id, {
          version: resolved.version,
          convocationIds: [convocation.id],
        }),
      ),
      403,
    );
    await actions.resumeAutomation(supervisorA, conv.id, {
      version: resolved.version,
      convocationIds: [convocation.id],
    });
    held = await db.convocation.findUniqueOrThrow({ where: { id: convocation.id } });
    assert.equal(held.humanHoldAt, null);
    const audit = await db.auditLog.count({
      where: {
        entityType: 'convocation',
        entityId: convocation.id,
        eventType: 'INBOX_AUTOMATION_RESUMED',
      },
    });
    assert.equal(audit, 1);
  });

  it('SSE filtra eventos por equipe', async () => {
    const last = await db.inboxEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
    const start = last?.id ?? 0n;
    const convA = await conversation({ teamId: teamA });
    const convB = await conversation({ teamId: teamB });
    await db.inboxEvent.createMany({
      data: [
        {
          conversationId: convA.id,
          teamId: teamA,
          type: 'conversation.updated',
          entityId: convA.id,
        },
        {
          conversationId: convB.id,
          teamId: teamB,
          type: 'conversation.updated',
          entityId: convB.id,
        },
      ],
    });
    const actorB = await loadActor(db, agentB);
    const events = await pollInboxEvents(db, actorB, {
      cursor: start,
      floor: start,
      sent: new Map(),
    });
    assert.ok(events.length >= 1);
    assert.ok(events.every((event) => event.conversationId !== convA.id));
    assert.ok(events.some((event) => event.conversationId === convB.id));
  });
});
