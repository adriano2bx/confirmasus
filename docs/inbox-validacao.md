# Validação do inbox na VPS (integração, backfill, integridade e carga)

**Fonte oficial:** `/media/adriano/PROJETOS/projetos/interno/confirmasus` (HD USB).
**Staging de execução:** `/srv/projetos/interno/confirmasus` na VPS (cópia de teste; não editar
código lá). Acesso pelo tailnet (Tailscale/MagicDNS); nada de URL pública.
**Runbook:** [runbooks/inbox-operacao.md](runbooks/inbox-operacao.md)

> Os números de capacidade abaixo são **metas a medir**, não capacidade comprovada. Registre o
> resultado real de cada execução (data, commit, hardware, réplicas) no relatório da tarefa.

Sempre com `MESSAGING_MODE=DRY_RUN`, banco de staging (nunca produção) e dados sintéticos.

## 1. Pré-requisitos no staging

- Cópia do repositório sincronizada em `/srv/projetos/interno/confirmasus`, `pnpm install`,
  `pnpm --filter @confirma/database generate`, migrações aplicadas no banco de staging.
- API e worker em execução com:
  - `MESSAGING_MODE=DRY_RUN`
  - `META_APP_SECRET=<segredo exclusivo de staging>` (o mesmo valor vai em `TEST_META_APP_SECRET`)
  - `META_ACCEPTED_PHONE_NUMBER_IDS` contendo `TEST_PHONE_NUMBER_ID`
  - `META_WHATSAPP_PHONE_NUMBER_ID` (necessário para templates legados e para o backfill)
  - `OPS_METRICS_TOKEN` com ≥ 24 caracteres (opcional; vazio desabilita acesso por token)
- `OpsModule` registrado em `apps/api/src/app.module.ts` (coordenador).

Novas variáveis desta entrega:

| Variável                                                                                                                                                          | Onde             | Uso                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------ |
| `OPS_METRICS_TOKEN`                                                                                                                                               | API              | Bearer para `/api/ops/metrics`; vazio/curto = só ADMIN |
| `LOAD_TEST_CONFIRM=SYNTHETIC_ONLY`                                                                                                                                | scripts de teste | trava de segurança obrigatória                         |
| `E2E_TARGET_IS_DRY_RUN=yes`                                                                                                                                       | e2e do gate      | declaração explícita de alvo em DRY_RUN                |
| `TEST_API_BASE_URL`, `TEST_META_APP_SECRET`, `TEST_PHONE_NUMBER_ID`                                                                                               | scripts de teste | alvo e assinatura                                      |
| `RATE_PER_MIN`, `DURATION_S`, `BATCH_SIZE`, `CONCURRENCY`, `TIMEOUT_MS`, `INBOUND_RATIO`, `CONTEXT_RATIO`, `DUPLICATE_RATIO`, `OUT_OF_ORDER_RATIO`, `RESULT_PATH` | carga            | perfil da carga                                        |
| `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`, `E2E_TEAM_ID`, `E2E_TIMEOUT_MS`, `TEST_KNOWN_PROVIDER_MESSAGE_ID`, `TEST_KNOWN_WA_ID`                                    | e2e do gate      | login e template conhecido                             |

## 2. Testes de integração

Testes `*.integration.test.ts` se auto-pulam sem `INTEGRATION_DATABASE_URL` /
`INTEGRATION_REDIS_URL`. Na VPS, apontando para banco/Redis **descartáveis**:

```sh
cd /srv/projetos/interno/confirmasus
export INTEGRATION_DATABASE_URL=postgresql://...staging-descartavel...
export INTEGRATION_REDIS_URL=redis://...staging...
pnpm --filter @confirma/api test
pnpm --filter @confirma/worker test
pnpm --filter @confirma/domain test
```

Unitários de ops (sem serviços; também rodam localmente):
`pnpm --filter @confirma/api test` (inclui `src/ops/*.test.ts`).

## 3. Backfill: dry-run e apply em cópia

1. Crie uma **cópia** do banco (ex.: `pg_dump` de produção restaurado em `confirma_backfill_copy`
   na VPS, com autorização). Nunca rode `--apply` direto em produção sem autorização explícita.
2. Dry-run (só leitura; relatório agregado, sem PII):

   ```sh
   cd /srv/projetos/interno/confirmasus
   DATABASE_URL=postgresql://.../confirma_backfill_copy \
   META_WHATSAPP_PHONE_NUMBER_ID=<id> \
   pnpm --filter @confirma/database exec tsx scripts/backfill-inbox.ts --report=/tmp/backfill-dry.json
   ```

   Confira: `contatos_a_criar`, `conversas_historicas_a_criar`, `campaign_ref_a_criar`,
   `respostas_a_criar`, `respostas_sem_telefone`, `pares_sem_numero_emissor` (deve ser 0 com o
   número configurado), `telefones_com_multiplos_pacientes` / `..._multiplas_convocacoes`
   (ambíguos: **não** geram vínculo; o atendente escolhe manualmente).

3. Apply na cópia, medindo a duração:

   ```sh
   DATABASE_URL=postgresql://.../confirma_backfill_copy META_WHATSAPP_PHONE_NUMBER_ID=<id> \
   pnpm --filter @confirma/database exec tsx scripts/backfill-inbox.ts --apply --batch-size=500 \
     --report=/tmp/backfill-apply-1.json
   ```

   Critérios: `violacoes: []`, `tabelas_legadas_inalteradas: true`, `duracao_ms` registrada.

