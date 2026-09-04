# RFC-028 · Parte B — worker `fast` em SOMBRA, filtro `strategy_id IS NULL`, API GET-only e chip "Rápidos"

Execute os PRs 3 e 4 da RFC-028 ATÉ O FINAL: re-medição → código → testes → merge → CD →
rebuild → 3 dias de sombra **válidos** → HANDOFF. A RFC é a fonte de verdade. Tudo em
SIMULAÇÃO e em **SOMBRA**: quatro braços decidem e gravam; **zero ordens**. A primeira ordem do
braço C é passo seguinte (P6). Origem: diagnóstico de 02–03/09/2026 (relatório linkado no
cabeçalho da RFC-028).

## Contexto mínimo: leia só…

1. `docs/rfcs/RFC-028-estrategia-fast-btc-updown.md` (D2, D4–D8, P8, aceite, parada).
2. `apps/api/src/polymarket/paper/fastpolicy.ts`, `fastconfig.ts`, `config/fast.json`.
3. `apps/api/src/polymarket/paper/runner.ts` l. 51, 119, 154–161, 391–490;
   `apps/api/src/polymarket-paper.ts` (monta `deps`).
4. `apps/api/test/polymarket/paper/scope.test.ts` l. 20–70: `\bwallet\b` vetado (l. 30),
   `WRITABLE_TABLES` (l. 60–69).
5. `docker-compose.yml` l. 309–342 (`polymarket-paper` monta só `runtime.json`) e 355–376
   (padrão env + bind mount).
6. `apps/api/src/polymarket/paper/bridge.ts` l. 85–110 e 300–320; `brokerstore.ts` l. 248
   e 447–462 (só assinaturas); `apps/api/src/polymarket/rtds.ts` l. 425–457;
   `apps/api/src/polymarket/portfolio/gatestore.ts` l. 122–135 e 305–320;
   `apps/api/src/polymarket/paper/performance.ts` l. 101–160.
7. `apps/api/src/polymarket/paper/api.ts` l. 594–615; `infra/nginx/nginx.conf` l. 190–200;
   `scripts/tests/test_nginx_perimeter.py` l. 131–143; `apps/web/src/Portfolio.tsx` l. 534;
   `apps/web/src/dicionario.ts` l. 94, 194, 419.

Nada além disso, salvo `docs/HANDOFF.md` (60 primeiras linhas) e `git log --oneline -15`.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE em deploy. Sem secrets.
- Deploy em TRÊS passos: merge → CD (reinicia os containers de profile **sem trocar a
  imagem**) → rebuild **obrigatório** do `polymarket-paper`; evidência: `/etc/ganso/release-sha`
  no container.
- Invariantes (idênticas nos prompts 11–21): paper-only; fail-closed; gates não afrouxam; GET-only — nenhum endpoint de escrita novo (o único POST é o rearme do kill switch já existente), painel nunca escreve em tabela de decisão; money em texto decimal, nunca `number`; migrations aplicadas não mudam, migration nova só pelo protocolo do CD (`infra/migrations/apply.sh`); regressão verificada **falhando no HEAD anterior**; **RE-MEDIR antes de codar** — premissa caída ⇒ PARE e registre no HANDOFF.
- Ao final: `docs/HANDOFF.md` e a linha 20b da tabela "Ordem e status" do README (formato
`| # | Prompt | Tipo | Depende de | Status |`; insira-a mesmo que 11–19 e 21 faltem).

## Estado medido (02–03/09; re-verifique)

| Premissa | Medido | Como re-medir |
| --- | --- | --- |
| Parte A em produção | tabelas novas; 0.1.0 congelada | `\d strategy_decisions`; `SELECT version, hash FROM fast_config_versions` |
| Kill switch | engatado `RECORDER_STALE` desde 02/09 02:21Z (`HANDOFF.md:377-379`) | `SELECT engaged, reason FROM paper_kill_switch`; engatado ⇒ janela **não conta**; rearme é do proprietário |
| PR-0, RFC-022, RFC-025 | RFC-022 e RFC-025 em **`accepted`** em 04/09 (`RFC-022…:3`, `RFC-025…:3`); **nenhuma das três implementada** (PR-0 sem PR) | PR-0: `count(*) FROM paper_ledger_events WHERE event_type='resolution'` > 0; RFC-025: `count(*) FROM portfolio_circuit_breakers WHERE kind='PARAM_CHANGE' AND ended_at IS NULL` = 0 em mercados vivos; RFC-022: status no repo. **Ausente ⇒ PARE antes do merge do PR 3** |
| Universo hoje | 0 updown com `end_ts` futuro (03/09); RFC-024 fecha a lacuna; cobertura é sobre os **descobertos** | `count(*) FROM polymarket_markets WHERE end_ts > now() AND question ~ '^Bitcoin Up or Down'` |
| Idade do RTDS | só `polymarket_rtds_prices.received_at` carimba por amostra (`rtds.ts:427-429`) | `SELECT feed, max(received_at) FROM polymarket_rtds_prices GROUP BY 1` |

**Antes do merge do PR 3**, grave o snapshot de G1–G6 e de `GET /paper/performance` (comando e
saída no HANDOFF); sem ele o aceite não se compara. `policy.ts` com diff ⇒ PARE.

