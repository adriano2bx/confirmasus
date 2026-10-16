# Planejamento: atendimento humano por WhatsApp

**Status:** planejamento revisado
**Branch:** `feat/whatsapp-human-inbox`

**Base:** `feat/whatsapp-meta-official` (`f30ef57`)
**Data:** 2026-10-16

## 1. Objetivo e resultado

Adicionar ao Confirma SUS um inbox próprio para receber e responder WhatsApp, organizar filas, permitir múltiplos atendentes, atribuição/transferência, notas internas, protocolo e acompanhamento da janela da Meta. Campanhas existentes devem continuar funcionando e seu histórico aparecer na mesma linha do tempo do atendimento.

“Sem ferramenta de terceiros” significa sem Chatwoot ou outro sistema de inbox. O transporte continuará sendo a WhatsApp Business Platform/Cloud API da Meta, com seus webhooks, modelos, regras e limites.

**Usuários:** atendentes (fila, assumir/responder/transferir); supervisores (visão e intervenção); administradores (equipes, permissões e políticas); cidadãos/responsáveis (continuidade pelo canal e protocolo).

**Métricas de sucesso:** 100% dos eventos válidos que receberem ACK devem estar persistidos duravelmente; nenhum duplicado visível por replay; primeira resposta humana medida por equipe; backlog drenado dentro da meta definida; 5.000 mensagens de entrada/min sustentadas e burst de 10.000/min validados com gerador sintético. Esses números são metas do software a confirmar em homologação, não capacidade garantida da Meta ou da VPS atual.

## 2. Decisões e premissas

