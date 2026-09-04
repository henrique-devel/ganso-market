# RFC-021 — Silêncio do feed com conexões vivas e kill switch honesto

**Status:** draft — aguardando aprovação do proprietário (2026-09-03)
**Dependências:** RFC-007 (recorder, `polymarket_data_gaps`), RFC-011 (kill switch paper, gatilho `RECORDER_STALE`), **RFC-020** (`RFC-020-deploy-sem-derrubar-o-banco.md`, draft — sem ela, cada merge recria os containers, o INSERT da lacuna falha junto com o banco e o detector novo produz ruído em vez de sinal)
**Habilita:** a próxima parada silenciosa do WebSocket do livro vira uma linha em `polymarket_data_gaps` em vez de sumir; o engate do kill switch diz qual série calou; o paper broker deixa de ficar engatado por horas com feed saudável (se o rearme condicionado for aprovado); `polymarket_markets.closed` passa a refletir a venue
**Origem:** diagnóstico operacional de 02–03/09/2026 — https://claude.ai/code/artifact/f7e3e623-831a-464f-8435-6cc671d325e6 (dívidas D03, D04, D07; céticos 16, 17, 19, 20, 29, 30)

## Prompt a executar

`prompts/roadmap/13-rfc-021-feed-kill-switch.md`. Tudo em SIMULAÇÃO. Nenhum gate
afrouxa, nenhum endpoint de escrita novo, nenhuma migration prevista (`cause` de
`polymarket_data_gaps` é `TEXT` livre — `migrations/0005_polymarket_data_foundation.sql:194–208`).

---

## Fatos medidos (02–03/09/2026 — RE-MEDIR antes de codar)

### O kill switch e o que o engata

| Fato | Valor | Origem |
| --- | --- | --- |
| Engates na história | **6**, todos `RECORDER_STALE`; **5** rearmes | `paper_ledger_events` (`kill_switch_engaged` / `kill_switch_rearmed`) |
| 6º engate | 02/09 **02:21:05Z**, ainda engatado (>31 h em 03/09 09:40Z) | `paper_kill_switch` (`engaged=t`, `rearmed_at` 01/09 23:51:48Z) |
| Gatilho | `RECORDER_STALE_MS = 5 * 60_000` | `apps/api/src/polymarket/paper/brokerstore.ts:46` |
| O que ele lê | `MAX(received_at)` de **`polymarket_book_snapshots`** — só essa tabela; nem `book_deltas`, nem `book_snapshots_full` | `brokerstore.ts:2596–2616` (`killSwitchTriggersTick`; SELECT em `:2607`) |
| Cadência do gatilho | a cada `settlementTick`, 60 s | `paper/runner.ts:41,424` |
| Snapshot mais novo antes dos 3 engates recentes | 22:43:47 / 23:06:32 / 02:15:40 (5 min 21 s, 5 min 36 s, 5 min 25 s antes) | `MAX(received_at)` de `polymarket_book_snapshots` por minuto (consulta ad hoc de 03/09, re-medir) |
| Coincidência com deploy | **nenhuma** nos 6. Nuance: o de 28/08 20:59Z foi parada manual do recorder para o VACUUM FULL, não silêncio | `journalctl -u docker.service`; HANDOFF 28/08 |
| Tempo engatado desde a primeira ordem | **63,6 %** | ledger, 02/09 |
| Efeito enquanto engatado | ponte recusa entradas aceitas: `BRIDGE_DECISION_SKIPPED` `KILL_SWITCH_ENGAGED`, **6** em 02/09; 0 ordens desde o engate | `paper/bridge.ts:252`; `brokerstore.ts:617` (409) |
| Rearme | **só humano**: único chamador de `rearmKillSwitch` (`brokerstore.ts:325`) é `POST /polymarket/paper/kill-switch/rearm` (`paper/api.ts:641–646`; `infra/nginx/nginx.conf:218–223`) | grep em `apps/api/src` e `apps/web/src` |

### A parada de 02/09 e por que ninguém a viu

| Minuto (UTC) | `book_deltas`/min | Tokens distintos |
| --- | --- | --- |
| 01:30 | 18 454 | 146 |
| 01:31 | 4 830 | — |
| 01:32 | 634 | — |
| 01:33 | 72 | 24 |
| 01:47 → 04:11 | 2–14 | — |
| 04:12 | 76 (retomada) | — |
| ~05:00 | regime cheio (~386 k/h) | — |

