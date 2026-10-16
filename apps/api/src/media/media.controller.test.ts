import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { MediaController } from './media.controller.js';
import { MediaService, type MediaAccessDeps } from './media.service.js';

const ASSET_ID = '22222222-2222-4222-8222-222222222222';
const STORAGE_KEY = '33333333-3333-4333-8333-333333333333';

function setup(
  options: {
    status?: string;
    memberships?: Array<{ teamId: string; role: string }>;
    exists?: boolean;
  } = {},
) {
  const audits: unknown[] = [];
  const opened: string[] = [];
  const deps: MediaAccessDeps = {
    db: {
      mediaAsset: {
        findUnique: async () =>
          options.exists === false
            ? null
            : {
                id: ASSET_ID,
                status: options.status ?? 'AVAILABLE',
                storageKey: STORAGE_KEY,
                detectedMimeType: 'image/jpeg',
                conversationMessageId: 'cm-1',
                conversationMessage: {
                  conversation: { id: 'conv-1', teamId: 'team-a', assigneeId: null },
                },
              },
      },
      teamMember: { findMany: async () => options.memberships ?? [] },
      auditLog: { create: async (input: unknown) => audits.push(input) },
    } as unknown as MediaAccessDeps['db'],
    storageDir: () => '/var/lib/confirma-sus/media',
    openFile: async (path) => {
      opened.push(path);
      return { stream: Readable.from([Buffer.from([0xff, 0xd8, 0xff])]), size: 3 };
    },
  };
  const controller = new MediaController(new MediaService(deps));
  const headers = new Map<string, string>();
  const response = {
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
  } as unknown as Response;
  return { controller, audits, opened, headers, response };
}

const agent = {
  user: { sub: 'user-1', email: 'a@example.test', role: 'OPERATOR' },
} as AuthenticatedRequest;
const admin = {
  user: { sub: 'admin-1', email: 'b@example.test', role: 'ADMIN' },
} as AuthenticatedRequest;

describe('GET /api/inbox/media/:assetId', () => {
  it('nega com 404 quando o usuário não é membro da equipe da conversa', async () => {
    const { controller, audits, opened, response } = setup({
      memberships: [{ teamId: 'team-b', role: 'SUPERVISOR' }],
    });
    await assert.rejects(controller.download(ASSET_ID, agent, response), NotFoundException);
    assert.equal(audits.length, 0);
    assert.equal(opened.length, 0);
  });

  it('responde 404 igual para inexistente, id inválido e mídia não AVAILABLE', async () => {
    const missing = setup({ exists: false });
    await assert.rejects(
      missing.controller.download(ASSET_ID, admin, missing.response),
      NotFoundException,
    );
    await assert.rejects(
      missing.controller.download('../../etc/passwd', admin, missing.response),
      NotFoundException,
    );
    const quarantined = setup({ status: 'QUARANTINED' });
    await assert.rejects(
      quarantined.controller.download(ASSET_ID, admin, quarantined.response),
      NotFoundException,
    );
    assert.equal(quarantined.opened.length, 0);
  });

  it('membro da equipe recebe anexo com cabeçalhos seguros e o acesso é auditado', async () => {
    const { controller, audits, opened, headers, response } = setup({
      memberships: [{ teamId: 'team-a', role: 'AGENT' }],
    });
    const file = await controller.download(ASSET_ID, agent, response);
    const options = file.getHeaders();
    assert.equal(options.type, 'image/jpeg');
    assert.equal(options.disposition, 'attachment; filename="midia-22222222.jpg"');
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(opened, [`/var/lib/confirma-sus/media/${STORAGE_KEY}`]);
    assert.deepEqual(audits, [
      {
        data: {
          userId: 'user-1',
          eventType: 'MEDIA_ACCESSED',
          entityType: 'media_asset',
          entityId: ASSET_ID,
          metadata: { conversationId: 'conv-1', conversationMessageId: 'cm-1' },
        },
      },
    ]);
  });
});
