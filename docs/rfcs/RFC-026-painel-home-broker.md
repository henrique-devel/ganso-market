# RFC-026 — Painel home broker (paper): Mesa, Carteira, Decisões, Resolução e séries de preço sobre o React existente, só GET, perímetro intacto

**Status:** accepted — autorizado para implementação (2026-09-04); seguir as recomendações da tabela P1–P5
**Origem:** diagnóstico de 2026-09-02/03 (relatório publicado: https://claude.ai/code/artifact/f7e3e623-831a-464f-8435-6cc671d325e6 — item RFC-026, auditoria UX, claims C1–C9); mockups no canvas "Ganso Market · Mesa do Operador": https://claude.ai/code/artifact/60e2fbdd-23eb-45ab-92a6-834b166ea95e
**Dependências:** **PR-0 (a)** — hotfix sem RFC (`prompts/roadmap/11-hotfixes-pr0-overview-settlement-sombra.md`, item a): `GET /polymarket/overview` responde 500 em produção porque `apps/api/src/polymarket/overview.ts:466` filtra por `occurred_at` (a coluna é `event_ts`). A faixa da carteira lê o `/overview`; sem o PR-0 (a) esta RFC nasce cega. RFC-015 (faixa de PnL, `/overview`, `/events`, `dicionario.ts` — mantidos), RFC-002 (perímetro: GET-only, sessão, `location =` sob `/paper`), RFC-013 (`panel_json` do motor — lido, não alterado)
**Habilita:** o operador lê o nome do mercado em toda célula, vê por que o motor recusa ("faltam 0,004 para aceitar"), vê o livro de 10 níveis que já viaja e é descartado, vê posições com PnL calculado no servidor e ordens com fila, e vê o primeiro gráfico de preço do painel. Base de tela para a RFC-027 (funil pré-agregado e Sistema fase 1) e para a tela Sombra da RFC-029 (tecla `4`)

## Prompt a executar

Índice `prompts/roadmap/18-rfc-026-painel-home-broker.md` e **três sessões, uma por PR**: `18a-rfc-026-pr1-mesa.md`, `18b-rfc-026-pr2-carteira.md`, `18c-rfc-026-pr3-series.md`. Dividido porque os três PRs tocam conjuntos quase disjuntos de arquivos (web; `paper/api.ts` + Nginx + teste de perímetro; `readapi.ts` + Nginx + SVG) e um prompt único estouraria o teto de 3–8 arquivos de contexto e de 900 palavras por sessão. Tudo em SIMULAÇÃO: zero endpoint de escrita, zero migration, zero gate tocado, nenhum `replayDecision`.

---

## Fatos medidos (02–03/09/2026; RE-MEDIR antes de codar)

Linhas conferidas no worktree em 2026-09-03 (`git rev-parse --short HEAD` = `ef7ca2d`). Contagens de banco medidas em produção em 02/09 14:55–15:10Z (auditoria UX, leitor 4).

### O que a tela mostra hoje

| Fato | Onde | Valor |
| --- | --- | --- |
| Abas do painel | `apps/web/src/App.tsx:203` | 4 (`visao`, `status`, `resolucao`, `portfolio`) |
| Sub-abas do Portfólio | `apps/web/src/Portfolio.tsx:57-64` | 7; tabelas de 9–10 colunas; Decisões baixa **500** linhas fixas a cada 30 s (`HISTORY_LIMIT`, `portfolio/api.ts:38`) |
| Coluna "Mercado" = `condition_id` truncado | `Portfolio.tsx:292`, `:974`, `:1131` (`slice(0, 12)`) | 3 tabelas; **110 de 110** mercados do painel têm `question` em `polymarket_markets` (claim C1 do relatório, psql 02/09) |
| `/opportunities` faz `LEFT JOIN polymarket_markets m` e não seleciona `question`/`category` | `apps/api/src/polymarket/portfolio/api.ts:201-225` (JOIN em `:215`) | — |
| `/decisions` não faz JOIN algum e não seleciona `paper_order_id` | `portfolio/api.ts:487-505` (coluna criada em `migrations/0014_polymarket_portfolio_engine.sql:143`; `0015_decision_to_paper_bridge.sql:54-58` é só o índice parcial `portfolio_decisions_bridge_pending_idx` que a usa) | o cliente não sabe se um aceite virou ordem |
| Badge imprime rótulo + código colados ("Normal NORMAL") | `apps/web/src/Overview.tsx:101-132` (`compacto` só em `:129`); `Portfolio.tsx` usa `<Badge>` 9× sem `compacto` | — |
| `parsePanel` descarta `book.bids/asks` | `apps/web/src/portfolio.ts:190-244` (só `book.spread`, `:215`); o motor grava 10 níveis (`portfolio/engine.ts:257-258`) | 10 níveis viajam e somem |
| Largura do painel | `apps/web/src/styles.css:210-211` `.shell--wide` | `min(72rem, …)` |
| Textos com número fixo que envelhece | `Overview.tsx:507` ("234.549 das 234.571"); `Portfolio.tsx:933` ("715 ms") | — |
| Resolução lista 200 sem aviso | `resolution/api.ts:25` `LIST_LIMIT = 200`; `Resolution.tsx:562` (`markets.map`) | **200 de 824** (auditoria UX 02/09; re-medir: `count(*)` da consulta de `resolution/api.ts:160-168` sem o `LIMIT`) |
| Polls | `App.tsx:24` 15 s (status); `Overview.tsx:33-34` 15 s (`/overview` + `/paper/performance`) e 5 s (`/events`); `Resolution.tsx:28,69-75` 6 fetches em `Promise.all` a cada 15 s; `Portfolio.tsx:50` 30 s | Resolução ≈ **48 req/min** = 24 (aba) + 12 (`/events`) + 8 (faixa) + 4 (status); conferir no access log |

### O que a API já tem e o edge fecha

| Fato | Onde | Valor |
| --- | --- | --- |
| `GET /polymarket/paper/positions` calcula `unrealized_pnl_usd` e `current_lockup_s` | `apps/api/src/polymarket/paper/api.ts:410-455` (`:439-443`) | fechado: `infra/nginx/nginx.conf:229` `^~ /api/ → 404` |
| `GET /polymarket/paper/orders` (`SELECT *`, inclui `queue_ahead`) | `paper/api.ts:373-407`; `SELECT count(*), count(queue_ahead) FROM paper_orders` (02/09) | fechado; `queue_ahead` preenchido em **18 de 18** ordens; `pipeline.open_orders` o omite (`resolution/api.ts:221-226`) |
| Teste de perímetro só aceita `location =` sob `/paper`, na allowlist; `test_the_order_creating_surfaces_stay_closed` afirma que `paper/orders` e `paper/positions` **não** aparecem em `location` algum | `scripts/tests/test_nginx_perimeter.py:36` (`PAPER_ALLOWLIST`), `:72-95`, `:96-111` (`test_the_rfc_015_read_surfaces_are_exact_and_get_only`), `:113-123` (lista fechada) | 2 entradas hoje (`rearm` POST, `performance` GET); publicar os dois **quebra** `:113-123` como está |
| `GET /polymarket/series/:tokenId` devolve `best_bid, best_ask, spread, mid_close` — sem OHLC | `apps/api/src/polymarket/readapi.ts:809-902` (comentário em `:809`, `app.get` em `:814`, colunas em `:838`); `SERIES_LIMIT = 10_000` (`:138`) | fechado |
| `polymarket_series_1m` tem `mid_open/mid_high/mid_low/mid_close`, `updates_count` | `migrations/0005_polymarket_data_foundation.sql:138-154`; `SELECT count(DISTINCT token_id) FROM polymarket_series_1m WHERE bucket_start > now() - interval '1 hour'` | **210 tokens** com bucket na última hora (02/09 15:02Z) |
| `/data-quality` e `/portfolio/limits` publicados e não consumidos | `nginx.conf:176`, `:120`; `portfolio/api.ts:295`; `grep -rn "data-quality\|portfolio/limits" apps/web/src` | 0 ocorrências |
| `proxy_read_timeout 5s` veta SSE | `nginx.conf:22` | tudo continua poll |
| `fundamental_labels.is_final` existe | `migrations/0006_polymarket_fundamental_model.sql:179` | base do selo "resolvido na venue, não liquidado" |
| Índices de `portfolio_decisions` | `migrations/0014_polymarket_portfolio_engine.sql:189-195` | `condition_id` indexado; `outcome` **não** |
| Limites de frescor e de edge só na config: nenhuma rota GET os expõe e o front não lê `config/portfolio.json` | `config/portfolio.json:46-47` (`bookMaxAgeMs 30000`, `estimateMaxAgeMs 300000`); `edgeLiqMin 0.02` (`:14`), `safetyMarginMin 0.01` (`:10`); `grep -rn 'edgeLiqMin\|safetyMarginMin\|bookMaxAgeMs\|estimateMaxAgeMs' apps/api/src/polymarket/portfolio/api.ts apps/api/src/polymarket/overview.ts apps/web/src` | **0 ocorrências** (03/09) → D6 acrescenta o bloco `config` a `/portfolio/limits` |
| Decisões nas 24 h | psql 02/09: `SELECT outcome, count(*) FROM portfolio_decisions WHERE decision_ts > now() - interval '24 hours' GROUP BY 1` | **94 `ACCEPTED`** contra **52 868 `REJECTED`** |
| Kill switch engatado | `docs/HANDOFF.md:378` | desde 02/09 02:21:05Z, `RECORDER_STALE` |
| PR-0 (a) ainda pendente | `grep -n "AND occurred_at" apps/api/src/polymarket/overview.ts` → `:466` (o grep cru de `occurred_at` **não** serve: é alias legítimo em `:157`, `:297`, `:600`) | pré-condição aberta em 03/09 |

---

## Decisões desta RFC

### D1 — Redesenho mínimo sobre o React existente, só GET, perímetro intacto

Nenhuma biblioteca nova, nenhum framework, nenhum SSE. O que muda é composição de tela e quatro acréscimos de leitura na API (D2, D6, D8, D10). Os únicos locations novos são os de D8 e D10; o único POST do painel continua o rearme do kill switch (`nginx.conf:218`). Nenhuma escrita em tabela de decisão pelo painel, nunca.

### D2 — Nome do mercado em toda célula; hash em tooltip

`m.question` e `m.category` entram no SELECT de `/opportunities` (JOIN já existe) e `/decisions` ganha o mesmo `LEFT JOIN polymarket_markets` (PK `condition_id`, 500 lookups por índice) mais a coluna `paper_order_id`. `condition_id`/`token_id` vão para `title` e para o modo engenheiro. Alternativa recusada: publicar `^~ /api/polymarket/markets` (limite 500 < 1 205 mercados — `docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md:74`, 02/09 —, e é um prefixo novo para resolver um SELECT).

### D3 — Cor com semântica fixa; ausência nunca é zero

| Cor | Significa |
| --- | --- |
| Verde | ganho, dado fresco, gate `PASS` |
| Vermelho | perda, falha, recusa por **dado** velho ou ausente, bloqueio que não sai sozinho (kill switch, `HALTED`) |
| Âmbar | envelhecido, disjuntor aberto, `INSUFFICIENT_DATA`, "quase" |
| Cinza | recusa por **regra** de negócio (banda, custos, edge mínimo) — é o normal do motor e não grita; "não medido", "sem dado" |
| Roxo tracejado + selo HIPOTÉTICO | tudo que vem da sombra: no panel `estimate.source` (`apps/web/src/portfolio.ts:213`), na decisão a coluna `estimate_source` (`migrations/0014:79`) de modelo não promovido |

Alta/baixa (verde/vermelho) só em variação de preço e PnL; comprar/vender em azul/laranja. Nunca só cor: sempre ● + palavra. Idade dos dados como cor contínua com limites lidos do bloco `config` de `/portfolio/limits` (D6) — nunca fixos no front.

### D4 — Badge compacto por padrão; modo engenheiro reinjeta o código

`compacto` vira padrão do `Badge`; a tecla `?` liga o modo engenheiro (persistido em `localStorage`), que volta a imprimir o `<code>`, mostra `condition_id`, `token_id`, `config_version/hash`, `snapshot_id` e o JSON cru em `<details>`. O invariante do `dicionario.ts` ("o código nunca some") continua: `title` sempre carrega o código.

### D5 — Mapa de telas, faixa fixa, teclas 1–6

| Tecla | Tela | Substitui | Poll | Fontes |
| --- | --- | --- | --- | --- |
| — | Faixa da carteira (fixa) | faixa de PnL | 15 s | `/overview`, `/paper/performance` |
| `1` | **Mesa** (default) | Visão geral + Oportunidades + Rápidos | 30 s | `/opportunities` (+`question`, `category`), `/decisions` (cliente), `/series?tokens=` (PR 3) |
| `2` | **Carteira** | Exposição + Estado + pipeline paper | 30 s | `/paper/positions`, `/paper/orders` (PR 2), `/portfolio/{exposure,limits,state}` |
| `3` | **Decisões** | Decisões + Consulta | 30 s | `/decisions?outcome=&condition_id=`, `/decisions/:id` |
| `4` | reservada (Sombra) | — | — | RFC-029; não entra aqui |
| `5` | **Resolução** | aba atual, em duas colunas | 15 s | inalterado; aviso "200 de 824" |
| `6` | **Sistema** | Status + Gates + cards | 15 s | casca aqui; fase 1 na RFC-027 |

Layout `min(100rem, calc(100% - 2rem))` em duas colunas (lista/detalhe), colapsando abaixo de 1 100 px. Orçamento: faixa + Mesa ≤ 20 req/min. Soma prevista por minuto: status do App 4 + `/overview` 4 + `/paper/performance` 4 + `/opportunities` 2 + `/decisions` 2 + `/series?tokens=` 2 (PR 3) = **18**; o feed `/events` a 5 s (12/min) não roda na Mesa, só em Sistema.

### D6 — Escada do motor com folga para aceitar; cartão PRD; livro L2

O detalhe do mercado (Mesa, coluna direita) tem, nesta ordem: (1) **escada** na ordem do `engine.ts` — disjuntor → livro → estimativa → banda → custos → edge → tamanho — com ✓/✗ e valor medido por degrau, lida do `panel_json` e da última decisão; barra de **folga para aceitar** = `edge.net − max(costs.safety_margin, edgeLiqMin)` — `edge` só tem `gross` e `net` (`engine.ts:134`); `safety_margin` fica em `costs` (`:135-141`); `edgeLiqMin` vem do bloco `config` abaixo —, "faltam 0,004 para aceitar"; degrau sem dado → "não medido" em cinza; (2) **cartão das 8 respostas do PRD** (POLY-10/16, `docs/PRD.md:330,336`), todas de `panel_json` já publicado (interface `PanelFields`, `engine.ts:116-185`: `market_probability`, `estimate`, `suggested_side`, `edge` (`gross`, `net`), `costs` (com `safety_margin`), `max_size` + `limiters` via `LIMITADOR` do `dicionario.ts`, `resolution_risk`, `entry_reason`/`invalidation_condition`, `data_freshness`); `correlated_markets`, `rule_excerpt` e `scenarios` só no modo engenheiro; (3) **livro L2** de 10 níveis em barras bid/ask de `panel_json.book.bids/asks` — o parser passa a lê-los; marca o preço da ordem sugerida e, com ordem minha, `queue_ahead` (PR 2). Nada disso é dado novo: é o que o motor já grava. **Bloco `config` em `/portfolio/limits`** (`portfolio/api.ts:294-296`, já publicado por `^~ /api/polymarket/portfolio`, `nginx.conf:120`): `edgeLiqMin`, `safetyMarginMin`, `bookMaxAgeMs`, `estimateMaxAgeMs`, `config_version`, lidos da config carregada pela API. É o único acréscimo do PR 1 além dos dois SELECTs; sem ele o front fixaria 0,02 e violaria D3.

### D7 — Bloco "O que eu faço agora?"

Até 3 frases, regra no cliente sobre dados publicados; frase só quando exige ação ou decisão do operador — recusa rotineira nunca vira frase. Fontes: kill switch engatado (`overview.kill_switch.engaged` — no topo da resposta, irmão de `portfolio` e `gates`, `apps/api/src/polymarket/overview.ts:506`; colunas `engaged, reason, engaged_at, rearmed_at, frozen_count`, `:402-405`; parser `parseKillSwitch`, `apps/web/src/overview.ts:174` — com o botão de rearme já existente); aceites sem ordem (`/decisions` com `outcome = ACCEPTED` e `paper_order_id IS NULL`, com aviso "amostra das últimas 500"); posição com mercado resolvido na venue e não liquidada no paper (`pending_settlement`, D8). Vazio → "nada exige ação agora" em cinza.

### D8 — `/paper/positions` e `/paper/orders` publicados por `location =`, GET

Mesmo padrão do `performance` (aprovado em 28/08, `nginx.conf:193-200`): `location = /api/polymarket/paper/positions` e `= /api/polymarket/paper/orders`, `$request_method != GET → 404`. No teste, em dois passos: (a) os dois paths **saem** da lista fechada de `test_the_order_creating_surfaces_stay_closed` (`test_nginx_perimeter.py:113-123`; como está, falha se eles aparecerem em qualquer `location`) e **entram** em `PAPER_ALLOWLIST` (`:36`, 4 entradas) — `intents`, `kill-switch`, `portfolio/halt` e `portfolio/resume` ficam na lista fechada; (b) `test_the_rfc_015_read_surfaces_are_exact_and_get_only` (`:96-111`) passa a cobrir os dois. `/paper/positions` ganha `LEFT JOIN polymarket_markets` (`question`) e `LEFT JOIN fundamental_labels fl ON fl.token_id = paper_positions.token_id` (PK `token_id`, `migrations/0006:172`; **nunca** por `condition_id`, que não é único — 2 tokens por mercado, índice `:189` — e duplicaria cada posição) → campo `pending_settlement = is_final AND shares > 0`; a heurística `mark_stale + end_ts < now` não é usada. Nenhum prefixo sob `/paper`, jamais: publicaria `POST /paper/intents`.

### D9 — Filtros em `/decisions` medidos sob o orçamento de 1 s

`?outcome=&condition_id=` na mesma rota e location `^~` (`nginx.conf:138`). `condition_id` usa `portfolio_decisions_market_idx`; `outcome` não tem índice. Antes de publicar: `EXPLAIN (ANALYZE, BUFFERS)` da consulta filtrada em psql direto, a quente e a frio. Se p95 a frio > 500 ms sem índice novo, **fallback**: manter `LIMIT 500` e filtrar no cliente com o aviso "das últimas 500". Índice novo exige migration e fica fora desta RFC. Filtro padrão da tela: **Aceitas**.

### D10 — Séries: `metric=ohlc`, lote `?tokens=`, `^~ /api/polymarket/series` GET-only, SVG sem biblioteca

`metric=ohlc` devolve `bucket_start, mid_open, mid_high, mid_low, mid_close, updates_count` de `polymarket_series_1m` (PK `token_id, bucket_start` → range scan). Variante em lote `GET /polymarket/series?tokens=a,b,c&metric=ohlc&from=` para a página visível (uma requisição, não 25), com teto de 25 tokens e `SERIES_LIMIT` total; `from` passa a ser **obrigatório** em `ohlc` e no lote (hoje `from`/`to` são opcionais, `readapi.ts:829-830` — sem `from`, `LIMIT 10 000` vira varredura de dias). Location `^~ /api/polymarket/series` GET-only no padrão de `/gates` (`nginx.conf:129-136`) — publica também `spread/depth/oi/holders`, que já existem e são leitura. Sparkline de 60 buckets por linha da Mesa; gráfico 24 h no detalhe com banda `mid_low/high` e marcas ▲ aceites, □ ordens, ● fills, linha vermelha em engates (de `/decisions` e `/events`). Medir o custo do lote (25 tokens × 60 buckets e 1 × 1 440) sob 1 s **antes** de publicar.

### D11 — Tudo continua poll; a tela diz "atualizado há N s"

`proxy_read_timeout 5s` veta SSE. Nenhum location dedicado a stream nesta RFC. Cada tela declara a idade do que mostra.

---

## Decisões do proprietário que esta RFC exige

| # | Decisão | Padrão se aprovada |
| --- | --- | --- |
| P1 | Publicar `GET /paper/positions` e `GET /paper/orders` como `location =` (dois locations novos sob `/paper`) | D8 |
| P2 | Publicar `^~ /api/polymarket/series` GET-only (prefixo novo fora de `/paper`; expõe também `spread/depth/oi/holders`) | D10 |
| P3 | Sequência: PR-0 (a) antes do PR 1; PR 1 → 2 → 3; Sistema fase 1 e funil na RFC-027; tecla `4` reservada à Sombra | D5 |
| P4 | Largura 100 rem em duas colunas (é a sua tela) e SVG próprio sem biblioteca (0 dependências novas) | D5, D10 |
| P5 | Filtro padrão de Decisões = Aceitas; cinza para recusa por regra (não vermelho) | D3, D9 |

Sem P1 o PR 2 fica só na parte web + `/decisions`; sem P2 o PR 3 não inicia.

## Escopo, em PRs

| PR | Conteúdo | Endpoints | Locations | Migration |
| --- | --- | --- | --- | --- |
| **1** | `m.question, m.category` em `/opportunities`; JOIN + `paper_order_id` em `/decisions`; layout 100 rem; cascas Mesa/Carteira/Decisões/Resolução/Sistema com teclas; modo engenheiro; Badge compacto; ordenação/filtro cliente (chips Todos/Rápidos/Com posição); bloco "O que eu faço agora?"; escada; cartão PRD; livro L2 (parser lê `book.bids/asks`); textos com número fixo saem | 0 novos (2 SELECTs + bloco `config` em `/portfolio/limits`) | 0 | 0 |
| **2** | `= /paper/positions` e `= /paper/orders` + `PAPER_ALLOWLIST`; JOIN `question` e `is_final` em positions; `?outcome=&condition_id=` em `/decisions` com EXPLAIN (fallback cliente); cartões de posição, ordens com fila, barras de limites, estado | 0 novos (2 publicados, 2 alterados) | 2 | 0 |
| **3** | `metric=ohlc` e `?tokens=` em `/series`; `^~ /series` GET-only; sparkline 1 h e gráfico 24 h com marcas em SVG; custo do lote medido antes | 1 rota de leitura nova (lote `GET /polymarket/series?tokens=`) + 1 variante `metric=ohlc` | 1 | 0 |

Cada PR passa `make verify` e `scripts/tests/test_nginx_perimeter.py`; nenhum toca `replayDecision`, gates, disjuntores ou política.

## Testes obrigatórios

- Web (`apps/web/test`): a Mesa renderiza `question` em toda linha e o hash só em `title`; com modo engenheiro desligado o texto renderizado do `Badge` não contém o código; `parsePanel` devolve 10 níveis de `bids/asks` de um `panel_json` real de fixture; a folga para aceitar é `edge.net − max(costs.safety_margin, edgeLiqMin)` com os três casos (positiva, negativa, sem dado → "não medido").
- API: `/opportunities` e `/decisions` devolvem `question` e `category`; `/portfolio/limits` devolve `config` com as 5 chaves de D6; `/paper/positions` devolve `pending_settlement` verdadeiro só com `is_final` e `shares > 0` e o **mesmo número de linhas** com e sem o JOIN (fixture com 2 tokens do mesmo `condition_id`); `/decisions?outcome=X` rejeita valor fora do domínio com 400; `/series?metric=ohlc` devolve as 6 colunas; `?tokens=` com 26 tokens → 400.
- Perímetro (`scripts/tests/test_nginx_perimeter.py`): `paper/orders` e `paper/positions` movidos da lista fechada (`:113-123`) para `PAPER_ALLOWLIST` (`:36`, 4 entradas) e cobertos por `test_the_rfc_015_read_surfaces_are_exact_and_get_only` (`:96-111`); `intents`, `kill-switch`, `portfolio/halt` e `portfolio/resume` continuam na lista fechada; o caso "prefixo sob `/paper`" continua a falhar; `^~ /api/polymarket/series` GET-only.
- Cada teste de regressão verificado **falhando no código anterior**.

## Critérios de aceite (produção)

| # | Critério | Como verificar |
| --- | --- | --- |
| A1 | Cada location novo: **401** sem sessão, **404** em POST/PUT/DELETE; `POST /api/polymarket/paper/intents` segue 404 | `curl -s -o /dev/null -w '%{http_code}'` de dentro do servidor, 3 métodos × 3 paths |
| A2 | Revisão no ar | `docker exec ganso-market-api-1 cat /etc/ganso/release-sha` = SHA do merge; rodapé do painel mostra o mesmo SHA |
| A3 | Nome do mercado em todas as células | SQL: linhas de `/opportunities` e `/decisions` com `question IS NULL` = 0 quando o `condition_id` existe em `polymarket_markets` |
| A4 | Nenhum "Normal NORMAL" | texto renderizado da faixa e da Mesa (teste web + inspeção) não contém o código fora de `title` com modo engenheiro desligado |
| A5 | Faixa + Mesa carregam com ≤ 20 req/min | access log do Nginx: requisições `/api/` do IP do operador em 60 s com a Mesa aberta |
| A6 | Consultas novas sob o orçamento | EXPLAIN a frio de `/decisions` filtrado e de `/series?tokens=` (25 × 60 e 1 × 1 440): p95 < 500 ms, números colados na RFC |
| A7 | Zero `statement timeout` da API nas 24 h após cada PR | com o PR 2 da RFC-023 em produção: `docker logs ganso-market-api-1 --since 24h \| grep -c '"pg_code":"57014"'` = 0 (método A3 da RFC-023). Antes dele: `docker compose logs postgres --since 24h \| grep -c "canceling statement"` = 0, registrando que o log do postgres não separa API de worker (RFC-023 A3) |

## Condições de parada

- PR-0 (a) ausente (`AND occurred_at` ainda em `overview.ts:466`).
- Qualquer prefixo sob `/api/polymarket/paper`; qualquer endpoint de escrita novo; qualquer escrita em tabela de decisão pelo painel.
- Migration, índice novo, gate, disjuntor, config de gate ou `replayDecision` tocados.
- Biblioteca de gráfico ou de UI adicionada ao `apps/web`.
- EXPLAIN a frio > 500 ms em consulta nova: fica no fallback cliente; não se sobe orçamento.
- Teste de regressão que não falha no código anterior; `make verify` vermelho.

## Fora do escopo (registrado)

Funil pré-agregado, seções "Quase"/"Congeladas" e Sistema fase 1 (gates com natureza do bloqueio, `/data-quality` consumido) → RFC-027. Tela Sombra (shadow replay publicado) → RFC-029, com emenda de escopo leve da RFC-017. Blotter `/paper/ledger?exclude=mark`, heartbeats por worker, `/books/:tokenId` ao vivo, RTDS 1 m → não decididos aqui. Correção da liquidação (PR-0 b) e do `estimateAsOf` (PR-0 c): a tela **rotula** posição não liquidada e estimativa de sombra; não corrige.

## Medido depois (preencher na execução)

| PR | Merge / SHA | EXPLAIN a frio | A1–A7 | Testes de perímetro alterados | Premissas que caíram |
| --- | --- | --- | --- | --- | --- |
| 1 | — | `/opportunities`: —; `/decisions` JOIN: — | — | nenhum (inalterado e verde) | — |
| 2 | — | `/decisions?outcome=`: —; `?condition_id=`: — | — | `:36`, `:96-111`, `:113-123` — `intents` segue na lista fechada: — | — |
| 3 | — | `?tokens=` 25×60: —; 1×1 440: — | — | superfícies de leitura GET-only + `/series`: — | — |
