# RFC-027 — Decisões como funil e Sistema com natureza do bloqueio: o painel diz onde as entradas morrem e por que cada gate não anda

**Status:** accepted — autorizado para implementação (2026-09-04)
**Dependências:** RFC-026 (`docs/rfcs/RFC-026-painel-home-broker.md`, `accepted` e ainda não implementada; **PR 1 mergeado é pré-condição** — ver Condições de parada; esta RFC ocupa as telas Decisões e Sistema que ela define), RFC-015 (`GET /overview`, `GET /events`, dicionário PT), RFC-018 (decision log grava só mudança de veredito — é o que torna a amostra de 500 linhas inútil para funil), RFC-023 (orçamento por rota — se estiver em produção, o teto da consulta do funil é o orçamento da rota, não 1 s)
**Habilita:** o operador lê o funil inteiro numa tela; três gates deixam de parecer "esperando" quando estão travados; `/data-quality` e `/portfolio/limits` passam a ter consumidor; o feed deixa de mostrar JSON cru
**Origem:** diagnóstico de 02–03/09/2026, relatório publicado em <https://claude.ai/code/artifact/f7e3e623-831a-464f-8435-6cc671d325e6> (leitores 1 e 3; síntese de UI, seções 4.3 e 4.5). **Não é necessário abrir o relatório**: tudo o que o prompt precisa está nas tabelas abaixo. Layout das telas Decisões e Sistema: canvas da RFC-026 (link no cabeçalho dela), só para layout

## Prompt a executar

`prompts/roadmap/19-rfc-027-funil-sistema.md`. Dois PRs. Tudo em SIMULAÇÃO: nenhum gate afrouxa, nenhum endpoint de escrita novo, nenhum disjuntor contornado, nenhuma escrita em tabela de decisão pelo painel. A única migration possível é a do D1, caminho B, e só se a medição mandar.

---

## Fatos medidos (02–03/09/2026 — RE-MEDIR antes de codar)

### A tela Decisões de hoje não consegue mostrar um funil

| Fato | Valor | Origem |
| --- | --- | --- |
| A sub-aba Decisões baixa N linhas fixas | `HISTORY_LIMIT = 500` | `apps/api/src/polymarket/portfolio/api.ts:38`; rota `GET /polymarket/decisions` `api.ts:487–505` |
| Cadência do poll | 30 s (`REFRESH_MS = 30_000`) | `apps/web/src/Portfolio.tsx:50`; seção `decisoes` `Portfolio.tsx:928` |
| Linhas/min do decision log depois da RFC-018 | 11,1 (em regime, 9 min de 02/09 01:20–01:29Z; 91,3 antes) | `prompts/roadmap/README.md:46`; `docs/HANDOFF.md:3324` |
| Janela que 500 linhas cobrem | **~45 min** (500 ÷ 11,1) | aritmética; era ~5,5 min antes da RFC-018 |
| Índices de `portfolio_decisions` | `(condition_id, decision_ts DESC)`, `(token_id, decision_ts DESC)`, **`(decision_kind, decision_ts DESC)`**, `(received_at)`; um parcial da ponte | `migrations/0014_polymarket_portfolio_engine.sql:189–196`; `0015_decision_to_paper_bridge.sql:54` |
| Timeout da API | pool herda `statement_timeout` = `connectTimeoutMs` (1 s); os workers sobrescrevem | `apps/api/src/database.ts:40–51` |
| Último `PORTFOLIO_CYCLE` | só no log: `evaluated`, `entrable`, `decisions_written`, `state`, `positions`, `open_breakers`, `stale_marks` | `apps/api/src/polymarket/portfolio/runner.ts:1008–1019` (campos em `:1009–1018`) |
| Janela do disjuntor | `BREAKER_EVENT_WINDOW_MS = 24 h` | `apps/api/src/polymarket/portfolio/breakers.ts:102` |

### O funil das 24 h de 02/09 (`portfolio_decisions`, `decision_kind = 'ENTRY'`; psql direto)

