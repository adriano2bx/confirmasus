import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ageSeconds, escapeLabelValue, formatPrometheus } from './prometheus.js';

describe('formatador Prometheus', () => {
  it('gera HELP, TYPE e amostras com e sem rótulos', () => {
    const text = formatPrometheus([
      {
        name: 'confirma_redis_up',
        help: 'Redis acessível.',
        type: 'gauge',
        samples: [{ value: 1 }],
      },
      {
        name: 'confirma_webhook_events',
        help: 'Eventos por status.',
        type: 'gauge',
        samples: [
          { labels: { status: 'PENDING' }, value: 3 },
          { labels: { status: 'DEAD_LETTER' }, value: 0 },
        ],
      },
    ]);
    assert.equal(
      text,
      [
        '# HELP confirma_redis_up Redis acessível.',
        '# TYPE confirma_redis_up gauge',
        'confirma_redis_up 1',
        '# HELP confirma_webhook_events Eventos por status.',
        '# TYPE confirma_webhook_events gauge',
        'confirma_webhook_events{status="PENDING"} 3',
        'confirma_webhook_events{status="DEAD_LETTER"} 0',
        '',
      ].join('\n'),
    );
  });

  it('escapa barra, aspas e quebra de linha em rótulos e HELP', () => {
    assert.equal(escapeLabelValue('a\\b"c\nd'), 'a\\\\b\\"c\\nd');
    const text = formatPrometheus([
      {
        name: 'm',
        help: 'linha1\nlinha2',
        type: 'gauge',
        samples: [{ labels: { team: 'x"y' }, value: 2 }],
      },
    ]);
    assert.match(text, /# HELP m linha1\\nlinha2/);
    assert.match(text, /m\{team="x\\"y"\} 2/);
  });

  it('formata valores especiais e família sem amostras', () => {
    const text = formatPrometheus([
      {
        name: 'a',
        help: 'h',
        type: 'gauge',
        samples: [{ value: Number.NaN }, { value: Infinity }],
      },
      { name: 'b', help: 'h', type: 'counter', samples: [] },
    ]);
    assert.match(text, /^a NaN$/m);
    assert.match(text, /^a \+Inf$/m);
    assert.match(text, /# TYPE b counter\n$/);
  });

  it('rejeita nomes inválidos e métricas duplicadas', () => {
    assert.throws(() => formatPrometheus([{ name: '1x', help: 'h', type: 'gauge', samples: [] }]));
    assert.throws(() =>
      formatPrometheus([
        { name: 'x', help: 'h', type: 'gauge', samples: [{ labels: { 'a-b': '1' }, value: 1 }] },
      ]),
    );
    assert.throws(() =>
      formatPrometheus([
        { name: 'x', help: 'h', type: 'gauge', samples: [{ labels: { __name: '1' }, value: 1 }] },
      ]),
    );
    assert.throws(() =>
      formatPrometheus([
        { name: 'x', help: 'h', type: 'gauge', samples: [] },
        { name: 'x', help: 'h', type: 'gauge', samples: [] },
      ]),
    );
  });

  it('calcula idade em segundos sem valores negativos', () => {
    const now = new Date('2026-10-16T12:00:00Z');
    assert.equal(ageSeconds(new Date('2026-10-16T11:59:00Z'), now), 60);
    assert.equal(ageSeconds(new Date('2026-10-16T12:01:00Z'), now), 0);
    assert.equal(ageSeconds(null, now), 0);
  });
});
