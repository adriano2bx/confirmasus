# Contrato de implementação: atendimento humano WhatsApp

**Branch:** `feat/whatsapp-human-inbox-implementation` (base `85ed551`)
**Plano:** [whatsapp-human-inbox.md](whatsapp-human-inbox.md) · **Linear:** ADR-15 (ADR-16 a ADR-29)
**Data:** 2026-10-16

Este documento é o contrato compartilhado entre as Tasks de implementação. Ele fixa
schema, regra de produto, formatos de evento, rotas de API e propriedade de arquivos.
Divergências do plano estão em "Decisões e cortes".

## 1. Regra de produto obrigatória (Adriano)

1. O atendente humano **nunca inicia conversa**. Não existe envio humano de template.
2. Envio humano só é permitido depois que o contato **respondeu a um template de campanha
   enviado pelo sistema** e somente dentro da janela de 24h (menos 5 min de margem) a partir
   do último inbound **elegível**.
3. **Correlação segura (gate fechado):** inbound é elegível somente se trouxer `context.id`
   (WAMID) que referencia uma linha de `messages` que seja template de campanha
   (`stage` FIRST/SECOND/THIRD, `attemptNumber` 1–3, não `SESSION_TEXT`), já submetida
   (`providerMessageId` presente), enviada ao **mesmo `wa_id`** e pelo **mesmo
   `phone_number_id`** (linhas legadas sem `senderPhoneNumberId` comparam com
   `META_WHATSAPP_PHONE_NUMBER_ID`). Texto livre sem `context.id`, correlação por telefone,
   por horário ou pela "última convocação" **não** autorizam resposta humana.
4. Inbound espontâneo/não elegível é persistido uma vez e vai para a fila, mas não concede
   permissão. A UI mostra o motivo do bloqueio.
5. Gate server-side em dois pontos, ambos pela **mesma função**
   `evaluateHumanReplyPolicy` de `@confirma/domain`:
   - API: dentro da transação que aceita a mensagem (após `SELECT ... FOR UPDATE` da conversa);
   - sender: imediatamente antes da chamada à Meta (relê conversa e contato). Se bloqueado,
     a mensagem fica `BLOCKED` e nada é enviado.
6. Opt-out/bloqueio do contato e conversa `RESOLVED` também bloqueiam. Só o responsável
   atribuído envia.
7. O fluxo automático de campanhas continua sendo o único emissor de templates. Sua política
   não muda, exceto a **pausa por atendimento humano** (ADR-24), que só suprime envios.

Implementação única: `packages/domain/src/inbox/eligibility.ts` (testes em `inbox.test.ts`).
**Ninguém reimplementa a regra.**

Pergunta em aberto para Adriano: inbound posterior **sem** `context.id` dentro de uma conversa
já elegível (ex.: o cidadão manda um segundo texto) deve renovar a janela? Hoje **não** renova
(gate fechado). Resposta a mensagem humana (context.id de HUMAN_TEXT) também **não** renova.

## 2. Schema (migração `20261016120000_whatsapp_human_inbox`, aditiva)

Ver `packages/database/prisma/schema.prisma`. Resumo:

| Modelo                                                                                                                     | Função                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WhatsAppContact`                                                                                                          | chave `waId` (dígitos); `profileName` nunca é prova de identidade; `optedOutAt`, `blockedAt`                                                                                                                                                                                                    |
| `Team`, `TeamMember(role AGENT/SUPERVISOR)`                                                                                | filas/equipes; no máx. uma `isDefault`                                                                                                                                                                                                                                                          |
| `Conversation`                                                                                                             | `protocol` único sem PII, `contactId`, `phoneNumberId`, `teamId`, `assigneeId`, `status` OPEN/WAITING_CONTACT/SNOOZED/RESOLVED, `version` otimista, `lastInboundAt`, `lastEligibleInboundAt` (âncora da janela), `lastOutboundAt`, `lastActivityAt`; índice parcial: 1 ativa por contato+número |
| `ConversationMessage`                                                                                                      | timeline canônica: `INBOUND`, `HUMAN_TEXT`, `CAMPAIGN_REF` (referência à linha de `messages`, sem copiar conteúdo/estado); `waMessageId` único; `idempotencyKey` único; `sourceEventId` único; `replyEligibility` + `eligibilityReason` no inbound; estados incl. `UNKNOWN` e `BLOCKED`         |
| `ConversationNote`                                                                                                         | nota interna, tabela própria; nunca lida pelo sender                                                                                                                                                                                                                                            |
| `ConversationActivity`                                                                                                     | histórico append-only (atribuição, transferência, estado, bloqueios, pausa)                                                                                                                                                                                                                     |
| `ConversationReadState`                                                                                                    | último lido por usuário (não lido por agente)                                                                                                                                                                                                                                                   |
| `ConversationContext`                                                                                                      | vínculo explícito conversa↔convocação: `TEMPLATE_REPLY` (via WAMID) ou `MANUAL`; nunca por telefone                                                                                                                                                                                            |
| `InboxEvent`                                                                                                               | feed `BIGSERIAL` para SSE; só tipo/IDs                                                                                                                                                                                                                                                          |
| `MediaAsset`                                                                                                               | mídia privada: MIME declarado/detectado, tamanho, sha256, storageKey, status                                                                                                                                                                                                                    |
| `Convocation.humanHoldAt/humanHoldConversationId`                                                                          | pausa de follow-ups por atendimento humano                                                                                                                                                                                                                                                      |
| `Message.senderPhoneNumberId`                                                                                              | número que enviou o template (preenchido em envios novos)                                                                                                                                                                                                                                       |
| `MessageEvent.attempts/nextAttemptAt/dispatchLeaseUntil/phoneNumberId/waId/deadLetteredAt`, `ProcessingStatus.DEAD_LETTER` | outbox durável do webhook                                                                                                                                                                                                                                                                       |

Helpers transacionais em `@confirma/database` (`packages/database/src/inbox.ts`):
`appendInboxEvent`, `allocateProtocol`, `upsertContact`, `findOrCreateActiveConversation`,
`withActiveConversationRetry`, `lockConversation`, `defaultTeamId`, `isUniqueViolation`.
Toda mudança visível no inbox grava `appendInboxEvent` **na mesma transação**.

Domínio (`@confirma/domain`): `evaluateInboundEligibility`, `evaluateHumanReplyPolicy`,
`humanReplyWindowExpiresAt`, `monotonicMax`, `canPerform`, `visibleTeamIds`, `canTransition`,
`formatProtocol`, `nextOutboundStatus`, `HUMAN_REPLY_BLOCK_LABELS`, limites de tamanho.

Filas (`@confirma/queue`): `QUEUES.humanMessages`, `QUEUES.media`, `SendHumanMessageJob`,
`ProcessMediaJob`, `humanMessageJobId`, `webhookJobId`, `mediaJobId`, `acquireSendPermit`.

## 3. Webhook durável (ADR-17/19)

- API valida HMAC, shape e limites; normaliza **todo o lote**; grava todos os `message_events`
  numa **única transação** (`createMany` + `skipDuplicates`, chaves determinísticas); só então
  responde 2xx. Falha de DB ⇒ 5xx (Meta reenvia). Depois do commit, publica no BullMQ em
  modo best-effort: Redis fora **não** muda a resposta.
- Chaves de deduplicação: `message:<wamid>`, `status:<wamid>:<status>:<timestamp>`,
  `billing:<wamid>:<status>:<timestamp>`.
- Envelope normalizado (`message_events.payload`), compatível com o atual e ampliado:
  - status: `{ type:'message-event', timestamp, phoneNumberId, payload:{ id, type, recipientId, bizOpaque, payload:{ ts, code, reason } } }`
  - billing: igual ao atual + `phoneNumberId`
  - inbound: `{ type:'message', timestamp, phoneNumberId, waId, profileName, payload:{ id, source, context:{ id }, type, payload:{ type, text, title, buttonPayload, media?:{ id, mimeType, sha256, filename } } } }`
  - localização: somente `type:'location'`, sem coordenadas no payload (minimização).
- Colunas `message_events.phoneNumberId` e `waId` preenchidas no insert.
- Despachante de outbox (worker): lease com `FOR UPDATE SKIP LOCKED`, publica `PENDING` e
  `FAILED` vencidos (`nextAttemptAt <= now`), `jobId = webhookJobId(id)`.
- Falha de processamento: `attempts+1`, `nextAttemptAt` com backoff exponencial (teto 15 min),
  `DEAD_LETTER` após `WEBHOOK_MAX_ATTEMPTS` (padrão 12), erro minimizado (sem conteúdo).
  Status que chega antes do WAMID ser conhecido segue esse caminho e é reconciliado depois.

## 4. Processamento de inbound e timeline (ADR-20)

Numa transação por evento (`withActiveConversationRetry`):

1. `upsertContact(waId, profileName)`; `findOrCreateActiveConversation(contact, phoneNumberId)`
   (conversa RESOLVED ⇒ nova conversa/novo protocolo).
2. Cria `ConversationMessage` INBOUND (`waMessageId` único, `sourceEventId`). Conflito de
   unicidade ⇒ evento duplicado: marca `PROCESSED` e não refaz nada (inclusive
   `MessageResponse`).
3. Localiza linha de `messages` por `context.id`; `evaluateInboundEligibility`; grava
   `replyEligibility`, `eligibilityReason`, `repliedCampaignMessageId`.
4. Elegível ⇒ `lastEligibleInboundAt = monotonicMax(...)` e `ConversationContext`
   `TEMPLATE_REPLY` para a convocação da linha referenciada. `lastInboundAt` sempre monotônico.
5. Garante `CAMPAIGN_REF` para as linhas de `messages` enviadas a esse `wa_id` pelo número
   (exibição de histórico do canal; **não** cria vínculo clínico).
6. Fluxo existente de CONFIRM/CANCEL/FREE_TEXT, resposta automática e handoff **inalterado**.
   O fallback legado por telefone (`findInboundMessage` sem context) continua só para
   `MessageResponse` da campanha, nunca para elegibilidade nem `ConversationContext`.
7. Mídia: cria `MediaAsset` PENDING; publica job best-effort após commit.
8. `appendInboxEvent` para mensagem/conversa.

Status de saída: procura em `messages` (fluxo atual) e depois em `conversation_messages` por
`waMessageId` ou `bizOpaque` (= `conversation_messages.id`), aplicando `nextOutboundStatus`.
`UNKNOWN` + status recebido ⇒ preenche `waMessageId` e avança.

## 5. Envio humano e limiter (ADR-23)

- API grava `ConversationMessage` HUMAN_TEXT `QUEUED` (+ atividade/evento) numa transação
  com o gate; publica `SendHumanMessageJob` best-effort; varredor do worker publica `QUEUED`
  antigos (outbox).
- Sender: claim `QUEUED→PROCESSING`; revalida gate (`evaluateHumanReplyPolicy` com conversa e
  contato relidos; ator = `authorId`); bloqueado ⇒ `BLOCKED` + atividade
  `HUMAN_SEND_BLOCKED`. `acquireSendPermit(phoneNumberId)`; envia texto com
  `biz_opaque_callback_data = conversation_messages.id`.
- Erro de rede/timeout após o request poder ter saído ⇒ `UNKNOWN` (sem retry cego) + atividade
  `HUMAN_SEND_UNKNOWN`; reconciliação pelo status webhook (`bizOpaque`). Erro com resposta
  HTTP da Meta não transitório ⇒ `FAILED`; 429/5xx com resposta ⇒ pode repetir (a Meta não
  aceitou). Sem promessa de exactly-once.
- `MESSAGING_MODE=DRY_RUN` nunca chama a Meta.
- Limiter: Redis compartilhado por `phone_number_id`, usado também pela campanha e pela
  resposta automática.

## 6. Pausa de automação (ADR-24)

- Ao **assumir/atribuir** conversa, a API marca `humanHoldAt` (e `humanHoldConversationId`)
  nas convocações ativas vinculadas por `ConversationContext` **e** nas convocações ativas
  cujo telefone selecionado é o `wa_id` (supressão operacional, não vínculo clínico).
  Atividade `AUTOMATION_PAUSED`.
- Scheduler (enfileirar devidos, promover follow-up, finalizar sem resposta, reconciliar jobs)
  ignora convocações com `humanHoldAt`. Sender de campanha relê a convocação imediatamente
  antes da Meta e não envia se `humanHoldAt` (job já enfileirado); volta a `SCHEDULED`
  sem consumir tentativa.
- Resolver **não** retoma. Retomar exige `POST .../automation/resume` explícito (supervisor),
  com prévia dos envios pendentes/vencidos.

## 7. API (ADR-21/22/25/26) — prefixo `/api/inbox`, `AuthGuard` + RBAC em todo endpoint

| Rota                                                                | Corpo/consulta                                                                                                                                                                                   | Resposta                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `GET /me`                                                           | —                                                                                                                                                                                                | `{ userId, globalRole, teams:[{id,name,role}] }`                   |
| `GET /conversations`                                                | `view=unassigned\|mine\|team\|waiting_contact\|snoozed\|resolved\|all`, `teamId`, `assigneeId`, `status`, `q` (protocolo ou dígitos do WhatsApp), `priority`, `from`, `to`, `cursor`, `limit≤50` | `{ items: ConversationSummary[], nextCursor }`                     |
| `GET /conversations/:id`                                            | —                                                                                                                                                                                                | `ConversationDetail`                                               |
| `GET /conversations/:id/timeline`                                   | `cursor`, `limit≤50` (mais recentes primeiro)                                                                                                                                                    | `{ items: TimelineItem[], nextCursor }`                            |
| `POST /conversations/:id/claim`                                     | `{ version }`                                                                                                                                                                                    | `ConversationSummary`                                              |
| `POST /conversations/:id/assign`                                    | `{ version, assigneeId }`                                                                                                                                                                        | idem                                                               |
| `POST /conversations/:id/transfer`                                  | `{ version, toTeamId?, toUserId?, reason }`                                                                                                                                                      | idem                                                               |
| `POST /conversations/:id/status`                                    | `{ version, status, snoozedUntil?, reason? }`                                                                                                                                                    | idem                                                               |
| `POST /conversations/:id/priority`                                  | `{ version, priority }`                                                                                                                                                                          | idem                                                               |
| `POST /conversations/:id/messages`                                  | `{ body, idempotencyKey(uuid) }`                                                                                                                                                                 | `202 { message }` ou `422 { code:'HUMAN_REPLY_BLOCKED', reasons }` |
| `POST /conversations/:id/notes`                                     | `{ body }`                                                                                                                                                                                       | `201 { note }`                                                     |
| `POST /conversations/:id/contexts`                                  | `{ convocationId }`                                                                                                                                                                              | `201`                                                              |
| `DELETE /conversations/:id/contexts/:convocationId`                 | —                                                                                                                                                                                                | `204`                                                              |
| `GET /conversations/:id/automation`                                 | —                                                                                                                                                                                                | prévia: convocações em pausa e envios vencidos                     |
| `POST /conversations/:id/automation/resume`                         | `{ version, convocationIds }`                                                                                                                                                                    | resumo                                                             |
| `POST /conversations/:id/read`                                      | `{ lastReadMessageId? }`                                                                                                                                                                         | `204`                                                              |
| `POST /contacts/:id/opt-out`                                        | `{ optedOut: boolean, reason }`                                                                                                                                                                  | `204`                                                              |
| `GET/POST/PATCH /teams`, `POST/DELETE /teams/:id/members[/:userId]` | ADMIN                                                                                                                                                                                            | equipes                                                            |
| `GET /stream`                                                       | SSE; `Last-Event-ID` ou `?cursor=`                                                                                                                                                               | eventos `{ id, type, conversationId, entityId }`                   |
| `GET /media/:assetId`                                               | —                                                                                                                                                                                                | arquivo (somente `AVAILABLE`, `attachment`, `nosniff`)             |

- Conflito de versão: `409 { code:'VERSION_CONFLICT', conversation: ConversationSummary }`.
- `ConversationSummary`: `{ id, protocol, status, priority, version, team, assignee, contact:{ id, waIdMasked, profileName, optedOut }, phoneNumberId, lastActivityAt, lastInboundAt, unreadCount, automationPaused, replyPolicy:{ allowed, reasons, windowExpiresAt } }` — `replyPolicy` avaliada para o usuário que consulta.
- `ConversationDetail` = summary + `contexts[]` (vinculadas) + `candidates[]` (convocações ativas
  com o mesmo telefone, **não vinculadas**, exigem seleção humana) + `ambiguous: boolean`.
- `TimelineItem`: `{ kind:'message', ... }` | `{ kind:'note', ... }` | `{ kind:'activity', ... }`,
  cursor opaco sobre `(createdAt,id)`.
- Telefone mascarado em listas; nada de conteúdo de mensagem em logs.
- SSE: só tipo/IDs, filtrado por equipes visíveis (`visibleTeamIds`), heartbeat 15 s, conexão
  máx. 5 min; cliente reconecta com cursor e refaz busca por HTTP. Fallback polling.

## 8. Propriedade de arquivos (Tasks)

| Task                       | Pode editar (exclusivo)                                                                                                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordenador                | `packages/database/prisma/**`, `packages/database/src/**`, `packages/domain/src/inbox/**`, `packages/queue/src/index.ts`, `package.json`s, este contrato, `.env.example`, `README.md`, integração final em `apps/worker/src/main.ts` (após T3) e `apps/api/src/app.module.ts` (após T4) |
| T1 webhook durável         | `apps/api/src/webhooks/**`, `apps/worker/src/outbox-dispatcher.ts` (+ teste)                                                                                                                                                                                                            |
| T2 inbound/timeline/status | `apps/worker/src/webhook-worker.ts`, `apps/worker/src/webhook-events.ts` (+ testes), `apps/worker/src/inbox/**`                                                                                                                                                                         |
| T3 sender/limiter/pausa    | `packages/queue/src/rate-limit.ts`, `apps/worker/src/meta-whatsapp-client.ts`, `message-worker.ts`, `automatic-reply-worker.ts`, `human-message-worker.ts`, `follow-up-schedule.ts`, `apps/worker/src/main.ts` (+ testes)                                                               |
| T4 API inbox               | `apps/api/src/inbox/**`, `apps/api/src/app.module.ts`                                                                                                                                                                                                                                   |
| T5 UI                      | `apps/web/app/atendimento/**`, `apps/web/app/lib/inbox*.ts`, `apps/web/app/components/navigation.tsx`                                                                                                                                                                                   |
| T6 mídia                   | `apps/worker/src/media/**`, `apps/api/src/media/**`                                                                                                                                                                                                                                     |
| T7 ops/backfill/carga      | `packages/database/scripts/**`, `apps/api/src/ops/**`, `tests/load/inbox-*`, `docs/runbooks/**`, `docs/inbox-*.md`                                                                                                                                                                      |

Testes: unitários rodam sem serviços. Testes que precisam de PostgreSQL/Redis ficam em arquivos
`*.integration.test.ts` e são pulados sem `INTEGRATION_DATABASE_URL`/`INTEGRATION_REDIS_URL`;
rodam somente na VPS (`/srv/projetos/interno/confirmasus`).

## 9. Decisões e cortes

- **Timeline canônica aditiva:** em vez de tornar `messages.convocationId` opcional (risco alto
  para relatórios/billing/dashboard), a timeline é `conversation_messages`, e envios de
  campanha entram como `CAMPAIGN_REF` apontando para `messages` (sem cópia divergente).
  Relatórios, billing e dashboard continuam lendo `messages` sem alteração.
- **Fila = equipe** no MVP (`Team`); sem entidade `Inbox` separada.
- **Reabertura:** inbound após RESOLVED cria nova conversa/protocolo; reabertura manual
  (supervisor) mantém o protocolo se não houver outra ativa.
- **Pausa** é disparada por assumir/atribuir (ação explícita), não por qualquer texto livre.
- Billing de mensagens humanas (texto de sessão) não entra em `billing_events` neste corte.
- Envio de mídia pelo atendente, round-robin, presença, macros, SLAs configuráveis: fora.
- Timeout ambíguo de campanha mantém o comportamento atual (retry do job); `UNKNOWN` sem retry
  vale para envio humano. Alterar a campanha exige decisão de Adriano.

## 10. Estado da implementação e validação (2026-10-16)

Implementado na branch, sem commit. Validação executada (dados 100% sintéticos, `DRY_RUN`):

- Local (sem serviços): `pnpm -r typecheck`; testes domain 21/21, worker 119/119, api 59/59,
  web 27/27; `pnpm --filter @confirma/web build`.
- VPS `vpsdev` (staging `/srv/projetos/interno/confirmasus`, Docker sem portas publicadas,
  Node 22, PostgreSQL 17, Redis 7), banco novo: todas as migrações aplicadas; domain 21/21,
  worker 133/133 (14 de integração), api 68/68 (9 de integração), web 27/27.
- E2E HTTP (API + worker): espontâneo ⇒ 422 `NO_ELIGIBLE_INBOUND`; `context.id` forjado ⇒ 422;
  outro `wa_id` citando o template ⇒ 422; resposta legítima ⇒ 202 e `SUBMITTED`; nota ⇒ 201 sem
  envio.
- Carga sintética de webhook, 60 s: ~5.509 eventos/min, 0 erro, ACK p50 20 ms, p95 34 ms,
  p99 52 ms; nenhum WAMID duplicado. **Não** foram executados os 15 min a 5k/min nem o burst de
  10k/min; capacidade em produção não está demonstrada.
- Redis parado: 40/40 requisições 204 (ACK ~1,5 s por causa da espera máxima de publicação);
  eventos persistidos como `PENDING` e drenados em ≤10 s após o Redis voltar.
- Backfill ensaiado: dry-run, apply e reexecução sem gravações; `messages`, `message_responses`,
  `convocations` e `billing_events` inalterados.
- `verify-inbox-integrity.ts` acusa as 2 mensagens `HUMAN_TEXT` criadas diretamente pelo teste de
  integração do worker (fixtures sem autor). Em base com dados de teste isso é esperado; em base
  real o resultado deve ser 0.
- Interface verificada com Chromium headless na VPS (desktop 1440 px e mobile 390 px): composer
  bloqueado com motivo para conversas não elegíveis, habilitado com prazo da janela para a
  elegível, nota interna destacada, pausa de automação visível.

### Decisões adicionais durante a implementação

- Inbound com `context.id` desconhecido espera até `WEBHOOK_CONTEXT_WAIT_ATTEMPTS` (padrão 4,
  cerca de 30 s) pela correlação e depois entra uma vez como `CONTEXT_NOT_FOUND`, sem permissão.
- API ajustada para aceitar corpo JSON até 1 MB (lotes da Meta) e `keepAliveTimeout` de 65 s para
  evitar `ECONNRESET` intermitente no proxy `/api` do Next (observado uma vez na validação visual).

### Perguntas em aberto para Adriano

1. Mensagem do cidadão **sem** `context.id` numa conversa já elegível deve renovar a janela de
   24 h? Hoje não renova (gate fechado).
2. A Meta pode entregar `wa_id` brasileiro sem o nono dígito. Hoje isso dá `RECIPIENT_MISMATCH`
   (gate fechado) e separa o histórico. Aceitar a equivalência `55DD9XXXXXXXX ↔ 55DDXXXXXXXX`
   só na comparação de destinatário?
3. Timeout ambíguo no envio de **campanha** mantém o retry atual (pode duplicar template). Mudar
   para `UNKNOWN` sem retry, como no envio humano?