- Onset **01:31Z**, retomada **04:12Z**, ~2 h 40 min mudos, ~24,6 mil linhas onde
  se esperava >1,3 M. `book_snapshots` caiu junto (272/h às 02h, 54/h às 03h — `count(*)` por hora, consulta ad hoc de 03/09, re-medir);
  `book_snapshots_full` (âncora, `bookpipe.ts:282–283`) e RTDS seguiram
  fluindo — **processo e rede vivos, stream mudo**.
- Três recreates durante a parada (01:39, 01:59, 02:08Z) ressubscreveram (~180–190
  snapshots cada) e **não** destravaram. Recuperação sem nenhum restart.
- `polymarket_data_gaps`: **zero** linhas `clob_ws` entre 01:30 e 04:12Z. Idem na
  parada de 01/09 22:43–23:36Z (53 min).
- O HANDOFF registrou "~01:59Z a ~04:00Z" e "snapshots continuam fluindo" (contador
  em memória): os dois estão errados pela medição acima.

**Por que é estrutural, não desta ocorrência.** Quem escreve lacuna `clob_ws`:

| Causa | Onde | Quando dispara |
| --- | --- | --- |
| `both_connections_down` | `orchestrator.ts:380–387`, via `dualws.ts:239–248` (`onBothDown` em `:248`) | só em `onClose` com `openConnections() === 0` |
| `reconcile_divergence` | `quality.ts:398–402` | a cada 3 600 000 ms (`orchestrator.ts:465`), amostra de livros em cache |
| `delta_persist_failed` (`internal`) | `orchestrator.ts:225` | INSERT do lote falhou |
| `trades_window_overflow` (`data_api`) | `trades.ts:332,339` | janela de trades saturada |
| `ws_disconnect`, `persist_failed` (`rtds`) | `rtds.ts:504,443` | socket do RTDS |

`dualws.ts:197–199` manda `PING` a cada 10 s e `:203` descarta `PONG`; **não existe
temporizador de última mensagem recebida**. `createFeedHealth` (`quality.ts:135,153`,
limiar 60 s) é só memória: recebe `heartbeat("clob_ws")` em `orchestrator.ts:291`,
aparece em `overview.ts:511` (`last_book_delta_age_ms`) e nunca escreve em
`data_gaps`. Conexão aberta e muda não gera lacuna — nunca.

### `polymarket_markets.closed` nunca vira `true`

- `closed = false` em **1 205 de 1 205** mercados (02/09).
- O registry só consulta `closed=false&active=true` (`registry.ts:368`) e é o único
  UPDATE da coluna (upsert, `registry.ts:671,694,718`).
- O sweep de pendentes lê `closed=true` (`samplers.ts:838`, `fetchStatuses(pending, true)`),
  grava o evento em `polymarket_resolution_events` com `raw.closed` (`samplers.ts:884–935`)
  e **não persiste** a coluna. O precedente de escrita estreita a partir do sweep já
  existe: `end_ts` (`registry.ts:620–632`).

---

## Decisões desta RFC

### D1 — silêncio com conexão viva É lacuna

O recorder ganha um detector de silêncio no caminho do WebSocket do livro:

- **Global:** nenhum frame de livro em `N` s (constante exportada, padrão **120 s**,
  override por variável de ambiente, nunca menor que 30 s) com ≥ 1 conexão aberta e
  universo não vazio ⇒ `openGap({source: "clob_ws", cause: "stream_silent"})`, sem
  `token_id`, reason code `WS_STREAM_SILENT` (nível `error`). Fecha no primeiro frame
  seguinte (`closeGap`), como o `both_connections_down` já faz em `orchestrator.ts:292–301`.
- **Ação:** ao abrir, `resubscribe` (`dualws.ts:265`); se seguir mudo por mais `N` s,
  fecha e reabre as conexões. Cada tentativa vai para `details_json`.
- **Controle positivo** (memória do projeto: dois livros frescos): ao abrir a lacuna,
  busca REST `/book` do token de referência (o de mais deltas nos 15 min anteriores
  ao silêncio — constante `SILENCE_WINDOW_MS`) duas vezes, ≥ 10 s entre elas, reaproveitando
  `resyncFromRest` (`orchestrator.ts:162–180`, throttle de 30 s por token; não criar um
  segundo cliente REST), e grava em `details_json.control`:
  `blind` (REST mudou e o WS não entregou nada — estamos cegos), `venue_quiet`
  (REST idêntico nas duas — a venue está parada), `unavailable` (REST falhou).
  **A lacuna é gravada nos três casos** — o controle classifica, não decide. Falhar
  fechado aqui é gravar.
