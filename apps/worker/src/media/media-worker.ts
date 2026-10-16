import { createHash } from 'node:crypto';
import { appendInboxEvent, prisma, type PrismaClient } from '@confirma/database';
import { mediaJobId, type ProcessMediaJob } from '@confirma/queue';
import type { Job, Queue } from 'bullmq';
import {
  detectMimeType,
  isMimeCompatible,
  MAGIC_BYTES_LENGTH,
  normalizeMimeType,
} from './magic-bytes.js';
import { readMediaConfig, type MediaConfig } from './media-config.js';
import {
  downloadMedia,
  fetchMediaMetadata,
  MediaRejection,
  MediaTransientError,
  type FetchLike,
} from './media-download.js';
import { createCommandScanner, type MediaScanner } from './media-scanner.js';
import { createFileMediaStorage, type MediaStorage } from './media-storage.js';

/**
 * Mídia privada recebida (ADR-27). Fluxo por MediaAsset PENDING:
 * claim (updateMany condicional + attempts) -> DRY_RUN? recusa sem chamar a Meta ->
 * metadados Graph -> limites/allowlist -> download com limite em streaming -> magic bytes ->
 * sha256 -> armazenamento privado (uuid, 0600) -> varredura -> AVAILABLE/QUARANTINED/REJECTED.
 * Logs só com IDs e códigos técnicos; nunca conteúdo, URL assinada ou filename.
 */

export type MediaDb = Pick<PrismaClient, 'mediaAsset' | '$transaction'>;

export interface MediaDeps {
  db?: MediaDb;
  fetch?: FetchLike;
  storage?: MediaStorage;
  scanner?: MediaScanner;
  clock?: () => Date;
  env?: NodeJS.ProcessEnv;
}

type FinalStatus = 'AVAILABLE' | 'QUARANTINED' | 'REJECTED';

interface Outcome {
  status: FinalStatus;
  rejectReason: string | null;
  detectedMimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  storageKey?: string;
}

interface ClaimedAsset {
  id: string;
  providerMediaId: string;
  declaredMimeType: string | null;
  conversationMessageId: string;
  conversationId: string;
  teamId: string | null;
}

const storageCache = new Map<string, MediaStorage>();

function storageFor(config: MediaConfig, deps: MediaDeps): MediaStorage | null {
  if (deps.storage) return deps.storage;
  if (!config.storageDir) return null;
  let storage = storageCache.get(config.storageDir);
  if (!storage) {
    storage = createFileMediaStorage(config.storageDir);
    storageCache.set(config.storageDir, storage);
  }
  return storage;
}

