import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InboxActor, TeamRole } from '@confirma/domain';
import {
  buildConversationWhere,
  clampLimit,
  decodeCursor,
  encodeCursor,
  formatSseEvent,
  hasInboxAccess,
  maskWaId,
  mergeTimeline,
  parseStreamCursor,
  replyBlockReasons,
  describeBlockReasons,
  slugify,
} from './inbox.helpers.js';
import { toSummary, type SummaryRow } from './inbox-summary.js';

const TEAM_A = '00000000-0000-4000-8000-00000000000a';
const TEAM_B = '00000000-0000-4000-8000-00000000000b';
const USER = '00000000-0000-4000-8000-000000000001';

function actor(role: 'ADMIN' | 'OPERATOR', teams: Array<[string, TeamRole]> = []): InboxActor {
  return { userId: USER, globalRole: role, teams: new Map(teams) };
}

describe('cursor opaco', () => {
  it('codifica e decodifica (data, id)', () => {
    const cursor = {
      at: new Date('2026-10-16T12:00:00.123Z'),
      id: '11111111-1111-4111-8111-111111111111',
    };
    const encoded = encodeCursor(cursor);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeCursor(encoded), cursor);
    assert.equal(decodeCursor(undefined), null);
  });

  it('rejeita cursor adulterado', () => {
    assert.throws(() => decodeCursor('nao-e-cursor'), /Cursor inválido/);
    const bad = Buffer.from(JSON.stringify({ t: 'x', i: 'drop table' })).toString('base64url');
    assert.throws(() => decodeCursor(bad), /Cursor inválido/);
  });
});

describe('máscara de telefone', () => {
  it('mantém DDI e 4 últimos dígitos', () => {
    assert.equal(maskWaId('551199990000'), '55******0000');
    assert.equal(maskWaId('5511999990000'), '55*******0000');
    assert.equal(maskWaId('123'), '***');
  });
});

describe('limite de página', () => {
  it('nunca passa de 50', () => {
    assert.equal(clampLimit(500), 50);
    assert.equal(clampLimit(undefined), 20);
    assert.equal(clampLimit(0), 20);
    assert.equal(clampLimit(3), 3);
  });
});

describe('where da listagem por visibilidade', () => {
  it('ADMIN não recebe filtro de equipe', () => {
    const where = buildConversationWhere(actor('ADMIN'), { view: 'all' }, null);
    assert.deepEqual(where, {});
  });

  it('agente fica restrito às próprias equipes', () => {
    const where = buildConversationWhere(
      actor('OPERATOR', [[TEAM_A, 'AGENT']]),
      { view: 'team' },
      null,
    );
    assert.deepEqual(where, {
      AND: [{ teamId: { in: [TEAM_A] } }, { status: { not: 'RESOLVED' } }],
    });
  });

  it('filtro por equipe invisível resulta vazio (null)', () => {
    assert.equal(
      buildConversationWhere(actor('OPERATOR', [[TEAM_A, 'AGENT']]), { teamId: TEAM_B }, null),
      null,
    );
    assert.equal(buildConversationWhere(actor('OPERATOR'), {}, null), null);
  });

  it('visões mine/unassigned, busca por protocolo/dígitos e cursor keyset', () => {
    const a = actor('OPERATOR', [[TEAM_A, 'SUPERVISOR']]);
    const at = new Date('2026-10-16T10:00:00Z');
    const id = '22222222-2222-4222-8222-222222222222';
    const mine = buildConversationWhere(a, { view: 'mine', q: 'atd-2026-0001' }, { at, id });
    assert.deepEqual(mine, {
      AND: [
        { teamId: { in: [TEAM_A] } },
        { assigneeId: USER, status: { not: 'RESOLVED' } },
        { protocol: { startsWith: 'ATD-2026-0001' } },
        { OR: [{ lastActivityAt: { lt: at } }, { lastActivityAt: at, id: { lt: id } }] },
      ],
    });
    const unassigned = buildConversationWhere(a, { view: 'unassigned', q: '(11) 9999' }, null);
    assert.deepEqual(unassigned?.AND, [
      { teamId: { in: [TEAM_A] } },
      { assigneeId: null, status: { not: 'RESOLVED' } },
      { contact: { waId: { contains: '119999' } } },
    ]);
    assert.throws(() => buildConversationWhere(a, { q: '12' }, null), /4 dígitos/);
  });
});

