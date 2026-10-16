#!/usr/bin/env bash
# Executado NA VPS, dentro do staging. Uso: bash scripts/vps-test/run.sh <etapa>
# Etapas: up | install | migrate | unit | integration | api-up | worker-up | e2e | down
set -euo pipefail
cd "$(dirname "$0")"
DC="docker compose -f compose.test.yml"
EXEC="$DC exec -T runner bash -lc"
case "${1:-}" in
  up) $DC up -d postgres redis runner ;;
  install) $EXEC 'corepack enable && pnpm config set store-dir /pnpm-store && pnpm install --frozen-lockfile && pnpm db:generate && pnpm -r --filter "./packages/*" build' ;;
  migrate) $EXEC 'pnpm --filter @confirma/database exec prisma migrate deploy' ;;
  unit) $EXEC 'pnpm -r typecheck && pnpm --filter @confirma/domain test && pnpm --filter @confirma/worker test && pnpm --filter @confirma/api test && pnpm --filter @confirma/web test' ;;
  integration) $EXEC 'pnpm --filter @confirma/worker build && pnpm --filter @confirma/api build && node --test --test-concurrency=1 "apps/worker/dist/**/*.integration.test.js" "apps/api/dist/**/*.integration.test.js"' ;;
  down) $DC down -v ;;
  *) echo "etapa desconhecida: ${1:-}" >&2; exit 2 ;;
esac
