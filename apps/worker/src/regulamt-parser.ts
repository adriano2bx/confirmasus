import ExcelJS from 'exceljs';
import type { ParsedSisregRow, SisregParseResult } from './sisreg-parser.js';

const normalizeHeader = (value: unknown) => String(value ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('pt-BR');

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
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).reduce<Record<string, string>>((out, part) => {
    out[part.type] = part.value;
    return out;
  }, {});
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

export async function parseRegulamtXlsx(data: Uint8Array): Promise<SisregParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(data) as any);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { layout: 'REGULAMT_XLSX', pageCount: 1, reportedPageCount: 1, totalReported: 0, rows: [], warnings: ['A planilha não contém abas.'] };

  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => headers.set(normalizeHeader(cell.value), column));
  const column = (...names: string[]) => names.map(normalizeHeader).map((name) => headers.get(name)).find(Boolean);
  const patientColumn = column('Paciente');
  const itemColumn = column('Item', 'Procedimento');
  const appointmentColumn = column('Data agendamento', 'Data do agendamento');
  const idColumn = column('ID', 'Código');
  // Suporte a Telefone/Celular/WhatsApp/Fone/Contato (ex.: "Telefone", "Celular", "WhatsApp", "Telefone 1", "Fone")
  const phoneColumns = [...headers.entries()]
    .filter(([name]) =>
      ['telefone', 'celular', 'whatsapp', 'fone', 'contato'].some((key) => name.includes(key)),
    )
    .map(([, col]) => col);
  if (!patientColumn || !itemColumn) {
    return { layout: 'REGULAMT_XLSX', pageCount: 1, reportedPageCount: 0, totalReported: 0, rows: [], warnings: ['Cabeçalho incompatível: esperado ao menos Paciente e Item.'] };
  }

  const rows: ParsedSisregRow[] = [];
  let ignored = 0;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const nome = String(row.getCell(patientColumn).value ?? '').trim() || null;
    const item = String(row.getCell(itemColumn).value ?? '').trim() || null;
    if (!nome && !item) { ignored += 1; continue; }
    const dataHora = appointmentColumn ? formatDate(row.getCell(appointmentColumn).value) : null;
    const codigo = idColumn ? String(row.getCell(idColumn).value ?? '').trim() || null : null;
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
    const issues = ['Data de nascimento ausente.'];
    if (telefones.length === 0) issues.push('Telefone ausente.');
    if (!nome) issues.unshift('Nome não identificado.');
    if (!item) issues.push('Procedimento ausente.');
    if (!dataHora) issues.push('Data/hora ausente.');
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    rows.push({ rowNumber, rawText: values.map((value: unknown) => String(value ?? '')).join(' | '), codigoConvocacaoOrigem: codigo, nome, dataNascimento: null, cpf: null, cns: null, telefones, dataHora, procedimentos: item ? [item] : [], issues });
  }
  const phoneHint = phoneColumns.length
    ? 'Telefone extraído das colunas Telefone/Celular/WhatsApp/Fone quando presentes.'
    : 'Telefone não encontrado na planilha — coluna aceita: Telefone, Telefones, Celular, WhatsApp, Fone ou Contato (ex.: "Telefone", "Telefone 1", "Celular").';
  const warnings = [
    `Planilha REGULAMT: nascimento e CPF/CNS não são fornecidos; ${phoneHint} Complete os registros na revisão antes de aprovar.`,
  ];
  if (ignored) warnings.push(`${ignored} linha(s) vazia(s) foram ignoradas.`);
  return { layout: 'REGULAMT_XLSX', pageCount: 1, reportedPageCount: 1, totalReported: rows.length, rows, warnings };
}
