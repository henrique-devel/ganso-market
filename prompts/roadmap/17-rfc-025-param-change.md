# RFC-025 — disjuntor `PARAM_CHANGE` abre em mudança real, não em nascimento

Fazer o disjuntor `PARAM_CHANGE` parar de congelar todo mercado novo por 24 h, ATÉ O
FINAL: código → testes → merge → CD → rebuild → medição publicada na RFC → HANDOFF.
Tudo em SIMULAÇÃO. Origem: diagnóstico de 02–03/09/2026 (relatório linkado no cabeçalho da RFC-025).

## Contexto mínimo: leia só…

1. `docs/rfcs/RFC-025-disjuntor-de-parametro-redefinido.md` — fonte de verdade: fatos, D1–D5, tabela P1–P3 e Apêndice A (as três SQL). **Se a coluna "Decisão do proprietário" de P1 estiver `pendente`, PARE.**
2. `apps/api/src/polymarket/portfolio/breakers.ts` — `BreakerObservation`, `BREAKER_EVENT_WINDOW_MS`, `detectBreakers` (ramos (ii) e (iv)).
3. `apps/api/src/polymarket/portfolio/exitstore.ts` — `MarketChangeState`, `loadMarketChangeStates` (a SQL de `paramChangedAt`), `openBreaker` (`:638–660`; grava `JSON.stringify(signal.detail)` — o `detail` novo entra sem mudar a função).
4. `apps/api/src/polymarket/portfolio/runner.ts` — só o reconciliador (~520–615; `BreakerConfigInput` em `:594–600`) e `PORTFOLIO_CYCLE` (`:1008`).
5. `apps/api/src/polymarket/portfolio/store.ts:83–85` — o `COALESCE` que justifica `fee_base_bps` em D1.
6. `apps/api/test/polymarket/portfolio/breakers.test.ts` e `integration.pg.test.ts` (`:66` gate, `:128–132` seed, `:255` skipIf, `:288–294` o teste a inverter).
7. `migrations/0005_polymarket_data_foundation.sql:51–72` — `polymarket_param_versions` (leitura).
8. Só para o PR 2: `config/portfolio.json:16–18, 51–52`; `apps/api/src/polymarket/portfolio/config.ts:57–58` (`PriceBandConfig`), `:626–636` (parse de `breakers`).
9. `docs/HANDOFF.md` — só o topo: outra sessão já tocou `breakers.ts`/`exitstore.ts`?

Nada mais: nem outras RFCs, nem o restante do HANDOFF.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251` (checkout `/opt/ganso-market`). Leitura livre; escrita SÓ em deploy. Nunca imprima secrets.
- Ordem de fontes: RFC-025 (decisões e SQL) → este prompt → código.
- Deploy em TRÊS passos: merge → CD → rebuild do serviço `polymarket-portfolio` do profile `polymarket` (`docker compose --profile polymarket build polymarket-portfolio && docker compose --profile polymarket up -d polymarket-portfolio`). O CD reinicia os containers de profile **sem trocar a imagem**; a evidência é `/etc/ganso/release-sha` nesse container. Registre o timestamp do rebuild no HANDOFF (aceite 2).
- `make verify` verde antes de cada PR — **e não basta**: roda vitest sem `GANSO_TEST_DATABASE_URL`, e os testes pg são pulados em silêncio. Rode `GANSO_TEST_DATABASE_URL=postgres://… npx vitest run apps/api/test/polymarket/portfolio/integration.pg.test.ts` contra um Postgres local migrado (`make up` + `make migrate`) e cole o `X passed`.
- Invariantes (idênticas nos prompts 11–21): paper-only; fail-closed; gates não afrouxam; GET-only — nenhum endpoint de escrita novo (o único POST é o rearme do kill switch já existente), painel nunca escreve em tabela de decisão; money em texto decimal, nunca `number`; migrations aplicadas não mudam, migration nova só pelo protocolo do CD (`infra/migrations/apply.sh`); regressão verificada **falhando no HEAD anterior**; **RE-MEDIR antes de codar** — premissa caída ⇒ PARE e registre no HANDOFF.
- Nesta RFC: sem migration, sem chave nova em `config/portfolio.json`; `BREAKER_EVENT_WINDOW_MS` só muda se P2 = D2-B.
- Ao final: `docs/HANDOFF.md`, "Medido depois" da RFC-025 e a linha 17 da tabela "Ordem e status" de `prompts/roadmap/README.md` (atualize-a; crie-a se faltar).

