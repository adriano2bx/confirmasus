import { isAbsolute } from 'node:path';

export const DEFAULT_MEDIA_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MEDIA_RETENTION_DAYS = 30;
export const DEFAULT_MEDIA_ALLOWED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'video/mp4',
] as const;

export type MediaScanMode = 'disabled' | 'command' | 'unset';

export interface MediaConfig {
  live: boolean;
  storageDir: string | null;
  maxBytes: number;
  allowedMime: ReadonlySet<string>;
  retentionDays: number;
  scanMode: MediaScanMode;
  scanCommand: string | null;
  scanTimeoutMs: number;
  downloadTimeoutMs: number;
  maxAttempts: number;
  graphApiVersion: string;
  accessToken: string | null;
}

export class MediaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaConfigError';
  }
}

export function readMediaConfig(env: NodeJS.ProcessEnv = process.env): MediaConfig {
  const allowed = env.MEDIA_ALLOWED_MIME?.trim()
    ? env.MEDIA_ALLOWED_MIME.split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    : [...DEFAULT_MEDIA_ALLOWED_MIME];
  const scanMode = env.MEDIA_SCAN_MODE?.trim().toLowerCase();
  const storageDir = env.MEDIA_STORAGE_DIR?.trim() || null;
  if (storageDir && !isAbsolute(storageDir)) {
    throw new MediaConfigError('MEDIA_STORAGE_DIR deve ser um caminho absoluto fora do webroot.');
  }
  return {
    // Qualquer valor diferente de LIVE é tratado como DRY_RUN (falha fechada).
    live: env.MESSAGING_MODE === 'LIVE',
    storageDir,
    maxBytes: positiveInt(env, 'MEDIA_MAX_BYTES', DEFAULT_MEDIA_MAX_BYTES),
    allowedMime: new Set(allowed),
    retentionDays: positiveInt(env, 'MEDIA_RETENTION_DAYS', DEFAULT_MEDIA_RETENTION_DAYS),
    // Sem valor explícito "disabled" o scanner é considerado não configurado => quarentena.
    scanMode: scanMode === 'disabled' || scanMode === 'command' ? scanMode : 'unset',
    scanCommand: env.MEDIA_SCAN_COMMAND?.trim() || null,
    scanTimeoutMs: positiveInt(env, 'MEDIA_SCAN_TIMEOUT_MS', 60_000),
    downloadTimeoutMs: positiveInt(env, 'MEDIA_DOWNLOAD_TIMEOUT_MS', 30_000),
    maxAttempts: positiveInt(env, 'MEDIA_MAX_ATTEMPTS', 5),
    graphApiVersion: env.META_GRAPH_API_VERSION?.trim() || 'v22.0',
    accessToken: env.META_WHATSAPP_ACCESS_TOKEN?.trim() || null,
  };
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MediaConfigError(`${name} deve ser um inteiro positivo.`);
  }
  return value;
}
