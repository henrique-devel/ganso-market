# RFC-024 — Descoberta por série e livro garantido para o universo rápido (BTC horário)

**Status:** accepted — autorizado para implementação (2026-09-04); P1–P4 aprovadas na recomendação (2026-09-05)
**Dependências:** RFC-007 (recorder: registry, WS dual, `book_deltas`), RFC-016 (`end_ts`, reserva de 25 slots do cap), decisão #88 (quota de `book_deltas` mantida em 52 GiB), RFC-020 (`docs/rfcs/RFC-020-deploy-sem-derrubar-o-banco.md`, deploy que não recria o Postgres) e RFC-021 (`docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md`, silêncio do feed com conexões vivas) — ambas em `accepted` nesta rodada e ainda não implementadas; sem elas o soak de 3 dias desta RFC não é mensurável
**Habilita:** qualquer estratégia rápida em simulação (não faz parte desta RFC); cobertura da `crypto_updown_gbm@1.1.0` em `updown` (hoje 5 de 457 mercados com estimativa); evidência do G1 por forma de mercado
**Origem:** diagnóstico operacional de 02–03/09/2026 em produção, somente leitura — relatório publicado em <https://claude.ai/code/artifact/f7e3e623-831a-464f-8435-6cc671d325e6> (estudo updown §1; síntese, seção 2). Não é preciso abri-lo: todos os números estão nas tabelas abaixo com o comando ou arquivo de origem

## Prompt a executar

`prompts/roadmap/16-rfc-024-descoberta-livro.md`. Três PRs, na ordem: prova no fio, descoberta por série com métrica, e — só se a prova exigir — reconexão por lote. Tudo em SIMULAÇÃO e somente leitura de mercado; nenhum gate, quota, endpoint de escrita ou disjuntor muda.

---

## Fatos medidos (02–03/09/2026, produção somente leitura; RE-MEDIR antes de codar)

### População e descoberta

| Fato | Valor | Origem |
| --- | --- | --- |
| Mercados "Up or Down" no catálogo (14 dias) | 457: BTC 411 (242 horários, 90 de 5–15 min, 64 de faixa 4 h, 15 diários); ETH 41; XRP 4; SOL 1 | `polymarket_markets.question ~* 'up or down'` |
| Emissão da venue | 24 horários/dia e 288 de 5 min/dia | contagem por dia no catálogo vs grade horária |
| Cobertura do catálogo | ~72 % dos horários; ~2 % dos de 5 min | 242 em ~334 h; 90 em 14 dias |
| Entrada no universo (min antes do fim) | horário mediana **21,0** (q1 10,0; q3 26,1); 5 min **−4,0** (entra depois de vencer) | `min(at)` de `polymarket_universe_log` `action='enter'` vs `COALESCE(end_ts, rule_versions.end_date)` |
| Quando o mercado começa a negociar | mediana 168 min antes do fim (q1 97) | `polymarket_trades` `min(trade_ts)`, 239/240 mercados |
| Catálogo em 03/09 | **0** mercados updown com `end_ts` futuro | psql 03/09 (síntese) |

Causa, no código: `fetchGammaPages` (`apps/api/src/polymarket/registry.ts:360`; consulta em `:367-370`) consulta `GET /markets?closed=false&active=true&order=volume24hr&ascending=false&limit=100`, com `PAGE_LIMIT = 100` (`registry.ts:21`) e `MAX_PAGES = 5` (`registry.ts:24`) — o top-500 por volume de 24 h — a cada `gammaMs ?? 600_000` (`orchestrator.ts:431`). Um horário só acumula volume para entrar no top-500 nos últimos ~20 min; um de 5 min nunca chega a tempo. 100 % dos catalogados entram no universo e 100 % dos vencidos têm label: o gargalo é a descoberta.

### Livro

| Fato | Valor | Origem |
| --- | --- | --- |
| Horários BTC vencidos com `polymarket_book_snapshots` nas 3 h finais | **19 de 240 (8 %)** | EXISTS por token Up |
| `polymarket_series_1m` por horário | mediana **0 min**; 3 mercados com ≥ 30 min, 14 com ≥ 15 min | contagem de buckets por token |
| Últimas 24 h (03/09, regex leniente incl. 5 min e 4 h) | 8 de 32 com livro a T−15 (25 %) | síntese, seção 2 |
| Snapshot `reason='subscribe'` após o `enter` (27 mercados, 30 h) | imediato em 2; 4–29 min depois em 6; **nunca em 19** | `polymarket_book_snapshots_full` vs `universe_log` |
| Livro do "10AM ET" de 02/09 | 14:47:58Z, 11 s após `ORCHESTRATOR_STARTING` 14:47:47Z (deploy) | `docker logs` do recorder |

Mecanismo no código: o `enter` do universo chama `dual.resubscribe(tokenIds)` (`orchestrator.ts:395`), que envia um novo frame `subscribeMessage(tokenIds)` em cada conexão aberta (`dualws.ts:265-271`; frame `{assets_ids, type: "market"}` em `recorder.ts:211-213`). O `bookpipe.ts:562-568` grava `reason = "subscribe"` no primeiro `book` de um token nunca visto. O próprio contrato prevê a alternativa: "If the venue ever requires a fresh socket per subscription, close/reopen here instead" (`dualws.ts:58-62`).

