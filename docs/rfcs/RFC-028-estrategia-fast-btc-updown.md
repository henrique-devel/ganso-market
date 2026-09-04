# RFC-028 — Estratégia `fast_btc_updown@0.1.0`: máquina de amostra com controle, em sub-carteira imaginária, primeiro em SOMBRA

**Status:** draft — aguardando aprovação do proprietário (2026-09-03; decisões P1–P8 abaixo)
**Dependências:** PR-0 (b), liquidação (`prompts/roadmap/11-hotfixes-pr0-overview-settlement-sombra.md`, item b; sem ele nenhuma posição fecha e nada é rotulado); RFC-022 (`RFC-022-ponte-runtime-e-saidas.md` — ponte, runtime de resolução e saídas); RFC-025 (`RFC-025-disjuntor-de-parametro-redefinido.md` — `PARAM_CHANGE` sem contar a versão 1; sem ela todo mercado novo nasce com disjuntor aberto e a estratégia recusa tudo); RFC-011 (simulador pessimista, kill switch); RFC-016/019 (`end_ts`, abertura da janela). **RFC-024** (`RFC-024-descoberta-por-serie-e-livro-dos-rapidos.md`) é pré-condição para o braço E emitir ordem e para a cobertura do braço C — **não** para a fase sombra desta RFC. Em 03/09 as três dependências estão em `Status: draft` no worktree (`RFC-022…:3`, `RFC-025…:3`; PR-0 sem PR); os prompts re-medem cada uma em produção antes do merge do PR 3.
**Habilita:** o primeiro conjunto de regras rápidas registrado, versionado e replayável; N experimental em dias (24 mercados-hora/dia) com braço de controle, sem tocar carteira principal, gates, policy global, disjuntores ou perímetro; a evidência para decidir, depois, se algum braço emite ordem paper.
**Origem:** diagnóstico de 02–03/09/2026, relatório publicado em <https://claude.ai/code/artifact/f7e3e623-831a-464f-8435-6cc671d325e6> (síntese da estratégia; dois juízes com enxertos; estudo updown §3, §5, §6).

## Prompt a executar

`prompts/roadmap/20a-rfc-028-estrategia-fast-config-policy.md` (PRs 1–2) e depois `prompts/roadmap/20b-rfc-028-estrategia-fast-sombra-api.md` (PRs 3–4). Tudo em SIMULAÇÃO e, nesta RFC, em **SOMBRA**: os quatro braços decidem e gravam a cada
horário BTC; **nenhuma ordem é criada**. `policy.ts` 1.0.0 fica intocada; os limiares dos
gates ficam onde estão; nenhum disjuntor é contornado; nenhum endpoint de escrita nasce. A
primeira ordem do braço C é **passo seguinte**, fora desta RFC, condicionado a 3 dias de
sombra limpos, RFC-024 em produção e decisão explícita do proprietário (P6).

## Fatos medidos (02–03/09/2026 — RE-MEDIR antes de codar)

