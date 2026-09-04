# RFC-025 — Disjuntor de mudança de parâmetro redefinido: `PARAM_CHANGE` abre em mudança real, não em nascimento

**Status:** draft — exige decisão registrada do proprietário (tabela P1–P3, coluna "Decisão do proprietário") (2026-09-03)
**Dependências:** nenhuma de código. RFC-013 (item 4 (iv): "mudança de fee schedule/tick/status", `docs/rfcs/RFC-013-polymarket-portfolio-engine.md:154–158`) é a especificação que esta RFC interpreta; RFC-018 (o G3 já viu `PARAM_CHANGE` disparar 939 vezes — nada aqui o devolve a zero). **Exige decisão registrada (tabela P1–P3).**
**Habilita:** o universo rápido da RFC-016/RFC-019 (mercados "Up or Down" horários) deixa de nascer congelado; a vazão de que o G2 depende passa a ser possível de medir; o `PARAM_CHANGE` volta a significar o que a RFC-013 escreveu
**Origem:** diagnóstico operacional de 02–03/09/2026 — https://claude.ai/code/artifact/f7e3e623-831a-464f-8435-6cc671d325e6 (funil, seções 1 e 2)

## Prompt a executar

`prompts/roadmap/17-rfc-025-param-change.md`. Tudo em SIMULAÇÃO. Nenhum gate afrouxa, nenhum endpoint de escrita novo, nenhuma migration (`detail_json` de `portfolio_circuit_breakers` é `jsonb`, `migrations/0014_polymarket_portfolio_engine.sql:290–300`), nenhuma chave nova em `config/portfolio.json` (a 1.2.0 não é recunhada).

---

## Fatos medidos (02/09/2026 — RE-MEDIR antes de codar; SQL exatas no Apêndice A)

### Onde as entradas morrem

| Fato | Valor | Origem |
| --- | --- | --- |
| Avaliações de entrada nas 24 h | 52 983 | `portfolio_decisions`, `decision_kind='ENTRY'` (recorte 02/09) |
| Mortas em `PORTFOLIO_CIRCUIT_BREAKER` | **29 600 (55,9 %)** | `engine.ts:334–341` (degrau 1, antes de qualquer aritmética); recorte 02/09 |
| Atribuídas ao `PARAM_CHANGE` aberto no instante | **29 173 (98,6 %) / 144 mercados** | consulta A1; recorte 02/09 |
| Atribuídas ao `PRICE_JUMP_NO_CATALYST` | 1 696 / 57 mercados | consulta A1; artifact seção 1 — **verificar na re-medição** |
| Atribuídas ao `DATA_STALENESS` | 73 / 2 mercados | consulta A1; artifact seção 1 — **verificar** |
| Universo rápido ("Up or Down") avaliado nas 24 h | 40 mercados, **1 519 de 1 519 decisões (100 %)** em `PORTFOLIO_CIRCUIT_BREAKER`; 1 515 via `PARAM_CHANGE` | consulta A3; recorte 02/09 (o 1 515: artifact seção 1 — **verificar**) |
| `PARAM_CHANGE` aberto no instante | 54 mercados, aberto há p50 324 min | `portfolio_circuit_breakers` `ended_at IS NULL`; artifact seção 2 — **verificar** |

### O que o código faz hoje

