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

## Núcleo BTC — `trading.v1` (RFC-045 S1)

Importar `@ganso-market/contracts/trading` ou o namespace `trading` da raiz.
Os tipos e parsers novos não importam `polymarket/*` nem mudam os schemas v1
anteriores. Não há banco, broker, signer, seleção por variável de ambiente ou
worker neste pacote. `mode` é obrigatório e aceita apenas `paper`; campos
extras (inclusive credenciais) são rejeitados.

| Unidade | Casas decimais | Semântica |
| --- | --- | --- |
| `BTC` | 8 | Quantidade; ordens/fills exigem valor positivo |
| `USD` | 6 | Dinheiro/PnL assinado |
| `USD_PER_BTC` | 6 | Preço positivo no instrumento/ordem/fill, sem teto de 1 |
| `RATE` | 9 | Razão assinada; `0.01` significa 1%, não 1 basis point |
| `PROBABILITY` | 6 | Intervalo fechado [0, 1], sem clamp |

Cada valor JSON tem **somente** `{ unit, decimals, raw }`; `raw` é o inteiro
decimal canônico de `MoneyAmount`, e o valor humano é `raw × 10^-decimals`.
`parseTradingAmount` reaproveita a conversão exata já existente. A política
de fronteira é `reject_inexact`: não arredonda, trunca, reescala ou aceita
float. Tick e lote são metadados positivos versionados do instrumento;
`assertTradingQuantum` verifica divisibilidade com bigint. Aritmética e
conversão de escalas ficam para G2-03.2, com política explícita por operação.
Essas escalas são do domínio, não uma afirmação sobre regras atuais da venue.

Todos os timestamps têm forma canônica UTC `YYYY-MM-DDTHH:mm:ss.sssZ`, com
validação do calendário. Dados públicos carregam instrumento/revisão, fonte,
ID do evento da fonte, hash do payload, versão do parser, tempo da fonte e de
recebimento e qualidade declarada. Dados stale/unknown permanecem assim;
este pacote não calcula frescor. Decisões não admitem entradas posteriores ao
instante da decisão. Fills exigem evidência identificada de livro/trade fresh;
isso valida o contrato, não prova liquidez ou executa uma simulação.

`parseTradingContract(kind, unknown)` valida forma e invariantes locais.
Nas fronteiras entre entidades, usar `parseTradingIntent` com conta,
experimento e instrumento; `parseTradingOrder` com intenção/instrumento;
`parseTradingExecution` com ordem/instrumento. Eles verificam propriedade,
referências, tick/lote e a preservação dos termos. IOC sempre tem preço limite;
GTD exige expiração futura. Uma execução pode ser parcial, sem ultrapassar
quantidade/preço da ordem. Qualquer parser rejeita com `TypeError`, sem defaults.

IDs são opacos, ASCII alfanumérico com `._:/-`, iniciando por alfanumérico,
de 1 a 192 caracteres. Produtores atribuem IDs lógicos estáveis antes de enviar;
retries reutilizam o mesmo ID. `tradingIdempotencyKey` codifica uma tupla JSON
com versão do contrato, modo, conta, experimento, instrumento, tipo e ID lógico.
`tradingDataKey` usa versão do contrato, instrumento, fonte, tipo e ID na fonte.
Tempo de recebimento, revisão de metadados, revisão do parser e conteúdo não
criam uma nova identidade. Na persistência futura, mesma chave/conteúdo é
replay; mesma chave/conteúdo divergente é conflito, nunca overwrite. A revisão
do instrumento continua obrigatória e deve coincidir entre as entidades.

O ledger perpétuo é um envelope append-only por dono, com chave idempotente,
sequência inteira positiva por conta, transação atômica, causa e tempos
econômico/de registro separados. Suporta caixa, reserva/liberação de margem,
fill, fee, funding, PnL realizado, mark, liquidação e reversão referenciada.
`delta` positivo credita caixa e negativo debita; `execution.fee` positivo é
cobrança e vira delta negativo no evento `fee`. Margem move disponibilidade,
sem mudar caixa; mark/unrealized PnL não realiza caixa; liquidação referencia
a execução, sem contabilizar um segundo fill. Funding declara período [início,
fim), taxa e origem, podendo chegar depois do instante econômico. Correções
usam novos eventos de reversão; não reescrevem eventos anteriores.

Unicidade, atomicidade, validade das referências persistidas, ordem de
sequência, soma de fills, reservas, fold de saldo/PnL e retomada são obrigações
dos próximos blocos de armazenamento/broker. Este contrato não as implementa.
Conta é associada a um experimento; propósito é manual/baseline/challenger.
Origem da decisão distingue operador, estratégia versionada e filtro de modelo
com resposta identificada; não concede autoridade de execução a um modelo.

## Comandos

No workspace npm do repositório:

```sh
npm run check --workspace @ganso-market/contracts
npm test --workspace @ganso-market/contracts
npm run build --workspace @ganso-market/contracts
```

## JEV v2 (JE02)

`trading.jev.v2` is exported through the existing `/trading` entrypoint. Profiles,
financial accounts and immutable experiment bindings are separate identities.
Every decision/order/fill boundary can use `assertJevOwnership`; ledger keys bind
owner, account, mode, profile/version, experiment and instrument/version.
`trading.v1` remains readable and paper-only, with its historical US$1,000 genesis.

The dormant JEV registry uses additive migration 0051 and independent `jev_*`
tables. Paper/stress each allocate US$250 once. Live reserves one durable,
unfunded identity (zero ledger cash); only later venue reconciliation can admit
real funding. No registration creates a signer, route, worker or active executor.
The three pair slots and live singleton are SQL constraints. Profiles/manifests,
bindings, transactions and events are append-only; a new material version starts
unqualified and cannot reuse a previous manifest fingerprint.

Initial manifests are `config/trading/jev/horizon-{1,3,5}.json`. Their only semantic
difference is the economic horizon. A pinned provider/model must be selected
before admission; this delivery makes no external model call. Context uses top-five
book depth, a 60-second observed trade window, fifteen closed 15-minute bars,
ceiling mean TR14, simple normalized RSI14 and 15/45/75-minute close returns.
Money/prices use six decimals, BTC eight, ratios nine (toward zero); depth/mid/VWAP
round down. Signed funding remains current context, never a settled payment.
Original source/receipt/persistence times and dependency references are preserved;
missing coverage/bars/dependencies remain incomplete, with public continuity unproven.

Cadence is 60 seconds, or 2 seconds with an open position and half-ATR movement
from the last decision or half-ATR stop proximity. Fast mode lasts at least 10 and
at most 30 seconds, with 60 seconds cooldown. Response deadline is 1.5 seconds;
decisions expire 2 seconds after the context cut. Book/account freshness is 2 seconds,
mark/funding 10 seconds. Flow/liquidity alone never activates fast mode.

Stop distance is fixed at 2 ATR14 captured before entry, anchored to the first
fill price, rounded toward entry on the full venue price grid. Later partials
only change protected quantity. The six-hour clock starts at the first fill;
stop, elapsed time, risk and missing protection can request an IOC reduce-only
close independently of JEV. These are pure contracts, without a scheduler.
Risk, execution, exits, freshness and cadence are frozen generator components;
one reviewed horizon/window/information-set change creates a new fingerprint.
Reporting windows never reset financial lifetime. Operational admission remains
in the separately selected checkpoints.
