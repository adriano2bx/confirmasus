import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrismaClient } from '@confirma/database';
import type { SendHumanMessageJob, SendPermit } from '@confirma/queue';
import { DelayedError, type Job, type Queue } from 'bullmq';
import {
  processHumanMessage,
  sweepQueuedHumanMessages,
  type HumanSenderDeps,
} from './human-message-worker.js';
import {
  SendPermitDeniedError,
  WhatsAppApiError,
  type sendMetaText,
} from './meta-whatsapp-client.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const AGENT = 'agent-1';
const TEAM = 'team-1';

interface State {
  message: Record<string, unknown> & { id: string; status: string; kind: string };
  conversation: Record<string, unknown> & { id: string };
  contact: { waId: string; optedOutAt: Date | null; blockedAt: Date | null };
  author: {
    role: 'ADMIN' | 'OPERATOR';
    active: boolean;
    deletedAt: Date | null;
    teamMemberships: Array<{ teamId: string; role: 'AGENT' | 'SUPERVISOR' }>;
  } | null;
}

function baseState(
  overrides: Partial<{
    status: string;
    lastEligibleInboundAt: Date | null;
    assigneeId: string | null;
    conversationStatus: string;
    optedOutAt: Date | null;
    memberships: Array<{ teamId: string; role: 'AGENT' | 'SUPERVISOR' }>;
  }> = {},
): State {
  return {
    message: {
      id: 'cm-1',
      kind: 'HUMAN_TEXT',
      status: overrides.status ?? 'QUEUED',
      body: 'texto de teste',
      authorId: AGENT,
      conversationId: 'conv-1',
    },
    conversation: {
      id: 'conv-1',
      teamId: TEAM,
      assigneeId: overrides.assigneeId === undefined ? AGENT : overrides.assigneeId,
      status: overrides.conversationStatus ?? 'OPEN',
      phoneNumberId: 'pnid-1',
      lastEligibleInboundAt:
        overrides.lastEligibleInboundAt === undefined
          ? new Date(NOW.getTime() - 60 * 60_000)
          : overrides.lastEligibleInboundAt,
      lastOutboundAt: null,
    },
    contact: { waId: '5511999999999', optedOutAt: overrides.optedOutAt ?? null, blockedAt: null },
    author: {
      role: 'OPERATOR',
      active: true,
      deletedAt: null,
      teamMemberships: overrides.memberships ?? [{ teamId: TEAM, role: 'AGENT' }],
    },
  };
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'updatedAt') return true;
    return row[key] === value;
  });
}

/** Prisma fake em memória; `conversationNote` lança se for acessado (nota nunca é lida). */
function fakeDb(state: State) {
  const activities: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  let locks = 0;
  const db = {
    conversationMessage: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: object }) => {
        if (!matches(state.message, where)) return { count: 0 };
        Object.assign(state.message, data);
        return { count: 1 };
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        matches(state.message, where)
          ? { ...state.message, conversation: { ...state.conversation } }
          : null,
      update: async ({ data }: { data: object }) => Object.assign(state.message, data),
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        matches(state.message, where)
          ? [{ ...state.message, conversation: { ...state.conversation } }]
          : [],
    },
    conversation: {
      findUnique: async () => ({ ...state.conversation, contact: { ...state.contact } }),
      update: async ({ data }: { data: object }) => Object.assign(state.conversation, data),
    },
    user: { findUnique: async () => state.author },
    conversationActivity: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        activities.push(data);
        return { id: `act-${activities.length}` };
      },
    },
    inboxEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      },
    },
    conversationNote: new Proxy(
      {},
      {
        get() {
          throw new Error('o sender nunca deve ler notas internas');
        },
      },
    ),
    $queryRaw: async () => {
      locks += 1;
      return [];
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
  };
  return {
    prisma: db as unknown as PrismaClient,
    activities,
    events,
    get locks() {
      return locks;
    },
  };
}

function fakeJob(attemptsMade = 0) {
  const delayed: number[] = [];
  const job = {
    data: { conversationMessageId: 'cm-1' },
    opts: { attempts: 3 },
    attemptsMade,
    moveToDelayed: async (timestamp: number) => {
      delayed.push(timestamp);
    },
  } as unknown as Job<SendHumanMessageJob>;
  return { job, delayed };
}

function deps(
  db: ReturnType<typeof fakeDb>,
  options: {
    mode?: string;
    permit?: SendPermit;
    send?: typeof sendMetaText;
    token?: string;
  } = {},
) {
  const sent: Array<Parameters<typeof sendMetaText>[0]> = [];
  const permits: Array<[string, string]> = [];
  const value: Partial<HumanSenderDeps> = {
    prisma: db.prisma,
    mode: () => options.mode ?? 'DRY_RUN',
    now: () => NOW,
    acquirePermit: async (phoneNumberId, priority) => {
      permits.push([phoneNumberId, priority]);
      return options.permit ?? { granted: true, retryAfterMs: 0 };
    },
    sendText: async (input) => {
      sent.push(input);
      if (options.send) return options.send(input);
      return { providerMessageId: 'wamid.human' };
    },
    ...(options.token ? { token: options.token } : {}),
  };
  return { value, sent, permits };
}