| Fato | Valor | Origem (verificado 03/09 no HEAD `ef7ca2d`) |
| --- | --- | --- |
| Janela do disjuntor | `BREAKER_EVENT_WINDOW_MS = 24 * 3_600_000` | `apps/api/src/polymarket/portfolio/breakers.ts:102` |
| Condição de abertura | `paramChangedAt !== null && now − paramChangedAt <= 24 h`; `detail_json` só carrega `param_changed_at` e `window_ms` | `breakers.ts:202–216` |
| O que é `paramChangedAt` | `max(pv.valid_from)` de `polymarket_param_versions` por `condition_id` — **a versão mais nova, seja ela qual for** | `apps/api/src/polymarket/portfolio/exitstore.ts:358–362` (`MarketChangeState`), `:401–402` (SQL em `loadMarketChangeStates`, `:387`) |
| Quem chama | `runner.ts:707` (ciclo de entrada) e `:1041` (ciclo de saída); a observação recebe `paramChangedAt: change.paramChangedAt` em `runner.ts:589`; `BreakerConfigInput` é montado em `:594–600` | `runner.ts:589, :594–600, :707, :1041` |
| Como o `detail` chega ao banco | `openBreaker` grava `JSON.stringify(signal.detail)` — campos novos no `detail` entram sem mudar a função | `exitstore.ts:638–660` (`:656`) |
| Escopo do congelamento | `market` — trava toda entrada no mercado | `breakers.ts:208`, `entryFrozenBy` `:299` |
| Fee que entra no EV | `COALESCE(p.taker_fee_bps, p.fee_base_bps)` — com `taker_fee_bps` NULL, o motor lê `fee_base_bps` | `store.ts:85` |
| Teste existente (unitário) | um único caso: `paramChangedAt` há 60 s abre | `apps/api/test/polymarket/portfolio/breakers.test.ts:144–149` |
| Teste existente (pg) | seed com **só a versão 1** (`VALUES ($1, 1, …)`, `:128–132`); espera `paramChangedAt` `toBeInstanceOf(Date)` (`:288–294`) — **quebra com D1**, e é a inversão que prova a falha | `apps/api/test/polymarket/portfolio/integration.pg.test.ts:128–132, :288–294`; gated por `GANSO_TEST_DATABASE_URL` (`:66`, `describe.skipIf` `:255`) |
| Schema das versões | `version`, `fee_base_bps`, `maker_fee_bps`, `taker_fee_bps`, `fee_curve_json`, `tick_size`, `min_order_size`, `neg_risk`, `valid_from`, `valid_to`; `UNIQUE (condition_id, version)`; índice `(condition_id, valid_from)` | `migrations/0005_polymarket_data_foundation.sql:51–72` |

### O que de fato abriu os 939 `PARAM_CHANGE` da história (consulta A2)

| Causa | n | % | Natureza |
| --- | --- | --- | --- |
| Versão 1 (mercado acabou de entrar no recorder) | **617** | 65,7 % | artefato de coleta — nenhum parâmetro mudou |
| `fee_base_bps` `NULL → 1000` (~40 min depois da versão 1, resto igual) | **247** | 26,3 % | artefato de coleta — preenchimento tardio |
| `tick_size` `0,01 ↔ 0,001` (preço cruzou 0,96 / 0,04) | 75 | 8,0 % | mudança real, rotineira de fim de vida |
| `taker_fee_bps` ou `fee_curve_json` mudaram | **0** em 249 versões consecutivas (48 h) | 0 % | nunca observado |
| `fee_base_bps` não nulo → não nulo diferente | **não medido** no recorte | — | **verificar na re-medição** (A2 com o campo) |

**92 % dos disparos não são mudança de parâmetro da venue.** A janela conta a partir da versão 1: todo mercado novo nasce congelado 24 h, e um mercado horário vive menos que isso — por isso 40 de 40 "Up or Down" nunca chegaram ao degrau 2.

### `PRICE_JUMP_NO_CATALYST` — ruído, não gargalo

| Fato | Valor | Origem |
| --- | --- | --- |
| Limiar | `jumpThreshold` 0,15 relativo em `jumpWindowMs` 300 000 | `config/portfolio.json:51–52`; `breakers.ts:162–164` |
| Disparos históricos | 9 570; `mid_before` p50 = **0,019** | `detail_json->>'mid_before'`; artifact seção 2 — **verificar** |
| Fora da banda de compra (`priceBand` 0,10–0,95, `config/portfolio.json:16–18`) | **7 668 (80 %)** | idem — **verificar** |
| Duração dos fechados | p50 2 min (recorte); p90 5 min, máx 65 min (artifact seção 2 — **verificar**) | `ended_at − started_at` |
| Ordem na escada | disjuntor em `engine.ts:334`; `PRICE_OUT_OF_BAND` testa o **preço atual** em `engine.ts:503` | leitura |

