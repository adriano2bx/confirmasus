import ExcelJS from 'exceljs';
import type { ParsedSisregRow, SisregParseResult } from './sisreg-parser.js';

const normalizeHeader = (value: unknown) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('pt-BR');

function formatDate(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  // ExcelJS represents worksheet dates as UTC-backed JS Dates. Keep the
  // displayed spreadsheet clock (07:00 must remain 07:00 in the review).
  if (value instanceof Date) {
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.APP_TIMEZONE ?? 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((out, part) => {
      out[part.type] = part.value;
      return out;
    }, {});
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

function formatBirthDate(value: unknown): string | null {
  const pad = (part: number) => String(part).padStart(2, '0');
  let year: number;
  let month: number;
  let day: number;

  if (value instanceof Date) {
    year = value.getUTCFullYear();
    month = value.getUTCMonth() + 1;
    day = value.getUTCDate();
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000);
    year = date.getUTCFullYear();
    month = date.getUTCMonth() + 1;
    day = date.getUTCDate();
  } else {
    const text = String(value ?? '').trim();
    const brazilian = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (brazilian) {
      day = Number(brazilian[1]);
      month = Number(brazilian[2]);
      year = Number(brazilian[3]);
    } else if (iso) {
      year = Number(iso[1]);
      month = Number(iso[2]);
      day = Number(iso[3]);
    } else {
      return null;
    }
  }

  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  )
    return null;
  return `${pad(day)}/${pad(month)}/${year}`;
}

export async function parseRegulamtXlsx(data: Uint8Array): Promise<SisregParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(data) as any);
  const sheet = workbook.worksheets[0];
  if (!sheet)
    return {
      layout: 'REGULAMT_XLSX',
      pageCount: 1,
      reportedPageCount: 1,
      totalReported: 0,
      rows: [],
      warnings: ['A planilha não contém abas.'],
    };

  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => headers.set(normalizeHeader(cell.value), column));
  const column = (...names: string[]) =>
    names
      .map(normalizeHeader)
      .map((name) => headers.get(name))
      .find(Boolean);
  const patientColumn = column('Paciente');
  const itemColumn = column('Item', 'Procedimento');
  const appointmentColumn = column('Data agendamento', 'Data do agendamento');
  const idColumn = column('ID', 'Código');
  const cpfColumn = column('CPF');
  const cnsColumn = column('CNS', 'Cartão SUS', 'Cartão Nacional de Saúde');
  const birthDateColumn = column('Data nascimento', 'Data de nascimento', 'Nascimento');
  // Suporte a Telefone/Celular/WhatsApp/Fone/Contato (ex.: "Telefone", "Celular", "WhatsApp", "Telefone 1", "Fone")
  const phoneColumns = [...headers.entries()]
    .filter(([name]) =>
      ['telefone', 'celular', 'whatsapp', 'fone', 'contato'].some((key) => name.includes(key)),
    )
    .map(([, col]) => col);
  if (!patientColumn || !itemColumn) {
    return {
      layout: 'REGULAMT_XLSX',
      pageCount: 1,
      reportedPageCount: 0,
      totalReported: 0,
      rows: [],
      warnings: ['Cabeçalho incompatível: esperado ao menos Paciente e Item.'],
    };
  }

  const rows: ParsedSisregRow[] = [];
  let ignored = 0;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const nome = String(row.getCell(patientColumn).value ?? '').trim() || null;
    const item = String(row.getCell(itemColumn).value ?? '').trim() || null;
    if (!nome && !item) {
      ignored += 1;
      continue;
    }
    const dataHora = appointmentColumn ? formatDate(row.getCell(appointmentColumn).value) : null;
    const birthDateValue = birthDateColumn ? row.getCell(birthDateColumn).value : null;
    const dataNascimento = birthDateColumn ? formatBirthDate(birthDateValue) : null;
    const codigo = idColumn ? String(row.getCell(idColumn).value ?? '').trim() || null : null;
    const cpfValue = cpfColumn ? row.getCell(cpfColumn).value : null;
    const cpfText = cpfValue == null ? '' : String(cpfValue).trim();
    // Excel may store CPF cells as numbers, which drops leading zeroes.
    const cpf = cpfText
      ? typeof cpfValue === 'number' && Number.isInteger(cpfValue) && cpfText.length < 11
        ? cpfText.padStart(11, '0')
        : cpfText
      : null;
    const cnsValue = cnsColumn ? row.getCell(cnsColumn).value : null;
    const cns = cnsValue == null ? null : String(cnsValue).replace(/\D/g, '') || null;
    const telefones = phoneColumns.length
      ? [
          ...new Set(
            phoneColumns
              .flatMap((col) => {
                const raw = row.getCell(col).value;
                if (raw == null || raw === '') return [];
                const text = String(raw).trim();
                if (!text) return [];
                // Aceita múltiplos números numa mesma célula separados por , ; / | quebra de linha ou " e "
                return text
                  .split(/[,;\/|\n]+/)
                  .flatMap((part) => part.split(/\s+e\s+/i))
                  .map((part) => part.trim())
                  .filter(Boolean);
              })
              .map((phone) => phone.trim())
              .filter(Boolean),
          ),
        ]
      : [];
    const issues: string[] = [];
    if (cpf && cpf.replace(/\D/g, '').length !== 11) issues.push('CPF inválido.');
    if (cns && cns.length !== 15) issues.push('CNS inválido.');
    if (birthDateValue != null && String(birthDateValue).trim() && !dataNascimento)
      issues.push('Data de nascimento inválida.');
    if (telefones.length === 0) issues.push('Telefone ausente.');
    if (!nome) issues.unshift('Nome não identificado.');
    if (!item) issues.push('Procedimento ausente.');
    if (!dataHora) issues.push('Data/hora ausente.');
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    rows.push({
      rowNumber,
      rawText: values.map((value: unknown) => String(value ?? '')).join(' | '),
      codigoConvocacaoOrigem: codigo,
      nome,
      dataNascimento,
      cpf,
      cns,
      telefones,
      dataHora,
      procedimentos: item ? [item] : [],
      issues,
    });
  }
  const phoneHint = phoneColumns.length
    ? 'Telefone extraído das colunas Telefone/Celular/WhatsApp/Fone quando presentes.'
    : 'Telefone não encontrado na planilha — coluna aceita: Telefone, Telefones, Celular, WhatsApp, Fone ou Contato (ex.: "Telefone", "Telefone 1", "Celular").';
  const unavailableFields: string[] = [];
  if (!cpfColumn) unavailableFields.unshift('CPF');
  if (!cnsColumn) unavailableFields.push('CNS');
  if (!birthDateColumn) unavailableFields.push('nascimento');
  const warnings = [
    `Planilha REGULAMT: ${unavailableFields.length ? `campos não encontrados na origem: ${unavailableFields.join(', ')}; ` : ''}${phoneHint} Nascimento é opcional para aprovação. Complete os registros na revisão antes de aprovar se desejar.`,
  ];
  if (ignored) warnings.push(`${ignored} linha(s) vazia(s) foram ignoradas.`);
  return {
    layout: 'REGULAMT_XLSX',
    pageCount: 1,
    reportedPageCount: 1,
    totalReported: rows.length,
    rows,
    warnings,
  };
}
