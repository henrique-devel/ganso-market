# RFC-021 — silêncio do feed com conexões vivas e kill switch honesto

Você vai fazer a parada silenciosa do WebSocket do livro virar lacuna registrada, o gatilho
`RECORDER_STALE` dizer qual série calou e o sweep persistir `closed`, ATÉ O FINAL: código →
testes → merge → CD → rebuild → verificação em produção → HANDOFF. Tudo em SIMULAÇÃO.
Origem: diagnóstico de 02–03/09/2026 (relatório linkado no cabeçalho da RFC-021).

## Contexto mínimo: leia só…

1. `docs/rfcs/RFC-021-silencio-do-feed-e-kill-switch.md` — fatos, D1–D4, P1–P3. Fonte de verdade.
2. `apps/api/src/polymarket/dualws.ts` — conexões duplas, heartbeat, `onClose`, `resubscribe`.
3. `apps/api/src/polymarket/orchestrator.ts` — `handleWsFrame`, escritores de lacuna, `resyncFromRest` (`:162–180`, throttle 30 s/token; o controle positivo da D1 o reaproveita). O sweep de pendentes (`umaPoller`, `:23,257`) roda AQUI, no `polymarket-recorder`.
4. `apps/api/src/polymarket/quality.ts` — `createGapWriter`, `createFeedHealth`.
5. `apps/api/src/polymarket/paper/brokerstore.ts` — `killSwitchTriggersTick`, `engageKillSwitch`, `rearmKillSwitch`. Cadência de 60 s da D3 (`M` = 15 ticks): `paper/runner.ts:41,424`.
6. `apps/api/src/polymarket/samplers.ts` — `fetchStatuses`, sweep de pendentes.
7. `docs/HANDOFF.md` (só o topo) e `prompts/roadmap/README.md` (tabela de status) — RFC-020 em produção? Resposta a P1?
8. O `.test.ts` de cada arquivo tocado, em `apps/api/test/polymarket/` (o de `brokerstore` em `polymarket/paper/`).

Nada mais. Sem `location` novo no nginx, `scripts/tests/test_nginx_perimeter.py` não muda.

## Autorização e regras permanentes

- **SSH autorizado pelo proprietário**: `ssh -i ~/.ssh/id_ed25519 root@178.105.65.251` (checkout em `/opt/ganso-market`). Leitura livre; escrita SOMENTE em deploy; nunca imprima secrets.
- Ordem de fontes: este prompt → RFC-021 → HANDOFF → código.
- Deploy em TRÊS passos: merge → CD → rebuild do profile (`polymarket-recorder` nos PRs 1 e 3, `polymarket-paper` no PR 2). O CD reinicia os containers **sem trocar a imagem**; a evidência de revisão é `/etc/ganso/release-sha` dentro do container.
- `make verify` verde antes de cada PR. Nesta RFC: `RECORDER_STALE_MS` fica em 5 min; nenhuma migration.
- Invariantes (idênticas nos prompts 11–21): paper-only; fail-closed; gates não afrouxam; GET-only — nenhum endpoint de escrita novo (o único POST é o rearme do kill switch já existente), painel nunca escreve em tabela de decisão; money em texto decimal, nunca `number`; migrations aplicadas não mudam, migration nova só pelo protocolo do CD (`infra/migrations/apply.sh`); regressão verificada **falhando no HEAD anterior**; **RE-MEDIR antes de codar** — premissa caída ⇒ PARE e registre no HANDOFF.
- Ao final: `docs/HANDOFF.md` e a linha 13 da tabela "Ordem e status" de `prompts/roadmap/README.md` (atualize-a; crie-a se faltar).

## Estado medido (02–03/09/2026 — re-verifique; o resto está na RFC)

