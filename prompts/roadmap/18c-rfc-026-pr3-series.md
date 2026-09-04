# RFC-026 · PR 3 — Séries de preço: `metric=ohlc`, lote `?tokens=`, sparkline e gráfico 24 h em SVG

Você vai executar o **PR 3 da RFC-026** ATÉ O FINAL: re-medição → medição de custo →
código → testes → merge → CD → verificação no perímetro e em produção → HANDOFF. A RFC é
a fonte de verdade (D5, D10, D11); este prompt só a operacionaliza. Tudo em SIMULAÇÃO: uma
variante (`metric=ohlc`) na rota que já existe, **uma rota de leitura nova** (o lote
`GET /polymarket/series?tokens=`), um location GET-only, zero migration, zero biblioteca.
Origem: diagnóstico de 02–03/09/2026 (relatório e canvas linkados no cabeçalho da RFC).

## Contexto mínimo: leia só…

1. `docs/rfcs/RFC-026-painel-home-broker.md` — D3, D5, D6, D10, D11, P2, A1–A7. **P2 aprovado** = `grep -n 'RFC-026' docs/HANDOFF.md` traz "P2 aprovado em DD/MM" (03/09: 0 linhas). Sem isso, PARE.
2. `apps/api/src/polymarket/readapi.ts` — `SERIES_LIMIT` (~l. 138) e a rota `/polymarket/series/:tokenId` (`:809-902`; `app.get` em `:814`, colunas em `:838`)
3. `migrations/0005_polymarket_data_foundation.sql:138-160` — schema de `polymarket_series_1m` (leitura; não muda)
4. `infra/nginx/nginx.conf` — `^~ /api/polymarket/gates` (~l. 129–136, padrão a copiar) e `^~ /api/` (~l. 229)
5. `scripts/tests/test_nginx_perimeter.py` — superfícies de leitura (`:96-111`, `:131-135` `test_read_surfaces_remain_get_only`)
6. `apps/web/src/Portfolio.tsx` — só a lista da Mesa e o detalhe do mercado criados no PR 1
7. `apps/web/src/portfolio.ts` — tipos e parsers; `apps/web/src/styles.css` — classes da Mesa

Nada além disso, salvo o índice `18-rfc-026-painel-home-broker.md`, o topo de `docs/HANDOFF.md` e `git log --oneline -15`. Não leia o
coletor de séries nem `engine.ts`: as colunas OHLC já existem e já são preenchidas.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE em deploy. Sem secrets.
- Deploy em três passos: seção "O que vale para as três sessões" do índice
  `18-rfc-026-painel-home-broker.md` (nesta RFC nenhum worker muda; o terceiro passo não se aplica).
- Invariantes (idênticas nos prompts 11–21): paper-only; fail-closed; gates não afrouxam; GET-only — nenhum endpoint de escrita novo (o único POST é o rearme do kill switch já existente), painel nunca escreve em tabela de decisão; money em texto decimal, nunca `number`; migrations aplicadas não mudam, migration nova só pelo protocolo do CD (`infra/migrations/apply.sh`); regressão verificada **falhando no HEAD anterior**; **RE-MEDIR antes de codar** — premissa caída ⇒ PARE e registre no HANDOFF.
- `^~ /api/polymarket/series` **GET-only**, fora de `/paper`. SVG próprio, sem biblioteca.
  **Medir o custo antes de publicar.**

## Estado medido (02–03/09; re-verifique)

