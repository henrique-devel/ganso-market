# RFC-028 · Parte A — `fast.json` 0.1.0, policy própria, backtest do filtro z e migration nova (0019/0020)

Execute os PRs 1 e 2 da RFC-028 ATÉ O FINAL: re-medição → backtest → código → testes → merge
→ CD → rebuild → verificação em produção → HANDOFF. A RFC é a fonte de verdade (D1–D8). Tudo
em SIMULAÇÃO. **Nenhum worker decide nada novo**: só config, parser, policy própria,
migration, retenção e testes. A estratégia só roda (em SOMBRA) na parte B. Origem: diagnóstico
de 02–03/09/2026 (relatório linkado no cabeçalho da RFC-028).

## Contexto mínimo: leia só…

1. `docs/rfcs/RFC-028-estrategia-fast-btc-updown.md` (fatos, D1–D8, P1–P8, aceite, parada).
2. `apps/api/src/polymarket/paper/policy.ts` inteiro — para **não** tocar; reaproveite tipos e
   `takerFeePerShare` (l. 125–131).
3. `apps/api/test/polymarket/paper/policy.test.ts` — padrão de teste da casa.
4. `apps/api/src/polymarket/portfolio/config.ts` — `parsePortfolioConfig` (l. 330) e
   `portfolioConfigHash` (l. 914–929): parser fail-closed e hash.
5. `migrations/0014_polymarket_portfolio_engine.sql` l. 25–34 (trigger imutável) e l. 290–317
   (`portfolio_circuit_breakers`); `migrations/0015_decision_to_paper_bridge.sql` l. 27–40
   (rename do CHECK de `source`); `migrations/0008_polymarket_paper_broker.sql` l. 86.
6. `apps/api/src/polymarket/retention.ts` l. 114–128, 195–210 e 936;
   `apps/api/src/polymarket/orchestrator.ts` l. 21 (quem consome a retenção).
7. `apps/api/src/polymarket/fundamental/catalog.ts` l. 109–116 (`openPriceKey`);
   `apps/api/src/polymarket/rtds.ts` l. 425–457 (`polymarket_rtds_prices` e `_1m`).
8. `apps/api/src/shadow-replay-cli.ts` só o cabeçalho (CLI read-only).

Nada além disso, salvo `docs/HANDOFF.md` (60 primeiras linhas) e `git log --oneline -15`.
`bridge.ts`, `runner.ts`, `brokerstore.ts` e o frontend são da parte B.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE em deploy. Sem secrets.
- Deploy em TRÊS passos: merge → CD (aplica migrations e reinicia os containers de profile
  **sem trocar a imagem**) → rebuild de profile. Evidência: `/etc/ganso/release-sha` no container.
- Invariantes (idênticas nos prompts 11–21): paper-only; fail-closed; gates não afrouxam; GET-only — nenhum endpoint de escrita novo (o único POST é o rearme do kill switch já existente), painel nunca escreve em tabela de decisão; money em texto decimal, nunca `number`; migrations aplicadas não mudam, migration nova só pelo protocolo do CD (`infra/migrations/apply.sh`); regressão verificada **falhando no HEAD anterior**; **RE-MEDIR antes de codar** — premissa caída ⇒ PARE e registre no HANDOFF.

**Rebuild obrigatório do `polymarket-recorder` após o PR 2**: `retention.ts` roda nele
(`orchestrator.ts:21` → `polymarket-recorder.ts`; `docker-compose.yml:182-187`); a declaração
de `strategy_decisions` só vale na imagem nova. Evidência: `/etc/ganso/release-sha` **dentro
desse container**. Ao final: `docs/HANDOFF.md` e a linha 20a da tabela "Ordem e status" de
`prompts/roadmap/README.md` (formato `| # | Prompt | Tipo | Depende de | Status |`; insira-a
mesmo que 11–19 faltem).

## Estado medido (02–03/09; re-verifique)

| Premissa | Medido | Como re-medir |
| --- | --- | --- |
| `POLICY_VERSION = "1.0.0"`, `decideOrderType` único ponto de decisão | `policy.ts:24`, `:137` | `grep -n "POLICY_VERSION\|export function" policy.ts` |
| `taker_fee_bps` NULL | 998/998 updown | tabela de parâmetros (nome: ver `paramsAtOrBefore`) |
| `paper_orders.source` CHECK; migration mais alta | `('manual','intent','portfolio')`; 0018 | `\d paper_orders`; `ls migrations/` |
| RTDS | só `twap30`/`twap60` `btc/usd`; 16,9 % dos buckets ausentes em 7 d | `SELECT feed, count(*) FROM polymarket_rtds_1m WHERE bucket_start > now()-'7 days'::interval GROUP BY 1` |
| Universo horário | `question` = `Bitcoin Up or Down - <Mês> <dia>, <h>(AM\|PM) ET` | `count(*) FROM polymarket_markets WHERE question ~ '^Bitcoin Up or Down - '` |
| Dependências PR-0, RFC-022, RFC-025 | RFC-022 e RFC-025 em **`accepted`** em 04/09 (`RFC-022…:3`, `RFC-025…:3`); **nenhuma das três implementada** (PR-0 sem PR) | PR-0: `count(*) FROM paper_ledger_events WHERE event_type='resolution'` (0 ⇒ ausente); RFC-025: `count(*) FROM portfolio_circuit_breakers WHERE kind='PARAM_CHANGE' AND ended_at IS NULL`; RFC-022: status no repo |