| Fato | Valor | Fonte |
| --- | --- | --- |
| Backtest sem look-ahead, comprar o favorito, BTC horário | líquido/cota entre **−0,080** (T−45) e **+0,021** (T−5); N = 162–168 por instante; **nenhum IC95 positivo** | estudo updown §3 (trade as-of + meio spread 0,005 + fee + 1 tick) |
| Favoritos p ≥ 0,90 a T−1 | 144/146 acertos, margem ≈ 0, cauda −0,99/cota | idem |
| GBM sobre TWAP60 vs mercado | Brier do mercado melhor em todos os instantes (T−10: 0,071 vs 0,099) | estudo updown §3 |
| `crypto_updown_gbm@1.1.0` em updown | +9,2 % Brier vs mercado; 0 entradas em 10 instantes com livro | síntese R6 |
| Fee taker por cota | `takerFeePerShare` = rate·p·(1−p) | `policy.ts:125-131` |
| Spread mediano / tick | 0,010 / 0,001 (422 de 457 mercados); `min_order_size` 5 | psql 03/09 |
| Maker: seleção adversa | ≈ −0,011/cota a T−10 (IC [−0,11; +0,08]); −0,07 a −0,09 em T−45..T−30 | backtest de proposta, **NÃO auditado**, cotou `bid = p−0,01`, não join |
| Braço E (convergência) | +0,055/cota, **28 obs.**, IC inclui zero; grade escolhida olhando 192 mercados | proposta 2, **não auditado** |
| Label após o fim | mediana 69 min, p90 87 | estudo updown §4 |
| Política global perto do fim | `DEFAULT_CATALYST_THRESHOLD_MIN = 30`; B4 `CATALYST_NEAR_WIDEN` 2 ticks atrás, nunca taker | `policy.ts:33`, `:184-199` |
| GTC por omissão | `ttlS null ⇒ GTC` (`policy.ts:158-159`); a ponte não passa `ttlS` no contexto (`bridge.ts:303-320`) ⇒ **18/18** ordens GTC | psql 03/09 |
| Taker inalcançável | ramo taker exige `takerFeeRate` conhecido (`policy.ts:206-208`); `taker_fee_bps` NULL em 998/998 updown | psql 03/09 |
| Cadência da ponte | `DEFAULT_BRIDGE_TICK_MS = 30_000`; `bridgeTimer` em `runner.ts:450` | `runner.ts:51` |
| Kill switch | engatado `RECORDER_STALE` desde 2026-09-02 02:21:05Z | `docs/HANDOFF.md:377-379` |
| RTDS (buckets) | só `twap30`/`twap60` `btc/usd`; **16,9 %** dos buckets de `polymarket_rtds_1m` ausentes (7 d); nenhum `spot`; colunas `(feed, symbol, bucket_start, open, high, low, close, samples)` | psql 03/09; `rtds.ts:451-457` |
| RTDS (amostras) | `polymarket_rtds_prices (feed, symbol, price, source_ts, received_at, ingest_lag_ms)` é a **única** fonte com carimbo por amostra; TTL 90 d. O RTDS grava no `polymarket-recorder`, não no `polymarket-paper` | `rtds.ts:427-429`; `retention.ts:203`; `polymarket-recorder.ts:3` |
| Guard do módulo paper | `WRITABLE_TABLES` com 8 tabelas; qualquer `INSERT INTO` fora dela falha; `\bwallet\b` vetado em código executável (`fast_wallet_state` passa: `_` não é fronteira) | `scope.test.ts:60-69`, `:30` |
| Onde cada coisa roda | `retention.ts` é consumido por `orchestrator.ts:21` no `polymarket-recorder` (`docker-compose.yml:182-187`); o `polymarket-paper` monta só `runtime.json` (`:309-342`); o `polymarket-portfolio` mostra o padrão env + bind mount por config (`:357`, `:375`) | `docker-compose.yml` |
| Livro nos 15 min finais | 8/32 horários (25 %) em 24 h; 19/240 (8 %) em 14 d | estudo updown §1 |
| Fonte da carteira principal | `paper_orders.source` CHECK `('manual','intent','portfolio')`; `acceptPaperOrder` rejeita `KILL_SWITCH_ENGAGED` antes de tudo | `migrations/0015:31-34`; `brokerstore.ts:447-462` |
| Posição é por token | `paper_positions.token_id` é PRIMARY KEY — não há posição por estratégia | `migrations/0008:86` |
| Evidência dos gates | `loadClosedPositions` lê `paper_positions` (`gatestore.ts:122-127`), consumida por `portfolio/runner.ts:1227`; fills taker do G2 lidos de `paper_ledger_events` (`gatestore.ts:313`); `buildPerformanceReport` lê posições/ordens sem filtro | `performance.ts:101-160` |
| Disjuntores | `portfolio_circuit_breakers.kind` ∈ 5 valores, `scope` ∈ market/token/portfolio | `migrations/0014:290-300` |
| Liquidação (`settlementTick`) | nunca fechou posição (`brokerstore.ts:2462` lê `outcomePrices` top-level) | PR-0 (b) |

