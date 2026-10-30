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
GUPSHUP_SOURCE=15559618824
GUPSHUP_APP_NAME=DoctorbotConfirma
GUPSHUP_API_URL=https://api.gupshup.io/wa/api/v1/template/msg
GUPSHUP_SESSION_MESSAGE_URL=https://api.gupshup.io/wa/api/v1/msg
GUPSHUP_TEMPLATE_FIRST_ID=dc67c2dc-3102-445d-ba77-7662243a2e42
GUPSHUP_TEMPLATE_SECOND_ID=ec210fc3-744a-4d6a-ad00-14304e9858c1
GUPSHUP_TEMPLATE_THIRD_ID=0598c34a-dca7-4ae9-b1a6-10defc9bcd89
AUTOMATIC_REPLY_ENABLED=true
AUTOMATIC_REPLY_CONFIRM_TEXT=Obrigado pela sua confirmação. Aguarde, em breve nossa equipe dará continuidade ao atendimento pelo whatsapp ou por ligação através do número (65) 3184-0054
AUTOMATIC_REPLY_CANCEL_TEXT=Seu cancelamento foi registrado. Não enviaremos novas convocações referentes a esta solicitação.
```

Defina exclusivamente no `confirma-worker`:

```text
MESSAGING_MODE=DRY_RUN
GUPSHUP_API_KEY=<secret configurado no EasyPanel>
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
# Deixe vazio ao receber a Gupshup diretamente. Preencha somente se um proxy
# confiável inserir o cabeçalho x-confirma-webhook-secret antes da API.
GUPSHUP_WEBHOOK_SECRET=
```

A API aplica as migrations e cria/atualiza automaticamente o administrador a cada inicialização. A senha é lida somente de `ADMIN_PASSWORD`; assim, alterar essa variável e reiniciar a API faz a rotação sem seed, terminal ou comando manual.

## Ordem de publicação

1. Crie PostgreSQL e Redis.
2. Crie API, web e worker pelo Git, configure as variáveis e publique. Não há comandos de bootstrap a executar: a API aplica migrations e provisiona o login automaticamente.
3. Publique inicialmente o worker com `MESSAGING_MODE=DRY_RUN` e `HANDOFF_MODE=DISABLED`.
4. Configure na Gupshup o callback público: `https://api.seu-dominio.com/api/webhooks/gupshup`, habilitando `enqueued`, `sent`, `delivered`, `read`, `failed`, eventos de cobrança e mensagens recebidas.
5. Faça uma campanha de homologação e confira banco, filas e painel.
6. Quando aprovado, altere as duas chaves de modo para `MESSAGING_MODE=LIVE` e `HANDOFF_MODE=LIVE`; o EasyPanel reinicia os containers automaticamente.

## Segurança operacional

- `GUPSHUP_API_KEY` é secret, nunca variável de build, arquivo `.env` versionado ou configuração do frontend.
- Como a chave anterior foi compartilhada, rotacione-a no painel Gupshup antes da produção.
- Mantenha `DRY_RUN` até concluir a homologação do webhook.
- Configure os valores `VIEW_EASYSAC_*` apenas como secrets do worker. Uma confirmação por botão cria um único transbordo idempotente, contendo o resumo do paciente e das solicitações; erros são reprocessados automaticamente até o limite configurado.
- Ative HTTPS no domínio API antes de registrar o webhook.
- Não configure `GUPSHUP_WEBHOOK_SECRET` esperando que a Gupshup envie esse cabeçalho. A variável serve somente quando um proxy reverso confiável o adiciona. Para chamadas diretas da Gupshup, mantenha-a vazia e restrinja a origem no proxy/firewall pelos IPs oficiais fornecidos pelo suporte da Gupshup.
- O endpoint valida também o campo `app` do payload contra `GUPSHUP_APP_NAME`, persiste o evento e responde `HTTP 204` antes de o worker executar as regras de negócio.
- Faça backup externo recorrente do PostgreSQL antes do piloto.