Num token a US$ 0,045, 15 % é 0,7 centavo — um tick. Não trava o funil (p50 de 2 min), mas enche `portfolio_circuit_breakers` e distorce a leitura do G3.

---

## Decisões que esta RFC exige do proprietário

Mudança de **semântica** de um disjuntor da RFC-013, não de limiar: não afrouxa gate nem número, mas muda o que conta como evento. O registro é **a última coluna desta tabela** — o prompt 17 a lê e PARA se P1 estiver `pendente`.

| # | Pergunta | Recomendação | Se recusada | Decisão do proprietário (data) |
| --- | --- | --- | --- | --- |
| **P1** | A versão 1 dos parâmetros e um preenchimento `NULL → valor` contam como "mudança de fee schedule/tick/status" (RFC-013 4(iv))? | **Não.** Só mudança de valor não nulo para valor não nulo diferente em `taker_fee_bps`, `fee_curve_json`, `tick_size` ou `fee_base_bps` conta (D1) | Nada muda; o universo rápido continua 100 % em disjuntor e o G2 não tem como andar | pendente |
| **P2** | A janela de 24 h fica **fixa** para mudanças reais (D2-A) ou vira **proporcional** à vida restante do mercado (D2-B: `min(24 h, 20 % de (end_ts − mudança))`, piso 5 min **a calibrar**)? | **D2-A** neste PR: menor mudança, constante intocada; a mudança real medida (tick em 0,96/0,04) atinge mercados que `PRICE_OUT_OF_BAND` já recusa. Re-medir após 7 dias; se mercados rápidos continuarem presos por tick real, D2-B em RFC seguinte | D2-B entra no PR 1 com `endDate: Date \| null` já disponível em `runner.ts:524` | pendente |
| **P3** | `PRICE_JUMP_NO_CATALYST` deixa de abrir para token **sem posição** cujos `mid_before` **e** `mid_now` estão **ambos** fora de `priceBand` (D3)? | **Sim**, opcional (PR 2): só nesse caso o veredito de entrada é idêntico (`PRICE_OUT_OF_BAND` recusa o preço atual); com um dos dois dentro da banda, ou com posição, o disjuntor continua abrindo | PR 2 não existe; medição publicada mesmo assim | pendente |

## Decisões desta RFC

### D1 — `paramChangedAt` é o instante da última mudança REAL, e o disjuntor diz qual campo mudou

`loadMarketChangeStates` (`exitstore.ts:387`) deixa de ler `max(valid_from)` e passa a ler o `valid_from` da versão mais nova cujo diff contra a anterior (`lag()` por `condition_id` ordenado por `version`) muda **pelo menos um** de `taker_fee_bps`, `fee_curve_json`, `tick_size`, `fee_base_bps` **de não nulo para não nulo diferente**. `fee_base_bps` entra porque `store.ts:85` o lê como taker fee via `COALESCE` quando `taker_fee_bps` é NULL — excluí-lo deixaria passar mudança real no campo que o motor usa. Versão 1 não tem anterior: nunca conta. `NULL → valor` é preenchimento do coletor: nunca conta. `valor → NULL` é perda de dado: achado, não disjuntor. `maker_fee_bps`, `min_order_size`, `neg_risk` ficam fora: não entram no EV (`store.ts:83–85`) e nunca mudaram.

`MarketChangeState` ganha `paramChangedFields: readonly string[]` e `paramChangedVersion: number | null`; `BreakerObservation` (`breakers.ts:82`) os recebe; o `detail` do sinal passa a carregar `changed_fields`, `version`, `from`, `to` além de `param_changed_at` e `window_ms` — `openBreaker` já serializa o `detail` inteiro (`exitstore.ts:656`), nada a ligar. É o que torna o aceite contável por campo.