## Decisões desta RFC

### D1 — É uma máquina de amostra, não uma promessa de lucro

Toda medição honesta dá EV ≈ 0 menos custos. O produto desta RFC é **N com controle**:
quatro braços de regra fixa, cada mercado-hora uma unidade experimental, um braço de controle
aleatório. Resultado negativo é evidência e encerra o experimento (D6).

### D2 — Sub-carteira `fast` fora da evidência dos gates

US$ 100 imaginários dentro dos US$ 1.000, com contabilidade própria (`fast_wallet_state`).
Toda ordem e decisão da estratégia nasce com `strategy_id = 'fast_btc_updown'`. A carteira
principal, o G1–G6 (`gatestore.ts`) e `buildPerformanceReport` passam a ler **só**
`strategy_id IS NULL`. Nenhum limiar muda; a mudança é registrada aqui porque toca a
consulta de evidência. O relatório exibe a contagem excluída (em sombra: 0). Posição da
sub-carteira em token que a carteira principal também segura: **recusa**
(`FAST_SKIPPED_MAIN_POSITION`) — em sombra não ocorre; como `paper_positions` é chaveada só
por `token_id`, posição por estratégia fica como pergunta aberta antes da primeira ordem.
Semântica do filtro: posição **excluída** se qualquer ordem do seu `token_id` tem `strategy_id`
(JOIN `paper_positions → paper_orders`); o teste de fixture grava exatamente isso.

### D3 — Policy própria; a global não muda um bit

`decideFastStrategyOrder(context)` em módulo próprio (proposta:
`apps/api/src/polymarket/paper/fastpolicy.ts`) com `FAST_POLICY_VERSION` própria.
`policy.ts` (`POLICY_VERSION = "1.0.0"`, `decideOrderType`) fica intocada; a estratégia
**não** chama `decideOrderType` (pode importar `takerFeePerShare`, que é pura). A fee assumida
0,07 vive só no contexto da estratégia e é gravada em cada decisão
(`assumed_taker_fee_rate`). **Rejeitado pelos dois juízes:** ligar fee 0,07 na policy global —
ligaria o ramo taker (`policy.ts:206-208`) para a carteira principal em 998/998 updown.
Invariantes de propriedade: toda saída tem limite; C nunca é taker; E nunca é GTC; sem
`worstPrice` ⇒ recusa; `ttlS` obrigatório.

### D4 — Universo e pré-condições (fail-closed, mais estritas que as globais)

| Item | Regra |
| --- | --- |
| Universo | só `question` casando `^Bitcoin Up or Down - (January..December) \d{1,2}, \d{1,2}(AM\|PM) ET$` (regex **estrita**; a `SHORT_SERIES_PATTERN` de `registry.ts:66` é leniente e não serve) |
| Unidade | mercado-hora; 1 decisão por braço por mercado; IC por mercado, nunca por cota |
| Livro | idade ≤ 10 s e spread ≤ 0,03 (`bookAtOrBefore`, `brokerstore.ts`) |
| RTDS | idade do `twap30` ≤ 3 s medida em `polymarket_rtds_prices.received_at` (última amostra com `feed = 'twap30'`; `source_ts` é o carimbo da venue) ⇒ senão `FAST_SKIPPED_RTDS_STALE`; nenhum bucket faltante nos últimos 15 min de `polymarket_rtds_1m`, que também fornece `S0`/`S_t`. **Não** avaliar idade a partir de `polymarket_rtds_1m` (bucket de 1 min: ou recusa 100 %, ou inventa) |
| `S0` | `open` do `twap60` no bucket da abertura da janela (derivação da RFC-019, `openPriceKey` em `catalog.ts:116`, uso em `fundamental/estimator.ts:317`); ausente ⇒ `FAST_SKIPPED_NO_S0` |
| Estado | kill switch desengatado (`loadKillSwitch`, `brokerstore.ts:248`); **nenhum** disjuntor aberto no mercado/token (`portfolio_circuit_breakers`, todos os `kind`); processo com `uptime < 300 s` ⇒ `FAST_SKIPPED_WARMUP`; últimos 60 s do mercado ⇒ não opera |
| Sinal | `z = ln(S_t/S0)/(σ√k)`, σ = 5 bps/min — parâmetro **congelado** da config, sem medição prévia auditada; o backtest do PR 1 mede o σ realizado e o registra na seção "Backtest do filtro z" (não altera o 0.1.0), k = minutos até `end_ts` |
| Empate | `\|ln(S_t/S0)\| < 10 bps` a < 10 min ⇒ ninguém opera (`FAST_SKIPPED_TIE_ZONE`) |

