# RFC-022 — Ponte decisão→ordem, runtime de resolução e saídas: por que 44 aceites viraram 8 ordens e 2 fills

**Status:** draft — aguardando aprovação do proprietário (2026-09-03; decisões P1–P3 abaixo)
**Dependências:** RFC-013 (ponte e critérios de saída, código completo), RFC-012 (runtime de resolução com geração/lease), PR-0 (b), liquidação (`prompts/roadmap/11-hotfixes-pr0-overview-settlement-sombra.md`, item b; `brokerstore.ts:2462` lê `payload_json.outcomePrices` e sem o fix nenhum fechamento é medível)
**Habilita:** vazão de fills mensurável para o G2; saída de posição com semântica declarada (ordem ou sinal); cancelamento por runtime só quando o runtime está de fato indisponível
**Origem:** diagnóstico de 02–03/09/2026, relatório publicado em <https://claude.ai/code/artifact/f7e3e623-831a-464f-8435-6cc671d325e6> (funil §3, §4.2, §4.4, §5; céticos 18 e 22)

## Prompt a executar

`prompts/roadmap/14-rfc-022-ponte-runtime-saidas.md`. Três defeitos independentes, um PR cada. Nenhum afrouxa gate, cria execução
real ou toca o kill switch. A RFC decide; o prompt remete e manda re-medir.

---

## Fatos medidos (02–03/09/2026 — RE-MEDIR antes de codar)

Produção por `psql` direto (sem o `statement_timeout` de 1 s da API) e `docker logs`.
HEAD `ef7ca2d`; linhas conferidas no worktree em 03/09.

### A ponte não vê o que o motor aceita

| Fato | Valor | Origem |
| --- | --- | --- |
| Tick da ponte | 30 s; tick lento é **pulado**, não empilhado | `paper/runner.ts:51` `DEFAULT_BRIDGE_TICK_MS`; `:297–300` `JOB_STILL_RUNNING` |
| Frescor exigido | `decision_ts > now − 30 s` | `bridge.ts:41` `MAX_DECISION_AGE_MS`; `bridge.ts:88–95` `PENDING_SQL` (filtra `decision_kind = 'ENTRY'`) |
| Lag `received_at − decision_ts` das 44 aceitas | p50 12,9 s / p90 20,6 s / max 33,3 s | o ciclo grava mercado a mercado; `portfolio_decisions.received_at` (`migrations/0014:144`) |
| Fases dos dois relógios | travadas (deriva 0,26 s em 11 ciclos) | decisões nascem a :30–:51 s, gravadas a :45–:05 s, ponte tica a :05/:35 s |
| Corte A — funil §3 (log retido de 30/08 até o fecho do funil, 02/09) | 44 aceitas: 8 ordens, 3 recusadas pelo kill switch (409), 33 nunca vistas (36 sem ordem) | `BRIDGE_DECISION_SKIPPED KILL_SWITCH_ENGAGED`; `paper_order_id IS NULL` |
| Corte B — cético 18 (`psql` 02/09 20:05Z, `received_at >= '2026-09-01'`) | 45 aceitas, 37 sem ordem | diferença de 1 aceita entre os cortes **não reconciliada**: RE-MEDIR com UMA consulta datada e reportar o corte |
| `BRIDGE_TICK` | `considered: 0, aged_out: 36–39` a cada 30 s | `bridge.ts:373–379`; `AGED_OUT_SQL` `bridge.ts:104–108` |

