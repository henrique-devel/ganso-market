# RFC-023 — Orçamento de 1 s da API e erros mudos: cada consulta declara o que pode custar, cada falha diz o que falhou

**Status:** accepted — autorizado para implementação (2026-09-04)
**Origem:** diagnóstico de 2026-09-02 (relatório publicado: https://claude.ai/code/artifact/f7e3e623-831a-464f-8435-6cc671d325e6 — item RFC-023, dívidas D15/D16/D44, céticos 13 e 15) e a seção "O 500 de 31/08 não era irreproduzível" do `docs/HANDOFF.md`
**Dependências:** PR-0 (a) — hotfix sem RFC (`prompts/roadmap/11-hotfixes-pr0-overview-settlement-sombra.md`, item a): `overview.ts` `occurred_at` → `event_ts`, mensagem no `OVERVIEW_API_FAILED` e teste que executa o SQL contra o esquema real. Esta RFC **não** refaz o PR-0; ela parte dele. RFC-015 (endpoints do painel), RFC-002 (perímetro: nada novo é publicado)
**Habilita:** diagnóstico em minutos em vez de dias (o defeito do `occurred_at` ficou 40 h invisível porque o log dizia só `error_name: "error"`); painel sem 500 com cache frio; `live_volume` deixa de ser um `NULL` mudo há mais de 30 h

## Prompt a executar

`prompts/roadmap/15-rfc-023-timeout-erros.md`. Três PRs pequenos, sem migration, sem endpoint novo, sem gate tocado. Tudo em SIMULAÇÃO.

---

## Fatos medidos (02–03/09/2026; RE-MEDIR antes de codar)

Linhas conferidas no worktree em 2026-09-03 (`git rev-parse --short HEAD` = `ef7ca2d`).

### O orçamento herdado

| Fato | Onde | Valor |
| --- | --- | --- |
| Timeout de query da API é o timeout de **conexão** | `apps/api/src/database.ts:40-41` (`overrides.queryTimeoutMs ?? config.database.connectTimeoutMs`), aplicado em `:50-51` a `query_timeout` **e** `statement_timeout` | — |
| Valor do timeout de conexão | `config/runtime.json:9` `connect_timeout_ms`; parse em `apps/api/src/config.ts:224-229` (100–30 000) | **1 000 ms** |
| Pool da API sem override | `apps/api/src/main.ts:13` `createDatabasePool(config)` | 1 s em **toda** consulta do painel |
| CLIs sem override | `gates-cli.ts:77`, `models-cli.ts:108`, `account-cli.ts:56` | 1 s |
| Workers com override | `polymarket-recorder.ts:9-11` e `polymarket-paper.ts:13-15` (30 s); `polymarket-estimator.ts:16-18`, `polymarket-portfolio.ts:60-62`, `polymarket-resolution.ts:28-30` (60 s); `shadow-replay-cli.ts:750-752` (120 s) | — |
| Teto que o edge impõe | `infra/nginx/nginx.conf:22` `proxy_read_timeout 5s` | qualquer orçamento > 5 s é fictício |
| Endpoints publicados | `nginx.conf:88-223`: `^~` para `resolution-risk`, `graph`, `opportunities`, `portfolio`, `gates`, `decisions`; `=` para `overview`, `events`, `data-quality`, `paper/performance`, `paper/kill-switch/rearm` (único POST) | 11 locations |

### O que o 1 s já custou, e o que ele NÃO causou

| Consulta | Medição | Fonte |
| --- | --- | --- |
| `GET /polymarket/decisions` | 715 ms frio (seq scan + sort) → **2,2 ms** após #76 | HANDOFF, PR #76 (01/09) |
| `GET /polymarket/opportunities` | 786 ms (sort em disco) → **23,8 ms** após #76 | idem |
| Subconsultas do `/overview`, **quentes** (psql direto, 02/09) | gates 1,7 ms; coleta **212,7 ms** (seq scan em `polymarket_data_gaps`, 101 600 linhas, e em `polymarket_universe_log`, 17 680); modelo **382 ms** (`MAX(decision_ts)` varre ~900 k entradas de índice em `fundamental_estimates`); tamanhos de tabela 16 ms | cético 15 |
| Subconsulta `paper` do `/overview` | **não executa**: `column "occurred_at" does not exist` (`overview.ts:464-466`, bloco `fills_24h`; `paper_ledger_events` tem `event_ts`, `migrations/0008_polymarket_paper_broker.sql:64`). Atenção: `occurred_at` é **também** o alias legítimo do feed `/events` (`overview.ts:157,297,600-627`) e continua existindo depois do PR-0 (a) | céticos 13 e 15 |
| Os 5 × HTTP 500 em `/overview` (02/09 14:52:23–14:54:27Z) | causa = coluna inexistente, **não** timeout; 100 % das chamadas autenticadas falham desde o deploy do #76; zero `canceling statement due to statement timeout` da API em 02/09 (os 2 do dia são do worker de portfólio, `exitstore.ts:538`, 60 s) | log do postgres |

**Leitura honesta:** a premissa "o 1 s está derrubando o painel hoje" **caiu** na re-medição. O que fica de pé: o orçamento é herdado por acidente, ninguém o declarou, duas consultas quentes já estão a 212 e 382 ms (a frio, na janela pós-deploy em que o postgres é recriado a cada merge, viram o próximo 500), e o log mudo foi a razão de o diagnóstico errar a causa. Esta RFC trata o risco latente e o mudo; o defeito ativo é do PR-0 (a).

### Erros sem mensagem

| Sítio | O que grava | Conferido |
| --- | --- | --- |
| `overview.ts:72-81` `logOverviewError` (chamado em `:549` pelo handler `/overview`, `app.get` em `:364`; `/events` em `:558`) | `reason_code` + `error_name` | escondeu o `occurred_at` por ~40 h |
| `paper/api.ts:83-92` `logPaperApiError`; `server.ts:231-238` `setErrorHandler` | idem, sem `message` | — |
| `readapi.ts:156-167`, `resolution/api.ts:38-49`, `fundamental/api.ts:175-186`, `portfolio/api.ts:68-79` | `message` é um **rótulo constante**, não `error.message` | — |
| `samplers.ts:249-263` `SAMPLER_FETCH_FAILED` (warn) | `condition_id`, `path`, `error_name` — descarta o `error.message`, que **já traz o status HTTP** (`samplers.ts:242-246`) | 549/551 com `path: /live-volume`, ~90 a cada 15 min (02/09 13:24–14:47Z) |
| `samplers.ts:359-368` `OI_HOLDERS_SAMPLE_FAILED`; `bookpipe.ts:259-268` `BOOKPIPE_PERSIST_FAILED` (1 045 em 24 h, 100 % nos minutos de deploy 14:47 e 14:51); `trades.ts:452-461` `TRADES_BACKFILL_MARKET_FAILED` | `error_name` só | — |
| Total de sítios `error_name:` em `apps/api/src` (sem testes) | **105** em 42 arquivos; `error_message` existe em `paper/runner.ts` (5), `portfolio/runner.ts` (1) — padrão do #37/#83 | grep 03/09 |

### `live_volume`

| Fato | Valor |
| --- | --- |
| Chamada | `samplers.ts:299-303` → `https://data-api.polymarket.com/live-volume?market=<conditionId>` (`DATA_API_BASE_URL`, `samplers.ts:18`) |
| Resultado em produção | `polymarket_oi_holders.live_volume` **NULL em 1 292/1 292** linhas das últimas 2 h e ~18 mil/30 h; `open_interest` e `holders_count` preenchidos |
| Coluna | `migrations/0005_polymarket_data_foundation.sql:165` `live_volume TEXT` (nula) — **não muda** |
| Consumidores | API: `readapi.ts:867-869` (`GET /polymarket/series/:tokenId?metric=oi` devolve `live_volume`); frontend: **zero** usos (`grep apps/web/src`, 03/09) |
| Correlato não diagnosticado (D44) | feed Gamma `uptimePct 13 %` em `quality.ts:196` — fica registrado, fora do escopo |

---

## Decisões desta RFC

### D1 — O orçamento é declarado, por endpoint, em config; o teto é o do edge

`createDatabasePool` **deixa de derivar** o timeout de query do de conexão: sem `queryTimeoutMs` explícito, o boot falha com `QUERY_TIMEOUT_UNDECLARED` (fail-closed: um padrão implícito foi exatamente o defeito). Os três CLIs passam a declarar (proposta: 60 s para `gates-cli` e `models-cli`, que leem as mesmas tabelas dos workers de 60 s; 10 s para `account-cli`). Os workers não mudam.

A API ganha em `config/runtime.json` a chave `services.api.statement_timeout_ms` com `ceiling`, `default` e `routes` (mapa `rota → ms`; `config.ts:253-256` hoje só aceita `bind_address` e `port`). Validação: `100 ≤ ms ≤ ceiling ≤ 4 000` — 1 s abaixo do `proxy_read_timeout 5s`, para que quem estoura seja o banco (com `pg_code 57014` no log) e não o Nginx (504 mudo). O pool da API recebe `ceiling`. O comentário defasado de `database.ts:31` ("the API default (connect timeout) is 2s"; o valor real é 1 000 ms, `runtime.json:9`) sai junto com o fallback.

**Executor orçado — mudança concreta.** `DatabasePool` hoje só expõe `query` e `transaction` (`database.ts:12-22`), e `transaction` emite `BEGIN` puro (`database.ts:90`). O PR 1 acrescenta um método `readOnly<T>(statementTimeoutMs, run)` ao `DatabasePool` (implementado sobre `transaction`), cujas duas primeiras instruções são `SET TRANSACTION READ ONLY` e `SET LOCAL statement_timeout = <ms>` — o padrão da casa é o de `portfolio/sweepstore.ts:71` (racional em `:15` e `:50`). `SET` fora de transação é proibido (vaza para a conexão do pool). O valor por rota vem de `routeOptions.config` (uso hoje: `server.ts:81` `request.routeOptions.url`), com `default` quando a rota não declara; o pool chega às rotas por `options.pool` em `server.ts:181-218`.

**Paralelismo do `/overview` preservado.** As 8 consultas do `/overview` rodam em `Promise.all` de `pool.query` (`overview.ts:381-458`). Envolvê-las numa única transação as serializaria num só client e somaria os tempos contra um orçamento único. Decisão: **cada `pool.query` vira sua própria transação orçada** (`readOnly` por consulta, mesmo `ms` da rota); a única rota POST **publicada** (`paper/kill-switch/rearm`) e os POST não publicados (`paper/api.ts:234,461,619,640`, `portfolio/api.ts:614,643`, `resolution/api.ts:402` — 404 no Nginx) ficam fora do `READ ONLY`. Conferido: nenhum GET publicado escreve (`writeState`, `portfolio/api.ts:566`, só é chamado pelos POST `:630/:670`). Teste: nenhum handler POST é envolvido pelo executor.

Valores propostos ao proprietário: `ceiling 4 000`, `default 2 000`; as rotas recebem `≥ 3 × p95 quente` e `≥ 1,5 × frio medido`, arredondado para cima em múltiplos de 500. **Direção proibida:** subir um orçamento para uma consulta caber. Consulta que não cabe se conserta por índice ou reescrita, como no #76.

Teste que dá ao aceite um denominador: um vitest lê `infra/nginx/nginx.conf`, extrai cada `proxy_pass http://api:3000/polymarket/<prefixo>` e falha se alguma rota Fastify sob esse prefixo não declara orçamento (via `routeOptions.config`). Publicar sem orçamento passa a ser impossível.

### D2 — O `EXPLAIN` de cada endpoint publicado fica registrado aqui

A sessão executora roda `EXPLAIN (ANALYZE, BUFFERS)` em produção (psql direto, leitura) para cada consulta dos 11 endpoints, com parâmetros reais, duas vezes: quente e **a frio na janela pós-deploy** (premissa a RE-MEDIR: o `server-update` recriou o postgres em `docs/HANDOFF.md:533`, mas o README do roadmap não o garante — confirmar com `docker inspect ganso-market-postgres-1 --format '{{.State.StartedAt}}'` logo após o CD; se o postgres **não** foi recriado, o frio se produz com `docker compose restart postgres` autorizado pelo proprietário). O resultado entra nesta seção, uma linha por consulta: `rota | consulta | quente ms | frio ms | plano (1 linha) | orçamento`. Sem a tabela preenchida o PR 1 não fecha.

| Rota | Consulta | Quente | Frio | Plano | Orçamento |
| --- | --- | --- | --- | --- | --- |
| a preencher pela sessão | | | | | |

### D3 — Toda falha diz o que falhou: `error_message` e `pg_code`

Um helper único (`errorFields(error)` — um módulo, sem dependência nova) devolve `error_name`, `error_message` (`error.message`, ou `null`) e `pg_code` (`error.code` quando é string — `57014` timeout, `42703` coluna inexistente, `23505` duplicata). Os **105 sítios** passam a usá-lo; os rótulos constantes em `message` ficam. Nome do campo é `error_message`, o que `paper/runner.ts:206` e `portfolio/runner.ts:692` já usam (#37, #83). Nenhum valor de payload, senha ou token entra: só o `message` do erro.

Dois testes: (a) regressão em `logOverviewError` — captura `stderr`, lança `new Error("boom")` e um erro com `code: "57014"`, exige `"error_message":"boom"` e `"pg_code":"57014"`; verificado **falhando** antes do PR; (b) varredura permanente — um teste lê `apps/api/src/**/*.ts` e falha em qualquer objeto de log com `error_name` e sem `error_message`. O grep manual desta rodada vira teste.

O PR-0 (a) grava `error.message` no campo `message` do `OVERVIEW_API_FAILED` (prompt 11, linhas 60-61). O PR 2 **migra** esse valor para `error_message` e `message` volta a ser rótulo constante, como nos demais sítios; o teste (a) passa a exigir `error_message`. Sem isso o teste-varredura aceitaria um sítio inconsistente. O escopo não encolhe.

Ordem com a RFC-020: os sítios de `bookpipe.ts`/`orchestrator.ts` que a D4 dela altera (`BOOKPIPE_PERSIST_FAILED` com `count`, `GAP_PERSIST_FAILED` com `dropped`) e o `pool.on("error")` da D3 dela em `database.ts` entram **antes** deste PR 2 (020 → 023); esta RFC só acrescenta o helper a esses sítios, não os redefine.

### D4 — `/live-volume`: primeiro a chamada real, depois uma de três saídas

Antes de qualquer código: `curl -sS -o /tmp/lv.json -w '%{http_code}\n' 'https://data-api.polymarket.com/live-volume?market=<conditionId de mercado vivo>'` de dentro do servidor, status e primeiros 300 bytes registrados nesta seção, mais o mesmo para um `conditionId` já resolvido.

| Resultado | Saída | Contrato |
| --- | --- | --- |
| 200 com corpo em forma diferente | corrigir as chaves de `extractMetric` (`samplers.ts:316-321`) | nada muda |
| 4xx por parâmetro (ex.: exige outro identificador) | corrigir a query string em `samplers.ts:300` | nada muda |
| 404/410/endpoint extinto | **parar de chamar**: `liveVolume = null` sem fetch, uma linha `LIVE_VOLUME_UNAVAILABLE` (info) por boot, `SAMPLER_FETCH_FAILED` com esse path cai a 0; a coluna fica; `series?metric=oi` segue devolvendo `live_volume: null` **documentado** como indisponível | remover o campo da API é decisão do proprietário (é contrato); o padrão é manter `null` explícito |

Registro da chamada: `status … | corpo … | data …` — a preencher pela sessão.

---

## Decisões do proprietário que esta RFC exige

1. Aprovar `ceiling 4 000 ms` e `default 2 000 ms` (D1), ou fixar outros dentro de `≤ 4 000`.
2. Aceitar que a API e os CLIs **não sobem** sem timeout declarado (`QUERY_TIMEOUT_UNDECLARED`, D1).
3. Na saída "endpoint extinto" de D4: manter `live_volume: null` explícito (padrão) **ou** remover o campo de `series?metric=oi`.
4. Confirmar a ordem: PR-0 (a) antes desta RFC; sem ele, a sessão para.

## Escopo, em PRs

| # | Item | Muda comportamento? | Config versionada? | Migration |
| - | --- | --- | --- | --- |
| 1 | orçamento por endpoint (D1) + tabela de `EXPLAIN` (D2) + CLIs explícitos | sim: consultas passam a ter teto declarado; boot fail-closed | sim: `services.api.statement_timeout_ms` | não |
| 2 | `error_message`/`pg_code` em todos os sítios (D3) + 2 testes | não (só log) | não | não |
| 3 | `/live-volume` medido e resolvido (D4) | depende da saída | não | não |

## Testes obrigatórios

- Config: `ms > ceiling`, `ceiling > 4 000` e chave desconhecida são recusados; rota ausente cai em `default`.
- `createDatabasePool(config)` sem `queryTimeoutMs` lança `QUERY_TIMEOUT_UNDECLARED`; com override, `statement_timeout` = override (pool falso).
- `readOnly` emite `SET TRANSACTION READ ONLY` e `SET LOCAL statement_timeout` **dentro** de transação e nunca fora; toda rota GET publicada passa por ele; **nenhum** handler POST é envolvido.
- Cobertura: toda rota sob prefixo publicado no `nginx.conf` declara orçamento (falha se uma nova entrar sem).
- `logOverviewError` grava `error_message` e `pg_code` (regressão verificada falhando antes).
- Varredura: nenhum log com `error_name` sem `error_message`.
- Sampler: falha do `/live-volume` loga o status HTTP; saída escolhida em D4 coberta por teste.
- `scripts/tests/test_nginx_perimeter.py` inalterado e verde: **nenhum location muda**.

## Critérios de aceite (produção, 24 h após o deploy do último PR)

| # | Verificação | Comando | Esperado |
| - | --- | --- | --- |
| A1 | nenhum `*_FAILED` mudo | `for s in api polymarket-recorder polymarket-paper polymarket-estimator polymarket-portfolio polymarket-resolution; do docker logs ganso-market-$s-1 --since 24h 2>&1 \| grep '_FAILED' \| grep -vc error_message; done` (`docker-compose.yml:1` `name: ganso-market`; serviços em `:182-344`) | `0` em todos |
| A2 | nenhum 500 no painel, inclusive a frio | proprietário abre todas as abas em ≤ 5 min após o restart da API; `docker logs ganso-market-api-1 --since 24h \| grep -c '"status_code":500'` | `0`, e ≥ 1 `200` por rota publicada |
| A3 | nenhum timeout da API | `docker logs ganso-market-api-1 --since 24h \| grep -c '"pg_code":"57014"'` (após o PR 2). O log do postgres **não** serve: sobe sem `log_line_prefix` com `%a` (`docker-compose.yml:17`) e não distingue o timeout da API do timeout legítimo de 60 s dos workers; mudar isso está fora do escopo | `0` |
| A4 | orçamento declarado é o que roda | teste com pool falso capturando `SET LOCAL statement_timeout = <ms>` por rota (o `pg_stat_activity` mostra só o `application_name`, não o GUC de outro backend); em dev, `SHOW statement_timeout` dentro de um `readOnly` do pool da API | `<ms>` da rota em cada captura; `SHOW` = valor da rota |
| A5 | `live_volume` resolvido | `SELECT count(*) FILTER (WHERE live_volume IS NOT NULL), count(*) FROM polymarket_oi_holders WHERE received_at > now() - interval '2 hours'` | `> 0` **ou** `LIVE_VOLUME_UNAVAILABLE` no boot e `SAMPLER_FETCH_FAILED` com `/live-volume` = 0 em 24 h |
| A6 | tabela D2 preenchida | esta RFC | 11 rotas, quente e frio |

## Condições de parada

- PR-0 (a) não mergeado: parar; o `occurred_at` não é corrigido aqui. Teste: `grep -n "occurred_at >" apps/api/src/polymarket/overview.ts` deve dar **vazio** (ou `sed -n 460,470p` sem `occurred_at`). **Não** use `grep -n occurred_at` puro: o alias do feed `/events` (`:157,297,600-627`) é legítimo e permanece.
- `database.ts` já sem o fallback em `main` (outra sessão chegou antes): re-ler, adaptar ou parar.
- Qualquer orçamento acima de 4 000 ms, ou subido para uma consulta caber.
- Location novo no Nginx, endpoint de escrita novo, migration, gate ou config de gate tocados.
- `make verify` vermelho; teste de regressão que **não** falha no código anterior.
- `/live-volume` responde 200 com o corpo que o código já espera na re-medição: o PR 3 vira registro, não código.