| Degrau (ordem em que o motor decide, não a do volume) | Linhas | % das avaliadas | Onde o motor decide |
| --- | --- | --- | --- |
| Avaliadas | 52 983 | 100 % | — |
| `PORTFOLIO_CIRCUIT_BREAKER` | 29 600 | 55,9 % (98,6 % via `PARAM_CHANGE`) | `engine.ts:334–341` |
| `BOOK_STALE` | 6 555 | 12,4 % | `engine.ts:372` |
| `DATA_STALE` | 8 373 | 15,8 % | `engine.ts:381`, `:389` |
| `PRICE_OUT_OF_BAND` | 4 039 | 7,6 % | `engine.ts:503` |
| `LOWER_BOUND_BELOW_COSTS` | 4 353 | 8,2 % | `engine.ts:516` |
| `EDGE_BELOW_MIN` | 34 | 0,06 % | `engine.ts:531` |
| **`ACCEPTED`** | **29** | **0,055 %** | `decisionrow.ts:143` |
| Ordens | 18 na história, 16 canceladas (`docs/HANDOFF.md:330`); "8 nas 48 h, todas canceladas": **verificar** em `paper_orders` (`brokerstore.ts:58–61` fala em 7 de 9 canceladas por uma rotina) | — | `paper_orders` |
| Fills (história) | 2 (28/08 14:30Z e 01/09 11:59Z) | — | `paper_ledger_events` |
| Fechamentos (história) | **0** | — | liquidação travada (PR-0 b; checklist 09) |

Os degraus ordem → fill → fechamento são da história inteira porque as 24 h não têm fill (2 fills em 5,2 dias). O painel mostra o degrau com a janela que tem dado e **diz qual é**.

"Quase": premissa **sem número no repositório** (os valores do diagnóstico não foram registrados com consulta). A sessão executora mede antes de codar (RE-MEDIR): `SELECT reason_code, count(*) FILTER (WHERE folga > -0.01) AS quase, count(*) FROM (SELECT reason_code, CASE reason_code WHEN 'LOWER_BOUND_BELOW_COSTS' THEN q_lo::numeric - exec_price::numeric - costs_total::numeric - safety_margin::numeric WHEN 'EDGE_BELOW_MIN' THEN edge_net::numeric - 0.02 END AS folga FROM portfolio_decisions WHERE decision_kind = 'ENTRY' AND decision_ts > now() - interval '24 hours' AND reason_code IN ('LOWER_BOUND_BELOW_COSTS','EDGE_BELOW_MIN')) t GROUP BY 1`. Colunas `costs_total`, `safety_margin` em `0014_…sql:94–95`; o `0.02` da consulta manual é `edgeLiqMin` (`config/portfolio.json:14`) e **só vale no psql** — o código lê da config (D3).

### Sistema: seis gates iguais na tela, quatro naturezas de bloqueio (medição 02/09 14:52:19Z, config 1.2.0)

| Gate | Situação | Natureza real | Tem data? | Chaves de `metrics_json` que a barra usa |
| --- | --- | --- | --- | --- |
| G1 | `INSUFFICIENT_DATA` | **modelo**: nenhum promovido (`model_forecasts 0`) | não | `model_resolved_markets`, `model_forecasts`, `required` (`gates.ts:157–159`) |
| G2 | `INSUFFICIENT_DATA` | **defeito**: a liquidação lê `payload_json.outcomePrices` (`paper/brokerstore.ts:2462`), coletor grava em `raw.outcomePrices`; 0 fechamentos na história | **não** | `shortfalls.{days,closed_positions,distinct_markets,categories,distinct_close_days}.{have,need}` (`gates.ts:314–341`); `days`, `closed_positions` (`:438–446`). Medido: `days 4,76/60`, `closed_positions 0/100`, `distinct_markets 0/30` |
| G3 | `INSUFFICIENT_DATA` | herda o G2 (base de evidência) | não | `max_drawdown` (`gates.ts:548`) |
| G4 | `INSUFFICIENT_DATA` | **defeito** (herda os fills do G2) | **não** | `fee_samples`, `slippage_samples`, `samples_required` (`gates.ts:637–639`); medido `0/100` |
| G5 | `INSUFFICIENT_DATA` | **relógio**: piso de 60 dias desde 28/08 20:38:47Z | **2026-10-27 20:38:47Z** | `below_minimum_days` (**lista de categorias**, não número), `required_days` (`gates.ts:754–755`). A data **não está** no `metrics_json`: vem de `portfolio_g2_clock.clock_start` (`0014:413–416`), que `gatestore.ts:521` já lê |
| G6 | `INSUFFICIENT_DATA` | **decisão do proprietário** | não | `current_report_id` (`gates.ts:801`) |