1. **Agrupamento pelo WhatsApp mantido**, como Adriano definiu. O `wa_id`/número normalizado identifica o contato; nome, CPF, CNS, nascimento ou convocação não são chaves alternativas. Um mesmo contato pode corresponder a mais de uma pessoa/convocação e a interface deve tornar a ambiguidade visível.
2. Canal inicial é WhatsApp oficial. Sem WhatsApp Web não oficial, outros canais, voz, bot generativo ou omnichannel.
3. Uma organização, com múltiplas filas/equipes no MVP; modelar `phone_number_id`/WABA para que conversas de números empresariais diferentes não se misturem. Multitenancy fora do escopo.
4. Inbox separa o **contato** do **caso de atendimento**. Conversa resolvida pode originar novo protocolo conforme política de reabertura ainda a definir.
5. Atendimento humano pausa os follow-ups automáticos pertinentes ao mesmo contato/convocação. Resolver o atendimento não retoma disparos silenciosamente.
6. Protocolo sequencial e único, sem PII embutida.
7. PostgreSQL é fonte de verdade; Redis/BullMQ distribui trabalho. ACK só depois de persistência durável.
8. Janela Meta é calculada no servidor a partir da última mensagem do usuário; texto livre bloqueado depois de 24h, quando só template aprovado e elegível pode iniciar contato. Regra atual descrita na documentação de WhatsApp [AWS](https://docs.aws.amazon.com/pdfs/social-messaging/latest/userguide/social-ug.pdf) e deve ser reconfirmada nas políticas Meta na implementação.
9. Capacidade de referência: 5k/min sustentadas por 15 min e 10k/min por 60 s, contabilizando separadamente mensagens lógicas e callbacks de estado. O aceite será sintético; limite por número/conta da Meta é dependência externa.

## 3. Estado atual e lacunas

- Stack existente: Next.js, NestJS, PostgreSQL/Prisma, Redis/BullMQ, usuários ADMIN/OPERATOR, webhook Meta com HMAC, envio de texto/template e estado de entrega.
- `Convocation` é o agregado de campanha. `Message` exige `convocationId`, estágio/tentativa e estrutura orientada a template; não representa mensagens livres sem convocação. `MessageResponse` registra respostas vinculadas ao fluxo.
- Webhook recebe mensagens e statuses, mas não cria conversas autônomas. Mensagens espontâneas sem saída correlacionável não viram atendimento persistente; remetente empresarial, identidade de contato e mídia não formam hoje um modelo de conversa.
- `HandoffEvent` é integração externa, não transferência entre atendentes.
- Não existem equipe/fila/atribuição/protocolo/notas internas, envio humano, SSE/WebSocket ou controle de concorrência de atendimento. Interface usa HTTP e polling em algumas telas.
- Texto livre recebido é registrado como FREE_TEXT, mas não suspende necessariamente o scheduler de follow-up.
- O README na base documentava agrupamento antigo por CPF/nome+nascimento, enquanto `patientGroupingKey` e campanha usam WhatsApp. A descrição foi corrigida nesta branch para refletir a regra vigente.

Referências verificadas no repo: `packages/database/prisma/schema.prisma`, `apps/api/src/webhooks/`, `apps/worker/src/webhook-worker.ts`, `apps/worker/src/main.ts`, `apps/worker/src/meta-whatsapp-client.ts`, `apps/api/src/campaigns/campaigns.service.ts`, `packages/domain/src/normalization.ts`, `apps/web/app/` e `README.md`.

## 4. Escopo funcional

### Inbox e operação

- Filas: não atribuídas, minhas, equipe, aguardando cidadão, aguardando equipe, adiadas e resolvidas; filtros/pesquisa por protocolo, WhatsApp, equipe, agente, estado, prioridade, etiqueta e período.
- Tela `/atendimento` em três painéis (fila, timeline, contexto do contato/convocações), responsiva, navegável por teclado; histórico paginado por cursor.
- Assumir, atribuir, transferir para agente/equipe, resolver, reabrir e adiar; transferência guarda ator, destino, origem, hora e motivo. Atribuição ativa única; conflito concorrente é devolvido com estado atualizado.
- Nota interna em armazenamento/API diferente de mensagem externa, com sinalização visual inequívoca. Histórico inclui eventos de atribuição, estado, protocolo, envio e falhas.
- Protocolo gerado em transação por sequência PostgreSQL, sem telefone/CPF/CNS no código.
- MVP usa atribuição manual. Round-robin, presença/online, digitação, macros, SLAs configuráveis, automação avançada e métricas por agente ficam para evolução.
- Conversa de contato desconhecido pode ser aberta sem campanha. Relacionar pacientes/convocações manualmente e permitir múltiplos vínculos. Não usar profile name como prova de identidade clínica.

### Mensagens e regras Meta

- Entrada reconhece texto, interativos/botões, imagem, documento, áudio, vídeo, localização e tipo desconhecido; guarda WAMID, `wa_id`, `phone_number_id`, timestamp, tipo e referência de mídia.
- Saída inicial: texto livre dentro da janela; templates aprovados e permitidos fora. Persistir metadados do template, parâmetros, consentimento/origem/instante quando exigidos e estados QUEUED/SUBMITTED/SENT/DELIVERED/READ/FAILED/UNKNOWN.
- Estado HTTP aceito não equivale a entrega; webhook de status atualiza o estado final, sem permitir regressão por evento atrasado.
- Mídia recebida deve aparecer como evento e ser recuperável em storage privado. Download autenticado, MIME/tamanho verificados, checksum, varredura e expiração. Envio de mídia pode ser fase posterior após validação institucional.
- Opt-out deve bloquear mensagens iniciadas pelo negócio e ser auditável; atendimento de entrada continua sujeito à política aprovada.

## 5. Arquitetura e dados

### Entidades

- **WhatsAppContact:** chave por `wa_id` normalizado; nome Meta opcional; opt-out/bloqueio e timestamps. Número empresarial é escopo da conversa, não motivo para misturar caixas.
- **Inbox/Team/TeamMember:** filas e membros. Permissões do backend por função/equipe (admin, supervisor, atendente ou permissões equivalentes), nunca só ocultação visual.
- **Conversation:** protocolo, contact, inbox/equipe e número/WABA de origem; status OPEN/PENDING/SNOOZED/RESOLVED; prioridade, assignee, versão otimista, criação/fechamento, último inbound/outbound e expiração da janela. `ConversationReadState` guarda último cursor lido por usuário para contagem correta em múltiplos agentes. Uma única conversa ativa por contato+inbox conforme regra de reabertura, garantida por transação/índice parcial.
- **AssignmentEvent/ConversationActivity:** histórico append-only de assunção, transferência, estado, etiqueta, nota e intervenção.
- **Message (evolução da tabela atual):** tornar entidade canônica de entrada/saída, com `conversationId`, direção, tipo, conteúdo, autor, WAMID, idempotency key, estados/timestamps do provider e metadados mínimos; inbound inclui estado `RECEIVED`. Acrescentar estado `UNKNOWN/RECONCILIATION_REQUIRED` para timeout ambíguo de saída; não reenviar automaticamente porque a Cloud API pode ter aceitado sem o cliente receber resposta. Campos de campanha atuais (`convocationId`, estágio, tentativa/template) passam a ser opcionais/contextuais. Atualizar relatórios, billing, relações de `MessageResponse` (incluindo mensagem recebida e mensagem enviada a que ela responde) e índices únicos de campanha. Mensagem humana, campanha e inbound usam uma timeline única; relação a convocação permanece opcional.
- **Nota interna:** atividade/tabela distinta, nunca enviada ao endpoint Meta.
- **WebhookReceipt/OutboxEvent:** evento normalizado e idempotente + publicação transacional. Entrada única pelo WAMID; status deduplicado por WAMID/tipo/timestamp.
- **MediaAsset:** storage privado, MIME real, tamanho, hash, provider media ID, expiração/varredura e acesso autorizado.
- **ConversationContext:** associação explícita muitos-para-muitos a pacientes/convocações; a chave de agrupamento por WhatsApp não muda.

### Webhook durável e ordenado

1. API stateless verifica HMAC no corpo bruto e confere IDs Meta aceitos; valida tamanho e shape.
2. Normaliza cada item do lote (mensagens e statuses), preservando tipo/IDs e minimizando PII; lote e evento individual têm limites distintos.
3. Em uma transação PostgreSQL insere receipts/outbox idempotentes. Só responde 2xx após commit. Se DB falhar, retorna erro para retry; não confirma evento em memória.
4. Despachante usa lease/`SKIP LOCKED`, batches e publica no BullMQ. Redis indisponível não perde evento; outbox é retomado.
5. Workers horizontais processam inbound, mídia, statuses e saída. Serializam por contato/conversa ou lock distribuído, ordenam pelo timestamp Meta e são idempotentes. Status que chega antes do commit do envio fica pendente sem associação e é reconciliado quando o WAMID for conhecido, sem ser ignorado nem regredir estados.
6. Payload venenoso vai a dead-letter minimizada com reprocessamento auditado. Redis/PubSub não é histórico.

### Outbound comum a campanha e inbox

API valida usuário, atribuição, status, permissão, idempotência e janela; grava Message + outbox na mesma transação. Despachante central compartilha rate limit por `phone_number_id` para campanha, resposta automática e humano; prioridade de humano não pode multiplicar o limite agregado. Worker registra tentativa e WAMID; callback Meta atualiza entrega. Timeout ambíguo entra em `UNKNOWN/RECONCILIATION_REQUIRED`, sem retry cego; o sistema não promete exactly-once onde o provedor não fornece chave idempotente consultável. Revalidar atribuição/estado/janela imediatamente antes do envio.

### Automação e conflitos

- Botão CONFIRM/CANCEL mantém fluxo existente e resposta automática configurada.
- Texto livre que pede suporte ou ação de assumir abre/atribui conversa e suspende follow-ups da convocação/contato; não cancela a campanha inteira nem afeta outros contatos.
- Scheduler e consumidor de job conferem bloqueio humano, inclusive para job já enfileirado; atualização concorrente é idempotente.
- Resolver não retoma disparos vencidos silenciosamente. Retomada exige ação explícita e resumo dos envios pendentes.
- Resposta recebida sem correlação confiável abre conversa sem escolher “a última convocação pelo telefone”. Correlação ambígua fica para confirmação do agente.
- Atualizar `lastInboundAt` monotonicamente (máximo entre valor atual e timestamp recebido); um webhook atrasado não encurta a janela Meta nem reordena a última atividade.

### APIs e atualização em tempo real

- `GET /api/inbox/conversations` filtros/cursor; detalhe e mensagens paginadas por cursor `(createdAt,id)`.
- `POST .../:id/claim|assign|transfer|resolve|reopen|snooze`; transições com versão e auditoria.
- `POST .../:id/messages` saída idempotente; `POST .../:id/notes` separado.
- Rotas administrativas de filas, equipes, membros, políticas e templates.
- SSE autenticado envia somente tipo/IDs/cursor, nunca conteúdo sensível completo. Ao reconectar, o cliente busca mudanças no banco desde cursor; polling lento é fallback. Autorização checada em toda busca.

## 6. Escala, SLO e operação

Metas provisórias no ambiente VPS de homologação, usando dados/eventos sintéticos:

- 5.000 inbound/min por 15 min; burst 10.000/min por 60 s; mensurar separadamente callbacks de estado, duplicatas e volume de mídia.
- 100% dos eventos com ACK durável e zero duplicata visível; callbacks fora de ordem não regridem estado.
- ACK webhook p95 ≤750 ms e p99 ≤2 s; não confundir com entrega WhatsApp.
- Backlog não cresce na carga sustentada e drena burst em até 5 min após cessar o pico.
- Lista paginada e histórico p95 ≤500 ms sob carga nominal; nenhum endpoint carrega tabela/histórico inteiro.
- Envio humano tem precedência operacional sobre campanha, sempre dentro de limite global Meta.

Valores são objetivos a confirmar com benchmark, não capacidade demonstrada atualmente. Checar separadamente o limite/tier, qualidade, templates e permissões da Meta; o sistema não contorna limite externo.

Componentes independentes: API de webhook; API/UI; workers inbound/status; dispatcher de outbox; sender; mídia. PostgreSQL com pooler, índices pelas consultas reais, limites de conexão e retenção; avaliar particionamento temporal somente após benchmark/volume. Redis HA com limites/métricas, filas recuperáveis. Storage privado dimensionado para mídia. O container único de homologação não comprova escala; produção deve escalar API/worker separadamente.

Métricas/alertas: taxa de webhook/ACK/5xx, p95/p99, duplicatas, idade da outbox e job mais velho por fila, retries/dead-letter, pool/locks do DB, latência/memória do Redis, API inbox, reconexões SSE, códigos Meta e proporções aceito/entregue/falhou, prazo de primeira resposta e backlog por equipe. Logs estruturados e tracing com IDs técnicos, conteúdo mascarado. Runbooks: Meta indisponível/rate limit, DB/Redis, token expirado, fila envelhecida, pico, mídia, replay e recuperação. Backups externos e restauração ensaiada antes do piloto.

## 7. Segurança e privacidade

Mensagens podem conter dado de saúde, classificado como sensível na LGPD. Antes de piloto, controlador/responsável deve definir finalidade/base legal, aviso de privacidade, retenção e descarte, atendimento de direitos, operadores/transferência internacional e necessidade de relatório de impacto. Isso é requisito de governança e não parecer jurídico; [LGPD oficial](https://planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm).

Aplicar minimização de payload/log, criptografia em trânsito/repouso, segredos Meta fora do Git e rotacionáveis, RBAC por equipe, CSRF e proteção de brute force, autorização em todos endpoints, auditoria de ações/acessos sensíveis, exportação desabilitada por padrão e retenção própria de mensagem, mídia, evento, audit e backup. Arquivos são não confiáveis; validar MIME real, tipo/tamanho, malware e expiração. Não inferir opt-in pela presença do paciente na importação.

## 8. Migração, teste, entrega e rollout

1. Fechar reabertura/protocolo, horário/SLA, opt-in/opt-out, conteúdo permitido, permissões e retenção com a instituição.
2. Criar entidades/índices aditivamente; backfill de contatos/conversas/mensagens pela chave WhatsApp; relatório de associações ambíguas; dry-run, medição de lock/duração e restauração antes de aplicar. Preservar relatórios, billing e estados; não fundir pacientes adicionais nem reescrever status clínicos.
3. Implementar webhook persistente/outbox e histórico independente de campanha; testar inbound desconhecido, duplicata, replay, lote, evento atrasado, botão, mensagem e statuses.
4. Implementar filas/permissões/atribuição, notas, protocolo, auditoria e API paginada.
5. Implementar envio humano, janela/templates, rate limit global, callbacks e suspensão/revalidação de automação.
6. Implementar inbox, SSE com cursor, mídia privada, observabilidade e ferramentas de dead-letter/replay.
7. Rodar carga e falhas na VPS com usuários/dados/eventos sintéticos; reiniciar API/worker/Redis, simular DB/Meta lento/429/5xx, validar zero perdas/duplicatas e recuperação.
8. Liberar com feature flag em homologação, depois piloto interno controlado e ramp-up gradual. Sem envio a pacientes, alteração de DNS ou deploy produtivo sem autorização operacional específica.

Testes necessários: unitários de máquina de estado/janela/idempotência; integração de webhooks oficiais anonimizados e status fora de ordem; concorrência entre agentes; nota nunca enviada; job de campanha já em fila ao assumir atendimento humano; migração/backfill/rollback; carga sintética 5k/10k; falhas do PostgreSQL/Redis/Meta; paginação e índices. Não foram executados nesta tarefa de planejamento.

## 9. Backlog proposto e dependências

1. **Regras de produto e governança** — precede envio/piloto; critérios: decisões da seção 12 registradas e política de privacidade/opt-in validada.
2. **ADR e contrato de eventos/Meta** — precede desenvolvimento; payloads, estados, idempotência, ordenação e limites aprovados; manter descrição do README consistente com a chave WhatsApp corrigida nesta branch.
3. **Schema inbox/contact/conversation e migração** — depende 1/2; backfill ensaiado, sem perda, duplicidade ou vínculo ambíguo automático.
4. **Recepção Meta durável, outbox e idempotência** — depende 2/3; ACK pós-commit e recuperação com Redis fora.
5. **Linha do tempo canônica e relação campanha** — depende 3/4; inbound, outbound campanha e humano ordenados sem duplicar billing/reports.
6. **Equipes, RBAC, protocolo, atribuição e transferência** — depende 3; operações atômicas/auditáveis.
7. **Notas internas, estados, tags, prioridade e auditoria** — depende 3/6; notas isoladas da API Meta.
8. **Janela, templates, opt-in/opt-out e sender compartilhado** — depende 1/3/5; bloqueios server-side, limiter agregado e status callback.
9. **Pausa segura da automação de campanha** — depende 3/5/8; scheduler e job consumidor verificam bloqueio.
10. **API e interface inbox** — depende 5/6/7/8; cursor, autorização, estados concorrentes e UX acessível.
11. **SSE, cursor de retomada e notificações** — depende 4/10; reconexão não perde evento nem expõe conteúdo.
12. **Mídia privada e validação** — depende 1/3/4; storage, malware/limites, expiração e autorização.
13. **Métricas, alertas, runbooks e resiliência** — acompanha 4/8/11/12; idade de fila/Meta/DB/Redis observável e procedimento de recuperação.
14. **Carga, segurança, migração e piloto** — depende de todas as anteriores; metas de 5k/10k e critérios da seção 6 aprovados em VPS; aceite de governança antes de dados reais.

Critério global de liberação: migrations testadas em cópia; nenhuma mensagem/note perdida ou duplicada; aceite de janela/permissões; campanhas preservadas; carga/recuperação demonstradas; alertas, backup/restore e responsável de operação definidos.

## 10. Riscos e decisões em aberto

| Risco/decisão | Tratamento ou decisão necessária |
|---|---|
| Mesmo telefone é de familiar/responsável e pode representar várias pessoas | Mantém chave WhatsApp a pedido do usuário; UI exige seleção de contexto e exibe todos vínculos. |
| Outbox/status e envio duplicado em timeout | Banco durável, idempotência local, reconciliação e estado UNKNOWN; não fazer retry cego nem prometer exactly-once sem suporte do provider. |
| Job de campanha compete ou envia após transferência | Limiter global e verificação de bloqueio no scheduler e imediatamente no sender. |
| Conteúdo clínico em inbox, mídia, logs e backups | Minimização, controle, retenção, criptografia e revisão institucional antes do piloto. |
| Meta muda regra/limite ou número não tem tier necessário | Confirmar documentação/Business Manager e testar número autorizado; não declarar capacidade externa garantida. |
| Reabertura, protocolo e SLA | Definir se nova mensagem reabre ou cria caso/protocolo, período de reabertura, horário/feriados e metas por fila. |
| Acesso/supervisão | Definir quem pode ver todas filas, assumir caso de colega, editar notas e exportar. |
| Opt-in, opt-out, menores e conteúdo permitido | Validação de privacidade/saúde e política Meta antes de habilitar envio iniciado pelo negócio. |
| Mídia e retenção | Definir tipos/tamanhos, região/storage autorizado, prazo de expiração e descarte. |
| Escala/custo/HA | Confirmar orçamento, disponibilidade, pool/Redis HA/VPS, tier do número e critérios de DR. |

## 11. Revisão de consistência do plano

Revisão efetuada após compor o plano. Foram corrigidos: capacidade expressa como mensagens lógicas (com callbacks contabilizados à parte); estado `UNKNOWN` para timeout sem confirmação do provedor, sem retry cego; estado de leitura por agente, não um contador global; status webhook sem mensagem local reconciliável; atualização monotônica de `lastInboundAt`; migração inclui relatórios, billing, respostas e índices da tabela Message; múltiplas filas/equipes no MVP; divergência do README sobre agrupamento. Permanecem abertas apenas decisões explicitadas na seção 10 e validações de carga/governança que dependem de ambiente e responsáveis.

| Invariante | Verificação planejada |
|---|---|
| Agrupamento WhatsApp não foi substituído por CPF/nome | Testes de mesmo `wa_id` em múltiplas convocações e `wa_id` diferentes sem fusão. |
| Entrada independente de campanha | Mensagem desconhecida sem WAMID de saída abre conversa e aparece uma vez. |
| Uma timeline sem cópia divergente | Migração do modelo Message atual e associação histórica; entrada/campanha/humano/status ordenados. |
| Nota não sai ao cidadão | Endpoint e storage próprios; integração prova zero chamadas Cloud API. |
| ACK indica durabilidade | Falha DB retorna erro; falha Redis não perde outbox. |
| Limite de envio não dobra com réplicas | Todos os tipos de saída passam no limiter agregado por número empresarial. |
| Humano interrompe automação inclusive em job enfileirado | Teste scheduler + consumidor após assumir atendimento. |
| Estado Meta não regride; resposta HTTP não equivale a entregue | Eventos repetidos/fora de ordem e métricas de estado terminal. |
| Capacidade é mensurável sem prometer capacidade Meta | Carga sintética na VPS, reporte separado de throughput local e tier/limite externo. |
| Dados sensíveis não viram logs/export abertos | Revisão de ACL, logs, retenção, mídia, backup e governança antes do piloto. |

O desenho usa entidade de mensagem canônica para evitar timelines duplicadas, mas isso torna a migração um item de risco alto; o backfill e os serviços de campanha precisam ser atualizados na mesma sequência antes de liberar o inbox. A capacidade 5k/10k, o escopo de mídia e as regras institucionais são premissas/decisões mensuráveis, não funcionalidades já disponíveis.

## 12. Fora do escopo

Multitenancy; canais além de WhatsApp; cliente WhatsApp não oficial; voz/IA clínica; bot generativo; marketing/campanhas novas; edição/apagamento de mensagens após envio; chamadas; métricas punitivas individuais; exportação em massa; garantia de limite de envio imposto pela Meta.
