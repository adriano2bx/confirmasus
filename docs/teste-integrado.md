# Teste integrado de WhatsApp

O teste percorre importação XLSX, revisão, aprovação, criação e agendamento de campanha, envio simulado e confirmação por webhook Meta assinado. Ele cria registros fictícios no banco configurado; use um banco local descartável.

Inicie PostgreSQL e Redis e aplique as migrações:

```bash
docker compose up -d postgres redis
export DATABASE_URL='postgresql://confirma:confirma@127.0.0.1:5432/confirma_sus?schema=public'
export REDIS_URL='redis://127.0.0.1:6379'
pnpm db:generate
pnpm --filter @confirma/database exec prisma migrate deploy
pnpm build
```

Em um terminal, inicie a API com o administrador de teste e o segredo HMAC:

```bash
export JWT_SECRET='local-test-secret-long-enough-over-32-chars'
export TEST_META_APP_SECRET='local-e2e-only-secret'
export ADMIN_EMAIL='teste@confirmasus.local'
export ADMIN_PASSWORD='TesteLocal123!'
DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" JWT_SECRET="$JWT_SECRET" \
META_APP_SECRET="$TEST_META_APP_SECRET" ADMIN_EMAIL="$ADMIN_EMAIL" \
ADMIN_PASSWORD="$ADMIN_PASSWORD" NODE_ENV=test API_PORT=3101 \
pnpm --filter @confirma/api start
```

Em outro terminal, inicie o worker. Confirme que `MESSAGING_MODE` está como `DRY_RUN`:

```bash
DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" JWT_SECRET="$JWT_SECRET" \
NODE_ENV=test MESSAGING_MODE=DRY_RUN API_PORT=3101 \
SCHEDULER_INTERVAL_MS=1000 node apps/worker/dist/main.js
```

Em um terceiro terminal, execute o teste com as mesmas credenciais e o mesmo segredo da API:

```bash
TEST_E2E_CONFIRM=LOCAL_DISPOSABLE_DB_AND_DRY_RUN \
TEST_ADMIN_EMAIL="$ADMIN_EMAIL" TEST_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
TEST_META_APP_SECRET="$TEST_META_APP_SECRET" \
TEST_API_BASE_URL=http://127.0.0.1:3101/api \
pnpm --filter @confirma/api test:e2e
```

O teste cancela a campanha ao final. As importações e os dados fictícios ficam no banco para inspeção; descarte o banco local depois do teste.