- **Por token:** só sobre os 5 tokens mais ativos nos mesmos 15 min (`SILENCE_WINDOW_MS`); um deles mudo
  por `N` s enquanto os outros fluem ⇒ lacuna com `token_id` + `resubscribe`. Tokens
  ilíquidos são mudos por natureza e não entram — o detector por token existe para
  pegar a assinatura perdida, não o mercado parado.

Direção proibida: substituir a lacuna por um contador em memória. `feedHealth` já é
isso e não viu nada.

### D2 — o gatilho `RECORDER_STALE` lê as duas séries e diz qual calou

`killSwitchTriggersTick` passa a ler `MAX(received_at)` de `polymarket_book_snapshots`
**e** de `polymarket_book_deltas` (índice `polymarket_book_deltas_received_at_idx`,
`migrations/0013_retention_time_indexes.sql:19`). Engata se **qualquer** das duas
passar de `RECORDER_STALE_MS` — mais estrito que hoje, direção segura. `book_snapshots_full`
continua fora: o passe de âncora reescreve cache congelado e disfarça a parada. **Efeito esperado, não defeito** (aceite negativo): com P1 recusado, o tempo engatado sobe acima dos 63,6 % e `BRIDGE_DECISION_SKIPPED KILL_SWITCH_ENGAGED` cresce; a sessão não "corrige" de volta.

O motivo persistido em `paper_kill_switch.reason` **continua** `RECORDER_STALE` (contrato do painel). O detalhe vai para o payload do evento `kill_switch_engaged` e para a linha `PAPER_KILL_SWITCH_ENGAGED` (`brokerstore.ts:319`): `series` (`snapshots` | `deltas` | `both`), idade de cada uma em ms. Sem migration. `RECORDER_STALE_MS` **não muda**: subir de 5 min seria afrouxar um gatilho de risco.

### D3 — rearme automático condicionado: SOMENTE com aprovação do proprietário

Sem aprovação, o rearme fica **manual** e esta RFC registra a decisão. Se aprovado, a D3 **supersede** a RFC-011 (`RFC-011-polymarket-microstructure-paper.md:266–270`, "bloqueia novas ordens até rearm manual"); o comentário de projeto em `infra/nginx/nginx.conf:215–217` ("stopping does not need a human") já aponta nessa direção. O rearme automático obedece a todas estas condições, no mesmo tick de 60 s do gatilho:

1. `reason = 'RECORDER_STALE'` — nunca para perda diária, disputa UMA ou engate manual.
2. As **duas** séries da D2 frescas (< `RECORDER_STALE_MS`) em `M` ticks consecutivos
   (`M` = 15, i.e. 15 min; constante exportada).
3. Nenhuma lacuna `stream_silent` aberta em `polymarket_data_gaps`.
4. Grava `kill_switch_rearmed` com payload `{"mode":"auto","healthy_ticks":M}` e log
   `PAPER_KILL_SWITCH_AUTO_REARMED`. O endpoint manual continua sendo o único caminho
   humano; nenhum endpoint novo.

O rearme não apaga o histórico de engates: é o `paper_ledger_events` que diz quanto
tempo o paper ficou parado, e o aceite abaixo é medido nele.

### D4 — o sweep de pendentes persiste `closed = true`

Escrita estreita, no padrão do `end_ts`: `UPDATE polymarket_markets SET closed = TRUE,
updated_at = $now WHERE condition_id = $1 AND closed IS DISTINCT FROM TRUE`, quando a
linha lida com `closed=true` retorna `closed: true`. O sweep **nunca** escreve
`false` — só o upsert do registry é dono da linha inteira. Antes de escrever, o
implementador lista todo leitor de `polymarket_markets.closed` (grep) e registra se
algum muda de comportamento.

### Achados laterais registrados, não corrigidos aqui

- `MAX_DECISION_AGE_MS = 30_000` (`bridge.ts:41`) é igual a `DEFAULT_BRIDGE_TICK_MS`
  (`runner.ts:51`): 15 de 21 entradas aceitas de 02/09 envelheceram antes de qualquer
  checagem. Defeito independente do kill switch: é a D1 da RFC-022
  (`RFC-022-ponte-runtime-e-saidas.md`), não desta.
- O engate de 26/08 05:28Z não é explicável pela tabela atual (`book_snapshots` começa em 27/08 15:51Z).

---

## Decisões do proprietário que esta RFC exige

