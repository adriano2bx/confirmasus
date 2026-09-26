# Confirma SUS

Monorepo do MVP de automação das convocações SUS por WhatsApp.

## Aplicações

- `apps/web`: painel administrativo em Next.js.
- `apps/api`: API HTTP em NestJS.
- `apps/worker`: processamento assíncrono e scheduler.
- `packages/database`: modelo e cliente Prisma.
- `packages/domain`: regras e tipos compartilhados.
- `packages/queue`: contratos e conexão BullMQ.

## Desenvolvimento local

1. Copie `.env.example` para `.env` e troque o `JWT_SECRET`.
2. Inicie PostgreSQL e Redis com `docker compose up -d postgres redis`.
3. Execute `pnpm install`.
4. Execute `pnpm db:generate` e `pnpm db:migrate`.
5. Execute `pnpm dev`.

## Fluxo disponível

1. Faça login e envie um PDF.
2. O worker extrai os registros e elimina o PDF depois de persistir o resultado.
3. Abra a importação, revise alertas e registros inválidos e aprove os dados válidos.
4. Crie uma campanha em `DRAFT`; pacientes são agrupados por CPF ou por nome normalizado + nascimento.
5. Programe a campanha: scheduler + BullMQ executam primeira, segunda e terceira tentativas.
6. Confirmação ou cancelamento por botão encerra a convocação; ausência de resposta avança tentativas e, depois da terceira, finaliza após `FINAL_RESPONSE_WINDOW_DAYS`.
7. Consulte o painel em `/painel`, a lista em `/convocacoes` e exporte CSVs pelas rotas protegidas de relatórios.
8. O administrador provisionado por `ADMIN_*` pode criar, desativar e redefinir a senha de operadores persistidos no PostgreSQL.

Campanhas podem ser programadas e executadas por scheduler. O envio começa em `DRY_RUN`; somente o worker com `MESSAGING_MODE=LIVE` e credenciais da WhatsApp Cloud API configuradas realiza disparos reais. O webhook da Meta está disponível em `/api/webhooks/meta`.

O PDF é temporário: o arquivo só deverá ser removido depois que seus dados forem
persistidos. O PostgreSQL é a fonte de verdade dos agendamentos; Redis/BullMQ serve
somente para execução assíncrona.

Para implantação no EasyPanel, o `Dockerfile` da raiz executa web, API e worker
em um único serviço de homologação na porta 3000. Para escalar os componentes
separadamente, utilize os Dockerfiles em `docker/`. Consulte
[o guia de produção](docs/easypanel.md).

Para medir a capacidade da API em homologação, consulte o [guia de teste de carga](docs/teste-de-carga.md) e execute `pnpm load:test`.

## Pendências antes do piloto

- Validar e ajustar o parser contra PDFs SISREG reais anonimizados.
- Configurar domínio HTTPS, callback de webhooks da Meta e secrets no EasyPanel.
- Configurar backup externo recorrente do PostgreSQL e executar um teste de restauração.