| Fato | Valor | Origem |
| --- | --- | --- |
| Gatilho | `RECORDER_STALE_MS = 5 * 60_000`; lê só `MAX(received_at)` de `polymarket_book_snapshots` | `brokerstore.ts:46`, `:2596–2616` |
| `data_gaps` na parada de 02/09 | **zero** `clob_ws`; escritores: `orchestrator.ts:380–387` (só `onClose` com 0 conexões, `dualws.ts:239–248`) e `quality.ts:398` (horário) | grep `openGap\|recordInstantGap` |
| `closed` | `false` em 1 205/1 205; sweep lê `closed=true` (`samplers.ts:838`), não persiste | SQL; leitura |
| `cause` | `TEXT` livre (`migrations/0005_polymarket_data_foundation.sql:194–208`) | leitura |

Re-medição: (a) `SELECT count(*) FROM polymarket_data_gaps WHERE cause = 'stream_silent'` > 0 ⇒ PR 1 já entregue, PARE; (b) `killSwitchTriggersTick` já lê `polymarket_book_deltas` ⇒ PR 2 já entregue, PARE; (c) RFC-020 não em produção (SHA do merge: linha 12 do README, topo do HANDOFF ou `git log --oneline --grep RFC-020`, contra o `release-sha` do recorder) ⇒ PARE e registre (P3); (d) sem resposta a P1 no HANDOFF ⇒ **rearme fica manual**.

## Escopo (um PR por item, na ordem; comportamento na RFC, aqui só os testes)

### PR 1 — detector de silêncio (D1) — `dualws.ts`, `orchestrator.ts`, `quality.ts`

Testes: socket falso entrega o livro do subscribe e cala; lacuna `stream_silent` aberta em `N`, fechada no frame seguinte; `resubscribe` enviado; reconexão em 2`N`; controle positivo nos três resultados (`blind`, `venue_quiet`, `unavailable`) **com a lacuna gravada nos três**; token ativo mudo abre lacuna com `token_id`; ilíquido não abre.

### PR 2 — gatilho honesto (D2) e rearme condicionado (D3, só se P1 aprovado) — `paper/brokerstore.ts`

Testes: deltas velhos + snapshots frescos engata com `series: deltas`; inverso, `series: snapshots`; ambos frescos não engata; `RECORDER_STALE_MS` intocado. Se P1 aprovado: não rearma com feed mudo, `reason` ≠ `RECORDER_STALE` ou lacuna `stream_silent` aberta; rearma após `M` ticks com `mode: auto`. Sem P1: nada disso.

### PR 3 — sweep persiste `closed = true` (D4) — `samplers.ts`

Testes: `closed: true` atualiza a coluna; `closed: false` não escreve.

## Verificação em produção

- Todo PR: `release-sha` do container confere com o merge.
- PR 1, **D+0** (fecha o deploy): após 30 min em regime, `SELECT count(*) FROM polymarket_data_gaps WHERE cause = 'stream_silent'` = 0, zero `WS_STREAM_SILENT` no log do recorder, `book_deltas`/min no regime da hora anterior. HANDOFF registra o aceite D+7 **pendente, com data**.
- PR 1, **D+7**: todo minuto com `book_deltas`/min < 1 % da hora anterior e universo > 50 tokens tem lacuna `stream_silent` aberta em ≤ `N` + 60 s; zero `blind` em regime.
- PR 2: próximo `kill_switch_engaged` traz `series`. Sem P1, tempo engatado e `BRIDGE_DECISION_SKIPPED KILL_SWITCH_ENGAGED` **sobem** (engata por qualquer série): esperado, não defeito; não "corrija". Com P1, nenhum intervalo engatado por `RECORDER_STALE` com as duas séries frescas por > `M` min.
- PR 3: `SELECT count(*) FROM polymarket_markets WHERE closed` > 0 em 24 h, coerente com `polymarket_resolution_events`.

## Entregável

Três PRs mergeados e verificados como acima; HANDOFF com números antes/depois, resposta a P1 e data do aceite D+7; linha 13 do README do roadmap atualizada.

## Condições de parada

- Mudança em `RECORDER_STALE_MS`; `N` < 30 s; lacuna não gravada quando o controle falha.
- Rearme automático sem P1 aprovado.
- Migration ou endpoint de escrita novo necessário.
- RFC-020 não em produção ao iniciar o PR 1.
- `make verify` vermelho; teste de regressão que passa no código anterior.
- Re-medição (a) ou (b) positiva: adaptar ou parar.