**Hipótese H1 (NÃO testada no fio):** o WS de mercado do CLOB ignora frames `subscribe` adicionais numa conexão viva; livros de tokens novos só nascem em reconexão/restart. É o mesmo padrão medido ao vivo no RTDS (`wss://ws-live-data.polymarket.com`, 2026-09-01, 13 sondas públicas): uma assinatura por tópico por conexão — frames sucessivos **substituem** a anterior, sem erro, sem ack negativo, sem fechar o socket. Os 2 casos "imediatos" e os 6 "4–29 min" podem ser reconexões coincidentes — a prova no fio decide.

### Quota de `book_deltas` (decisão #88, mantida)

`retention.ts:153-160`: `ttlDays: 14`, `quotaBytes: 52 * GB`, `requiresSeriesCoverage: true`; gatilho de poda `QUOTA_TRIGGER_RATIO = 0.9` (`retention.ts:45`) ⇒ 46,8 GiB, alvo `QUOTA_TARGET_RATIO = 0.8` (`retention.ts:46`) ⇒ 41,6 GiB. A poda roda dentro do recorder (`orchestrator.ts:21`, `createRetentionJob`). Medido em #88: 313,67 B/linha, 11,33 / 13,69 / 15,59 M linhas/dia ⇒ a quota entrega 15,7 / 13,0 / 11,4 dias.

| Grandeza | Valor | Origem |
| --- | --- | --- |
| `book_deltas` **vivo** (linha-base) | **35,174 GiB** / 120.407.970 linhas (02/09 02:05Z) | `docs/HANDOFF.md`, tabela "Medição em produção" do #88 (~linha 3555) |
| Folga até o gatilho de 46,8 GiB | **11,6 GiB** | 46,8 − 35,17 |
| 19 → 28 GB (28/08 → 31/08) | bytes **físicos** pós-repack, não vivos — não servem de linha-base | `docs/HANDOFF.md` "Dado para a redeclaração" (~linha 1948) |
| Orçamento global (61 tabelas) | 51,72 GiB vivos contra gatilho de 99 GiB | HANDOFF #88 (~linha 3560); é o que `QUOTA_GLOBAL_TTL_REDUCED` mede — **não** a quota desta tabela |

