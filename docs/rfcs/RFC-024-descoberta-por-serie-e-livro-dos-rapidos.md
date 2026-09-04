# RFC-024 — Descoberta por série e livro garantido para o universo rápido (BTC horário)

**Status:** draft — aguardando aprovação do proprietário (2026-09-03)
**Dependências:** RFC-007 (recorder: registry, WS dual, `book_deltas`), RFC-016 (`end_ts`, reserva de 25 slots do cap), decisão #88 (quota de `book_deltas` mantida em 52 GiB), RFC-020 (`docs/rfcs/RFC-020-deploy-sem-derrubar-o-banco.md`, deploy que não recria o Postgres) e RFC-021 (`docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md`, silêncio do feed com conexões vivas) — ambas em draft nesta rodada; sem elas o soak de 3 dias desta RFC não é mensurável
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

*(a preencher pelo PR 1, verbatim, com data/hora e as 3 rodadas em tabela: variante, tempo até `book` em A, comportamento dos tokens antigos, `book` em B, `price_change`/min.)*
