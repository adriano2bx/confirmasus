import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { prisma, type PrismaClient } from '@confirma/database';
import { canPerform, type InboxActor, type TeamRole } from '@confirma/domain';

export const MEDIA_ACCESS_DEPS = Symbol('MEDIA_ACCESS_DEPS');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mesmo formato gerado pelo worker (apps/worker/src/media/media-storage.ts). */
const STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
};

export interface MediaAccessDeps {
  db: Pick<PrismaClient, 'mediaAsset' | 'teamMember' | 'auditLog'>;
  storageDir: () => string | null;
  openFile: (path: string) => Promise<{ stream: Readable; size: number }>;
}

export interface MediaRequester {
  sub: string;
  role: 'ADMIN' | 'OPERATOR';
}

export interface MediaDownload {
  stream: Readable;
  size: number;
  mimeType: string;
  filename: string;
}

const defaultDeps: MediaAccessDeps = {
  db: prisma,
  storageDir: () => process.env.MEDIA_STORAGE_DIR?.trim() || null,
  async openFile(path) {
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      return { stream: handle.createReadStream(), size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  },
};

/**
 * Acesso autorizado à mídia privada (ADR-27). Inexistente, sem permissão, não AVAILABLE ou
 * arquivo ausente respondem igualmente 404 para não revelar existência.
 */
@Injectable()
export class MediaService {
  private readonly deps: MediaAccessDeps;

  constructor(@Optional() @Inject(MEDIA_ACCESS_DEPS) deps?: Partial<MediaAccessDeps>) {
    this.deps = { ...defaultDeps, ...deps };
  }

  async open(user: MediaRequester, assetId: string): Promise<MediaDownload> {
    const notFound = () => new NotFoundException('Mídia não encontrada');
    if (!UUID_PATTERN.test(assetId)) throw notFound();

    const { db } = this.deps;
    const [asset, memberships] = await Promise.all([
      db.mediaAsset.findUnique({
        where: { id: assetId },
        select: {
          id: true,
          status: true,
          storageKey: true,
          detectedMimeType: true,
          conversationMessageId: true,
          conversationMessage: {
            select: { conversation: { select: { id: true, teamId: true, assigneeId: true } } },
          },
        },
      }),
      db.teamMember.findMany({ where: { userId: user.sub }, select: { teamId: true, role: true } }),
    ]);
    if (!asset) throw notFound();

    const actor: InboxActor = {
      userId: user.sub,
      globalRole: user.role,
      teams: new Map(memberships.map((member) => [member.teamId, member.role as TeamRole])),
    };
    const conversation = asset.conversationMessage.conversation;
    if (!canPerform(actor, 'view', conversation)) throw notFound();
    if (asset.status !== 'AVAILABLE' || !asset.storageKey || !asset.detectedMimeType)
      throw notFound();
    if (!STORAGE_KEY_PATTERN.test(asset.storageKey)) throw notFound();

    const directory = this.deps.storageDir();
    if (!directory || !isAbsolute(directory)) {
      console.warn(`Mídia ${asset.id} indisponível: MEDIA_STORAGE_DIR ausente ou inválido`);
      throw notFound();
    }

    let file: { stream: Readable; size: number };
    try {
      file = await this.deps.openFile(join(directory, asset.storageKey));
    } catch {
      console.warn(`Mídia ${asset.id} indisponível: arquivo ausente`);
      throw notFound();
    }

    try {
      await db.auditLog.create({
        data: {
          userId: user.sub,
          eventType: 'MEDIA_ACCESSED',
          entityType: 'media_asset',
          entityId: asset.id,
          metadata: {
            conversationId: conversation.id,
            conversationMessageId: asset.conversationMessageId,
          },
        },
      });
    } catch (error) {
      // Sem trilha de auditoria não há entrega.
      file.stream.destroy();
      throw error;
    }

    const extension = EXTENSIONS[asset.detectedMimeType] ?? 'bin';
    return {
      stream: file.stream,
      size: file.size,
      mimeType: asset.detectedMimeType,
      filename: `midia-${asset.id.slice(0, 8)}.${extension}`,
    };
  }
}