**Volumetria estimada do incremento [ASSUNÇÃO, a medir no PR 1]:** `updates_count` de `polymarket_series_1m` nos 60 min finais de um horário = 2.100–2.700/min por token (medido 02–03/09 nos horários BTC com ≥ 15 min de série; re-medir com o mesmo `updates_count` por bucket). Se cada update é ~1 linha de delta: 2 tokens × 2.400/min × 65 min ≈ 312 k linhas ≈ 98 MB por horário; 24/dia ⇒ **+7,5 M linhas/dia (+2,3 GB/dia)**. Total estimado 18,8–23,1 M linhas/dia ⇒ a quota de 52 GiB passaria a entregar **~7,7–9,5 dias**, abaixo do TTL de 14. A poda por quota segue funcionando (PR #89); o que encurta é a janela de replay. Com a folga de 11,6 GiB, +2,3 GB/dia cruza o gatilho de 0,9 em **~5 dias**: a poda disparar durante o soak é o comportamento **normal** (0,9 → 0,8), não um defeito. Número a confirmar com a taxa real de deltas medida no PR 1.

---

## Re-medição de 2026-09-08 (antes de codar; RFC-024 "RE-MEDIR antes de codar")

Medida em produção, somente leitura, entre 01:41Z e 02:10Z de 2026-09-08, com
`psql` direto no `ganso-market-postgres-1` (a API roda sob `statement_timeout`,
e as consultas de população não caberiam nele). População: os horários BTC da
série com **fim nas últimas 72 h** — 65 mercados.

**Nenhuma condição de parada disparou.** A premissa central não caiu: piorou.

| Fato | RFC (02–03/09) | Re-medido (08/09) | Veredito |
| --- | --- | --- | --- |
| Mediana do `enter` antes do fim | 21,0 min (q1 10,0; q3 26,1) | **12,6 min** (q1 2,9; q3 16,3) | **confirmada, pior** |
| Horários com lead ≥ 60 min | — | **0 de 65** | parada em ≥ 60 min **não** disparou |
| Livro a T−15, **régua da D4** | não medido nesta régua | **2 de 65 = 3,1 %** | **linha-base nova** |
| Livro nas 3 h finais, régua antiga, mesmas 72 h | 19/240 = 8 % (14 dias) | 3 de 65 = 4,6 % | consistente |
| Cobertura do catálogo de horários | ~72 % | 65 de 72 = **90 %** | melhorou; não muda o gargalo |
| B/linha de `book_deltas` | 313,67 | **313,67** (idêntico) | confirmada |
| Linhas/dia de `book_deltas` | 11,33 / 13,69 / 15,59 M | **13,2 M** (24 h) | confirmada |
| RFC-020 em produção | não entregue | **entregue** | melhorou |
| RFC-021 em produção | não entregue | **ainda não entregue** | risco do soak, registrado |

`com_livro_t15` por dia UTC de fim, na régua exata da D4 (bucket de
`polymarket_series_1m` em [fim−15 min, fim−14 min) com `updates_count ≥ 1`):
0/15 em 05/09, **0/24** em 06/09, **2/24** em 07/09, 0/2 em 08/09.

### A premissa que CAIU: a folga de `book_deltas` não é 11,6 GiB

A RFC declarou 35,174 GiB vivos (02/09) e **11,6 GiB de folga** até o gatilho de
46,8 GiB. Seis dias depois:

| Grandeza | RFC (02/09) | Medido (08/09) | Fonte |
| --- | --- | --- | --- |
| Bytes **vivos** | 35,174 GiB | **44,43 GiB** | log `RETENTION_BLOAT` do recorder, 00:05:09Z (`live_bytes: 47705950084`) |
| Bytes vivos, 2.ª medição | — | 44,855 GiB | `psql` 01:45Z, fórmula do `measureTableSizes` replicada |
| Bytes **físicos** | — | 56,29 GiB | `pg_total_relation_size` |
| Linhas vivas | 120,4 M | **153,5 M** | `n_live_tup` |
| **Folga até o gatilho de 46,8 GiB** | **11,6 GiB** | **1,9–2,4 GiB** | 46,8 − 44,4 |
| Crescimento líquido | — | ~1,6 GiB/dia | (44,43 − 35,17) / 6 dias |

**Isto é o "número real" que a P2 exigiu antes do PR 2.** A poda por quota vai
disparar em ~1,2 dia sem o incremento, e mais cedo com ele — o que a própria
RFC já declara **normal** (0,9 → 0,8), não defeito. O que muda é a margem: não
há 11,6 GiB de espaço, há ~2. A poda por TTL está saudável e rodando (última em
00:05:09Z, 71 044 linhas), e em 30 h de log **não houve** nenhum
`RETENTION_QUOTA_UNMET`, `RETENTION_QUOTA_NO_PROGRESS` nem
`RETENTION_STEP_FAILED`. Há **3** `SERIES_COVERAGE_MISSING` em 30 h — a guarda
por fatia reportando buraco, que estanca a poda daquele token; é o risco a
observar no soak, e não uma das condições de parada listadas.

### A série, listada ao vivo (o que a D2 deixou para a sessão)

`GET https://gamma-api.polymarket.com/events?series_id=10114&closed=false&limit=100`
— série **`btc-up-or-down-hourly`**, `series_id` **10114**,
`recurrence: "hourly"`, `seriesType: "single"`. Confirmada em 2026-09-08 02:05Z
a partir do próprio evento de um horário
(`GET /events?slug=bitcoin-up-or-down-september-8-2026-3pm-et`, campo `series`).

Três achados que a RFC não podia prever:

1. **A série publica 48 h à frente.** 50 eventos na resposta, do horário em
   curso até `bitcoin-up-or-down-september-9-2026-9pm-et` (2 890 min), todos com
   `clobTokenIds`, `active=true`, `closed=false` — e `volume24hr` **nulo ou
   desprezível** (4,98 a 14,94 em 4 dos 50). É a causa mecânica do problema:
   nenhum deles pode entrar num top-500 **ordenado por volume**.
2. **`GET /markets?series_id=10114` IGNORA o filtro** e devolve mercados sem
   relação (`xi-jinping-out-before-2027`, primárias de 2028). Das três formas
   que a D2 listou como não verificadas (`/events?slug=`, `series_id`,
   `/markets?slug=`), a que serve é `/events?series_id=`.
3. **O slug separa as quatro cadências sem ambiguidade**, e a regex é sobre ele:

   | Forma | Slug real | Casa a regex nova? |
   | --- | --- | --- |
   | horário | `bitcoin-up-or-down-september-7-2026-8pm-et` | **sim** (24/24) |
   | 15 min | `btc-updown-15m-1788827400` | não |
   | 5 min | `btc-updown-5m-1788807600` | não |
   | 4 h | `btc-updown-4h-1788811200` | não |
   | diário | `bitcoin-up-or-down-on-september-7-2026` | não (o `-on-`) |

   A `SHORT_SERIES_PATTERN` (`registry.ts:101`) casa **todas** elas; a nova casa
   só a horária, e o teste verifica os dois lados.

4. **O mercado aninhado no evento não tem `tags`** (elas vivem no evento) nem
   `events`. Sem enxertar os dois antes do parse, o registro da série cairia no
   classificador por palavra-chave em vez da taxonomia da venue.

### A URL da consulta da série, confirmada na doc da Gamma

A série foi confirmada **pelo próprio dado**, e é o registro que a D2 pediu:

```
GET https://gamma-api.polymarket.com/events?slug=bitcoin-up-or-down-september-8-2026-3pm-et
  -> events[0].series[0] = { "id": "10114", "ticker": "btc-up-or-down-hourly",
                             "slug": "btc-up-or-down-hourly",
                             "title": "BTC Up or Down Hourly",
                             "seriesType": "single", "recurrence": "hourly" }
```

E a consulta que o `fetchSeriesMarkets` usa, com o `series_id` que veio dali:

```
GET https://gamma-api.polymarket.com/events?series_id=10114&closed=false&limit=100
```

A forma **`/markets?series_id=`** foi testada na mesma sessão e **ignora o
filtro**: devolveu `xi-jinping-out-before-2027` e primárias de 2028. Fica
registrada como a que **não** serve, para ninguém tentar de novo.

### Correção do custo do plano da D4 (o número que eu publiquei primeiro estava medido na consulta errada)

A D4 manda medir o plano antes do merge e mover a agregação para o recorder se
passar de 200 ms. Eu medi **20,6 ms** e mantive na API — mas medi uma consulta
de **um dia**, e o que foi para produção cobre **3 dias mais o corrente**. A
medição correta, contra o Postgres de produção, com o SQL extraído da imagem
publicada:

| Passada | Tempo |
| --- | --- |
| primeira (frio) | **596,8 ms** |
| repetições quentes (5×) | 42,6 / 8,6 / 8,3 / 7,8 / 7,6 ms |

Quente cabe folgado nos 200 ms; **a frio não**. Por que segue na API, e não é
uma decisão silenciosa:

- o `budgetedPool` da RFC-023 envolve **por consulta, e não por requisição**,
  exatamente para que um `Promise.all` não fique preso a um cliente só
  (`apps/api/src/budgets.ts:55-66`, com o comentário que explica o porquê). As
  cinco consultas da rota correm em transações próprias, cada uma com o
  orçamento da rota;
- logo o custo marginal em wall-clock é ~0: a rota já espera a percentil de
  `ingest_lag_ms`, medida pela RFC-023 em **2 601,7 ms a frio**, e 596,8 ms
  terminam bem antes dela. O pool é `max: 4` (`database.ts:130`), então a quinta
  consulta espera o primeiro cliente livre — e as rápidas liberam primeiro;
- a alternativa que a D4 nomeia — "a agregação vai para o ciclo do recorder e a
  API só lê" — exige **persistir o agregado**, isto é, uma tabela, isto é, uma
  **migration**; e a mesma RFC declara "Migration? não" para os três PRs. A
  regra e a restrição da própria RFC se contradizem nesse ponto.

**Fica registrado como decisão consciente, não como omissão:** a agregação
segue na API, com 596,8 ms a frio contra um teto de 4 000 ms por consulta, e a
inconsistência entre a regra dos 200 ms e o "sem migration" volta ao
proprietário. Se ele preferir a letra da D4, o caminho é uma migration nova
pelo protocolo do CD — fora do escopo desta RFC.

---

## Decisões desta RFC

### D1 — a prova no fio vem antes da solução

Nenhuma linha do recorder muda antes de o WS ser medido. O PR 1 entrega um CLI somente leitura (`apps/api/src/wire-probe-cli.ts`, invocado como o `models-cli.ts` dentro do container; ao contrário dele, **não** importa `database.ts` nem `pg` e ignora `GANSO_CONFIG_FILE`/`GANSO_POSTGRES_PASSWORD_FILE`, que o container `polymarket-recorder` tem em `docker-compose.yml:188-190`; saída só em stdout) que executa o protocolo abaixo e cujo resultado é colado **verbatim** na seção "Resultado da prova no fio" desta RFC, com data e hora.

Protocolo (3 repetições em horas distintas, todas com controle positivo):

1. Abrir a conexão A em `wss://ws-subscriptions-clob.polymarket.com/ws/market` (`recorder.ts:17`) e assinar 2 tokens de um mercado do universo. Esperado: `book` em ≤ 5 s (senão a rodada é inválida).
2. Após 60 s, enviar na conexão A um segundo frame `subscribe` com o token Up do horário BTC em curso (T−30..T−60), em duas variantes: (a) só o token novo; (b) a lista antiga + o novo, exatamente como `resubscribe` faz hoje.
3. No mesmo instante, abrir a conexão B assinando só o token novo. Esperado: `book` em ≤ 5 s — é o controle positivo; se B não recebe, o token está quieto e a rodada não conta.
4. Medir: tempo até o primeiro `book` do token novo em A (ou "nunca" após 120 s); se os tokens antigos continuam a fluir em A após o frame (o frame **soma** ou **substitui**?); linhas de `price_change` por minuto do token novo em B durante 10 min (insumo de volumetria).

Zero escrita em banco. A leitura de mercado é pública; são duas conexões por rodada (A e B) — 3 rodadas × 2 variantes ⇒ até 12 conexões no total. `docker compose exec` exige o recorder de pé; `docker compose run --rm --no-deps` na mesma imagem não toca o processo de coleta.

### D2 — descoberta por série em paralelo ao top-500, dentro do cap

O top-500 fica como está. Uma segunda fonte, `fetchSeriesMarkets`, lista a série `bitcoin-up-or-down-*` na Gamma e junta os registros aos do top-500 **antes** de `selectUniverse` (`registry.ts:252`). A forma exata da consulta (`/events?slug=`, `series_id` ou `/markets?slug=`) não foi verificada: o PR 2 começa listando ao vivo, em GET, os 24 slugs reais de um dia e fixa a regex do horário sobre eles (a `SHORT_SERIES_PATTERN` de `registry.ts:66-67` casa também 5 min e 4 h; a regex nova casa **só** o horário). A RFC-007 (linha 65) já recomenda a paginação keyset da Gamma; a série usa o mesmo cliente.

Regras fechadas:

- entra só mercado com horizonte ≤ `FAST_SERIES_LOOKAHEAD_MS = 75 min` (ciclo de 10 min + margem para o `enter` ficar ≥ 60 min antes do fim) e ≤ `FAST_SERIES_MAX_MARKETS = 4` por ciclo — a série ocupa no máximo 2–3 dos 100 slots ao mesmo tempo;
- o cap de 100 mercados / 200 tokens (`registry.ts:18-19`) e a reserva de 25 slots (`SHORT_HORIZON_RESERVED_MARKETS`, `registry.ts:48`) **não mudam**; um horário a ≤ 6 h já cai em `capPriority = 2` (`registry.ts:226-241`) e na fila reservada;
- o motivo do `enter` em `polymarket_universe_log` ganha o sufixo `_series` (o campo `reason` é texto livre, `registry.ts:961`), para a métrica separar as duas fontes;
- falha da série não derruba o ciclo: o top-500 segue; a falha vira `polymarket_data_gaps` `source='gamma'`, `cause='series_fetch_failed'` (`insertDataGap`, `registry.ts:443-465`).

### D3 — a lacuna do livro ausente é registrada; a reconexão é condicional

Em qualquer resultado do PR 1, o recorder passa a registrar em `polymarket_data_gaps` (`source='clob_ws'`, `token_id` preenchido, `cause='subscribe_book_missing'`, via `createGapWriter().openGap/closeGap`, `quality.ts:87-108`) todo token que entrou na assinatura e não recebeu `book` em 60 s; a lacuna fecha quando o `book` chega. O timer vale **só** para tokens que **entram** (não vistos em `seenTokens`, `bookpipe.ts:563`) e é cancelado no `exit`, para uma saída de universo não abrir lacuna espúria. Reutilizar o `gaps` já instanciado no orchestrator (`createGapWriter(pool)`, `orchestrator.ts:150`; uso em `gaps.openGap`, `:380`) — não criar outro pool. É a medição contínua de H1 em produção e o alarme do G1-por-forma.

Só se o PR 1 mostrar que o frame adicional **não** entrega livro, o PR 3 troca o corpo de `resubscribe` (`dualws.ts:265-271`) pela alternativa que o contrato já nomeia: reconexão **rolante**, um slot por vez (o outro fica de pé — sem lacuna `both_connections_down`), disparada só quando tokens **entram** (saídas não reconectam), no máximo uma vez por ciclo gamma. Custo: um re-book dos ~200 tokens por reconexão, absorvido pelo dedupe por hash de `bookpipe.ts`. Uma terceira conexão dedicada ao universo rápido fica como alternativa se o re-book medido pesar em `snapshots_full`. Se o PR 1 mostrar que o frame **entrega**, o PR 3 não existe e os 19 casos "nunca" têm outra causa: parar e re-diagnosticar antes de qualquer código.

### D4 — métrica de cobertura GET-only, com denominador medido

Publicada como campo novo do `GET /polymarket/data-quality` já existente — o handler monta as próprias queries em `readapi.ts:943-975` e **não** chama `metricsSnapshot` de `quality.ts:451`; o campo entra em `readapi.ts` e o teste em `apps/api/test/polymarket/readapi.test.ts` ( location exato em `infra/nginx/nginx.conf:176`; `scripts/tests/test_nginx_perimeter.py:101`) — **nenhum location novo** — e emitida no log do recorder a cada ciclo gamma como `FAST_COVERAGE`. Por dia UTC, para a série horária BTC:

| Campo | Definição |
| --- | --- |
| `emitidos` | mercados da série com fim no dia, **contados na resposta da Gamma** (não o 24 esperado) |
| `catalogados_60min` | com primeiro `enter` em `polymarket_universe_log` ≤ fim − 60 min |
| `com_livro_t15` | com bucket de `polymarket_series_1m` em [fim − 15 min, fim − 14 min) e `updates_count ≥ 1` em pelo menos um token |
| `lead_mediano_min` | mediana de (fim − primeiro `enter`) |
| `subscribe_book_missing_24h` | lacunas com essa causa nas últimas 24 h |

Lente de degeneração: se `emitidos = 0` (série não respondeu), a métrica publica `null`, nunca 100 %. O "hoje = 8 %" foi medido em `polymarket_book_snapshots` nas 3 h finais — instrumento diferente de `com_livro_t15`; antes do soak, **re-medir a linha-base com a definição exata acima** (bucket de `series_1m` a T−15), senão o salto 8 % → 90 % pode ser troca de régua. A consulta roda sob o `statement_timeout = 1000 ms` da API (ou o orçamento da rota, se a RFC-023 já estiver em produção): o plano é medido antes do merge e, se passar de 200 ms, a agregação vai para o ciclo do recorder e a API só lê.

---

## Decisões que esta RFC exige do proprietário

> **APROVADAS — 2026-09-05.** O proprietário aprovou **todas** as decisões desta seção,
> cada uma **na recomendação da própria tabela** (coluna "Recomendação"). Não há decisão
> pendente nesta RFC.
> Registro correspondente em `docs/HANDOFF.md`, seção "APROVAÇÃO DAS RFC-020…029".
> Condição de parada abaixo que exija "decisão registrada" está **satisfeita** por esta linha;
> só volta a valer se o proprietário reverter a decisão por escrito.


| # | Decisão | Recomendação |
| --- | --- | --- |
| P1 | Autorizar a prova no fio a partir do servidor de produção (conexão WS de leitura, sem banco) | sim; é leitura pública |
| P2 | Aceitar que a quota de 52 GiB, **mantida**, passe a entregar ~8–10 dias de `book_deltas` em vez de 11–16 (estimativa; número real depois do PR 1). A folga real é **11,6 GiB** (35,17 → 46,8 GiB vivos), não a implícita nos 19–28 GB físicos; a poda por quota vai disparar no soak por desenho | sim, com o número real registrado no HANDOFF antes do PR 2 |
| P3 | Aprovar a segunda fonte de descoberta como incremento da RFC-007, com cap e reserva intocados | sim |
| P4 | Se H1 se confirmar: reconexão rolante (D3) ou terceira conexão dedicada | rolante primeiro; dedicada só se o re-book pesar |

## Fora do escopo

Mercados de 5 min (basis TWAP 13 %, zero livro), ETH/SOL/XRP (RTDS só entrega BTC), feed `spot` do RTDS, qualquer estratégia, ordem paper, policy, gate, disjuntor, tela nova e endpoint novo.

## Escopo, em PRs

| # | Item | Muda comportamento? | Migration? |
| - | --- | --- | --- |
| 1 | `wire-probe-cli` + resultado verbatim nesta RFC + taxa de deltas medida | não (CLI de leitura) | não |
| 2 | `fetchSeriesMarkets` + lacuna `subscribe_book_missing` + métrica em `data-quality` e log `FAST_COVERAGE` | sim (universo ganha ≤ 4 mercados da série) | não |
| 3 | **condicional a H1**: reconexão rolante em `resubscribe` | sim (churn de conexão em `enter`) | não |

## Testes obrigatórios

- PR 1: teste estático ou de módulo prova que `wire-probe-cli.ts` não importa `database.ts` nem `pg` (transitivamente) e que roda igual com `GANSO_CONFIG_FILE`/`GANSO_POSTGRES_PASSWORD_FILE` presentes ou ausentes; a rodada sem controle positivo sai como `INVALID`, não como resultado.
- PR 2 (`apps/api/test/polymarket/registry.test.ts`): fixture com os 24 slugs reais de um dia — a regex horária casa 24/24 e 0 de 5 min/4 h/diário; mercado da série a 80 min do fim **não** entra, a 70 min entra; com 4 já dentro, o 5.º é recusado; a série falhando não altera a seleção do top-500 e grava a lacuna `gamma`; motivo do `enter` termina em `_series`.
- PR 2 (`bookpipe.test.ts`/teste novo): token assinado sem `book` em 60 s abre lacuna `subscribe_book_missing`; `book` chegando fecha a lacuna; `book` em 10 s não abre nada.
- PR 2 (métrica): `emitidos = 0` ⇒ campos `null`; dia com 24/22/20 ⇒ 91,7 % e 83,3 %.
- PR 3 (`dualws.test.ts`): `resubscribe` com token novo reconecta **um** slot, espera `open` e só então o segundo; sem token novo (só saída) não reconecta; nunca dispara `onBothDown`.
- Perímetro: `test_nginx_perimeter.py` verde sem alteração (nenhum location novo).
- Cada teste de regressão verificado **falhando no código anterior**.

## Critérios de aceite (produção, 3 dias UTC consecutivos após o PR 2 ou 3)

| Critério | Hoje | Alvo | Como verificar |
| --- | --- | --- | --- |
| Horários BTC com livro a T−15 | 8 % (3 h) / 25 % (24 h) | **≥ 90 %** (≥ 22 de 24) | `com_livro_t15 / emitidos` em `GET /polymarket/data-quality` e log `FAST_COVERAGE` |
| Mediana de descoberta antes do fim | 21,0 min | **≥ 60 min** | `lead_mediano_min`; SQL `min(at)` de `enter` vs `end_ts` |
| Bytes vivos de `polymarket_book_deltas` | 35,17 GiB (02/09) | **≤ 52 GiB** todo o soak, com a poda por quota rodando (cruzar 46,8 GiB é o gatilho normal 0,9 → 0,8) | `measureTableSizes` via `GET /polymarket/data-quality` (`readapi.ts:971-973`); zero `RETENTION_QUOTA_UNMET`, `RETENTION_QUOTA_NO_PROGRESS` ou `RETENTION_STEP_FAILED` para `polymarket_book_deltas` no log do recorder |
| `subscribe_book_missing` por dia | não medido | tendendo a 0 após o PR 3 | `polymarket_data_gaps` por `cause` |
| Escritas fora de tabelas de coleta | — | **zero** | diff das migrations vazio; nenhum INSERT fora de `polymarket_*` de coleta |

## Condições de parada

- A re-medição mostrar mediana de descoberta ≥ 60 min ou cobertura de livro ≥ 90 % antes de qualquer código (a premissa caiu: registrar e parar).
- O PR 1 sem controle positivo válido em 3 rodadas: não codar o PR 3 por hipótese.
- Qualquer escrita fora de tabelas de coleta; qualquer location, endpoint de escrita, mudança de gate, quota, TTL ou disjuntor.
- Bytes vivos de `book_deltas` **> 52 GiB**, ou qualquer `RETENTION_QUOTA_UNMET` / `RETENTION_QUOTA_NO_PROGRESS` / `RETENTION_STEP_FAILED` para `polymarket_book_deltas` durante o soak: reverter o PR 2 (a série sai do universo) e voltar ao proprietário com o número. Cruzar 46,8 GiB **não** é parada: é a poda fazendo o trabalho.
- Deploy que recrie o Postgres no meio do soak (RFC-020 não entregue): o soak reinicia; não somar janelas.

## Resultado da prova no fio

Executada de dentro do servidor de produção, na imagem do recorder
(`release-sha` `d01b5827fea5d7368f51c78688cdb9cbd2f7a1a9`), com
`docker compose run --rm --no-deps polymarket-recorder node
apps/api/dist/wire-probe-cli.js --rounds 1` — container descartável, o processo
de coleta intocado. Somente leitura de mercado, zero escrita.

### A rodada verbatim, 2026-09-08

```
RFC-024 D1 — prova no fio do resubscribe
url: wss://ws-subscriptions-clob.polymarket.com/ws/market
iniciado: 2026-09-08T02:42:28.227Z
janelas: baseline 5000 ms, frame extra em 60000 ms, book em A ate 120000 ms, taxa 600000 ms

serie horaria (GET /events?series_id=10114&closed=false): 50 slugs casando a regex, 49 com fim no futuro
  bitcoin-up-or-down-september-7-2026-10pm-et  fim em 18 min  tokens 2
  bitcoin-up-or-down-september-7-2026-11pm-et  fim em 78 min  tokens 2
  bitcoin-up-or-down-september-8-2026-12am-et  fim em 138 min  tokens 2
  bitcoin-up-or-down-september-8-2026-1am-et  fim em 198 min  tokens 2

linha-base: bitcoin-up-or-down-september-7-2026-10pm-et fim em 18 min (2 tokens)
token novo: bitcoin-up-or-down-september-7-2026-11pm-et fim em 78 min

| # | variante | inicio | veredito | book em A | antigos seguem em A | book em B | price_change/min em B | motivo do INVALID |
| - | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | only_new | 2026-09-08T02:42:28.329Z | NEVER_ON_A | nunca | sim (4497 frames) | 21 ms | 9.5 |  |
| 2 | old_plus_new | 2026-09-08T02:53:28.499Z | NEVER_ON_A | nunca | sim (6776 frames) | 22 ms | 1244.5 |  |

rodadas validas: 2 de 2
H1 (o frame extra NAO entrega livro): 2 de 2 rodadas validas
o frame SOMA (antigos seguem fluindo): 2 de 2; SUBSTITUI: 0 de 2

VOLUMETRIA (P2), da taxa medida em B
  price_change/min por token (mediana de 2): 1244.5
  assuncao: 1 price_change = 1 linha de polymarket_book_deltas a 313.67 B
  incremento: 2 tokens x 65 min x 24 mercados/dia = 3882840 linhas/dia = 1.13 GiB/dia (1.22 GB/dia)

terminado: 2026-09-08T03:04:28.582Z
```

### O que a rodada decide

**H1 confirmada, 2 de 2, e a variante que importa é a segunda.** A
`old_plus_new` manda *a lista antiga mais o token novo* — **exatamente o que
`resubscribe` faz hoje** —, e deu `NEVER_ON_A` igual à `only_new`, com o
controle positivo em 22 ms. Não é um detalhe de formato do frame: é o
comportamento do recorder em produção, reproduzido em condições controladas.

**H1 confirmada.** Um segundo frame `subscribe` numa conexão **viva**, com um
token que não estava no primeiro frame, não entregou livro em 120 s — enquanto
uma conexão aberta **no mesmo instante**, com só aquele token, recebeu o livro
em **21 ms**. O controle positivo prova que o token estava vivo e que o venue
estava disposto a servi-lo: o que falhou foi o frame, não o mercado.

**E a hipótese estava certa na conclusão e errada no mecanismo.** A H1 foi
construída sobre o padrão medido no RTDS — *"frames sucessivos **substituem** a
anterior"*. No WS de mercado do CLOB não é substituição: os tokens antigos
seguiram fluindo em A, **4 497 frames** depois do frame extra. O frame nem soma
nem substitui: é **ignorado** para tokens novos, deixando a assinatura anterior
intacta. Para o PR 3 dá no mesmo — só uma conexão nova entrega livro —, mas o
diagnóstico correto importa para quem ler isto depois.

Uma ressalva sobre o rótulo do CLI: ele imprime *"o frame SOMA (antigos seguem
fluindo): 2 de 2"*, e "soma" é impreciso. O que a rodada mostra é que os
antigos **não são silenciados** e o novo **não é atendido** — o frame não
substitui nem acrescenta. A coluna a ler é a dos antigos; o rótulo agregado
sobrevive de um mundo com só duas hipóteses.

