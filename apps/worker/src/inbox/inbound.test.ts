import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { conversationInboundPatch, eligibilityFields, inboundTimelineData } from './inbound.js';

describe('inbound do inbox: envelope normalizado', () => {
  it('extrai wa_id, número, context.id e texto do envelope novo', () => {
    const data = inboundTimelineData(envelope({ text: 'Olá', type: 'text' }, 'wamid.campanha'));
    assert.equal(data.waMessageId, 'wamid.in-1');
    assert.equal(data.waId, '5511999990000');
    assert.equal(data.phoneNumberId, 'pn-1');
    assert.equal(data.profileName, 'Perfil');
    assert.equal(data.contextWaMessageId, 'wamid.campanha');
    assert.equal(data.contentType, 'text');
    assert.equal(data.body, 'Olá');
    assert.equal(data.media, null);
  });

  it('envelope legado sem phoneNumberId usa a coluna do evento e depois o número configurado', () => {
    const legacy = {
      type: 'message',
      payload: { id: 'wamid.x', source: '+55 11 99999-0000', type: 'text', payload: { text: 'a' } },
    };
    assert.equal(inboundTimelineData(legacy).phoneNumberId, null);
    assert.equal(inboundTimelineData(legacy).waId, '5511999990000');
    assert.equal(
      inboundTimelineData(legacy, { legacyPhoneNumberId: 'pn-env' }).phoneNumberId,
      'pn-env',
    );
    assert.equal(
      inboundTimelineData(legacy, { eventPhoneNumberId: 'pn-col', legacyPhoneNumberId: 'pn-env' })
        .phoneNumberId,
      'pn-col',
    );
  });

  it('trunca o corpo em 4096 caracteres e não guarda nada de localização', () => {
    const long = inboundTimelineData(envelope({ text: 'x'.repeat(5_000), type: 'text' }));
    assert.equal(long.body?.length, 4_096);
    const location = inboundTimelineData(envelope({ type: 'location', text: 'Rua X' }));
    assert.equal(location.contentType, 'location');
    assert.equal(location.body, null);
  });

  it('mapeia mídia para MediaAsset pendente e normaliza tipo desconhecido', () => {
    const data = inboundTimelineData(
      envelope({ type: 'image', media: { id: 'media-1', mimeType: 'image/jpeg' } }),
    );
    assert.deepEqual(data.media, { providerMediaId: 'media-1', declaredMimeType: 'image/jpeg' });
    assert.equal(inboundTimelineData(envelope({ type: 'tipo<script>' })).contentType, 'unknown');
  });
});

describe('inbound do inbox: conversa e elegibilidade', () => {
  const base = {
    status: 'OPEN',
    lastInboundAt: new Date('2026-10-16T12:00:00Z'),
    lastEligibleInboundAt: new Date('2026-10-16T12:00:00Z'),
    lastActivityAt: new Date('2026-10-16T12:00:00Z'),
  };

  it('evento atrasado não reduz lastInboundAt nem lastEligibleInboundAt', () => {
    const patch = conversationInboundPatch(base, new Date('2026-10-16T11:00:00Z'), true);
    assert.equal(patch.lastInboundAt.toISOString(), '2026-10-16T12:00:00.000Z');
    assert.equal(patch.lastEligibleInboundAt?.toISOString(), '2026-10-16T12:00:00.000Z');
    assert.equal(patch.status, undefined);
  });

  it('inbound não elegível nunca toca a âncora da janela', () => {
    const patch = conversationInboundPatch(base, new Date('2026-10-16T13:00:00Z'), false);
    assert.equal(patch.lastInboundAt.toISOString(), '2026-10-16T13:00:00.000Z');
    assert.equal('lastEligibleInboundAt' in patch, false);
  });

  it('WAITING_CONTACT e SNOOZED voltam para OPEN', () => {
    const at = new Date('2026-10-16T13:00:00Z');
    assert.equal(
      conversationInboundPatch({ ...base, status: 'SNOOZED' }, at, false).status,
      'OPEN',
    );
    assert.equal(
      conversationInboundPatch({ ...base, status: 'WAITING_CONTACT' }, at, false).status,
      'OPEN',
    );
  });

  it('só grava o template respondido quando elegível', () => {
    assert.deepEqual(eligibilityFields({ eligible: true, reason: 'TEMPLATE_REPLY' }, 'm-1'), {
      replyEligibility: 'ELIGIBLE_TEMPLATE_REPLY',
      eligibilityReason: 'TEMPLATE_REPLY',
      repliedCampaignMessageId: 'm-1',
    });
    assert.deepEqual(eligibilityFields({ eligible: false, reason: 'RECIPIENT_MISMATCH' }, 'm-1'), {
      replyEligibility: 'NOT_ELIGIBLE',
      eligibilityReason: 'RECIPIENT_MISMATCH',
      repliedCampaignMessageId: null,
    });
  });
});

function envelope(content: Record<string, unknown>, contextId?: string) {
  return {
    type: 'message',
    timestamp: 1_760_000_000_000,
    phoneNumberId: 'pn-1',
    waId: '5511999990000',
    profileName: 'Perfil',
    payload: {
      id: 'wamid.in-1',
      source: '5511999990000',
      ...(contextId ? { context: { id: contextId } } : {}),
      type: content.type,
      payload: content,
    },
  };
}
