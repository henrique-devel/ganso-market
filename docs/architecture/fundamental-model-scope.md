# Modelo fundamental Polymarket — escopo e limites (RFC-010)

Documento curto exigido pela RFC-010: **o que este módulo NÃO faz**. As
afirmações abaixo são normativas. Contrariar qualquer uma delas exige nova
decisão do proprietário e nova RFC, não um ajuste de código.

Código coberto: `apps/api/src/polymarket/fundamental/**`, o serviço
`polymarket-estimator` (`apps/api/src/polymarket-estimator.ts`) e a migration
`migrations/0006_polymarket_fundamental_model.sql`.

## O que este módulo NÃO faz

**1. Não executa nada.** A saída do módulo são linhas em
`fundamental_estimates` e os registros que as sustentam. Ele não cria ordem,
não cria ordem de papel, não cria sinal, não abre nem fecha posição e não toca
em wallet, signer, seed, private key ou qualquer credencial de trading. Não
existe caminho de execução atrás de feature flag.

> **FATO VERIFICADO:** a migration 0006 não declara nenhuma coluna de ordem,
> posição, tamanho executado, endereço ou credencial; nenhum arquivo de
> `apps/api/src/polymarket/fundamental/` referencia wallet, signer ou private
> key (a única ocorrência de "order" no módulo é `OrderBook`, a estrutura de
> leitura do livro gravado pela RFC-007, e cláusulas `ORDER BY`).

Execução real na Polymarket é escopo exclusivo da RFC-009 e de seus gates;
paper broker e portfólio são RFC-011 e RFC-013. Este módulo entrega `q`,
`q_lo` e `q_hi`; o que se faz com isso é decidido a jusante.

**2. Não existe modelo universal.** Cada modelo pertence a exatamente uma
categoria (`crypto_updown` ou `macro_scheduled`). É proibido treinar um modelo
único cross-categoria "para simplificar". Categoria sem modelo `active` fica no
baseline de mercado — permanentemente, se for o caso.

> **FATO VERIFICADO:** `fundamental_models.category` tem
> `CHECK (category IN ('crypto_updown', 'macro_scheduled'))` e o índice parcial
> `fundamental_models_active_uidx` garante no máximo um modelo `active` por
> categoria. O catálogo (`catalog.ts`) é fechado: uma família de modelo por
> categoria, sem ponto de extensão cross-categoria.

**3. O baseline de mercado não é desligável.** O microprice executável, calculado
do livro cru gravado, existe sempre que o livro é válido. Não há flag, config
ou endpoint que o desligue. Um modelo só substitui o baseline depois de passar
o gate e de ser promovido manualmente; qualquer anomalia devolve a estimativa
ao baseline.

**4. Passar o gate significa apenas "não piorar o baseline com CI 95%".** É um
critério de **não-inferioridade**: o limite superior do intervalo de confiança
95% (block bootstrap) da diferença modelo − baseline precisa ficar em zero ou
abaixo, para Brier e log loss, com no mínimo 100 mercados resolvidos cobertos e
sem fatia de horizonte degradando mais que 20% relativo.

Passar o gate **não** é edge líquido de custos, **não** é promessa de lucro e
**não** autoriza execução. Fees, spread executável, slippage, dimensionamento e
construção de portfólio são decididos a jusante (RFC-013). Nenhum texto de
código, doc, log ou UI deste módulo pode ser lido como afirmação sobre retorno.

**5. Validação é somente walk-forward temporal.** Treino sempre no passado da
validação, janelas deslizantes, incerteza por block bootstrap. **k-fold e
shuffle são proibidos** — eles quebram a ordem temporal e produzem métricas que
não existem fora do papel.

**6. Nenhum dado posterior à decisão entra como feature.** Todo join é as-of
pelo `source_ts` do dado (relógio da origem), com a exigência adicional de
`received_at <= decision_ts` onde a tabela tem esse campo. Bucket agregado de
1 minuto só é usado quando o bucket inteiro já está no passado.

`closedTime`, status UMA e `polymarket_resolution_events` **nunca** são feature.
O desfecho fica publicamente conhecível antes de a resolução onchain existir; o
label só indexa métricas pelo instante em que o desfecho ficou conhecível
(`fundamental_labels.publicly_knowable_ts`). Uma disputa UMA aberta entra no
caminho de decisão apenas como **veto** que força o baseline, nunca como
feature.

