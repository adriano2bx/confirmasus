import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** storageKey é sempre um UUID gerado aqui; nunca deriva de filename/MIME do cliente. */
export const STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface MediaStorage {
  save(bytes: Uint8Array): Promise<{ storageKey: string; path: string }>;
  remove(storageKey: string): Promise<void>;
  pathFor(storageKey: string): string;
}

/** Armazenamento em disco privado: diretório 0700, arquivos 0600, nomes aleatórios sem extensão. */
export function createFileMediaStorage(directory: string): MediaStorage {
  let prepared: Promise<void> | null = null;
  const prepare = () => {
    prepared ??= (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    })().catch((error: unknown) => {
      prepared = null;
      throw error;
    });
    return prepared;
  };

  const pathFor = (storageKey: string) => {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) throw new Error('storageKey inválido');
    return join(directory, storageKey);
  };

  return {
    pathFor,
    async save(bytes) {
      await prepare();
      const storageKey = randomUUID();
      const path = pathFor(storageKey);
      // "wx": falha se existir; nunca sobrescreve outro arquivo.
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.chmod(0o600);
      } catch (error) {
        await handle.close();
        await rm(path, { force: true });
        throw error;
      }
      await handle.close();
      return { storageKey, path };
    },
    async remove(storageKey) {
      await rm(pathFor(storageKey), { force: true });
    },
  };
}