| # | Decisão | Padrão se não houver resposta |
| --- | --- | --- |
| P1 | Aprovar ou recusar o rearme automático condicionado (D3) e o `M` (proposta: 15 min) | **Recusado**: rearme segue manual; a decisão é registrada no HANDOFF |
| P2 | Rearmar manualmente o switch engatado desde 02/09 02:21:05Z (ato exclusivo do proprietário; nenhum PR o faz) | Continua engatado |
| P3 | Ordem: esperar a RFC-020 em produção antes do PR 1 | **Esperar** — sem ela o detector mede o deploy, não a venue |

---

## Escopo, em PRs

| # | Item | Arquivos | Muda comportamento? | Migration |
| --- | --- | --- | --- | --- |
| 1 | Detector de silêncio global e por token, `stream_silent`, controle positivo, resubscribe/reconexão (D1) | `dualws.ts`, `orchestrator.ts`, `quality.ts` | sim (lacunas novas; resubscribe em silêncio) | não |
| 2 | Gatilho lê deltas E snapshots e registra `series` (D2); rearme condicionado **só se P1 aprovado** (D3) | `paper/brokerstore.ts` | sim (engata mais cedo em silêncio de deltas) | não |
| 3 | Sweep persiste `closed = true` (D4) | `samplers.ts` | sim (coluna passa a refletir a venue) | não |

## Testes obrigatórios

- Fixture de silêncio em `apps/api/test/polymarket/dualws.test.ts` / `orchestrator.test.ts`:
  socket falso entrega o livro do subscribe e cala; em `N` s abre lacuna `stream_silent`;
  primeiro frame depois fecha; `resubscribe` foi enviado; sem frames por 2`N` a conexão é reaberta.
- Controle positivo: REST diferente ⇒ `blind`; REST idêntico ⇒ `venue_quiet`; REST
  falha ⇒ `unavailable` **e a lacuna existe** nos três casos.
- Por token: token ativo mudo com os demais fluindo abre lacuna com `token_id`; token
  ilíquido mudo não abre nada.
- `brokerstore.test.ts`: snapshots frescos + deltas velhos engata com `series: deltas`;
  o inverso, `series: snapshots`; ambos frescos não engata; `RECORDER_STALE_MS` intocado.
- Se P1 aprovado: não rearma com feed mudo; não rearma com `reason` ≠ `RECORDER_STALE`;
  não rearma com lacuna `stream_silent` aberta; rearma após `M` ticks saudáveis e grava
  `mode: auto`.
- `samplers.test.ts`: linha `closed: true` do sweep atualiza a coluna; linha `closed: false`
  não escreve nada.
- Cada teste de regressão verificado **falhando no código anterior**.

## Critérios de aceite (em produção)

| Critério | Como verificar |
| --- | --- |
| Próxima parada silenciosa aparece em `data_gaps` em ≤ `N` + 60 s (60 s = granularidade da consulta por minuto que data o onset) | `SELECT gap_start, gap_end, details_json FROM polymarket_data_gaps WHERE cause = 'stream_silent'` contra a queda de `book_deltas`/min |
| Nenhum minuto com `book_deltas`/min < 1 % da hora anterior e universo > 50 tokens sem lacuna `stream_silent` cobrindo | consulta por minuto, 7 dias após o deploy |
| Engate registra a série | payload de `kill_switch_engaged` traz `series`; log `PAPER_KILL_SWITCH_ENGAGED` idem |
| Se P1 aprovado: switch nunca engatado por `RECORDER_STALE` com as duas séries frescas por > `M` min | ledger: intervalo engate→rearme vs `MAX(received_at)` das duas tabelas |
| `closed = true` existe | `SELECT count(*) FROM polymarket_markets WHERE closed` > 0 em 24 h, coerente com `polymarket_resolution_events` `closed` |
| Ruído zero em regime | nenhuma lacuna `stream_silent` com controle `blind` enquanto `book_deltas`/min está no regime |

## Condições de parada

- Qualquer alteração de `RECORDER_STALE_MS`, de `N` para menos de 30 s, ou lacuna que
  deixe de ser gravada quando o controle falha.
- Rearme automático em qualquer forma sem P1 aprovado e registrado.
- Necessidade de migration ou de endpoint de escrita novo: parar e perguntar.
- RFC-020 não em produção ao iniciar o PR 1 (P3): parar e registrar.
- `make verify` vermelho; teste de regressão que passa no código anterior.
- A re-medição mostrar `stream_silent` já existente em `polymarket_data_gaps` ou
  `killSwitchTriggersTick` já lendo `book_deltas`: outra sessão entregou parte; adaptar ou parar.
