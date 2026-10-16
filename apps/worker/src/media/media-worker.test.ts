import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ProcessMediaJob } from '@confirma/queue';
import type { Job, Queue } from 'bullmq';
import { detectMimeType, isMimeCompatible, normalizeMimeType } from './magic-bytes.js';
import { downloadMedia, MediaRejection, type FetchLike } from './media-download.js';
import { createCommandScanner, type MediaScanner } from './media-scanner.js';
import { createFileMediaStorage, STORAGE_KEY_PATTERN, type MediaStorage } from './media-storage.js';
import { expireMedia, processMedia, sweepPendingMedia, type MediaDb } from './media-worker.js';

const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 1, 2, 3, 4,
]);
const PDF = new TextEncoder().encode('%PDF-1.7\n%fake pdf de teste\n');

function bytes(...parts: Array<string | number[]>): Uint8Array {
  return Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === 'string' ? [...part].map((char) => char.charCodeAt(0)) : part,
    ),
  );
}

describe('detecção por magic bytes', () => {
  const cases: Array<[string, Uint8Array, string | null]> = [
    ['jpeg', JPEG, 'image/jpeg'],
    ['png', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), 'image/png'],
    ['pdf', PDF, 'application/pdf'],
    ['ogg', bytes('OggS', [0, 2, 0, 0, 0, 0]), 'audio/ogg'],
    ['mp4', bytes([0, 0, 0, 0x18], 'ftypisom', [0, 0, 2, 0]), 'video/mp4'],
    ['m4a', bytes([0, 0, 0, 0x20], 'ftypM4A ', [0, 0, 0, 0]), 'audio/mp4'],
    ['webp', bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 '), 'image/webp'],
    ['mp3 id3', bytes('ID3', [4, 0, 0]), 'audio/mpeg'],
    ['zip', bytes([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]), 'application/zip'],
    ['exe', bytes('MZ', [0x90, 0, 3, 0]), 'application/x-msdownload'],
    ['elf', bytes([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), 'application/x-executable'],
    ['script', bytes('#!/bin/sh\n'), 'text/x-shellscript'],
    ['texto', bytes('hello world'), null],
    ['vazio', new Uint8Array(), null],
  ];
  for (const [name, input, expected] of cases) {
    it(`reconhece ${name}`, () => assert.equal(detectMimeType(input), expected));
  }

  it('normaliza parâmetros e aceita somente equivalência de container MP4', () => {
    assert.equal(normalizeMimeType('Audio/OGG; codecs=opus'), 'audio/ogg');
    assert.equal(isMimeCompatible('audio/mp4', 'video/mp4'), true);
    assert.equal(isMimeCompatible('image/jpeg', 'application/pdf'), false);
  });
});

describe('download com limite em streaming', () => {
  it('aborta quando os bytes recebidos passam do limite, mesmo sem Content-Length', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 100) controller.close();
        else controller.enqueue(new Uint8Array(1_024));
      },
    });
    const fetchImpl: FetchLike = async () => new Response(stream, { status: 200 });
    await assert.rejects(
      downloadMedia(fetchImpl, {
        url: 'https://cdn.example.test/m',
        token: 't',
        maxBytes: 4_096,
        timeoutMs: 5_000,
      }),
      (error: unknown) => error instanceof MediaRejection && error.reason === 'SIZE_LIMIT',
    );
    assert.ok(pulled < 100, 'leitura deve parar logo após exceder o limite');
  });

  it('recusa Content-Length acima do limite e URL sem https', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(new Uint8Array(10), { status: 200, headers: { 'content-length': '999999' } });
    await assert.rejects(
      downloadMedia(fetchImpl, {
        url: 'https://cdn.example.test/m',
        token: 't',
        maxBytes: 100,
        timeoutMs: 5_000,
      }),
      (error: unknown) => error instanceof MediaRejection && error.reason === 'SIZE_LIMIT',
    );
    await assert.rejects(
      downloadMedia(fetchImpl, {
        url: 'http://cdn.example.test/m',
        token: 't',
        maxBytes: 100,
        timeoutMs: 5_000,
      }),
      (error: unknown) =>
        error instanceof MediaRejection && error.reason === 'DOWNLOAD_URL_INSECURE',
    );
  });
});

