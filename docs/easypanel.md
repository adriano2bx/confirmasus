# Implantação no EasyPanel

## Opção recomendada para homologação: um único serviço

Crie uma aplicação pelo Git usando o `Dockerfile` da raiz e exponha a porta
`3000`. Esse container executa automaticamente o painel, a API e o worker. A
API fica disponível no mesmo domínio em `/api`, sem necessidade de expor a
porta 3001 ou configurar `localhost` no navegador.

No EasyPanel:

```text
Dockerfile: Dockerfile
Porta: 3000
NEXT_PUBLIC_API_URL: /api
NEXT_PUBLIC_APP_TIMEZONE: America/Sao_Paulo
```

Não é necessário configurar comando de inicialização. O container aplica as
migrations, provisiona o login das variáveis `ADMIN_*` e inicia os três
processos automaticamente.

Configure `DATABASE_URL`, `REDIS_URL` e todas as demais variáveis desta página
como variáveis de ambiente em tempo de execução. Secrets não devem ser
configurados apenas como argumentos de build.

Cadastre e aprove no WhatsApp Manager os três modelos usados nas convocações,
com idioma `pt_BR`, um parâmetro de texto no corpo para o nome do paciente e
dois botões de resposta rápida nesta ordem: confirmação e cancelamento. Os
modelos atualmente aprovados usam os textos `Confirmar` / `Cancelar` na primeira
etapa, `Quero confirmar` / `Quero Cancelar` na segunda e `Vou Confirmar` /
`Vou cancelar` na terceira. O envio associa os payloads `CONFIRM` e `CANCEL`
aos índices 0 e 1 desses botões.
Use os nomes exatos dos modelos nas variáveis `META_TEMPLATE_*_NAME`.

## Opção para escala independente: três serviços

Crie serviços separados a partir do mesmo repositório Git:

| Serviço           | Dockerfile                 | Porta |       Réplicas |
| ----------------- | -------------------------- | ----: | -------------: |
| `confirma-web`    | `docker/Dockerfile.web`    |  3000 |              1 |
| `confirma-api`    | `docker/Dockerfile.api`    |  3001 |              1 |
| `confirma-worker` | `docker/Dockerfile.worker` |     — | 1 inicialmente |

Configure um serviço PostgreSQL e um Redis pelo catálogo do EasyPanel. Não exponha as portas desses serviços publicamente. Use os endereços internos que o EasyPanel fornecer em `DATABASE_URL` e `REDIS_URL`.

## Variáveis compartilhadas

Defina em `confirma-api` e `confirma-worker`:

```text
NODE_ENV=production
APP_TIMEZONE=America/Sao_Paulo
DATABASE_URL=<URL interna do PostgreSQL com ?schema=public>
REDIS_URL=<URL interna do Redis>
JWT_SECRET=<texto aleatório com no mínimo 32 caracteres>
UPLOAD_TEMP_DIR=/tmp/confirma-sus
META_WHATSAPP_PHONE_NUMBER_ID=<ID do número no WhatsApp Manager>
META_WHATSAPP_LANGUAGE=pt_BR
META_GRAPH_API_VERSION=v22.0
META_TEMPLATE_FIRST_NAME=primeira_convocacao_sus_unico
META_TEMPLATE_SECOND_NAME=segunda_convocacao_sus
META_TEMPLATE_THIRD_NAME=terceira_convocacao_sus
AUTOMATIC_REPLY_ENABLED=true
AUTOMATIC_REPLY_CONFIRM_TEXT=Recebemos sua confirmação. Aguarde, em breve nossa equipe dará continuidade ao atendimento.
AUTOMATIC_REPLY_CANCEL_TEXT=Seu cancelamento foi registrado. Não enviaremos novas convocações referentes a esta solicitação.
```

Defina exclusivamente no `confirma-worker`:

```text
MESSAGING_MODE=DRY_RUN
META_WHATSAPP_ACCESS_TOKEN=<token permanente da Meta>
SCHEDULER_INTERVAL_MS=10000
MESSAGE_WORKER_CONCURRENCY=5
WEBHOOK_WORKER_CONCURRENCY=10
FINAL_RESPONSE_WINDOW_DAYS=1
MESSAGE_RATE_LIMIT_MAX=20
MESSAGE_RATE_LIMIT_DURATION_MS=1000
TEMP_FILE_MAX_AGE_HOURS=24
HANDOFF_MODE=LIVE
HANDOFF_WORKER_CONCURRENCY=3
HANDOFF_MAX_ATTEMPTS=5
VIEW_EASYSAC_WEBHOOK=<webhook da View/EasySAC>
VIEW_EASYSAC_ORG_ID=<secret>
VIEW_EASYSAC_APP_KEY=<secret>
VIEW_EASYSAC_CHANNEL_ID=<secret>
VIEW_EASYSAC_QUEUE_ID=<secret>
VIEW_EASYSAC_CHANNEL_TYPE=whatsapp
# Opcional: fallback compatível com a API de chat da OpenAI para registros
# SISREG com baixa confiança. Desligado por padrão; configure apenas se houver
# autorização para enviar esses dados ao endpoint escolhido.
SISREG_AI_FALLBACK_ENABLED=false
SISREG_AI_ENDPOINT=https://<endpoint>/v1/chat/completions
SISREG_AI_API_KEY=<secret>
SISREG_AI_MODEL=gpt-4o-mini
```

Defina exclusivamente no `confirma-web`:

```text
NEXT_PUBLIC_API_URL=https://api.seu-dominio.com/api
NEXT_PUBLIC_APP_TIMEZONE=America/Sao_Paulo
```

Como variáveis `NEXT_PUBLIC_*` são incorporadas durante a compilação do Next.js,
configure esses mesmos valores também como argumentos de build do serviço web no EasyPanel.

Defina exclusivamente no `confirma-api`:

```text
API_PORT=3001
JWT_EXPIRES_IN=8h
ADMIN_NAME=Administrador
ADMIN_EMAIL=<e-mail de acesso>
ADMIN_PASSWORD=<senha forte com ao menos 12 caracteres>
META_APP_SECRET=<app secret da Meta>
META_WEBHOOK_VERIFY_TOKEN=<token de verificação escolhido por você>
```

A API aplica as migrations e cria/atualiza automaticamente o administrador a cada inicialização. A senha é lida somente de `ADMIN_PASSWORD`; assim, alterar essa variável e reiniciar a API faz a rotação sem seed, terminal ou comando manual.

## Ordem de publicação

Ao substituir uma implantação Gupshup pela versão Meta, finalize as campanhas
Gupshup e aguarde suas respostas pendentes antes da troca. Esta branch recebe
somente webhooks da Meta; respostas antigas enviadas ao callback Gupshup não
serão processadas por ela.

1. Crie PostgreSQL e Redis.
2. Crie API, web e worker pelo Git, configure as variáveis e publique. Não há comandos de bootstrap a executar: a API aplica migrations e provisiona o login automaticamente.
3. Publique inicialmente o worker com `MESSAGING_MODE=DRY_RUN` e `HANDOFF_MODE=DISABLED`.
4. Configure no painel de desenvolvedores Meta o callback HTTPS `https://api.seu-dominio.com/api/webhooks/meta`, use `META_WEBHOOK_VERIFY_TOKEN` e assine o campo `messages` da conta WhatsApp Business.
5. Faça uma campanha de homologação e confira banco, filas e painel.
6. Quando aprovado, altere as duas chaves de modo para `MESSAGING_MODE=LIVE` e `HANDOFF_MODE=LIVE`; o EasyPanel reinicia os containers automaticamente.

## Segurança operacional

- `META_WHATSAPP_ACCESS_TOKEN` e `META_APP_SECRET` são secrets, nunca variáveis de build, arquivo `.env` versionado ou configuração do frontend.
- Mantenha `DRY_RUN` até concluir a homologação do webhook.
- Configure os valores `VIEW_EASYSAC_*` apenas como secrets do worker. Uma confirmação por botão cria um único transbordo idempotente, contendo o resumo do paciente e das solicitações; erros são reprocessados automaticamente até o limite configurado.
- Ative HTTPS no domínio API antes de registrar o webhook.
- O endpoint valida `X-Hub-Signature-256` com o app secret da Meta, persiste cada status/mensagem e responde `HTTP 204` antes de o worker executar as regras de negócio.
- Faça backup externo recorrente do PostgreSQL antes do piloto.