**7. A fronteira de regime de 28/abr/2026 (cutover CLOB V2) é dura.** Nenhum
conjunto de treino ou calibração cruza essa data sem o flag explícito
`regime_mix = true` no registro do modelo, e **modelo com `regime_mix = true`
nunca é promovível**. A migração V2 matou estratégias vivas em uma semana;
"ter mais dados" não é justificativa para ignorar a fronteira.

> **FATO VERIFICADO:** a constraint `fundamental_models_regime_boundary` recusa
> janela que cruze `2026-04-28 00:00:00+00` sem `regime_mix`, e
> `fundamental_models_regime_mix_never_active` recusa `status = 'active'` com
> `regime_mix`. A mesma regra é repetida em código
> (`assertRegimeBoundary`, `REGIME_V2_CUTOVER`) e na cláusula `WHERE` da
> promoção.

**8. Favorite-longshot bias não é tratado como edge.** A evidência é
conflitante (presente em Kalshi e corridas de cavalo; ausente na Polymarket no
único backtest com custos reais). Nenhum modelo deste módulo assume o viés. Se
algum modelo futuro quiser explorá-lo, o viés precisa ser medido por categoria
no pipeline próprio, pós-V2, antes de virar feature.

**9. Não fabrica número.** Métrica sem observação não vira zero: taxa de
fallback sobre janela vazia é `null`, não `0`. Modelo sem calibração
walk-forward serve o mapa base cru, e isso é estado honesto, não degradação.
Mercado cuja regra versionada não parseia de forma inequívoca é **excluído** do
modelo e fica no baseline — inventar um strike ou um limiar seria fabricar
alpha.

**10. Não usa LLM local, GPU nem serviço externo pago.** Treino e calibração
rodam em batch no próprio CPX42. Interpretação de ambiguidade de regra por NLP
é escopo do modelo de risco de resolução (RFC futura), não desta.

## O que este módulo faz

Para cada token do universo da RFC-007 e cada instante de decisão, responde
"qual é nossa probabilidade estimada do YES e qual é a incerteza dela?", de
forma reprodutível e auditável:

| Etapa                    | Responsável                          | Resultado                                                                |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------------ |
| Prior de mercado         | `microprice.ts`                      | microprice executável do livro cru a `S_ref`, ou livro inválido           |
| Features as-of           | `features.ts`                        | livro, TWAP Chainlink, calendário/release macro, regra versionada         |
| Modelo da categoria      | `models/crypto-updown.ts`, `models/macro-scheduled.ts` | `q` e dispersão `sigma`, ou abstenção explícita       |
| Incerteza                | `interval.ts`                        | `[q_lo, q_hi]` central de 90%, determinístico e versionado                |
| Decisão/fallback         | `estimate.ts` (função pura, sem I/O) | linha de consumidor + linhas shadow, ou ausência explícita                |
| Label store              | `labels.ts`                          | `{0, 0.5, 1}` com instante publicamente conhecível                        |
| Walk-forward + bootstrap | `walkforward.ts`                     | Brier/log loss vs baseline, CI 95%, reliability, cobertura do intervalo   |
| Gate                     | `gate.ts`                            | `PASS` ou `NO_EVIDENCE_OF_ALPHA` com todos os critérios reprovados        |
| Ciclo de vida            | `registry.ts`                        | registro imutável, promoção manual, kill manual, revalidação obrigatória  |
| Leitura                  | `api.ts`                             | endpoints autenticados de leitura e as duas transições manuais            |

Toda probabilidade cruza fronteira como string decimal canônica de exatamente
seis casas (`PROB_DIGITS = 6`); preço, tamanho e nocional são aritmética exata
em `BigInt` escalado por `10^9` (`fixed.ts`). Internos estatísticos (caudas
normal/t, EWMA, regressão logística) usam double, e o resultado é quantizado de
volta para a string canônica antes de sair — por isso a mesma entrada e a mesma
versão produzem os mesmos bytes.

## Tabelas que este módulo possui

