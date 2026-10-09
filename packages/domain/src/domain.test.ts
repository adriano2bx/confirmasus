import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeBrazilianPhone,
  normalizeButtonAction,
  normalizePatientName,
  patientGroupingKey,
  selectWhatsAppPhone,
  templateForStage,
} from './index.js';

describe('normalização do domínio', () => {
  it('normaliza nome e agrupa pelo WhatsApp', () => {
    assert.equal(normalizePatientName('  Maria  da Sílva '), 'MARIA DA SILVA');
    assert.equal(patientGroupingKey({ phones: ['(65) 99999-9999'] }), 'WHATSAPP:5565999999999');
  });

  it('usa o número selecionado para WhatsApp como chave', () => {
    assert.equal(
      patientGroupingKey({
        phones: ['+55 (65) 99999-9999'],
        selectedPhone: '(65) 99999-9999',
      }),
      'WHATSAPP:5565999999999',
    );
  });

  it('normaliza e escolhe o primeiro celular válido', () => {
    const landline = normalizeBrazilianPhone('(65) 3333-4444');
    const mobile = normalizeBrazilianPhone('(65) 99999-9999');
    assert.deepEqual(mobile, {
      original: '(65) 99999-9999',
      normalized: '5565999999999',
      valid: true,
      mobile: true,
    });
    assert.equal(selectWhatsAppPhone([landline, mobile]), mobile);
  });
});

describe('respostas e templates', () => {
  it('normaliza todos os textos oficiais', () => {
    for (const text of ['Confirmar', 'Quero Confirmar', 'Vou Confirmar']) {
      assert.equal(normalizeButtonAction(text), 'CONFIRM');
    }
    for (const text of ['Cancelar', 'Quero Cancelar', 'Vou Cancelar']) {
      assert.equal(normalizeButtonAction(text), 'CANCEL');
    }
  });

  it('seleciona template exclusivamente pela etapa', () => {
    assert.equal(templateForStage('FIRST').name, 'primeira_convocacao_sus_unico');
    assert.equal(templateForStage('SECOND').name, 'segunda_convocacao_sus');
    assert.equal(templateForStage('THIRD').name, 'terceira_convocacao_sus');
  });
});