4. **Idempotência:** rode o mesmo `--apply` de novo. Todos os contadores de criação em
   `resultado` devem ser 0 e `totais_depois` igual ao da primeira execução.
5. Corte de respostas: por padrão é o primeiro INBOUND do worker ao vivo (ou o início da
   execução). Em produção, informe `--cutoff=<ISO do deploy do inbox>` para não duplicar
   respostas já registradas pelo worker ao vivo.

Limitação conhecida: o backfill usa o telefone normalizado de `messages.phone`. Se a Meta
reportar o `wa_id` do mesmo número em outro formato (ex.: sem o nono dígito), o contato ao vivo
será diferente do histórico. Isso não abre permissão (gate por `context.id`); apenas separa o
histórico. Avaliar na amostra do dry-run.

## 4. Verificação de integridade

```sh
DATABASE_URL=postgresql://.../confirma_backfill_copy \
pnpm --filter @confirma/database exec tsx scripts/verify-inbox-integrity.ts
```

Somente leitura. Exit `0` = sem violação, `1` = violação (lista em `violacoes`), `2` = erro.
Violações incluem: duplicatas por `waMessageId`/`campaignMessageId`, mais de uma conversa ativa
por contato+número, **HUMAN_TEXT enviada sem elegibilidade** (deve ser 0), inbound de backfill
elegível, contexto `TEMPLATE_REPLY` sem inbound elegível, órfãos. Avisos (`warning`) não mudam
o exit code (ex.: `UNKNOWN`, dead-letters, possível nota copiada para mensagem).

## 5. E2E do gate humano (HTTP)

Pré-requisito para os cenários positivos: um template de campanha **SUBMITTED em DRY_RUN** para
um wa_id sintético. Fluxo: importar planilha sintética com paciente de telefone
`55999000xxxx`, criar e agendar campanha (DRY_RUN gera `provider_message_id = dry-run-…`), e então:

```sql
SELECT provider_message_id, phone FROM messages
WHERE phone LIKE '55999000%' AND stage IN ('FIRST','SECOND','THIRD')
  AND provider_message_id IS NOT NULL
ORDER BY submitted_at DESC LIMIT 1;
```

```sh
LOAD_TEST_CONFIRM=SYNTHETIC_ONLY E2E_TARGET_IS_DRY_RUN=yes \
TEST_API_BASE_URL=http://<host-staging-tailnet>:3001/api \
TEST_META_APP_SECRET=... TEST_PHONE_NUMBER_ID=... \
E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
TEST_KNOWN_PROVIDER_MESSAGE_ID=dry-run-... TEST_KNOWN_WA_ID=55999000xxxx \
node tests/load/inbox-human-gate-e2e.mjs
```

Critério: `ok: true`. Esperado: espontâneo ⇒ 422 `HUMAN_REPLY_BLOCKED`
(`NO_ELIGIBLE_INBOUND`); `context.id` forjado ⇒ 422; outro wa*id citando o template ⇒ 422;
resposta legítima ⇒ política liberada, 202 e mensagem `SUBMITTED`; nota ⇒ 201 sem nova
mensagem. Sem `TEST_KNOWN*\*`os cenários positivos aparecem como`pulado`.
O script depende dos formatos de `/api/inbox`do contrato (§7); se a T4 mudar DTOs de equipe,
use`E2E_TEAM_ID` com uma equipe existente.

## 6. Carga sintética do webhook

```sh
LOAD_TEST_CONFIRM=SYNTHETIC_ONLY \
TEST_API_BASE_URL=http://<host-staging-tailnet>:3001/api \
TEST_META_APP_SECRET=... TEST_PHONE_NUMBER_ID=... OPS_METRICS_TOKEN=... \
RATE_PER_MIN=5000 DURATION_S=900 BATCH_SIZE=10 CONCURRENCY=50 \
RESULT_PATH=/tmp/carga-5k-15min.json \
node tests/load/inbox-webhook-load.mjs
```

Execute o gerador a partir de uma máquina do tailnet próxima da VPS (ou da própria VPS) para
não medir a sua rede doméstica. Os status sintéticos (`wamid.SYNTH.*`) não correspondem a
mensagens reais e acabam em dead-letter após `WEBHOOK_MAX_ATTEMPTS` — esperado no staging.

| Cenário (metas do plano) | Parâmetros                                            | Critério                                                                               |
| ------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Sustentado               | `RATE_PER_MIN=5000 DURATION_S=900`                    | `ack_ms.p95 <= 750`, `ack_ms.p99 <= 2000`, `taxa_erro = 0`, `taxa_alvo_atingida`       |
| Pico curto               | `RATE_PER_MIN=10000 DURATION_S=60`                    | idem; backlog drena após o pico                                                        |
| Drenagem                 | após cada cenário, ler `/api/ops/metrics` a cada 30 s | `confirma_webhook_events{status="PENDING"}` volta ao patamar inicial; `oldest_age` cai |

Registre também CPU/memória da API, worker, Postgres e Redis durante a execução. Se uma meta não
for atingida, **registre o valor medido** e o gargalo observado; não ajuste a meta silenciosamente.
