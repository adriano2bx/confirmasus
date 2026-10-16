# Runbook — operação do atendimento humano (inbox WhatsApp)

**Escopo:** API (`/api/inbox`, `/api/webhooks/meta`, `/api/ops`), worker (outbox de webhook,
sender humano, mídia) e scripts de backfill/integridade.
**Contrato:** [whatsapp-human-inbox-contract.md](../planning/whatsapp-human-inbox-contract.md) ·
**Validação:** [inbox-validacao.md](../inbox-validacao.md)

> Regra de produto (não muda em incidente): o atendente **nunca inicia conversa** e só responde
> dentro de 24h (−5 min) após inbound **correlacionado a template de campanha** (`context.id`).
> Nenhum procedimento abaixo autoriza enviar template humano, reenviar "às cegas" ou abrir
> janela manualmente (editar `last_eligible_inbound_at` é proibido).
>
> Dados de saúde: em tickets, chats e logs use apenas IDs técnicos (conversation id, protocolo
> `ATD-…`, message_event id). Nunca copie texto de mensagem, telefone completo ou nome.

## 0. Sinais e onde olhar

`GET /api/ops/metrics` (Prometheus; ADMIN ou `Authorization: Bearer $OPS_METRICS_TOKEN`):

| Métrica                                                                               | Significado                                                          | Alerta sugerido (ajustar após medição) |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------- |
| `confirma_db_up`, `confirma_redis_up`                                                 | dependência acessível na coleta                                      | `== 0` por 2 min                       |
| `confirma_webhook_events{status}`                                                     | outbox do webhook (`PENDING`, `PROCESSING`, `FAILED`, `DEAD_LETTER`) | `PENDING` crescendo 10 min             |
| `confirma_webhook_oldest_age_seconds{status}`                                         | idade do evento mais antigo não processado                           | `PENDING` > 300 s                      |
| `confirma_webhook_dead_letters`                                                       | eventos que esgotaram `WEBHOOK_MAX_ATTEMPTS`                         | `> 0` (analisar)                       |
| `confirma_inbox_human_messages{status}`                                               | `QUEUED`/`PROCESSING`/`UNKNOWN`/`BLOCKED`/`FAILED`                   | `UNKNOWN > 0`; `FAILED` subindo        |
| `confirma_inbox_human_queued_oldest_age_seconds`                                      | envio humano parado na fila                                          | > 120 s                                |
| `confirma_inbox_unassigned_open_conversations{team}` e `..._oldest_age_seconds{team}` | fila de atendimento sem responsável                                  | conforme SLA operacional               |
| `confirma_queue_jobs{queue,state}`                                                    | BullMQ (`waiting`/`active`/`delayed`/`failed`)                       | `waiting` crescendo                    |
| `confirma_media_assets{status}`                                                       | mídias `PENDING`/`QUARANTINED`/`REJECTED`…                           | `PENDING` crescendo                    |
| `confirma_inbox_events_max_id`                                                        | feed SSE avançando                                                   | parado com inbound chegando            |

Dead-letters: `GET /api/ops/dead-letters?page=1&limit=50` (ADMIN). A resposta não inclui
payload, wa_id nem WAMID — só IDs, tipo, tentativas, erro minimizado e datas.

Integridade (somente leitura, na VPS):
`pnpm --filter @confirma/database exec tsx scripts/verify-inbox-integrity.ts` (exit 1 = violação).

## 1. Meta indisponível ou 429/limite

**Sintomas:** `confirma_inbox_human_messages{status="FAILED"}` ou `QUEUED` subindo; erros
`429`/`5xx` no log do worker (sem conteúdo); campanhas atrasando.

1. Confirme na página de status da Meta / Business Manager. Não altere código.
2. O sender trata 429/5xx **com resposta HTTP** como "Meta não aceitou" e pode repetir com backoff;
   o limiter compartilhado por `phone_number_id` segura campanha, resposta automática e humano.
3. Se o 429 persistir: pause campanhas novas pela UI (`/api/campaigns/:id/pause`) para priorizar
   o atendimento humano. Não reduza a margem da janela.
4. Mensagens humanas cuja janela expirar enquanto esperam serão **BLOCKED** no sender
   (revalidação do gate). Isso é correto: não reenviar fora da janela.
5. Erros de rede/timeout após o request poder ter saído viram `UNKNOWN` (ver §8).

## 2. Token da Meta expirado/revogado

**Sintomas:** erros `401`/código OAuth da Meta em todo envio; `FAILED` em massa.

1. Defina `MESSAGING_MODE=DRY_RUN` no worker **ou** pare o worker de envio se houver risco de
   repetição desordenada (as mensagens `QUEUED` ficam no outbox).
2. Gere novo token de sistema no Business Manager; atualize o segredo no ambiente (nunca em
   arquivo do repositório) e reinicie o worker.