### D5 — Braços

| Braço | Regra | Modo nesta RFC | Modo alvo |
| --- | --- | --- | --- |
| C maker | T−12..T−8; favorito em [0,70; 0,92] com `\|z\| ≥ 1`; post-only join do melhor bid; GTD até T−4; recusa se fila visível > 3× ticket; sem requote | sombra | ordem paper (passo seguinte, P6) |
| E convergência | `\|z\| ≥ 1,5`, k ∈ [4, 10], ask+1 tick em [0,80; 0,95); FAK com `worstPrice = ask+1 tick`; fee assumida 0,07 gravada; z trocou de sinal nos 3 buckets anteriores ⇒ não opera | sombra | paper só após RFC-024 |
| A favorito tardio | T−10 ± 30 s; lado com mid ≥ 0,60 se 0,60 ≤ ask ≤ 0,90 | sombra | sombra permanente |
| D controle | lado sorteado com semente fixa por `condition_id`; mesma regra de preço do A | sombra | sombra permanente |
| B modelo 1.1.0 | — | só comparação no replay | nunca emite ordem |

Ticket 5 cotas (`min_order_size`) em todos. Saída só por resolução; C cancela por TTL.

### D6 — Limites e critérios pré-registrados (nunca afrouxam)

| Limite / critério | Valor |
| --- | --- |
| Ordens | ≤ 1 por braço por mercado-hora; ≤ 2 posições abertas por braço; ≤ 24/dia no total |
| Stop | US$ 10/braço/dia; US$ 20/sub-carteira/dia |
| Pausa de braço | acerto em 0,60–0,90 < implícito − 10 pontos com N ≥ 50 (`FAST_ARM_PAUSED`) |
| Parar braço | N ≥ 100 e IC95 superior do PnL/cota < 0; ou (E) Clopper-Pearson inferior de ε > ε*; ou stop diário 3× em 5 dias |
| Promover ticket 5 → 20 (ainda paper) | N ≥ 300, IC95 inferior > 0, p < 0,05 vs D, replay reproduz PnL com desvio < 5 % |
| Encerrar | 30 dias ou 700 mercados/braço sem promoção ⇒ "sem edge detectável a 3 c/cota" |
| Soberania | kill switch global e todos os disjuntores; **rejeitado** respeitar só alguns |

### D7 — Registro e congelamento

`strategy_decisions` append-only (trigger no padrão de `portfolio_config_versions_guard`,
`migrations/0014:25-34`), índice `(strategy_id, arm, decision_ts)`, com braço,
`config_version`, `config_hash`, insumos as-of (bid/ask/spread/`queue_ahead`/`S0`/`S_t`/`z`/`k`/fee
assumida), veredito e reason code (código de máquina `FAST_*`, rótulo PT em
`apps/web/src/dicionario.ts`: `MOTIVO_FAST: Dicionario` ao lado de `MOTIVO_GATE` (l. 94) e
`MOTIVO_DECISAO` (l. 194), consumido por `rotulo` (l. 419)). `config/fast.json` 0.1.0 é **congelada antes do deploy**;
versões em tabela imutável (`fast_config_versions`); qualquer mudança é versão nova. Parser e
hash seguem `parsePortfolioConfig`/`portfolioConfigHash` (`portfolio/config.ts:330`, `:914-929`).
Backtest do filtro z sobre ~300 mercados é obrigatório e auditado antes do deploy (o de
proposta não foi); seu resultado entra nesta RFC como seção "Backtest do filtro z".