Dependência ausente **não** para esta parte (só config, policy, migration, retenção): registre
no HANDOFF; quem PARA é a parte B. `POLICY_VERSION` ≠ 1.0.0 ou `strategy_id` já em
`paper_orders` ⇒ PARE. Migration: a próxima livre (0019 em 03/09; 0020 se a RFC-027 usou o
caminho B).

## Escopo

**PR 1 — backtest, config e policy própria (sem migration).**

1. **Backtest do filtro z** (D7): CLI read-only `apps/api/src/fast-backtest-cli.ts`, script
   `fast-backtest` em `apps/api/package.json` (ao lado de `account`, l. 15), rodado em
   produção via `docker exec ganso-market-api-1 node apps/api/dist/fast-backtest-cli.js`.
   ~300 mercados BTC horários resolvidos, sem look-ahead (`S0` = `open` do `twap60` na
   abertura; `S_t` = `close` do `twap30` do bucket anterior). Saída: braço × banda × k com N,
   PnL/cota líquido, IC95 bootstrap por mercado, reversão de z e **σ realizado** (bps/min) —
   seção "Backtest do filtro z" da RFC. Direção de E não reproduzida, ou IC95 negativo em toda
   a grade ⇒ **PARE antes do deploy**.
2. **`config/fast.json` 0.1.0** com exatamente os parâmetros de D4–D6 (todos os braços
   `mode: "shadow"`; σ = 5 bps/min congelado; `assumedTakerFeeRate: "0.07"`). Parser
   fail-closed em `apps/api/src/polymarket/paper/fastconfig.ts` (arquivo ausente ou inválido ⇒
   erro nomeado, nunca default) + `fastConfigHash`.
3. **`apps/api/src/polymarket/paper/fastpolicy.ts`**: `FAST_POLICY_VERSION = "0.1.0"`,
   `decideFastStrategyOrder(context)` pura, sem chamar `decideOrderType`; insumos de D4 na
   entrada, `{ ok, arm, verdict, reason, order? }` com reason codes `FAST_*` na saída. Nenhum
   identificador `wallet` (`scope.test.ts:30` veta).
4. Testes (`apps/api/test/polymarket/paper/fastpolicy.test.ts`, `fastconfig.test.ts`): itens
   "Parser", "Propriedades" e "Pré-condições" da RFC.

**PR 2 — migration nova + retenção.** `strategy_decisions` (append-only por trigger, índice
`(strategy_id, arm, decision_ts)`, colunas as-of de D7), `fast_config_versions` (imutável:
`version`, `hash`, `config_json`, `frozen_at`), `fast_wallet_state`, `paper_orders.strategy_id
TEXT NULL` + CHECK de `source` com `'fast'` (renomeando como a 0015). `strategy_decisions`
declarada em `retention.ts` (TTL 180 d, quota 1 GiB, não protegida — P4). Testes: migration
idempotente; UPDATE/DELETE nas tabelas imutáveis lança; `source='fast'` sem `strategy_id` recusa.

## Verificação

- `make verify` verde nos dois PRs; regressão do CHECK falhando antes da migration.
- Após o CD do PR 2: `docker exec ganso-market-api-1 cat /etc/ganso/release-sha` = SHA do
  merge; `\d strategy_decisions`, `\d fast_config_versions`, `\d paper_orders` (`strategy_id`
  e `'fast'` no CHECK); `SELECT count(*) FROM paper_orders WHERE strategy_id IS NOT NULL` = 0.
- Após o rebuild: `docker exec ganso-market-polymarket-recorder-1 cat /etc/ganso/release-sha`
  = SHA do merge; `GET /polymarket/data-quality` (`readapi.ts:932`) lista `strategy_decisions`
  em `storage`; `polymarket_retention_log` só ganha linha quando há poda (`recordAction`,
  `retention.ts:936`) — tabela nova com TTL 180 d: **nenhuma** é o esperado, registre isso;
  nenhum erro novo em 30 min.
- Congelamento: linha 0.1.0 em `fast_config_versions` com o hash do arquivo commitado (SQL
  manual registrado no HANDOFF — P5).

## Entregável

Dois PRs mergeados e verificados; RFC-028 com "Backtest do filtro z" (σ realizado) e status
dos PRs 1–2; `fast.json` 0.1.0 congelado com hash; HANDOFF e README com as dependências
medidas e a parte B liberada ou bloqueada, com o motivo.

## Condições de parada

- Diff em `policy.ts`, `bridge.ts`, `brokerstore.ts`, gates, disjuntores ou migration aplicada.
- Backtest sem reprodução da direção de E, ou IC95 negativo em toda a grade.
- P1–P5 não aprovados: escreva o código, **não** faça merge do PR 2.
- Endpoint de escrita novo; ordem com `strategy_id` em produção; `make verify` vermelho.