`BREAKER_EVENT_WINDOW_MS` não muda; `RULE_CLARIFICATION` usa a mesma constante e não é tocado.

### D2 — a janela fica em 24 h (D2-A), condicionada a re-medição

Com D1 sozinha, 92 % dos disparos somem e o nascimento deixa de congelar. Os 8 % restantes são tick em 0,96/0,04, em mercados que a banda já recusa: manter 24 h ali não custa entrada e preserva a leitura conservadora da RFC-013. D2-B fica pronta: `endDate` já chega ao reconciliador (`runner.ts:524, 568–570`) como `Date | null`, coerente com `polymarket_markets.end_ts` nulável (`migrations/0017_polymarket_market_end_ts.sql:47`); sem `end_ts`, 24 h. O piso de 5 min é número novo, sem medição — a calibrar.

### D3 — `PRICE_JUMP_NO_CATALYST` com `mid_before` E `mid_now` fora da banda, sem posição, não abre (opcional)

Em `detectBreakers`, o ramo (ii) (`breakers.ts:162–179`) ganha a condição: abre se `holdsPosition`, **ou** se `midBeforeScaled` ∈ `[minBuy, maxBuy]`, **ou** se `midNowScaled` ∈ `[minBuy, maxBuy]`. Só com os dois fora da banda e sem posição o sinal é omitido. `BreakerConfigInput` recebe a banda já parseada (`PriceBandConfig`, `config.ts:57–58`; montagem em `runner.ts:594–600`) — nenhuma chave nova (`rejectUnknownKeys`, `config.ts:629–633`).

Por que os dois: olhar só `mid_before` seria **afrouxamento**. Um token a 0,96 que cai 17 % para 0,80 sem catalisador — o padrão da RFC-013 4(ii) — tem `mid_before` fora e `mid_now` dentro; hoje abre e congela a entrada, e com a condição ingênua a entrada a 0,80 passaria por `PRICE_OUT_OF_BAND` (`engine.ts:503` testa o preço **atual**) e chegaria à aritmética. Esse caso **continua abrindo**. Com os dois fora, `PRICE_OUT_OF_BAND` recusa no mesmo ciclo: veredito idêntico, só muda o rótulo. Com posição, nada muda em preço nenhum.

### D4 — sem migration, sem recunhagem de config, sem tocar os outros disjuntores

`detail_json` é `jsonb`; nenhuma coluna nova. Nenhuma chave em `config/portfolio.json`. `UMA_PROPOSED_OR_DISPUTED`, `RULE_CLARIFICATION` e `DATA_STALENESS` não mudam uma linha; os testes deles ficam como prova.

### D5 — a medição antes/depois é entregável, publicada nesta RFC

As consultas A1, A2 e A3 do Apêndice A, **sem reescrever**, antes do deploy e 24 h depois, coladas em "Medido depois": `reason_code` e atribuição por disjuntor (A1, hoje 55,9 % / 98,6 %); causa por campo (A2, hoje 617/247/75/0); fração do universo rápido sob disjuntor (A3, hoje 100 %, 40 de 40). Sem a medição, o PR não fecha.

---

## Escopo, em PRs

| # | Item | Muda comportamento? | Config? | Migration? |
| --- | --- | --- | --- | --- |
| 1 | D1 (+ D2-A): `paramChangedAt` só em mudança real; `detail_json` com `changed_fields` | sim (o que abre `PARAM_CHANGE`) | não | não |
| 2 | D3: `PRICE_JUMP` com `mid_before` e `mid_now` fora da banda, sem posição, não abre — **só se P3 aprovado** | sim (rótulo; veredito idêntico só nesse caso) | não | não |
| 3 | D5: medição antes/depois publicada nesta RFC; HANDOFF; README do roadmap | não | não | não |

## Testes obrigatórios

