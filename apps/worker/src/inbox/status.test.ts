import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  conversationMessageIdFromBizOpaque,
  conversationMessageStatusPatch,
  statusUpdate,
} from './status.js';

const empty = {
  status: 'SUBMITTED',
  waMessageId: 'wamid.h1',
  submittedAt: null,
  sentAt: null,
  deliveredAt: null,
  readAt: null,
  failedAt: null,
};
const at = new Date('2026-10-16T12:00:00Z');

describe('status de mensagem humana', () => {
  it('não regride com status fora de ordem', () => {
    const read = conversationMessageStatusPatch(
      { ...empty, status: 'READ' },
      { status: 'DELIVERED', at },
      'wamid.h1',
    );
    assert.equal(read?.status, 'READ');
    const failedAfterRead = conversationMessageStatusPatch(
      { ...empty, status: 'READ' },
      statusUpdate('failed', at, { code: 131_000 })!,
      'wamid.h1',
    );
    assert.equal(failedAfterRead?.status, 'READ');
    assert.equal(failedAfterRead && 'failedAt' in failedAfterRead, false);
  });

  it('reconcilia UNKNOWN preenchendo o WAMID recebido por bizOpaque', () => {
    const patch = conversationMessageStatusPatch(
      { ...empty, status: 'UNKNOWN', waMessageId: null },
      { status: 'SENT', at },
      'wamid.novo',
    );
    assert.equal(patch?.status, 'SENT');
    assert.equal(patch?.waMessageId, 'wamid.novo');
    assert.equal(patch?.sentAt, at);
  });

  it('ignora status cujo WAMID conflita com o já gravado', () => {
    assert.equal(
      conversationMessageStatusPatch(empty, { status: 'SENT', at }, 'wamid.outro'),
      null,
    );
  });

  it('BLOCKED nunca muda e read preenche deliveredAt', () => {
    assert.equal(
      conversationMessageStatusPatch(
        { ...empty, status: 'BLOCKED' },
        { status: 'SENT', at },
        'wamid.h1',
      )?.status,
      'BLOCKED',
    );
    const read = conversationMessageStatusPatch(empty, { status: 'READ', at }, 'wamid.h1');
    assert.equal(read?.deliveredAt, at);
  });

  it('aceita somente uuid como bizOpaque', () => {
    assert.equal(
      conversationMessageIdFromBizOpaque('3F2504E0-4F89-11D3-9A0C-0305E82C3301'),
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    );
    assert.equal(conversationMessageIdFromBizOpaque("1' OR 1=1"), null);
    assert.equal(conversationMessageIdFromBizOpaque(undefined), null);
  });

  it('mapeia status Meta', () => {
    assert.equal(statusUpdate('enqueued', at, {})?.status, 'SUBMITTED');
    assert.equal(statusUpdate('deleted', at, {}), null);
    assert.deepEqual(statusUpdate('failed', at, {}), {
      status: 'FAILED',
      at,
      failureCode: 'META_FAILED',
      failureReason: 'Falha reportada pelo provedor',
    });
  });
});