async function expectBlocked(state: State, reason: string) {
  const db = fakeDb(state);
  const d = deps(db, { mode: 'LIVE' });
  await processHumanMessage(fakeJob().job, d.value);
  assert.equal(state.message.status, 'BLOCKED');
  assert.equal(d.sent.length, 0, 'nada pode ser enviado');
  const activity = db.activities.find((item) => item.type === 'HUMAN_SEND_BLOCKED');
  assert.ok(activity, 'atividade HUMAN_SEND_BLOCKED');
  const reasons = (activity.metadata as { reasons: string[] }).reasons;
  assert.ok(reasons.includes(reason), `motivo ${reason} em ${reasons.join(',')}`);
  assert.ok(db.events.some((event) => event.type === 'message.updated'));
  assert.ok(db.locks > 0, 'revalida sob lock da conversa');
}

describe('sender humano: gate antes da Meta', () => {
  it('bloqueia sem inbound elegível (atendente não inicia conversa)', async () => {
    await expectBlocked(baseState({ lastEligibleInboundAt: null }), 'NO_ELIGIBLE_INBOUND');
  });

  it('bloqueia com janela de 24h expirada', async () => {
    await expectBlocked(
      baseState({ lastEligibleInboundAt: new Date(NOW.getTime() - 24 * 60 * 60_000) }),
      'WINDOW_EXPIRED',
    );
  });

  it('bloqueia contato com opt-out', async () => {
    await expectBlocked(
      baseState({ optedOutAt: new Date(NOW.getTime() - 1_000) }),
      'CONTACT_OPTED_OUT',
    );
  });

  it('bloqueia quem não é o responsável atribuído', async () => {
    await expectBlocked(baseState({ assigneeId: 'other-agent' }), 'NOT_ASSIGNEE');
  });

  it('bloqueia responsável que saiu da equipe da conversa', async () => {
    await expectBlocked(baseState({ memberships: [] }), 'NOT_TEAM_MEMBER');
  });

  it('bloqueia conversa resolvida', async () => {
    await expectBlocked(baseState({ conversationStatus: 'RESOLVED' }), 'CONVERSATION_RESOLVED');
  });

  it('nunca envia mensagem BLOCKED (nem reavalia)', async () => {
    const state = baseState({ status: 'BLOCKED' });
    const db = fakeDb(state);
    const d = deps(db, { mode: 'LIVE' });
    await processHumanMessage(fakeJob().job, d.value);
    assert.equal(state.message.status, 'BLOCKED');
    assert.equal(d.sent.length, 0);
    assert.equal(d.permits.length, 0);
    assert.equal(db.events.length, 0);
  });

  it('ignora linha que não é HUMAN_TEXT', async () => {
    const state = baseState();
    state.message.kind = 'INBOUND';
    const db = fakeDb(state);
    const d = deps(db, { mode: 'LIVE' });
    await processHumanMessage(fakeJob().job, d.value);
    assert.equal(state.message.status, 'QUEUED');
    assert.equal(d.sent.length, 0);
  });
});

describe('sender humano: envio', () => {
  it('em DRY_RUN dentro da janela marca SUBMITTED sem chamar a Meta', async () => {
    const state = baseState();
    const db = fakeDb(state);
    const d = deps(db, { mode: 'DRY_RUN' });
    await processHumanMessage(fakeJob().job, d.value);
    assert.equal(state.message.status, 'SUBMITTED');
    assert.match(String(state.message.waMessageId), /^dry-run-human-/);
    assert.equal(state.message.submittedAt, NOW);
    assert.equal(state.conversation.lastOutboundAt, NOW);
    assert.equal(d.sent.length, 0);
    assert.deepEqual(d.permits, [['pnid-1', 'human']]);
    assert.ok(
      db.events.some((event) => event.type === 'message.updated' && event.entityId === 'cm-1'),
    );
  });

  it('em LIVE envia texto com bizOpaque = id e phone_number_id da conversa', async () => {
    const state = baseState();
    const db = fakeDb(state);
    const d = deps(db, { mode: 'LIVE' });
    await processHumanMessage(fakeJob().job, d.value);
    assert.deepEqual(d.sent, [
      {
        destination: '5511999999999',
        text: 'texto de teste',
        bizOpaqueCallbackData: 'cm-1',
        phoneNumberId: 'pnid-1',
      },
    ]);
    assert.equal(state.message.status, 'SUBMITTED');
    assert.equal(state.message.waMessageId, 'wamid.human');
  });

  it('falha ambígua vira UNKNOWN com atividade e sem retry', async () => {
    const state = baseState();
    const db = fakeDb(state);
    const d = deps(db, {
      mode: 'LIVE',
      send: async () => {
        throw new WhatsAppApiError('sem resposta', 'AMBIGUOUS_TIMEOUT', true, true);
      },
    });
    await processHumanMessage(fakeJob().job, d.value);
    assert.equal(state.message.status, 'UNKNOWN');
    assert.equal(state.message.failureCode, 'AMBIGUOUS_TIMEOUT');
    assert.equal(d.sent.length, 1);
    assert.ok(db.activities.some((item) => item.type === 'HUMAN_SEND_UNKNOWN'));
    assert.ok(db.events.some((event) => event.type === 'message.updated'));
  });

  it('429/5xx com resposta volta a QUEUED e relança para o BullMQ', async () => {
    const state = baseState();
    const db = fakeDb(state);
    const error = new WhatsAppApiError('limite', '130429', true);
    const d = deps(db, {
      mode: 'LIVE',
      send: async () => {
        throw error;
      },
    });
    await assert.rejects(
      processHumanMessage(fakeJob(0).job, d.value),
      (thrown) => thrown === error,
    );
    assert.equal(state.message.status, 'QUEUED');
  });

  it('erro transitório na última tentativa vira FAILED', async () => {
    const state = baseState();
    const db = fakeDb(state);
    const d = deps(db, {
      mode: 'LIVE',
      send: async () => {
        throw new WhatsAppApiError('limite', 'HTTP_503', true);
      },
    });
    await processHumanMessage(fakeJob(2).job, d.value);
    assert.equal(state.message.status, 'FAILED');
  });

  it('erro não transitório com resposta vira FAILED', async () => {
    const state = baseState();
    const db = fakeDb(state);
    const d = deps(db, {
      mode: 'LIVE',
      send: async () => {
        throw new WhatsAppApiError('recusado', '131026', false);
      },
    });
    await processHumanMessage(fakeJob().job, d.value);
    assert.equal(state.message.status, 'FAILED');
    assert.equal(state.message.failureCode, '131026');
  });
});