3. Mensagens humanas `FAILED` por token não são reenviadas automaticamente. O atendente deve
   escrever de novo **se** a janela ainda estiver aberta (a UI mostra o motivo).

## 3. PostgreSQL fora

- **Webhook:** a API grava o lote inteiro numa transação **antes** do 2xx. DB fora ⇒ 5xx ⇒ a Meta
  reenvia com backoff (por horas). Nada é perdido se o banco voltar dentro da retenção de
  reentrega da Meta. Não "aceite" webhooks sem persistir.
- **Inbox/API:** 5xx; o atendente não consegue enviar (o gate exige transação). Correto.
- **Métricas:** `confirma_db_up 0` (o endpoint continua respondendo).
- Recuperação: restaure o banco; acompanhe `confirma_webhook_events{status="PENDING"}` subir e
  depois drenar; rode a verificação de integridade.

## 4. Redis fora

- **Webhook:** continua aceitando (persistência no Postgres); a publicação no BullMQ é best-effort
  e falha silenciosamente. O despachante de outbox republica `PENDING` quando o Redis voltar.
- **Envio humano:** API aceita (`QUEUED` gravado) e o varredor republica depois; nada é enviado
  enquanto o Redis estiver fora (limiter e filas dependem dele).
- **Métricas:** `confirma_redis_up 0`, sem `confirma_queue_jobs`.
- Recuperação: subir Redis; acompanhar `confirma_webhook_oldest_age_seconds` e
  `confirma_inbox_human_queued_oldest_age_seconds` voltarem a valores baixos.

## 5. Fila envelhecida (outbox ou BullMQ)

1. Identifique onde: `confirma_webhook_oldest_age_seconds{status="PENDING"}` (despachante),
   `confirma_queue_jobs{state="waiting"}` (workers) ou `..._human_queued_oldest_age_seconds`.
2. Verifique se o worker está vivo (logs, `docker compose ps` na VPS) e se há lease preso
   (`dispatch_lease_until` no futuro distante — o lease expira sozinho).
3. Escale réplicas do worker se CPU/DB permitirem (os jobs são idempotentes por `jobId`).
4. **Não** apague jobs nem altere `processing_status` em massa.

## 6. Pico de tráfego

1. Observe ACK do webhook (latência no proxy) e `confirma_webhook_events{status="PENDING"}`.
2. O ACK depende só do insert em lote; o processamento é assíncrono. Se o backlog crescer mas o
   ACK estiver ok, aumente workers; se o ACK subir, investigue pool de conexões do Postgres.
3. Campanhas grandes podem ser pausadas para dar prioridade ao inbox.
4. Metas de capacidade estão em [inbox-validacao.md](../inbox-validacao.md) — são metas a medir.

## 7. Dead-letter e replay

1. Liste: `GET /api/ops/dead-letters` (ADMIN). Agrupe por `eventType`/`processingError`.
2. Corrija a causa (ex.: bug implantado, dado de referência ausente). Status que chegou antes do
   WAMID ser conhecido normalmente é reconciliado sozinho; dead-letter indica que não foi.
3. Reprocesse **um** evento: `POST /api/ops/dead-letters/:id/replay` (ADMIN, com CSRF pela UI ou
   cookie+`x-csrf-token`). O evento volta para `PENDING` com `attempts=0` e `nextAttemptAt=null`;
   o despachante do worker o publica. Gera `AuditLog` `WEBHOOK_DEAD_LETTER_REPLAYED`.
4. Replay é idempotente no processamento (chaves únicas em `conversation_messages`), mas faça em
   lotes pequenos e acompanhe as métricas. Se voltar a DEAD_LETTER, não insista: abra incidente.
5. Em staging, os status sintéticos da carga (WAMIDs `wamid.SYNTH.*`) **vão** para dead-letter
   por não corresponderem a mensagens reais — é esperado e não deve ser reprocessado.

## 8. Mensagem humana `UNKNOWN` (reconciliação manual)

`UNKNOWN` = o request à Meta pode ter saído, mas não houve resposta conclusiva (timeout/rede).
**Não reenviar às cegas** (risco de duplicar mensagem para o cidadão).

1. Aguarde o webhook de status: ele reconcilia por `biz_opaque_callback_data`
   (= `conversation_messages.id`) e preenche `wa_message_id`, avançando o status.
2. Após 30 min sem status: consulte no Business Manager/WhatsApp Manager se houve envio para a
   conversa (pelo horário e protocolo, sem copiar conteúdo para o ticket).
3. Se confirmado que **não** saiu: o atendente escreve de novo (nova mensagem, nova
   `idempotencyKey`) **somente** se a janela ainda estiver aberta. Registre nota interna.
