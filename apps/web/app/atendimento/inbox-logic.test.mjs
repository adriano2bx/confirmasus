import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HUMAN_REPLY_BLOCK_LABELS,
  activityDetail,
  appendConversationPage,
  buildConversationQuery,
  campaignRefLabel,
  clearStreamPending,
  composerState,
  formatRemaining,
  initialStreamState,
  isSearchInvalid,
  mergeListHead,
  mergeTimeline,
  messageStatusInfo,
  normalizeSearch,
  parseInboxEvent,
  pendingAfterSend,
  prepareSend,
  priorityLabel,
  reduceInboxEvent,
  streamUrl,
  timelineItemFromSent,
  uiPermissions,
} from './inbox-logic.mjs';

const NOW = Date.parse('2026-10-16T12:00:00Z');

describe('formatação de estados de mensagem', () => {
  it('explica UNKNOWN como envio não confirmado aguardando reconciliação', () => {
    const info = messageStatusInfo('UNKNOWN');
    assert.equal(info.tone, 'warning');
    assert.equal(info.description, 'Envio não confirmado, aguardando reconciliação.');
  });

  it('cobre todos os estados de saída humana', () => {
    for (const status of [
      'QUEUED',
      'SUBMITTED',
      'SENT',
      'DELIVERED',
      'READ',
      'FAILED',
      'UNKNOWN',
      'BLOCKED',
    ]) {
      assert.notEqual(messageStatusInfo(status).label, 'Situação não identificada', status);
    }
    assert.equal(messageStatusInfo('FAILED').tone, 'danger');
    assert.equal(messageStatusInfo('BLOCKED').tone, 'danger');
    assert.equal(messageStatusInfo('READ').tone, 'success');
    assert.equal(messageStatusInfo('XYZ').label, 'Situação não identificada');
  });

  it('formata o tempo restante da janela', () => {
    assert.equal(formatRemaining(0), 'expirada');
    assert.equal(formatRemaining(30_000), 'menos de 1 min');
    assert.equal(formatRemaining(45 * 60_000), '45 min');
    assert.equal(formatRemaining(3 * 3_600_000 + 5 * 60_000), '3 h 5 min');
    assert.equal(formatRemaining(2 * 3_600_000), '2 h');
  });
});

describe('composer de resposta a partir de replyPolicy', () => {
  const open = { allowed: true, reasons: [], windowExpiresAt: '2026-10-16T20:00:00.000Z' };

  it('habilita somente quando o servidor permite e a janela está aberta', () => {
    const state = composerState(open, NOW);
    assert.equal(state.enabled, true);
    assert.deepEqual(state.reasons, []);
    assert.equal(state.remainingMs, 8 * 3_600_000);
  });

  it('desabilita com os motivos do servidor em texto', () => {
    const state = composerState(
      { allowed: false, reasons: ['NO_ELIGIBLE_INBOUND', 'NOT_ASSIGNEE'], windowExpiresAt: null },
      NOW,
    );
    assert.equal(state.enabled, false);
    assert.deepEqual(state.reasons, [
      HUMAN_REPLY_BLOCK_LABELS.NO_ELIGIBLE_INBOUND,
      HUMAN_REPLY_BLOCK_LABELS.NOT_ASSIGNEE,
    ]);
  });

  it('fecha o gate se a janela venceu no relógio local, mesmo com allowed=true', () => {
    const state = composerState({ ...open, windowExpiresAt: '2026-10-16T11:59:59.000Z' }, NOW);
    assert.equal(state.enabled, false);
    assert.deepEqual(state.reasons, [HUMAN_REPLY_BLOCK_LABELS.WINDOW_EXPIRED]);
  });

  it('fecha o gate sem janela conhecida ou sem política', () => {
    assert.equal(
      composerState({ allowed: true, reasons: [], windowExpiresAt: null }, NOW).enabled,
      false,
    );
    assert.equal(composerState(null, NOW).enabled, false);
    const unknown = composerState({ allowed: false, reasons: [], windowExpiresAt: null }, NOW);
    assert.equal(unknown.enabled, false);
    assert.equal(unknown.reasons.length, 1);
  });
});