O rótulo atual é um só para os seis: "Sem dado bastante" (`apps/web/src/dicionario.ts:65–83`). `GET /overview` publica os gates **sem** `metrics_json` (`overview.ts:409–412`); `GET /polymarket/gates` publica com (`portfolio/api.ts:355–365`) e o frontend já o parseia (`apps/web/src/portfolio.ts:421`, `:549`). Nenhuma rota publica hoje o `clock_start`.

### Publicado e não consumido; cru na tela

| Fato | Origem |
| --- | --- |
| `GET /polymarket/data-quality` publicado (`location =`) e sem consumidor no frontend | `infra/nginx/nginx.conf:176`; `readapi.ts:944`; `grep -rn "data-quality\|portfolio/limits" apps/web/src` vazio (03/09) |
| `GET /polymarket/portfolio/limits` publicado (sob `^~ /api/polymarket/portfolio`) e sem consumidor | `nginx.conf:120`; `portfolio/api.ts:294–318` |
| Disjuntores abertos já publicados (`kind`, `started_at`, `ended_at IS NULL`) | `GET /portfolio/state`, `portfolio/api.ts:339–350` |
| Feed "O que aconteceu" renderiza `detail` como `JSON.stringify` dentro de `<details>` | `apps/web/src/Overview.tsx:529–532` |
| Texto com número fixo: "as recusas são 234.549 das 234.571 linhas do log" | `Overview.tsx:507` |
| Idades já publicadas em `/overview`: `circuit_breakers.most_recent_at`, `collection.last_book_delta_age_ms`, `model.last_estimate_at`, `paper.fills_24h`, `measured_at` por gate | `overview.ts:504–535`, `:410` |
| Sem heartbeat por worker no banco | fase 2, fora desta RFC |

---

## Decisões que esta RFC exige do proprietário

| # | Decisão | Opções | Default se não houver resposta |
| --- | --- | --- | --- |
| P1 | O funil das 24 h pode custar uma migration (tabela `portfolio_decision_hourly`, escrita só pelo worker) se o `EXPLAIN` do caminho A não fechar? | A: só leitura na API; B: migration nova (0019, a próxima livre em 03/09) | **B**, condicionado à medição (D1) |
| P2 | As 500 linhas cruas saem da tela padrão de Decisões e ficam atrás de um filtro "Todas (últimas 500)"? | sim / não | sim |
| P3 | A etiqueta "travado por defeito, sem data" em G2/G4 é aceitável como texto do painel, com a causa nomeada (liquidação)? | sim / redigir de outro modo | sim |
| P4 | O feed mostra JSON cru só no "modo engenheiro" (toggle local, sem persistência no servidor)? | sim / manter `<details>` sempre | sim |

---

## Decisões desta RFC

### D1 — o funil das 24 h é contado sobre o log inteiro, nunca sobre amostra

Um funil desenhado sobre 500 linhas é um funil de 45 minutos com título de 24 horas. A tela **não desenha funil de amostra**; se o agregado não estiver disponível, mostra "funil indisponível" e o motivo.

Dois caminhos, decididos por medição, nesta ordem:

- **A (sem migration):** `GET /overview` ganha o bloco `funnel_24h` com `SELECT reason_code, outcome, count(*) FROM portfolio_decisions WHERE decision_kind = 'ENTRY' AND decision_ts > now() - interval '24 hours' GROUP BY 1, 2`. O predicado casa o índice `portfolio_decisions_kind_idx (decision_kind, decision_ts DESC)` (`0014:193–194`); são ~53 k linhas por 24 h. Vale se `EXPLAIN (ANALYZE, BUFFERS)` em produção der `max(3 × quente p95, 1,5 × frio nos 2 min pós-CD) ≤ 500 ms` — metade do 1 s do pool (`database.ts:51`), na regra de folga da RFC-023 D1. Se a RFC-023 já estiver em produção, o teto é o orçamento da rota `/overview`. Se mede, não se assume.
- **B (migration nova — 0019, a próxima livre em 03/09):** tabela `portfolio_decision_hourly (hour_start timestamptz, reason_code text, outcome text, decisions bigint, markets int, PRIMARY KEY (hour_start, reason_code, outcome))`, escrita **só pelo worker de portfólio** ao fim de cada `PORTFOLIO_CYCLE` (upsert da hora corrente e da anterior; o worker não tem o `statement_timeout` de 1 s). A API lê 24–25 linhas × códigos. Tabela `protected` na lista de retenção, TTL 90 dias, ~9 códigos × 24 h ≈ 200 linhas/dia.

Em qualquer caminho, o bloco leva `window_from`, `window_to` e `source: "log" | "hourly"`. Os degraus ordem/fill/fechamento vêm do ledger (`paper.fills_24h` já existe em `/overview`) e são rotulados com a própria janela.

### D2 — o último ciclo sai do log e entra no `/overview`

Caminho A: derivado de `portfolio_panel_snapshots`, que recebe **todos** os mercados avaliados a cada ciclo com o mesmo `computed_at` (`runner.ts:968–993`, `ON CONFLICT (token_id, computed_at)`), no `computed_at = max(computed_at)` — não `received_at`: a UNIQUE é `(token_id, computed_at)` (`0014:341`) e `portfolio_panel_snapshots_latest_idx` cobre `computed_at DESC` (`0014:346–347`). `evaluated = count(*)`, `entrable = count(*) FILTER (WHERE entrable)`, `vetoed`; `open_breakers` já está em `circuit_breakers.open`; `stale_marks` reusa a consulta de `exitstore.ts:175–204`. Caminho B: a mesma migration cria `portfolio_cycle_summary` (1 linha, upsert **só pelo worker**, os sete campos do `runner.ts:1009–1018`; a API nunca a escreve). O painel diz "nenhum mercado entrável agora (54 sob disjuntor, 1 marca velha)" com número do ciclo, não da amostra.

### D3 — "Quase" e "Congeladas" são leituras do que já está gravado

- **Quase:** agregado **no servidor**, nunca no cliente. Motivo: o SELECT de `GET /polymarket/decisions` (`portfolio/api.ts:491–495`) não devolve `costs_total` nem `safety_margin`, `edgeLiqMin` (= 0,02, `config/portfolio.json:14`) só é publicado pelo bloco `config` de `/portfolio/limits` que o PR 1 da RFC-026 acrescenta (D6 dela), e o aceite 4 proíbe carregar `/decisions` por padrão. `GET /overview` ganha o bloco `near_misses_24h: [{reason_code, count, folga_min, folga_p50}]` sobre as mesmas 24 h e o mesmo caminho do D1 (A: consulta com `reason_code IN (…)` no mesmo índice; B: colunas `near_misses`, `folga_min` em `portfolio_decision_hourly`). A folga é calculada na API com o `edgeLiqMin` da config já carregada; o limite **não** é republicado no `/overview` — o front o lê do bloco `config` de `/portfolio/limits` (RFC-026 D6), única fonte publicada. Folga: `q_lo − exec_price − costs_total − safety_margin` (LOWER_BOUND) ou `edge_net − edge_liq_min` (EDGE); entra se > −0,01. Aritmética em texto decimal, nunca float; o frontend **não fixa 0,02** e só formata ("faltou 0,4 c" = `folga_min` em centavos).
- **Congeladas:** disjuntores abertos (`open_circuit_breakers` de `/portfolio/state`, `portfolio/api.ts:339–350`), agrupados por `kind`, com contagem regressiva `started_at + window_ms − now` para `PARAM_CHANGE`/`RULE_CLARIFICATION` e causa em PT pelo dicionário `TIPO_DISJUNTOR` (`dicionario.ts:159`). O `window_ms` (= `BREAKER_EVENT_WINDOW_MS`, `breakers.ts:102`) passa a viajar na mesma resposta; o frontend **não** fixa 24 h. Nenhum disjuntor é fechado, alterado ou contornado pelo painel.

