import { execFile } from 'node:child_process';

export type ScanVerdict = 'clean' | 'infected' | 'error';

export interface MediaScanner {
  scan(path: string): Promise<ScanVerdict>;
}

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; shell: false; windowsHide: true },
  callback: (error: (Error & { code?: unknown }) | null) => void,
) => unknown;

/**
 * Executa MEDIA_SCAN_COMMAND com o caminho como único argumento, via execFile (sem shell).
 * Exit 0 = limpo; exit 1 = ameaça encontrada (convenção ClamAV); qualquer outra falha = erro.
 * A saída do comando é descartada (pode conter nomes/caminhos).
 */
export function createCommandScanner(
  command: string,
  timeoutMs: number,
  run: ExecFileLike = execFile as unknown as ExecFileLike,
): MediaScanner {
  return {
    scan(path) {
      return new Promise((resolve) => {
        run(command, [path], { timeout: timeoutMs, shell: false, windowsHide: true }, (error) => {
          if (!error) resolve('clean');
          else if (error.code === 1) resolve('infected');
          else resolve('error');
        });
      });
    },
  };
}
