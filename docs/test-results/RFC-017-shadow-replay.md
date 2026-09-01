# RFC-017 — shadow replay: resultados da primeira rodada real

Ferramenta entregue nos PRs [#72](https://github.com/henrique-devel/ganso-market/pull/72)
e [#73](https://github.com/henrique-devel/ganso-market/pull/73). Este arquivo
guarda a **saída verbatim** das duas primeiras rodadas em produção, os fatos que
elas mediram e as três premissas do escopo de 2026-08-28 que a medição desmente.

- Servidor: `178.105.65.251`; `release-sha` dentro da `api`:
  `78333343b04b885872505d74c654d265b1aea05e`
- Janela varrida: `--to 2026-09-01T14:25:00Z`, fechada no `decision_id 703817`
- Modo de execução: **somente leitura por construção** — allowlist de statement
  mais `SET TRANSACTION READ ONLY` dentro da transação de cada leitura. Nenhuma
  linha foi escrita em nenhuma tabela.

---

## Resumo em uma tela

| Pergunta                                                         | Resposta medida                                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| O replay reproduz o log inteiro, não só a amostra horária de 50? | **Sim: 224 647 de 224 647 admitidas**, zero `BASELINE_MISMATCH`                                 |
| Quantas decisões uma chave de custo pode mover?                  | **20 340 (9,05%)**, em **65 dos 322** mercados — as outras 91% foram decididas antes da conta   |
| Subir `capitalCostAnnual` até 0,40 muda o que o motor FAZ?       | **Não. 0 linhas, 0 mercados, nos 8 candidatos**                                                 |
| Então até onde a taxa teria que ir?                              | **Além de 1000 (100 000% a.a.)** — a busca de AÇÃO não acha nada no bracket                     |
| Quanto da folga o maior candidato consome?                       | **0,4284%** a r=0,40                                                                            |
| E se a fonte fosse o shadow?                                     | **519 linhas (20,1%) e 9 mercados (40,9%) agiriam diferente**; 511 entradas só do shadow         |
| O PnL contrafactual dessas entradas?                             | **Não medível ainda**: 515 entradas, **0** com label final                                      |

---

## Modo A — varredura de `costs.capitalCostAnnual` (verbatim)

Comando:

```sh
docker compose --env-file deploy/server.env exec -T api \
  node apps/api/dist/shadow-replay-cli.js sweep costs.capitalCostAnnual \
  --values 0.12,0.15,0.183,0.20,0.25,0.30,0.365,0.40 --to 2026-09-01T14:25:00Z
```

```text
# RFC-017 mode A — sweep of costs.capitalCostAnnual

## Population (the denominator, stated three ways)

  decisions in window           224647
  admitted (baseline MATCHED)   224647  100.000%
  reached the arithmetic        20340  9.054%   <- the only rows a cost key can move
  markets: seen / admitted / reaching   322 / 322 / 65

  exclusions:
    BASELINE_MISMATCH            0
    NO_REPLAY_BLOCK              0
    UNSUPPORTED_KIND             0
    CONFIG_UNAVAILABLE           0

  recorded value: 0.12

## Per candidate

  ACTION = ACCEPTED<->REJECTED. REASON = the label moved, the action did not.

  value      action(ln/mkt)  reason(ln/mkt)  side  binding  cap>0   med d(edge_net)  max slack used
  0.1200     0/0             0/0             0     0        0           0.000000000         0.0000%
  0.1500     0/0             0/0             0     0        0           0.000000000         0.0000%
  0.1830     0/0             0/0             319   0        108         0.000000000         0.0001%
  0.2000     0/0             269/1           932   0        3685        0.000000000         0.0318%
  0.2500     0/0             282/1           2229  0        4533        0.000000000         0.1310%
  0.3000     0/0             282/1           2288  0        4786        0.000000000         0.2301%
  0.3650     0/0             284/2           3706  0        5297        0.000000000         0.3590%
  0.4000     0/0             284/2           3706  0        6803        0.000000000         0.4284%

  Counts are absolute. The denominator for ACTION and REASON is the 20340 rows / 65 markets that reached the arithmetic, NOT the 224647 rows in the window.

  side/verdict transitions at 0.2:
         269  YES/REJECTED:LOWER_BOUND_BELOW_COSTS -> NO/REJECTED:PRICE_OUT_OF_BAND
  side/verdict transitions at 0.25:
         282  YES/REJECTED:LOWER_BOUND_BELOW_COSTS -> NO/REJECTED:PRICE_OUT_OF_BAND
  side/verdict transitions at 0.3:
         282  YES/REJECTED:LOWER_BOUND_BELOW_COSTS -> NO/REJECTED:PRICE_OUT_OF_BAND
  side/verdict transitions at 0.365:
         282  YES/REJECTED:LOWER_BOUND_BELOW_COSTS -> NO/REJECTED:PRICE_OUT_OF_BAND
           2  NO/REJECTED:LOWER_BOUND_BELOW_COSTS -> YES/REJECTED:PRICE_OUT_OF_BAND
  side/verdict transitions at 0.4:
         282  YES/REJECTED:LOWER_BOUND_BELOW_COSTS -> NO/REJECTED:PRICE_OUT_OF_BAND
           2  NO/REJECTED:LOWER_BOUND_BELOW_COSTS -> YES/REJECTED:PRICE_OUT_OF_BAND

## Margin — what a row of zeros actually means

  searched on the 20 decisions whose slack the candidates consumed most, inside the bracket [0.12,1000].

  ACTION (ACCEPTED <-> REJECTED) — the number the config needs:
    NONE. No value in the bracket changes what the engine would DO.
    Read with 'max slack used': a max near zero means the key is
    arithmetically incapable in this population, NOT that the candidates
    are safe to adopt on the evidence of this sweep.

  LABEL (side and reason only) — diagnostic, not the headline:
    decision 492229: NO/REJECTED:PRICE_OUT_OF_BAND -> YES/REJECTED:PRICE_OUT_OF_BAND at costs.capitalCostAnnual = 0.419181
    decision 492295: NO/REJECTED:PRICE_OUT_OF_BAND -> YES/REJECTED:PRICE_OUT_OF_BAND at costs.capitalCostAnnual = 0.419181
    decision 492361: NO/REJECTED:PRICE_OUT_OF_BAND -> YES/REJECTED:PRICE_OUT_OF_BAND at costs.capitalCostAnnual = 0.419181

## Provenance

{
  "mode": "A",
  "analysis_mode": "audit",
  "reads": [
    "portfolio_decisions",
    "portfolio_config_versions"
  ],
  "window_requested": {
    "from": null,
    "to": "2026-09-01T14:25:00.000Z"
  },
  "window_covered": {
    "oldest": "2026-08-30T09:44:16.637Z",
    "newest": "2026-09-01T14:24:44.936Z",
    "rows": 224647,
    "markets": 322,
    "decision_id_range": [
      479171,
      703817
    ],
    "closed_at_decision_id": 703817,
    "note": "the scan is pinned to this decision_id, so rows written during the run are outside it and two runs over the same range agree"
  },
  "config_versions": [
    "1.2.0"
  ],
  "config_hashes": {
    "1.2.0": "1c8a331685828c144959600831634262cf482c0099c8a44f7eb60bf876f31faf"
  },
  "engine_default_config_version": "1.2.0",
  "breakeven_bracket": [
    0.12,
    1000
  ],
  "shadow_rows_in_window": 82357
}

SIMULAÇÃO — SEM EXECUÇÃO REAL. Nothing was written.
```

### O que essa tabela diz, e o que ela não diz

**A coluna que responde à pergunta do proprietário é `action`, e ela é zero em
toda a lista.** Nenhuma das 20 340 decisões que chegaram à conta teria sido
aceita ou rejeitada de outra forma com a taxa em 0,15, 0,183, 0,20, 0,25, 0,30,
0,365 ou 0,40. Não é "quase nada": é nada.

**O zero não é vazio, e é a coluna de margem que prova isso.** A r=0,40 o maior
candidato consome **0,4284%** da folga da decisão mais apertada. A busca de valor
de virada, rodada sobre as 20 decisões que os candidatos chegaram mais perto de
virar, **não acha nenhuma mudança de AÇÃO em todo o bracket [0,12; 1000]** — ou
seja, nem a 100 000% a.a. Essa é a leitura "aritmeticamente incapaz nesta
população", e não "não havia contra o que comparar": havia 20 340 linhas em 65
mercados, todas replicando byte a byte.

**A causa é o lockup, não o tamanho da amostra.** Os lockups do log são dois:
`0,0264 d` (38 min) e `0,1528 d` (3,67 h). Com o hurdle do buffer em
`0,0005/dia`, a carga de capital vale `(r − 0,1825/p) × (L/365) × p`, e com L em
horas ela fica abaixo de `1e-4` por ação em toda a lista, contra um `edgeLiqMin`
de `0,02`. O parâmetro só voltaria a pesar com lockup da ordem de **30 dias**.

**As colunas `reason` e `side` medem outra coisa, e por isso ficam separadas.** A
estimativa `MARKET_BASELINE` sai do MESMO livro que o motor caminha, então `q`
fica no microprice e as duas pernas empatam exatamente. `evaluateMarket`
desempata com `>` estrito, YES ganha por ser avaliada primeiro, e a carga de
capital — proporcional ao preço — desempata a favor da perna barata. O resultado
é uma rejeição que continua rejeição e troca de rótulo:
`YES/LOWER_BOUND_BELOW_COSTS` vira `NO/PRICE_OUT_OF_BAND`, em **284 linhas / 2
mercados** a r=0,40. Somar isso à coluna `action` inflaria a mordida do parâmetro
numa ordem de grandeza — foi exatamente o defeito que a primeira rodada pegou e
que o PR #73 consertou, antes de o número chegar ao proprietário.

### Determinismo, provado em produção

Duas rodadas sobre a mesma janela fechada (`decision_id <= 703817`), uma em
`table` e outra em `json`, devolveram os mesmos agregados — `224647 / 224647 /
20340` — e os mesmos contadores por candidato
(`0.2:0/269  0.25:0/282  0.3:0/282  0.365:0/284  0.4:0/284`). A janela é fechada
no `decision_id` que o sumário reporta justamente para isso: sem esse corte, uma
passada de minutos sobre um log que ganha ~55 linhas/mercado/hora varreria linhas
escritas depois da proveniência, e duas rodadas nunca bateriam.

---

## Controle — a MESMA população, uma chave que MORDE

O zero do `capitalCostAnnual` só significa alguma coisa se a ferramenta for
capaz de achar um flip quando existe um. A prova é rodar **a mesma janela, a
mesma população, o mesmo binário** contra uma chave diferente:

```sh
docker compose --env-file deploy/server.env exec -T api \
  node apps/api/dist/shadow-replay-cli.js sweep costs.edgeLiqMin \
  --values 0.02,0.03 --to 2026-09-01T14:25:00Z
```

```text
# RFC-017 mode A — sweep of costs.edgeLiqMin

## Population (the denominator, stated three ways)

  decisions in window           224647
  admitted (baseline MATCHED)   224647  100.000%
  reached the arithmetic        20340  9.054%   <- the only rows a cost key can move
  markets: seen / admitted / reaching   322 / 322 / 65

  exclusions:
    BASELINE_MISMATCH            0
    NO_REPLAY_BLOCK              0
    UNSUPPORTED_KIND             0
    CONFIG_UNAVAILABLE           0

  recorded value: 0.02

## Per candidate

  ACTION = ACCEPTED<->REJECTED. REASON = the label moved, the action did not.

  value      action(ln/mkt)  reason(ln/mkt)  side  binding  cap>0   med d(edge_net)  max slack used
  0.0200     0/0             0/0             0     0        0           0.000000000         0.0000%
  0.0300     7/2             7/2             0     7        0           0.000000000      2032.5203%

  Counts are absolute. The denominator for ACTION and REASON is the 20340 rows / 65 markets that reached the arithmetic, NOT the 224647 rows in the window.

  side/verdict transitions at 0.03:
           4  YES/ACCEPTED:- -> YES/REJECTED:EDGE_BELOW_MIN
           3  NO/ACCEPTED:- -> NO/REJECTED:EDGE_BELOW_MIN
  binding transitions at 0.03:
           1  DEPTH_TAKE_PCT -> NOT_SIZED
           6  CORRELATION_FACTOR -> NOT_SIZED

## Margin — what a row of zeros actually means

  searched on the 20 decisions whose slack the candidates consumed most, inside the bracket [0.02,1000].

  ACTION (ACCEPTED <-> REJECTED) — the number the config needs:
    decision 598667: ACCEPTED -> REJECTED at costs.edgeLiqMin = 0.0204929
    decision 702129: ACCEPTED -> REJECTED at costs.edgeLiqMin = 0.0214201
    decision 696949: ACCEPTED -> REJECTED at costs.edgeLiqMin = 0.0223213
    decision 692976: ACCEPTED -> REJECTED at costs.edgeLiqMin = 0.0234751
    decision 603583: ACCEPTED -> REJECTED at costs.edgeLiqMin = 0.0251381

  LABEL (side and reason only) — diagnostic, not the headline:
    decision 598667: YES/ACCEPTED:- -> YES/REJECTED:EDGE_BELOW_MIN at costs.edgeLiqMin = 0.0204929
    decision 702129: NO/ACCEPTED:- -> NO/REJECTED:EDGE_BELOW_MIN at costs.edgeLiqMin = 0.0214201
    decision 696949: NO/ACCEPTED:- -> NO/REJECTED:EDGE_BELOW_MIN at costs.edgeLiqMin = 0.0223213

## Provenance

{
  "mode": "A",
  "analysis_mode": "audit",
  "reads": [
    "portfolio_decisions",
    "portfolio_config_versions"
  ],
  "window_requested": {
    "from": null,
    "to": "2026-09-01T14:25:00.000Z"
  },
  "window_covered": {
    "oldest": "2026-08-30T09:44:16.637Z",
    "newest": "2026-09-01T14:24:44.936Z",
    "rows": 224647,
    "markets": 322,
    "decision_id_range": [
      479171,
      703817
    ],
    "closed_at_decision_id": 703817,
    "note": "the scan is pinned to this decision_id, so rows written during the run are outside it and two runs over the same range agree"
  },
  "config_versions": [
    "1.2.0"
  ],
  "config_hashes": {
    "1.2.0": "1c8a331685828c144959600831634262cf482c0099c8a44f7eb60bf876f31faf"
  },
  "engine_default_config_version": "1.2.0",
  "breakeven_bracket": [
    0.02,
    1000
  ],
  "shadow_rows_in_window": 82357
}

SIMULAÇÃO — SEM EXECUÇÃO REAL. Nothing was written.
```

Mesmas 224 647 decisões, mesmas 20 340 alcançáveis, mesmos 65 mercados — e
subir `edgeLiqMin` de 0,02 para 0,03 **muda a AÇÃO de 7 linhas em 2 mercados**
(4 na perna YES, 3 na NO), com o binding constraint saindo de `DEPTH_TAKE_PCT`
para `NOT_SIZED`. A busca de AÇÃO acha os valores de virada um a um —
**0,0204929**, **0,0214201**, **0,0223213**, **0,0234751**, **0,0251381** — em
vez de devolver `NONE`.

**É isso que fecha a lente de degeneração.** A varredura não "passou porque não
havia contra o que comparar": ela encontra flips e valores de virada na mesma
população, com a mesma amostra de 20 decisões, quando a chave é capaz de
produzi-los. O zero do `capitalCostAnnual` é, portanto, um fato sobre o
parâmetro — não sobre a ferramenta, nem sobre o tamanho da amostra.

---

## Modo B — replay de fonte (verbatim)

Comando:

```sh
docker compose --env-file deploy/server.env exec -T api \
  node apps/api/dist/shadow-replay-cli.js source-replay --to 2026-09-01T14:25:00Z
```

```text
# RFC-017 mode B — source replay (baseline -> shadow)

OFFLINE ANALYSIS, not an audit: this mode reads market tables.

## Population

  entry-path decisions seen     224481
  admitted (shadow found as-of) 13875  6.181%
  reached the estimate          2576  1.148%   <- the only rows a source swap can move
  markets: seen / admitted / reaching  322 / 67 / 22
  window covered                2026-08-30T09:45:16.654Z .. 2026-09-01T14:24:44.936Z
  shadow models used            crypto_updown_gbm@1.0.0, crypto_updown_gbm@1.1.0

  exclusions:
    BASELINE_MISMATCH            0
    NO_REPLAY_BLOCK              0
    SHADOW_MISSING               210601
    SHADOW_STALE                 0
    BASELINE_ALREADY_SHADOW      5
    UNSUPPORTED_KIND             0

## What the shadow would have changed

  lines whose ACTION differs    519  20.148%
  markets whose ACTION differs  9  40.909%
  lines whose REASON differs    765  29.697%
  accepted by baseline only     8
  accepted by shadow only       511

  top transitions:
         415  REJECTED:LOWER_BOUND_BELOW_COSTS -> ACCEPTED:-
          87  REJECTED:PRICE_OUT_OF_BAND -> ACCEPTED:-
          85  REJECTED:LOWER_BOUND_BELOW_COSTS -> REJECTED:EDGE_BELOW_MIN
          80  REJECTED:LOWER_BOUND_BELOW_COSTS -> REJECTED:PRICE_OUT_OF_BAND
          31  REJECTED:PRICE_OUT_OF_BAND -> REJECTED:LOWER_BOUND_BELOW_COSTS
          17  REJECTED:PRICE_OUT_OF_BAND -> REJECTED:EDGE_BELOW_MIN
          14  REJECTED:EDGE_BELOW_MIN -> REJECTED:LOWER_BOUND_BELOW_COSTS
          12  REJECTED:DATA_STALE -> REJECTED:LOWER_BOUND_BELOW_COSTS
           7  REJECTED:DATA_STALE -> ACCEPTED:-
           7  ACCEPTED:- -> REJECTED:LOWER_BOUND_BELOW_COSTS

## Counterfactual PnL (HYPOTHETICAL)

  entries the shadow would take 515
  settled against a final label 0
  without a final label         515
  wins / losses / halves        0 / 0 / 0
  gross USD                     0.000000
  engine costs USD              0.000000
  conservative degradation USD  0.000000
  net USD                       0.000000

## Provenance

{
  "mode": "B",
  "analysis_mode": "offline",
  "reads": [
    "portfolio_decisions",
    "portfolio_config_versions",
    "fundamental_estimates",
    "fundamental_labels",
    "fundamental_models"
  ],
  "not_an_audit": "mode B reads market tables, so its window is bounded by their retention and it does not survive the raw-data TTL the way mode A does",
  "window_requested": {
    "from": null,
    "to": "2026-09-01T14:25:00.000Z"
  },
  "decision_log_window": {
    "oldest": "2026-08-30T09:44:16.637Z",
    "newest": "2026-09-01T14:24:44.936Z",
    "rows": 224647,
    "closed_at_decision_id": 703817
  },
  "shadow_estimates_in_window": {
    "rows": 82357,
    "tokens": 273,
    "oldest": "2026-08-20T05:03:26.893Z",
    "newest": "2026-09-01T14:24:42.245Z",
    "model_ids": [
      "crypto_updown_gbm@1.0.0",
      "crypto_updown_gbm@1.1.0"
    ]
  },
  "any_model_promoted": false,
  "degradation_per_share": 0.01,
  "pnl_label": "hypothetical",
  "gate_note": "feeds the RFC-010 promotion decision; does not replace it. No model is promoted without a gate PASS and the owner's manual action."
}

SIMULAÇÃO — SEM EXECUÇÃO REAL. Nothing was written.
```

### O que essa tabela diz

**O shadow é muito mais disposto a entrar.** Das 2 576 decisões que chegaram à
estimativa e tinham linha shadow as-of, **519 (20,1%)** teriam agido diferente,
em **9 dos 22 mercados (40,9%)**. A assimetria é o número que importa: **511
entradas só do shadow** contra **8 só do baseline**. A transição dominante é
`REJECTED:LOWER_BOUND_BELOW_COSTS → ACCEPTED`, com 415 linhas.

**Mais entradas não é mais alpha, e o PnL que diria qual das duas coisas é ainda
não existe.** Das 515 entradas que o shadow teria feito, **zero** está num token
com label final: são mercados crypto de horizonte curto que ainda não resolveram,
ou cujo label ainda não chegou. A ferramenta reporta
`515 considered / 0 settled / 515 without final label` em vez de inventar um
número. **Re-rodar quando os labels chegarem** é o próximo passo dessa leitura;
dos 24 tokens que são ao mesmo tempo cobertos por shadow e alcançáveis, 5 têm
label final hoje.

**A exclusão dominante é honesta e grande:** `SHADOW_MISSING` em 210 601 de
224 481 linhas. O shadow cobre `crypto_updown` e o log tem 322 mercados; a janela
efetiva do modo B é o overlap, não a janela do log, e a saída imprime as duas.

**`BASELINE_ALREADY_SHADOW = 5`** — o guard da premissa 3 disparando em dado
real. Ver a seção seguinte.

---

## Defeito ativo encontrado pela medição: o shadow vaza para as decisões

`estimateAsOf` (`apps/api/src/polymarket/portfolio/store.ts:178`) faz
`WHERE token_id = $1 AND decision_ts <= $2 ORDER BY decision_ts DESC LIMIT 1` —
**sem filtro de `status` e sem desempate**. Em cada instante um token tem uma
linha de consumidor (`status='active'`) e uma por modelo shadow
(`status='shadow'`), **todas com o mesmo `decision_ts`** (chave única
`(token_id, decision_ts, COALESCE(model_id,''))`). Qual delas o `LIMIT 1` devolve
é indefinido.

Medido em 2026-09-01:

| Fato                                               | Valor                                                       |
| -------------------------------------------------- | ----------------------------------------------------------- |
| modelos promovidos                                 | **0** (as três linhas de `fundamental_models` em `shadow`)    |
| decisões com `estimate_source='MODEL'` mesmo assim | **5**, em 2 mercados, entre 13:03:43Z e 13:50:44Z             |
| dessas, quantas foram ACEITAS                      | **0** (4 `PRICE_OUT_OF_BAND`, 1 `PORTFOLIO_CIRCUIT_BREAKER`)  |
| instantes com mais de uma linha de estimativa      | **80 397**                                                    |

A prova de que é a linha shadow e não a ativa: a `decision_id` 698296 gravou
`q=0,999000 / q_lo=0,990385 / q_hi=0,999000`, que é exatamente o `estimate_id`
837093 (`crypto_updown_gbm@1.0.0`, `status='shadow'`), e **não** o `estimate_id`
837092 do mesmo instante (`q=0,998500 / q_lo=0,997632`, `status='active'`).

Começou a disparar depois que o PR #70 acrescentou o segundo modelo shadow
(`crypto_updown_gbm@1.1.0`, deployado às 12:14Z), que triplicou as linhas por
instante. Viola a invariante da RFC-010 gravada na migration 0006 — *"Shadow
estimates exist for gating only and are invisible to consumers"* — e deixa um
modelo não promovido influenciar decisão de paper sem gate PASS.

**Nenhuma ordem de paper resultou disso** (as 5 foram rejeitadas), mas a
invariante está quebrada e a taxa depende de layout de heap, não de nada
controlado.

**Fora do escopo desta RFC** — é área da RFC-010. O conserto é um predicado
(`AND status = 'active'`) mais desempate determinístico
(`ORDER BY decision_ts DESC, estimate_id DESC`), com regressão que planta as duas
linhas no mesmo `decision_ts` e prova que a ativa vence. Fica como decisão do
proprietário.

---

## Verificações da entrega

| Item                                                    | Estado                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `replayDecision` e o check de hash                      | **intocados** (`git diff` vazio em `replay.ts`); a varredura os usa como **teste de admissão**    |
| terceiro construtor de linha                            | **não existe**: só `decisionrow.ts` devolve `DecisionRow`                                          |
| escrita em qualquer tabela                              | **nenhuma**; o envelope recusa e o servidor recusa de novo                                         |
| config candidata em `portfolio_config_versions`         | **nenhuma**                                                                                        |
| `make verify`                                           | **verde**, 1518 testes na API                                                                      |
| janela atravessa o deploy da RFC-018                    | **não**: a cadência não foi deployada; densidade homogênea em ~55 linhas/mercado/hora nas 53 h     |
| memória                                                 | `mem_limit` da `api` é 384 MiB e ela usava 37 MiB antes da rodada; a varredura anda em páginas de 500 |
| tempo de parede                                         | modo A **1 min 27 s**; modo B **7 min 11 s** (uma consulta as-of por página)                        |

## O que fica aberto

1. **A cunhagem da 1.3.0 é decisão do proprietário.** A medição diz que, na
   população que existe hoje, a escolha entre 0,12 e 0,40 **não muda nenhuma
   decisão** — nem para melhor nem para pior. Se o objetivo é tornar o parâmetro
   vinculante, ele só volta a morder com lockups de semanas: é uma decisão sobre
   o UNIVERSO negociado, não sobre a taxa.
2. **Re-rodar o modo B quando os labels chegarem.** Hoje 0 das 515 entradas
   contrafactuais tem label final; a leitura de PnL fica aberta até lá.
3. **O vazamento do shadow** descrito acima, que é área da RFC-010.