### D8 — Fase sombra primeiro; a ordem é outro passo

Em 0.1.0 todos os braços têm `mode: "shadow"`. O worker `fast` (job de 5 s no
`polymarket-paper`, ao lado do `bridgeTimer` de `runner.ts:450`) decide e grava; o caminho
que chamaria `acceptPaperOrder` **no mesmo tick** existe atrás de `mode` e é provado
inalcançável em sombra por teste. Sair da sombra exige versão 0.2.0 da config e P6.

## Decisões do proprietário exigidas

| # | Decisão |
| --- | --- |
| P1 | Aceitar EV esperado ≈ 0 ou levemente negativo em troca de N com controle (D1) |
| P2 | Sub-carteira fora da evidência dos gates: filtro `strategy_id IS NULL` em G1–G6 e performance (D2) |
| P3 | Reservar US$ 100 dos US$ 1.000 à sub-carteira, com contabilidade própria (D2) |
| P4 | Migration nova (a próxima livre: 0019 em 03/09; 0020 se a RFC-027 tiver seguido o caminho B): `paper_orders.source` ganha `'fast'` + `strategy_id`; `strategy_decisions`; `fast_config_versions`; `fast_wallet_state`; retenção de `strategy_decisions` (proposta: TTL 180 d, quota 1 GiB, não protegida) |
| P5 | Congelar `fast.json` 0.1.0 com os parâmetros de D4–D6 antes de olhar mais dados (D7) |
| P6 | **Fora desta RFC:** autorizar a primeira ordem do braço C só após 3 dias de sombra limpos + RFC-024 em produção |
| P7 | Promoção de ticket só pelos critérios de D6, ainda em paper; nunca execução real |
| P8 | Publicar no Nginx, com `location =` GET-only, o par `location = /api/polymarket/strategies/fast/{decisions,summary}` → `proxy_pass http://api:3000/polymarket/strategies/fast/...` (padrão `nginx.conf:193-197`, RFC-015) |

## Escopo, em PRs

| # | Prompt | Item | Muda comportamento da carteira principal? |
| - | --- | --- | --- |
| 1 | 20a | backtest do filtro z (~300 mercados, CLI read-only); `config/fast.json` + parser fail-closed + hash; `decideFastStrategyOrder` + testes de propriedade | não |
| 2 | 20a | migration nova (0019/0020, ver P4) + retenção declarada em `retention.ts` + **rebuild do `polymarket-recorder`** (é quem executa a retenção) | não (só DDL aditivo) |
| 3 | 20b | worker `fast` em sombra (decisões gravadas, zero ordens); `WRITABLE_TABLES` (`scope.test.ts:60-69`) ganha só `strategy_decisions`, `fast_config_versions`, `fast_wallet_state`; mount `./config/fast.json:/etc/ganso/fast.json:ro` + env no `polymarket-paper`, parser fail-closed (arquivo ausente ⇒ worker não sobe); filtro `strategy_id IS NULL` em gates/performance/ponte (a ponte só após o PR-1 da RFC-022; o filtro não altera o frescor da D1 dela) | não (consulta de evidência ganha filtro; em sombra, 0 linhas excluídas) |
| 4 | 20b | `GET /polymarket/strategies/fast/{decisions,summary}`; Nginx exato (par `/api/...` → `proxy_pass` sem prefixo, P8) + `test_nginx_perimeter.py`; chip "Rápidos" com nome do mercado e reason codes PT (na Mesa da RFC-026 se ela estiver em produção; senão na sub-aba "Rápidos" atual, `Portfolio.tsx:534`) | não |

## Testes obrigatórios

