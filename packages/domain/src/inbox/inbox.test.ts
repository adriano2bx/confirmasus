import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HUMAN_REPLY_WINDOW_MS,
  HUMAN_REPLY_WINDOW_SAFETY_MS,
  canPerform,
  canTransition,
  evaluateHumanReplyPolicy,
  evaluateInboundEligibility,
  formatProtocol,
  monotonicMax,
  nextOutboundStatus,
  PROTOCOL_PATTERN,
  type InboxActor,
  type ReferencedCampaignMessage,
} from './index.js';

const template: ReferencedCampaignMessage = {
  stage: 'FIRST',
  attemptNumber: 1,
  templateId: 'primeira_convocacao_sus_unico',
  phone: '5565999990000',
  senderPhoneNumberId: 'PN1',
  providerMessageId: 'wamid.template',
  status: 'DELIVERED',
};
const inbound = {
  waId: '5565999990000',
  phoneNumberId: 'PN1',
  contextWaMessageId: 'wamid.template',
};

describe('elegibilidade de resposta humana (regra de produto)', () => {
  it('resposta com context.id a template de campanha do mesmo número é elegível', () => {
    assert.deepEqual(evaluateInboundEligibility(inbound, template), {
      eligible: true,
      reason: 'TEMPLATE_REPLY',
    });
  });

  it('inbound espontâneo sem context.id não é elegível', () => {
    const result = evaluateInboundEligibility({ ...inbound, contextWaMessageId: null }, template);
    assert.deepEqual(result, { eligible: false, reason: 'NO_CONTEXT' });
  });

  it('context.id desconhecido não é elegível', () => {
    assert.equal(evaluateInboundEligibility(inbound, null).eligible, false);
  });

  it('resposta à mensagem automática (texto de sessão) não é elegível', () => {
    const automatic = {
      ...template,
      stage: 'FINISHED',
      attemptNumber: 4,
      templateId: 'SESSION_TEXT',
    };
    assert.deepEqual(evaluateInboundEligibility(inbound, automatic), {
      eligible: false,
      reason: 'CONTEXT_NOT_CAMPAIGN_TEMPLATE',
    });
  });

  it('template para outro telefone ou por outro número empresarial não é elegível', () => {
    assert.equal(
      evaluateInboundEligibility({ ...inbound, waId: '5565988887777' }, template).eligible,
      false,
    );
    assert.equal(
      evaluateInboundEligibility({ ...inbound, phoneNumberId: 'PN2' }, template).eligible,
      false,
    );
  });

  it('template ainda não submetido não é elegível', () => {
    const queued = { ...template, providerMessageId: null, status: 'QUEUED' };
    assert.equal(evaluateInboundEligibility(inbound, queued).eligible, false);
  });

  it('registro legado sem remetente só é elegível com phone_number_id configurado igual', () => {
    const legacy = { ...template, senderPhoneNumberId: null };
    assert.equal(evaluateInboundEligibility(inbound, legacy).eligible, false);
    assert.equal(evaluateInboundEligibility(inbound, legacy, 'PN1').eligible, true);
    assert.equal(evaluateInboundEligibility(inbound, legacy, 'PN9').eligible, false);
  });
});

describe('gate de envio humano', () => {
  const base = {
    lastEligibleInboundAt: new Date('2026-10-16T10:00:00Z'),
    contactOptedOutAt: null,
    contactBlockedAt: null,
    conversationStatus: 'OPEN',
    assigneeId: 'u1',
    actorId: 'u1',
  };

  it('permite dentro da janela para o responsável', () => {
    const policy = evaluateHumanReplyPolicy(base, new Date('2026-10-16T12:00:00Z'));
    assert.equal(policy.allowed, true);
  });

  it('bloqueia sem inbound elegível (atendente não inicia conversa)', () => {
    const policy = evaluateHumanReplyPolicy({ ...base, lastEligibleInboundAt: null });
    assert.deepEqual(policy.reasons, ['NO_ELIGIBLE_INBOUND']);
  });

  it('bloqueia com janela expirada, incluindo a margem de segurança', () => {
    const edge = new Date(
      base.lastEligibleInboundAt.getTime() + HUMAN_REPLY_WINDOW_MS - HUMAN_REPLY_WINDOW_SAFETY_MS,
    );
    assert.deepEqual(evaluateHumanReplyPolicy(base, edge).reasons, ['WINDOW_EXPIRED']);
    const before = new Date(edge.getTime() - 1);
    assert.equal(evaluateHumanReplyPolicy(base, before).allowed, true);
  });

  it('bloqueia opt-out, conversa resolvida e quem não é o responsável', () => {
    const now = new Date('2026-10-16T11:00:00Z');
    const policy = evaluateHumanReplyPolicy(
      { ...base, contactOptedOutAt: now, conversationStatus: 'RESOLVED', actorId: 'u2' },
      now,
    );
    assert.deepEqual(policy.reasons, [
      'CONTACT_OPTED_OUT',
      'CONVERSATION_RESOLVED',
      'NOT_ASSIGNEE',
    ]);
  });

  it('webhook atrasado não encurta a janela', () => {
    const current = new Date('2026-10-16T12:00:00Z');
    assert.equal(monotonicMax(current, new Date('2026-10-16T11:00:00Z')), current);
  });
});

describe('RBAC, transições, protocolo e estados', () => {
  const agent: InboxActor = {
    userId: 'a',
    globalRole: 'OPERATOR',
    teams: new Map([['t1', 'AGENT']]),
  };
  const supervisor: InboxActor = {
    userId: 's',
    globalRole: 'OPERATOR',
    teams: new Map([['t1', 'SUPERVISOR']]),
  };
  const outsider: InboxActor = { userId: 'o', globalRole: 'OPERATOR', teams: new Map() };

  it('aplica permissões por equipe e responsável', () => {
    assert.equal(canPerform(agent, 'claim', { teamId: 't1', assigneeId: null }), true);
    assert.equal(canPerform(agent, 'reply', { teamId: 't1', assigneeId: 's' }), false);
    assert.equal(canPerform(agent, 'reply', { teamId: 't1', assigneeId: 'a' }), true);
    assert.equal(canPerform(agent, 'assign', { teamId: 't1', assigneeId: null }), false);
    assert.equal(canPerform(supervisor, 'assign', { teamId: 't1', assigneeId: 'a' }), true);
    assert.equal(canPerform(supervisor, 'reply', { teamId: 't1', assigneeId: 'a' }), false);
    assert.equal(canPerform(outsider, 'view', { teamId: 't1', assigneeId: null }), false);
  });

  it('valida transições de estado', () => {
    assert.equal(canTransition('RESOLVED', 'OPEN'), true);
    assert.equal(canTransition('RESOLVED', 'SNOOZED'), false);
  });

  it('gera protocolo sem PII', () => {
    const protocol = formatProtocol(42n, new Date('2026-10-16T00:00:00Z'));
    assert.equal(protocol, 'ATD-2026-00000042');
    assert.match(protocol, PROTOCOL_PATTERN);
  });

  it('estado de saída não regride e UNKNOWN é reconciliável', () => {
    assert.equal(nextOutboundStatus('READ', 'DELIVERED'), 'READ');
    assert.equal(nextOutboundStatus('UNKNOWN', 'SENT'), 'SENT');
    assert.equal(nextOutboundStatus('DELIVERED', 'FAILED'), 'DELIVERED');
    assert.equal(nextOutboundStatus('BLOCKED', 'SENT'), 'BLOCKED');
  });
});