| Tabela                             | Conteúdo                                                        | Retenção                       |
| ---------------------------------- | --------------------------------------------------------------- | ------------------------------ |
| `fundamental_models`               | uma linha por VERSÃO treinada; identidade imutável (trigger)     | nunca podada (protegida)       |
| `fundamental_estimates`            | a saída única: `q`, `q_lo`, `q_hi`, proveniência, flags          | TTL 90 dias                    |
| `fundamental_gate_reports`         | avaliações de gate com métricas, CI e critérios reprovados       | nunca podada (protegida)       |
| `fundamental_labels`               | mercados resolvidos com label `{0, 0.5, 1}`                      | nunca podada (protegida)       |
| `fundamental_model_events`         | trilha imutável: registro, gate, promoção, kill, revalidação     | nunca podada (protegida)       |
| `fundamental_calibration_reports`  | relatório diário materializado por categoria/modelo              | nunca podada (protegida)       |

`fundamental_estimates` carrega constraints que tornam proveniência incompleta
impossível: linha `source = 'MODEL'` exige `model_id`, `model_version`,
`feature_set_version`, `git_sha` e `data_refs` não nulos; linha
`source = 'MARKET_BASELINE'` exige `fallback_reason` e `data_refs` não nulos e
proíbe `model_id`; `q_lo <= q <= q_hi` é constraint, não convenção; e
`status = 'shadow'` só existe com `source = 'MODEL'`.

## Artefatos versionados

Toda estimativa é reproduzível a partir do conjunto de versões que a produziu.
Mudança em qualquer definição abaixo **exige bump da versão correspondente**, o
que invalida calibrações que citavam a versão antiga.

| Versão                       | Valor atual              | O que congela                                                        |
| ---------------------------- | ------------------------ | -------------------------------------------------------------------- |
| `MICROPRICE_VERSION`         | `1.0.0`                  | fórmula do microprice executável e regras de invalidação do livro     |
| `INTERVAL_VERSION`           | `1.0.0`                  | composição de `[q_lo, q_hi]`: piso estrutural, z(90%), alargamentos   |
| `FEATURE_SET_VERSION`        | `1.0.0`                  | camada as-of compartilhada (`features.ts`)                            |
| `CRYPTO_FEATURE_SET_VERSION` | `1.0.0`                  | conteúdo e ordem da linha de features do `crypto_updown`              |
| `MACRO_FEATURE_SET_VERSION`  | `1.0.0`                  | chaves de consenso/dispersão, matching de calendário, regime macro    |
| `model_version` (semver)     | por linha do registry    | hiperparâmetros, seed e janelas de treino daquela versão              |
| `git_sha`                    | revisão do código        | o binário que produziu a linha                                        |

Famílias de modelo registradas: `crypto_updown_gbm` (versão `1.0.0`) e
`macro_scheduled_consensus` (versão `1.0.0`). Toda rodada de treino cria uma
versão nova; versões são imutáveis (trigger `fundamental_models_guard_trg`
recusa alteração de identidade e recusa `DELETE`).

`git_sha` chega ao container por `deploy/release-sha`, reescrito pelo
`export-subst` do `git archive` no release; `GANSO_GIT_SHA` sobrepõe. **Quando
o SHA não pode ser resolvido, nenhum modelo serve** — o fallback é
`PROVENANCE_UNAVAILABLE` e o baseline continua. Estimativa sem proveniência
completa é bug, não degradação aceitável.

## Escada de fallback

O fallback é código puro-função (`estimate.ts`), sem I/O além do livro já lido,
e nunca lança erro ao consumidor. A ordem abaixo é a ordem real de avaliação;
o primeiro critério que dispara define `fallback_reason`.

### Antes de tudo: livro inválido ⇒ ausência de estimativa

Livro inválido **não** produz linha. A ausência é o veto, e o consumidor a trata
como veto — nunca como valor default. Motivos (`BookInvalidReason`), contados no
log do ciclo em `absent_reasons`:

| Motivo             | Condição                                                                   |
| ------------------ | -------------------------------------------------------------------------- |
| `NO_BOOK`          | sem snapshot/deltas até o instante, lado vazio ou nível ilegível            |
| `BOOK_STALE`       | livro mais velho que `max_book_age_ms` (default 30 s) no instante           |
| `BOOK_CROSSED`     | melhor bid ≥ melhor ask: o estado gravado não é livro negociável            |
| `DEPTH_BELOW_SREF` | um dos lados não completa `S_ref` (default US$ 100) de nocional             |
| `SPREAD_TOO_WIDE`  | spread executável a `S_ref` acima de `max_exec_spread` (default 0,10)       |

