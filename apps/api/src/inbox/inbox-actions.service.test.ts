import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import type { PrismaClient } from '@confirma/database';
import type { SendHumanMessageJob } from '@confirma/queue';
import type { Queue } from 'bullmq';
import { InboxActionsService } from './inbox-actions.service.js';
import { pollInboxEvents } from './inbox-stream.service.js';
import type { SummaryRow } from './inbox-summary.js';

/**
 * Testes de serviço com prisma stubado (sem banco). Cada chamada `modelo.método` é registrada;
 * handlers sobrescrevem o retorno padrão.
 */
type Handler = (args: unknown) => unknown;

function fakeDb(handlers: Record<string, Handler> = {}) {
  const calls: Array<{ op: string; args: unknown }> = [];
  const defaults: Record<string, (args: unknown) => unknown> = {
    findMany: () => [],
    findUnique: () => null,
    findFirst: () => null,
    create: (args) => ({
      id: randomUUID(),
      createdAt: new Date(),
      ...((args as { data?: object }).data ?? {}),
    }),
    update: () => ({ teamId: TEAM_A }),
    updateMany: () => ({ count: 1 }),
    deleteMany: () => ({ count: 1 }),
    createMany: () => ({ count: 1 }),
    upsert: () => ({}),
  };
  const db: unknown = new Proxy(
    {},
    {
      get(_target, model: string) {
        if (model === 'then') return undefined;
        if (model === '$transaction') return async (work: (tx: unknown) => unknown) => work(db);
        if (model === '$queryRaw') {
          return async (...args: unknown[]) => {
            calls.push({ op: '$queryRaw', args });
            return handlers.$queryRaw?.(args) ?? [];
          };
        }
        return new Proxy(
          {},
          {
            get(_inner, method: string) {
              if (method === 'then') return undefined;
              return async (args: unknown) => {
                const op = `${model}.${method}`;
                calls.push({ op, args });
                const handler = handlers[op];
                return handler ? handler(args) : defaults[method]?.(args);
              };
            },
          },
        );
      },
    },
  );
  return {
    db: db as PrismaClient,
    calls,
    ops: () => calls.map((call) => call.op),
    count: (op: string) => calls.filter((call) => call.op === op).length,
  };
}

function fakeQueue(behavior: 'ok' | 'down' = 'ok') {
  const added: unknown[] = [];
  const queue = {
    add: async (...args: unknown[]) => {
      added.push(args);
      if (behavior === 'down') throw new Error('ECONNREFUSED');
      return {};
    },
  };
  return { queue: queue as unknown as Queue<SendHumanMessageJob>, added };
}

const TEAM_A = '00000000-0000-4000-8000-00000000000a';
const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const CONVERSATION = '00000000-0000-4000-8000-0000000000c1';
const agent = { sub: USER, role: 'OPERATOR' as const };

function conversation(overrides: Partial<SummaryRow> = {}): SummaryRow {
  return {
    id: CONVERSATION,
    protocol: 'ATD-2026-00000001',
    status: 'OPEN',
    priority: 0,
    version: 1,
    teamId: TEAM_A,
    assigneeId: USER,
    phoneNumberId: 'pn-1',
    lastActivityAt: new Date(),
    lastInboundAt: new Date(),
    lastEligibleInboundAt: new Date(Date.now() - 60_000),
    snoozedUntil: null,
    team: { id: TEAM_A, name: 'Equipe A' },
    assignee: { id: USER, name: 'Atendente' },
    contact: {
      id: 'ct-1',
      waId: '551199990000',
      profileName: null,
      optedOutAt: null,
      blockedAt: null,
    },
    ...overrides,
  };
}

function baseHandlers(
  row: SummaryRow,
  role: 'AGENT' | 'SUPERVISOR' = 'AGENT',
): Record<string, Handler> {
  return {
    'teamMember.findMany': () => [{ teamId: TEAM_A, role }],
    'conversation.findUnique': () => row,
  };
}

