import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateImportedRow } from './import-row.js';

const baseRow = {
  codigoConvocacaoOrigem: 'REQ-1',
  nome: 'Maria da Silva',
  dataNascimento: '01/01/1980',
  cpf: null,
  cns: null,
  dataHora: '10/10/2026 10:00',
  procedimentos: ['Consulta'],
};

describe('telefone único do paciente na importação', () => {
  it('mantém só o WhatsApp selecionado e descarta os demais números', () => {
    const row = validateImportedRow({
      ...baseRow,
      telefones: ['(65) 3333-4444', '(65) 99999-9999', '(65) 98888-7777'],
      selectedPhone: '(65) 98888-7777',
    });

    assert.equal(row.issues.length, 0);
    assert.deepEqual(row.telefones, ['5565988887777']);
    assert.equal(row.selectedPhone, '5565988887777');
    assert.deepEqual(
      row.phones.map((phone) => phone.normalized),
      ['5565988887777'],
    );
  });

  it('escolhe o primeiro celular válido quando a linha não tem seleção explícita', () => {
    const row = validateImportedRow({
      ...baseRow,
      telefones: ['(65) 3333-4444', '(65) 99999-9999', '(65) 98888-7777'],
      selectedPhone: null,
    });

    assert.equal(row.issues.length, 0);
    assert.deepEqual(row.telefones, ['5565999999999']);
    assert.equal(row.selectedPhone, '5565999999999');
  });

  it('mantém inválida uma seleção que não corresponde a celular fornecido', () => {
    const row = validateImportedRow({
      ...baseRow,
      telefones: ['(65) 99999-9999', '(65) 98888-7777'],
      selectedPhone: '(65) 3333-4444',
    });

    assert.ok(row.issues.includes('O telefone selecionado para WhatsApp não é um celular válido.'));
    assert.deepEqual(row.telefones, ['5565999999999']);
  });
});