### Livro válido: degradação para `MARKET_BASELINE`

Com livro válido sempre existe linha de consumidor. Ela é `MODEL` apenas quando
um modelo **promovido** serviu; em qualquer outro caso é `MARKET_BASELINE` com o
intervalo do baseline alargado por `fallback_widen_factor` (default 1,5×) — o
fallback é sempre **mais** incerto, nunca menos.

Motivos (`FallbackReason`, `types.ts`), na ordem de precedência de
`resolveAttempt`/`decideEstimate`. A distinção entre os dois primeiros estados
é deliberada: `NO_ACTIVE_MODEL` diz que nada foi registrado para a categoria,
`MODEL_IN_SHADOW` diz que existe modelo e o que falta é o gate.

| Ordem | `fallback_reason`         | Quando dispara                                                                            |
| ----- | ------------------------- | ----------------------------------------------------------------------------------------- |
| 1     | `NO_ACTIVE_MODEL`         | a categoria não tem modelo promovido **nem** modelo em shadow: nada foi registrado ainda   |
| 2     | `UMA_DISPUTE_ACTIVE`      | disputa UMA aberta no mercado no instante da decisão — veto, vence qualquer modelo         |
| 3     | `PROVENANCE_UNAVAILABLE`  | `git_sha` não resolvido: nenhuma linha `MODEL` pode ser escrita                            |
| 4     | `RULE_NOT_PARSEABLE`      | a regra versionada não parseia de forma inequívoca; o mercado fica no baseline             |
| 4     | `MODEL_ABSTAINED`         | o modelo se recusa a falar (histórico insuficiente, consenso ausente, série faltando)      |
| 4     | `MODEL_ERROR`             | exceção do modelo (capturada em `catalog.ts`) ou `q` não finito                            |
| 4     | `MODEL_TIMEOUT`           | declarado no contrato; **sem emissor no código atual**                                     |
| 5     | `FEED_STALE`              | amostra do feed resolutor mais velha que `crypto.max_feed_age_ms` (default 120 s)          |
| 6     | `MODEL_IN_SHADOW`         | existe modelo em `shadow` na categoria e nenhum promovido: a linha shadow é gravada, o consumidor lê baseline |
| —     | `GATE_FAILED`             | declarado no contrato; **sem emissor no código atual**                                     |
| —     | `CATEGORY_NOT_MODELLED`   | declarado no contrato; **sem emissor no código atual**                                     |

> **FATO VERIFICADO:** busca por cada literal em
> `apps/api/src/polymarket/fundamental/` encontra emissor para oito dos onze
> motivos. `MODEL_TIMEOUT`, `GATE_FAILED` e `CATEGORY_NOT_MODELLED` existem no
> tipo `FallbackReason` e não são emitidos hoje.
>
> **INFERÊNCIA:** reprovação de gate aparece na prática como
> `NO_ACTIVE_MODEL`/`MODEL_IN_SHADOW`, porque um modelo `active` que perde o
> gate é rebaixado para `shadow` na mesma chamada (`runGate`) e o ciclo
> seguinte já não o encontra promovido — por isso `GATE_FAILED` não tem
> emissor. Nenhum dos três motivos pode ser removido do tipo sem revisão: eles
> são contrato compartilhado com as RFC-011/013.

Linhas `shadow` são material de gate, invisíveis ao consumidor: `api.ts` só as
devolve com `include_shadow=true` e nunca em `/polymarket/estimates/latest`.

## Fronteiras com outras RFCs

- **RFC-007** é a única fonte dos dados: livro, trades, regras/params
  versionados, status UMA, RTDS crypto e calendário macro. Este módulo lê essas
  tabelas e não coleta nada por conta própria.
- **RFC-011** (microestrutura/paper broker) consome `q` e `q_lo`. A biblioteca
  do microprice executável é compartilhada — por isso é versionada.
- **RFC-013** (sinais e portfólio) decide o que fazer com a estimativa,
  inclusive custos e dimensionamento. Nada disso existe aqui.
- **RFC-009** (execução real, burn wallet) não tem nenhum ponto de contato com
  este módulo.