export async function processMedia(job: Job<ProcessMediaJob>, deps: MediaDeps = {}): Promise<void> {
  const db = deps.db ?? prisma;
  const clock = deps.clock ?? (() => new Date());
  const config = readMediaConfig(deps.env ?? process.env);

  const row = await db.mediaAsset.findUnique({
    where: { id: job.data.mediaAssetId },
    select: {
      id: true,
      providerMediaId: true,
      declaredMimeType: true,
      status: true,
      attempts: true,
      conversationMessageId: true,
      conversationMessage: {
        select: { conversationId: true, conversation: { select: { teamId: true } } },
      },
    },
  });
  if (!row || row.status !== 'PENDING') return;
  const asset: ClaimedAsset = {
    id: row.id,
    providerMediaId: row.providerMediaId,
    declaredMimeType: row.declaredMimeType,
    conversationMessageId: row.conversationMessageId,
    conversationId: row.conversationMessage.conversationId,
    teamId: row.conversationMessage.conversation.teamId,
  };

  if (row.attempts >= config.maxAttempts) {
    await finalize(
      db,
      asset,
      { status: 'REJECTED', rejectReason: 'MAX_ATTEMPTS' },
      config,
      clock(),
      null,
    );
    return;
  }
  const claimed = await db.mediaAsset.updateMany({
    where: { id: asset.id, status: 'PENDING', attempts: row.attempts },
    data: { attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return;
  const attempt = row.attempts + 1;

  if (!config.live) {
    // DRY_RUN (ou modo inválido): nunca chama a Meta nem grava arquivo.
    await finalize(
      db,
      asset,
      { status: 'REJECTED', rejectReason: 'DRY_RUN' },
      config,
      clock(),
      null,
    );
    return;
  }

  const storage = storageFor(config, deps);
  let savedKey: string | null = null;
  try {
    if (!config.accessToken || !storage) throw new MediaTransientError('CONFIG_MISSING');
    const outcome = await acquire(asset, config, storage, deps, (key) => {
      savedKey = key;
    });
    await finalize(db, asset, outcome, config, clock(), storage);
    if (outcome.status !== 'AVAILABLE') {
      console.warn(`Mídia ${asset.id} ${outcome.status}: ${outcome.rejectReason ?? '-'}`);
    }
  } catch (error) {
    if (savedKey && storage) await storage.remove(savedKey).catch(() => undefined);
    if (error instanceof MediaRejection) {
      await finalize(
        db,
        asset,
        { status: 'REJECTED', rejectReason: error.reason },
        config,
        clock(),
        null,
      );
      console.warn(`Mídia ${asset.id} REJECTED: ${error.reason}`);
      return;
    }
    const reason = error instanceof MediaTransientError ? error.reason : 'INTERNAL_ERROR';
    if (attempt >= config.maxAttempts) {
      await finalize(
        db,
        asset,
        { status: 'REJECTED', rejectReason: reason },
        config,
        clock(),
        null,
      );
      console.warn(`Mídia ${asset.id} REJECTED após ${attempt} tentativas: ${reason}`);
      return;
    }
    console.warn(`Mídia ${asset.id} falhou na tentativa ${attempt}: ${reason}`);
    throw new Error(`Falha transitória ao processar mídia: ${reason}`);
  }
}

async function acquire(
  asset: ClaimedAsset,
  config: MediaConfig,
  storage: MediaStorage,
  deps: MediaDeps,
  onSaved: (storageKey: string) => void,
): Promise<Outcome> {
  const fetchImpl = deps.fetch ?? fetch;
  const token = config.accessToken ?? '';
  const metadata = await fetchMediaMetadata(fetchImpl, {
    mediaId: asset.providerMediaId,
    token,
    version: config.graphApiVersion,
    timeoutMs: config.downloadTimeoutMs,
  });

  const providerMime = normalizeMimeType(metadata.mimeType);
  const declared = normalizeMimeType(asset.declaredMimeType) ?? providerMime;
  if (!declared) throw new MediaRejection('MIME_UNDECLARED');
  if (providerMime && !isMimeCompatible(declared, providerMime))
    throw new MediaRejection('MIME_MISMATCH_PROVIDER');
  if (!config.allowedMime.has(declared)) throw new MediaRejection('MIME_NOT_ALLOWED');
  if (metadata.fileSize !== null && metadata.fileSize > config.maxBytes)
    throw new MediaRejection('SIZE_LIMIT');

  const bytes = await downloadMedia(fetchImpl, {
    url: metadata.url,
    token,
    maxBytes: config.maxBytes,
    timeoutMs: config.downloadTimeoutMs,
  });

  const detected = detectMimeType(bytes.subarray(0, MAGIC_BYTES_LENGTH));
  if (!detected) throw new MediaRejection('MIME_UNDETECTED');
  if (!isMimeCompatible(declared, detected)) throw new MediaRejection('MIME_MISMATCH');
  if (!config.allowedMime.has(detected)) throw new MediaRejection('MIME_NOT_ALLOWED');

  const digest = createHash('sha256').update(bytes).digest();
  const sha256 = digest.toString('hex');
  // A Meta documenta sha256 do arquivo; aceita hex ou base64 para não depender da codificação.
  if (
    metadata.sha256 &&
    metadata.sha256 !== sha256 &&
    metadata.sha256 !== digest.toString('base64').toLowerCase()
  ) {
    throw new MediaRejection('SHA256_MISMATCH');
  }

  const saved = await storage.save(bytes);
  onSaved(saved.storageKey);
  const base = {
    detectedMimeType: detected,
    sizeBytes: bytes.byteLength,
    sha256,
    storageKey: saved.storageKey,
  };

  if (config.scanMode === 'disabled') return { status: 'AVAILABLE', rejectReason: null, ...base };
  const scanner =
    config.scanMode === 'command'
      ? (deps.scanner ??
        (config.scanCommand
          ? createCommandScanner(config.scanCommand, config.scanTimeoutMs)
          : null))
      : null;
  if (!scanner) return { status: 'QUARANTINED', rejectReason: 'SCANNER_NOT_CONFIGURED', ...base };

  const verdict = await scanner.scan(saved.path);
  if (verdict === 'clean') return { status: 'AVAILABLE', rejectReason: null, ...base };
  if (verdict === 'infected') {
    await storage.remove(saved.storageKey);
    const { storageKey: _removed, ...rest } = base;
    return { status: 'REJECTED', rejectReason: 'SCAN_INFECTED', ...rest };
  }
  return { status: 'QUARANTINED', rejectReason: 'SCAN_ERROR', ...base };
}

/** Grava o estado final somente se o asset ainda estiver PENDING, com evento do inbox na mesma transação. */
async function finalize(
  db: MediaDb,
  asset: ClaimedAsset,
  outcome: Outcome,
  config: MediaConfig,
  now: Date,
  storage: MediaStorage | null,
): Promise<void> {
  const expiresAt = new Date(now.getTime() + config.retentionDays * 24 * 60 * 60 * 1_000);
  const applied = await db.$transaction(async (tx) => {
    const result = await tx.mediaAsset.updateMany({
      where: { id: asset.id, status: 'PENDING' },
      data: {
        status: outcome.status,
        rejectReason: outcome.rejectReason,
        detectedMimeType: outcome.detectedMimeType ?? null,
        sizeBytes: outcome.sizeBytes ?? null,
        sha256: outcome.sha256 ?? null,
        storageKey: outcome.storageKey ?? null,
        expiresAt,
      },
    });
    if (result.count === 0) return false;
    await appendInboxEvent(tx, {
      conversationId: asset.conversationId,
      teamId: asset.teamId,
      type: 'message.updated',
      entityId: asset.conversationMessageId,
    });
    return true;
  });
  // Outro processo finalizou antes: o arquivo desta tentativa fica órfão e é removido.
  if (!applied && outcome.storageKey && storage)
    await storage.remove(outcome.storageKey).catch(() => undefined);
}

export interface SweepPendingMediaOptions {
  /** Idade mínima do PENDING para republicar (padrão 60 s). */
  olderThanMs?: number;
  limit?: number;
  db?: MediaDb;
  clock?: () => Date;
  env?: NodeJS.ProcessEnv;
}

/** Outbox: republica PENDING antigos (job perdido/Redis fora). jobId determinístico evita duplicata. */
export async function sweepPendingMedia(
  queue: Queue<ProcessMediaJob>,
  options: SweepPendingMediaOptions = {},
): Promise<number> {
  const db = options.db ?? prisma;
  const now = (options.clock ?? (() => new Date()))();
  const config = readMediaConfig(options.env ?? process.env);
  const pending = await db.mediaAsset.findMany({
    where: {
      status: 'PENDING',
      attempts: { lt: config.maxAttempts },
      createdAt: { lte: new Date(now.getTime() - (options.olderThanMs ?? 60_000)) },
    },
    orderBy: { createdAt: 'asc' },
    take: options.limit ?? 200,
    select: { id: true },
  });
  for (const asset of pending) {
    await queue.add(
      'process-media',
      { mediaAssetId: asset.id },
      {
        jobId: mediaJobId(asset.id),
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }
  return pending.length;
}

export interface ExpireMediaDeps {
  db?: MediaDb;
  storage?: MediaStorage;
  env?: NodeJS.ProcessEnv;
  limit?: number;
}

/**
 * Retenção: apaga o arquivo e marca EXPIRED quando `expiresAt` venceu ou, sem `expiresAt`,
 * após MEDIA_RETENTION_DAYS desde a criação. O arquivo é apagado antes do registro
 * (preferimos metadado órfão a arquivo de saúde retido além do prazo).
 */
export async function expireMedia(
  now: Date = new Date(),
  deps: ExpireMediaDeps = {},
): Promise<number> {
  const db = deps.db ?? prisma;
  const config = readMediaConfig(deps.env ?? process.env);
  const storage = storageFor(config, deps);
  const cutoff = new Date(now.getTime() - config.retentionDays * 24 * 60 * 60 * 1_000);
  const due = await db.mediaAsset.findMany({
    where: {
      status: { in: ['PENDING', 'AVAILABLE', 'QUARANTINED', 'REJECTED'] },
      OR: [{ expiresAt: { lte: now } }, { expiresAt: null, createdAt: { lte: cutoff } }],
    },
    orderBy: { createdAt: 'asc' },
    take: deps.limit ?? 200,
    select: {
      id: true,
      status: true,
      storageKey: true,
      conversationMessageId: true,
      conversationMessage: {
        select: { conversationId: true, conversation: { select: { teamId: true } } },
      },
    },
  });

  let expired = 0;
  for (const asset of due) {
    if (asset.storageKey) {
      if (!storage) {
        console.warn(`Mídia ${asset.id} não expirada: MEDIA_STORAGE_DIR ausente`);
        continue;
      }
      try {
        await storage.remove(asset.storageKey);
      } catch {
        console.warn(`Mídia ${asset.id} não expirada: falha ao remover arquivo`);
        continue;
      }
    }
    const applied = await db.$transaction(async (tx) => {
      const result = await tx.mediaAsset.updateMany({
        where: { id: asset.id, status: asset.status },
        data: { status: 'EXPIRED', storageKey: null },
      });
      if (result.count === 0) return false;
      await appendInboxEvent(tx, {
        conversationId: asset.conversationMessage.conversationId,
        teamId: asset.conversationMessage.conversation.teamId,
        type: 'message.updated',
        entityId: asset.conversationMessageId,
      });
      return true;
    });
    if (applied) expired += 1;
  }
  return expired;
}
