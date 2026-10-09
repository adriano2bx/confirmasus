# API de custos

Os dados financeiros não são enviados ao dashboard nem exibidos no painel web. O acesso é exclusivo para usuários `ADMIN` autenticados com Bearer Token.

## Endpoints

- `GET /api/billing/events` — eventos paginados.
- `GET /api/billing/summary` — totais consolidados.
- `GET /api/billing/campaigns/:campaignId` — resumo de uma campanha.

## Filtros

| Parâmetro            | Descrição                              |
| -------------------- | -------------------------------------- |
| `dateFrom`, `dateTo` | Período em ISO 8601.                   |
| `campaignId`         | UUID da campanha.                      |
| `messageId`          | UUID interno da mensagem.              |
| `providerMessageId`  | Identificador retornado pelo provedor. |
| `stage`              | `FIRST`, `SECOND` ou `THIRD`.          |
| `category`           | Categoria informada pelo provedor.     |
| `status`             | Status do evento de cobrança.          |
| `billable`           | `true` ou `false`.                     |
| `currency`           | Moeda, por exemplo `BRL`.              |
| `page`, `limit`      | Paginação; limite máximo de 250.       |
| `sortBy`             | `billingAt`, `cost` ou `createdAt`.    |
| `sortOrder`          | `asc` ou `desc`.                       |

Exemplo:

```http
GET /api/billing/events?dateFrom=2026-08-01T00:00:00-03:00&dateTo=2026-08-31T23:59:59-03:00&campaignId=UUID&stage=SECOND&billable=true&currency=BRL&page=1&limit=100
Authorization: Bearer TOKEN_ADMIN
```

Valores decimais são retornados como string para evitar perda de precisão.

Na integração com a WhatsApp Cloud API, os webhooks de status podem incluir os
metadados de preço `billable`, `category` e `pricing_model`. Eles não incluem o
valor monetário por mensagem; por isso `cost` e `currency` permanecem `null`, e
`totalCost` não representa a fatura da Meta. Consulte a cobrança no WhatsApp
Manager para obter os valores faturados.
