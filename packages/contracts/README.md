# `@ganso-market/contracts`

Contratos de fronteira compartilhados da RFC-001. Este pacote contém apenas
tipos, schemas JSON e conversões exatas; ele não contém autenticação, ingestão,
estratégia, assinatura ou execução.

## Invariantes de v1

- Schemas são JSON Schema Draft 2020-12 sob `schemas/v1`. Um contrato publicado
  em `v1` não é alterado de forma incompatível; breaking changes criam `v2`.
- Nomes JSON usam `snake_case`. IDs são strings opacas e não vazias, salvo
  restrição mais específica declarada pelo schema.
- Todos os timestamps são RFC3339 em UTC e usam o sufixo canônico `Z`.
- `commitment` é sempre declarado como `processed`, `confirmed` ou `finalized`;
  commitments diferentes não são intercambiáveis.
- `MoneyAmount.raw` é um inteiro matemático na menor unidade do ativo. Na
  fronteira JSON ele é uma string decimal canônica para preservar exatidão:
  `0` ou `-?[1-9][0-9]*`. Expoente, ponto decimal, `+`, zeros à esquerda e `-0`
  são inválidos.
- `MoneyAmount.decimals` declara a escala base-10, de 0 a 255.
  O valor humano é `raw × 10^-decimals`; este pacote não faz essa conversão.
- `MoneyAmount.asset_id` declara o ativo/moeda da quantia e não pode ser vazio.
- Internamente, `MoneyAmount.raw` usa `bigint`. Os helpers nunca convertem esse
  campo por `Number`, `parseInt` ou ponto flutuante.
- `age_ms` e `max_age_ms` são durações inteiras, não valores financeiros.
- `ReasonCode` usa uppercase snake case, sem espaços ou pontuação livre.
- Correlation IDs começam por caractere alfanumérico, usam somente ASCII
  alfanumérico, ponto, underscore ou hífen e têm no máximo 64 caracteres.
- `ExecutionMode` aceita exclusivamente `paper` nesta versão.

## Validação

Consumidores devem carregar todos os schemas v1 no Ajv 2020 e registrar
`ajv-formats`, pois os campos temporais usam `format: date-time`. A validação
deve falhar fechada para propriedades extras ou referências desconhecidas.

```ts
import { parseMoneyAmount, serializeMoneyAmount } from "@ganso-market/contracts";

const amount = parseMoneyAmount({
  raw: "9007199254740993123456789",
  decimals: 9,
  asset_id: "SOL",
});

serializeMoneyAmount(amount);
```

## Comandos

No workspace npm do repositório:

```sh
npm run check --workspace @ganso-market/contracts
npm test --workspace @ganso-market/contracts
npm run build --workspace @ganso-market/contracts
```