- **Rodar os pg de verdade**: `make verify` (Makefile:97) chama `vitest run` sem `GANSO_TEST_DATABASE_URL`, e `integration.pg.test.ts` é **pulado em silêncio** (`describe.skipIf`, `:255`). Exigir a saída `X passed` de `GANSO_TEST_DATABASE_URL=postgres://… npx vitest run apps/api/test/polymarket/portfolio/integration.pg.test.ts` contra um Postgres local migrado (`make up` + `make migrate`; ver `docs/test-results/RFC-013-portfolio-engine.md:112`), além do `make verify` verde.
- `loadMarketChangeStates` (pg): a expectativa `toBeInstanceOf(Date)` (`integration.pg.test.ts:288–294`) passa a `toBeNull()` — o seed tem só a versão 1 (`:128–132`); essa inversão **é** a prova de falha no código anterior. Adicionar fixtures v2 ao seed: `fee_base_bps NULL → 1000`, resto igual → `null`; `tick_size 0.01 → 0.001` → `valid_from` da v2 e `paramChangedFields = ['tick_size']`; v3 só `min_order_size` → continua a v2.
- `detectBreakers`: `PARAM_CHANGE` abre com `paramChangedAt` recente e o `detail` carrega `changed_fields`; o teste-guarda "fixture para todo kind" (`breakers.test.ts:169`) continua verde.
- PR 2: `mid_before` 0,02 → 0,023 sem posição → **não** abre; o mesmo com posição → abre; 0,50 sem posição → abre; **0,96 → 0,80 sem posição → DEVE abrir** (`mid_now` dentro da banda).
- Contagem de casos de `UMA_*`, `RULE_CLARIFICATION`, `DATA_STALENESS` no arquivo de teste igual antes e depois.

## Critérios de aceite (verificáveis em produção, 24 h após o rebuild do serviço `polymarket-portfolio` do profile `polymarket`)

1. `PARAM_CHANGE` abertos depois do deploy, pela consulta **A2** com `started_at > <rebuild>`: **0** por versão 1, **0** por `NULL → valor`; todo `detail_json` tem `changed_fields` não vazio.
2. Todo "Up or Down" **descoberto depois do deploy** (`polymarket_markets.received_at` > timestamp do rebuild, registrado no HANDOFF; `migrations/0004_polymarket.sql:24`) tem a **primeira** linha em `portfolio_decisions` com `reason_code <> 'PORTFOLIO_CIRCUIT_BREAKER'`, salvo outro disjuntor aberto com causa registrada. Fração sob disjuntor pela **A3**: publicada (antes: 100 %).
3. Distribuição de `reason_code` pela **A1** publicada (antes: 55,9 % em disjuntor). Restos de `BOOK_STALE`/`DATA_STALE` (`engine.ts:372–389`) são sintoma do feed (ver RFC-021/RFC-024) — registrar, não consertar aqui.
4. Contagem por `kind` em `portfolio_circuit_breakers` (`started_at`, 24 h antes vs 24 h depois): `DATA_STALENESS` e `UMA_PROPOSED_OR_DISPUTED` com razão depois/antes entre 0,5 e 2, ou desvio explicado; `RULE_CLARIFICATION` segue 0.
5. `/etc/ganso/release-sha` do container `polymarket-portfolio` = SHA do merge; zero erros novos no log do serviço.

## Condições de parada

- A re-medição (A1) mostrar atribuição ao `PARAM_CHANGE` abaixo de 50 %, ou a SQL em `exitstore.ts:401–402` já não ser `max(valid_from)`: outra sessão chegou antes — parar.
- P1 `pendente` na tabela acima.
- Qualquer necessidade de migration ou de chave nova em `config/portfolio.json`.
- Qualquer alteração em `BREAKER_EVENT_WINDOW_MS` sem P2 = D2-B aprovado.
- Qualquer mudança nos ramos (i), (iii) ou (v) de `detectBreakers`.
- `make verify` vermelho; pg pulado; teste de regressão que não falha no código anterior.