describe('timeline mesclada', () => {
  it('ordena (createdAt, id) desc entre fontes e pagina', () => {
    const t = (iso: string) => new Date(iso);
    const messages = [
      { kind: 'message' as const, id: 'c', createdAt: t('2026-10-16T10:00:03Z') },
      { kind: 'message' as const, id: 'a', createdAt: t('2026-10-16T10:00:01Z') },
    ];
    const notes = [{ kind: 'note' as const, id: 'b', createdAt: t('2026-10-16T10:00:03Z') }];
    const activities = [
      { kind: 'activity' as const, id: 'z', createdAt: t('2026-10-16T10:00:02Z') },
    ];
    const page = mergeTimeline([messages, notes, activities], 3);
    assert.deepEqual(
      page.items.map((item) => `${item.kind}:${item.id}`),
      ['message:c', 'note:b', 'activity:z'],
    );
    assert.ok(page.nextCursor);
    assert.deepEqual(decodeCursorLoose(page.nextCursor), { t: '2026-10-16T10:00:02.000Z', i: 'z' });
    assert.equal(mergeTimeline([messages], 5).nextCursor, null);
  });
});

function decodeCursorLoose(value: string) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
}

describe('motivos de bloqueio', () => {
  it('acrescenta NOT_ASSIGNEE quando reply é negado', () => {
    assert.deepEqual(replyBlockReasons([], false), ['NOT_ASSIGNEE']);
    assert.deepEqual(replyBlockReasons(['NOT_ASSIGNEE'], false), ['NOT_ASSIGNEE']);
    assert.deepEqual(replyBlockReasons(['WINDOW_EXPIRED'], true), ['WINDOW_EXPIRED']);
    assert.match(describeBlockReasons(['NO_ELIGIBLE_INBOUND'])[0]?.label ?? '', /não pode iniciar/);
  });
});

describe('SSE', () => {
  it('formata só tipo e IDs, BigInt como string', () => {
    const line = formatSseEvent({
      id: 9007199254740993n,
      type: 'message.created',
      conversationId: 'conv',
      entityId: null,
    });
    assert.equal(
      line,
      'id: 9007199254740993\ndata: {"id":"9007199254740993","type":"message.created","conversationId":"conv","entityId":null}\n\n',
    );
  });

  it('valida Last-Event-ID', () => {
    assert.equal(parseStreamCursor(undefined), null);
    assert.equal(parseStreamCursor('42'), 42n);
    assert.throws(() => parseStreamCursor('-1'));
    assert.throws(() => parseStreamCursor('1;drop'));
  });
});

describe('summary', () => {
  const row: SummaryRow = {
    id: 'conv-1',
    protocol: 'ATD-2026-00000001',
    status: 'OPEN',
    priority: 0,
    version: 3,
    teamId: TEAM_A,
    assigneeId: USER,
    phoneNumberId: 'pn-1',
    lastActivityAt: new Date('2026-10-16T10:00:00Z'),
    lastInboundAt: new Date('2026-10-16T09:00:00Z'),
    lastEligibleInboundAt: new Date('2026-10-16T09:00:00Z'),
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
  };

  it('mascara telefone, limita não lidos e avalia replyPolicy para o usuário', () => {
    const now = new Date('2026-10-16T10:00:00Z');
    const summary = toSummary(
      row,
      actor('OPERATOR', [[TEAM_A, 'AGENT']]),
      { unreadCount: 250, automationPaused: true },
      now,
    );
    assert.equal(summary.contact.waIdMasked, '55******0000');
    assert.equal(JSON.stringify(summary).includes('551199990000'), false);
    assert.equal(summary.unreadCount, 99);
    assert.equal(summary.replyPolicy.allowed, true);
    const other = toSummary(
      row,
      { ...actor('OPERATOR', [[TEAM_A, 'AGENT']]), userId: 'outro' },
      { unreadCount: 0, automationPaused: false },
      now,
    );
    assert.deepEqual(other.replyPolicy.reasons, ['NOT_ASSIGNEE']);
    const noEligible = toSummary(
      { ...row, lastEligibleInboundAt: null },
      actor('OPERATOR', [[TEAM_A, 'AGENT']]),
      { unreadCount: 0, automationPaused: false },
      now,
    );
    assert.deepEqual(noEligible.replyPolicy.reasons, ['NO_ELIGIBLE_INBOUND']);
  });
});

describe('diversos', () => {
  it('slug e acesso', () => {
    assert.equal(slugify('Regulação Ambulatorial'), 'regulacao-ambulatorial');
    assert.equal(hasInboxAccess(actor('OPERATOR')), false);
    assert.equal(hasInboxAccess(actor('ADMIN')), true);
  });
});