| Premissa | Como re-medir | Se caiu |
| --- | --- | --- |
| PR 1 mergeado (Mesa com detalhe) | `grep -n "100rem" apps/web/src/styles.css` → 1 linha | **PARE** |
| `/series` devolve só `best_bid, best_ask, spread, mid_close` | `grep -n "mid_open" apps/api/src/polymarket/readapi.ts` vazio | se já há OHLC, pule a variante |
| `from`/`to` opcionais (`parseOptionalAt`, ~l. 829–830) | `grep -n parseOptionalAt` na rota | registre |
| `/series` fechado no edge | `curl -s -o /dev/null -w '%{http_code}' https://…/api/polymarket/series/x` de dentro do servidor → 404 | 401 → outra sessão publicou: adapte |
| `SERIES_LIMIT = 10_000` | `sed -n 138p apps/api/src/polymarket/readapi.ts` | registre |
| 210 tokens com bucket na última hora | `SELECT count(DISTINCT token_id), max(bucket_start) FROM polymarket_series_1m WHERE bucket_start > now() - interval '1 hour'` | 0 → a série parou: registre e PARE |
| Custo do lote **não medido** | `EXPLAIN (ANALYZE, BUFFERS)` de 25 tokens × 60 buckets e de 1 × 1 440, a frio | > 500 ms → reduza o teto antes de publicar; registre |

## Escopo (D10, D11)

**API:** `metric=ohlc` em `/polymarket/series/:tokenId` devolve `bucket_start, mid_open,
mid_high, mid_low, mid_close, updates_count` (range scan pela PK `token_id, bucket_start`).
Variante em lote `GET /polymarket/series?tokens=a,b,c&metric=ohlc&from=` — teto de **25**
tokens (26 → 400), `SERIES_LIMIT` total, resposta agrupada por token. Em `ohlc` e no lote
`from` é **obrigatório** (400 sem ele): sem `from`, `LIMIT 10 000` vira varredura de dias.
Só leitura, mesma `guard`.

**Nginx:** `location ^~ /api/polymarket/series` GET-only copiando o bloco de `/gates`.
Publica também `spread/depth/oi/holders`, já existentes e de leitura (registrado em P2).

**Teste de perímetro:** `/series` entra nas superfícies de leitura GET-only; POST → 404.

**Web:** sparkline SVG de 60 buckets por linha da Mesa, carregada **numa** requisição em
lote com os tokens da página visível, no mesmo ciclo de 30 s do `/opportunities` (A5: faixa
+ Mesa ≤ 20 req/min continua valendo). Gráfico 24 h no detalhe, buscado ao selecionar o
mercado: `mid_close` com banda `mid_low/high`, marcas ▲ aceites, □ ordens, ● fills (de
`/decisions` já carregado) e linha vermelha em engates do kill switch (de `/events`).
Alta/baixa em verde/vermelho só aqui e no PnL (D3). Sem dado → "sem série" em cinza, nunca
linha zero. Livro congelado aparece como linha reta — não esconda.

## Verificação

- `make verify` e `test_nginx_perimeter.py` verdes; testes API: `metric=ohlc` devolve as 6
  colunas; sem `from` → 400; `?tokens=` com 26 → 400; com 25 respeita `SERIES_LIMIT`.
- **A6** EXPLAIN a frio dos dois casos colado na RFC **antes** do merge.
- **A1**, de dentro do servidor: `/api/polymarket/series/x?metric=ohlc&from=…` → 401 sem
  sessão no GET, 404 em POST/PUT/DELETE; `POST /api/polymarket/paper/intents` segue 404.
- **A2** `release-sha` no container = SHA do merge. **A5** access log: ≤ 20 req/min com a
  Mesa aberta 60 s (o lote não pode duplicar a cadência). **A7** zero `canceling
  statement` da API em 24 h.

## Entregável

PR mergeado e verificado; linha "PR 3" de "Medido depois" da RFC-026 (SHA, EXPLAIN,
A1/A2/A5/A6/A7, testes de perímetro alterados, premissas caídas); HANDOFF; linha 18 do README.

## Condições de parada

- PR 1 ausente; P2 não aprovado.
- EXPLAIN a frio > 500 ms sem que o teto do lote resolva: não publica, registra.
- Location que aceite método além de GET; qualquer coisa sob `/paper`; migration; índice.
- Biblioteca de gráfico ou de UI em `apps/web`; SSE ou WebSocket.
- Teste de regressão que não falha no código anterior; `make verify` vermelho.