- Parser de `fast.json`: campo faltante, banda invertida, σ ≤ 0, `mode` desconhecido ⇒ recusa nomeada; hash estável.
- Propriedades de `decideFastStrategyOrder`: toda saída tem limite; C nunca taker; E nunca GTC; sem `worstPrice` ⇒ recusa; `ttlS` obrigatório; `policy.ts` sem diff.
- Pré-condições: cada uma falhando sozinha produz o reason code próprio; disjuntor aberto de **qualquer** `kind` ⇒ recusa; kill switch engatado ⇒ recusa antes de decidir.
- Sombra: com `mode: "shadow"` em todos os braços, `acceptPaperOrder` nunca é chamado (spy) e `paper_orders` fica vazia após N ticks.
- Filtro: uma ordem com `strategy_id` inserida em fixture **não** aparece em `loadClosedPositions`, nos fills taker do G2 nem em `buildPerformanceReport`; a contagem excluída sobe para 1.
- Replay: decidir de novo sobre os insumos as-of gravados reproduz braço/veredito/reason/z.
- Perímetro: locations novos 401 sem sessão, 404 em método ≠ GET; `POST /paper/intents` segue 404.
- Guard: `scope.test.ts` verde com as três tabelas novas em `WRITABLE_TABLES` e nenhum identificador `wallet` no módulo; `fast.json` ausente ⇒ `polymarket-paper` não sobe (teste do parser).
- Cada teste de regressão verificado **falhando no código anterior**.

## Critérios de aceite (fase sombra, verificáveis em produção)

| Critério | Como medir |
| --- | --- |
| 4 braços gravando em ≥ 90 % dos horários BTC **descobertos**, por 3 dias | `strategy_decisions`: `count(DISTINCT condition_id)` por `arm` ÷ mercados do universo casando a regex com `end_ts` na janela e ≥ 15 min de vida catalogada. O denominador pode ser pequeno (03/09: 0 updown com `end_ts` futuro — lacuna de descoberta que a RFC-024 fecha); registrar o denominador no HANDOFF |
| Braços **exercitados** (anti-degeneração) | ≥ **20** decisões por braço (A, C, D, E) que passaram todas as pré-condições e chegaram ao veredito do sinal (`reason` fora de `FAST_SKIPPED_KILL_SWITCH`, `_BREAKER_OPEN`, `_RTDS_STALE`, `_NO_S0`, `_WARMUP`, `_BOOK_STALE`): `SELECT arm, reason, count(*) FROM strategy_decisions GROUP BY 1,2 ORDER BY 1,3 DESC`. 100 % de recusa por pré-condição **não** é aceite |
| Janela válida | kill switch engatado ou disjuntor aberto em **qualquer** instante dos 3 dias ⇒ a janela é **inválida e recomeça** (a recusa está certa, mas não é evidência). Hoje (02/09) o kill switch está engatado e a RFC-025 é draft: a janela só começa depois de rearme e disjuntores fechados |
| Zero ordens | `SELECT count(*) FROM paper_orders WHERE strategy_id IS NOT NULL OR source = 'fast'` = 0 |
| Zero contaminação | G1–G6 e `/paper/performance` idênticos antes/depois do deploy; contagem excluída = 0 |
| Replay determinístico | amostra ≥ 200 decisões reproduzida 100 % pela policy da estratégia |
| Worker saudável | `FAST_TICK` a cada 5 s sem erro por 3 dias; CPU do `polymarket-paper` sem degrau |

## Condições de parada

- Qualquer diff em `policy.ts`, em limiar de gate, em disjuntor ou em migration já aplicada.
- Uma ordem com `strategy_id` em produção durante a fase sombra.
- Janela de sombra com kill switch engatado ou disjuntor aberto: não completa; recomeça.
- Backtest do filtro z não reproduz a direção do de proposta, ou o IC95 exclui zero pelo lado negativo em toda a grade — registrar e parar antes do deploy.
- RTDS sem `twap60` por > 24 h (S0 impossível): parar, não substituir a fonte.
- `fast.json` alterado depois de congelado sem versão nova.
- `make verify` vermelho; endpoint de escrita novo; prefixo sob `/paper` no Nginx.
