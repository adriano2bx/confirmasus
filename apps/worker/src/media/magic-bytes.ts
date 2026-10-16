/**
 * Detecção do MIME real por assinatura (magic bytes), sem dependência externa.
 * Retorna null quando o conteúdo não é reconhecido: o chamador deve recusar.
 * Formatos perigosos (executáveis, scripts, compactados) são reconhecidos para
 * que a recusa registre um motivo técnico preciso.
 */

/** Bytes necessários para identificar qualquer assinatura conhecida. */
export const MAGIC_BYTES_LENGTH = 16;

export function detectMimeType(bytes: Uint8Array): string | null {
  const ascii = (start: number, text: string) => {
    if (bytes.length < start + text.length) return false;
    for (let index = 0; index < text.length; index += 1) {
      if (bytes[start + index] !== text.charCodeAt(index)) return false;
    }
    return true;
  };
  const starts = (...signature: number[]) =>
    bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);

  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'audio/wav';
  if (ascii(0, '%PDF-')) return 'application/pdf';
  if (ascii(0, 'OggS')) return 'audio/ogg';
  if (ascii(4, 'ftyp')) return isoBaseMediaType(bytes);
  if (ascii(0, 'ID3')) return 'audio/mpeg';
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) {
    // Frame MPEG: camada 00 = ADTS (AAC); demais camadas = MPEG audio (MP3).
    return ((bytes[1] ?? 0) & 0x06) === 0 ? 'audio/aac' : 'audio/mpeg';
  }
  if (
    starts(0x50, 0x4b, 0x03, 0x04) ||
    starts(0x50, 0x4b, 0x05, 0x06) ||
    starts(0x50, 0x4b, 0x07, 0x08)
  ) {
    return 'application/zip';
  }
  if (starts(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07)) return 'application/vnd.rar';
  if (starts(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return 'application/x-7z-compressed';
  if (starts(0x1f, 0x8b)) return 'application/gzip';
  if (starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return 'application/x-ole-storage';
  if (ascii(0, 'MZ')) return 'application/x-msdownload';
  if (starts(0x7f, 0x45, 0x4c, 0x46)) return 'application/x-executable';
  if (
    starts(0xfe, 0xed, 0xfa, 0xce) ||
    starts(0xfe, 0xed, 0xfa, 0xcf) ||
    starts(0xce, 0xfa, 0xed, 0xfe) ||
    starts(0xcf, 0xfa, 0xed, 0xfe) ||
    starts(0xca, 0xfe, 0xba, 0xbe)
  ) {
    return 'application/x-mach-binary';
  }
  if (ascii(0, '#!')) return 'text/x-shellscript';
  return null;
}

function isoBaseMediaType(bytes: Uint8Array): string {
  const brand = String.fromCharCode(...bytes.subarray(8, 12));
  if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
  if (brand.startsWith('3g')) return 'video/3gpp';
  if (brand === 'qt  ') return 'video/quicktime';
  if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic';
  return 'video/mp4';
}

/** Remove parâmetros e normaliza caixa: "audio/ogg; codecs=opus" -> "audio/ogg". */
export function normalizeMimeType(value: string | null | undefined): string | null {
  const mime = value?.split(';')[0]?.trim().toLowerCase();
  return mime ? mime : null;
}

/**
 * Containers equivalentes: áudio MP4 pode vir com brand genérico (isom/mp42) e é
 * detectado como video/mp4. Nenhuma outra equivalência é aceita.
 */
const EQUIVALENT_MIME_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['audio/mp4', 'video/mp4']),
];

export function isMimeCompatible(declared: string, detected: string): boolean {
  if (declared === detected) return true;
  return EQUIVALENT_MIME_GROUPS.some((group) => group.has(declared) && group.has(detected));
}
