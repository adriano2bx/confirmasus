import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { PrismaClient } from '@confirma/database';
import type { SendAutomaticReplyJob, SendMessageJob, SendPermit } from '@confirma/queue';
import { DelayedError, type Job } from 'bullmq';
import { processAutomaticReply } from './automatic-reply-worker.js';
import { processSendMessage, type CampaignSenderDeps } from './message-worker.js';
import { SendPermitDeniedError, WhatsAppApiError } from './meta-whatsapp-client.js';

const originalPhoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
beforeEach(() => {
  process.env.META_WHATSAPP_PHONE_NUMBER_ID = 'pnid-env';
});
afterEach(() => {
  if (originalPhoneNumberId === undefined) delete process.env.META_WHATSAPP_PHONE_NUMBER_ID;
  else process.env.META_WHATSAPP_PHONE_NUMBER_ID = originalPhoneNumberId;
});

type Row = Record<string, unknown>;

interface CampaignState {
  convocation: Row & { id: string; status: string; version: number; humanHoldAt: Date | null };
  message: (Row & { id: string; status: string }) | null;
  events: Row[];
  /** Simula atribuição concorrente: hold aparece na releitura antes da Meta. */
  holdOnRecheck?: boolean;
}

function campaignState(humanHoldAt: Date | null = null): CampaignState {
  return {
    convocation: {
      id: 'conv-1',
      status: 'QUEUED',
      stage: 'FIRST',
      version: 3,
      humanHoldAt,
      nextActionAt: new Date('2026-10-16T09:00:00.000Z'),
      campaign: {
        status: 'RUNNING',
        secondIntervalDays: 2,
        secondStartTime: '09:00',
        thirdIntervalDays: 3,
        thirdStartTime: '09:00',
        finalResponseWindowDays: 1,
      },
      selectedPhone: { valid: true, mobile: true, normalizedValue: '5511999999999' },
      patient: { displayName: 'Paciente Teste', phones: [] },
    },
    message: null,
    events: [],
  };
}

function apply(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) {
      row[key] = Number(row[key]) + Number((value as { increment: number }).increment);
    } else row[key] = value;
  }
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => key === 'id' || row[key] === value);
}

function fakeCampaignDb(state: CampaignState) {
  const db = {
    convocation: {
      findUnique: async (args: { select?: Row }) => {
        if (args.select) {
          if (state.holdOnRecheck) state.convocation.humanHoldAt = new Date();
          return { humanHoldAt: state.convocation.humanHoldAt };
        }
        return { ...state.convocation };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (!matches(state.convocation, where)) return { count: 0 };
        apply(state.convocation, data);
        return { count: 1 };
      },
      update: async ({ data }: { data: Row }) => apply(state.convocation, data),
    },
    message: {
      upsert: async ({ create, update }: { create: Row; update: Row }) => {
        if (state.message) apply(state.message, update);
        else
          state.message = {
            id: 'msg-1',
            providerMessageId: null,
            ...create,
          } as unknown as CampaignState['message'];
        return state.message;
      },
      findUniqueOrThrow: async () => ({
        ...state.message,
        convocation: { ...state.convocation },
      }),
      update: async ({ data }: { data: Row }) => apply(state.message!, data),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (!state.message || !matches(state.message, where)) return { count: 0 };
        apply(state.message, data);
        return { count: 1 };
      },
    },
    messageEvent: {
      create: async ({ data }: { data: Row }) => {
        state.events.push(data);
        return data;
      },
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
  };
  return db as unknown as PrismaClient;
}

function campaignJob() {
  const delayed: number[] = [];
  const job = {
    data: { convocationId: 'conv-1', stage: 'FIRST' },
    opts: { attempts: 3 },
    attemptsMade: 0,
    moveToDelayed: async (timestamp: number) => {
      delayed.push(timestamp);
    },
  } as unknown as Job<SendMessageJob>;
  return { job, delayed };
}

function campaignDeps(
  state: CampaignState,
  options: { mode?: string; permit?: SendPermit; fail?: Error; token?: string } = {},
) {
  const sent: unknown[] = [];
  const permits: Array<[string, string]> = [];
  const value: Partial<CampaignSenderDeps> = {
    prisma: fakeCampaignDb(state),
    mode: () => options.mode ?? 'DRY_RUN',
    acquirePermit: async (phoneNumberId, priority) => {
      permits.push([phoneNumberId, priority]);
      return options.permit ?? { granted: true, retryAfterMs: 0 };
    },
    sendTemplate: async (input) => {
      sent.push(input);
      if (options.fail) throw options.fail;
      return { providerMessageId: 'wamid.template' };
    },
    ...(options.token ? { token: options.token } : {}),
  };
  return { value, sent, permits };
}