describe('query de filtros da lista', () => {
  it('monta view, busca normalizada, cursor e limite', () => {
    const query = new URLSearchParams(
      buildConversationQuery({
        view: 'mine',
        q: ' +55 (65) 99999-0000 ',
        cursor: 'abc',
        limit: 20,
      }),
    );
    assert.equal(query.get('view'), 'mine');
    assert.equal(query.get('q'), '5565999990000');
    assert.equal(query.get('cursor'), 'abc');
    assert.equal(query.get('limit'), '20');
  });

  it('mantém protocolo em maiúsculas e omite vazios', () => {
    const query = new URLSearchParams(
      buildConversationQuery({ view: 'team', q: 'atd-2026-00000001', teamId: ' ', priority: '' }),
    );
    assert.equal(query.get('q'), 'ATD-2026-00000001');
    assert.equal(query.has('teamId'), false);
    assert.equal(query.has('priority'), false);
    assert.equal(query.has('cursor'), false);
  });

  it('nunca pede mais de 50 nem aceita view desconhecida', () => {
    const query = new URLSearchParams(
      buildConversationQuery({ view: 'everything', limit: 1000, priority: 2 }),
    );
    assert.equal(query.get('view'), 'unassigned');
    assert.equal(query.get('limit'), '50');
    assert.equal(query.get('priority'), '2');
  });

  it('busca sem dígitos nem protocolo, ou com menos de 4 dígitos, vira vazia e inválida', () => {
    assert.equal(normalizeSearch('maria'), '');
    assert.equal(normalizeSearch('123'), '');
    assert.equal(isSearchInvalid('123'), true);
    assert.equal(isSearchInvalid(''), false);
    assert.equal(isSearchInvalid('0000'), false);
    assert.equal(normalizeSearch('9'.repeat(60)).length, 40);
  });

  it('aceita prioridade até 3 (urgente)', () => {
    assert.equal(new URLSearchParams(buildConversationQuery({ priority: 3 })).get('priority'), '3');
    assert.equal(priorityLabel(3), 'Urgente');
    assert.equal(priorityLabel(2), 'Muito alta');
  });
});

describe('merge de páginas da timeline e da lista', () => {
  const item = (kind, id, createdAt, extra = {}) => ({ kind, id, createdAt, ...extra });

  it('junta páginas sem duplicar e em ordem cronológica', () => {
    const newest = [
      item('message', 'm3', '2026-10-16T10:03:00Z'),
      item('note', 'm2', '2026-10-16T10:02:00Z'),
    ];
    const older = [
      item('message', 'm2', '2026-10-16T10:02:00Z'),
      item('note', 'm2', '2026-10-16T10:02:00Z'),
      item('message', 'm1', '2026-10-16T10:01:00Z'),
    ];
    const merged = mergeTimeline(newest, older);
    assert.deepEqual(
      merged.map((entry) => `${entry.kind}:${entry.id}`),
      ['message:m1', 'message:m2', 'note:m2', 'message:m3'],
    );
  });

  it('versão nova do item substitui a antiga (atualização de estado)', () => {
    const merged = mergeTimeline(
      [item('message', 'h1', '2026-10-16T10:00:00Z', { status: 'QUEUED' })],
      [item('message', 'h1', '2026-10-16T10:00:00Z', { status: 'DELIVERED' })],
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].status, 'DELIVERED');
  });

  it('carregar mais não duplica conversas', () => {
    const merged = appendConversationPage([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]);
    assert.deepEqual(
      merged.map((c) => c.id),
      ['a', 'b', 'c'],
    );
  });

  it('topo novo remove conversa afetada que saiu do filtro e mantém o restante', () => {
    const existing = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const merged = mergeListHead(existing, { items: [{ id: 'c' }, { id: 'a' }], nextCursor: 'x' }, [
      'b',
      'c',
    ]);
    assert.deepEqual(
      merged.map((c) => c.id),
      ['c', 'a', 'd'],
    );
    const last = mergeListHead(existing, { items: [{ id: 'a' }], nextCursor: null });
    assert.deepEqual(
      last.map((c) => c.id),
      ['a'],
    );
  });
});