describe('sender humano: limiter compartilhado', () => {
  it('sem vaga, volta a QUEUED e adia o job sem consumir tentativa', async () => {
    const state = baseState();
    const db = fakeDb(state);
    const { job, delayed } = fakeJob();
    const d = deps(db, {
      mode: 'LIVE',
      permit: { granted: false, retryAfterMs: 250 },
      token: 'lock-token',
    });
    await assert.rejects(
      processHumanMessage(job, d.value),
      (error) => error instanceof DelayedError,
    );
    assert.equal(state.message.status, 'QUEUED');
    assert.equal(delayed.length, 1);
    assert.equal(d.sent.length, 0);
  });

  it('sem token, relança erro repetível de limite', async () => {
    const state = baseState();
    const db = fakeDb(state);
    const d = deps(db, { mode: 'LIVE', permit: { granted: false, retryAfterMs: 250 } });
    await assert.rejects(
      processHumanMessage(fakeJob().job, d.value),
      (error) => error instanceof SendPermitDeniedError && error.retryable,
    );
    assert.equal(state.message.status, 'QUEUED');
    assert.equal(d.sent.length, 0);
  });
});

describe('varredor de envios humanos (outbox)', () => {
  function fakeQueue(states: Record<string, string>) {
    const added: string[] = [];
    const removed: string[] = [];
    const queue = {
      getJob: async (jobId: string) =>
        states[jobId]
          ? {
              getState: async () => states[jobId],
              remove: async () => {
                removed.push(jobId);
              },
            }
          : undefined,
      add: async (_name: string, data: SendHumanMessageJob, opts: { jobId: string }) => {
        added.push(opts.jobId);
        return { id: opts.jobId, data };
      },
    } as unknown as Pick<Queue<SendHumanMessageJob>, 'add' | 'getJob'>;
    return { queue, added, removed };
  }

  it('publica QUEUED sem job e recria job concluído/falho; não duplica job vivo', async () => {
    const state = baseState();
    const db = fakeDb(state);
    const missing = fakeQueue({});
    assert.equal(
      (await sweepQueuedHumanMessages(missing.queue, { prisma: db.prisma, now: NOW })).published,
      1,
    );
    assert.deepEqual(missing.added, ['human-message:cm-1']);

    const failed = fakeQueue({ 'human-message:cm-1': 'failed' });
    await sweepQueuedHumanMessages(failed.queue, { prisma: db.prisma, now: NOW });
    assert.deepEqual(failed.removed, ['human-message:cm-1']);
    assert.deepEqual(failed.added, ['human-message:cm-1']);

    const delayed = fakeQueue({ 'human-message:cm-1': 'delayed' });
    await sweepQueuedHumanMessages(delayed.queue, { prisma: db.prisma, now: NOW });
    assert.deepEqual(delayed.added, []);
  });

  it('PROCESSING órfão vira UNKNOWN (sem reenvio)', async () => {
    const state = baseState({ status: 'PROCESSING' });
    const db = fakeDb(state);
    const { queue, added } = fakeQueue({});
    const result = await sweepQueuedHumanMessages(queue, { prisma: db.prisma, now: NOW });
    assert.equal(result.markedUnknown, 1);
    assert.equal(state.message.status, 'UNKNOWN');
    assert.deepEqual(added, []);
    assert.ok(db.activities.some((item) => item.type === 'HUMAN_SEND_UNKNOWN'));
  });
});
