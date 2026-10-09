import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { parseRegulamtXlsx } from './regulamt-parser.js';

describe('parser REGULAMT XLSX', () => {
  it('extrai CPF, CNS, nascimento e horário sem deslocar as datas', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Agenda');
    sheet.addRow([
      'Paciente',
      'Item',
      'Data agendamento',
      'CPF',
      'CNS',
      'Data nascimento',
      'WhatsApp',
    ]);
    sheet.addRow([
      'Maria da Silva',
      'Cardiologia',
      new Date(Date.UTC(2026, 2, 25, 10, 30)),
      1234567890,
      '7000 0477 3534 123',
      new Date(Date.UTC(1960, 4, 10)),
      '(65) 99999-9999 / (65) 3333-4444',
    ]);

    const result = await parseRegulamtXlsx(Buffer.from(await workbook.xlsx.writeBuffer()));
    assert.equal(result.layout, 'REGULAMT_XLSX');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.cpf, '01234567890');
    assert.equal(result.rows[0]?.cns, '700004773534123');
    assert.equal(result.rows[0]?.dataNascimento, '10/05/1960');
    assert.equal(result.rows[0]?.dataHora, '25/03/2026 10:30');
    assert.deepEqual(result.rows[0]?.telefones, ['(65) 99999-9999', '(65) 3333-4444']);
  });

  it('mantém solicitações repetidas como linhas separadas e ignora linhas vazias', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Agenda');
    sheet.addRow(['Paciente', 'Procedimento', 'WhatsApp']);
    sheet.addRow(['Pessoa Sintética', 'Consulta', '(65) 99999-9999']);
    sheet.addRow(['Pessoa Sintética', 'Exame', '(65) 99999-9999']);
    sheet.addRow([null, null, null]);

    const result = await parseRegulamtXlsx(Buffer.from(await workbook.xlsx.writeBuffer()));
    assert.equal(result.totalReported, 2);
    assert.deepEqual(
      result.rows.map((row) => row.procedimentos),
      [['Consulta'], ['Exame']],
    );
    assert.ok(result.warnings.some((warning) => warning.includes('1 linha(s) vazia(s)')));
  });

  it('devolve aviso claro quando os cabeçalhos mínimos não existem', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Agenda').addRow(['Nome', 'Procedimento']);

    const result = await parseRegulamtXlsx(Buffer.from(await workbook.xlsx.writeBuffer()));
    assert.equal(result.rows.length, 0);
    assert.match(result.warnings[0] ?? '', /cabeçalho incompatível/i);
  });
});
