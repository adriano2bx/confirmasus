import {
  normalizeBrazilianPhone,
  normalizePatientName,
  selectWhatsAppPhone,
} from '@confirma/domain';

export interface ImportedRowData {
  codigoConvocacaoOrigem: string | null;
  nome: string | null;
  dataNascimento: string | null;
  cpf: string | null;
  cns: string | null;
  telefones: string[];
  dataHora: string | null;
  procedimentos: string[];
  selectedPhone: string | null;
}

export interface ValidatedImportRow extends ImportedRowData {
  normalizedName: string | null;
  birthDate: Date | null;
  scheduledAt: Date | null;
  normalizedCpf: string | null;
  normalizedCns: string | null;
  phones: ReturnType<typeof normalizeBrazilianPhone>[];
  issues: string[];
}

export function readImportedRow(value: unknown): ImportedRowData {
  const data = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    codigoConvocacaoOrigem:
      typeof data.codigoConvocacaoOrigem === 'string' ? data.codigoConvocacaoOrigem : null,
    nome: typeof data.nome === 'string' ? data.nome : null,
    dataNascimento: typeof data.dataNascimento === 'string' ? data.dataNascimento : null,
    cpf: typeof data.cpf === 'string' ? data.cpf : null,
    cns: typeof data.cns === 'string' ? data.cns : null,
    telefones: Array.isArray(data.telefones)
      ? data.telefones.filter((item): item is string => typeof item === 'string')
      : [],
    dataHora: typeof data.dataHora === 'string' ? data.dataHora : null,
    procedimentos: Array.isArray(data.procedimentos)
      ? data.procedimentos.filter((item): item is string => typeof item === 'string')
      : [],
    selectedPhone: typeof data.selectedPhone === 'string' ? data.selectedPhone : null,
  };
}

function parseBrazilianDate(value: string | null): Date | null {
  if (!value) return null;
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day)
    ? parsed
    : null;
}

function parseBrazilianDateTime(value: string | null): Date | null {
  if (!value) return null;
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, day, month, year, hour, minute] = match;
  return zonedDateTime(
    Number(year),
    Number(month),
    Number(day),
    Number(hour),
    Number(minute),
    process.env.APP_TIMEZONE ?? 'America/Sao_Paulo',
  );
}

function zonedDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date | null {
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = new Date(wallClockUtc);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = zonedParts(candidate, timeZone);
    if (!parts) return null;
    const representedUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
    );
    candidate = new Date(candidate.getTime() + wallClockUtc - representedUtc);
  }
  const check = zonedParts(candidate, timeZone);
  return check &&
    check.year === year &&
    check.month === month &&
    check.day === day &&
    check.hour === hour &&
    check.minute === minute
    ? candidate
    : null;
}

function zonedParts(value: Date, timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(value);
    const values = Object.fromEntries(
      parts
        .filter(({ type }) => type !== 'literal')
        .map(({ type, value: part }) => [type, Number(part)]),
    );
    return {
      year: values.year!,
      month: values.month!,
      day: values.day!,
      hour: values.hour!,
      minute: values.minute!,
    };
  } catch {
    return null;
  }
}

export function validateImportedRow(value: unknown): ValidatedImportRow {
  const row = readImportedRow(value);
  const birthDate = parseBrazilianDate(row.dataNascimento);
  const scheduledAt = parseBrazilianDateTime(row.dataHora);
  const phones = row.telefones.map(normalizeBrazilianPhone);
  const selectedPhone = row.selectedPhone ? normalizeBrazilianPhone(row.selectedPhone) : null;
  const normalizedCpf = row.cpf?.replace(/\D/g, '') || null;
  const normalizedCns = row.cns?.replace(/\D/g, '') || null;
  const issues: string[] = [];

  if (!row.codigoConvocacaoOrigem) issues.push('Código da convocação ausente.');
  if (!row.nome || normalizePatientName(row.nome).length < 3)
    issues.push('Nome inválido ou ausente.');
  if (row.dataNascimento && !birthDate) issues.push('Data de nascimento inválida.');
  if (!selectWhatsAppPhone(phones)) issues.push('Nenhum telefone celular válido para WhatsApp.');
  if (selectedPhone && (!selectedPhone.valid || !selectedPhone.mobile)) {
    issues.push('O telefone selecionado para WhatsApp não é um celular válido.');
  } else if (
    selectedPhone &&
    !phones.some((phone) => phone.normalized === selectedPhone.normalized)
  ) {
    issues.push('O telefone selecionado para WhatsApp não está na lista de telefones.');
  }
  if (!scheduledAt) issues.push('Data/hora inválida ou ausente.');
  if (row.procedimentos.length === 0) issues.push('Procedimento ausente.');
  if (normalizedCpf && normalizedCpf.length !== 11) issues.push('CPF inválido.');
  if (normalizedCns && normalizedCns.length !== 15) issues.push('CNS inválido.');

  return {
    ...row,
    normalizedName: row.nome ? normalizePatientName(row.nome) : null,
    birthDate,
    scheduledAt,
    normalizedCpf: normalizedCpf?.length === 11 ? normalizedCpf : null,
    normalizedCns: normalizedCns?.length === 15 ? normalizedCns : null,
    phones,
    issues,
  };
}