describe('armazenamento privado', () => {
  let directory: string;
  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'confirma-media-test-'));
  });
  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('grava com nome uuid sem extensão, arquivo 0600 e diretório 0700', async () => {
    const root = join(directory, 'store');
    const storage = createFileMediaStorage(root);
    const saved = await storage.save(JPEG);
    assert.match(saved.storageKey, STORAGE_KEY_PATTERN);
    assert.equal(basename(saved.path), saved.storageKey);
    assert.equal(((await stat(saved.path)).mode & 0o777).toString(8), '600');
    assert.equal(((await stat(root)).mode & 0o777).toString(8), '700');
    assert.deepEqual(await readFile(saved.path), Buffer.from(JPEG));
    assert.throws(() => storage.pathFor('../../etc/passwd'));
    await storage.remove(saved.storageKey);
    assert.deepEqual(await readdir(root), []);
  });
});

describe('scanner por comando', () => {
  it('usa execFile sem shell com o caminho como argumento e interpreta o exit code', async () => {
    const calls: Array<{ file: string; args: readonly string[]; shell: boolean }> = [];
    const codes = [null, 1, 2];
    const scanner = createCommandScanner(
      '/usr/bin/clamdscan',
      1_000,
      (file, args, options, callback) => {
        calls.push({ file, args, shell: options.shell });
        const code = codes.shift();
        callback(
          code === null || code === undefined ? null : Object.assign(new Error('exit'), { code }),
        );
      },
    );
    assert.equal(await scanner.scan('/data/x'), 'clean');
    assert.equal(await scanner.scan('/data/x'), 'infected');
    assert.equal(await scanner.scan('/data/x'), 'error');
    assert.deepEqual(calls[0], { file: '/usr/bin/clamdscan', args: ['/data/x'], shell: false });
  });
});

// --- processMedia com dependências falsas ------------------------------------------------

interface FakeAsset {
  id: string;
  providerMediaId: string;
  declaredMimeType: string | null;
  status: string;
  attempts: number;
  conversationMessageId: string;
  storageKey: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  [key: string]: unknown;
}

function fakeDb(asset: FakeAsset) {
  const events: unknown[] = [];
  const updateMany = async ({
    where,
    data,
  }: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }) => {
    if (where.id !== asset.id) return { count: 0 };
    if (where.status !== undefined && where.status !== asset.status) return { count: 0 };
    if (where.attempts !== undefined && where.attempts !== asset.attempts) return { count: 0 };
    for (const [key, value] of Object.entries(data)) {
      if (key === 'attempts' && typeof value === 'object' && value) asset.attempts += 1;
      else asset[key] = value;
    }
    return { count: 1 };
  };
  const relation = {
    conversationMessage: { conversationId: 'conv-1', conversation: { teamId: 'team-1' } },
  };
  const mediaAsset = {
    findUnique: async () => ({ ...asset, ...relation }),
    findMany: async () => [{ ...asset, ...relation }],
    updateMany,
  };
  const db = {
    mediaAsset,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ mediaAsset, inboxEvent: { create: async (input: unknown) => events.push(input) } }),
  } as unknown as MediaDb;
  return { db, events };
}

function pendingAsset(overrides: Partial<FakeAsset> = {}): FakeAsset {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    providerMediaId: 'meta-media-1',
    declaredMimeType: 'image/jpeg',
    status: 'PENDING',
    attempts: 0,
    conversationMessageId: 'cm-1',
    storageKey: null,
    expiresAt: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

function metaFetch(content: Uint8Array, metadata: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, authorization: new Headers(init.headers).get('authorization') });
    if (url.startsWith('https://graph.facebook.com/')) {
      return Response.json({
        url: 'https://lookaside.example.test/media?mid=1',
        mime_type: 'image/jpeg',
        sha256: createHash('sha256').update(content).digest('hex'),
        file_size: content.byteLength,
        ...metadata,
      });
    }
    return new Response(content, { status: 200 });
  };
  return { fetchImpl, calls };
}

function memoryStorage() {
  const files = new Map<string, Uint8Array>();
  const storage: MediaStorage = {
    pathFor: (key) => `/private/${key}`,
    async save(content) {
      const storageKey = crypto.randomUUID();
      files.set(storageKey, content);
      return { storageKey, path: `/private/${storageKey}` };
    },
    async remove(key) {
      files.delete(key);
    },
  };
  return { storage, files };
}

const job = (id: string) => ({ data: { mediaAssetId: id } }) as Job<ProcessMediaJob>;
const LIVE = {
  MESSAGING_MODE: 'LIVE',
  META_WHATSAPP_ACCESS_TOKEN: 'test-token',
  MEDIA_STORAGE_DIR: '/private',
};
const clock = () => new Date('2026-10-16T12:00:00Z');