async function expectHttp(
  promise: Promise<unknown>,
  status: number,
): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HttpException, `esperava HttpException, veio ${String(error)}`);
    assert.equal(error.getStatus(), status);
    return error.getResponse() as Record<string, unknown>;
  }
  assert.fail(`esperava HTTP ${status}`);
}

describe('envio humano (gate na API)', () => {
  const input = { body: 'Olá', idempotencyKey: randomUUID() };

  it('sem inbound elegível => 422 HUMAN_REPLY_BLOCKED, atividade, nenhuma mensagem nem job', async () => {
    const fake = fakeDb(baseHandlers(conversation({ lastEligibleInboundAt: null })));
    const { queue, added } = fakeQueue();
    const response = await expectHttp(
      new InboxActionsService(fake.db, queue).sendMessage(agent, CONVERSATION, input),
      422,
    );
    assert.equal(response.code, 'HUMAN_REPLY_BLOCKED');
    assert.deepEqual(response.reasons, ['NO_ELIGIBLE_INBOUND']);
    assert.equal(fake.count('conversationMessage.create'), 0);
    assert.equal(fake.count('conversationActivity.create'), 1);
    assert.equal(
      fake.calls.find((call) => call.op === '$queryRaw') !== undefined,
      true,
      'lock da conversa',
    );
    assert.equal(added.length, 0);
  });

  it('janela expirada e não responsável => 422 com motivos', async () => {
    const expired = conversation({
      lastEligibleInboundAt: new Date(Date.now() - 24 * 60 * 60_000),
      assigneeId: OTHER,
    });
    const fake = fakeDb(baseHandlers(expired));
    const response = await expectHttp(
      new InboxActionsService(fake.db, fakeQueue().queue).sendMessage(agent, CONVERSATION, input),
      422,
    );
    assert.deepEqual(response.reasons, ['WINDOW_EXPIRED', 'NOT_ASSIGNEE']);
    assert.equal(fake.count('conversationMessage.create'), 0);
  });

  it('usuário de outra equipe => 404 sem gravar nada', async () => {
    const fake = fakeDb({
      'teamMember.findMany': () => [
        { teamId: '00000000-0000-4000-8000-0000000000ff', role: 'SUPERVISOR' },
      ],
      'conversation.findUnique': () => conversation(),
    });
    await expectHttp(
      new InboxActionsService(fake.db, fakeQueue().queue).sendMessage(agent, CONVERSATION, input),
      404,
    );
    assert.equal(fake.count('conversationActivity.create'), 0);
    assert.equal(fake.count('conversationMessage.create'), 0);
  });

  it('usuário sem equipe => 403', async () => {
    const fake = fakeDb({ 'teamMember.findMany': () => [] });
    await expectHttp(
      new InboxActionsService(fake.db, fakeQueue().queue).sendMessage(agent, CONVERSATION, input),
      403,
    );
  });

  it('permitido => HUMAN_TEXT QUEUED, evento e job com jobId determinístico', async () => {
    const fake = fakeDb(baseHandlers(conversation()));
    const { queue, added } = fakeQueue();
    const result = await new InboxActionsService(fake.db, queue).sendMessage(
      agent,
      CONVERSATION,
      input,
    );
    assert.equal(result.message.kind, 'HUMAN_TEXT');
    assert.equal(result.message.status, 'QUEUED');
    const create = fake.calls.find((call) => call.op === 'conversationMessage.create');
    assert.equal(
      (create?.args as { data: { idempotencyKey: string } }).data.idempotencyKey,
      input.idempotencyKey,
    );
    assert.equal(fake.count('inboxEvent.create'), 1);
    assert.equal(added.length, 1);
    const [name, payload, options] = added[0] as [string, SendHumanMessageJob, { jobId: string }];
    assert.equal(name, 'send-human-message');
    assert.equal(payload.conversationMessageId, result.message.id);
    assert.equal(options.jobId, `human-message:${result.message.id}`);
  });

  it('Redis fora não falha a requisição', async () => {
    const fake = fakeDb(baseHandlers(conversation()));
    const result = await new InboxActionsService(fake.db, fakeQueue('down').queue).sendMessage(
      agent,
      CONVERSATION,
      input,
    );
    assert.equal(result.message.status, 'QUEUED');
  });

  it('idempotencyKey repetido devolve a mesma mensagem sem duplicar', async () => {
    const existing = {
      id: randomUUID(),
      conversationId: CONVERSATION,
      direction: 'OUTBOUND',
      kind: 'HUMAN_TEXT',
      status: 'SENT',
      contentType: 'text',
      body: 'Olá',
      authorId: USER,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date(),
    };
    const fake = fakeDb({
      ...baseHandlers(conversation()),
      'conversationMessage.findUnique': () => existing,
    });
    const { queue, added } = fakeQueue();
    const result = await new InboxActionsService(fake.db, queue).sendMessage(
      agent,
      CONVERSATION,
      input,
    );
    assert.equal(result.message.id, existing.id);
    assert.equal(fake.count('conversationMessage.create'), 0);
    assert.equal(added.length, 0, 'mensagem já enviada não é republicada');
  });
});

