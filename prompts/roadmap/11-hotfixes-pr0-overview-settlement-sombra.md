# PR-0 — três hotfixes sem RFC: `/overview` 500, liquidação travada, sombra vazando

Três defeitos medidos em 02–03/09/2026, corrigidos ATÉ O FINAL: da re-medição à verificação em
produção e ao HANDOFF. Um PR por defeito (ou três commits). Sem migration; tudo em SIMULAÇÃO.
Depende de: —. Habilita: RFC-023 e RFC-026 (exigem o PR-a); RFC-022 e RFC-028 (exigem o PR-b).
Origem: relatório do diagnóstico de 02–03/09 (<https://claude.ai/code/artifact/f7e3e623-831a-464f-8435-6cc671d325e6>) — não é preciso abri-lo: os números estão abaixo.

## Contexto mínimo: leia só

1. `docs/HANDOFF.md` — 30 primeiras linhas e a seção "CHECKLIST PRÉ-LIVE DA RFC-009" (l. 215).
2. `apps/api/src/polymarket/overview.ts` — `logOverviewError` (~l. 72) e o bloco
   `fills_24h` (~l. 463–468).
3. `migrations/0008_polymarket_paper_broker.sql` — `paper_ledger_events` (l. 50–71).
4. `apps/api/src/polymarket/paper/brokerstore.ts` — `settlementTick` (~l. 2369–2530).
5. `apps/api/src/polymarket/paper/broker.ts` — `resolveOutcomeForToken` (~l. 176–200).
6. `apps/api/src/polymarket/portfolio/store.ts` — `estimateAsOf` (~l. 179–205).
7. `migrations/0006_polymarket_fundamental_model.sql` — `fundamental_estimates` (l. 98–163).
8. `apps/api/test/polymarket/paper/bridge.pg.test.ts` — suíte contra PostgreSQL real
   (`GANSO_TEST_DATABASE_URL` l. 23, `describe.skipIf` l. 238).

Além destes, leia SOMENTE o arquivo de teste que cada PR nomeia.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251`
  (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE no deploy. Sem secrets no log.
- Deploy em TRÊS passos: merge na `main` → CD → rebuild de profile. O CD reinicia os containers
  de profile **sem trocar a imagem** (`api` é default: o CD o troca). Evidência:
  `cat /etc/ganso/release-sha` no container.
- `make verify` verde por PR.
- Invariantes (idênticas nos prompts 11–21): paper-only; fail-closed; gates não afrouxam; GET-only — nenhum endpoint de escrita novo (o único POST é o rearme do kill switch já existente), painel nunca escreve em tabela de decisão; money em texto decimal, nunca `number`; migrations aplicadas não mudam, migration nova só pelo protocolo do CD (`infra/migrations/apply.sh`); regressão verificada **falhando no HEAD anterior**; **RE-MEDIR antes de codar** — premissa caída ⇒ PARE e registre no HANDOFF.
- Ao final: `docs/HANDOFF.md` e a linha 11 da tabela "Ordem e status" de `prompts/roadmap/README.md` (atualize-a; crie-a se faltar).

## Estado medido (02–03/09/2026; RE-MEÇA)

| # | Defeito | Medição | Origem |
| --- | --- | --- | --- |
| a | `GET /polymarket/overview` **500 em 100 %** das chamadas autenticadas desde o PR #76 (01/09) | 5/5 em 500, 02/09 14:52–14:54Z (`docs/rfcs/RFC-023-orcamento-da-api-e-erros-mudos.md:38`); postgres: `column "occurred_at" does not exist`; `OVERVIEW_API_FAILED` sem `message` | `overview.ts:466` usa `occurred_at`; a coluna é `event_ts` (`0008:64`); `overview.test.ts` usa pool falso |
| b | Liquidação do paper (`settlementTick`) **nunca fechou posição** | 0 eventos `resolution`; `PAPER_RESOLUTION_DATA_ERROR reason=TOKEN_NOT_IN_MARKET` 1×/min (824 em 24 h); 1.017/1.017 `resolved` gravam `payload_json.raw.outcomePrices` | `brokerstore.ts:2462` lê `payload["outcomePrices"]` → `[]`; `broker.ts:183` dispara pelo segundo termo. Tratam os dois caminhos: `resolution/store.ts:727`, `resolution/timeline.ts:73`, `fundamental/labels.ts:59` |
| c | Decisões usam estimativa de **sombra** | 159 `portfolio_decisions` com `estimate_source='MODEL'`, 13 mercados, 6 `ACCEPTED`, **0** modelo `active` em `fundamental_models` | `store.ts:187–188`: sem `status = 'active'` nem desempate; cada instante: 1 `active` + 1 por modelo shadow, mesmo `decision_ts` |

Re-medição em produção, read-only (`C="docker compose --env-file deploy/server.env"`; SQL via
`$C exec postgres psql -U ganso_market -d ganso_market -c '...'`, `docker-compose.yml:13–14`):

```
$C logs postgres --since 24h 2>&1 | grep -c occurred_at
$C --profile polymarket logs polymarket-paper --since 24h 2>&1 | grep -c TOKEN_NOT_IN_MARKET
SELECT count(*) FROM paper_ledger_events WHERE event_type = 'resolution';
SELECT count(*) FROM fundamental_models WHERE status = 'active';
SELECT count(*), count(*) FILTER (WHERE outcome = 'ACCEPTED')
  FROM portfolio_decisions WHERE estimate_source = 'MODEL';
```

## Escopo, em PRs

**PR-a — `/overview` volta a responder.** `occurred_at` → `event_ts`; `logOverviewError` grava
`message` (`error.message`, nunca payload de request). Testes: (1) novo
`apps/api/test/polymarket/overview.pg.test.ts` — harness de `overview.test.ts` (`authService`
falso), pool real; `GET` → 200; falha antes pela coluna; (2) unitário do log com `message`.

**PR-b — a liquidação lê o payload onde ele está.** Ler `raw.outcomePrices ?? outcomePrices`
(estreite `payload["raw"]` para objeto antes). Em `broker.ts:183`: array vazio ou índice além
dele → reason code novo, p. ex. `RESOLUTION_PRICES_MISSING`; `TOKEN_NOT_IN_MARKET` só para
`index === -1`. Testes: (1) `brokerstore.test.ts` — `resolved` com
`raw.outcomePrices: ["0","1"]` e posição no índice 0 gera `resolution` com `outcome_price` 0
(falha antes); (2) `broker.test.ts` — array vazio → reason code novo; token ausente →
`TOKEN_NOT_IN_MARKET`.

**PR-c — sombra invisível ao consumidor.** Em `estimateAsOf`: `AND status = 'active'` e
`ORDER BY decision_ts DESC, estimate_id DESC`. Área da RFC-010 (invariante em `0006:108–109`).
Em 03/09 o HANDOFF (l. 82–89) só diz "vira decisão do proprietário" — **não há autorização**;
sem linha nova lá, este PR não abre (este prompt não autoriza). Teste em
`portfolio/integration.pg.test.ts`: duas linhas com o mesmo `token_id`/`decision_ts`, uma
`active` (`model_id` nulo) e uma `shadow` com `model_id`; a ativa vence; falha antes.

## Deploy e verificação em produção

Após o CD: `$C --profile polymarket up --build --detach polymarket-paper polymarket-portfolio`;
`release-sha` = SHA do merge em `api`, paper e portfolio.

| PR | Aceite verificável |
| --- | --- |
| a | Log JSON da `api` (`server.ts:76–85`): `"route":"/polymarket/overview"` com `"status_code":200` após o proprietário abrir o painel; zero `OVERVIEW_API_FAILED`; postgres sem `occurred_at` |
| b | Em ≤ 2 min (`DEFAULT_SETTLEMENT_TICK_MS = 60_000`, `paper/runner.ts:41`): primeiro `resolution` em `paper_ledger_events`; posição `0x71b5721c…` (BTC > US$ 78.000 em 1/set, Não em 01/09 16:37Z) fechada com perda realizada ≈ **US$ 4,62**; `PAPER_RESOLUTION_DATA_ERROR` desse `condition_id` cessa; `closed_positions` do G2 = 1. Não limpa `frozen_markets_json` nem rearma o kill switch |
| c | `portfolio_decisions` gravadas após o deploy com `estimate_source='MODEL'` = **0** enquanto `fundamental_models` não tiver `status='active'` |

## Entregável

- PRs mergeados com a saída "falha antes / passa depois"; suítes `.pg.test.ts` rodadas
  localmente contra banco migrado (o CI as pula).
- Aceite com números de produção e horários UTC no HANDOFF.

## Condições de parada

- Re-medição mostra o item já corrigido → pule e registre.
- PR-c sem autorização do proprietário no HANDOFF (em 03/09: ausente).
- Precisar de migration; mudar gates, disjuntores, policy, quotas ou migrations aplicadas.
- Regressão que NÃO falha no código anterior → refaça.
- Endpoint de escrita novo; escrita em tabela de decisão pelo painel.