### D4 — as 500 linhas cruas deixam de ser a tela padrão

A tela Decisões abre em funil + último ciclo + Quase + Congeladas. A tabela crua fica atrás do filtro "Todas (últimas 500)", com o aviso "últimas 500 linhas ≈ 45 min de log". `HISTORY_LIMIT` não sobe.

### D5 — natureza do bloqueio por gate, sem migration e sem tocar o gate

Uma tabela **no frontend** (`dicionario.ts`, verbete novo `NATUREZA_BLOQUEIO`) mapeia `gate × reason_code × chaves de metrics_json` para uma de quatro etiquetas: **relógio com data** (G5: data = `clock_start + required_days`), **travado por defeito, sem data** (G2, G4: `closed_positions = 0` e a causa nomeada), **decisão do proprietário** (G6), **depende de modelo promovido** (G1: `model_forecasts = 0`). A regra é dado-dirigida: quando `closed_positions > 0`, a etiqueta do G2 vira "acumulando" sozinha. Barras "tem/precisa" lidas dos pares já publicados (`shortfalls.*.have/need` no G2; `model_resolved_markets/required` no G1; `fee_samples/samples_required` no G4). O código do gate e o `reason_code` permanecem visíveis (regra do dicionário: o código nunca some).

Fonte: `GET /polymarket/gates` (tem `metrics_json`), que ganha o campo `g2_clock: [{category, clock_start, regime_fingerprint, last_reset_reason}]` lido de `portfolio_g2_clock` (2 linhas, chave primária; `gatestore.ts:520–523` já faz esse SELECT com as quatro colunas — `last_reset_reason` entra para a etiqueta "relógio reiniciado por X"; `last_reset_at` fica de fora). Mesma rota, mesma location, sem migration. `/overview` não muda para isso. Se `g2_clock` vier vazio, G5 mostra "relógio não iniciado", nunca uma data inventada.

### D6 — consumidores para o que já está publicado; feed traduzido

`/data-quality` vira a seção "Qualidade de dados" (quotas por tabela, lacunas 24 h, lag p50/p99); `/portfolio/limits` vira "Limites" (caps por dimensão e limitador dominante das 24 h). Semáforos por fonte derivados das idades já em `/overview`: verde < 60 s, âmbar < 5 min, vermelho acima; "não medido no painel" para o que não tem idade publicada (heartbeat por worker fica para a fase 2). O `detail` do feed é traduzido por chaves conhecidas do dicionário; `JSON.stringify` só no modo engenheiro. Textos com número fixo saem. Se a RFC-024 estiver em produção, `/data-quality` traz também a cobertura do universo rápido (RFC-024 D4): exibir, não recalcular.

---

## Escopo, em PRs

| # | Item | Muda comportamento? | Migration? | Perímetro? |
| --- | --- | --- | --- | --- |
| 1 | Funil 24 h + último ciclo + `near_misses_24h` no `/overview` (D1–D3); `window_ms` em `/portfolio/state`; Congeladas e tela padrão sem as 500 cruas (D3, D4) | leitura só | **só no caminho B** (migration nova, escrita pelo worker) | não (blocos dentro de rotas já publicadas) |
| 2 | Sistema fase 1: natureza do bloqueio + barras (D5) com `g2_clock` em `/polymarket/gates`; `/data-quality`, `/limits`, semáforos, feed traduzido (D6) | leitura só | não | não (rotas já publicadas) |

## Testes obrigatórios