### A mesma coisa, medida em produção sem sonda nenhuma

No mesmo processo do recorder, no mesmo dia, a lacuna `subscribe_book_missing`
da D3 produziu o experimento natural que a sonda reproduz em condições
controladas:

| Instante | Como os tokens entraram | Tokens | Lacunas em 60 s |
| --- | --- | --- | --- |
| 02:41:43Z (boot) | assinatura no `open` de conexões **novas** | **162** | **0** |
| 02:51:45Z (ciclo gamma) | frame `subscribe` em sockets **vivos** | **6** | **6** |

As seis, com o slug do mercado:

```
2026-09-08 02:52:45.255+00 | 1016931503 | btc-updown-4h-1788825600
2026-09-08 02:52:45.256+00 | 2786450160 | bitcoin-up-or-down-september-7-2026-11pm-et
2026-09-08 02:52:45.256+00 | 4507236779 | bitcoin-up-or-down-september-7-2026-11pm-et
2026-09-08 02:52:45.256+00 | 5110713006 | ethereum-up-or-down-on-september-8-2026
2026-09-08 02:52:45.256+00 | 4085911012 | ethereum-up-or-down-on-september-8-2026
2026-09-08 02:52:45.256+00 | 1060935077 | btc-updown-4h-1788825600
```

Sete minutos depois, **as seis seguiam abertas**: nenhum daqueles tokens jamais
recebeu livro. E as duas primeiras são os dois tokens do
`bitcoin-up-or-down-september-7-2026-11pm-et` — o mercado que a fonte por série
acabara de descobrir **68,3 min antes do fim**. O PR 2 resolveu a descoberta; o
livro exigia o PR 3.