describe('reducer de eventos SSE', () => {
  it('marca lista e conversa aberta para refetch e anuncia nova mensagem', () => {
    const state = reduceInboxEvent(
      initialStreamState(),
      { id: '10', type: 'message.created', conversationId: 'c1', entityId: 'm1' },
      'c1',
    );
    assert.equal(state.lastEventId, '10');
    assert.equal(state.refreshList, true);
    assert.equal(state.refreshSelected, true);
    assert.equal(state.refreshSelectedTimeline, true);
    assert.deepEqual(state.affectedConversationIds, ['c1']);
    assert.equal(state.announcement, 'Nova mensagem na conversa aberta.');
  });

  it('processa commit atrasado (id menor) sem recuar o cursor', () => {
    const first = reduceInboxEvent(
      initialStreamState(),
      { id: '20', type: 'conversation.updated', conversationId: 'c2' },
      'c1',
    );
    const cleared = clearStreamPending(first);
    assert.equal(cleared.lastEventId, '20');
    assert.equal(cleared.refreshList, false);
    // A API revisita eventos recém-confirmados abaixo do cursor: precisam gerar refetch.
    const late = reduceInboxEvent(
      cleared,
      { id: '19', type: 'message.created', conversationId: 'c1' },
      'c1',
    );
    assert.equal(late.lastEventId, '20');
    assert.equal(late.refreshSelectedTimeline, true);
  });

  it('compara ids como inteiros grandes, não como texto', () => {
    const state = reduceInboxEvent(
      { ...initialStreamState(), lastEventId: '9' },
      { id: '10', type: 'note.created', conversationId: 'c1' },
      'c1',
    );
    assert.equal(state.lastEventId, '10');
    assert.equal(state.refreshList, false, 'nota interna não altera a lista');
    assert.equal(state.refreshSelectedTimeline, true);
  });

  it('evento de outra conversa não força refetch da conversa aberta', () => {
    const state = reduceInboxEvent(
      initialStreamState(),
      { id: '1', type: 'message.updated', conversationId: 'c9' },
      'c1',
    );
    assert.equal(state.refreshSelected, false);
    assert.equal(state.refreshList, true);
  });

  it('descarta payload inválido e lê id do evento', () => {
    assert.equal(parseInboxEvent('{"type":1}'), null);
    assert.equal(parseInboxEvent('nope'), null);
    assert.deepEqual(parseInboxEvent('{"type":"note.created","conversationId":"c1"}', '7'), {
      id: '7',
      type: 'note.created',
      conversationId: 'c1',
      entityId: null,
    });
    assert.equal(streamUrl('http://x/api/', '42'), 'http://x/api/inbox/stream?cursor=42');
    assert.equal(streamUrl('http://x/api', null), 'http://x/api/inbox/stream');
  });
});

describe('idempotência do envio', () => {
  let counter = 0;
  const newKey = () => `key-${++counter}`;

  it('reaproveita a chave ao repetir o mesmo texto após falha incerta', () => {
    const attempt = prepareSend(null, ' Olá ', newKey);
    assert.equal(attempt.body, 'Olá');
    const pending = pendingAfterSend(attempt, null);
    assert.equal(prepareSend(pending, 'Olá', newKey).idempotencyKey, attempt.idempotencyKey);
    assert.equal(pendingAfterSend(attempt, 503), attempt);
  });

  it('gera chave nova para outro texto ou após resposta definitiva', () => {
    const attempt = prepareSend(null, 'A', newKey);
    assert.notEqual(prepareSend(attempt, 'B', newKey).idempotencyKey, attempt.idempotencyKey);
    assert.equal(pendingAfterSend(attempt, 202), null);
    assert.equal(pendingAfterSend(attempt, 422), null);
  });
});

describe('permissões de exibição e referências de campanha', () => {
  const agent = { userId: 'u1', globalRole: 'OPERATOR', teams: [{ id: 't1', role: 'AGENT' }] };

  it('agente assume não atribuída mas não atribui nem retoma automação', () => {
    const perms = uiPermissions(agent, { teamId: 't1', assigneeId: null });
    assert.equal(perms.claim, true);
    assert.equal(perms.assign, false);
    assert.equal(perms.resumeAutomation, false);
    assert.equal(perms.transfer, false);
    assert.equal(uiPermissions(agent, { teamId: 't1', assigneeId: 'u1' }).transfer, true);
    assert.equal(uiPermissions(agent, { teamId: 't2', assigneeId: null }).note, false);
  });

  it('nome do paciente só aparece para convocação vinculada', () => {
    const campaign = { stage: 'FIRST', convocationId: 'v1', patientName: 'Paciente Teste' };
    assert.deepEqual(campaignRefLabel(campaign, []), {
      title: 'Template de campanha — 1ª convocação',
      patient: null,
      linked: false,
    });
    assert.equal(campaignRefLabel(campaign, ['v1']).patient, 'Paciente Teste');
  });
});

describe('formato real da API', () => {
  it('converte a resposta 202 do envio em item de timeline', () => {
    const item = timelineItemFromSent({
      id: 'm1',
      kind: 'HUMAN_TEXT',
      direction: 'OUTBOUND',
      status: 'QUEUED',
      createdAt: '2026-10-16T12:00:00.000Z',
    });
    assert.equal(item.kind, 'message');
    assert.equal(item.messageKind, 'HUMAN_TEXT');
    assert.equal(item.status, 'QUEUED');
  });

  it('descreve atividades a partir do metadata', () => {
    assert.equal(
      activityDetail('STATUS_CHANGED', { from: 'OPEN', to: 'RESOLVED' }),
      'Aberta → Resolvida',
    );
    assert.equal(activityDetail('PRIORITY_CHANGED', { from: 0, to: 3 }), 'Normal → Urgente');
    assert.equal(
      activityDetail('HUMAN_SEND_BLOCKED', { reasons: ['WINDOW_EXPIRED'], source: 'api' }),
      HUMAN_REPLY_BLOCK_LABELS.WINDOW_EXPIRED,
    );
    assert.equal(activityDetail('ASSIGNED', null), '');
  });
});
