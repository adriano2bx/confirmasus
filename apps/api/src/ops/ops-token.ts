import { createHash, timingSafeEqual } from 'node:crypto';

/** Token mínimo aceito; abaixo disso o acesso por token fica desabilitado. */
export const OPS_METRICS_TOKEN_MIN_LENGTH = 24;

export function configuredOpsToken(value = process.env.OPS_METRICS_TOKEN): string | null {
  const token = value?.trim() ?? '';
  return token.length >= OPS_METRICS_TOKEN_MIN_LENGTH ? token : null;
}

/** Extrai o token de `Authorization: Bearer <token>`. */
export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value ?? '');
  return match?.[1] ?? null;
}

/**
 * Comparação em tempo constante (resumos SHA-256 de mesmo tamanho, sem vazar o comprimento).
 * Token configurado vazio/curto = acesso por token desabilitado.
 */
export function isValidOpsToken(
  header: string | string[] | undefined,
  configured: string | null = configuredOpsToken(),
): boolean {
  if (!configured) return false;
  const presented = bearerToken(header);
  if (!presented) return false;
  const expected = createHash('sha256').update(configured).digest();
  const actual = createHash('sha256').update(presented).digest();
  return timingSafeEqual(expected, actual);
}