describe('campanha sem pausa humana (comportamento inalterado)', () => {
  it('DRY_RUN: SUBMITTED, evento e WAITING_RESPONSE com prazo do follow-up; grava senderPhoneNumberId', async () => {
    const state = campaignState();
    const d = campaignDeps(state);
    await processSendMessage(campaignJob().job, d.value);
    assert.equal(state.message?.status, 'SUBMITTED');
    assert.match(String(state.message?.providerMessageId), /^dry-run-/);
    assert.equal(state.message?.senderPhoneNumberId, 'pnid-env');
    assert.equal(state.message?.attemptNumber, 1);
    assert.equal(state.convocation.status, 'WAITING_RESPONSE');
    assert.ok(state.convocation.nextActionAt instanceof Date);
    assert.equal(state.events[0]?.eventType, 'DRY_RUN_SUBMITTED');
    assert.equal(d.sent.length, 0);
    assert.equal(d.permits.length, 0, 'DRY_RUN da campanha não usa o limiter Redis');
  });

  it('LIVE: pede permissão ao limiter compartilhado e envia o template', async () => {
    const state = campaignState();
    const d = campaignDeps(state, { mode: 'LIVE' });
    await processSendMessage(campaignJob().job, d.value);
    assert.deepEqual(d.permits, [['pnid-env', 'campaign']]);
    assert.equal(d.sent.length, 1);
    assert.equal(state.message?.status, 'SUBMITTED');
    assert.equal(state.message?.providerMessageId, 'wamid.template');
    assert.equal(state.convocation.status, 'WAITING_RESPONSE');
  });

  it('timeout ambíguo mantém a política atual: volta a QUEUED e relança para retry', async () => {
    const state = campaignState();
    const error = new WhatsAppApiError('sem resposta', 'AMBIGUOUS_TIMEOUT', true, true);
    const d = campaignDeps(state, { mode: 'LIVE', fail: error });
    await assert.rejects(
      processSendMessage(campaignJob().job, d.value),
      (thrown) => thrown === error,
    );
    assert.equal(state.message?.status, 'QUEUED');
    assert.equal(state.convocation.status, 'QUEUED');
  });

  it('erro não repetível continua marcando SEND_ERROR', async () => {
    const state = campaignState();
    const d = campaignDeps(state, {
      mode: 'LIVE',
      fail: new WhatsAppApiError('template inválido', '132000', false),
    });
    await processSendMessage(campaignJob().job, d.value);
    assert.equal(state.message?.status, 'FAILED');
    assert.equal(state.convocation.status, 'SEND_ERROR');
  });
});

describe('campanha com pausa humana (humanHoldAt)', () => {
  it('job já enfileirado não envia: volta a SCHEDULED sem criar tentativa', async () => {
    const state = campaignState(new Date());
    const d = campaignDeps(state, { mode: 'LIVE' });
    await processSendMessage(campaignJob().job, d.value);
    assert.equal(state.convocation.status, 'SCHEDULED');
    assert.equal(state.convocation.version, 4);
    assert.equal(state.message, null, 'nenhuma linha de messages criada');
    assert.equal(d.sent.length, 0);
    assert.equal(d.permits.length, 0);
  });

  it('atribuição concorrente vista na releitura antes da Meta: não envia nem consome tentativa', async () => {
    const state = campaignState();
    state.holdOnRecheck = true;
    const d = campaignDeps(state, { mode: 'LIVE' });
    await processSendMessage(campaignJob().job, d.value);
    assert.equal(d.sent.length, 0);
    assert.equal(state.message?.status, 'QUEUED');
    assert.equal(state.message?.providerMessageId, null);
    assert.equal(state.convocation.status, 'SCHEDULED');
    assert.equal(state.events.length, 0);
  });

  it('DRY_RUN também respeita a releitura da pausa', async () => {
    const state = campaignState();
    state.holdOnRecheck = true;
    const d = campaignDeps(state);
    await processSendMessage(campaignJob().job, d.value);
    assert.equal(state.message?.status, 'QUEUED');
    assert.equal(state.convocation.status, 'SCHEDULED');
  });
});

describe('campanha e resposta automática no limiter compartilhado', () => {
  it('campanha sem vaga: volta a QUEUED e adia o job sem consumir tentativa', async () => {
    const state = campaignState();
    const { job, delayed } = campaignJob();
    const d = campaignDeps(state, {
      mode: 'LIVE',
      permit: { granted: false, retryAfterMs: 300 },
      token: 'lock-token',
    });
    await assert.rejects(
      processSendMessage(job, d.value),
      (error) => error instanceof DelayedError,
    );
    assert.equal(delayed.length, 1);
    assert.equal(d.sent.length, 0);
    assert.equal(state.message?.status, 'QUEUED');
    assert.equal(state.convocation.status, 'QUEUED');
  });

  it('campanha sem vaga e sem token relança erro repetível', async () => {
    const state = campaignState();
    const d = campaignDeps(state, { mode: 'LIVE', permit: { granted: false, retryAfterMs: 300 } });
    await assert.rejects(
      processSendMessage(campaignJob().job, d.value),
      (error) => error instanceof SendPermitDeniedError,
    );
    assert.equal(state.convocation.status, 'QUEUED');
  });

  it('resposta automática sem vaga volta a QUEUED mesmo na última tentativa', async () => {
    const message: Row = { id: 'auto-1', status: 'QUEUED', phone: '5511999999999' };
    const db = {
      message: {
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          if (message.status !== where.status) return { count: 0 };
          Object.assign(message, data);
          return { count: 1 };
        },
        findUniqueOrThrow: async () => ({ ...message }),
        update: async ({ data }: { data: Row }) => Object.assign(message, data),
      },
    } as unknown as PrismaClient;
    const sent: unknown[] = [];
    const job = {
      data: { messageId: 'auto-1', action: 'CONFIRM' },
      opts: { attempts: 3 },
      attemptsMade: 2,
    } as unknown as Job<SendAutomaticReplyJob>;
    await assert.rejects(
      processAutomaticReply(job, {
        prisma: db,
        mode: () => 'LIVE',
        acquirePermit: async () => ({ granted: false, retryAfterMs: 100 }),
        sendText: async (input) => {
          sent.push(input);
          return { providerMessageId: 'x' };
        },
      }),
      (error) => error instanceof SendPermitDeniedError,
    );
    assert.equal(message.status, 'QUEUED');
    assert.equal(sent.length, 0);
  });
});
