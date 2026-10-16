/** Recusa definitiva: a mídia não será baixada/liberada. `reason` é um código técnico sem conteúdo. */
export class MediaRejection extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'MediaRejection';
  }
}

/** Falha transitória (rede, timeout, 5xx/429): pode ser tentada de novo. */
export class MediaTransientError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'MediaTransientError';
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface MetaMediaMetadata {
  url: string;
  mimeType: string | null;
  sha256: string | null;
  fileSize: number | null;
}

export async function fetchMediaMetadata(
  fetchImpl: FetchLike,
  input: { mediaId: string; token: string; version: string; timeoutMs: number },
): Promise<MetaMediaMetadata> {
  const endpoint = `https://graph.facebook.com/${encodeURIComponent(input.version)}/${encodeURIComponent(input.mediaId)}`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${input.token}` },
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch {
    throw new MediaTransientError('META_METADATA_NETWORK');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw httpFailure('META_METADATA', response.status);
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const url = typeof body?.url === 'string' ? body.url : null;
  if (!url) throw new MediaRejection('META_METADATA_INVALID');
  const rawSize = body?.file_size;
  const fileSize =
    typeof rawSize === 'number'
      ? rawSize
      : typeof rawSize === 'string' && /^\d+$/.test(rawSize)
        ? Number(rawSize)
        : null;
  return {
    url,
    mimeType: typeof body?.mime_type === 'string' ? body.mime_type : null,
    sha256: typeof body?.sha256 === 'string' ? body.sha256.toLowerCase() : null,
    fileSize,
  };
}

/**
 * Baixa o binário com Authorization, abortando assim que o total passar de `maxBytes`
 * (Content-Length declarado ou bytes efetivamente recebidos). Só aceita https.
 */
export async function downloadMedia(
  fetchImpl: FetchLike,
  input: { url: string; token: string; maxBytes: number; timeoutMs: number },
): Promise<Uint8Array> {
  let target: URL;
  try {
    target = new URL(input.url);
  } catch {
    throw new MediaRejection('DOWNLOAD_URL_INVALID');
  }
  if (target.protocol !== 'https:') throw new MediaRejection('DOWNLOAD_URL_INSECURE');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(target.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${input.token}` },
        signal: controller.signal,
      });
    } catch {
      throw new MediaTransientError(
        controller.signal.aborted ? 'DOWNLOAD_TIMEOUT' : 'DOWNLOAD_NETWORK',
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw httpFailure('DOWNLOAD', response.status);
    }
    const declaredLength = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declaredLength) && declaredLength > input.maxBytes) {
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
      throw new MediaRejection('SIZE_LIMIT');
    }
    if (!response.body) throw new MediaTransientError('DOWNLOAD_EMPTY_BODY');

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > input.maxBytes) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          throw new MediaRejection('SIZE_LIMIT');
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof MediaRejection) throw error;
      throw new MediaTransientError(
        controller.signal.aborted ? 'DOWNLOAD_TIMEOUT' : 'DOWNLOAD_NETWORK',
      );
    }
    if (total === 0) throw new MediaRejection('EMPTY_FILE');
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
  }
}

function httpFailure(prefix: string, status: number): Error {
  if (status === 429 || status >= 500) return new MediaTransientError(`${prefix}_HTTP_${status}`);
  return new MediaRejection(`${prefix}_HTTP_${status}`);
}
