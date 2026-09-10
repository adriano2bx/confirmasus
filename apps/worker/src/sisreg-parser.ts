import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PositionedText {
  text: string;
  x: number;
  y: number;
  page: number;
}

export interface ParsedSisregRow {
  rowNumber: number;
  rawText: string;
  codigoConvocacaoOrigem: string | null;
  nome: string | null;
  dataNascimento: string | null;
  cpf: string | null;
  cns: string | null;
  telefones: string[];
  dataHora: string | null;
  procedimentos: string[];
  issues: string[];
}

export interface SisregParseResult {
  layout: 'SISREG_V1' | 'SISREG_V2' | 'REGULAMT_XLSX' | 'UNKNOWN';
  pageCount: number;
  reportedPageCount: number | null;
  totalReported: number | null;
  rows: ParsedSisregRow[];
  warnings: string[];
}

const PHONE_PATTERN = /(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[\s-]?\d{4}/g;
const CPF_PATTERN = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/;
const CODE_PATTERN = /\b\d{7,12}\b/;

function detectLayout(fullText: string): SisregParseResult['layout'] {
  if (/Confirma[cç][aã]o\s+de\s+Agendas|CONSULTA\s+DE\s+AGENDA\s+DE\s+PROFISSIONAL/i.test(fullText))
    return 'SISREG_V2';
  if (/SISREG|Sistema Nacional de Regula[cç][aã]o/i.test(fullText)) return 'SISREG_V1';
  return 'UNKNOWN';
}

export function rebuildLines(items: readonly PositionedText[]): string[] {
  const groups: PositionedText[][] = [];

  for (const item of [...items].sort((a, b) => a.page - b.page || b.y - a.y)) {
    const group = groups.find(
      (candidate) =>
        candidate[0]?.page === item.page && Math.abs((candidate[0]?.y ?? 0) - item.y) <= 3,
    );
    if (group) group.push(item);
    else groups.push([item]);
  }

  return groups
    .sort((a, b) => (a[0]?.page ?? 0) - (b[0]?.page ?? 0) || (b[0]?.y ?? 0) - (a[0]?.y ?? 0))
    .map((group) =>
      group
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

export function parseSisregLines(lines: readonly string[], pageCount: number): SisregParseResult {
  const fullText = lines.join('\n');
  const layout = detectLayout(fullText);
  const pagination = fullText.match(/P[aá]gina\s+\d+\s+de\s+(\d+)/i);
  const reportedTotal = fullText.match(/(?:Total|Quantidade)\D{0,20}(\d{1,7})/i);
  const reportedPageCount = pagination?.[1] ? Number(pagination[1]) : null;
  const totalReported = reportedTotal?.[1] ? Number(reportedTotal[1]) : null;

  const starts: number[] = [];
  lines.forEach((line, index) => {
    // In the SISREG report the procedure code also has nine digits. A
    // convocation starts at the appointment header, never at "Procedimento".
    if (
      line.match(CODE_PATTERN) &&
      !/P[aá]gina|Total/i.test(line) &&
      !/^\s*Procedimento/i.test(line)
    )
      starts.push(index);
  });

  const rows = starts.map((start, rowIndex) => {
    const end = starts[rowIndex + 1] ?? lines.length;
    return parseRecordBlock(lines.slice(start, end).join(' '), rowIndex + 1);
  });

  const warnings: string[] = [];
  if (layout === 'UNKNOWN') warnings.push('Layout do PDF não reconhecido com segurança.');
  if (reportedPageCount !== null && reportedPageCount > pageCount) {
    warnings.push(
      `O documento informa ${reportedPageCount} páginas, mas o arquivo contém ${pageCount}.`,
    );
  }
  if (totalReported !== null && rows.length < totalReported) {
    warnings.push(
      `O SISREG informa ${totalReported} registros, mas ${rows.length} foram encontrados.`,
    );
  }
  if (rows.length === 0) warnings.push('Nenhum registro de convocação foi identificado.');

  return { layout, pageCount, reportedPageCount, totalReported, rows, warnings };
}

function parseRecordBlock(rawText: string, rowNumber: number): ParsedSisregRow {
  const normalized = normalizeSisregSpacing(rawText);
  const code = normalized.match(CODE_PATTERN)?.[0] ?? null;
  const cpf = normalized.match(CPF_PATTERN)?.[0] ?? null;
  const cns = extractCns(normalized);
  const phones = [...normalized.matchAll(PHONE_PATTERN)]
    .map((match) => match[0].trim())
    .filter(
      (phone) =>
        phone.replace(/\D/g, '').length >= 10 &&
        (phone.includes('-') || (phone.includes('(') && phone.includes(')'))),
    );
  const dates = extractSpacedDates(rawText);
  const firstTime = extractSpacedTimes(rawText)[0] ?? null;
  const nameMatch = code ? extractPatientName(normalized) : null;
  const procedureMatch = extractProcedure(normalized);

  const row: ParsedSisregRow = {
    rowNumber,
    rawText,
    codigoConvocacaoOrigem: code,
    nome: nameMatch ?? null,
    // The appointment date appears first; the patient's birth date is the
    // last date in the record block.
    dataNascimento: dates.at(-1) ?? null,
    cpf,
    cns,
    telefones: [...new Set(phones)],
    dataHora: dates[0] && firstTime ? `${dates[0]} ${firstTime}` : null,
    procedimentos: procedureMatch ? [procedureMatch] : [],
    issues: [],
  };

  if (!row.codigoConvocacaoOrigem) row.issues.push('Código da convocação ausente.');
  if (!row.nome) row.issues.push('Nome não identificado com segurança.');
  if (row.telefones.length === 0) row.issues.push('Telefone ausente.');
  if (!row.dataHora) row.issues.push('Data/hora ausente.');
  if (row.procedimentos.length === 0) row.issues.push('Procedimento ausente.');
  return row;
}

function normalizeSisregSpacing(value: string): string {
  // pdfjs exposes some SISREG glyphs as one character per text item. Keep
  // word boundaries but compact numbers, dates, times and phone characters.
  return value
    .replace(/Telef\s+one/gi, 'Telefone')
    .replace(/Procedimento\s*\(\s*s\s*\)/gi, 'Procedimento(s)')
    .replace(/[\d][\d\s/():-]*[\d]/g, (part) => part.replace(/\s+/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSpacedDates(value: string): string[] {
  return [...value.matchAll(/(\d\s*\d\s*\/\s*\d\s*\d\s*\/\s*\d\s*\d\s*\d\s*\d)/g)]
    .map((match) => match[1]?.replace(/\s+/g, '') ?? '')
    .filter((date) => /^\d{2}\/\d{2}\/\d{4}$/.test(date));
}

function extractSpacedTimes(value: string): string[] {
  return [...value.matchAll(/(\d\s*\d\s*:\s*\d\s*\d)/g)]
    .map((match) => match[1]?.replace(/\s+/g, '') ?? '')
    .filter((time) => /^\d{2}:\d{2}$/.test(time));
}

function extractProcedure(value: string): string | null {
  const compact = value.replace(/[\s]/g, '').toLocaleUpperCase('pt-BR');
  if (
    compact.includes('TOMOGRAFIA') &&
    compact.includes('EMISS') &&
    compact.includes('PÓSIT') &&
    compact.includes('PET-CT')
  ) {
    return 'TOMOGRAFIA POR EMISSÃO DE PÓSITRONS (PET-CT)';
  }
  const match = value.match(/Procedimento\(s\):\s*(.+?)(?=\s+Paciente:|$)/i);
  if (match?.[1]?.trim()) return match[1].trim();

  // Some SISREG exports place the label after the procedure lines when the
  // PDF text items are read by vertical position. Recover the numbered
  // procedure block in that ordering as well.
  const numbered = value.match(/\b(?:0[1-9]|[12]\d)\s*-\s*[\s\S]+/);
  return numbered?.[0]?.replace(/\s+Procedimento\(s\):\s*$/i, '').trim() ?? null;
}

function extractPatientName(value: string): string | null {
  const candidates = [between(value, 'Paciente:', 'CNS:'), between(value, 'Nascimento:', 'Idade:')]
    .map(cleanName)
    .filter((candidate): candidate is string => Boolean(candidate));
  const candidate = candidates.find((item) => item.replace(/\s/g, '').length >= 4);
  return candidate ?? null;
}

function extractCns(value: string): string | null {
  const betweenLabels = between(value, 'CNS:', 'Nascimento:').replace(/\D/g, '');
  return betweenLabels.length === 15 ? betweenLabels : null;
}

function between(value: string, start: string, end: string): string {
  const from = value.indexOf(start);
  if (from < 0) return '';
  const to = value.indexOf(end, from + start.length);
  return to < 0 ? '' : value.slice(from + start.length, to);
}

function cleanName(value: string): string | null {
  const withoutNumbers = value
    .replace(/\(?\d{2}\)?\d{4,5}-\d{4}/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\b(?:Telefone\(s\)|Origem|Idade|Paciente)\b/gi, ' ')
    .trim();
  // Join broken glyph runs such as "A D RI A N A" while preserving actual
  // spaces where the PDF supplies them.
  const joined = withoutNumbers.replace(/\b(?:[A-ZÀ-Ý]{1,2}\s+){2,}[A-ZÀ-Ý]{1,4}\b/g, (part) =>
    part.replace(/\s+/g, ''),
  );
  const words = joined.match(/[A-ZÀ-Ý][A-ZÀ-Ý'’-]*/gi) ?? [];
  const result = words
    .filter((word) => !['MT', 'GO', 'JATAI', 'CUIABA'].includes(word.toUpperCase()))
    .join(' ')
    .trim();
  return result.length >= 4 ? result : null;
}

export async function parseSisregPdf(data: Uint8Array): Promise<SisregParseResult> {
  const document = await getDocument({ data, useSystemFonts: true }).promise;
  const items: PositionedText[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const operatorList = await page.getOperatorList();
    const operatorText = operatorTextByAlignmentKey(operatorList.fnArray, operatorList.argsArray);
    for (const item of content.items) {
      if (!('str' in item)) continue;
      items.push({
        text: restoreExplicitSpacing(item.str, operatorText),
        x: item.transform[4] ?? 0,
        y: item.transform[5] ?? 0,
        page: pageNumber,
      });
    }
  }

  return parseSisregPositionedItems(items, document.numPages);
}

/**
 * The SISREG PDF renders each appointment as a visual card: patient details
 * are above the request code and scheduling/procedure details are below it.
 * Reading only linear text interleaves columns, so this parser keeps the PDF
 * coordinates as the source of truth for the real SISREG_V1 layout.
 */
export function parseSisregPositionedItems(
  items: readonly PositionedText[],
  pageCount: number,
): SisregParseResult {
  const lines = rebuildLines(items);
  const fullText = lines.join('\n');
  const layout = detectLayout(fullText);
  const codes = items
    .filter((item) => item.x < 85 && /^\d{7,12}$/.test(item.text.trim()))
    .sort((left, right) => left.page - right.page || right.y - left.y);
  const rows = codes.map((code, index) => {
    const previous = codes[index - 1];
    const next = codes[index + 1];
    // The first card on a page follows a long report header. A bounded window
    // above its code prevents header labels from being treated as a patient.
    const upper = previous?.page === code.page ? (previous.y + code.y) / 2 : code.y + 60;
    const lower =
      next?.page === code.page
        ? layout === 'SISREG_V2'
          ? next.y + 20
          : (next.y + code.y) / 2
        : Number.NEGATIVE_INFINITY;
    const block = items.filter(
      (item) => item.page === code.page && item.y <= upper && item.y >= lower && item.text.trim(),
    );
    const row = parsePositionedRecord(code, block, index + 1, layout);
    if (row.procedimentos.length === 0) {
      const procedureLabel = items
        .filter(
          (item) =>
            item.page === code.page &&
            /Procedimento\(s\):/i.test(item.text) &&
            Math.abs(item.y - code.y) < 100,
        )
        .sort((left, right) => Math.abs(left.y - code.y) - Math.abs(right.y - code.y))[0];
      if (procedureLabel) {
        const adjacentProcedure = items
          .filter((item) => item.page === code.page && Math.abs(item.y - procedureLabel.y) <= 3)
          .map((item) => item.text)
          .join(' ');
        const procedure = extractProcedure(adjacentProcedure);
        if (procedure) {
          row.procedimentos = [procedure];
          row.issues = row.issues.filter((issue) => issue !== 'Procedimento ausente.');
        }
      }
    }
    // A page can end between the patient card and its scheduling/procedure
    // rows. Attach only the top continuation area of the next page.
    if (next && next.page > code.page) {
      const continuation = items.filter(
        (item) => item.page === next.page && item.y > next.y && item.text.trim(),
      );
      const continuationSchedule = continuation
        .filter((item) => item.x >= 425 && item.x < 500)
        .map((item) => item.text)
        .join(' ');
      const continuationDate =
        extractSpacedDates(continuationSchedule)[0] ?? extractSpacedDates(row.rawText)[0];
      const continuationTime = extractSpacedTimes(continuationSchedule)[0];
      const continuationProcedure = extractProcedure(
        continuation
          .filter((item) => item.x >= 80 && item.x < 500)
          .map((item) => item.text)
          .join(' '),
      );
      if (!row.dataHora && continuationDate && continuationTime)
        row.dataHora = `${continuationDate} ${continuationTime}`;
      if (row.procedimentos.length === 0 && continuationProcedure)
        row.procedimentos = [continuationProcedure];
      row.issues = row.issues.filter(
        (issue) =>
          !(issue === 'Data/hora ausente.' && row.dataHora) &&
          !(issue === 'Procedimento ausente.' && row.procedimentos.length > 0),
      );
    }
    return row;
  });
  const pagination = fullText.match(/P[aá]gina\s+\d+\s+de\s+(\d+)/i);
  const reportedTotal = fullText.match(
    /(?:Resultados por p[aá]gina|Total|Quantidade)\D{0,20}(\d{1,7})/i,
  );
  const warnings: string[] = [];
  const reportedPageCount = pagination?.[1] ? Number(pagination[1]) : null;
  const totalReported = reportedTotal?.[1] ? Number(reportedTotal[1]) : null;
  if (layout === 'UNKNOWN') warnings.push('Layout do PDF não reconhecido com segurança.');
  if (reportedPageCount !== null && reportedPageCount > pageCount)
    warnings.push(
      `O documento informa ${reportedPageCount} páginas, mas o arquivo contém ${pageCount}.`,
    );
  if (rows.length === 0) warnings.push('Nenhum registro de convocação foi identificado.');
  return { layout, pageCount, reportedPageCount, totalReported, rows, warnings };
}

function parsePositionedRecord(
  code: PositionedText,
  block: readonly PositionedText[],
  rowNumber: number,
  layout: SisregParseResult['layout'],
): ParsedSisregRow {
  const columns: Record<
    'name' | 'birth' | 'phone' | 'schedule' | 'procedure',
    readonly [number, number]
  > =
    layout === 'SISREG_V2'
      ? {
          name: [150, 225],
          birth: [225, 295],
          phone: [500, 560],
          schedule: [440, 500],
          procedure: [80, 500],
        }
      : {
          name: [150, 230],
          birth: [225, 295],
          phone: [490, 560],
          schedule: [425, 500],
          procedure: [225, 490],
        };
  const at = (min: number, max: number) =>
    block.filter((item) => item.x >= min && item.x < max).sort((left, right) => right.y - left.y);
  const nameParts = at(...columns.name)
    .filter((item) => !/Paciente:/i.test(item.text))
    .map((item) => compactName(item.text))
    .filter(Boolean);
  const birth =
    at(...columns.birth)
      .map((item) => extractSpacedDates(item.text)[0])
      .find(Boolean) ?? null;
  const phone = at(...columns.phone).flatMap((item) =>
    extractPhones(normalizeSisregSpacing(item.text)),
  );
  const schedule = at(...columns.schedule)
    .map((item) => item.text)
    .join(' ');
  const scheduleDates = extractSpacedDates(schedule);
  const scheduleTime = extractSpacedTimes(schedule)[0] ?? null;
  const procedureText = at(...columns.procedure)
    .map((item) => item.text)
    .join(' ');
  const rawText = [...block]
    .sort((left, right) => right.y - left.y || left.x - right.x)
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join(' ');
  const cns = extractCnsColumn(at(75, 150));
  const row: ParsedSisregRow = {
    rowNumber,
    rawText,
    codigoConvocacaoOrigem: code.text.trim(),
    nome: nameParts.length ? nameParts.join(' ') : null,
    dataNascimento: birth,
    cpf: null,
    cns: cns ?? extractCns(rawText),
    telefones: [...new Set(phone)],
    dataHora: scheduleDates[0] && scheduleTime ? `${scheduleDates[0]} ${scheduleTime}` : null,
    procedimentos: extractProcedure(procedureText) ? [extractProcedure(procedureText)!] : [],
    issues: [],
  };
  if (!row.nome) row.issues.push('Nome não identificado com segurança.');
  if (row.telefones.length === 0) row.issues.push('Telefone ausente.');
  if (!row.dataHora) row.issues.push('Data/hora ausente.');
  if (row.procedimentos.length === 0) row.issues.push('Procedimento ausente.');
  return row;
}

function compactName(value: string): string {
  const withoutFooter = value
    .replace(/ESTAT[IÍ]STICAS\s*DA\s*PESQUISA.*$/i, '')
    .replace(/(?:VAGAS\s*DE|SOLICITA[CÇ][OÕ]ES|TOTAL\s*DE).*$/i, '')
    .trim();
  const parts = withoutFooter.split(/\s+/).filter(Boolean);
  const fragmented =
    parts.length >= 4 && parts.filter((part) => part.length <= 2).length / parts.length >= 0.7;
  return (fragmented ? parts.join('') : parts.join(' ')).trim();
}

function extractCnsColumn(items: readonly PositionedText[]): string | null {
  const text = items
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join(' ');
  const match = text.match(/\d(?:[\s\d]*\d){14}/);
  const digits = match?.[0].replace(/\D/g, '');
  return digits?.length === 15 ? digits : null;
}

function operatorTextByAlignmentKey(
  operations: readonly number[],
  argumentsList: readonly unknown[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current = '';
  let insideText = false;
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation === OPS.beginText) {
      current = '';
      insideText = true;
      continue;
    }
    if (operation === OPS.showText && insideText) {
      const args = argumentsList[index] as [Array<number | { unicode?: string }>] | undefined;
      current += (args?.[0] ?? [])
        .filter((glyph): glyph is { unicode?: string } => typeof glyph !== 'number')
        .map((glyph) => glyph.unicode ?? '')
        .join('');
      continue;
    }
    if (operation === OPS.endText && insideText) {
      const normalized = current.replace(/\s+/g, ' ').trim();
      const key = alignmentKey(normalized);
      if (key) result.set(key, [...(result.get(key) ?? []), normalized]);
      current = '';
      insideText = false;
    }
  }
  return result;
}

export function restoreExplicitSpacing(value: string, candidates: Map<string, string[]>): string {
  const matches = candidates.get(alignmentKey(value));
  return matches?.shift() ?? value;
}

function alignmentKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLocaleUpperCase('pt-BR');
}

function extractPhones(value: string): string[] {
  return [...value.matchAll(PHONE_PATTERN)]
    .map((match) => match[0].trim())
    .filter(
      (phone) =>
        phone.replace(/\D/g, '').length >= 10 &&
        (phone.includes('-') || (phone.includes('(') && phone.includes(')'))),
    );
}