## Apêndice A — as três consultas (usar como estão; `:t0` = agora − 24 h, `:t1` = agora)

```sql
-- A1: entradas das 24 h por reason_code, e as em disjuntor atribuídas ao kind aberto no instante
WITH d AS (SELECT decision_id, condition_id, decision_ts, reason_code FROM portfolio_decisions
           WHERE decision_kind = 'ENTRY' AND decision_ts >= :t0 AND decision_ts < :t1)
SELECT d.reason_code, b.kind, count(*) AS n, count(DISTINCT d.condition_id) AS markets
FROM d LEFT JOIN portfolio_circuit_breakers b
  ON d.reason_code = 'PORTFOLIO_CIRCUIT_BREAKER' AND b.condition_id = d.condition_id
 AND b.started_at <= d.decision_ts AND (b.ended_at IS NULL OR d.decision_ts < b.ended_at)
GROUP BY 1, 2 ORDER BY n DESC;

-- A2: causa de cada PARAM_CHANGE — a versão cujo valid_from casa com o detail, contra a anterior
WITH v AS (SELECT condition_id, version, valid_from, fee_base_bps, taker_fee_bps, fee_curve_json, tick_size,
             lag(fee_base_bps)   OVER w AS p_base, lag(taker_fee_bps) OVER w AS p_taker,
             lag(fee_curve_json) OVER w AS p_curve, lag(tick_size)    OVER w AS p_tick
           FROM polymarket_param_versions WINDOW w AS (PARTITION BY condition_id ORDER BY version))
SELECT CASE WHEN v.version = 1 THEN 'v1'
            WHEN v.p_base IS NULL AND v.fee_base_bps IS NOT NULL AND v.p_taker IS NOT DISTINCT FROM v.taker_fee_bps
                 AND v.p_curve IS NOT DISTINCT FROM v.fee_curve_json AND v.p_tick IS NOT DISTINCT FROM v.tick_size THEN 'fee_base NULL->valor'
            WHEN v.p_tick IS NOT NULL AND v.tick_size IS DISTINCT FROM v.p_tick THEN 'tick_size real'
            WHEN v.p_taker IS NOT NULL AND v.taker_fee_bps IS DISTINCT FROM v.p_taker THEN 'taker_fee real'
            WHEN v.p_curve IS NOT NULL AND v.fee_curve_json IS DISTINCT FROM v.p_curve THEN 'fee_curve real'
            WHEN v.p_base IS NOT NULL AND v.fee_base_bps IS DISTINCT FROM v.p_base THEN 'fee_base real'
            WHEN v.condition_id IS NULL THEN 'sem casamento' ELSE 'outro' END AS causa,
       count(*) AS n
FROM portfolio_circuit_breakers b
LEFT JOIN v ON v.condition_id = b.condition_id
           AND v.valid_from = (b.detail_json->>'param_changed_at')::timestamptz
WHERE b.kind = 'PARAM_CHANGE' -- AND b.started_at > :rebuild  (aceite 1)
GROUP BY 1 ORDER BY n DESC;

-- A3: universo rápido avaliado nas 24 h — mercados e decisões sob disjuntor
SELECT count(DISTINCT d.condition_id) AS markets,
       count(DISTINCT d.condition_id) FILTER (WHERE d.reason_code = 'PORTFOLIO_CIRCUIT_BREAKER') AS markets_frozen,
       count(*) AS decisions,
       count(*) FILTER (WHERE d.reason_code = 'PORTFOLIO_CIRCUIT_BREAKER') AS decisions_frozen
FROM portfolio_decisions d JOIN polymarket_markets m ON m.condition_id = d.condition_id
WHERE d.decision_kind = 'ENTRY' AND d.decision_ts >= :t0 AND d.decision_ts < :t1
  AND m.question ILIKE '%Up or Down%'; -- aceite 2: AND m.received_at > :rebuild
```

## Medido depois

_(a preencher pela sessão que executar o prompt 17 — D5)_