describe('processMedia', () => {
  it('em DRY_RUN não chama a Meta e marca REJECTED DRY_RUN com evento do inbox', async () => {
    const asset = pendingAsset();
    const { db, events } = fakeDb(asset);
    let fetched = false;
    await processMedia(job(asset.id), {
      db,
      env: {},
      clock,
      fetch: async () => {
        fetched = true;
        throw new Error('não deveria chamar');
      },
    });
    assert.equal(fetched, false);
    assert.equal(asset.status, 'REJECTED');
    assert.equal(asset.rejectReason, 'DRY_RUN');
    assert.equal(asset.attempts, 1);
    assert.deepEqual(events, [
      {
        data: {
          conversationId: 'conv-1',
          teamId: 'team-1',
          type: 'message.updated',
          entityId: 'cm-1',
        },
      },
    ]);
  });

  it('sem scanner configurado deixa a mídia válida em QUARANTINED', async () => {
    const asset = pendingAsset();
    const { db } = fakeDb(asset);
    const { fetchImpl, calls } = metaFetch(JPEG);
    const { storage, files } = memoryStorage();
    await processMedia(job(asset.id), { db, env: LIVE, clock, fetch: fetchImpl, storage });
    assert.equal(asset.status, 'QUARANTINED');
    assert.equal(asset.rejectReason, 'SCANNER_NOT_CONFIGURED');
    assert.equal(asset.detectedMimeType, 'image/jpeg');
    assert.equal(files.size, 1);
    assert.ok(calls.every((call) => call.authorization === 'Bearer test-token'));
    assert.equal(calls[0]?.url, 'https://graph.facebook.com/v22.0/meta-media-1');
    assert.deepEqual(asset.expiresAt, new Date('2026-11-15T12:00:00Z'));
  });

  it('com scanner limpo marca AVAILABLE e grava hash, tamanho e storageKey uuid', async () => {
    const asset = pendingAsset();
    const { db } = fakeDb(asset);
    const { fetchImpl } = metaFetch(JPEG);
    const { storage } = memoryStorage();
    const scanned: string[] = [];
    const scanner: MediaScanner = { scan: async (path) => (scanned.push(path), 'clean') };
    await processMedia(job(asset.id), {
      db,
      env: { ...LIVE, MEDIA_SCAN_MODE: 'command' },
      clock,
      fetch: fetchImpl,
      storage,
      scanner,
    });
    assert.equal(asset.status, 'AVAILABLE');
    assert.equal(asset.rejectReason, null);
    assert.equal(asset.sizeBytes, JPEG.byteLength);
    assert.equal(asset.sha256, createHash('sha256').update(JPEG).digest('hex'));
    assert.match(String(asset.storageKey), STORAGE_KEY_PATTERN);
    assert.deepEqual(scanned, [`/private/${String(asset.storageKey)}`]);
  });

  it('recusa conteúdo PDF declarado como image/jpeg e não grava arquivo', async () => {
    const asset = pendingAsset();
    const { db } = fakeDb(asset);
    const { fetchImpl } = metaFetch(PDF);
    const { storage, files } = memoryStorage();
    await processMedia(job(asset.id), {
      db,
      env: { ...LIVE, MEDIA_SCAN_MODE: 'disabled' },
      clock,
      fetch: fetchImpl,
      storage,
    });
    assert.equal(asset.status, 'REJECTED');
    assert.equal(asset.rejectReason, 'MIME_MISMATCH');
    assert.equal(asset.storageKey, null);
    assert.equal(files.size, 0);
  });

  it('recusa executável disfarçado e tipo fora da allowlist', async () => {
    const exe = bytes('MZ', [0x90, 0, 3, 0, 0, 0, 4, 0]);
    const disguised = pendingAsset();
    const first = fakeDb(disguised);
    await processMedia(job(disguised.id), {
      db: first.db,
      env: { ...LIVE, MEDIA_SCAN_MODE: 'disabled' },
      clock,
      fetch: metaFetch(exe).fetchImpl,
      storage: memoryStorage().storage,
    });
    assert.equal(disguised.rejectReason, 'MIME_MISMATCH');

    const zip = pendingAsset({ declaredMimeType: 'application/zip' });
    const second = fakeDb(zip);
    const { fetchImpl, calls } = metaFetch(JPEG, { mime_type: 'application/zip' });
    await processMedia(job(zip.id), {
      db: second.db,
      env: LIVE,
      clock,
      fetch: fetchImpl,
      storage: memoryStorage().storage,
    });
    assert.equal(zip.rejectReason, 'MIME_NOT_ALLOWED');
    assert.equal(calls.length, 1, 'não baixa binário fora da allowlist');
  });

  it('recusa por file_size declarado pela Meta sem baixar', async () => {
    const asset = pendingAsset();
    const { db } = fakeDb(asset);
    const { fetchImpl, calls } = metaFetch(JPEG, { file_size: 17 * 1024 * 1024 });
    await processMedia(job(asset.id), {
      db,
      env: LIVE,
      clock,
      fetch: fetchImpl,
      storage: memoryStorage().storage,
    });
    assert.equal(asset.rejectReason, 'SIZE_LIMIT');
    assert.equal(calls.length, 1);
  });

  it('recusa sha256 divergente', async () => {
    const asset = pendingAsset();
    const { db } = fakeDb(asset);
    const { fetchImpl } = metaFetch(JPEG, { sha256: 'a'.repeat(64) });
    await processMedia(job(asset.id), {
      db,
      env: LIVE,
      clock,
      fetch: fetchImpl,
      storage: memoryStorage().storage,
    });
    assert.equal(asset.rejectReason, 'SHA256_MISMATCH');
  });

  it('scanner com ameaça apaga o arquivo e marca REJECTED', async () => {
    const asset = pendingAsset();
    const { db } = fakeDb(asset);
    const { storage, files } = memoryStorage();
    await processMedia(job(asset.id), {
      db,
      env: { ...LIVE, MEDIA_SCAN_MODE: 'command' },
      clock,
      fetch: metaFetch(JPEG).fetchImpl,
      storage,
      scanner: { scan: async () => 'infected' },
    });
    assert.equal(asset.status, 'REJECTED');
    assert.equal(asset.rejectReason, 'SCAN_INFECTED');
    assert.equal(asset.storageKey, null);
    assert.equal(files.size, 0);
  });

  it('falha transitória mantém PENDING e relança; na última tentativa marca REJECTED', async () => {
    const asset = pendingAsset();
    const { db } = fakeDb(asset);
    const failing: FetchLike = async () => new Response('', { status: 503 });
    await assert.rejects(
      processMedia(job(asset.id), {
        db,
        env: { ...LIVE, MEDIA_MAX_ATTEMPTS: '2' },
        clock,
        fetch: failing,
      }),
    );
    assert.equal(asset.status, 'PENDING');
    assert.equal(asset.attempts, 1);
    await processMedia(job(asset.id), {
      db,
      env: { ...LIVE, MEDIA_MAX_ATTEMPTS: '2' },
      clock,
      fetch: failing,
    });
    assert.equal(asset.status, 'REJECTED');
    assert.equal(asset.rejectReason, 'META_METADATA_HTTP_503');
  });

  it('ignora asset que não está PENDING', async () => {
    const asset = pendingAsset({ status: 'AVAILABLE' });
    const { db, events } = fakeDb(asset);
    await processMedia(job(asset.id), {
      db,
      env: LIVE,
      clock,
      fetch: async () => assert.fail('sem fetch'),
    });
    assert.equal(asset.attempts, 0);
    assert.equal(events.length, 0);
  });
});

