export interface NormalizedPhone {
  original: string;
  normalized: string;
  valid: boolean;
  mobile: boolean;
}

export function normalizePatientName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

export function patientGroupingKey(input: {
  phones: readonly string[];
  selectedPhone?: string | null;
}): string {
  const requested = input.selectedPhone ? normalizeBrazilianPhone(input.selectedPhone) : null;
  const selected =
    (requested?.valid && requested.mobile ? requested : null) ??
    selectWhatsAppPhone(input.phones.map(normalizeBrazilianPhone));
  return selected ? `WHATSAPP:${selected.normalized}` : '';
}

export function normalizeBrazilianPhone(value: string): NormalizedPhone {
  const original = value;
  let digits = value.replace(/\D/g, '');

  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (!digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) {
    digits = `55${digits}`;
  }

  const national = digits.startsWith('55') ? digits.slice(2) : digits;
  const valid = digits.startsWith('55') && (national.length === 10 || national.length === 11);
  const subscriber = national.slice(2);
  const mobile = valid && subscriber.length === 9 && subscriber.startsWith('9');

  return { original, normalized: digits, valid, mobile };
}

export function selectWhatsAppPhone(phones: readonly NormalizedPhone[]): NormalizedPhone | null {
  return phones.find((phone) => phone.valid && phone.mobile) ?? null;
}
