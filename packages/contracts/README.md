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