## Escopo

**PR 3 — worker em sombra + filtro de evidência.**

1. **Worker `fast`** em `apps/api/src/polymarket/paper/fastworker.ts`, timer de 5 s
   (`fastTickMs` em `deps`, como `bridgeTickMs`, `runner.ts:119`/`:452`), guard de
   reentrância. Por tick: pré-condições de D4 — **idade do `twap30` lida de
   `polymarket_rtds_prices.received_at`**; `S0`/`S_t`/buckets faltantes de
   `polymarket_rtds_1m`; `loadKillSwitch`; disjuntores de todos os `kind`; `process.uptime()`
   —, `decideFastStrategyOrder`, **uma** linha em `strategy_decisions` por (mercado, braço)
   com insumos as-of. Com `mode === "paper"` chamaria `acceptPaperOrder` no mesmo tick — em
   0.1.0 inalcançável (spy). Log `FAST_TICK` por reason code.
2. **Guard do módulo**: `WRITABLE_TABLES` (`scope.test.ts:60-69`) ganha `strategy_decisions`,
   `fast_config_versions`, `fast_wallet_state` — **só** elas; senão o `INSERT` do worker
   quebra `make verify`. Nenhum identificador `wallet` (l. 30; `fast_wallet_state` passa: `_`
   não é fronteira de palavra).
3. **Config no container**: `polymarket-paper` ganha em `docker-compose.yml` o volume
   `./config/fast.json:/etc/ganso/fast.json:ro` e `GANSO_FAST_CONFIG_FILE: /etc/ganso/fast.json`
   (padrão das l. 357/375); `polymarket-paper.ts` lê a variável; arquivo ausente ou
   inválido ⇒ **o worker não sobe**.
4. **Filtro `strategy_id IS NULL`** em `loadClosedPositions` (`gatestore.ts:122-135`; posição
   excluída se **qualquer** ordem do `token_id` tem `strategy_id`, D2), fills taker do G2
   (`:305-320`), `buildPerformanceReport` (`performance.ts:101-160`) e ponte
   (`bridge.ts:85-110`; só após o PR-1 da RFC-022). Relatório ganha `excluded_strategy_rows`
   (sombra: 0). Nenhum limiar muda.
5. Testes: spy de `acceptPaperOrder` nunca chamado e `paper_orders` vazia após N ticks; guard
   verde; fixture com `strategy_id` ausente das três leituras (excluídas = 1); replay reproduz
   braço/veredito/reason/z; cada pré-condição sozinha ⇒ seu reason code; `fast.json` ausente
   ⇒ start rejeita.

**PR 4 — API GET-only e chip "Rápidos".**

6. `GET /polymarket/strategies/fast/decisions?after=<cursor>&arm=` (keyset, ≤ 200 linhas, nome
   do mercado via `question`) e `.../summary` (por braço: N, reason codes, cobertura,
   versão/hash, modo). `preHandler: guard`, `SIMULATION_BANNER`; EXPLAIN a frio < 200 ms.
7. Nginx: pares `location = /api/polymarket/strategies/fast/{decisions,summary}` →
   `proxy_pass http://api:3000/polymarket/strategies/fast/...` (`nginx.conf:193-197`).
   `test_read_surfaces_remain_get_only` já cobre GET-only; o teste novo afirma presença e
   `location =`.
8. Frontend conforme D7/P8 da RFC: chip por braço e lista de decisões na Mesa da RFC-026 se
   estiver em produção, senão na sub-aba "Rápidos" (`Portfolio.tsx:534`); `MOTIVO_FAST` em
   `dicionario.ts`, via `rotulo`.

## Verificação

- `make verify` e perímetro verdes; `docker exec ganso-market-polymarket-paper-1 cat
  /etc/ganso/release-sha` = SHA do merge; `FAST_TICK` a cada 5 s no log.
- Janela de 3 dias **válida**: kill switch desengatado e nenhum disjuntor aberto o tempo
  todo; qualquer engate ⇒ recomeça.
- No HANDOFF: `SELECT arm, reason, count(*) FROM strategy_decisions GROUP BY 1,2 ORDER BY
  1,3 DESC` com ≥ 20 decisões por braço passando as pré-condições (N da RFC); cobertura
  ≥ 90 % dos descobertos, com o denominador; `count(*) FROM paper_orders WHERE strategy_id
  IS NOT NULL OR source='fast'` = 0; G1–G6 e `/paper/performance` iguais ao snapshot
  pré-merge; replay de ≥ 200 decisões 100 %; CPU sem degrau.

## Entregável

PRs 3 e 4 mergeados e verificados; RFC-028 "implemented (fase sombra)" com aceite
preenchido; HANDOFF e README atualizados; a primeira ordem do braço C **espera** RFC-024 e P6.

## Condições de parada

- Dependência (PR-0, RFC-022, RFC-025) ausente em produção: PARE antes do merge do PR 3.
- Diff em `policy.ts`, limiar de gate, disjuntor ou migration aplicada; `make verify` vermelho.
- Ordem com `strategy_id` ou `source='fast'`; `mode` ≠ `"shadow"`; `fast.json` sem versão nova.
- Prefixo sob `/paper` ou `/strategies` no Nginx; endpoint de escrita novo; RTDS sem `twap60` > 24 h.