## Estado medido (02/09/2026 — re-verifique com as SQL do Apêndice A)

| Fato | Valor | Origem |
| --- | --- | --- |
| Entradas em `PORTFOLIO_CIRCUIT_BREAKER` atribuídas ao `PARAM_CHANGE` (24 h) | 98,6 % (29 173 de 29 600) | consulta A1 |
| Universo rápido ("Up or Down") | 40 de 40 mercados, 1 519 de 1 519 decisões em disjuntor | consulta A3 |
| `paramChangedAt` hoje | `max(pv.valid_from)` — a versão mais nova, qualquer que seja | `exitstore.ts:401–402` |

Atribuição < 50 %, ou SQL já diferente de `max(valid_from)`: outra sessão chegou antes — PARE e registre.

## Escopo (um PR por item, na ordem)

### PR 1 — D1 (+ D2-A): `paramChangedAt` só em mudança real, com o campo no `detail_json`

- `loadMarketChangeStates`: `lag()` por `condition_id` ordenado por `version`; `paramChangedAt` = `valid_from` da versão mais nova em que `taker_fee_bps`, `fee_curve_json`, `tick_size` ou `fee_base_bps` mudou **de não nulo para não nulo diferente**. Versão 1, `NULL→valor`, `valor→NULL`: nunca contam.
- `MarketChangeState` e `BreakerObservation` ganham `paramChangedFields`/`paramChangedVersion`; o `detail` do sinal ganha `changed_fields`, `version`, `from`, `to`. `BREAKER_EVENT_WINDOW_MS` e os ramos (i), (iii), (v) intocados.
- Testes: os de "Testes obrigatórios" da RFC. O de regressão é **inverter** `integration.pg.test.ts:288–294` de `toBeInstanceOf(Date)` para `toBeNull()` (o seed `:128–132` tem só a v1) e adicionar os fixtures v2/v3 ao seed. Guarda de `breakers.test.ts:169` verde.
- **Antes do merge**: rode e guarde A1, A2 e A3 (o "antes").

### PR 2 — D3: `PRICE_JUMP` com `mid_before` E `mid_now` fora da banda, sem posição, não abre — **só se P3 aprovado**

- Ramo (ii): abre se `holdsPosition`, ou `midBeforeScaled` ∈ `[minBuy, maxBuy]`, ou `midNowScaled` ∈ `[minBuy, maxBuy]`. Omite só com os dois fora e sem posição. Banda de `config.priceBand` já parseada — sem chave nova.
- Testes: 0,02→0,023 sem posição → não abre; com posição → abre; 0,50 sem posição → abre; **0,96→0,80 sem posição → DEVE abrir** (o afrouxamento que a RFC proíbe).

### PR 3 — D5: medição depois, docs

- 24 h após o rebuild: repita A1, A2 (`started_at > <rebuild>`) e A3 (`received_at > <rebuild>`); cole os números, datados, em "Medido depois" da RFC-025; HANDOFF; README.

## Verificação em produção

Os cinco critérios de aceite da RFC-025, como estão lá. Números-chave: A2 pós-deploy com **0** por versão 1 e **0** por `NULL→valor`; A3 (antes: 100 % sob disjuntor); A1 (antes: 55,9 %). Restos de `BOOK_STALE`/`DATA_STALE` são sintoma do feed (RFC-021/RFC-024) — registre, não conserte.

## Entregável

- PR 1 (e PR 2, se P3 aprovado) mesclados; CD e rebuild feitos; `release-sha` conferido.
- RFC-025 com "Medido depois"; HANDOFF; linha 17 do README com status e premissas confirmadas ou desmentidas.
- Resposta final no formato do prompt mestre (comandos e resultados reais, com o `X passed` dos pg).

## Condições de parada

- P1 `pendente` na tabela da RFC; P2/P3 `pendente` e o PR depende delas.
- Premissa caiu na re-medição (atribuição < 50 %, SQL já alterada).
- Migration, chave nova em `config/portfolio.json`, `BREAKER_EVENT_WINDOW_MS` sem D2-B, ou tocar os ramos (i), (iii), (v).
- Regressão que não falha no código anterior; `make verify` vermelho; pg pulado.
- Qualquer mudança que deixe passar uma entrada hoje recusada por motivo que não seja `PARAM_CHANGE` de nascimento/preenchimento (0,96→0,80 incluído).