describe('nota interna', () => {
  it('grava em conversation_notes, nunca em conversation_messages nem na fila', async () => {
    const fake = fakeDb(baseHandlers(conversation({ assigneeId: null })));
    const { queue, added } = fakeQueue();
    const result = await new InboxActionsService(fake.db, queue).addNote(agent, CONVERSATION, {
      body: 'Ligar depois',
    });
    assert.equal(result.note.kind, 'note');
    assert.equal(fake.count('conversationNote.create'), 1);
    assert.equal(
      fake.ops().some((op) => op.startsWith('conversationMessage.')),
      false,
    );
    assert.equal(added.length, 0);
  });
});

describe('transições', () => {
  it('versão divergente => 409 VERSION_CONFLICT com summary atualizado', async () => {
    const fake = fakeDb(baseHandlers(conversation({ version: 5, assigneeId: null })));
    const response = await expectHttp(
      new InboxActionsService(fake.db, fakeQueue().queue).claim(agent, CONVERSATION, 4),
      409,
    );
    assert.equal(response.code, 'VERSION_CONFLICT');
    assert.equal((response.conversation as { version: number }).version, 5);
    assert.equal(fake.count('conversationActivity.create'), 0);
  });

  it('claim atribui, registra atividade, pausa automação e incrementa versão', async () => {
    const fake = fakeDb({
      ...baseHandlers(conversation({ assigneeId: null })),
      'convocation.findMany': (args) =>
        (args as { where: { humanHoldAt?: unknown } }).where.humanHoldAt === null
          ? [{ id: 'cv-1' }]
          : [],
    });
    await new InboxActionsService(fake.db, fakeQueue().queue).claim(agent, CONVERSATION, 1);
    const pause = fake.calls.find((call) => call.op === 'convocation.updateMany');
    assert.deepEqual(
      (pause?.args as { data: { humanHoldConversationId: string } }).data.humanHoldConversationId,
      CONVERSATION,
    );
    const types = fake.calls
      .filter((call) => call.op === 'conversationActivity.create')
      .map((call) => (call.args as { data: { type: string } }).data.type);
    assert.deepEqual(types, ['ASSIGNED', 'AUTOMATION_PAUSED']);
    const bump = fake.calls.find(
      (call) =>
        call.op === 'conversation.update' && JSON.stringify(call.args).includes('increment'),
    );
    assert.ok(bump, 'version+1');
  });

  it('claim de conversa com responsável => 403', async () => {
    const fake = fakeDb(baseHandlers(conversation({ assigneeId: OTHER })));
    await expectHttp(
      new InboxActionsService(fake.db, fakeQueue().queue).claim(agent, CONVERSATION, 1),
      403,
    );
  });

  it('resolver não retoma a automação', async () => {
    const fake = fakeDb(baseHandlers(conversation()));
    await new InboxActionsService(fake.db, fakeQueue().queue).updateStatus(agent, CONVERSATION, {
      version: 1,
      status: 'RESOLVED',
    });
    assert.equal(fake.count('convocation.updateMany'), 0);
  });

  it('transferência exige destino membro da equipe e registra motivo', async () => {
    const TEAM_B = '00000000-0000-4000-8000-00000000000b';
    const fake = fakeDb({
      ...baseHandlers(conversation()),
      'team.findUnique': () => ({ active: true }),
      'teamMember.findUnique': () => null,
    });
    const service = new InboxActionsService(fake.db, fakeQueue().queue);
    const rejected = await expectHttp(
      service.transfer(agent, CONVERSATION, {
        version: 1,
        toTeamId: TEAM_B,
        toUserId: OTHER,
        reason: 'Especialidade',
      }),
      422,
    );
    assert.equal(rejected.code, 'ASSIGNEE_NOT_TEAM_MEMBER');
    await service.transfer(agent, CONVERSATION, {
      version: 1,
      toTeamId: TEAM_B,
      reason: 'Especialidade',
    });
    const activity = fake.calls.find(
      (call) =>
        call.op === 'conversationActivity.create' &&
        JSON.stringify(call.args).includes('TRANSFERRED'),
    );
    assert.deepEqual((activity?.args as { data: object }).data, {
      conversationId: CONVERSATION,
      actorId: USER,
      type: 'TRANSFERRED',
      fromTeamId: TEAM_A,
      toTeamId: TEAM_B,
      fromUserId: USER,
      toUserId: null,
      reason: 'Especialidade',
    });
    const teams = fake.calls
      .filter((call) => call.op === 'inboxEvent.create')
      .map((call) => (call.args as { data: { teamId: string } }).data.teamId);
    assert.ok(teams.includes(TEAM_A), 'equipe de origem também é notificada');
  });

  it('retomada exige supervisor e lista explícita, com AuditLog', async () => {
    const held = [
      { id: 'cv-1', humanHoldAt: new Date(), status: 'WAITING_RESPONSE', nextActionAt: null },
    ];
    const agentFake = fakeDb(baseHandlers(conversation()));
    await expectHttp(
      new InboxActionsService(agentFake.db, fakeQueue().queue).resumeAutomation(
        agent,
        CONVERSATION,
        {
          version: 1,
          convocationIds: ['cv-1'],
        },
      ),
      403,
    );
    const fake = fakeDb({
      ...baseHandlers(conversation(), 'SUPERVISOR'),
      'convocation.findMany': () => held,
    });
    const result = await new InboxActionsService(fake.db, fakeQueue().queue).resumeAutomation(
      agent,
      CONVERSATION,
      {
        version: 1,
        convocationIds: ['cv-1'],
      },
    );
    assert.deepEqual(result.resumedConvocationIds, ['cv-1']);
    assert.equal(fake.count('auditLog.createMany'), 1);
    const clear = fake.calls.find((call) => call.op === 'convocation.updateMany');
    assert.deepEqual((clear?.args as { data: object }).data, {
      humanHoldAt: null,
      humanHoldConversationId: null,
    });
  });
});

describe('SSE por equipe', () => {
  it('filtra pelas equipes visíveis e avança o cursor', async () => {
    const fake = fakeDb({
      'inboxEvent.findMany': () => [
        { id: 5n, type: 'message.created', conversationId: CONVERSATION, entityId: null },
      ],
    });
    const state = { cursor: 3n, floor: 3n, sent: new Map<string, number>() };
    const events = await pollInboxEvents(
      fake.db,
      { userId: USER, globalRole: 'OPERATOR', teams: new Map([[TEAM_A, 'AGENT']]) },
      state,
    );
    assert.equal(events.length, 1);
    assert.equal(state.cursor, 5n);
    const where = (fake.calls[0]?.args as { where: { teamId: unknown } }).where;
    assert.deepEqual(where.teamId, { in: [TEAM_A] });
  });

  it('ADMIN não filtra por equipe', async () => {
    const fake = fakeDb();
    await pollInboxEvents(
      fake.db,
      { userId: USER, globalRole: 'ADMIN', teams: new Map() },
      {
        cursor: 0n,
        floor: 0n,
        sent: new Map(),
      },
    );
    const where = (fake.calls[0]?.args as { where: Record<string, unknown> }).where;
    assert.equal('teamId' in where, false);
  });
});