Conexão nova: 162 de 162. Conexão viva: 0 de 6. É o mesmo veredito da sonda,
pelo instrumento que fica ligado depois que a sonda vai embora.

### Volumetria para a P2 — e por que o número da sonda **não** é o número

A própria projeção do CLI (1,13 GiB/dia, da mediana de 1 244,5/min) é um
**piso**, não a estimativa, e a razão está nas duas rodadas: a conexão B da
rodada 1 observou um mercado a **T−78..T−68 min**, quando ele está parado
(9,5/min), e a da rodada 2 a **T−67..T−57 min**, quando ele começa a acordar
(1 244,5/min). Nenhuma das duas cobre a última hora, que é onde o volume está.
Por isso a volumetria da P2 vem do `updates_count`, abaixo, e não da sonda.

O `price_change/min em B` de 9,5 da rodada 1, isolado, seria um erro maior ainda.
A conexão B observou um mercado a **T−78..T−68 min** do fim, quando ele ainda
está parado; a estimativa da RFC (2 100–2 700/min) foi medida na **última
hora**, quando ele negocia. São faixas diferentes do mesmo mercado, não medições
conflitantes.

Medido com o mesmo instrumento da RFC — `updates_count` de
`polymarket_series_1m` por bucket de 1 min, horários BTC dos últimos 14 dias:

| Faixa até o fim | Buckets | Média/min | Mediana | Máximo |
| --- | --- | --- | --- | --- |
| T−60..T−30 | 50 | **2 428,9** | 2 410,0 | 5 150 |
| T−30..T−15 | 296 | **2 712,7** | 2 163,0 | 8 237 |
| T−15..T−0 | 762 | **3 004,5** | 1 655,0 | 20 543 |
| qualquer token do universo (6 h, comparação) | 39 870 | 77,8 | 18,0 | — |

**A assunção da RFC está confirmada.** Um horário nos 60 min finais custa
72 867 + 40 691 + 45 068 = **158 626 updates por token**; dois tokens dão
317 252 por mercado, e 24 mercados/dia dão **7,61 M linhas/dia** — contra os
7,5 M estimados. A 313,67 B/linha (re-medido idêntico), são **+2,22 GiB/dia**
(+2,39 GB/dia) contra os +2,3 GB/dia estimados.

O que **não** se confirmou foi a folga, e é o que a P2 pediu por escrito:

| Grandeza | RFC (02/09) | Medido (08/09) |
| --- | --- | --- |
| Bytes vivos de `polymarket_book_deltas` | 35,174 GiB | **44,4–45,0 GiB** |
| Folga até o gatilho de 46,8 GiB | 11,6 GiB | **1,8–2,4 GiB** |
| Incremento medido | +2,3 GB/dia (estimado) | **+2,22 GiB/dia** (medido) |
| Quando a poda por quota dispara | ~5 dias | **~11 h** |
| Dias retidos com a quota de 52 GiB | 7,7–9,5 | **~8,5** (52 ÷ 6,1 GiB/dia) |

A poda disparar é o comportamento **normal** (0,9 → 0,8 leva a 41,6 GiB), como
a RFC já declarava; o que muda é que ela dispara quase imediatamente, e não
depois de cinco dias. A quota de 52 GiB e o TTL de 14 dias **não** foram
tocados.