A explicação do HANDOFF (linha 2792: "entradas aceitas antes de a ponte
existir") **não vale mais**: o log retido começa em 30/08, depois da ponte.
Ressalva do cético 22 (corte B): das 37 sem ordem, 21 são de 02/09 pós-engate
do kill switch (esperado); 14–17 de 01/09 foram puladas com o switch desarmado
e o motivo não é mais recuperável (logs perdidos no `--force-recreate`). O
mecanismo de fase é **inferência forte sobre código lido**, não prova por log
para essas 16 — por isso o PR-1 exige teste com lag plantado.

### O runtime de resolução cancela tudo a cada soluço

| Fato | Valor | Origem |
| --- | --- | --- |
| Ordens | 18: 2 `filled`, 16 `canceled`, **todas** pelo runtime | `paper_orders.resolution_cancel_reason` |
| Antes do #52 (PR #52 no GitHub, 28/08; hora não verificável pelo repositório) | 7 `LAGGING` + 1 `NOT_READY` + 1 `MISMATCH` | graça de 180 s só para `LAGGING`: `brokerstore.ts:69`, `:1821–1866`; comentário `:55–57` diz só "measured 2026-08-28" |
| Depois do #52 | 5 `NOT_READY` + 2 `GENERATION_MISMATCH`, **0 `LAGGING`**, 1 fill em 8 | cético 18/22 |
| Rajada | 5 `NOT_READY` às 22:07:15,2–15,4Z de 01/09 + 1 `MISMATCH` 1,6 s depois | sem merge nem restart de container (journal do host); 21 `polymarket_resolution_input_changes` no mesmo segundo |
| Mecanismo | falha de job → `markFailed` (`ready = FALSE`) → próximo state tick roda `bootGenerationUnlocked` (`randomUUID()`) | `resolution/runner.ts:289–311`, `:313–316`, `:430–431`; chamadores `:707`, `:824`, `:938`, `:1056` |
| Carimbos de tempo do runtime **não são monotônicos** | `markBooting` rescreve `started_at` E `updated_at` a cada rotação; `markFailed`, heartbeat e state tick rescrevem `updated_at` | `resolution/runner.ts:255–284` (`started_at = EXCLUDED.started_at`), `:302`, `:387`, `:654`, `:789`, `:904`, `:1033` |
| Reproduzido em 02/09 | `JOB_FAILED state_tick RESOLUTION_MARKET_METADATA_VERSION_MISSING` 15:01:16Z → geração nova pronta 15:01:31Z | container não reiniciou (`StartedAt` 14:52:01Z) |
| Reação do paper | `NOT_READY` se `!runtime.ready`; `MISMATCH` se geração ≠ a da ordem; **sem graça** | `brokerstore.ts:1451–1533` `resolutionRuntimeFailure`; geração carimbada no aceite `:623` |
| Snapshot lido pelo paper | não carrega `ready_at`, `started_at`, `updated_at`, `failure_reason` | `interface ResolutionRuntimeSnapshot` `brokerstore.ts:1137–1150`; SELECT em `loadLockedResolutionRuntime` `:1392–1450`; colunas em `migrations/0011_resolution_runtime_safety.sql:214–240` |

O #52 acertou o alvo dele; a classe de cancelamento só mudou de rótulo
(`LAGGING` → `NOT_READY`/`MISMATCH`) e um soluço de 1,6 s cancelou 100 % das abertas.

### Saídas não têm caminho

| Fato | Valor | Origem |
| --- | --- | --- |
| Decisões `EXIT ACCEPTED` | 242 (2 mercados); `paper_order_id NULL` em 242/242 | 186 no BTC > 78k em 4 h (veredito oscila a cada ~77 s) |
| Leitores de `decision_kind = 'EXIT'` | só `exitstore.ts:349` (`lastExitSignature`) | `PENDING_SQL` filtra `ENTRY` |
| Forma da linha `EXIT` | `orderSide: "SELL"`, `sizeShares: null`, `bindingConstraint: "NOT_SIZED"` | `decisionrow.ts:181`, `:204`, `:207` |
| RFC-013 §5 | "gerar intenção de saída (paper)" — não diz se vira ordem | `RFC-013:161` |

Posição só fecha por liquidação, que está quebrada (PR-0 b): `closed_positions = 0`.

### Fora do escopo, registrado

`taker_fee_bps IS NULL` em 1.195/1.195 mercados ⇒ `policy.ts:206–208` nunca emite
FAK; 18/18 ordens `GTC post_only DEFAULT_PASSIVE_TAKER_FEE_UNKNOWN` (`policy.ts:252`);
`ttlS` chega `null` (`bridge.ts:329`) ⇒ GTC (`policy.ts:158–159`). Depende de fee
taker real; a RFC-028 usa fee assumida em policy própria, sem tocar a global. Disjuntor
`PARAM_CHANGE` (98,6 % das rejeições): RFC-025. Kill switch e gatilho `RECORDER_STALE`
(`killSwitchTriggersTick`, `brokerstore.ts`): RFC-021 — esta RFC toca `brokerstore.ts` só no
runtime de resolução. Nesta rodada só esta RFC altera o frescor em `bridge.ts`; o filtro
`strategy_id IS NULL` da RFC-028 (PR 3) entra depois do PR-1 e não altera a D1.

---

## Decisões que esta RFC exige do proprietário

| # | Pergunta | Recomendação | Se recusada |
| --- | --- | --- | --- |
| **P1** | "Saída aceita" vira **ordem de venda passiva** (D4-A) ou fica como **sinal** (D4-B)? | D4-A: sem ela o G2 depende 100 % da liquidação e nunca observa saída antecipada | D4-B: só rótulo no painel; zero código na ponte |
| **P2** | Ordem viva sobrevive a rotação de geração **transitória** (< 180 s, âncora monotônica) e adota a geração nova depois de re-validada? | Sim (D2): é a mesma leitura do #52, estendida a `NOT_READY`/`MISMATCH`; fills continuam estritos | PR-2 fica só com o diagnóstico (D3) |
| **P3** | Frescor da ponte medido por `received_at` (janela de 2 ticks, 60 s) com teto absoluto de 90 s em `decision_ts` (D1)? | Sim: o livro continua exigido fresco (30 s) e a política re-cota contra o livro atual | alternativa: manter `decision_ts`, janela 90 s |

## Decisões desta RFC

### D1 — a ponte mede frescor por quando viu a linha, não por quando o motor decidiu

`PENDING_SQL` passa a filtrar `d.received_at > now − MAX_RECEIVED_AGE_MS`
(nova, 60 s = 2 × `DEFAULT_BRIDGE_TICK_MS`) **e** `d.decision_ts > now −
MAX_DECISION_TS_AGE_MS` (nova, 90 s, teto absoluto). Dois ticks porque
`bridgeTickOnce` **pula** o tick quando o anterior ainda roda (`JOB_STILL_RUNNING`,
`paper/runner.ts:297–300`): com janela igual ao período, um tick lento perderia a
linha de novo. O teto de 90 s impede que um ciclo travado despeje decisões velhas
ao destravar. Proteção econômica intacta: `MAX_BOOK_AGE_MS` (30 s) segue exigindo
livro fresco e `decideOrderType` re-cota contra o livro atual dentro de `q_lo`/`q_hi`.

`AGED_OUT_SQL` conta só `received_at` posterior ao boot. `bridge.ts` não conhece o
boot: o runner passa `bootAt` nas deps de `bridgeTick` (instante do `PAPER_BOOT`,
`paper/runner.ts:386`). O contador volta a significar "perdeu algo **agora**";
`BRIDGE_TICK` ganha `boot_at`.

### D2 — graça para `NOT_READY` e `GENERATION_MISMATCH`, com âncora monotônica

`RESOLUTION_LAG_CANCEL_GRACE_MS` (180 s) passa a cobrir também os dois motivos.
**A âncora NÃO pode ser `updated_at` nem `started_at`**: `markBooting` rescreve
ambos a cada rotação; `markFailed`/heartbeat/state tick rescrevem `updated_at`
(tabela acima). Em ciclo boot→falha→boot (o `..._METADATA_VERSION_MISSING`
recorrente) a "idade" ficaria sempre < 180 s e a ordem **nunca** cancelaria: fail-open.

| Âncora | Definição | Efeito |
| --- | --- | --- |
| Primeira vista (principal) | primeiro `now` em que o paper viu **esta** ordem sob `!ready` ou geração divergente; `Map<order_id, Date>` na memória do worker; a entrada some quando o runtime está pronto e a ordem é validada/adota geração | idade ≥ 180 s → cancela como hoje |
| Teto duro (rede) | `ready_at IS NULL` visto para a ordem por > 180 s contínuos, **mesmo que `generation` tenha mudado no meio** | cancela, seja qual for a geração |
| Reinício do paper | o `Map` zera; toda ordem `open` entra no primeiro tick pós-boot | a graça recomeça do boot, nunca do passado |

Para isso `ResolutionRuntimeSnapshot` e o SELECT de `loadLockedResolutionRuntime`
passam a carregar `ready_at`, `started_at`, `updated_at` e `failure_reason`.
Dentro da graça, ordem `open` não é cancelada; log `PAPER_ORDER_RUNTIME_GRACE`
com `reason`, `age_ms`, `grace_ms`. **O cancelamento após a graça grava `age_ms`
e `grace_ms` em `resolution_cancel_details_json`** — hoje só a graça de LAGGING
grava `lag_age_ms` (`brokerstore.ts:1855`, `:1863`) e nenhuma chave `age_ms`
existe; sem isso a consulta de aceite devolve NULL e "passa" por vazio.

Se o runtime volta a `ready` sob geração nova **e**
`assertResolutionPolicyStillAuthorizesOrder` (`brokerstore.ts:1360`) continua
autorizando o token, a ordem adota a geração nova (`resolution_generation`
atualizado in-place; log `PAPER_ORDER_GENERATION_ADOPTED` com a geração
anterior). Mudança de contrato consciente: a RFC-012 desenhou a geração como
carimbo imutável; não há trigger de append-only em `paper_orders` (só em
`portfolio_position_entries`, `migrations/0015:113–114`). Sem re-validação, sem
adoção. **Fills seguem estritos**: `revalidateResolutionRuntimeForFill`
(definida em `brokerstore.ts:1613`; **seis** chamadas: `:2038`, `:2062`, `:2102`,
`:2223`, `:2249`, `:2318`) não ganha graça em nenhuma. `MISSING`, `STOPPED`,
`STALE` e `GRAPH_*` **nunca** ganham graça — runtime morto cancela na hora, como
hoje. Nenhuma migration.

### D3 — rotações contadas por causa

`bootGenerationUnlocked` passa a logar `RESOLUTION_GENERATION_ROTATED` com
`previous_generation`, `failure_reason` (o que `markFailed` gravou),
`failed_at` e, ao ficar pronto, `ready_after_ms`. Sem tabela nova: `JOB_FAILED`
já carrega `job` e `detail` (`resolution/runner.ts:1088–1092`); o que falta é o
elo falha → rotação → cancelamentos, hoje só inferível. O HANDOFF do PR-2
entrega a contagem de 7 dias por `failure_reason`. Corrigir as causas (ex.:
`RESOLUTION_MARKET_METADATA_VERSION_MISSING`, que o #61 não eliminou) fica para
quando houver contagem.

### D4 — saída: ordem (A) ou sinal (B), nunca os dois em silêncio

**D4-A (se P1 = ordem).** Segundo seletor na ponte para
`decision_kind = 'EXIT' AND outcome = 'ACCEPTED' AND paper_order_id IS NULL`,
frescor da D1. Tamanho = `paper_positions.shares` do token (`loadPositionShares`,
`brokerstore.ts:853`) porque a linha `EXIT` não é dimensionada; lado `SELL`;
`decideOrderType` com o flip por lado que `conservativeBound` (`bridge.ts:189`,
usado em `:260`; provado em `bridge.test.ts:239`) já faz — reutilizar; passiva no
ask, `post_only`. Mesmas proteções do `ENTRY` (gate de resolução, kill switch,
livro fresco, runtime pronto, id derivado do `decision_id`, `paper_order_id`
carimbado). Regras próprias: **uma** saída aberta por token — nova `EXIT ACCEPTED`
com ordem aberta é `BRIDGE_DECISION_SKIPPED EXIT_ORDER_ALREADY_OPEN`; `HOLD`
posterior **não** cancela (repostar a cada 77 s destruiria a posição na fila; a
histerese é da RFC-013). `reduceOnlyCap` (`brokerstore.ts:1912–1971`) segue como teto.

**D4-B (se P1 = sinal).** Zero código na ponte. `apps/web/src/dicionario.ts:184`
(`TIPO_DECISAO.EXIT`) ganha `consequencia`, campo que `Verbete` já define
(`dicionario.ts:15–22`): "Saída — sinal do motor; a posição só fecha por
resolução". O HANDOFF registra que `EXIT ACCEPTED` é evidência, não ordem.

Proibido: FAK sem fee taker conhecida; saída para token sem posição; escrita em
`portfolio_decisions` além de `paper_order_id` (append-only, `migrations/0014:171–180`).

---

## Escopo, em PRs

| # | Item | Muda comportamento? | Migration? | Rebuild (passo 3) | Depende de |
| --- | --- | --- | --- | --- | --- |
| 1 | ponte: frescor por `received_at` (60 s) + teto 90 s; `aged_out` pós-boot | sim (decisões passam a ser vistas) | não | `polymarket-paper` | P3 |
| 2 | runtime: graça com âncora monotônica + adoção de geração; log de rotação por causa | sim (ordem sobrevive a soluço < 180 s) | não | `polymarket-paper` **e** `polymarket-resolution` | P2 |
| 3 | saídas: D4-A **ou** D4-B | A: sim (ordem `SELL`); B: não | não | A: `polymarket-paper`; B: imagem `web` (não é de profile) + hard reload no navegador | P1 |

## Testes obrigatórios

- PR-1: decisão com `decision_ts = now − 45 s` e `received_at = now − 5 s` **é**
  considerada; `received_at = now − 40 s` (um tick pulado) **é**; `decision_ts =
  now − 95 s` **não** é; `received_at` anterior a `bootAt` não conta em `aged_out`.
  Verificado falhando no `bridge.ts` anterior.
- PR-2: ordem `open` sob `ready = false` há 60 s **sobrevive**; há 200 s **cancela**
  `NOT_READY` com `age_ms ≥ 180000` nos detalhes; **runtime alternando boot/falha
  a cada 20 s por 200 s (geração e `started_at`/`updated_at` novos a cada ciclo)
  → cancela**; geração rotacionada e pronta em 90 s com política autorizando →
  ordem adota a geração nova; política recusando → cancela; fill sob geração
  divergente **continua recusado** nos seis caminhos; `STALE`/`STOPPED` cancelam
  na hora.
- PR-3-A: `EXIT ACCEPTED` com posição de 8,11 shares gera `SELL` 8,11 passiva;
  segunda `EXIT ACCEPTED` com ordem aberta é pulada; `EXIT` sem posição é pulada;
  `HOLD` posterior não cancela.
- Cada teste de regressão verificado **falhando no código anterior**.

## Critérios de aceite (produção, após deploy em três passos, kill switch desarmado)

| Critério | Medida | Como medir |
| --- | --- | --- |
| Ponte vê os aceites | `aged_out ≈ 0` e `considered > 0` em ticks com aceite novo | `docker logs polymarket-paper \| grep BRIDGE_TICK` |
| Aceite vira ordem | ≥ 80 % das `ENTRY ACCEPTED` (excluídas as sob kill switch) com `paper_order_id` em 7 dias | `portfolio_decisions LEFT JOIN paper_orders ON decision_id`, `received_at > boot` |
| Runtime não cancela por soluço | 0 cancelamentos `NOT_READY`/`MISMATCH` com `age_ms < 180000` em 7 dias; **toda** linha desses motivos pós-deploy tem `age_ms` não nulo (senão o critério passa por vazio) | `paper_orders.resolution_cancel_details_json->>'age_ms'` (chave gravada pelo PR-2) |
| Rotações contadas | todo `RESOLUTION_GENERATION_ROTATED` tem `failure_reason` não nulo; contagem de 7 dias por `failure_reason` no HANDOFF | `docker logs polymarket-resolution \| grep -c RESOLUTION_GENERATION_ROTATED`, agrupado por `failure_reason` |
| Saídas (A) | toda `EXIT ACCEPTED` fresca com posição tem `paper_order_id` ou `BRIDGE_DECISION_SKIPPED` com motivo | consulta acima com `decision_kind = 'EXIT'` |

Fechamentos só são mensuráveis com o PR-0 (b), a liquidação, em produção.

## Condições de parada

- Qualquer PR exigir mexer em gate, kill switch, `caps.*` ou config versionada.
- Re-medição mostrar `aged_out = 0` e `considered > 0` já no HEAD (premissa caiu).
- P1/P2/P3 sem resposta do proprietário: PR-1 pode ir com a alternativa de P3;
  PR-2 fica só com a D3; PR-3 não começa.
- Fill precisar de graça para passar em teste: fills são estritos por desenho.
- Âncora da graça depender de um carimbo que o runtime rescreve (fail-open): parar.
- `make verify` vermelho.