- PR 1: `apps/api/test/polymarket/overview.test.ts` — bloco `funnel_24h` com `window_from/to` e `source`; sem agregado disponível a resposta traz `funnel_24h: null` e a UI (`apps/web/test/overview.test.ts`) mostra "indisponível", **não** desenha barras. Caminho B: teste do upsert horário e do de `portfolio_cycle_summary` (idempotentes: duas execuções, uma linha) e de que só o worker escreve (a API não tem caminho de escrita); `RETENTION_TABLES` (`retention.ts:128`) inclui as tabelas novas como `protected: true`. Folga do "Quase" calculada **na API** em decimal com casos de borda (−0,0099 entra, −0,0100 não) e `edgeLiqMin` vindo da config, não de literal; regressão: `near_misses_24h` ausente da resposta no código anterior. Contagem regressiva do `PARAM_CHANGE` com `started_at` e `window_ms` fixos.
- PR 2: `apps/web/test/dicionario.test.ts` — regressão: fixture com o `metrics_json` real dos seis gates de 02/09 exige `NATUREZA_BLOQUEIO`, que não existe no código anterior (o teste falha por import); as quatro etiquetas a partir dessa fixture; `closed_positions > 0` muda a etiqueta do G2 sem mudar código; G5 com `g2_clock` vazio dá "relógio não iniciado". `apps/web/test/overview.test.ts` — `detail` com chaves conhecidas vira texto; chave desconhecida cai no modo engenheiro sem quebrar. Semáforo: 59 s verde, 61 s âmbar, 301 s vermelho. API: `/polymarket/gates` devolve `g2_clock` com as 2 categorias do fixture.
- Cada teste de regressão verificado **falhando no código anterior**. `scripts/tests/test_nginx_perimeter.py` verde (nada novo publicado).

## Critérios de aceite (verificáveis em produção após o rebuild)

1. Na tela Decisões, uma linha legível: "N avaliadas → n aceitas → o ordens → f fills" com os números de `funnel_24h` iguais a `SELECT outcome, reason_code, count(*) … 24h` em psql (tolerância: o ciclo em andamento).
2. `curl` autenticado em `/api/polymarket/overview` traz `funnel_24h.source`, `window_from`, `window_to` e `last_cycle.evaluated` igual ao último `PORTFOLIO_CYCLE` do `docker logs` do worker (±1 ciclo).
3. G2 e G4 aparecem como "travado por defeito, sem data"; G5 com a data `2026-10-27 20:38:47Z` (= `clock_start` de `SELECT category, clock_start FROM portfolio_g2_clock` + 60 d); G1 "depende de modelo promovido"; G6 "decisão do proprietário". Nenhum aparece como "esperando" sem data. Se a liquidação (PR-0 b) já tiver fechado posições, G2 mostra "acumulando N/100" — e isso é aceite, não falha.
4. Nenhuma requisição do painel a `/decisions` no carregamento padrão da tela Decisões (aba de rede); a tabela crua só carrega no filtro.
5. Zero `JSON.stringify` visível fora do modo engenheiro; zero texto com número fixo (`grep -n "234\." apps/web/src` vazio).
6. Consulta do funil dentro do orçamento da rota: `EXPLAIN` registrado na RFC (seção "Medido depois"), quente e frio; **zero timeout da API nas 24 h após o deploy** — com o PR 2 da RFC-023 em produção, `docker logs ganso-market-api-1 --since 24h | grep -c '"pg_code":"57014"'` = 0 (método A3 da RFC-023); antes dele, `canceling statement` no log do postgres, com a ressalva de que ele não separa API de worker.

## Condições de parada

- Qualquer escrita do painel ou da API em tabela de decisão, disjuntor, gate ou estado — o único POST continua sendo o rearme do kill switch já existente.
- Caminho A fora do orçamento **e** migration não aprovada (P1): o PR 1 entrega só Congeladas e D4 (o Quase depende do mesmo agregado) e registra o bloqueio.
- Qualquer mudança em `config/portfolio.json`, nos gates, em `HISTORY_LIMIT` ou em `BREAKER_EVENT_WINDOW_MS`.
- `make verify` vermelho; teste de perímetro vermelho.
- PR 1 da RFC-026 (telas com teclas `3` Decisões e `6` Sistema, modo engenheiro) ainda não mergeado quando a sessão começar: parar e registrar. O PR 2 da RFC-026 (filtros em `/decisions`) é desejável, não obrigatório.
- Qualquer número de produção fixado em texto da tela (a regra vale para os desta RFC também).

## Medido depois

(preenchido pela sessão executora: `EXPLAIN` quente/frio do funil, caminho escolhido, `release-sha` dos containers, `curl` do aceite 2, captura do aceite 3.)