describe('outbox e retenção', () => {
  it('sweepPendingMedia publica com jobId determinístico', async () => {
    const asset = pendingAsset();
    const { db } = fakeDb(asset);
    const added: Array<{ data: unknown; jobId: unknown }> = [];
    const queue = {
      add: async (_name: string, data: unknown, options: { jobId?: string }) =>
        added.push({ data, jobId: options.jobId }),
    } as unknown as Queue<ProcessMediaJob>;
    assert.equal(await sweepPendingMedia(queue, { db, env: {}, clock }), 1);
    assert.deepEqual(added, [{ data: { mediaAssetId: asset.id }, jobId: `media:${asset.id}` }]);
  });

  it('expireMedia apaga o arquivo e marca EXPIRED', async () => {
    const { storage, files } = memoryStorage();
    const saved = await storage.save(JPEG);
    const asset = pendingAsset({
      status: 'AVAILABLE',
      storageKey: saved.storageKey,
      expiresAt: new Date('2026-10-01'),
    });
    const { db, events } = fakeDb(asset);
    assert.equal(await expireMedia(new Date('2026-10-16'), { db, storage, env: {} }), 1);
    assert.equal(asset.status, 'EXPIRED');
    assert.equal(asset.storageKey, null);
    assert.equal(files.size, 0);
    assert.equal(events.length, 1);
  });
});