4. Se confirmado que saiu: mantenha `UNKNOWN` até o status chegar ou registre nota interna; não
   altere o estado direto no banco sem autorização.

## 9. Mídia

- Mídias entram como `PENDING`; o worker baixa, valida MIME/tamanho/sha256 e marca
  `AVAILABLE`, `QUARANTINED` ou `REJECTED`. Download só de `AVAILABLE`, como anexo, `nosniff`.
- `PENDING` crescendo: verificar fila `confirma.media`, token da Meta (a URL de mídia exige o
  token) e espaço de armazenamento. URLs da Meta expiram: mídia muito antiga pode virar `EXPIRED`.
- Nunca abra mídia `QUARANTINED`/`REJECTED` em estação de trabalho.

## 10. Backfill e rollback

**Backfill** (ver [inbox-validacao.md](../inbox-validacao.md) §3): sempre dry-run primeiro, depois
`--apply` em **cópia** do banco, verificação de integridade, e só então em produção com
autorização explícita. O backfill:

- cria contatos, conversas históricas `RESOLVED`, `CAMPAIGN_REF` e `INBOUND` com
  `replyEligibility=NOT_ELIGIBLE` / `eligibilityReason=BACKFILL_HISTORICAL`;
- **não** cria `ConversationContext`, **não** define `last_eligible_inbound_at`, **não** altera
  `messages`, `convocations`, `message_responses` nem `billing_events`;
- é idempotente e usa advisory lock (duas execuções simultâneas: a segunda aborta).

**Rollback:** a migração `20261016120000_whatsapp_human_inbox` é **aditiva**. Rollback operacional =
desligar o inbox (não expor a rota `/atendimento`, não registrar `InboxModule`/`OpsModule`,
parar o sender humano) e deixar de usar as tabelas novas. Campanhas seguem lendo `messages`.

SQL de remoção — **somente referência; NUNCA executar sem autorização explícita de Adriano,
backup verificado e janela de manutenção**:

```sql
-- REFERÊNCIA. NÃO EXECUTAR SEM AUTORIZAÇÃO.
-- Remover apenas dados do backfill (mantém inbox ao vivo):
-- DELETE FROM conversation_messages WHERE idempotency_key LIKE 'backfill:response:%';
-- DELETE FROM conversation_messages m USING conversation_activities a
--   WHERE a.conversation_id = m.conversation_id AND a.reason = 'BACKFILL_HISTORICAL'
--     AND a.type = 'CONVERSATION_OPENED' AND m.kind = 'CAMPAIGN_REF';
-- (conversas, atividades e inbox_events históricos exigem remoção em ordem de FK)
--
-- Remoção completa do inbox (destrutiva):
-- DROP TABLE media_assets, inbox_events, conversation_contexts, conversation_read_states,
--   conversation_activities, conversation_notes, conversation_messages, conversations,
--   team_members, teams, whatsapp_contacts;
-- DROP SEQUENCE conversation_protocol_seq;
-- ALTER TABLE convocations DROP COLUMN human_hold_at, DROP COLUMN human_hold_conversation_id;
-- ALTER TABLE messages DROP COLUMN sender_phone_number_id;
-- (colunas de outbox em message_events e o valor DEAD_LETTER do enum exigem análise à parte)
```

## 11. Checklist antes do piloto

- [ ] **LGPD:** base legal e finalidade do atendimento registradas; aviso de privacidade cobre
      atendimento humano por WhatsApp; operadores com termo de confidencialidade.
- [ ] **Opt-in:** pacientes da campanha piloto com consentimento para contato por WhatsApp;
      fluxo de opt-out testado (`POST /api/inbox/contacts/:id/opt-out` bloqueia envio).
- [ ] **Retenção:** prazo definido para `conversation_messages`, notas e mídias; rotina de
      expiração de mídia (`expires_at`) ativa; backups com o mesmo prazo.
- [ ] **Acesso:** equipes e papéis (AGENT/SUPERVISOR) revisados; MFA/senhas fortes; ADMIN mínimo.
- [ ] **Logs:** amostra de logs da API/worker sem conteúdo, telefone completo ou nome.
- [ ] **Gate:** e2e `tests/load/inbox-human-gate-e2e.mjs` aprovado em staging (422 espontâneo,
      202 só com resposta a template, nota sem envio).
- [ ] **Integridade:** `verify-inbox-integrity.ts` sem violações em staging pós-backfill.
- [ ] **Carga:** resultados medidos registrados (não presumidos) — ver `inbox-validacao.md`.
- [ ] **Alertas:** coletor Prometheus com `OPS_METRICS_TOKEN` (≥ 24 caracteres) e alertas da §0.
- [ ] **Plantão:** responsável por dead-letter/`UNKNOWN` definido; este runbook revisado.
- [ ] `MESSAGING_MODE=LIVE` somente após autorização operacional explícita.
