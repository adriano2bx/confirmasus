/**
 * Verificação de integridade do inbox — SOMENTE LEITURA.
 *
 * Uso (na VPS, contra a cópia de staging ou produção com autorização):
 *   pnpm --filter @confirma/database exec tsx scripts/verify-inbox-integrity.ts
 *
 * Imprime JSON com contagens (sem conteúdo, telefone ou nome). Exit code:
 *   0 = nenhuma violação; 1 = há violação; 2 = erro de execução.
 */
import { PrismaClient } from '@prisma/client';
import { minimizeError, runIntegrityChecks, tableTotals } from './inbox-integrity.js';

const client = new PrismaClient();
const startedAt = Date.now();

try {
  const checks = await runIntegrityChecks(client);
  const violations = checks.filter((check) => check.severity === 'violation' && check.count > 0);
  console.log(
    JSON.stringify(
      {
        evento: 'verificacao_integridade_inbox',
        ok: violations.length === 0,
        violacoes: violations.map((check) => check.name),
        totais: await tableTotals(client),
        verificacoes: checks,
        duracao_ms: Date.now() - startedAt,
      },
      null,
      2,
    ),
  );
  process.exitCode = violations.length === 0 ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ evento: 'erro', erro: minimizeError(error) }));
  process.exitCode = 2;
} finally {
  await client.$disconnect();
}
