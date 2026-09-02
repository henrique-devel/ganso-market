# Handoff do projeto Ganso Market

- Última atualização: 2026-09-01 — **RFC-015: o painel do operador (PR #76)**.
  A faixa de PnL passa a existir em **todas** as abas, "Visão geral" vira a aba
  default com um agregador (`GET /polymarket/overview`) e um feed keyset
  (`GET /polymarket/events?after=`), o vocabulário de máquina ganha dicionário
  em português **sem esconder o código**, e o `unknown` cru some da tela.
  **Nada do que a faixa mostra é dado novo** — `realized_pnl_day_usd`,
  `_week_usd`, banca, equity e drawdown já eram publicados e já eram PARSEADOS
  por `portfolio.ts`, e nunca renderizados; não-realizado e fees vinham de
  `/paper/performance`, que existia e estava fechado no Nginx.
  **O achado da sessão não estava no escopo:** o 500 do
  `GET /polymarket/decisions` de 31/08 18:21Z, registrado como "não
  reproduzível", é aritmética. Não existe índice em `decision_ts` sozinho, então
  `ORDER BY decision_ts DESC LIMIT 500` era um parallel seq scan de **715 ms com
  cache frio** (12 ms quente) — e a API roda com **`statement_timeout = 1000
ms`**, porque `database.ts` reusa `connect_timeout_ms` como timeout de query e
  **todo worker sobrescreve para 30–120 s menos a API**, que é justamente quem
  serve o painel. Ordenar por `decision_id DESC` (a PK, monotônica com a
  inserção e uma ordem TOTAL onde `decision_ts` empata dentro de um ciclo):
  **0,17 ms**, e **2,2 ms medidos em produção depois do deploy**.
  `GET /polymarket/opportunities` tinha o mesmo defeito um passo atrás —
  `DISTINCT ON` que não usava o índice, **786 ms** com sort externo derramando
  9,5 MB por worker em disco, na aba que fica aberta com poll de 30 s. Reescrito
  como loose index scan: **24 ms medidos em produção**. Estava fora do escopo
  até a aba "Rápidos" precisar da consulta.
  **`budget_used_pct` foi corrigido antes de `data-quality` ser publicado**: era
  bytes FÍSICOS de um SUBCONJUNTO (`polymarket_%`) contra o orçamento inteiro,
  enquanto `QUOTA_GLOBAL_ALARM` soma bytes VIVOS da lista INTEIRA de retenção.
  Dois erros somados. A medição saiu do fecho de `createRetentionJob` e virou
  `measureTableSizes` exportada — um segundo estimador seria repetir o defeito
  com outro nome — e a leitura das 74 tabelas passou a ser **uma** consulta de
  catálogo, 16 ms.
  Perímetro **verificado de dentro do servidor**: `overview`, `events`,
  `data-quality` e `paper/performance` respondem **401 sem sessão** e **404 em
  POST/PUT/DELETE/PATCH**; `POST /paper/intents`, `/paper/orders`,
  `/paper/kill-switch`, `/portfolio/halt` e `/portfolio/resume` seguem **404**.
  `make verify` verde, **1538 testes na API e 82 no web, zero migration**.
  Detalhe em [`docs/rfcs/RFC-015-operator-dashboard.md`](rfcs/RFC-015-operator-dashboard.md).
  **ACHADO NÃO CAUSADO POR ESTA SESSÃO, e o mais acionável dela:**
  `polymarket_book_deltas` ficou **53 minutos sem uma única linha**
  (22:43:47Z → 23:36Z), começando ~30 min ANTES do merge. Sobreviveu ao rebuild
  do profile às 23:19Z e só voltou no restart seguinte, recuperando o regime
  cheio (8.892 deltas/min em 186 tokens). Durante a parada, `book_snapshots`,
  `book_snapshots_full` e `rtds_prices` seguiram gravando e o universo tinha 92
  mercados vivos — é o caminho **incremental** do livro, não a conexão. **E
  `polymarket_data_gaps` não abriu uma única lacuna**: 53 minutos de
  microestrutura perdida sem nenhum alarme. Seção própria abaixo.
  Registro anterior: **RFC-017: o shadow replay nos dois modos, e
  três premissas do escopo de 28/08 desmentidas pela própria ferramenta (PRs #72
  e #73)**. Um CLI **read-only por construção** (allowlist de statement mais
  `SET TRANSACTION READ ONLY` por leitura) que varre uma chave de config sobre o
  decision log gravado, e que troca a FONTE da estimativa pelas linhas shadow
  as-of o `decision_ts`. Rodado em produção sobre a janela inteira — **224.647
  decisões, 100% admitidas pelo replay de baseline, zero mismatch**.
  **(1) O denominador honesto não é o log, são 9,05% dele.** `evaluateMarket`
  recusa em escada e as recusas de cima são decididas por escalares já
  persistidos que nenhuma troca de config recomputa; só **20.340 linhas, em 65
  dos 322 mercados**, chegam à conta. Metade do log é
  `PORTFOLIO_CIRCUIT_BREAKER`. Dividir flips por 224 mil daria um número **11×
  menor que o real** e chamaria de "impacto zero" o que é "população errada".
  **(2) `capitalCostAnnual` não é "quase inerte": não muda NENHUMA decisão.**
  Em 0,15, 0,183, 0,20, 0,25, 0,30, 0,365 e 0,40 a coluna AÇÃO
  (`ACCEPTED ↔ REJECTED`) é **0 linhas / 0 mercados**, e a busca de valor de
  virada não acha mudança de ação em todo o bracket **[0,12; 1000] — nem a
  100.000% a.a.** A causa é o lockup: o log tem dois (**38 min** e **3,67 h**), e
  com o hurdle do buffer em 0,0005/dia a carga máxima a r=0,40 é
  **0,0000827/ação**, 0,41% do `edgeLiqMin`. O maior candidato consome **0,4284%**
  da folga da decisão mais apertada. Isso corrige o registro de que na saída "os
  12% já são vinculantes": o critério 6 compara contra 0,000159/ação enquanto o
  critério 1 dispara em 0,01 — está **63× dentro** dele. **A cunhagem da 1.3.0
  continua sendo decisão do proprietário, e a medição a transforma numa decisão
  sobre o UNIVERSO negociado, não sobre a taxa.**
  **(3) Parte das decisões JÁ usa o shadow — defeito ativo.** `estimateAsOf`
  (`store.ts:178`) não filtra `status` nem desempata, e cada instante tem uma
  linha ativa mais uma por modelo shadow com o **mesmo `decision_ts`**. Com
  **zero modelos promovidos**, **5 decisões** de 01/09 gravaram
  `estimate_source='MODEL'` com os números exatos da linha shadow (a 698296 tem
  `q_lo=0,990385` do `estimate_id` 837093, não `0,997632` da ativa 837092).
  Nenhuma foi aceita, mas a invariante da RFC-010 está quebrada. **É área da
  RFC-010, fica fora deste escopo e vira decisão do proprietário.**
  **Modo B:** das 2.576 decisões que chegaram à estimativa com shadow as-of,
  **519 (20,1%) em 9 de 22 mercados (40,9%)** teriam agido diferente — **511
  entradas só do shadow contra 8 só do baseline**. O **PnL contrafactual ainda
  não é medível**: 0 das 515 entradas tem label final. A ferramenta reporta isso
  em vez de inventar um número. **A própria rodada seca pegou dois defeitos de
  medição na ferramenta** antes de qualquer número chegar ao proprietário: AÇÃO
  estava somada a MOTIVO (uma troca de PERNA reescrevia o rótulo de 284 rejeições
  que continuavam rejeições), e os deltas vinham das colunas de 6 casas enquanto
  o motor decide em 9 (a 0,183 a carga que vira a perna é 2,5e-7). Determinismo
  provado em produção: duas rodadas sobre a janela fechada no `decision_id
703817` deram agregados idênticos. `make verify` verde, **1518 testes na API**.
  Sem migration. Evidência:
  [`docs/test-results/RFC-017-shadow-replay.md`](test-results/RFC-017-shadow-replay.md).
  Registro anterior do dia: **RFC-014 + RFC-019: o modelo deixa de calar
  em barreira e updown (PR #70)**. A categoria crypto estava em **31,9%** de
  cobertura (36 de 113 mercados com linha MODEL em 24 h) porque o modelo recusa,
  corretamente, tudo que não é terminal: **barreira 0 de 51, updown 0 de 13**.
  As duas formas entram como **uma** versão nova da mesma família —
  `crypto_updown_gbm@1.1.0`, formas no hyperparam imutável `forms` — coexistindo
  em `shadow` com a 1.0.0 **intocada** (golden pinado bit a bit); a promoção
  segue exigindo gate PASS + ação manual, e o gate não mudou.
  **A re-medição desmentiu três premissas do escopo**: `event_start_ts` **não
  existe** (a D2 da RFC-016 mediu `eventStartTime: null` em 100/100 — a abertura
  passa a ser derivada do fim real menos a duração do título); a resolução real é
  **candle Binance**, não Chainlink, então "zero basis risk" caiu e o viés ficou
  registrado (no updown o offset cancela em K/S; na barreira o TWAP alisa os
  pavios enquanto a 2·Φ contínua superestima); e o **RTDS de produção só entrega
  BTC** (eth/sol/xrp e o feed spot nunca gravaram uma linha — investigação do
  recorder aberta, fora deste escopo). Revisão adversarial de seis lentes fechou
  **sete defeitos**, dois deles introduzidos nesta sessão: `$1 million` virava
  strike de **$1** (numa barreira, toque instantâneo com q≈1), o range contava
  dias no ano do deadline e abria a janela ~23 h cedo num ano bissexto, e a
  direção neutra ("hit") **invertia após um cruzamento**. `dip below` não virou
  nem barreira nem terminal: zero ocorrências em produção e nenhuma regra decide
  a família — fica no baseline, como manda a condição de parada. Cobertura do
  parser no universo vivo (54 membros): **26 → 51**; servível com o feed que
  existe: **20 → 41 (2,05×)**. `make verify` verde (1467 testes na API),
  PostgreSQL 18.4 real 8/8 com as 17 migrations pelo protocolo. Sem migration
  nova. Evidência:
  [`docs/test-results/RFC-014-019-barrier-updown.md`](test-results/RFC-014-019-barrier-updown.md).
  Registro anterior do dia: **RFC-016: o instante real de fim de mercado
  (PR #66)**. A re-medição **desmentiu cinco das sete premissas** do escopo de
  28/08 — a cadência de 10 s já estava ativa desde 23/08, o horizonte já era
  intradia via `polymarket_rule_versions.end_date`, os "558 crypto vencidos" são
  linhas obsoletas de mercados fora do universo e o cap não morde desde 29/08 —
  e encontrou no lugar um defeito muito maior: **o label store lia a coluna
  date-only**, punha 94% dos `publicly_knowable_ts` à meia-noite (mediana 16 h
  adiantados) e, como a calibração filtra por `decision_ts <
publicly_knowable_ts`, descartava **38.200 de 74.412** estimativas MODEL — e
  **8.063 de 8.063** das feitas na última hora de vida do mercado, que é
  exatamente o que a cadência de 10 s existe para produzir. É o mecanismo por
  trás do bloqueio "o gate da RFC-010 não tem como acumular evidência".
  Migration 0017 (`end_ts`, aditiva, prospectiva), captura nos dois call sites,
  onze consumidores auditados um a um, reserva de 25 slots do cap para
  horizontes curtos e `budget.test.ts` recalibrado sem afrouxar o piso.
  **Deployado às 23:57:35Z e verificado**: `end_ts` em 87/87 membros, labels à
  meia-noite 94% → 2,9%, estimativas pontuáveis **36.212 → 74.412**, última hora
  **0 → 8.063**, janelas finas em mercado longo **75% → 0**, zero erros nos seis
  serviços. Ver "SESSÃO 2026-09-01". Registro anterior do dia: **nowcast oficial no calendário
  macro + sync com retry (PR #63)**. A entrega veio junto de uma **medição que
  desmente a premissa do trabalho**: rodando o parser real contra os 22 mercados
  macro de produção, os 22 falham em `UNRECOGNIZED_VARIABLE` **antes** de o
  consenso ser lido — 20 são mercados de MUDANÇA de juros (o modelo precifica
  NÍVEL), 1 é Bank of England, 1 é Estreito de Ormuz, e **nenhum** é de CPI ou
  emprego. O consenso faltando **não era o gargalo**, e este PR não destrava
  nenhum dos 22; o valor do dado é prospectivo. Entregue mesmo assim, com fonte:
  `cpi-2026-09` carrega o nowcast do Cleveland Fed lido em 31/08 (`cpi_yoy` 3.37,
  `cpi_mom` 0.36, `core_cpi_yoy` 2.38), keyed por variável para não servir a
  escala errada a um mercado irmão; as outras 14 entradas seguem sem consenso, de
  propósito, com o motivo de cada uma no arquivo. E o sync do calendário passou a
  rodar no job de 10 min além do boot — a fragilidade de 23/08, cuja ocorrência
  mais recente era de `20:53:49Z` desta mesma noite. **Deployado às 22:08–22:20Z
  e provado de ponta a ponta às 22:49Z**, num caso que não foi induzido: o CD do
  #64 reiniciou o recorder, o boot sync falhou às `22:39:14Z` — e o job de 10 min
  recuperou sozinho às `22:49:15Z` com `recovered: true`. Ver "SESSÃO 2026-08-31 (noite, 2)". Registro anterior do dia: **hotfix do
  `RESOLUTION_MARKET_METADATA_VERSION_MISSING` recorrente (PR #61)**: causa raiz
  medida em produção (78 falhas/24 h em duas populações — 674 rejeições/dia
  journalizadas indevidamente e a corrida entre o `enter` e a primeira versão de
  metadata), corrigida sem migration e sem afrouxar o fail-closed. **Deployada e
  verificada em produção às 20:45Z**: as duas causas confirmadas com o input que
  as disparava (rejeições absorvidas com evento tipado; `enter` e primeira
  versão de metadata no mesmo instante), taxa **~78/dia → 0**, zero erros nos
  dois serviços. Ver a seção "SESSÃO 2026-08-31 (noite)". Registro anterior do dia: **re-medição do bloco de 28/08 em produção,
  regra de parada honrada**: os quatro defeitos re-medidos e nenhum existe
  mais — zero código/config/migration/deploy nesta sessão. Soak do #51
  **fechado**: zero resets do G2 em ~65 h; #50 e #53 saudáveis e contínuos;
  soak do #52 segue **impossível de medir** porque o kill switch está engatado
  desde 28/08 20:59Z — o rearme é um clique do proprietário no painel. Dado
  novo para a redeclaração da quota: `book_deltas` cresce ~3,3 GB/dia físico
  pós-repack. **Na mesma sessão o proprietário autorizou a migration 0016**,
  aplicada pelo protocolo da 0013: a poda de `portfolio_decisions` fechou
  pela primeira vez na vida — 449.553 linhas por quota em segundos, zero
  `RETENTION_STEP_FAILED`)
- Sessão 2026-08-28 (noite — **bloco de hotfixes autorizado pelo
  proprietário executado de ponta a ponta e ativo em produção**: o medidor de
  bytes vivos da retenção parou de herdar o arquivo físico e desarmou uma
  exclusão de 33,9 M de linhas vivas (#50), o fingerprint do G2/G5 virou o
  schedule da venue e os resets por rotação pararam (#51), o lag transitório do
  runtime deixou de cancelar ordens paper (#52), o coletor onchain gravou as
  primeiras linhas da sua história (#53), o batch da quota virou orçado por
  bytes (#54) e o `VACUUM FULL` de `polymarket_book_deltas` recuperou **78 GB**
  — banco de 116 → 38 GB. Um bloqueio novo com condição de parada: a poda de
  `portfolio_decisions` exige um índice em
  `portfolio_panel_snapshots(decision_id)` = migration 0016, pendente de
  autorização)
- Branch principal: `main`
- RFC-016: **implementada e ativa em produção** desde 2026-08-31 23:57:35Z (migration 0017)
- RFC-014 + RFC-019: **código completo (2026-09-01, PR #70)**, `crypto_updown_gbm@1.1.0`
  em `shadow` ao lado da 1.0.0; deploy e verificação em produção na mesma sessão
- RFC-017: **implementada e rodada em produção** (2026-09-01, PRs #72 e #73);
  ferramenta de leitura, não muda runtime nem config
- RFC ativa: RFC-013 (motor de portfólio) — fases A–E mergeadas (PRs #30, #33,
  #34, #36, #39) mais os fixes #40 (G1) e o desta sessão (G2/G3/G4/G6);
  migration 0014 aplicada em produção e **nunca alterada** desde então
- RFC-012: **ativa em produção** desde 2026-08-26 01:15Z
- RFC-013: **ativa em produção** desde 2026-08-26 19:53Z. Um falso `PASS` no G1
  ficou de pé por ~4 h e foi corrigido no PR #40; a auditoria dos outros cinco
  gates sob a mesma lente encontrou o mesmo defeito em **G2, G3 e G4**, e uma
  variante mais silenciosa no **G6**. Config **1.1.0 → 1.2.0**
- Modo permitido no runtime atual: `paper`

Este documento registra o ponto de continuidade entre sessões. Ele não
substitui a ordem de fontes de verdade: solicitação atual do proprietário,
`docs/PRD.md`, RFC ativa e somente depois código/configuração.

## DECISÃO DE ESCOPO — caminho único Polymarket (2026-08-18)

**FATO INFORMADO:** o proprietário decidiu seguir por um único caminho: a
Polymarket. O desenvolvimento do bot para a rede Solana foi pausado e removido
do escopo.

**FATO VERIFICADO:** em consequência, foram removidos do repositório: as RFCs
do caminho Solana (RFC-001A, RFC-003, RFC-004, RFC-005, RFC-006, RFC-008) e
seus test-results, os módulos `domain/` e `ingestion/` do market-engine (e as
dependências `yellowstone-grpc-*`, `bs58`, `sha2`, `futures`), o probe
Yellowstone, os scripts `rfc001a_*` e o runbook de limpeza do host antigo. O
PRD (v0.2), README, índice de RFCs e prompt mestre foram reescritos para o
caminho único. Todo o histórico permanece no git; uma retomada futura do
caminho Solana exigiria novas RFCs.

- A migration `0003_domain_events.sql` permanece aplicada no servidor; suas
  tabelas ficam dormentes e vazias (nada escreve nelas). Migrations aplicadas
  não são removidas nem alteradas.
- O market-engine ficou reduzido à fundação (runtime, configuração,
  health/readiness); 14 testes Rust.
- A hot wallet Solana e sua prova de recuperação offline deixaram de ser
  bloqueios do projeto. A única wallet prevista é a burn wallet Polygon da
  RFC-009.

## DECISÃO DE PRODUTO — motor de quatro modelos e novas RFCs (2026-08-19)

**FATO INFORMADO:** o proprietário definiu o desenho do motor Polymarket
(oportunidade respondida por 8 perguntas; modelos fundamental, microestrutura,
risco de resolução e portfólio; critérios de entrada/saída; grafo lógico entre
mercados; campos do painel). Registro verbatim em
[`docs/research/plano-owner-polymarket-2026-08-18.md`](research/plano-owner-polymarket-2026-08-18.md).

**FATO VERIFICADO:** pesquisa profunda executada em 2026-08-19 (docs oficiais
V2, GitHub, Reddit, X/Truth Social, literatura quant, incidentes UMA; 8 agentes
de pesquisa, ~1M tokens) e consolidada em
[`docs/research/polymarket-deep-dive-2026-08.md`](research/polymarket-deep-dive-2026-08.md).
Destaques que moldaram as RFCs: fees V2 por categoria (fórmula
`C × feeRate × p × (1−p)`, taker only, crypto 0.07 — maker/post-only é
estruturalmente preferível), delay de 250ms para ordens marketáveis em
crypto/finance, não existe histórico oficial de book L2 (o recorder próprio é a
única fonte de microestrutura), UMA: bond ~US$ 750, liveness 2h, máx. 2
requests e resultado 50/50 possível, RTDS/Chainlink TWAP é o mesmo dado que
resolve mercados crypto (insumo direto do modelo fundamental).

**FATO VERIFICADO:** RFCs reestruturadas em 2026-08-19: a RFC-007 virou
fundação de dados/recorder V2; foram criadas RFC-010 (modelo fundamental),
RFC-011 (microestrutura e paper broker), RFC-012 (risco de resolução e grafo
lógico) e RFC-013 (motor de portfólio, entrada/saída e gates). PRD emendado
para v0.3 (POLY-09..16). RFC-009 agora depende dos gates G1–G6 da RFC-013.
Revisão adversarial de consistência aplicada (numeração cruzada, orçamento de
40 GB com reserva explícita, fontes macro na coleta, replay independente de
TTL).

## RFC-010 IMPLEMENTADA E ATIVA EM PRODUÇÃO (2026-08-20)

- **FATO VERIFICADO (produção, 2026-08-20):** PRs #6, #7 e #8 mergeados, CI/CD
  verde nos três jobs em cada um, revisão final `ba8cbf2a` no servidor,
  migration 0006 aplicada (versões 1–6, 6 tabelas `fundamental_*`) e
  `polymarket-estimator` ativado e reconstruído com
  `--profile polymarket up --build`. Quatro ciclos observados no universo cheio
  (100 mercados, 200 tokens): 130–158 linhas de consumidor e 25–26 shadow por
  ciclo, `token_failures: 0`, **zero erros e zero warnings** nos logs. No
  banco: 571 linhas `MARKET_BASELINE/active` todas com
  `fallback_reason = MODEL_IN_SHADOW`, 103 linhas `MODEL/shadow` todas com
  proveniência completa, e um único `git_sha` — `c055da33`, a revisão
  implantada. Estimador em 39 MiB de 384 MiB.
- **FATO VERIFICADO (estado final, 2026-08-20 05:31Z):** 3.892 linhas
  `MARKET_BASELINE/active` e 625 `MODEL/shadow` em
  `fundamental_estimates`; **zero** linhas `MODEL` sem proveniência completa,
  **zero** linhas de baseline sem motivo de fallback, **zero** modelos
  `active`. O carimbo de proveniência acompanha o código que roda, não o
  checkout: 577 linhas com `c055da33` (imagem anterior) e 48 com `ba8cbf2a`
  (imagem reconstruída), a transição exata do rebuild. Zero erros nos logs
  após a correção do registro benigno; sete containers rodando.
- **FATO VERIFICADO:** as ausências de estimativa em produção têm sempre motivo
  explícito (`BOOK_STALE`, `NO_BOOK`, `DEPTH_BELOW_SREF`, `SPREAD_TOO_WIDE`) —
  livro inválido produz ausência, nunca valor default.
- **FATO VERIFICADO:** os seis endpoints da RFC-010 respondem 401 sem token no
  container da API, mas **não estão publicados pelo Nginx**: o perímetro da
  RFC-002 (`location ^~ /api/ { return 404; }`) libera apenas health e auth.
  Isso já valia para os endpoints de leitura da RFC-007. Publicar essa
  superfície é **decisão de perímetro do proprietário** e não foi alterada.

## BLOQUEIO ATUAL DA RFC-010 — o gate ainda não tem como acumular evidência

- **FATO VERIFICADO (2026-08-21):** 52 mil+ estimativas gravadas, mas
  **0 linhas em `fundamental_labels`**. A causa era a montante:
  `polymarket_resolution_events` tinha **80 eventos `proposed` e nenhum
  `resolved`/`market_resolved`**, então não existia desfecho para rotular.
- **FATO VERIFICADO — furo operacional encontrado e corrigido:** o deploy do CD
  **não troca a imagem dos containers de profile**. Depois de mergear a RFC-010
  eu reconstruí só o `polymarket-estimator`; o `polymarket-recorder` continuou
  rodando a imagem antiga, **sem a captura de desfecho**
  (`grep -c outcomePrices` = 0 na imagem antiga, 2 na nova). Reconstruído em
  2026-08-20 com `--profile polymarket up --build polymarket-recorder`.
  **Lição: toda mudança em código do recorder exige rebuild explícito dele,
  mesmo que o CD tenha rodado verde.**
- **FATO VERIFICADO:** após o restart do recorder, `BOOK_DIVERGENCE` decaiu de
  42/min para 4, 12 e 0/min em três janelas de 1 min — é a rajada de
  re-subscribe (o livro recebido É o resync, comportamento da RFC-007), não uma
  regressão. Zero erros no recorder.
- **CAUSA RAIZ CONFIRMADA (2026-08-21) — eram DUAS causas somadas.** Corrigidas.

  1. **O poller UMA só consulta mercados no universo atual, e o mercado sai do
     universo antes de resolver.** Medido em produção: os **80** mercados com
     evento `proposed` **todos** já haviam saído do universo, em média
     **17,4 min depois** da proposta — muito antes de a liveness de ~2 h da UMA
     terminar. Ou seja, paramos de perguntar exatamente sobre o mercado que
     está prestes a resolver.
  2. **O `/markets` do Gamma filtra `closed=false` por padrão.** Verificado
     contra a API real: o mesmo `condition_id` devolve **0 resultados** sem
     filtro e o mercado resolvido **com** `&closed=true`
     (`umaResolutionStatus: resolved`, `outcomePrices: ["1","0"]`). Mesmo que
     continuássemos perguntando, a consulta padrão nunca enxergaria a
     resolução.

  **Correção (RFC-007, exigida pela tarefa 7 da RFC-010):** novo
  `pollPendingOnce()` no poller UMA, agendado a cada 10 min, que segue os
  mercados que saíram do universo e ainda não chegaram a estado terminal
  (janela de 7 dias, teto de 200 por varredura, ordenados por atividade mais
  recente) e consulta o Gamma **com os dois filtros** — aberto e
  `closed=true`. Coberto por teste.

- **FATO VERIFICADO (produção, 2026-08-22, após o deploy da correção):** a
  cadeia fechou de ponta a ponta. A primeira varredura pendente gravou **99
  eventos `resolved`** (antes: 0 em ~2 dias), todos com `outcomePrices` não
  nulo. O `syncLabels` seguinte produziu **204 labels em 102 mercados** — 102
  com label `0` e 102 com `1`, complementares como manda um mercado binário —,
  **todos finais, zero disputados, zero sem instante conhecível**. Disso saem
  **62.356 observações pontuáveis** (estimativa anterior ao instante em que o
  desfecho ficou público) em **39 mercados**, das quais 8.211 são linhas de
  modelo em shadow.
- **ESTADO DO GATE (2026-08-22):** dois relatórios gravados, ambos
  `NO_EVIDENCE_OF_ALPHA` com `NO_OBSERVATIONS` — eles rodaram às 01:27, **antes**
  de os labels existirem (02:27). Ambos os modelos seguem em `shadow`. O
  primeiro relatório com métricas reais sai na próxima execução diária. A
  cobertura hoje é **39 de 100 mercados** exigidos, só em `crypto_updown`;
  `macro_scheduled` continua em zero porque o modelo se abstém sem consenso.
- **FATO VERIFICADO:** o restante da cadeia já estava correto — a captura de
  desfecho grava `outcomePrices`/`outcomes` no payload (confirmado nos 80
  eventos `proposed` em produção) e `labels.ts` aceita `resolved`/
  `market_resolved` com desfecho. Faltava só observar a transição.
- **FRAGILIDADE CONHECIDA (RFC-007, não corrigida):** o sync do calendário
  macro roda **só no boot do recorder e não tem retry**. Em 2026-08-23 o
  postgres foi recriado 187 ms **depois** do recorder no `server-update`, então
  o sync pegou o banco subindo e registrou `MACRO_CALENDAR_SYNC_FAILED`. Sem
  perda nesta vez (arquivo e banco têm as mesmas 15 entradas), mas se o arquivo
  tivesse mudado a alteração seria silenciosamente perdida até o próximo
  restart. Correção natural: agendar o sync junto do job `macro_releases`
  (10 min) em vez de só no boot. Fora do escopo da RFC-010 — a categoria macro
  já está bloqueada por falta de consenso no calendário.
- **BLOQUEIO/TODO (RFC-007):** o caminho WS de resolução é **código morto** —
  `recordMarketResolved` existe em `samplers.ts` e **ninguém o chama**, e
  `market_resolved` não está no union `MarketMessage` nem em
  `parseMarketFrame`. Hoje a única fonte de resolução é o polling do Gamma.
  Não foi corrigido aqui: o polling resolve a necessidade da RFC-010 e mexer no
  parser do WS é escopo da RFC-007.

## RFC-010 — implementação (2026-08-20)

- **FATO VERIFICADO:** RFC-010 (modelo fundamental) implementada na branch
  `claude/rfc-010-estruturacao-producao-3b21cf`: migration 0006 (6 tabelas,
  com fronteira de regime, imutabilidade de versão e proveniência como
  constraints do banco), microprice executável em aritmética exata de ponto
  fixo, intervalo de incerteza versionado, fallback determinístico como função
  pura, camada de features as-of com guarda anti-leakage, modelos
  `crypto_updown` e `macro_scheduled`, label store, pipeline walk-forward com
  block bootstrap, gate `NO_EVIDENCE_OF_ALPHA`, relatório de calibração
  diário, 6 endpoints autenticados e o serviço Compose `polymarket-estimator`.
  `make verify` verde. Evidência:
  [`docs/test-results/RFC-010-fundamental-model.md`](test-results/RFC-010-fundamental-model.md).
- **FATO VERIFICADO:** o serviço foi exercitado em container real (projeto
  Compose isolado, PostgreSQL próprio): migration aplicada, boot registrando os
  dois modelos do catálogo em `shadow`, ciclo escrevendo linhas de baseline com
  proveniência completa, linhas `shadow` do modelo crypto com `git_sha` e
  `data_refs` reais, e livro velho produzindo ausência explícita
  (`absent_reasons.BOOK_STALE`), nunca valor default.
- **FATO VERIFICADO:** nenhum modelo nasce servindo. Os dois modelos do
  catálogo entram em `shadow`; o consumidor lê `MARKET_BASELINE` com motivo
  `MODEL_IN_SHADOW` até que um gate PASS seja registrado **e** o proprietário
  promova manualmente pelo endpoint.
- **FATO VERIFICADO:** correção adjacente necessária na RFC-007 —
  `createUmaStatusPoller` gravava o status da resolução mas não o desfecho.
  Passou a gravar `outcomePrices`/`outcomes` na timeline imutável; sem isso o
  label store não teria o que pontuar e nenhum gate poderia ter evidência.

## ESTADO DA EVIDÊNCIA E PRÓXIMO GARGALO (2026-08-23)

- **FATO VERIFICADO:** a cadeia de evidência está viva e crescendo. **358
  labels em 179 mercados** (eram 204/102 no dia anterior), **60 mercados
  pontuáveis**, e o primeiro gate com dados reais rodou (relatório #3,
  7.334 observações, `crypto_updown`).
- **FATO VERIFICADO — o gate contou 8 mercados, não 60.** A diferença **não** é
  degeneração de preço: é cobertura do modelo. Dos 80 mercados crypto com
  estimativa nas últimas 6 h, o modelo atende **7** e fica silencioso em **73**.
- **CAUSA VERIFICADA:** as perguntas que ele recusa são de **barreira**
  ("Will Bitcoin **reach** $82,500 in August?", "Will Ethereum **dip to**
  $1,250?"), enquanto as que ele atende são terminais ("Will the price of
  Bitcoin **be above** $68,000 on August 25?"). A recusa está **correta** — um
  mapa de distribuição terminal subestima sistematicamente um payoff que paga
  no caminho —, mas custa ~90% da cobertura. No ritmo atual, os 100 mercados do
  gate exigiriam ~660 mercados resolvidos.
- **DECISÃO DO PROPRIETÁRIO (2026-08-23):** desenvolver o fluxo inteiro
  primeiro e só depois incrementar. A variante de primeira passagem virou a
  **RFC-014** (`docs/rfcs/RFC-014-polymarket-first-passage.md`), em `draft`,
  não implementada.
- **CORRIGIDO (2026-08-23):** a calibração diária era zerada por todo deploy
  (`setInterval` de 24 h a partir do boot). Passou a ser medida contra o
  `generated_at` do último relatório gravado, com checagem a cada 10 min e uma
  no boot; `labels` também passou a rodar no boot em vez de esperar 1 h.
- **BLOQUEIO/TODO conhecido:** quando um modelo em `shadow` se abstém, **nada
  registra o porquê**. A linha do consumidor diz `MODEL_IN_SHADOW` (status de
  promoção), não o motivo da abstenção. Diagnosticar a cobertura exigiu quatro
  consultas ad-hoc em vez de um `grep`. Gravar o motivo da abstenção é pequeno
  e paga em toda investigação futura.

## DECISÃO DO PROPRIETÁRIO — RFC-011 aceita para implementação (2026-08-23)

**FATO INFORMADO:** o proprietário aprovou iniciar a RFC-011 (microestrutura e
paper broker) **antes** do gate PASS da RFC-010, revogando a nota anterior
deste handoff ("Só depois disso: RFC-011"). Coerente com a decisão de
2026-08-23 de desenvolver o fluxo inteiro primeiro e só depois incrementar.
A RFC-011 não exige modelo promovido (opera com ordens manuais/intents e o
baseline publicado); **a promoção de modelo continua exigindo gate PASS +
ação manual — isso não muda.**

**FATO INFORMADO — decisões de orçamento aprovadas junto com a aceitação:**

1. **RAM:** novo serviço Compose `polymarket-paper` com 256 MiB, com
   `model-worker` (stub sem modelo) cedendo memória para caber no cap de
   4 GiB do `check_compose_policy.py` (folga era de 128 MiB). **FATO
   VERIFICADO na implementação:** o corte do `model-worker` foi para
   **96 MiB**, não os 128 cogitados — o cap é estrito (`< 4 GiB`) e com 128
   o agregado cairia exatamente em 4 GiB; com 96 fica em 4064 MiB. Feito no
   PR de fundação da RFC-011, junto com o serviço novo.
2. **Disco:** dos ~1,3 GB restantes da reserva de 6 GB das RFCs 010–013
   (as `fundamental_*` já alocam 4,7 GB em `retention.ts`), sub-quotas:
   features em janelas 0,6 GB; markouts + calibração de P(fill) 0,4 GB;
   ledger + ordens paper 0,3 GB.

**FATO VERIFICADO (verificação de prontidão, 2026-08-23):** todos os insumos
de dados da RFC-011 existem e estão em produção (book L2 + replay
determinístico, fees/tick versionados as-of, resolução com `outcomePrices`
via polling Gamma, `q`/`q_lo` publicados, microprice executável compartilhado).
O registro completo — incluindo o que nasce `UNAVAILABLE` (direção de fluxo,
sem pipeline onchain) e os defaults conservadores (latência sem round-trip
medido) — está na seção "Estado verificado das dependências" da própria
RFC-011.

**FATO VERIFICADO — pré-trabalho obrigatório encontrado na verificação
(escopo RFC-007):** `parseLastTrade` em
`apps/api/src/polymarket/messages.ts` constrói o objeto com apenas 6 campos e
**descarta `size`, `fee_rate_bps` e `transaction_hash`** do frame cru do WS.
Em produção, `polymarket_trades` com `provenance='ws'` tem os três campos
NULL e o índice de dedupe WS (`WHERE transaction_hash IS NOT NULL`) nunca se
aplica. O teste existente passa porque monta a mensagem à mão com os campos.
Sem isso a fila passiva (C2) e a reconciliação de fee (C4) da RFC-011 não têm
insumo. Correção antes do corpo da RFC-011; deploy exige rebuild explícito do
recorder (o CD não troca imagem de profile).

## DECISÃO DO PROPRIETÁRIO — cadência por horizonte (2026-08-22)

**FATO INFORMADO:** o proprietário definiu a cadência de estimativa por
horizonte: **10 s na última hora, 60 s até 6h, 5 min até 24h, 10 min daí em
diante**, em vez da cadência plana de 60 s.

**FATO VERIFICADO (medição que motivou a decisão):** a distribuição das
586.878 linhas em produção era o oposto do intuitivo — os mercados de menos de
6h eram só **3,1%** do volume, enquanto **67% vinha de horizonte > 7 dias**
(116 mercados, tipo "ETH chega a $2.500 até 31/dez/2026"). Essas linhas
distantes pagavam dois terços do armazenamento e **nunca viravam evidência**,
porque são podadas meses antes de o mercado resolver.

**FATO VERIFICADO:** com a cadência por horizonte o volume cai de ~309 k para
~47 k linhas/dia (**6,6×**), a janela de 3 GB passa de ~5,5 dias para **mais de
um mês**, e a resolução temporal _aumenta_ na última hora — que é onde a RFC
espera que o modelo tenha alguma chance. Implementado como
`estimate_cadence_ms` por bucket, com o laço tiquetaqueando a 10 s e o trabalho
caro (janelas de feed) pulado quando nenhum token está vencido.

**FATO VERIFICADO (produção, 2026-08-23, após o rebuild):** ciclos a cada 10 s
com **2 tokens avaliados por tique** e 126 limitados, zero ausências, zero
erros. Taxa medida: **82 linhas em 5 min ⇒ ~23,6 mil linhas/dia ⇒ ~23 MB/dia**,
o que dá **~134 dias** dentro da quota de 3 GB. Melhor que a projeção de ~47 k
porque o universo hoje é de 64 mercados (128 tokens) e a maioria está em
buckets distantes; a taxa sobe quando muitos mercados se aproximam da resolução
ao mesmo tempo, e o teto continua sendo o que `budget.test.ts` modela sobre a
distribuição medida de horizontes.

**FATO VERIFICADO — desperdício encontrado e corrigido em produção:** minutos
depois de o laço de 10 s subir, 17 tokens com livro permanentemente inválido
estavam sendo reavaliados **a cada tique**, porque estimativa ausente não grava
linha (de propósito) e a cadência só olhava linhas gravadas. A cadência passou
a contar **avaliações**; `tokens_considered` caiu de 17 para 2 por tique.

**INVARIANTE:** uma estimativa precisa sobreviver `horizonte + ~27 h` para
virar evidência (resolução → liveness UMA ~2 h → sync de label ≤ 1 h → até 24 h
até a calibração diária). `budget.test.ts` segura esse piso; encurtar a janela
abaixo dele apagaria a evidência antes de ela ser pontuada.

- **DECISÃO RESOLVIDA (era pendente) — janela de retenção das estimativas:**
  volumetria medida em PostgreSQL real: **1.020 B por linha** (200 k linhas,
  após `VACUUM ANALYZE`). No teto da RFC (200 tokens × 1 linha/minuto), a
  superfície do consumidor são 288 k linhas/dia — **mais as linhas `shadow`**,
  uma por token por ciclo enquanto houver modelo em shadow, ou seja 576 k
  linhas/dia ≈ 588 MB/dia. A quota de 3 GB sustenta **~5,5 dias** (≈11 dias
  antes de qualquer modelo ser registrado), não os 90 dias do TTL — quota vence
  TTL na retenção, então o orçamento local é respeitado e o que encolhe é a
  janela. Para 90 dias reais dentro de 3 GB seria preciso cadência de ~20 min
  ou ~52 GB de quota. **Isso limita o gate**: acumular 100 mercados resolvidos
  exige que eles resolvam dentro da janela guardada. O código entrega o default
  da RFC (60 s); o botão está em `config/fundamental.json`.
- **RISCO ABERTO — cobertura macro é zero hoje:** `config/macro-calendar.json`
  não traz `consensus`/`nowcast` em nenhuma entrada, então o modelo
  `macro_scheduled` **abstém em todo mercado macro** e tudo fica no baseline.
  É o comportamento correto (não inventar consenso), mas a categoria só produz
  evidência depois que nowcasts (Cleveland Fed / CME FedWatch) entrarem no
  calendário. Não é bloqueio de código: `parseMacroCalendar` guarda a entrada
  inteira em `payload_json`, então basta acrescentar `consensus` (ou `nowcast`
  / `forecast`) e, opcionalmente, `consensus_std` às entradas de
  `config/macro-calendar.json` — os valores precisam vir de fonte oficial, não
  de estimativa nossa.
- ~~**BLOQUEIO/TODO:** não existe CLI nem endpoint que **registre** uma versão
  nova de modelo~~ — **FECHADO em 2026-09-02 (RFC-018 item 4):** `models-cli`
  (`node apps/api/dist/models-cli.js register|list|show`), fora do perímetro
  HTTP como o `gates-cli`, reusando `registerModel` e portanto com as mesmas
  garantias de imutabilidade por conteúdo. Documentado em
  [`docs/runbooks/polymarket-fundamental.md`](runbooks/polymarket-fundamental.md).

## Estado atual

- **FATO VERIFICADO:** runtime composto por PostgreSQL, market-engine Rust
  (fundação), API Fastify (auth + recorder Polymarket), web React/Vite, worker
  Python opcional e Nginx. Somente Nginx publica porta; desenvolvimento usa
  `127.0.0.1:8080`, standalone usa `0.0.0.0:80`.
- **FATO VERIFICADO (2026-08-20, por SSH):** o host de produção usa Ubuntu
  22.04 x86_64, usuário `root`, checkout em `/opt/ganso-market`, **Docker
  27.5.1 e Compose v2.32.4** — correção de um registro anterior deste handoff,
  que dizia 29.7.2/5.4.0 (esses são os números da máquina do proprietário, não
  os do servidor). Somente SSH e Nginx publicados; UFW inativo.
- **FATO VERIFICADO:** CI/CD ativo: todo push na `main` roda os gates e, se
  aprovados, atualiza o servidor pelo comando SSH forçado com validação de
  release e rollback. Incidentes de 2026-08-17/18 resolvidos: a reinstalação de
  SSH do servidor tinha removido a chave de deploy (restaurada) e uma cópia
  manual de código do Mac tinha deixado `/opt/ganso-market` com dono UID 501
  (restaurado com `chown -R root:root`). **Lição operacional: nunca copiar
  código manualmente para o servidor; o caminho é merge na `main` → CD.**
- **FATO VERIFICADO:** autenticação em produção desde 2026-08-18: firewall
  Hetzner restringe a porta 80 ao IP do operador (confirmado por sondas
  externas de três países — todas timeout), conta única `owner` criada por CLI
  e login validado pelo proprietário. Modelo 1 do runbook
  [`auth-perimeter.md`](runbooks/auth-perimeter.md); HTTP em claro é risco
  aceito com origem única.
- **FATO VERIFICADO:** recorder Polymarket ativo em produção desde 2026-08-18
  (profile `polymarket`), após correção do crash de `source_ts` (epoch-ms →
  `Date`, PR #2): container estável, 2.314+ snapshots em 24 tokens com
  `source_ts` preenchido e defasagem média ~3,2 s. O deploy (`server-update`)
  não remove o container do profile, mas não troca a imagem dele: após deploy
  que altere o recorder, rodar
  `docker compose --env-file deploy/server.env --profile polymarket up --build --detach polymarket-recorder`.
- **FATO VERIFICADO:** ainda NÃO existem: modelos/estratégias, paper broker,
  wallet, signer, ordens e execução ao vivo.

## RFC-007 IMPLEMENTADA E ATIVA EM PRODUÇÃO (2026-08-20)

- **FATO VERIFICADO (produção, 2026-08-20):** PR #5 mergeado, deploy pelo CD
  verde, migration 0005 aplicada (versões 1–5) e recorder V2 ativo no servidor
  com `--profile polymarket up --build`. Após 9 minutos: 111 mercados, 516k
  deltas L2, 90k trades, RTDS fluindo, container estável e **zero erros nos
  logs**. Gaps registrados: somente `trades_window_overflow` do backfill
  histórico (comportamento projetado — janelas de 1h com >10k trades na Data
  API; o WS cobre o fluxo ao vivo). Janela de 7 dias do critério de aceite
  iniciada em 2026-08-20.
- **FATO VERIFICADO:** RFC-007 (fundação de dados) implementada na branch
  `claude/rfc-007-data-foundation`: migration 0005 (17 tabelas), registry
  Gamma com universo crypto+macro e log de transições, regras/parâmetros
  versionados por hash com vigência, livro L2 completo (WS duplo com dedupe,
  deltas em lote, âncoras), trades (WS + backfill janelado), OI/holders, UMA
  status → eventos imutáveis, RTDS (TWAP Chainlink + Binance, frames oficiais,
  valores E18), calendário macro versionado + releases BLS, qualidade
  (gaps/reconciliação/replay determinístico), retenção (TTL+quotas, tabelas
  protegidas), API de leitura autenticada (11 endpoints) e orquestrador
  supervisionado. Revisão adversarial de 6 lentes: 24 achados confirmados,
  todos corrigidos com teste. `make verify` verde; 213 testes vitest.
  Evidência: [`docs/test-results/RFC-007-data-foundation.md`](test-results/RFC-007-data-foundation.md).
- **FATO VERIFICADO:** smoke ao vivo isolado no Mac contra as APIs reais:
  janela final de ~7 min sob carga plena com zero erros e zero gaps não
  registrados (95 mercados, 748k deltas L2, 264k trades, RTDS ativo).
- **DECISÃO PENDENTE (proprietário):** no ritmo medido, deltas L2 ≈ 29 GB/dia;
  a quota de 12 GB governa → janela efetiva de L2 ≈ meio dia. Reduzir séries
  curtas do universo ou rebalancear quotas fica para depois da observação em
  produção.
- **FATO VERIFICADO (2026-08-20):** a rede do macOS caiu após sleep (errno 49
  até em loopback) e o reboot que a restaurou limpou o `/private/tmp`, levando
  o clone de trabalho com os commits locais. O código foi reconstruído por
  replay determinístico dos transcripts dos agentes (`~/.claude`, que sobrevive
  a reboot) num worktree durável, e revalidado pela própria suíte antes do
  push. Lição operacional: workspace de implementação nunca em diretório
  temporário; commit cedo, push cedo.

## Sequência de RFCs

| RFC                                                   | Estado de acompanhamento                                                                               | Evidência/condição                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| RFC-001 — Fundação e runtime                          | Implementada                                                                                           | [`docs/test-results/RFC-001.md`](test-results/RFC-001.md)                                                         |
| RFC-002 — Auth e HTTP                                 | Implementada e publicada com perímetro (2026-08-18)                                                    | [`docs/test-results/RFC-002.md`](test-results/RFC-002.md)                                                         |
| RFC-007 — Polymarket: fundação de dados e recorder V2 | Implementada (2026-08-20); aguardando merge/deploy; recorder básico ativo em produção desde 2026-08-18 | [`docs/test-results/RFC-007-recorder.md`](test-results/RFC-007-recorder.md); expansão de coleta é o próximo passo |
| RFC-010 — Modelo fundamental (`q` + incerteza)        | Implementada e ativa em produção (2026-08-20); modelos em `shadow`, nenhum promovido                   | [`docs/test-results/RFC-010-fundamental-model.md`](test-results/RFC-010-fundamental-model.md)                     |
| RFC-011 — Microestrutura e paper broker               | Código completo (2026-08-24); container ativo em produção, nenhuma ordem paper criada ainda            | [`docs/test-results/RFC-011-microstructure-paper.md`](test-results/RFC-011-microstructure-paper.md)               |
| RFC-012 — Risco de resolução e grafo lógico           | **Ativa em produção (2026-08-26 01:15Z)**, `score_version` 1.1.1; 220 mercados pontuados, todos `NONE` | [`docs/test-results/RFC-012-resolution-graph.md`](test-results/RFC-012-resolution-graph.md)                       |
| RFC-013 — Motor de portfólio e gates                  | **Ativa em produção** desde 2026-08-26 19:53Z (fases A–E, config **1.2.0**)                            | Gates G1–G6 habilitam a RFC-009; todos medidos e nenhum `PASS` — correto hoje. Quatro degenerações fechadas       |
| RFC-009 — Execução Polymarket maker-side              | Não iniciada; exige gates G1–G6 da RFC-013 + aprovação explícita                                       | Burn wallet Polygon; risco jurisdicional aceito                                                                   |

As RFCs do caminho Solana foram removidas em 2026-08-18 (ver decisão acima).

## DECISÃO DO PROPRIETÁRIO — o kill switch ganha botão no painel (2026-08-27)

**FATO INFORMADO:** o proprietário pediu que o rearme do kill switch do paper
broker fosse possível pela interface web, em vez de exigir acesso ao servidor.

**FATO VERIFICADO — por que o pedido apareceu.** O switch estava **engatado desde
2026-08-26 05:28:48Z** com motivo `RECORDER_STALE` e nunca havia sido rearmado —
35 h de broker parado que ninguém tinha como ver sem entrar no servidor. Quem
encontrou foi a ponte, no primeiro trabalho real dela: `BRIDGE_DECISION_SKIPPED`
com `reason: "KILL_SWITCH_ENGAGED"`. Enquanto ele estivesse de pé, **nenhuma
ordem de paper era aceita de fonte nenhuma**, e o G2 não acumulava uma única
posição fechada. Rearmado às 20:48:54Z pelo caminho de código real
(`rearmKillSwitch`), com o evento `kill_switch_rearmed` no ledger e o
`engaged_at` preservado — o G3 continua enxergando que o switch foi exercitado.

**O que o botão é, e o que ele deliberadamente não é:**

- **Uma única superfície nova no perímetro**, e é a primeira escrita que ele
  publica: `POST /api/polymarket/paper/kill-switch/rearm`, como `location =`
  (caminho exato) e não como prefixo. `^~ /api/polymarket/paper` publicaria
  também o `POST .../intents`, que **cria ordens** — a superfície que nunca pode
  ser alcançável de fora. Tem limitador de taxa em zona própria, para um burst
  no rearme não consumir o orçamento do login.
- **Sem GET novo.** O estado do switch já viaja no
  `GET /api/polymarket/resolution-risk/pipeline`, que o painel já lê e já
  desenha. Um segundo endpoint para o mesmo fato seria mais uma coisa para
  manter de acordo com a primeira.
- **Sem botão de engatar.** O switch tem gatilhos automáticos (recorder parado,
  perda diária), então parar nunca espera por humano. Uma parada manual continua
  sendo ação de dentro do servidor, e o `halt`/`resume` da RFC-013 continuam
  fechados.
- **Sem botão quando o estado é desconhecido.** Enquanto a leitura do pipeline
  não chega, não há de que rearmar: oferecer a ação assim mesmo seria controle
  cego. E o parser recusa qualquer `engaged` que não seja booleano — um payload
  quebrado não pode ser lido como "o broker está rodando".
- **Dois cliques, nunca um.** O primeiro só revela o que a ação faz. O motivo e o
  instante do engate ficam na tela durante a confirmação, para a decisão ser
  tomada contra a evidência e não de memória.

**FATO VERIFICADO (produção, 2026-08-27 21:1xZ, revisão `578197aa`):** o botão
está no ar e o perímetro se comporta como projetado. Medido de dentro do
servidor, sem token:

| Requisição                                     | Resposta                            |
| ---------------------------------------------- | ----------------------------------- |
| `POST /api/polymarket/paper/kill-switch/rearm` | **401** — publicado, exige sessão   |
| `GET` no mesmo caminho                         | **404** — método fixado             |
| `POST /api/polymarket/paper/intents`           | **404** — cria ordens, fica fechado |

Foram só dois passos (merge + CD): `web` e `nginx` são serviços default. O botão
só aparece com o switch engatado — hoje ele está armado, então o card mostra
"Armado / Rearmado há…".

**Estado da ponte depois do rearme:** nenhuma ordem ainda, e o motivo não é a
ponte. A última entrada **aceita** foi às 18:17:12Z; das 18:17 às 21:15 o motor
não aceitou nenhuma (`aged_out` parado em 45, `considered: 0` em todo tick).
Ou seja: o gargalo saiu do kill switch e voltou para onde a RFC-013 sempre disse
que estaria — `entrable: 0` sem modelo promovido na RFC-010. A ponte está armada
e sem trabalho, que é diferente de estar quebrada.

**Teste de regressão do perímetro:** `scripts/tests/test_nginx_perimeter.py`
falha se alguém trocar o `location =` por um prefixo, se o método deixar de ser
fixado, se o limitador sumir, ou se qualquer caminho da RFC-012/013 deixar de ser
GET-only. O buraco não é o risco — o risco é ele alargar por acidente, num diff
que pareceria uma mudança de um caractere.

## Decisões e invariantes vigentes

1. `ExecutionMode` aceita exclusivamente `paper` no runtime atual (o caminho
   `live` só é introduzido pela RFC-009, gated e desarmado por padrão).
2. Estratégia nunca acessa signer; nesta etapa sequer existe signer.
3. Secrets entram por arquivo montado. Private key e seed nunca usam env,
   Git, banco, logs, fixtures ou frontend.
4. Configuração falha fechada para modo/campo/arquivo desconhecido ou inválido.
5. Readiness depende de `SELECT 1`; liveness não mascara dependência ausente.
6. Money usa inteiro matemático exato: string decimal canônica na fronteira
   JSON e `bigint` internamente.
7. Logs de aplicação/access são JSON, têm correlation ID quando aplicável e
   não registram query string recebida.
8. `make down` e o smoke não removem volumes por padrão.
9. A fundação standalone pode publicar somente Nginx em IPv4/TCP 80; nenhum
   serviço interno ganha porta no host.

## Decisões pendentes e riscos residuais

- **RISCO:** não há TTL/retenção nas tabelas Polymarket; `polymarket_book_snapshots`
  cresce ~200 mil linhas/dia. Coberto pela RFC-007 reescrita (implementar).
- **RISCO:** não há backup externo automático, HA ou recuperação garantida do
  PostgreSQL. **Reafirmado pelo proprietário em 2026-08-28: a proposta de
  backup mínimo foi recusada e o risco permanece aceito como está.**
- **RISCO:** `ServiceHealth` é reproduzido manualmente entre linguagens; os
  schemas v1 são normativos, mas existe risco futuro de drift.
- **RISCO:** o market-engine não possui `healthcheck` declarativo no Compose;
  `make server-health` cobre sua readiness pela rede interna.
- **RISCO:** a chave de CD é equivalente a uma credencial `root`, apesar do
  comando SSH forçado.
- **RISCO:** o rollback automático restaura código e containers, mas não desfaz
  migrations; mudanças futuras de banco devem ser retrocompatíveis.
- **BLOQUEIO (RFC-009):** parecer jurídico/tributário e provisionamento da burn
  wallet na Polygon antes de qualquer execução real na Polymarket.

## DECISÃO DO PROPRIETÁRIO — RFC-012 aceita para implementação (2026-08-24)

**FATO INFORMADO:** o proprietário aprovou a RFC-012 (risco de resolução e
grafo lógico) com as seguintes decisões, registradas também na própria RFC:

1. **Disco:** a quota de `fundamental_estimates` cai de 3,0 → 2,0 GB (janela
   medida continua ~87 dias a ~23 MB/dia), liberando **1,0 GB** para a
   RFC-012 (scores 0,4 / grafo+violações 0,3 / timeline de disputas 0,2 /
   relatórios 0,1). Mudança de `retention.ts` acontece no PR de fundação da
   RFC-012.
2. **RAM:** novo container `polymarket-resolution` com 192 MiB, financiado
   pela redução do estimador de 384 → 192 MiB (uso medido: 39 MiB).
3. **Coletor onchain em duas fases:** v1 do score usa a timeline Gamma já
   gravada; eventos onchain do UMA Adapter via `eth_getLogs` em RPC público
   da Polygon (sem dependência nova) como parte 2, com verificação de
   ABI/endereço contra a doc atual no início do desenvolvimento.
4. **Circuit breaker em camadas:** o estado da RFC-012 é a fonte autoritativa
   consultada pelo paper broker; o gatilho de disputa da RFC-011 permanece
   como redundância independente e **toda divergência entre as camadas é
   logada e exposta como métrica** — o proprietário quer a comparação para
   decisão, não a eliminação de uma das camadas.
5. **Enforcement imediato:** os vetos ganham dentes já na RFC-012 — intents
   sob `VETO`/`CIRCUIT_BREAKER` recusados; ordem manual sob `VETO` só com
   `override_veto` auditado no ledger.
6. **Dashboard visual (FATO INFORMADO, com implicação de perímetro):** o
   proprietário quer operar por interface gráfica — página no web app com
   score/decomposição, ações, disputas, violações, vetos, divergências e o
   estado do pipeline paper. Isso implica **publicar os endpoints read-only
   pelo Nginx** (hoje `location ^~ /api/` devolve 404), mantendo a auth de
   sessão da RFC-002 e o firewall Hetzner que restringe a porta 80 ao IP do
   operador. Nenhum endpoint de escrita novo é publicado.

**FATO VERIFICADO (prontidão):** todos os insumos Gamma existem e estão em
produção (timeline UMA com `outcomePrices`, regras versionadas com
`rule_change`, campos UMA em `rule_versions`, grupos negRisk, holders,
placeholders de augmented negRisk já filtrados no registry); zero
infraestrutura onchain existe (escopo da própria RFC); migration `0010`
livre. Registro completo na seção "Estado verificado das dependências" da
RFC-012.

## RFC-012 — FASES A–D + HARDENING FINAL VERIFICADOS (2026-08-24)

**FATO VERIFICADO:** as 18 tarefas da RFC-012 foram implementadas nas quatro
fases do plano de PRs (A: migration 0010 + retenção + score `R` + léxico;
B: grafo + bandas de custo + violações; C: enforcement + onchain fase 2 +
API; D: dashboard + Nginx), na branch `claude/rfc-012-execucao-c254e1`.
O hardening pós-revisão foi verificado por `make verify`, suíte API integral
serial em PostgreSQL real (**79/79 arquivos, 1.041/1.041 testes**), recorte PG
de resolução/versionamento (**23/23**) e `make integration` em Compose
isolado. Migrations 0001–0012 foram aplicadas em PostgreSQL 18.4 descartável
pelo protocolo do `apply.sh`; a 0010 permaneceu inalterada e as garantias
novas foram introduzidas de forma aditiva nas 0011–0012. Revisão, merge e
ativação em produção continuam pendentes.
Evidência completa:
[`docs/test-results/RFC-012-resolution-graph.md`](test-results/RFC-012-resolution-graph.md).

- **Score `R`**: composição monotônica de 8 features normalizadas (léxico de
  rule-precision determinístico versionado, prior de disputa
  externo→medido com limiar de 200 resoluções, clarificações
  material/cosmética, sensibilidade UMA por bond/liveness, delta
  endDate/umaEndDate, concentração de holders, P(50/50) estrutural — zero em
  negRisk —, prêmio de adjudicação na janela de settlement). Pesos/léxico
  hasheados em `resolution_score_versions`; o boot RECUSA reutilizar um
  nome de versão com conteúdo diferente (verificado em runtime real).
- **Ações**: disputa ativa ⇒ CIRCUIT_BREAKER (grupo herda o pior estado do
  evento negRisk); salto de preço sem catalisador ⇒ CB em modo suspeita;
  flag dura (fonte subjetiva, clarificação <24h, título≠regra) ou R ≥ 0,7 ⇒
  VETO; banda média ⇒ `resolution_buffer` (base + hurdle de capital pelo
  lockup esperado + cauda 50/50 avaliada no preço da decisão). Mercado
  terminal é carregado pelo ID mesmo fora do universo e só libera sua ação e
  a do grupo após `settle + recomputação`, evitando CB/VETO residual.
- **Enforcement (tarefa 17) com dentes**: `POST /polymarket/paper/intents`
  recusa sob VETO/CB/veto de sanidade com justificativa e devolve
  `resolution_buffer` no aceite; ordem manual recusada sob CB e, sob VETO,
  aceita só com `override_veto` auditado no payload de `order_accepted` do
  ledger. Para ordens já abertas sob CB, o restante só executa se for
  reduce-only contra a posição assinada reconstruída do ledger (`long`: SELL;
  `short`: BUY). `FAK` maior que a capacidade preenche somente até zero e
  cancela o restante; `FOK` e ordens passivas que cruzariam zero são
  canceladas sem fill. Lado expansivo, posição zero e restante inválido
  também são cancelados com evento auditável. Leitura indisponível do estado
  autoritativo ou da posição cancela as ordens afetadas, sem fill. Intent sem
  estado de resolução também falha fechado (`RESOLUTION_STATE_MISSING`).
- **Atomicidade e ordem de locks**: aceite + ledger, kill switch, settlement,
  release terminal e fills passivos foram fechados em transações com ordem de
  locks determinística e rechecagens finais. O journal autoritativo impede
  TOCTOU entre resolução, política e execução paper; settlement não permite
  fill posterior e replay de fill já persistido não reaplica risco mutável.
- **Runtime durável**: migration 0011 adiciona journal de seis fontes,
  geração/lease, cursor, watermarks e validade do grafo. O pipeline inteiro é
  serializado por uma mutex e só publica uma geração pronta após recompute →
  build → evaluate → sanity na mesma transação lógica; heartbeat não renova
  freshness e mutação curada invalida readiness atomicamente.
- **Metadados as-of**: migration 0012 preserva o histórico dos outcomes e o
  token afirmativo. Só mercados exatamente binários com um único `Yes`/`Up`
  são mapeados; payload ambíguo, multivalorado ou legado falha fechado. O
  versionamento usa advisory locks e conflitos stale, exercitados com conexões
  PostgreSQL concorrentes.
- **Grafo**: NEGRISK estrutural por evento Gamma; LADDER por extração
  determinística de título (família de limiar e de data — esta só para
  payoffs de barreira); arestas curadas por arquivo versionado
  (`config/graph-edges.json`) e por `POST /polymarket/graph/edges` (autor +
  justificativa obrigatórios). Avaliação a cada 1 min com preços executáveis
  em bigint (nunca midpoint), banda = fees taker por perna + ε (o spread já
  está pago nas pernas bid/ask), violação só após k=3 avaliações
  consecutivas, tamanho executável por book-walk sobre a profundidade
  gravada, supressão de sinal em nós sob VETO/CB.
- **Divergência de camadas (decisão 4)**: comparação periódica entre o CB
  desta RFC e o `frozen_markets` da RFC-011, registrada nas DUAS direções em
  `resolution_layer_divergences` e exposta na API e no painel.
- **Onchain (fase 2) — verificação de ABI/endereço feita no início, como a
  RFC exige, com achado material:** a ABI dos eventos foi confirmada no
  repositório oficial (v2.0.0 e main idênticos nos eventos de ciclo de
  vida), mas o adapter nomeado na RFC (`0x6A9D…4F74`, V2) está **dormente** —
  sondagem ao vivo na Polygon achou zero logs em ~2 dias. Os resolvedores
  reais de hoje, obtidos do `resolvedBy` do Gamma e confirmados emitindo
  exatamente os topic0 verificados (7,3k logs/10k blocos), são
  `0x65070be9…` (binários) e `0x69c47de9…` (negRisk). Os quatro endereços
  estão na config. O coletor usa `eth_getLogs` com fetch nativo (keccak-256
  próprio com dupla implementação verificada por vetores), chunks de 2k
  blocos (RPCs públicos limitam 10k), cursor por adapter e **filtro de
  orçamento**: só eventos de `questionID` de mercados já registrados são
  gravados (medição ao vivo: o fluxo global é de milhares de logs/dia, que
  estourariam a quota de 0,09 GB). O `questionID` passou a ser capturado
  pelo registry (coluna nova em `polymarket_markets`, backfill conforme o
  Gamma re-observa cada mercado; exige rebuild do recorder).
- **Relatório próprio**: taxa de disputa por categoria com IC de Wilson,
  distribuição P1–P4, frequência de 50/50, lockup observado e o backtest do
  veto (tarefa 10: cobertura de disputados e falso-positivo em limpos,
  incluindo resolvidos fora do universo e re-pontuando 1 min antes da
  proposta). O replay usa somente buckets de 1 min totalmente fechados e o
  prior medido disponível naquele instante histórico, nunca estatísticas do
  relatório; diário com due-check contra o último relatório gravado.
- **Dashboard (tarefa 18)**: aba "Resolução" no web app atrás do login
  (score com decomposição, ações e justificativas, disputas, violações,
  vetos, divergências, pipeline paper, relatório); Nginx publica **somente
  GET** de `/api/polymarket/resolution-risk*` e `/api/polymarket/graph*` —
  o `POST /graph/edges` e todo o resto de `/api/*` continuam fechados no
  perímetro.
- **Orçamento e retenção**: 1,0 GB de PG (0,4 scores / 0,3 grafo / 0,2
  timeline / 0,1 relatórios), `fundamental_estimates` 3→2 GB e container
  `polymarket-resolution` 192 MiB financiado pelo estimador (384→192;
  `--max-old-space-size` 320→160); agregado do Compose em 4064 MiB (< 4 GiB
  estrito, verificado pelo policy check). A série `resolution_scores` usa
  180 dias/0,35 GB e pode ser podada por `DELETE`; `UPDATE` continua proibido,
  enquanto versões/configuração permanecem imutáveis. O replay exato fica
  limitado à janela em que os inputs as-of estão retidos; depois dela, a
  trilha paper continua auditável sem prometer consulta ao score bruto podado.
  O pruning por `DELETE`, com `UPDATE` ainda proibido, foi exercitado no gate
  final.

## RFC-011 — CÓDIGO COMPLETO (2026-08-24)

**FATO VERIFICADO:** as 10 tarefas da RFC-011 foram implementadas e mergeadas
na `main` em seis PRs com CI verde (#18 pré-trabalho + aceitação, #19
fundação, #20 Parte A features, #21 Parte B validador/política, #22 Partes
C/D broker/ledger/kill switch, #23 calibração/relatório/intents). `make
verify` verde no estado final: 642 testes na API (127 do módulo paper),
migrations 0001–0009 validadas contra PostgreSQL real com constraints e
trigger de imutabilidade exercitados. Evidência completa:
[`docs/test-results/RFC-011-microstructure-paper.md`](test-results/RFC-011-microstructure-paper.md).

- O ledger canônico É a coluna base conservadora (degradação determinística
  de 30% aplicada no fill); a coluna otimista é diagnóstica e proibida em
  gates; a de estresse aplica 5¢/share taker.
- A feature de direção de fluxo nasce `UNAVAILABLE` (CHECK no banco) até o
  pipeline onchain `OrderFilled` existir (fase 2 da RFC-007).
- O guard de escopo do módulo (clone do da RFC-010 + padrões EIP-712) roda em
  todo `make verify`; documento em
  [`docs/architecture/paper-broker-scope.md`](architecture/paper-broker-scope.md).

## SESSÃO 2026-08-26 — RFC-012 ATIVADA, RFC-013 FASES A–E

**FATO VERIFICADO:** dez PRs mergeados nesta sessão (#26–#36), todos com CI
verde nos três jobs. Release em produção: `9da1215`. Migrations em **14**.

### A retenção nunca tinha funcionado — cinco causas somadas

`polymarket_retention_log` tinha **uma única linha em toda a vida do projeto**.
O banco chegou a **105 GB** contra um orçamento de 40 GB, com
`polymarket_book_deltas` em **76 → 90 GB** contra uma quota de 12 GB, crescendo
**~15,3 GB/dia** sobre 198 tokens. Restavam ~12 dias de disco.

| #   | Causa (todas medidas em produção)                                                                                                                                             | Corrigida em                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | Nenhuma tabela grande tinha índice na coluna de tempo da poda — só compostos liderados por `token_id`. O probe de corte planejava `Sort` sobre 232 M linhas.                  | #26 (migration 0013, 19 índices)               |
| 2   | `setInterval` de 24 h **sem execução no boot**; o recorder reinicia mais que uma vez por dia, então o timer nunca vencia.                                                     | #26 (`createJobScheduler` + `runAtBoot`)       |
| 3   | Quota comparada com `pg_total_relation_size`, que não encolhe com `DELETE`. Bug destrutivo: apagaria outros 28 GB de linhas **vivas** a cada execução, até esvaziar a tabela. | #26 (quota em bytes vivos)                     |
| 4   | Precondição de cobertura de agregados em query única: scan de 262 M linhas, estourava o `statement_timeout` de 30 s e **abortava o passo de quota em toda execução**.         | #27 (checagem por token, index-only scan)      |
| 5   | Probe exato de corte por `OFFSET`: **42,7 s medidos** contra timeout de 30 s.                                                                                                 | #28 (corte interpolado, fração limitada a 0,9) |

Mais dois refinamentos sobre o mesmo caminho: a checagem por token passou a ser
**fatiada em janelas de 12 h** (#32), porque seu custo cresce com a faixa — 14,3 s
no token mais pesado a 2 dias de corte, acima de 30 s a ~3,5 dias; e o `DELETE`
entrou na **guarda por fatia** com lotes de 5 000 em vez de 50 000 (#35), porque
um lote grande num token pesado estourava o timeout (três índices a manter, um
deles com **39 GB**) e a exceção escapava abortando a tabela inteira.

Também foi corrigido um comportamento que travava a poda para sempre: um buraco
de um minuto nos agregados — que **todo restart do recorder produz** — congelava
aquele token permanentemente na checagem tudo-ou-nada. Agora o buraco apenas
**trunca** a poda e é reportado como `SERIES_COVERAGE_MISSING`.

**EMENDA DE ORÇAMENTO (decisão do proprietário, 2026-08-25):** global
40 → **110 GB**; `book_deltas` 12 → 60 → **52 GB**; book top-10 4 → **8 GB**;
agregados 1 min 3 → **10 GB** (sem isso o gate G2 da RFC-013 seria immensurável,
que é condição de parada da própria RFC); reserva das RFC-010..013 6 → **8 GB**,
financiada pelo corte dos deltas. Total declarado: **89 GB**. Registro na seção
"Orçamento" da RFC-007.

### RFC-012: dois bloqueadores permanentes de ativação

**FATO VERIFICADO:** a RFC-012 estava mergeada (PR #25) mas **inativa**: os
containers de profile rodavam imagem pré-RFC-012 e o `polymarket-resolution`
nunca havia subido. O passo (2a) do handoff anterior nunca foi executado.

1. **Token afirmativo inalcançável.** A migration 0012 é prospectiva e o
   registry só re-observa o universo ATUAL — mas o serviço de resolução pontua
   o universo **mais** os mercados que saíram sem resolver nos últimos 7 dias, e
   falha fechado sem o mapeamento. Medido: **100 de 100** mercados do universo
   mapeados, **99 de 99** recém-saídos sem mapeamento. Como todo mercado que sai
   sem resolver entra nessa janela, esperar **nunca converge** — seria
   crash-loop permanente, não transitório. Corrigido em #27: a varredura de
   pendentes da RFC-010 já busca esses mercados no Gamma e o mesmo payload
   carrega `outcomes`/`clobTokenIds`, então ela passou a persistir a observação
   de metadados. Convergiu de 99/99 para **0 de 195**.

2. **`TITLE_RULE_MISMATCH` vetando 67% do universo.** Primeira execução com o
   universo real: **130 de 195 mercados sob VETO**, todos pelo mesmo flag duro,
   com score máximo de **0,318** — muito abaixo do limiar de veto por score de
   0,7. Causa: o template padrão da Polymarket **remete ao título** (_"the price
   specified in the title"_) em vez de repetir os valores, então o check
   comparava `{1.90, 28, agosto}` do título contra `{1, 12}` da regra — números
   vindos de _"1 minute candle"_ e _"12:00"_. O check media a maquinaria da
   própria regra. Corrigido em #29 (`titleDeferralTerms` no léxico, guarda
   estreita: regra que nomeia valores próprios divergentes continua sendo
   flagada). Resultado: **0 de 199 sob VETO**.

### RFC-012 ATIVA EM PRODUÇÃO (2026-08-26 01:15Z)

```
SCORES_RECOMPUTED  trigger=boot  scored=195  failed=0
GRAPH_BUILT        nodes=93  structural=257 (254 LADDER + 3 NEGRISK)
RESOLUTION_BOOT    score_version=1.1.1  onchain_enabled=true
```

`polymarket-resolution` em **43,6 MiB de 192 MiB**. Estado atual: **220
mercados, todos `NONE`**.

**Janela de ordem de deploy que queimou uma versão de score.** `config/` é
montado por bind e chega com o CD; o léxico que ele **nomeia** vive na imagem e
só muda no rebuild de profile. Na janela entre as duas coisas o binário ANTIGO
leu `score_version: 1.1.0` e gravou uma linha em `resolution_score_versions`
fixando esse nome ao hash do léxico ANTERIOR. A imagem nova então divergiu e o
serviço entrou em crash-loop com `SCORE_VERSION_CONTENT_MISMATCH` — fail-closed
correto, e a linha é imutável por trigger, também corretamente. **O nome 1.1.0
está queimado permanentemente**; a saída foi cunhar **1.1.1** (#31).
Procedimento de prevenção documentado em
[`docs/runbooks/single-server.md`](runbooks/single-server.md): quando um PR
mudar ao mesmo tempo um arquivo de `config/` e o conteúdo que ele nomeia, o
rebuild dos containers de profile tem que acontecer na mesma janela do merge.

### RFC-013 — fases A a E

| Fase | PR  | Conteúdo                                                                                                                                                                                                                                                                                    | Estado                                                 |
| ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| A    | #30 | Migration 0014 (12 tabelas), config versionada com hash, EV por share, sizing Kelly, máquina de estados, mapa de fatores, guard de escopo, documento de ausência de execução real e de stop-loss                                                                                            | migration **aplicada** (schema_versions = 14)          |
| B    | #33 | Exposições em 8 dimensões, 7 critérios de saída, motor de decisão, painel de 14 campos, store, runner, serviço `polymarket-portfolio`                                                                                                                                                       | mergeada, **serviço não criado no servidor**           |
| C    | #34 | Gates G1–G6, block-bootstrap reproduzível                                                                                                                                                                                                                                                   | mergeada                                               |
| D    | #36 | API (9 endpoints), perímetro Nginx GET-only, aba "Portfólio" no painel                                                                                                                                                                                                                      | mergeada, **Nginx não recarregado com as rotas novas** |
| E    | —   | Medição contínua dos gates (tarefa 8) + relógio G2 por categoria, ciclo de saída sobre posições abertas (tarefa 5 no runner), replay determinístico do decision log (tarefa 7), circuit breakers (tarefa 4), PnL realizado do ledger, campos 9/10/12 do painel, espaço de consulta paginado | **aberta nesta sessão**; migration 0014 intocada       |

**199 → 290 testes** no módulo `portfolio` (mais 19 só-PostgreSQL).

Decisões de implementação registradas:

1. **Dupla contagem de custo de capital.** A RFC-013 soma `custo_capital` ao
   `buffer_resolucao` da RFC-012, mas o `bufferBase` implementado na RFC-012 já
   cobra `capitalDailyHurdle × lockupDays`. Somar cobraria o mesmo lockup duas
   vezes; o módulo cobra apenas o **excedente**, então o total fica em `max(os
dois)` — nunca na soma e nunca abaixo de qualquer um deles.
2. **Assimetria de lado no limite inferior.** Para NO o limite conservador é
   `1 − q_hi`, não `1 − q_lo`. Trocar de lado troca qual ponta do intervalo é a
   pessimista; usar a errada seria o limite otimista vestindo o nome do inferior.
3. **Banca nocional.** Os caps da RFC são percentuais da banca, que não existia
   em lugar nenhum do projeto. `bankrollUsd` (default **$1.000**) entrou na
   config versionada, documentado como nocional de simulação.
4. **Fonte de resolução pelo oráculo.** A RFC capeia por
   `resolutionSource`/oráculo, mas o Gamma popula `resolutionSource` em **2 de
   98** mercados elegíveis. Uso `COALESCE(resolution_source, resolved_by)`.
   Consequência a calibrar: **460 de 570** rule versions resolvem pelo mesmo
   adapter UMA, então o cap de 25% por fonte efetivamente capeia o livro inteiro
   em 25% da banca. É o parâmetro fazendo o que sua justificativa diz
   ("cláusulas fallback idênticas em massa = risco correlacionado"), mas é
   **decisão pendente do proprietário** — afrouxar em silêncio seria a direção
   proibida.
5. **Configs completas.** `config/portfolio.json` e `config/factor-map.json`
   declaram **cada** valor em vez de depender de defaults do código, para que o
   hash seja propriedade do arquivo e a janela de ordem de deploy não possa
   queimar um nome de versão como aconteceu com o `score_version`. Há teste que
   falha se um arquivo ficar incompleto.
6. **RAM do novo serviço.** `polymarket-portfolio` com 192 MiB, financiado
   reduzindo o recorder de 1024 → **832 MiB** (medido em produção: 230 MiB com
   o universo cheio, 3,6× de folga restante). O agregado do Compose fica
   exatamente onde estava: 4 261 412 864 bytes.

### RFC-013 fase E — o que foi fechado nesta sessão

**Tarefa 8 (medição contínua).** Job `gates` a cada 1 h e no boot: mede G1–G6
sobre evidência gravada, grava uma linha imutável por gate em
`portfolio_gate_measurements`, mantém o relógio G2 **por categoria** com
fingerprint de regime, e audita o replay das 50 decisões mais novas no mesmo
ciclo. Por decisão do proprietário o relatório semanal foi substituído por um
**espaço de consulta paginado** (`GET /polymarket/gates/measurements`, aba
"Consulta" no painel) — paginação por cursor, não por `OFFSET`, porque a tabela
nunca é podada e só cresce.

**Tarefa 5 no runner (saídas em shadow).** Job `exits` a cada 30 s sobre
posições abertas. Grava `EXIT` no decision log **quando o veredito muda** — um
hold é registrado (é evidência de que o motor olhou), mas não reescrito a cada
30 s. O preço de saída é book-walk sobre a posição **inteira**, não o melhor bid.

**Tarefa 7 (replay determinístico).** `inputs_json.replay` guarda todo escalar
que o motor leu, em **nove** dígitos e não nos seis das colunas. Um único
construtor de linha (`decisionrow.ts`) serve runner e replay, então o teste
compara o motor e não dois mapeamentos. O replay lê só o decision log e
`portfolio_config_versions` — nunca book snapshots, estimativas ou estado de
resolução.

**Três lacunas que eram pré-requisito.** Os 5 circuit breakers da tarefa 4
nunca abriam (`breakerOpen: false` fixo), o PnL realizado era `0n` fixo (a
máquina de estados era inerte) e `takerFeeRate`/`rulePrecisionMultiplier` eram
fixos com os campos 9/10/12 do painel nulos. Todos fiados.

**Bug encontrado e corrigido durante os testes.** O critério 6 de saída
(capital bloqueado deixou de compensar o edge) cobrava só o **excedente** sobre
o hurdle do buffer da RFC-012 — mas o edge residual da saída não subtrai buffer
nenhum, então cobrava zero e o critério **nunca poderia disparar**. Na saída
passou a cobrar o custo integral do lockup restante; na entrada o excedente
continua correto, porque lá o edge líquido já subtrai o buffer.

**Config 1.0.0 → 1.1.0.** Um parâmetro novo (`exits.unwindAlarmPctOpenPnl`,
default 0,25 — o "X% do PnL aberto" do alarme de liquidez da tarefa 4) mudou o
conteúdo hasheado, então a versão foi cunhada de novo, que é o mecanismo que a
RFC exige. Seguro porque a 1.0.0 **nunca foi cunhada em produção**: o serviço
não existe no servidor ainda. Se existisse, seria o incidente do `score_version`
1.1.0 de novo.

Evidência completa, com os números medidos:
[`docs/test-results/RFC-013-portfolio-engine.md`](test-results/RFC-013-portfolio-engine.md).

### INCIDENTE: o G1 passou sem evidência nenhuma (2026-08-26, ~4 h)

**FATO VERIFICADO.** Primeiro ciclo de gates depois da ativação (19:53:19Z):
`{"gate":"G1","status":"PASS","reason_code":null}`. Não havia modelo promovido na
RFC-010, portanto não havia nada calibrado para medir.

**Mecanismo.** `loadForecastRows` filtrava `status = 'active'` mas não `source`.
Sem modelo promovido o estimador cai para baseline de mercado, e o `q` passa a
ser derivado do MESMO book gravado que o `market_prob` com que seria comparado.
`modelBrier ≈ marketBrier` e a barra é "não piora" — empate satisfaz; e
`modelBrier < 0,20` também, porque o **preço** é bem calibrado.

**Confirmação empírica**, na medição corrigida: `used_signal_brier =
0.07451024201319072`. A RFC-013 cita "barra: preço tem Brier ~0,074". O sinal
mediu exatamente o que a RFC diz que o preço mede — porque era o preço.

**Correção (PR #40).** As duas barras da RFC foram separadas: (a) o modelo
promovido vs o preço, tomada só sobre `source = 'MODEL'`; (b) o sinal usado vs o
teto absoluto. Sem modelo promovido, (a) é **immensurável** e o gate responde
`INSUFFICIENT_DATA` com o motivo escrito. Confirmado em produção às 23:49:19Z.

**Lição operacional, e ela custou três tropeços nesta sessão.** Merge, CD e
rebuild de profile são **três** passos e nenhum adivinha o outro:

1. o primeiro rebuild pegou a janela 13 min antes do CD do #39 → subiu fase D
   com config 1.1.0 no disco, uma bomba armada para o próximo restart;
2. o segundo rebuild rodou com o #40 ainda **OPEN** → recompilou o mesmo bug;
3. `git pull` foi tentado em `/opt/ganso-market`, que **não tem `.git`**, e
   `gh` foi tentado no servidor, onde não está instalado.

A guarda que resolve é rebuildar só depois de confirmar a correção no disco:

```sh
cd /opt/ganso-market && if grep -q modelForecasts apps/api/src/polymarket/portfolio/gates.ts; then docker compose --env-file deploy/server.env --profile polymarket up --build --detach polymarket-portfolio; else echo "PARE: o CD ainda nao entregou"; fi
```

**A linha `PASS` de 19:53 permanece** em `portfolio_gate_measurements`, imutável
por trigger. É correto: é a trilha de evidência de que o falso verde existiu.

### ACHADO: a ponte decisão → ordem de paper não existe

**FATO VERIFICADO** por busca de código: fora do próprio módulo, o único código
que toca `portfolio_decisions` é o worker de retenção, para podar. A coluna
`paper_order_id` da migration 0014 existe para isso ("set once the paper broker
accepted an order for this decision") e **nunca é preenchida**. O caminho de
`intent` do paper broker é um endpoint HTTP em `paper/api.ts` que espera alguém
chamar.

Em produção já houve **2 entradas ACEITAS** que não geraram posição nenhuma.

Isso **reordena o caminho crítico**: não é a RFC-010 sem modelo promovido. Mesmo
com entradas aceitas, nenhuma posição nasce, nenhuma fecha, e o G2 fica em
`INSUFFICIENT_DATA` para sempre. A ponte não pode viver dentro do módulo
`portfolio` (o guard de escopo proíbe escrever fora de `portfolio_*`), então
onde ela mora é decisão de projeto pendente.

### AUDITORIA: os outros quatro gates tinham o mesmo defeito do G1 (2026-08-27)

O incidente do G1 deixou uma pergunta escrita: _"nenhum dos outros quatro gates
foi reauditado sob a lente 'passa por degeneração'"_. A auditoria foi feita.
**Três dos quatro tinham o defeito**, e o quarto tinha uma variante mais
silenciosa. Em todos, o padrão é o mesmo: uma condição que se satisfaz porque
não havia nada contra o que comparar.

| Gate   | Como passava sem medir nada                                                                                                                                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G2** | PnL constante ⇒ toda reamostragem devolve o mesmo número ⇒ o IC 95% colapsa num ponto e `ciLow > 0` vira aritmética sobre ele. Idem para rajada num só dia, poucos blocos independentes, e uma posição dominando o livro. E as posições fechadas **antes** do relógio continuavam na amostra: um reset do G5 que joga os dias fora e mantém o sample é cosmético |
| **G3** | Zero posições ⇒ zero breaches não bloqueados e zero drawdown ⇒ com os breakers demonstrados, `PASS` sobre um livro que nunca existiu                                                                                                                                                                                                                             |
| **G4** | O viés de slippage comparava o fill simulado com um book-walk sobre **o mesmo snapshot que o simulador consumiu** — a mesma consulta, na mesma tabela, pelos mesmos níveis. Viés zero por construção, `bias >= 0` incapaz de falhar. E sem mínimo de amostra: uma mediana sobre uma amostra é aquela amostra                                                     |
| **G6** | `currentReportId === null` significava "confere" — e **nada jamais cunhava um relatório**, então era null sempre. Uma aprovação gravada à mão casaria com qualquer coisa                                                                                                                                                                                         |

O que fechou cada um, com teste de regressão no formato do #40 (todos afirmam
`not.toBe("PASS")`), está em
[`docs/test-results/RFC-013-portfolio-engine.md`](test-results/RFC-013-portfolio-engine.md)
§10. Em resumo: dispersão exigida no G2 (largura de intervalo, blocos, dias de
fechamento distintos, concentração, corte pela janela do relógio); G3 passa a
receber **o mesmo objeto** de base de evidência que o G2; G4 ganha mínimo de
amostra por perna e **proveniência declarada** em cada amostra, com as
auto-referentes excluídas da aritmética e contadas; G6 ganha relatórios de
verdade e um caminho de registro.

**O veredito medido não mudou**: seis gates, nenhum `PASS`, `rfc_009_status`
`BLOCKED`. Mudou o motivo.

### Registro da aprovação do G6

O ciclo de gates passa a cunhar `portfolio_gate_reports` quando — e só quando —
**um veredito muda** (fingerprint sobre gate/status/reason_code, não sobre as
métricas: um relatório por hora invalidaria a revisão continuamente). Uma
aprovação vale exatamente enquanto valerem as respostas que ela aprovou.

O registro é uma **CLI**, não um endpoint: o perímetro publica o portfólio só
em GET, e as duas coisas fechadas na borda são as que mudam o que o sistema tem
permissão de fazer — sair de `HALTED`, e esta.

```sh
docker compose exec -T api node apps/api/dist/gates-cli.js show
docker compose exec -T api node apps/api/dist/gates-cli.js approve <id> \
  --reviewer owner --acknowledge-expectation < revisao.txt
```

Recusa com código próprio: relatório inexistente, não corrente, já aprovado,
gates ainda não todos `PASS`, revisor inválido, registro escrito com menos de 40
caracteres, expectativa calibrada não reconhecida. A mesma guarda está repetida
**dentro** do `UPDATE`. Procedimento em
[`docs/runbooks/polymarket-portfolio.md`](runbooks/polymarket-portfolio.md).

### DECISÃO DE DESENHO: onde mora a ponte decisão → ordem de paper

Recomendação escrita em
[`docs/architecture/decision-to-paper-bridge.md`](architecture/decision-to-paper-bridge.md),
**não implementada**:

> **O decision log é o outbox. O consumidor mora no módulo `paper`. Nenhum dos
> dois módulos escreve na tabela do outro.**

Um job `bridge` a cada 30 s no `paper/runner.ts` lê `portfolio_decisions`
(`ENTRY`/`ACCEPTED`/`paper_order_id IS NULL`), revalida frescor por conta
própria e chama **em processo** o mesmo `decideOrderType` + `acceptPaperOrder`
que o endpoint de intents já usa. A chave de junção viaja com a ordem
(`paper_orders.decision_id`), e é o **próprio módulo portfolio** que carimba
`paper_order_id` no ciclo seguinte, lendo `paper_orders` só para leitura. Assim
os dois guards de escopo continuam exatamente tão estritos quanto são hoje.

Custo: migration **0015** (`paper_orders.source` ganha `'portfolio'`, mais a
coluna `decision_id`), zero container novo, zero RAM nova, zero superfície nova
no perímetro. As alternativas — dentro do portfolio, um terceiro serviço, uma
chamada HTTP, ou o portfolio escrevendo `paper_orders` — e por que cada uma foi
recusada estão no documento.

### Config 1.1.0 → 1.2.0 (cuidado de deploy)

Quatro parâmetros de gate novos (`g2MinDistinctCloseDays`,
`g2MinBootstrapBlocks`, `g2MaxSinglePositionPnlShare`, `g4MinReconciledFills`)
mudam o conteúdo hasheado. A 1.1.0 **está cunhada em produção** desde 19:53Z de
2026-08-26, então editá-la repetiria o incidente do `score_version`: a versão
foi cunhada de novo. O parser continua recusando afrouxamento — os quatro
entram na lista que dispara `PORTFOLIO_CONFIG_GATE_LOOSENED`.

`config/portfolio.json` chega pelo CD e o binário que o lê só muda no rebuild de
profile: **os dois têm que sair na mesma janela**.

### SEGUNDO BLOCO DE CHECAGEM — rodado pela primeira vez (2026-08-27 03:11Z)

Nunca havia rodado contra a fase E. Rodou depois do rebuild com a config 1.2.0.

| Verificação                    | Resultado                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `PORTFOLIO_BOOT`               | `config_version` **1.2.0**, hash `1c8a3316…`, `factor_map_version` 1.0.0                            |
| Seis gates                     | **todos `INSUFFICIENT_DATA`**, `rfc_009_status: BLOCKED` — o resultado correto                      |
| `PORTFOLIO_GATE_REPORT_MINTED` | **`report_id: 1`, `reason: "first_report"`** — o primeiro relatório de gates que já existiu         |
| `gates-cli show` em produção   | responde, com os seis vereditos e a expectativa calibrada impressa                                  |
| `PORTFOLIO_REPLAY_OK`          | presente; **zero** `MISMATCH`; **zero** linhas de erro no serviço                                   |
| Métricas novas do G4           | `samples_required: 100`, `self_referential_fee_samples: 0`, `self_referential_slippage_samples: 0`  |
| Métricas novas do G2           | `distinct_close_days`, `bootstrap_blocks`, `outside_window` presentes nos shortfalls                |
| Perímetro Nginx                | GET `gates/measurements`, `portfolio/state`, `opportunities`, `decisions` → **401**; POST → **404** |
| RAM                            | portfolio **23,8 MiB de 192**; recorder 87 de 832; postgres 252 de 1024; nada perto do teto         |
| Imagens                        | `api` e `polymarket-portfolio` de 03:10Z de hoje; as outras quatro de 17:03Z de ontem               |
| Poda de `book_deltas`          | **rodando**: 5 execuções, **124,8 M linhas** apagadas; vivas 249,4 M → **106,9 M**                  |

**A janela de crash-loop foi observada, e é a lição de sempre.** O CD entregou
`config/portfolio.json` 1.2.0 e recriou o container **antes** do rebuild; o
binário antigo leu quatro chaves que não conhecia e recusou com
`PORTFOLIO_CONFIG_UNKNOWN_KEY` — fail-closed correto. O rebuild fechou a janela.
Merge, CD e rebuild continuam sendo três passos.

**Relógio do G2 resetou sozinho, corretamente.** `macro` foi resetado às
02:19:29Z com `regime_fingerprint_changed`: a venue mudou fee/tick nessa
categoria e os dias acumulados foram jogados fora. `crypto` segue desde
2026-08-26 19:53:19Z. É o mecanismo do G5 funcionando em produção, observado
pela primeira vez.

**`pg_database_size` em 111 GB contra um orçamento de 110 GB.** Não é
descontrole: `DELETE` não devolve páginas ao arquivo, então o número físico é
uma marca d'água. A quota por tabela usa `liveBytes` (físico descontado da
fração de tuplas mortas) exatamente para não entrar no laço destrutivo de podar
sobre um tamanho que nunca cai — está documentado em `retention.ts`. Disco em
119 GB de 301 GB (**42%**).

### Achado novo: 32 `FEATURES_WINDOW_FAILED` por 20 min no paper

**FATO VERIFICADO** (2026-08-27, achado pelo bloco de checagem): o serviço
`polymarket-paper` registra `FEATURES_WINDOW_FAILED` ~32 vezes a cada 20 min,
com **apenas** `error_name: "Error"` e nenhuma mensagem — o mesmo padrão que o
#37 corrigiu no recorder e na resolução, e que custou tempo real de diagnóstico
duas vezes. O job de features do paper não foi coberto por aquele PR.

Somado a isso, uma inconsistência: o `FEATURES_TICK` do mesmo ciclo reporta
`failures: 0` enquanto as linhas de falha saem. Os dois contadores não falam da
mesma coisa.

Não é regressão desta sessão: a imagem do `polymarket-paper` é de 17:03Z de
2026-08-26 e não foi tocada. Fica como pendência.

(`FEATURES_BACKLOG_SKIPPED` aparece ~6.000 vezes no mesmo intervalo, sempre com
`window_kind: "1s"` e `windows_skipped: 5`. É `warn`, não erro: o tick roda a
cada ~10 s e as janelas de 1 s acumulam, então o catch-up é limitado de
propósito. Ruidoso, não quebrado.)

### Achado aberto: coletor onchain falhando

**FATO VERIFICADO:** `JOB_FAILED job:"onchain"` se repete a cada ciclo — 12
ocorrências em 60 min — com `ONCHAIN_POLLED` **zerado**. Sondando os RPCs da
config a partir do servidor:

| endpoint                                 | resposta                                              |
| ---------------------------------------- | ----------------------------------------------------- |
| `https://polygon-rpc.com`                | **403** — `API key disabled, reason: tenant disabled` |
| `https://polygon-bor-rpc.publicnode.com` | OK, e `eth_getLogs` no adapter real também responde   |

O endpoint público que a config lista primeiro **foi fechado** desde o
desenvolvimento da RFC-012 (2026-08-24). O failover do coletor está correto
(percorre todas as URLs, só lança se todas falharem) e a segunda URL funciona —
então a causa do `JOB_FAILED` é outra. O PR #37 (aberto, CI verde) faz a
mensagem do erro entrar no log dos jobs supervisionados, o que deve revelá-la no
próximo ciclo.

Padrão que custou tempo real duas vezes nesta sessão: falha logada apenas com
`error_name: "Error"`. Diagnosticar o `SCORE_VERSION_CONTENT_MISMATCH` exigiu
re-executar o boot à mão dentro do container; diagnosticar o onchain exigiu
reproduzir suas chamadas RPC manualmente. #31 corrigiu no entrypoint da
resolução, #37 corrige nos jobs supervisionados do recorder e da resolução.

### Estado medido do disco (2026-08-26 ~09:50Z)

| Métrica                    | Valor                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pg_database_size`         | **104 GB** (orçamento 110 GB, alarme em 99 GB)                                                                               |
| `polymarket_book_deltas`   | **249,4 M** linhas vivas                                                                                                     |
| Disco                      | 111 GB de 301 GB (**39%**)                                                                                                   |
| `polymarket_retention_log` | poda registrada em `book_snapshots` (7,08 M linhas) e `paper_feature_windows` (1,19 M) — **`book_deltas` ainda sem entrada** |

**Por que `book_deltas` ainda não fecha:** as imagens dos containers de profile
são de **02:18Z**, anteriores ao merge do #35 (guarda do `DELETE` por fatia).
A correção que destrava a poda existe na `main` mas **não está rodando**. É
preciso o rebuild de profile — o mesmo que criará o `polymarket-portfolio`.

## DECISÃO DO PROPRIETÁRIO — calibração da RFC-013 (2026-08-27)

**FATO INFORMADO:** o proprietário decidiu os quatro pontos abertos da seção de
achados de calibração (§7 de
[`docs/test-results/RFC-013-portfolio-engine.md`](test-results/RFC-013-portfolio-engine.md)).
Registro item a item, com o que cada decisão implica em código e o que ainda
falta para cada uma virar comportamento.

### 1. Decision log: TTL declarado de 90 dias — mas o que prende é a quota, não o TTL

**DECISÃO:** aceitar ~3 dias como retenção real por enquanto e declarar o TTL em
**90 dias** (era 180), pelo raciocínio do proprietário de que a maior parte do
log é histórico que ninguém vai reler.

**FATO VERIFICADO — o TTL não é o que prende.** A poda tem dois limites e o
menor ganha: TTL de 180 dias e quota de 0,9 GB. A 2.038 bytes/linha e ~141 mil
linhas/dia são **287 MB/dia**, então a quota vence em **3,4 dias**. Baixar o TTL
de 180 → 90 **não muda nada hoje**: a quota poda antes, em qualquer um dos dois
valores. Reter 90 dias de verdade exigiria **25,9 GB** de quota — contra um
banco já em 111 GB físicos num orçamento de 110 GB. Por quota, 90 dias não está
disponível.

O TTL de 90 dias foi mesmo assim registrado como intenção declarada, porque ele
passa a ser o limite que prende **depois** que a cadência de escrita cair (item
b abaixo). Não é decoração: é o teto que vale no estado seguinte.

**FATO VERIFICADO — o custo de 3 dias não é "histórico que ninguém lê".** Existe
um consumidor sob carga: `entryProvenanceFor`
(`exitstore.ts:243`) lê, a cada ciclo de saída, a decisão de **entrada** da
posição aberta — para comparar hoje contra o que a entrada se comprometeu a
acreditar. Quando essa linha é podada, quatro dos sete critérios de saída
**param de poder disparar**, em silêncio:

| Critério de saída                  | Com a entrada podada                                                             | Onde               |
| ---------------------------------- | -------------------------------------------------------------------------------- | ------------------ |
| Condição de invalidação (campo 12) | `invalidationProbLowerBelowScaled === null` → `invalidationFired` sempre `false` | `exitcycle.ts:273` |
| Modelo se moveu contra a tese      | `entryProbScaled` cai para a estimativa de hoje → diferença zero                 | `exitcycle.ts:306` |
| Fonte/regra de resolução mudou     | `entryRuleVersion === null` → `sourceChanged` sempre `false`                     | `exitcycle.ts:277` |
| Precisão de regra degradou         | `entryRulePrecisionScaled === null` → sempre `false`                             | `exitcycle.ts:285` |

Cada um desses `null` é deliberado e está comentado no código como "não sabemos
que se moveu" — a direção honesta quando a linha **nunca existiu**. O que a poda
faz é transformar a exceção em rotina: **toda posição segurada por mais de ~3
dias perde a própria tese**. É exatamente a lente da auditoria dos gates
(2026-08-27) aplicada ao lado da saída — o critério não falha, ele só deixa de
disparar.

Era **latente** quando o achado saiu: zero posições abertas e nenhuma ponte para
o paper. Viraria real no dia em que a ponte entrasse — e a ponte entrou na mesma
sessão, com o carimbo dentro dela.

**Sequência decidida, nesta ordem:**

- **(a) FEITO, junto da ponte:** a provenance da entrada é carimbada em
  `portfolio_position_entries` (lado, `q_lo`/`q_hi`, `rule_version`, fonte de
  resolução, precisão de regra, nível de invalidação) no instante em que a ordem
  é aceita. Tabela `protected`, imutável por trigger, nunca podada;
  `entryProvenanceFor` lê dela primeiro e cai para o log só para entradas
  anteriores à ponte. Mata a degeneração **independentemente** da retenção, e há
  teste contra PostgreSQL real que apaga a linha de decisão e exige a provenance
  completa. Falta deploy.
- **(b) O meio-termo que o proprietário pediu vem de escrever menos, não de
  guardar mais:** aplicar ao ciclo de **entrada** a regra que o ciclo de saída
  já usa — escrever quando o veredito **muda**
  (`runner.ts:997`). Hoje a entrada grava incondicionalmente, uma linha por
  mercado por ciclo (`runner.ts:861`), e a maioria dos 98 mercados devolve o
  mesmo veto com o mesmo binding constraint a cada minuto. Com a mesma quota de
  0,9 GB o log passa a cobrir semanas, e o TTL de 90 dias passa a ser o limite
  que vale. **O fator de redução tem que ser medido** (contagem de trocas de
  assinatura por mercado por dia no log atual), não estimado.
- **(c) Interpretação que (b) exige registrar:** a RFC-013 diz "toda intenção
  persiste" (tarefa 7). O ciclo de saída já foi aprovado lendo isso como "toda
  intenção **distinta**" — um hold é registrado, não reescrito a cada 30 s. (b)
  estende a mesma leitura à entrada. Sem esse registro, escrever menos leria
  como afrouxamento silencioso da tarefa 7, que é a direção proibida. Um
  heartbeat periódico (uma linha por mercado por hora) pode ser mantido se
  quisermos a prova "o motor olhou" dentro do próprio log; hoje ela já existe
  fora dele, em `portfolio_gate_measurements` (`protected`, horária) e no
  `PORTFOLIO_CYCLE`.

### 2. `custo_capital_anual`: subir, com o número saindo de um shadow replay

**DECISÃO:** subir o parâmetro para torná-lo vinculante e **depois** rodar um
shadow replay para avaliar se o passo faz sentido para o bot.

**FATO VERIFICADO — o cruzamento depende do preço, não só do hurdle.** O achado
anterior dizia "acima de ~18,3% a.a." e isso está incompleto. O módulo cobra o
excedente `r × (L/365) × p − 0,0005 × L`
(`ev.ts:147`): o lockup `L`
**cancela** e o preço `p` não, então o parâmetro passa a morder quando
`r > 0,1825 / p`.

| Preço de entrada     | `custo_capital_anual` necessário para morder |
| -------------------- | -------------------------------------------- |
| 0,95 (topo da banda) | **19,2% a.a.**                               |
| 0,75                 | 24,3% a.a.                                   |
| 0,50                 | **36,5% a.a.**                               |
| 0,25                 | 73,0% a.a.                                   |
| 0,10 (piso da banda) | 182,5% a.a.                                  |

Ou seja: 18,3–20% torna o parâmetro vinculante **só no topo da banda de compra**;
para valer num mercado de meio-preço o número tem que ser ~36,5% a.a. A escolha
entre 20% e 40% é a diferença entre "continua praticamente inerte" e "reprecifica
o livro inteiro", e não é uma escolha que se faça por gosto.

**FATO VERIFICADO — o parâmetro não é inerte nos dois lados.** Na **saída** o
critério 6 já cobra o custo integral do lockup restante, sem descontar buffer
(`exitcycle.ts:266`,
`bufferDailyHurdleScaled: 0n`). Os 12% a.a. de hoje **já são vinculantes ali**.
Subir o número não é neutro: aperta a entrada **e** deixa a saída mais impaciente
com capital preso.

**Como o número vai ser escolhido:** varredura de `capitalCostAnnual` sobre o
decision log gravado, usando o replay determinístico da tarefa 7 —
`inputs_json.replay` guarda todo escalar da decisão, então dá para recontar as
decisões registradas sob cada taxa candidata e medir quantas mudam de veredito,
de tamanho e de binding constraint. É medição, não opinião. **`config/portfolio.json`
fica em 1.2.0 até a varredura dar o número**; subir agora queimaria um nome de
versão para um valor que a própria decisão manda revisar.

**Dependência cruzada com o item 1:** a varredura roda sobre um log que só
guarda ~3 dias. Ela tem que rodar sobre a janela existente, ou depois de (b).

### 3. Cap de fonte de resolução: trocar a chave, não o número

**DECISÃO:** manter `caps.fonteResolucao` em **0,25** e trocar a **chave** do
bucket — capear por família de cláusula de regra em vez de por adapter.

O proprietário respondeu "não entendi o ponto aqui" ao achado original. O ponto,
em ordem, porque ele é o que justifica a decisão:

**O que o cap é.** `caps.fonteResolucao = 0,25` limita a soma da exposição de
pior caso de **todas as posições que compartilham a mesma fonte de resolução** a
25% da banca (`exposure.ts:239`).

**Por que ele existe.** Se o mesmo oráculo — ou a mesma cláusula de fallback —
decide muitos mercados, uma falha dele (disputa, bond, 50/50) atinge todos de uma
vez. São **uma aposta**, não muitas. O cap é a tradução disso em dinheiro.

**Onde ele descarrilou.** A RFC queria capear por `resolutionSource` do Gamma,
mas o Gamma popula esse campo em **2 de 98** mercados elegíveis, então o código
cai para `COALESCE(resolution_source, resolved_by)` — e `resolved_by` é o
**adapter**, que é UMA em **460 de 570** rule versions. A chave do bucket
colapsa: ~81% do livro cai num único bucket chamado "UMA".

**A consequência medida.** O cap deixa de ser regra de diversificação e passa a
ser **teto global de exposição**: com banca nocional de US$ 1.000, o livro
inteiro nunca passa de **US$ 250**, por mais descorrelacionados que os mercados
sejam. O cap de capital bloqueado (60% = US$ 600) **nunca** consegue prender, e
com o cap de entrada de 2% (US$ 20) o livro satura em ~12 posições. Efeito
colateral de diagnóstico: `binding_constraint` no decision log passaria a dizer
`fonteResolucao` em quase toda decisão — ruído no campo que existe exatamente
para explicar por que os tamanhos são pequenos.

**Por que a chave e não o número.** "Resolve pelo adapter UMA" é um fato sobre a
Polymarket, não um agrupamento de risco. Uma falha UMA-wide é uma cauda real
(bond ~US$ 750, liveness 2 h, 50/50 possível), mas é **risco de venue** — que o
cap de capital bloqueado já cobre — e não cluster por fonte. O que diferencia
risco entre dois mercados é a **cláusula de regra**: a RFC-012 já calcula
`rule_version` e precisão de regra, e o `config/resolution-lexicon.json` já
classifica cláusula. Capear por família de cláusula devolve ao parâmetro a função
que a justificativa dele descreve, sem afrouxar nada: subir `fonteResolucao` para
perto de 0,6 seria tornar o cap inerte, e essa direção continua fora da mesa.

**O que o PR precisa fazer:** derivar a chave de bucket da família de cláusula
(léxico da RFC-012) com fallback explícito e **nomeado** quando a cláusula não
for classificável — um fallback silencioso para "unknown" recriaria o bucket
gigante com outro nome, que é o mesmo defeito com roupa nova. A dimensão de
exposição gravada em `portfolio_exposures` muda de valor, não de nome. Não é
mudança de config (o número fica em 0,25), mas **muda comportamento de sizing**,
então entra com teste de que dois mercados de cláusulas diferentes deixam de
compartilhar bucket e dois de cláusula igual continuam compartilhando.

### 4. `g2MaxSinglePositionPnlShare = 0,25` — aprovado pelo proprietário

**DECISÃO:** o número fica em **0,25**. Deixa de ser "número do implementador" e
passa a ser limiar aprovado pelo proprietário.

O que ele faz: o G2 rejeita a amostra quando **uma única posição fechada
responde por mais de 25% do PnL bruto absoluto** do conjunto
(`gates.ts:408`) — é a segunda perna de dispersão, ao lado de dias distintos de
fechamento e blocos de bootstrap. Com as 100 posições fechadas que o G2 exige,
uma distribuição uniforme dá 1% cada; 25% significa que um único fechamento
moveu um quarto de todo o dinheiro que o livro moveu.

**Revisão futura registrada:** revisitar contra dado real quando o G2 tiver ≥ 100
posições fechadas — o que depende da ponte decisão → ordem de paper. Até lá não
há amostra contra a qual calibrar.

### Achado novo: `portfolio_panel_snapshots` declara 30 dias e retém a mesma ordem de 3

**FATO VERIFICADO (aritmética, linha ainda não medida):** a mesma conta do item 1
se aplica à tabela vizinha. `portfolio_panel_snapshots` recebe **uma linha por
mercado por ciclo**, no mesmo `panelMs` de 60 s
(`runner.ts:864`), e o
`panel_json` carrega o mesmo livro de 10 níveis por lado (`BOOK_LEVELS = 10`)
mais o trecho de regra de até 240 caracteres (`RULE_EXCERPT_MAX_CHARS`). Contra
uma quota de 0,56 GB, qualquer linha acima de ~4 kB/dia·mercado põe a quota na
frente do TTL declarado de **30 dias**; na ordem de 1,4 kB/linha a janela real
fica em ~3 dias, como no decision log.

**Diferença importante:** aqui não há consumidor profundo. A API só lê
`DISTINCT ON (token_id) … ORDER BY computed_at DESC`
(`api.ts:172`) e o detalhe lê
`LIMIT 1`. É uma **etiqueta errada**, não um perigo: o TTL declarado promete 30
dias de histórico de painel que a quota não entrega. Medir `pg_column_size` da
linha em produção e redeclarar o TTL — não inventar quota nova.

## SESSÃO 2026-08-28 — BLOCO DE HOTFIXES: retenção, G2/G5, throughput, onchain

Cinco PRs mergeados e **ativos em produção** (#50–#54, CI verde nos três jobs em
cada um), mais a janela de manutenção autorizada. Cada fix entrou com teste de
regressão **verificado falhando no código anterior** (padrão dos #40–#49), e
cada defeito foi **re-medido em produção antes da correção**. Release final no
servidor: `24e1c91` (confirmado por `/etc/ganso/release-sha` DENTRO de cada
container de profile, nunca por `compose ps`).

### #50 — o medidor de bytes vivos parou de herdar o arquivo físico (URGENTE)

**FATO VERIFICADO (re-medição 2026-08-28 ~19:30Z, antes do fix):** o desconto
por fração de tuplas mortas degenera quando o autovacuum zera `n_dead_tup` sem
o arquivo encolher: `live_bytes == físico` de novo — a lente das degenerações
dos gates aplicada à retenção. `polymarket_book_deltas` estava com **104,5 GB
físicos e `n_dead_tup = 0`** (autovacuum às 19:04Z), lidos como 104,5 GB
"vivos" contra quota de 52 GB. A rodada de 13:37Z pediu
**`rows_to_delete: 33.926.410`** (~53% da tabela, vivo real ~20 GB) e só não
executou porque o DELETE do token pesado estourou timeout. **Pior: às 10:28:32Z
a mesma degeneração já havia apagado 1.390.106 linhas VIVAS** (`pruned_before =
28/08 07:32` — dados com ~3 h de idade). E às 13:37Z o histograma defasado do
`pg_stats` escolheu corte 26/08 14:36, **1,9 dia ATRÁS** do que a rodada das
10:28 já tinha podado — o floor era estado por run e morria no restart.

**Correção (#50):** bytes vivos = `linhas vivas × largura medida`
(`pg_stats.avg_width` + overhead de tupla + parcela de índice por entrada viva

- **chunks TOAST vivos × 2048 B** — medido: o decision log tem 1,4 kB por
  larguras e 3,4 kB por `pg_column_size`; o resto é TOAST que o `avg_width` não
  vê). Nunca o arquivo. O floor da quota agora é **persistido** (semeado de
  `max(pruned_before)` do retention_log, exceto tabelas `closedRowsOnly`);
  histograma que devolveria corte ≤ floor loga `RETENTION_HISTOGRAM_STALE` e cai
  para o estimador linear ancorado no floor. `ANALYZE` após poda que apagou
  linhas. `RETENTION_STEP_FAILED` ganhou `detail` com a mensagem real (padrão do
  #37).

**FATO VERIFICADO (produção, 19:52Z, primeira varredura com o fix):**
`book_deltas` medido em **20,77 GB vivos** (o compacto real, medido depois pelo
`VACUUM FULL`, é 19 GB — erro de ~9%) → `RETENTION_BLOAT`, **zero pedido de
exclusão**; o pedido de 33,9 M desarmou. **O alarme global saiu**: live honesto
36,28 GB contra gatilho de 99 GiB → `RETENTION_GLOBAL_BLOAT` (warn, 88,3 GB de
inchaço) e **zero `QUOTA_GLOBAL_TTL_REDUCED`** — o corte de 25% nos TTLs de ~20
tabelas parou.

### #51 — o fingerprint de regime virou o schedule da venue (decisão de 28/08)

**FATO VERIFICADO (re-medição):** 11 resets do relógio do G2 em ~44 h (6
crypto, 5 macro; crypto resetou de novo às 16:18Z de 28/08), janela contínua
máxima 19,5 h contra 60 DIAS exigidos. O hash cobria as tuplas fee/tick dos
mercados ATUALMENTE em vigor, e o conjunto se move sem nenhuma mudança de
venue: em 48 h de `param_versions`, **124 observações flipando `fee_base_bps`
entre NULL e "1000"** (ruído do Gamma) e **93 flipando `tick_size`
0.001↔0.01** (banda de preço); combos raros — `(NULL, 0.01, f)` tinha 11
mercados — esvaziam e o hash muda.

**Correção (#51), semântica decidida pelo proprietário:** regime = **schedule
de fee/tick da venue por categoria**. Fingerprint = domínios de valores por
parâmetro, do **último valor não-nulo de cada mercado, sobre todos os mercados
já categorizados** (quem sai não retira o que atestou; observação sem o campo
não diz nada; tick migrando de banda não cria valor novo). `negRisk` saiu do
hash (estrutura por evento, não schedule). Validado contra produção: crypto
`fee {1000} / tick {0.001, 0.01} / min {5}` (fee atestado por 649 mercados),
macro `fee {0, 1000} / tick {0.001, 0.01}`. Nenhuma chave de config mudou.

**FATO VERIFICADO (produção):** o deploy zerou o relógio **uma última vez**
(crypto e macro às 20:38:47Z, fingerprints novos por definição — esperado e
registrado; resets passados não são recuperáveis, correto). Desde então, **zero
resets** sob rotação normal. A verificação plena é 24–48 h sem
`PORTFOLIO_G2_CLOCK_RESET` (antes: ~5/dia) — **observação em curso**.

### #52 — lag transitório do runtime deixou de cancelar ordem paper

**FATO VERIFICADO (re-medição):** **7 das 9 ordens canceladas** da história
tinham `RESOLUTION_RUNTIME_LAGGING` com lag de 1, 1, 1, 2, 11, 11 e 17
input-ids; o journal de inputs anda a 49–286 entradas/hora e o runtime alcança
no ciclo de ~1 min, então `processed < head` é rotineiramente verdade por
instantes. Throughput: **1 fill na vida do sistema** (28/08 14:30Z) contra as
~2–3/dia que o G2 precisa.

**Correção (#52), sem afrouxar o fail-closed:** ordem aberta só é cancelada
quando o lag **persiste** — a idade da entrada mais antiga não processada
(`received_at` dos próprios journals; sem memória por ordem, sobrevive a
restart) passa de **180 s** (~3 ciclos do runtime). Na graça, a claim é
liberada e o tick loga `PAPER_ORDER_RUNTIME_LAG_GRACE`; idade imensurável cai
no cancelamento. Runtime **morto** nunca espera (lease expira →
`RESOLUTION_RUNTIME_STALE` imediato, inalterado). **FILL inalterado**: aceitação
e revalidação continuam exigindo runtime alcançado em todos os heads — provado
por teste que passa nas DUAS revisões. Verificação plena (proporção
canceladas/criadas caindo, vida mediana subindo em `paper_orders`) exige 24 h
de ordens novas — **observação em curso** (a ponte cria ordens raramente
enquanto `entrable: 0`).

### #53 — o coletor onchain coletou pela primeira vez na vida

**FATO VERIFICADO (re-medição, com correção de diagnóstico):**
`https://polygon-rpc.com` devolve 403 ("API key disabled, reason: tenant
disabled") desde 24/08 ✓ como registrado. Mas o `-32701` do failover **não é
limite de range/resultado** (hipótese anterior, refutada por sondagem): é
**"History has been pruned for this block"**. O publicnode poda histórico
(fronteira medida entre ~80 k e ~100 k blocos, difusa entre upstreams do
balanceador) e o cursor vazio ancorava a primeira varredura em
`target − 200.000` — toda rodada pedia blocos que o provedor **nunca mais vai
servir**. Sondagens que fecharam o diagnóstico: range de 2.000 blocos recente
funciona (2.399 logs numa chamada); os mesmos ranges a 100 k–200 k de
profundidade devolvem -32701 nos dois tamanhos.

**Correção (#53):** config: sai o endpoint 403; entram
`polygon-bor-rpc.publicnode.com` + `gateway.tenderly.co/public/polygon`
(failover **validado byte a byte**: mesma janela → 286 logs idênticos;
recusados pela sondagem: drpc, 1rpc, meowrpc, blastapi, zan). `chunk_blocks`
2000 → 500; `lookback_blocks` 200000 → **40000** (dentro do histórico servível
— a correção da causa raiz). Coletor: chunk que falha é retentado com metade do
span até piso de 125 blocos; poda de histórico no piso **salta o cursor para a
âncora do lookback** (`ONCHAIN_RANGE_PRUNED`) em vez de falhar para sempre;
outros erros continuam derrubando a rodada. `RpcError` carrega a mensagem do
provedor. O hash do score cobre só material de score (teste existente), então
nada cunhou versão; o rebuild saiu na mesma janela do CD (regra da janela
única).

**FATO VERIFICADO (produção, 20:43–20:48Z):** `ONCHAIN_POLLED` com
`inserted: 10` e depois `inserted: 1` → **11 linhas em
`resolution_onchain_events`** (eram 0 desde sempre); cursor dos 4 adapters
avançando (92.794.799); `skipped_unmapped` ~2,9 k/poll (filtro de orçamento
fazendo o que promete); **zero `JOB_FAILED job:"onchain"`**.

### #54 — batch da quota orçado por bytes (bônus, saído do diagnóstico do #50)

Com a mensagem real no log, o `RETENTION_STEP_FAILED` recorrente de
`portfolio_decisions` revelou **"Query read timeout"**: 50.000 linhas de
~4,3 kB movem ~220 MB por batch (seis índices + TOAST) e estouram o timeout do
pool em toda varredura. O batch da quota virou
`min(batch de linhas, 32 MiB / bytesPerRow)` com piso de 1.000 linhas; tabelas
magras mantêm o batch cheio; caminho do TTL inalterado.

### BLOQUEIO NOVO (condição de parada): a poda de `portfolio_decisions` exige migration — **RESOLVIDO em 2026-08-31 (migration 0016 autorizada; seção da sessão 2026-08-31)**

**FATO VERIFICADO (produção, 21:22Z + probe com ROLLBACK):** mesmo com o batch
por bytes, a poda de decisions continuou estourando timeout. A causa final,
medida com `EXPLAIN ANALYZE` de um DELETE de UMA linha (em transação revertida):
**125 ms por linha, dominados pelo trigger da FK
`portfolio_panel_snapshots_decision_id_fkey` (ON DELETE SET NULL)** —
`portfolio_panel_snapshots.decision_id` **não tem índice**, então cada linha
apagada de decisions custa um seq scan de ~600 MB no panel. 7.600 linhas/batch
× 125 ms ≈ 950 s: nenhum batch viável fecha.

A cura é `CREATE INDEX` em `portfolio_panel_snapshots (decision_id)` —
**migration 0016**, e migration é condição de parada deste bloco: **não foi
implementada**. Registrado para autorização do proprietário. Enquanto não
existe: a quota de `portfolio_decisions` (0,9 GB) **não fecha** e a tabela
cresce ~0,5 GB/dia (1,19 GB físicos hoje); o TTL de 180 d bateria na mesma FK.
Com o banco em 38 GB contra orçamento de 110, há semanas de folga — mas é o
risco aberto número um da retenção. (A poda do panel_snapshots fecha
normalmente: apagar o lado que REFERENCIA não paga a FK.)

### Janela de manutenção — `VACUUM FULL` recuperou 78 GB

**FATO VERIFICADO (2026-08-28 20:53–21:06Z):** `pg_repack` não existe na imagem
`postgres:18.4-bookworm` (verificado) → caminho `VACUUM (FULL, ANALYZE)` com o
recorder parado, como autorizado. Números:

| Métrica                  | Antes           | Depois               |
| ------------------------ | --------------- | -------------------- |
| `polymarket_book_deltas` | 97 GB (42 + 56) | **19 GB (11 + 8,8)** |
| `pg_database_size`       | 116 GB          | **38 GB**            |
| Disco usado              | 124 G (44%)     | **43 G (15%)**       |

Lock exclusivo: **7 min 34 s** (20:54:42 → 21:02:16Z). Gap do recorder:
20:53:56 → 21:06:33Z (~12,6 min), registrado pelo próprio sistema — o desenho.
Higiene docker: `builder prune` + imagens dangling = **2,33 GB**. O alarme
global já tinha saído com o #50 (o vivo honesto nunca esteve perto de 99 GiB);
pós-repack o físico também está longe. Primeira varredura pós-repack:
`book_deltas` sumiu até do `RETENTION_BLOAT` (físico ≈ vivo).

**Efeito colateral desenhado, com REARME PENDENTE:** o gap do recorder engatou
o kill switch do paper às **20:59:32Z** (`RECORDER_STALE`, `orders_canceled: 0`
— não havia ordem aberta). O gatilho automático funcionando como projetado. O
recorder está saudável desde 21:06:33Z, mas o rearme por aqui foi
deliberadamente NÃO executado: o endpoint exige sessão do proprietário (criar
credencial está fora do que esta sessão pode fazer) e o caminho de código
direto no servidor foi bloqueado pela política de execução. **É um clique no
botão de rearme do painel (PR #46) — o botão existe exatamente para este
cenário.** Enquanto engatado, nenhuma ordem paper é aceita e o soak do #52
fica pausado.

**DECISÃO DO PROPRIETÁRIO (28/08, registrada):** a quota de 52 GiB de
`book_deltas` **não foi redeclarada** — a redeclaração é consciente, com dado,
após **~1 semana de ingestão observada pós-repack** (ingestão do dia: ~18,7 M
linhas ≈ 15 GB/dia física... a medir com o arquivo compacto). Também decidido
em 28/08: **backup mínimo recusado** — o risco de perda total do PostgreSQL
permanece aceito como está.

### Bloco de checagem final (medido em produção, 2026-08-28 ~22:25Z)

| Verificação                       | Resultado                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #50 retenção                      | varredura de boot: `book_deltas` vivo 20,77 GB < quota, **zero pedido de exclusão**; alarme global fora; **zero `QUOTA_GLOBAL_TTL_REDUCED`**                                                                                                                                                                                                                                                  |
| #51 G2/G5                         | **0 resets** desde o reset final do deploy (20:38:47Z; antes: ~5/dia). Soak de 24–48 h em curso                                                                                                                                                                                                                                                                                               |
| #52 lag                           | **0 cancelamentos** desde o deploy; soak de 24 h pausado pelo kill switch engatado (rearme pendente, 1 clique)                                                                                                                                                                                                                                                                                |
| #53 onchain                       | **53 linhas** em `resolution_onchain_events` (0 na vida toda antes; 11 → 53 em ~1,5 h), cursor dos 4 adapters em 92.827.299 e avançando, **zero `JOB_FAILED job:"onchain"` em 1 h**                                                                                                                                                                                                           |
| Banco                             | 38 GB (`book_deltas` 20 GB e ingerindo)                                                                                                                                                                                                                                                                                                                                                       |
| RAM                               | recorder 242/832 MiB; resolution 84/192; paper 34/256; portfolio 32/192; postgres 357/1024 — nada perto do teto                                                                                                                                                                                                                                                                               |
| Erros em ~1 h, por serviço tocado | portfolio **zero**; recorder **1** (decisions/FK — causa raiz achada, migration 0016 pendente); paper 15 × `FEATURES_WINDOW_FAILED` (pendência pré-existente de 27/08, taxa até menor) + o engate único do kill switch às 20:59; resolution 3 (burst único às 21:51 de `RESOLUTION_MARKET_METADATA_VERSION_MISSING` + cascata fail-closed de um ciclo, classe pré-existente, auto-recuperado) |

**Zero erros novos causados pelo bloco.** Os quatro sinais de verificação do
bloco: #50 e #53 **fechados**; #51 e #52 com evidência inicial positiva e soak
de 24–48 h em curso (o do #52 depende do rearme).

### Registro de execução

Deploys desta sessão, todos pelos TRÊS passos (merge → CD → rebuild de
profile, confirmado por grep no disco antes de cada rebuild e por
`release-sha` dentro do container depois): recorder rebuildado 2× (#50 às
19:50Z, #54 às 21:19Z), portfolio+paper+resolution juntos às 20:36Z (#51–#53,
config + binário na mesma janela). Higiene: o worktree local usou
`git stash push -u` com tag única e `apply` por SHA (o protocolo de stash
compartilhado), e um `git checkout HEAD --` em branch errado custou uma
reaplicação de edições — nada chegou ao servidor fora do CD.

## SESSÃO 2026-08-31 — RE-MEDIÇÃO DO BLOCO DE 28/08 (regra de parada honrada)

O prompt do bloco de hotfixes (retenção, fingerprint G2/G5, throughput de
fills, coletor onchain) foi recebido de novo em 2026-08-31. A regra 2 do
próprio bloco manda re-medir cada defeito em produção antes de corrigir e
**parar a correção se a medição contradisser o defeito** — foi o que aconteceu
nas quatro: todas já estavam corrigidas pelos PRs #50–#54 de 2026-08-28.
**Nenhum código, config ou migration nesta sessão; o único deploy foi o do
próprio registro (docs-only, PR #56).** O que segue é a
verificação contínua, medida em produção somente leitura (2026-08-31
~13:10–13:25Z), que fecha os soaks pendentes do bloco.

Release verificado DENTRO dos containers (`/etc/ganso/release-sha`, nunca
`compose ps`): recorder `24e1c91` (#54); portfolio, paper e resolution
`fbf3cd6` (#51–#53) — exatamente o registrado em 28/08; nada mudou no servidor
desde então.

| Re-medição   | Resultado (produção, 2026-08-31)                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #50 retenção | Defeito ausente. `book_deltas` está com `n_dead_tup = 0` e 28 GB físicos — o cenário exato da degeneração antiga — e mesmo assim **zero `RETENTION_QUOTA_UNMET`, zero pedido de exclusão e zero `QUOTA_GLOBAL_TTL_REDUCED`** em 24 h, com 96.757.954 linhas vivas. Varredura de 30/08 22:09Z: `RETENTION_BLOAT` informativo nos dois snapshots (físico > vivo medido, quota satisfeita) |
| #51 G2/G5    | **SOAK FECHADO.** Os únicos 2 `PORTFOLIO_G2_CLOCK_RESET` na vida do container são o reset final do deploy (28/08 20:38:47Z, crypto+macro, `regime_fingerprint_changed`). Desde então, **zero resets em ~65 h** sob rotação normal do universo (antes: ~5/dia). O relógio do G2 acumula janela contínua desde 20:38:47Z                                                                  |
| #52 lag      | Fix no ar; **soak segue impossível de medir**: kill switch engatado desde 28/08 20:59:32Z (`RECORDER_STALE`), **zero ordens paper criadas em ~2,7 dias**. Zero cancelamentos no período. Rearme é 1 clique do proprietário no painel (PR #46)                                                                                                                                           |
| #53 onchain  | Saudável e contínuo: **195 linhas** em `resolution_onchain_events` (53 → 195 desde 28/08), cursor dos 4 adapters em 92.985.016 e avançando, `ONCHAIN_POLLED` inserindo às 13:14Z, **zero `JOB_FAILED job:"onchain"` em 24 h**                                                                                                                                                           |
| Banco        | 50 GB (`book_deltas` 28 GB físicos; `portfolio_decisions` 2,42 GB; `portfolio_panel_snapshots` 796 MB). Disco do host: 54 G/301 G (19%)                                                                                                                                                                                                                                                 |
| RAM          | recorder 182/832 MiB; portfolio 43/192; resolution 136/192; paper 31/256; postgres 800 MiB/1 GiB (era 357 MiB em 28/08 — observar)                                                                                                                                                                                                                                                      |
| Erros em 1 h | recorder, portfolio e paper: **zero**; resolution: 6, todos da classe pré-existente abaixo                                                                                                                                                                                                                                                                                              |

### Dado para a redeclaração da quota de `book_deltas` (decisão do proprietário, pendente)

Pós-repack (28/08 21:06Z, 19 GB físicos) → 31/08 13:20Z, 28 GB físicos:
**+9 GB em ~2,7 dias ≈ 3,3 GB/dia físico líquido** — bem abaixo dos ~15 GB/dia
pré-repack (arquivo compacto, sem herdar bloat). 96,76 M linhas vivas. A
semana de observação decidida em 28/08 fecha **~2026-09-04**; redeclarar com
esse dado.

### Classe pré-existente virou recorrente (registrada; fora do escopo do bloco)

O `RESOLUTION_MARKET_METADATA_VERSION_MISSING` que em 28/08 21:51Z apareceu
como burst único auto-recuperado agora recorre: **63 falhas de `state_tick` em
24 h**, espalhadas 1–5/hora, com **91 `condition_id` distintos, cada um
falhando UMA vez** (não é poison pill: é mercado entrando no escopo terminal
antes de a versão de metadado as-of existir; no ciclo seguinte passa). Cada
falha derruba em cascata fail-closed o `graph_eval` e o `heartbeat` daquele
ciclo (57 + 57 em 24 h) e se auto-recupera: na última hora foram 72
`GRAPH_EVALUATED`, 58 `RESOLUTION_HEARTBEAT`, 13 `GRAPH_BUILT` e 8
`SCORES_RECOMPUTED` contra 6 falhas. O gap de um ciclo é exatamente o
transitório que a graça de 180 s do #52 absorve sem cancelar ordem. A taxa é
provavelmente proporcional a mercados indo a terminal (~90/dia). Corrigir a
classe é trabalho novo, fora deste bloco — registrado para priorização.

### Itens de observação da retenção (warn, não erro)

- `RETENTION_QUOTA_NO_PROGRESS` em `paper_feature_windows` (após podar 304.487
  linhas) e `portfolio_panel_snapshots` (após 93.493), ambos com
  `cutoff == floor` — a poda converge por varredura diária sem passar do floor
  persistido do #50. Observar se as duas quotas fecham nas próximas varreduras.
- O `RETENTION_STEP_FAILED` diário de `portfolio_decisions` ("Query read
  timeout") continua — é o bloqueio da **migration 0016** (pendente de
  autorização); a tabela está em 2,42 GB e cresce ~0,45 GB/dia como previsto.

### Pós-merge do registro (PR #56, 13:39–13:45Z): o CD reiniciou os profiles — e isso virou verificação extra

- O CD do merge docs-only **reiniciou** os containers de profile sem trocar
  imagem (`release-sha` idênticos antes/depois: recorder `24e1c91`, demais
  `fbf3cd6`; logs preservados — foi restart, não recreate).
- **Bônus do #51**: o relógio do G2 **sobreviveu ao reboot sem reset** — o
  fingerprint determinístico do schedule foi reconstruído igual no boot; os
  únicos 2 `PORTFOLIO_G2_CLOCK_RESET` da vida seguem sendo os do deploy de
  28/08 20:38:47Z.
- Varredura de boot da retenção (13:41–13:44Z) coerente com o vivo real:
  podas por quota de 894.170 linhas em `book_snapshots` (cutoff 26/08
  10:09Z) e 297.840 em `book_snapshots_full` (até o floor, depois
  `NO_PROGRESS`); o `RETENTION_STEP_FAILED` de `portfolio_decisions`
  (migration 0016) recorreu como esperado. **Nenhum pedido acima do vivo.**
- `MACRO_CALENDAR_SYNC_FAILED` no boot — a fragilidade conhecida de 23/08
  (sync só no boot, sem retry; o postgres reiniciou junto). **Sem perda**:
  arquivo e banco têm as mesmas 15 entradas. Resolution pós-restart: **zero
  erros**.

### Migration 0016 AUTORIZADA E APLICADA (mesma sessão, 14:26–14:40Z) — a poda de decisions fechou pela primeira vez

**FATO INFORMADO:** o proprietário autorizou a migration 0016 (o bloqueio com
condição de parada registrado em 28/08).

**Re-medição antes da correção (regra do bloco):** índice ausente em produção
(só `pkey`, `UNIQUE(token_id, computed_at)`, `received_at_idx` e
`latest_idx`); `portfolio_decisions` em 2.443 MB / 596.751 linhas contra
quota de 0,9 GB; um `RETENTION_STEP_FAILED` por varredura — dois só em 31/08
("Query read timeout" às 13:44Z, "canceling statement due to statement
timeout" às 13:55Z). Panel com 214.979 linhas, todas com `decision_id`
preenchido.

**Execução (PR #58, CI verde, `make verify` verde):**

- Migration `0016_portfolio_panel_snapshots_decision_id_index.sql`: um
  `CREATE INDEX IF NOT EXISTS` em `portfolio_panel_snapshots (decision_id)`;
  0014/0015 intocadas. Validada pelo protocolo do `apply.sh` em PostgreSQL
  18.4 descartável: 0001–0015 sem o índice (regressão demonstrada no código
  anterior), 0001–0016 cria e registra (`schema_versions` = 16), re-execução
  idempotente, e o UPDATE com o shape do RI trigger passa a usar o índice.
- **Protocolo da 0013 para banco grande**: índice construído em produção com
  `CREATE INDEX CONCURRENTLY` ANTES do merge — **0,42 s**, `indisvalid = t`,
  4,75 MB (215 k linhas). O statement da migration virou no-op inerte via
  `IF NOT EXISTS`; o CD aplicou e registrou a versão 16 às 14:35:07Z.
  Nenhum rebuild de profile (mudança só de banco).

**FATO VERIFICADO (produção, 14:35:43Z, varredura de boot pós-CD):** a poda
de `portfolio_decisions` fechou **pela primeira vez na vida do sistema** —
`RETENTION_PRUNE cause:"quota" rows_deleted: 449.553` (76% da tabela) em
segundos, seguido do `ANALYZE` do #50, **zero `RETENTION_STEP_FAILED`**.
Estado final: 143.106 linhas vivas (~0,6 GB vivo < quota de 0,9 GB); o físico
segue 2.447 MB até o autovacuum reciclar (o medidor do #50 não herda arquivo,
então isso é bloat, não decisão). A FK fez o `SET NULL` desenhado em 67.829
das 215.942 linhas do panel. Um `RETENTION_QUOTA_NO_PROGRESS` logo após o
prune (`cutoff == floor`, corte interpolado limitado a 0,9 por rodada +
stats defasadas) — a varredura diária de ~22:09Z deve sair silenciosa; se
repetir com quota não satisfeita, converge por varredura como nas outras
tabelas. Terceiro restart do dia e o relógio do G2 continua sem reset (os 2
da vida seguem sendo os do deploy de 28/08); único erro pós-deploy é o
`MACRO_CALENDAR_SYNC_FAILED` de boot (classe de 23/08, sem perda — 15
entradas no arquivo e no banco).

## SESSÃO 2026-08-31 (noite) — HOTFIX do `RESOLUTION_MARKET_METADATA_VERSION_MISSING` recorrente

A classe registrada de manhã como "pré-existente virou recorrente" foi
diagnosticada, medida e corrigida (PR #61). **Sem migration**: a 0011 e a 0012
seguem intocadas, e o fail-closed do mapeamento não foi afrouxado em nenhum
ponto.

### Re-medição antes de codar (regra de parada honrada — o defeito EXISTIA)

Produção somente leitura, 2026-08-31 ~19:53–20:00Z, container de resolution com
log contínuo desde 28/08 20:38Z:

| Medida                                            | Valor                                                     |
| ------------------------------------------------- | --------------------------------------------------------- |
| Falhas de `state_tick` em 24 h                    | **78** (233 na vida do container: 9 em 28/08, 85, 77, 62) |
| `condition_id` distintos nas 78                   | **75** — cada mercado falha uma vez, não é poison pill    |
| Mercados scoreable AGORA sem metadata             | **0 de 171** — nenhum mercado legítimo pendente           |
| Estados não-`NONE` fora do scoreable sem metadata | **0** — sem risco de crash-loop no boot                   |

### Causa raiz medida — DUAS populações, um mesmo trigger

O trigger `universe_membership_input_change_trg` (migration 0011) journaliza
**todo** insert em `polymarket_universe_log`. O `state_tick` transforma o
`condition_id` de cada mudança em alvo de recompute; alvo fora do conjunto
scoreable cai no `marketsByIds`, cujo fail-closed de mapeamento **aborta o tick
inteiro** (e em cascata o `graph_eval` e o `heartbeat` daquele ciclo).

1. **44 de 78 (56%) — linhas `rejected_filter`.** Mercados que a seleção de
   universo descartou: **não estão em `polymarket_markets`**, nunca chegam ao
   registry e **nunca terão versão de metadata**. Não é corrida — é escopo: o
   `loadScoreableMarkets` lê só `enter`/`exit`, mas o journal captura a rejeição
   também. Volume: **674 rejeições/dia**; e as **9.925 mudanças sem metadata
   desde 20/08 vêm TODAS de `universe_membership`** — nenhuma outra fonte
   (`resolution_event`, `param_version`, `rule_version`, `event_membership`,
   `market_metadata`) jamais produziu uma. O erro dispara ~4,2 s depois da
   linha de rejeição.
2. **34 de 78 (44%) — corrida na entrada.** O `enter` era logado para todos os
   entrantes **antes** do laço que persiste registry e metadata. Medido: o erro
   dispara **0,41 s depois do `enter`** e **0,43 s antes da primeira versão de
   metadata** (`version = 1` em todos). Em 3 dos 34 o `valid_from` já era
   anterior ao erro por ~30 ms — carimbo antes do COMMIT, mesma corrida.

**Por que cada mercado falha só uma vez:** o tick que falha não avança o cursor
(o UPDATE é da mesma transação), mas marca `recoveryRequired`; o tick seguinte
entra em `bootGenerationUnlocked`, que faz **recompute completo** e salta
`processed_input_change_id` direto para o `MAX(input_change_id)`. Nada é
perdido — a varredura de boot cobre todo o conjunto scoreable — mas a mudança
ofensora é pulada, o que explica o "auto-recuperado no ciclo seguinte" e
absorve as ~630 rejeições/dia que não chegam a virar erro.

### Correção (PR #61)

- **`resolution/runner.ts`** — a leitura do journal passa a resolver a ação do
  `polymarket_universe_log` (mesmo `LEFT JOIN` que já resolvia evento e regra) e
  uma mudança que não seja `enter`/`exit` **não nomeia alvo de recompute**. A
  mudança continua consumida: o cursor avança e o lote segue contando como uma
  revisão de grafo (cadência de `GRAPH_BUILT` preservada de propósito). O skip é
  tipado e contado — `RESOLUTION_INPUT_CHANGE_OUT_OF_SCOPE {source, skipped}`.
- **`registry.ts`** — o `enter` passa a ser inserido **dentro da transação** que
  aplica a observação de metadata, no **mesmo instante** (`enter.at ==
metadata.valid_from`). Uma leitura as-of que enxerga a associação enxerga o
  mapeamento. Efeito colateral desejado: entrante cuja metadata falha **não vira
  membro** naquele ciclo (antes virava, com `logSafely` engolindo a falha) — é
  retentado no ciclo seguinte, e `entered` passa a contar entradas commitadas.

**O fail-closed não mudou:** `loadScoreableMarkets` e `marketsByIds` continuam
lançando `RESOLUTION_MARKET_METADATA_VERSION_MISSING`, e há teste novo provando
que um membro (`enter`) sem mapeamento **ainda derruba o tick** e **não avança o
cursor**. Nenhum mapeamento de token é inventado em lugar nenhum.

### Testes

- `registry.test.ts`: o `enter` é inserido na mesma transação (profundidade 1) e
  **depois** da versão de metadata, com `at == valid_from`; e um entrante cuja
  metadata falha **não** vira membro. As duas **falham no código anterior**.
- `runner.test.ts`: uma mudança `rejected_filter` é consumida (cursor avança,
  grafo reconstrói, evento tipado emitido) sem nunca virar alvo, enquanto um
  `enter` no mesmo lote continua sendo recomputado — **falha no código
  anterior**; e o teste de fail-closed acima, que passa nos dois (é invariante).
- `make verify` verde; suíte de resolution + registry + samplers + recorder:
  337 testes.

### FATO VERIFICADO — deployado e confirmado em produção (2026-08-31 20:14–20:45Z)

Deploy nos três passos: merge (PR #61, CI verde) → CD (`8b0b5b7`, run verde,
migrations sem mudança — nenhuma migration nesta entrega) → **rebuild dos DOIS
containers de profile** (`polymarket-resolution` e `polymarket-recorder`, ambos
tocados pelo fix). Código confirmado no disco por grep antes do rebuild
(`universe_action` ×3 e `RESOLUTION_INPUT_CHANGE_OUT_OF_SCOPE` no runner, o
`enter` transacional no registry) e `release-sha` **`8b0b5b7`** conferido
**dentro** dos três containers (resolution, recorder e api) — nunca por
`compose ps`. Boot limpo: `SCORES_RECOMPUTED trigger:"boot" scored:171
failed:0`, zero erros.

**As duas causas foram verificadas com o input que as disparava, não por
ausência de erro:**

- **Causa 1 (rejeições).** 20:29:17Z o ciclo Gamma gravou 3 `rejected_filter`
  para mercados com **0 linhas em `polymarket_markets` e 0 versões de
  metadata** — a população exata. 11 s depois o tick consumiu as 3 e registrou
  `RESOLUTION_INPUT_CHANGE_OUT_OF_SCOPE {source:"universe_membership",
skipped:3}`, **sem `JOB_FAILED`**. Antes do fix esse input produzia
  exatamente um `RESOLUTION_MARKET_METADATA_VERSION_MISSING` e derrubava o
  `graph_eval` e o `heartbeat` do ciclo.
- **Causa 2 (corrida na entrada).** O mercado `0x05f71a3164a3` entrou às
  **20:39:18.304Z** e sua **primeira versão de metadata (`version = 1`) tem
  `valid_from` idêntico — 20:39:18.304Z**. Mesmo instante, mesma transação.
- **O lote misto que a regressão modela aconteceu de verdade**, às 20:39:27.841Z
  num único tick: `RESOLUTION_INPUT_CHANGE_OUT_OF_SCOPE skipped:8` +
  `SCORES_RECOMPUTED trigger:"rule_change" scored:171 failed:0` +
  `GRAPH_BUILT nodes:62` (subiu de 61 — o entrante entrou no grafo). As
  rejeições foram absorvidas e a entrada real foi pontuada no mesmo lote.

| Medida (janela de 26 min pós-deploy)              | Antes                    | Depois                                                    |
| ------------------------------------------------- | ------------------------ | --------------------------------------------------------- |
| `RESOLUTION_MARKET_METADATA_VERSION_MISSING`      | ~78/dia (~1,4 na janela) | **0**                                                     |
| `JOB_FAILED job:"state_tick"`                     | idem                     | **0**                                                     |
| Erros (`level:error`) no resolution               | 6/h                      | **0**                                                     |
| Erros no recorder                                 | 0 na classe              | **0**                                                     |
| `SCORES_RECOMPUTED` / `GRAPH_BUILT`               | 9 / 15 por ~45 min       | 3 / 5 por 26 min — cadência preservada                    |
| `GRAPH_EVALUATED` / `RESOLUTION_HEARTBEAT`        | 76 / 61 por ~45 min      | 30 / 25 por 26 min                                        |
| `REGISTRY_PERSIST_FAILED` / `UNIVERSE_LOG_FAILED` | 0                        | **0** — entradas não foram bloqueadas pela transação nova |

Os inputs que disparavam as duas causas **chegaram** na janela (11 rejeições e
1 entrada) e nenhum virou erro. A verificação de 24 h que resta é confirmatória:
o alvo é taxa 0 sustentada — qualquer reaparecimento seria uma terceira
população, e a medição de 20/08–31/08 diz que ela não existe (as 9.925 mudanças
sem metadata do histórico vêm 100% de `universe_membership`).

**Ponto a observar:** com o `enter` dentro da transação de metadata, um entrante
cujo `applyMarketMetadataObservation` falhar **não vira membro** naquele ciclo
(antes virava, com `logSafely` engolindo a falha) — é retentado 10 min depois e
aparece como `REGISTRY_PERSIST_FAILED`. Zero ocorrências até agora.

### Carona não executada — o 500 do `GET /polymarket/decisions`

Não reproduzível: o container `ganso-market-api-1` foi **recriado às 19:17:33Z**
(CD do PR #60) e o log de 18:21:11Z não existe mais. O endpoint responde **200**
agora (medido às 20:01Z, duas requisições). Não é módulo adjacente a este fix —
fica para prompt próprio, com a observação de que qualquer investigação precisa
de log preservado ou de reprodução ao vivo.

## SESSÃO 2026-08-31 (noite, 2) — NOWCAST OFICIAL NO CALENDÁRIO MACRO + SYNC COM RETRY (PR #63)

Duas entregas e **uma medição que desmente a premissa do trabalho**. A medição
vem primeiro porque muda o que se pode prometer.

### A medição: o consenso faltando NÃO era o gargalo da categoria macro

A premissa herdada era "`macro_scheduled` abstém em TODO mercado por falta de
consenso". Rodei o parser real (`parseMacroMarket`) contra os **22 mercados
macro de produção**, com as regras e a metadata puxadas do banco. Resultado:

```
 22  UNRECOGNIZED_VARIABLE
```

Os 22 falham no **primeiro portão** do parser, muito antes de o consenso ser
lido:

- **20** são mercados de **MUDANÇA** de juros ("decrease by 25 bps", "N Fed rate
  cuts in 2026"). O texto casa `hasFed`, mas dispara o veto
  `RATE_CHANGE_PHRASES` — este modelo precifica **nível**, não variação. O veto
  está **certo**; o mercado é que é de outra natureza.
- **1** é Bank of England (não é o Fed).
- **1** é "Strait of Hormuz traffic returns to normal" (não é variável macro).
- **0** são de CPI ou de emprego. Não existe mercado de nível no universo.

Ou seja: encher o calendário de consenso **não destrava nenhum dos 22**. É a
lente de degeneração de gate aplicada a um prompt de dado — a verificação
prometida ("`macro_scheduled` passa a emitir estimativa") passaria vazia, porque
não há mercado elegível para comparar. Está registrado no PR e aqui em vez de
ser contornado.

**O gargalo real, e é decisão do proprietário:** o modelo precifica nível e o
universo macro da Polymarket é de mudança. Destravar de verdade exige variável
nova (`fed_rate_change_bps` ou equivalente, com o parser lendo brackets de
25 bps) — escopo de RFC, não de PR de dado. Enquanto isso a categoria macro
segue sem produzir evidência de modelo, e a segunda categoria do G2 continua
dependendo de entradas por baseline.

### Entrega 1 — nowcast oficial, keyed por variável (sem migration)

`config/macro-calendar.json` não tinha consenso em nenhuma das 15 entradas.
Agora **uma** tem, a única com fonte oficial hoje: `cpi-2026-09` (que publica o
dado de **agosto**/2026, `period: M08`), com o nowcast do **Cleveland Fed** lido
em 2026-08-31 (tabela atualizada em 08/31):

| variável       | valor |
| -------------- | ----- |
| `cpi_yoy`      | 3.37  |
| `cpi_mom`      | 0.36  |
| `core_cpi_yoy` | 2.38  |

URL, publicador, DOI, data de atualização da fonte e data de leitura ficam em
`_consensus_source`, na própria entrada. **Sem `consensus_std`**: o publicador
não divulga dispersão para o nowcast, então o modelo cai em
`macro.default_sigma` e grava `macroSigmaSource: "config_default"`. Inventar
sigma seria inventar input.

As outras 14 seguem **sem** consenso, de propósito, com o motivo de cada família
registrado em `_consensus_absent` no próprio arquivo:

- `cpi-2026-10..12` — o Cleveland Fed faz nowcast só do **período corrente**;
  em 31/08 as tabelas traziam agosto/2026 e 2026:Q3 e nada além;
- `nfp-*` — nenhum publicador oficial de consenso de payrolls/desemprego é
  nomeado na RFC-010 nem neste handoff;
- `fomc-*` — a **CME FedWatch publica distribuição sobre faixas de 25 bps**, não
  nível com dispersão. Em 31/08 estava **bimodal** (~66% em 3,75–4,00%, ~34% em
  3,50–3,75%), **sem massa na média das duas**. Espremer isso na normal que o
  modelo centra no consenso seria estimativa nossa, não número do publicador;
- `gdp-*` — BEA não é variável de `macro_scheduled` 1.0.0.

**Por que keyed e não um número solto** (isto é um defeito latente que o PR
fecha antes de abrir): `matchCalendar` casa mercado e entrada por **família**, e
um release publica várias variáveis — o CPI carrega `cpi_yoy`, `cpi_mom` e
`core_cpi_yoy` de uma vez. Um `consensus: 3.37` solto seria servido às três, e
um mercado de `cpi_mom` (limiar ~0,3) sairia com mu=3,37 → q travado em 0,999,
**em silêncio**: o guarda de `MACRO_RELEASE_MAX_SIGMAS` só existe no regime
pós-release. `readConsensus` passa a ler `consensus_by_variable[variable]` antes
das chaves soltas, que seguem válidas para família de uma variável só (FOMC).
`MACRO_FEATURE_SET_VERSION` **1.0.0 → 1.1.0** (o `FEATURE_SET_VERSION`
compartilhado de `features.ts` continua 1.0.0 — são versões diferentes, e a
linha `ESTIMATOR_CYCLE` loga a compartilhada).

### Entrega 2 — sync do calendário no job de 10 min (a fragilidade de 23/08)

O sync rodava **só no boot e sem retry**; o CD reinicia os profiles a cada
merge, então `MACRO_CALENDAR_SYNC_FAILED` recorria em todo boot que perdesse a
corrida com o postgres, e a edição do arquivo se perdia em silêncio até um
restart seguinte ganhar a corrida. **A ocorrência mais recente está no log e é
de uma hora antes deste PR: `2026-08-31T20:53:49Z`, no CD do #62.**

`createCalendarSync` (em `macro.ts`) roda agora também dentro do job
`macro_releases` (10 min), **mantendo** o sync de boot. Logging pensado para
operação: **falha loga em toda passada** (senão "zero não-recuperado em 24 h"
não é verificável); **sucesso loga** no boot, quando versionou algo, ou quando
recuperou (`recovered: true`); regime estável fica silencioso. Ambas as linhas
ganham `trigger` (`boot` | `scheduled`).

### FATO VERIFICADO — deployado em produção (2026-08-31 22:08–22:20Z)

Três passos na mesma janela, com a guarda de confirmar o código no disco antes
de rebuildar:

1. **Merge + CD** (22:08:21Z, sucesso). A config chegou ao servidor e o boot
   sync da imagem **antiga** já gravou `cpi-2026-09` **versão 2** às
   `22:11:48Z` — a ordem é segura nos dois sentidos: estimator velho + config
   nova lê chave solta, não acha, e abstém.
2. **Rebuild de `polymarket-recorder` E `polymarket-estimator`** (22:19:33Z). O
   estimator entrou porque o código do modelo foi tocado — o prompt previa que
   não seria, e a razão medida está acima.
3. **Confirmado no runtime**: o boot log novo traz
   `MACRO_CALENDAR_SYNCED {"inserted":0,"trigger":"boot","recovered":false}` —
   os campos novos provam que a imagem nova está de pé. O bundle deployado tem
   as duas chamadas (`runOnce("boot")` na linha 318 e `runOnce("scheduled")` na
   366 de `dist/polymarket/orchestrator.js`).
4. **A passada AGENDADA foi observada rodando**, e sem log — que é o
   comportamento desenhado. Prova positiva por contador de catálogo:
   `pg_stat_user_tables.idx_scan` de `polymarket_macro_calendar` saiu de **2250**
   (22:20:25Z) para **2266** (22:30:04Z), +16 exatamente no tique de
   `macro_releases` de ~22:29:33Z — 10 min após o boot das 22:19:33Z; 15 SELECTs
   do `syncCalendar` (um por entrada) mais o `DISTINCT ON` do `pollOnce`. E o
   container tem **uma única** linha `MACRO_CALENDAR` na vida: a do boot. Ou
   seja, o sync agendado roda, não escreve nada quando nada mudou, e fica
   silencioso — sem as 144 linhas/dia que a alternativa produziria.

Banco, medido às 22:20Z:

| medida                                | valor                                                      |
| ------------------------------------- | ---------------------------------------------------------- |
| linhas em `polymarket_macro_calendar` | 16 (15 v1 + `cpi-2026-09` v2)                              |
| entradas com `consensus_by_variable`  | 1                                                          |
| conteúdo                              | `{"cpi_mom": 0.36, "cpi_yoy": 3.37, "core_cpi_yoy": 2.38}` |
| `read_at` da proveniência             | `2026-08-31`                                               |

### Testes

- `createCalendarSync`: falha no boot (postgres frio) + sucesso no ciclo
  seguinte → banco **converge com o arquivo**, `recovered: true`; edição do
  arquivo com o processo de pé é capturada; falha persistente continua logando
  e nunca lança; arquivo ausente vira `MACRO_CALENDAR_FILE_MISSING`.
- Modelo: a mesma entrada serve `cpi_yoy`/`cpi_mom`/`core_cpi_yoy` com os três
  valores certos (o `cpi_mom` fica em 0,773 em vez de saturar em 0,999 — que é
  exatamente o erro que a forma keyed evita); silêncio sobre uma variável faz
  **abster** em vez de pegar a irmã; keyed tem precedência sobre solto; solto
  segue funcionando para FOMC.
- **Forma do arquivo, em CI**: todo consenso publicado tem de ser keyed, com
  variável conhecida, `url` https e `read_at` datado. O PR que colocar chave
  solta ou valor sem fonte **reprova**. É onde a invariante da RFC-010 passa a
  ser executável em vez de prosa.
- `make verify` verde; **1408 testes da API** passam.

### Processo registrado (o nowcast envelhece)

`docs/runbooks/polymarket-fundamental.md` ganhou a seção "Atualizar o
consenso/nowcast do calendário macro": forma do campo, **quando** atualizar (na
semana anterior a cada release; depois de cada release publicado; quando a fonte
revisa o método), o passo a passo, e por que a FedWatch não vira consenso de
`fed_target_rate`. `docs/runbooks/polymarket-recorder.md` ganhou o verbete de
incidente do `MACRO_CALENDAR_SYNC_FAILED` (deixou de ser terminal; só agir se
repetir por mais de ~20 min). **Nenhuma coleta automática de site externo foi
criada** — dependência nova é decisão do proprietário.

### FATO VERIFICADO — a recuperação aconteceu sozinha, em produção, 20 min depois

O ciclo completo do defeito e da correção foi observado **sem ser provocado**,
no CD do PR #64 (docs-only — e o CD reinicia os profiles até em docs-only):

| instante        | linha                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `22:39:14.525Z` | `MACRO_CALENDAR_SYNC_FAILED` `{"trigger":"boot"}` — o recorder reiniciou pelo CD e o boot sync **perdeu a corrida com o postgres**. É exatamente a falha de 23/08. Antes deste PR, terminal até o próximo restart. |
| `22:49:15.516Z` | `MACRO_CALENDAR_SYNCED` `{"inserted":0,"trigger":"scheduled","recovered":true}` — **um único ciclo de 10 min depois**, o job convergiu e marcou a recuperação.                                                     |

`inserted: 0` porque nada tinha mudado no arquivo desde a v2 — o ponto é que a
passada agendada **rodou e fechou o buraco** que o boot deixou aberto. Se o
arquivo tivesse mudado naquela janela, a mudança teria entrado ali em vez de se
perder em silêncio, que era o comportamento antigo.

Isso é evidência melhor do que o teste unitário: a falha não foi induzida, foi o
CD normal do projeto produzindo a corrida que produz há semanas.

### O que fica aberto desta sessão

- **Soak de 24 h**: zero `MACRO_CALENDAR_SYNC_FAILED` **não-recuperado**. O
  primeiro par falha→recuperação já foi observado (22:39:14Z → 22:49:15Z, seção
  acima); o que resta é confirmar que nenhum caso fica sem o
  `MACRO_CALENDAR_SYNCED {"recovered":true}` depois.
- **Nenhuma estimativa macro de modelo é esperada** — e isso não é regressão. A
  verificação prometida no prompt ("linhas `MODEL/shadow` macro") **não pode**
  passar com o universo atual, pela medição acima. Não foi forçada.
- **Decisão do proprietário**: variável de mudança de juros para o
  `macro_scheduled` (ou aceitar que a categoria macro não produz evidência).

## SESSÃO 2026-09-01 — RFC-017: SHADOW REPLAY NOS DOIS MODOS (PRs #72 e #73)

**FATO INFORMADO:** o proprietário aprovou em 2026-08-28 os dois modos do shadow
replay — varredura de config (decisão 2 de 27/08) e replay contrafactual de
fonte. Escopo: ferramenta de leitura, sem tabela nova, sem painel, sem cunhar
versão de config.

**FATO VERIFICADO (produção, 2026-09-01, `release-sha`
`78333343b04b885872505d74c654d265b1aea05e`):** a ferramenta existe, roda os dois
modos sobre a janela inteira e **não escreve em lugar nenhum, por construção**.
A saída verbatim das duas rodadas está em
[`docs/test-results/RFC-017-shadow-replay.md`](test-results/RFC-017-shadow-replay.md).

### O que a medição desmente

**(1) O denominador honesto não é o log, são 9,05% dele.** `evaluateMarket`
recusa em escada, e todas as recusas acima da conta são decididas por escalares
já persistidos que nenhuma troca de config recomputa — `portfolio_state`,
`breaker_open`, `resolution_action`. Medido: **20.340 de 224.647** linhas
chegaram à conta, em **65 dos 322** mercados; metade do log (49,1%) é
`PORTFOLIO_CIRCUIT_BREAKER`. Uma varredura que dividisse flips por 224 mil
reportaria um número 11× menor que o real. A ferramenta publica o denominador
alcançável ao lado do total, nos dois modos.

**(2) `capitalCostAnnual` não é "quase inerte" — não muda nenhuma decisão.**

| valor | AÇÃO (linhas/mercados) | MOTIVO (linhas/mercados) | folga consumida |
| ----- | ---------------------- | ------------------------ | --------------- |
| 0,120 | 0 / 0                  | 0 / 0                    | 0,0000%         |
| 0,150 | 0 / 0                  | 0 / 0                    | 0,0000%         |
| 0,183 | 0 / 0                  | 0 / 0                    | 0,0001%         |
| 0,200 | **0 / 0**              | 269 / 1                  | 0,0318%         |
| 0,250 | **0 / 0**              | 282 / 1                  | 0,1310%         |
| 0,300 | **0 / 0**              | 282 / 1                  | 0,2301%         |
| 0,365 | **0 / 0**              | 284 / 2                  | 0,3590%         |
| 0,400 | **0 / 0**              | 284 / 2                  | 0,4284%         |

A busca de valor de virada, sobre as 20 decisões que os candidatos chegaram mais
perto de virar, **não acha mudança de AÇÃO em todo o bracket [0,12; 1000]** — nem
a 100.000% a.a. A causa é o lockup: o log tem **dois** (38 min e 3,67 h), e com
o hurdle do buffer em 0,0005/dia a carga máxima a r=0,40 é **0,0000827/ação**,
0,41% do `edgeLiqMin`. O parâmetro só voltaria a pesar com lockup de ~30 dias.

Corrige também o registro de 27/08 de que na **saída** os 12% "já são
vinculantes": o critério 6 (`edgeAtBid < remainingCapitalCost`) compara contra
0,000159/ação no pior caso a r=0,40 enquanto o critério 1 dispara em
`edgeResidualMin = 0,01`. Está **63× dentro** do critério 1 — só pode disparar em
posição que o critério 1 já tirou. Positivo não é vinculante.

**(3) Parte das decisões já usa o shadow (defeito ativo, da RFC-010).**
`estimateAsOf` (`store.ts:178`) não filtra `status` nem desempata, e cada
instante tem uma linha de consumidor (`active`) mais uma por modelo shadow, todas
com o **mesmo `decision_ts`**. Com **zero modelos promovidos**, **5 decisões** de
01/09 (13:03:43Z–13:50:44Z, 2 mercados) gravaram `estimate_source='MODEL'`: a
`decision_id` 698296 tem `q_lo=0,990385`, que é o `estimate_id` 837093
(`crypto_updown_gbm@1.0.0`, `shadow`), e não `0,997632` da linha ativa 837092 do
mesmo instante. Há **80.397 instantes** com mais de uma linha; passou a disparar
depois que o PR #70 acrescentou o segundo modelo shadow às 12:14Z. **Nenhuma das
5 foi aceita**, mas a invariante da RFC-010 ("shadow estimates … are invisible to
consumers", migration 0006) está quebrada. O conserto é um predicado
(`AND status = 'active'`) mais desempate determinístico, **é área da RFC-010 e
fica como decisão do proprietário**. O modo B detecta, exclui e conta esses casos
(`BASELINE_ALREADY_SHADOW = 5`) — comparar shadow contra shadow seria inventar o
resultado.

### Modo B — o que o shadow teria feito

Das **2.576** decisões que chegaram à estimativa e tinham linha shadow as-of
(dentro do TTL de 300 s), **519 (20,1%)** em **9 de 22 mercados (40,9%)** teriam
agido diferente. A assimetria é o número: **511 entradas só do shadow** contra
**8 só do baseline**; a transição dominante é
`LOWER_BOUND_BELOW_COSTS → ACCEPTED` (415 linhas). Exclusão dominante e honesta:
`SHADOW_MISSING` em 210.601 de 224.481 linhas — o shadow cobre `crypto_updown` e
o log tem 322 mercados.

**Mais entradas não é mais alpha, e o PnL que diria qual das duas coisas é ainda
não existe:** das 515 entradas contrafactuais, **0** está num token com label
final. A ferramenta reporta `515 considered / 0 settled` em vez de inventar um
número. **Re-rodar quando os labels chegarem.** O gate da RFC-010 segue soberano;
isto alimenta a decisão de promoção, não a substitui.

### Dois defeitos de medição pegos pela própria rodada, antes do número sair

- **AÇÃO estava somada a MOTIVO.** A estimativa `MARKET_BASELINE` sai do mesmo
  livro que o motor caminha, então `q` fica no microprice e as duas pernas
  **empatam exatamente**; `evaluateMarket` desempata com `>` estrito e a carga de
  capital, proporcional ao preço, desempata a favor da perna barata. 284
  rejeições trocavam de rótulo e continuavam rejeições. Contar isso como
  "veredito mudou" inflaria a mordida numa ordem de grandeza.
- **Os deltas vinham da coluna de 6 casas; o motor decide em 9.** A r=0,183 a
  carga que vira a perna é 2,5e-7/ação — 319 linhas trocam de perna enquanto
  `capital_cost` ainda imprime `0.000000`.
- E o **valor de virada** procurava qualquer mudança: na janela inteira ele achou
  0,419, que é uma troca de perna, e teria ido ao proprietário como "o número da
  1.3.0" (PR #73 separou AÇÃO de RÓTULO).

### Controle — a lente de degeneração, fechada com dado

O zero do `capitalCostAnnual` só vale se a ferramenta souber achar um flip quando
existe um. Rodando **a mesma janela, a mesma população, o mesmo binário** contra
`costs.edgeLiqMin` (0,02 → 0,03): **7 linhas em 2 mercados mudam de AÇÃO** e a
busca de virada devolve os valores um a um — 0,0204929, 0,0214201, 0,0223213,
0,0234751, 0,0251381 — em vez de `NONE`. A varredura não "passou porque não havia
contra o que comparar": o zero do `capitalCostAnnual` é um fato sobre o
parâmetro, não sobre a ferramenta nem sobre o tamanho da amostra.

### Invariantes e verificações

`replayDecision` e o `CONFIG_HASH_MISMATCH` **intocados** — a varredura os usa
como **teste de admissão**, e 224.647 de 224.647 decisões passaram (zero
mismatch, sobre a janela inteira e não só a amostra horária de 50). Nenhum
terceiro construtor de linha: só `decisionrow.ts` devolve `DecisionRow`, e o
mapeador de linha do `gatestore` foi **extraído** para o loader novo não virar um
segundo. Loader keyset com streaming (páginas de 500) — a janela cheia são
~620 MB de JSON contra o `mem_limit` de 384 MiB da `api`. Janela fechada no
`decision_id` do sumário, sem o que duas rodadas nunca bateriam: duas rodadas
sobre `decision_id <= 703817` deram agregados idênticos. `make verify` verde,
**1518 testes na API**. Sem migration. Modo A levou 1 min 27 s; modo B, 7 min 11 s.

### Próximo passo mínimo

Apresentar ao proprietário: (a) que a 1.3.0 não tem número a cunhar — subir a
taxa não muda nada enquanto o livro for intradia, e a decisão real é sobre o
universo; (b) o vazamento do shadow, que é um predicado de conserto na RFC-010;
(c) re-rodar o modo B quando os labels dos mercados que o shadow teria entrado
chegarem.

## SESSÃO 2026-09-01 — RFC-016: O INSTANTE REAL DE FIM, E A EVIDÊNCIA DA ÚLTIMA HORA QUE ERA DESCARTADA (PR #66)

**A re-medição desmentiu cinco das sete premissas do escopo aprovado em
2026-08-28**, e encontrou no lugar delas um defeito bem maior. A medição vem
primeiro porque foi ela que decidiu o desenho.

### O que o diagnóstico de 28/08 dizia, e o que a produção diz

Medido em 2026-08-31 entre 23:00Z e 23:20Z, contra o banco de produção e contra
a API pública da Gamma:

| Premissa de 28/08                        | Medido em 31/08                                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "gravamos só `end_date_iso` (date-only)" | **falso onde importa**: `polymarket_rule_versions.end_date` é TIMESTAMPTZ e já tem o instante cheio em **1005/1046** versões abertas (as 41 restantes são meia-noite de verdade — Fed, fim de ano) |
| "558 crypto ativos vencidos"             | reproduz como **703**, e **todas** são linhas de registro obsoletas de mercados que já saíram do universo. Membros com `end_date_iso` vencido: **0**                                               |
| "nenhum mercado com horizonte < 6 h"     | **2** membros < 1 h e **29** < 6 h no instante da medição                                                                                                                                          |
| "a cadência de 10 s nunca ativa"         | **ativa desde 23/08**: 3 tokens com gap mediano de **10,0 s** nos últimos 20 min, e **6.164 das 20.471** estimativas de 24 h no bucket `lt_1h` — o maior bucket do dia                             |
| "gap nos updown vivos = 60 s"            | o número está certo, a leitura não: 60 s é a mediana da **mistura**; na última hora de vida é 10 s                                                                                                 |
| "o cap rejeitou ~46 mercados/dia"        | última rejeição por cap em **2026-08-29 09:59Z**; **zero** nas últimas 24 h; universo em 83/100 mercados                                                                                           |
| "~1.586 enter/exit por semana"           | **confirmado**: 1.492 enter / 1.502 exit em 7 dias                                                                                                                                                 |
| Gamma devolve `eventStartTime`           | **`null` em 100 de 100** mercados crypto; `gameStartTime` também                                                                                                                                   |

O `end_date_iso` **é** date-only (1056/1056) e a Gamma **devolve** o instante
cheio. As duas coisas são verdade. O que não era verdade é que ninguém gravasse
o instante — `registry.ts` já o passa para `applyRuleObservation` desde a
RFC-007, e o horizonte das features lê essa coluna primeiro. Por isso a cadência
funciona.

### O DEFEITO REAL: a cadência de 10 s funciona e tudo que ela produz é jogado fora

Dos **onze** leitores de horizonte no código, nove leem a cadeia versionada e
acertam. Dois liam a coluna plana. Um deles é o label store:

`labels.ts` alimentava `publiclyKnowableInstant` com o date-only, e como esse
instante é o **mínimo** dos candidatos, o resultado era a meia-noite do dia do
vencimento — **1.572 de 1.670 labels (94%)** às 00:00:00 exatas, mediana **16 h**
adiantados (p90 20 h). E `calibration.ts` filtra a evidência com
`AND e.decision_ts < l.publicly_knowable_ts`:

| Conjunto                                          | Antes            | Depois (medido em produção) |
| ------------------------------------------------- | ---------------- | --------------------------- |
| Estimativas `MODEL` com label final, pontuáveis   | 36.212 de 74.412 | **74.412 de 74.412**        |
| Estimativas na **última hora de vida** do mercado | **0 de 8.063**   | **8.063 de 8.063**          |
| Labels com `publicly_knowable_ts` à meia-noite    | 1.572 de 1.670   | **48 de 1.672** (2,9%)      |

**Zero de 8.063.** A cadência de 10 s decidida pelo proprietário em 22/08 existe
para produzir exatamente essas estimativas, e cem por cento delas eram
descartadas antes de virar evidência. **É o mecanismo por trás do bloqueio "o
gate da RFC-010 não tem como acumular evidência" que este handoff carregava
desde 20/08.** Os 48 que restaram à meia-noite são meia-noite de verdade
(conferido: "Bitcoin Up or Down - August 21, 4:00PM-8:00PM ET" termina às
2026-08-22T00:00:00Z).

Defeito secundário, no paper: `paper/runner.ts` calculava `endDate - now` do
date-only, o que dá **negativo** quase o dia todo, e negativo satisfazia o teste
`<= 1 h` de `windowKindsForHorizon` — o token recebia o conjunto de janelas mais
**caro**, não o mais barato.

| Janelas de feature                                   | 6 h antes do deploy        | Depois do deploy |
| ---------------------------------------------------- | -------------------------- | ---------------- |
| `10s`                                                | 86.509                     | 14               |
| `1s`                                                 | 12.980                     | 2                |
| `1m`                                                 | 44.170                     | 1.710            |
| Fração das `10s` em mercado com horizonte real > 6 h | **75%** (63.951 de 84.772) | **0 de 14**      |
| Fração das `1s` idem                                 | **38%** (3.936 de 10.481)  | **0 de 2**       |

### O que foi entregue (PR #66, merge 2026-08-31 23:4xZ)

- **Migration 0017 (aditiva, aplicada pelo CD):** `polymarket_markets.end_ts
TIMESTAMPTZ` nullable, **sem backfill** — preenchida conforme a Gamma
  re-observa, o padrão do `questionID` da RFC-012 — mais um índice parcial
  `WHERE end_ts IS NOT NULL`.
- **Captura nos DOIS call sites** (lição do PR #49): o ciclo do registro e a
  varredura de pendentes, do mesmo payload. A varredura usa
  `applyMarketEndTsObservation`, uma escrita estreita que **nunca apaga** um
  instante conhecido, **nunca cria** linha, e **não dispara** o gatilho de
  captura de metadata da 0012 — verificado contra PostgreSQL real (1 versão
  antes, 1 depois de dois UPDATEs; e 1→2 ao mudar `question`, provando que o
  gatilho continua vigiando o que deve).
- **Duas ordens explícitas de resolução do horizonte.** As-of
  (`rule.end_date → end_ts → end_date_iso`): a regra versionada sempre ganha,
  porque `end_ts` é mutável in place e não sabe dizer o que valia no instante da
  decisão. Corrente (`end_ts → rule.end_date → end_date_iso`): para o label
  store, o paper e os payloads de leitura. **O fallback para a regra versionada
  é o que consertou o acervo histórico sem nenhum UPDATE retroativo** — os
  74.412 viraram evidência no dia do deploy porque todo mercado resolvido tem
  versão de regra, mesmo sem `end_ts`.
- **Cap do universo:** a série curta estava em prioridade **3 de 4** — o
  universo rápido era a primeira coisa a ser cortada quando o cap mordesse. Um
  updown dentro de 6 h sobe para 2, e **25 dos 100 slots** ficam reservados a
  mercados curtos, ordenados por quem vence antes; a reserva é oportunista e
  devolve à fila geral o que não usa. O motivo do `enter` passou a carregar o
  bucket de horizonte.
- **`end_ts` exposto** em `/polymarket/opportunities`,
  `/polymarket/resolution-risk` e no payload de mercado do read API, para a
  futura aba "Rápidos" da RFC-015. Sem location novo no Nginx.

### Fora do escopo original, com o motivo medido (aprovado pelo proprietário em 31/08)

- **`end_ts` NÃO entra em `polymarket_market_metadata_versions`.** O histórico
  as-of desse fato **já existe e está correto** em
  `polymarket_rule_versions.end_date`: versionada, com hash de conteúdo
  normativo (uma mudança de `endDate` abre versão nova por construção) e trigger
  append-only. É onde o `endDate` semanticamente mora — faz parte das regras de
  resolução, junto de `uma_end_date` e `custom_liveness`. Duplicar criaria
  **duas cadeias as-of para o mesmo fato**, e um backtest que lesse a errada
  produziria um horizonte divergente do que o estimador usou, sem como saber
  qual estava certo.
- **`event_start_ts` não foi criado.** `eventStartTime` vem `null` em 100/100
  mercados crypto medidos, e `gameStartTime` também. Coluna que a fonte nunca
  preenche é peso morto.

### VOLUMETRIA: o teto apertou, o piso não se moveu

O `MEASURED_ROW_SHARE` do `budget.test.ts` era de 22/08 e descrevia um universo
que não existe mais. Re-medido em 31/08 (48 h, amostra horária, horizonte as-of
pela versão de regra em vigor naquela hora, ponderado por tokens):

| Bucket   | Modelo de 22/08 | Medido em 31/08 |
| -------- | --------------- | --------------- |
| `lt_1h`  | 0,3%            | **6,32%**       |
| `1h_6h`  | 2,8%            | **9,55%**       |
| `6h_24h` | 7,4%            | **31,95%**      |
| `1d_7d`  | 14,5%           | **31,10%**      |
| `gt_7d`  | **75,0%**       | **21,08%**      |

Consequência: o **teto modelado** (200 tokens, todo token rendendo linha a cada
período de cadência, mais shadow) sobe de ~47 k para **~170 k linhas/dia**, e a
quota de 2 GB compra **6,2 dias** nele em vez dos ~24 que o modelo antigo
prometia. A **taxa realmente escrita** era de 20.818 linhas nas 24 h anteriores
ao deploy, e nessa taxa a mesma quota compra **~100 dias**.

**DECISÃO DO PROPRIETÁRIO (2026-08-31), consultado com os dois números:** manter
a quota em **2 GB** e tornar o teste honesto. O `budget.test.ts` passou a
assertar a **INVARIANTE** (`horizonte + 27 h` = 1,125 dia) sobre o **teto** — o
número mais pessimista disponível, que a clareia por **5,5×** — e a margem de
**7×** sobre a **taxa medida em produção**, que é onde a decisão de quota de
24/08 sempre a mediu. Também caiu a asserção "corta 4× versus a cadência plana",
que não vale mais (o corte real é ~1,7×, porque o universo migrou para
horizontes curtos), substituída pela que de fato importa: **mais de 75% das
linhas caem em `lt_1h`/`1h_6h`**, onde uma estimativa ainda pode virar
evidência, e menos de 5% na cauda `gt_7d`. **Nada em `RETENTION_TABLES` foi
tocado** — quota 2 GB, TTL 90 dias.

### Deploy e verificação em produção

**Os três passos, completos.** Merge do #66 → CD verde (que aplicou a migration:
`schema_versions` foi a **17** sozinha) → rebuild de profile em
`polymarket-recorder`, `-estimator`, `-paper`, `-portfolio` e `-resolution` às
**2026-08-31 23:57:35Z**. Todos os **seis** containers em
`/etc/ganso/release-sha` = `4bae1b92a1ffb8d9a2910470ccee3a8e1881161d`.

| Critério de aceite                                                   | Medido em produção                                                                                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `end_ts` preenchida nos membros do universo                          | **87 de 87 (100%)**, 81 com hora intradia; as 973 linhas obsoletas de mercados fora do universo seguem NULL, como o desenho prospectivo manda |
| Membros com fim real no passado                                      | **2 de 87** — os que acabaram de vencer e ainda não passaram pelo ciclo de saída (era 1 de 83 antes)                                          |
| Distribuição de horizonte pelo `end_ts`                              | 3 em `< 1 h`, 29 em `1h–6h`, 17 em `6h–24h`, 27 em `1d–7d`, 16 em `> 7d`                                                                      |
| Labels com knowable_ts à meia-noite                                  | **94% → 2,9%** (1.572/1.670 → 48/1.672), e os 48 são meia-noite real                                                                          |
| Estimativas MODEL pontuáveis                                         | **36.212 → 74.412** (100%)                                                                                                                    |
| Estimativas da última hora de vida, pontuáveis                       | **0 → 8.063** (100%)                                                                                                                          |
| Gap de estimativa na última hora de vida                             | **10,0 s** (o mercado das 00:00Z)                                                                                                             |
| Janelas `1s`/`10s` em mercado de horizonte real > 6 h                | **75% / 38% → 0 de 3.868 / 0 de 2** (amostra de 1 h 40)                                                                                       |
| Erros novos (recorder, estimator, paper, portfolio, resolution, api) | **0 em todos os seis**, acumulado em 37 min                                                                                                   |
| Bucket de horizonte no motivo do `enter`                             | **`priority_2_crypto_1d_7d`** às 00:27:46Z                                                                                                    |
| RAM                                                                  | recorder 155/832 MiB, resolution 44/192, estimator 33/192, paper 32/256, portfolio 30/192                                                     |

**Taxa de volume — a re-medir em 48 h.** Duas janelas pós-deploy: 443 linhas em
21,6 min (projeta ~29,5 k/dia) e **1.889 linhas em 1 h 40 (projeta ~27,0 k/dia)**,
contra as 20.818 das 24 h anteriores. As duas ainda são curtas, e a primeira é
enviesada pelo vencimento das 00:00Z de vários updown horários — o pico do
bucket de 10 s; a projeção cai conforme a janela cresce, como esperado. Mesmo a
~27 k/dia a quota de 2 GB compra ~78 dias, 69× o piso de 27 h;
`fundamental_estimates` está em 913 MB (44,6% da quota). **Re-medir em 48 h** e
comparar com o modelo do `budget.test.ts`.

**A medição de janelas do paper se sustentou com amostra 270× maior:** das
**3.868** janelas `10s` e 2 janelas `1s` computadas em 1 h 40, **zero** são de
mercado com horizonte real acima de 6 h. Antes eram 75% e 38%. O conserto não
matou a cadência fina — ele a apontou.

**Carimbo do bucket confirmado às 00:27:46Z**, no primeiro `enter` posterior ao
rebuild (a Gamma levou meia hora para publicar mercado novo):
`priority_2_crypto_1d_7d`, em dois mercados. O giro por bucket passa a ser
legível direto do log de membresia.

**Retenção: `paper_feature_windows` está descendo, como previsto.** Entrou no
deploy em 1095 MB contra 0,6 GB de quota (178%), com a poda batendo no piso
(`RETENTION_QUOTA_NO_PROGRESS`, cutoff = floor). Uma hora e quarenta depois:
**722 MB (117%)**. O acervo é **anterior** a esta RFC; o que ela fez foi fechar
a torneira, e a poda voltou a fazer progresso. **Verificar em 48 h** se fecha
abaixo da quota; se não fechar, é decisão de quota do proprietário.

**Um erro no recorder na hora seguinte, e não é regressão desta RFC:**
`MACRO_CALENDAR_SYNC_FAILED` com `trigger: "boot"` às 01:37:50Z, quando o CD do
PR #67 (docs) reiniciou os containers — a fragilidade conhecida que o PR #63
endereçou. O job de 10 min recuperou sozinho às **01:47:52Z** com
`MACRO_CALENDAR_SYNCED {"recovered": true}`, o mesmo padrão do PR #65. Os outros
cinco serviços seguem em zero erros.

Evidência completa em
[`docs/test-results/RFC-016-intraday-horizon.md`](test-results/RFC-016-intraday-horizon.md);
o documento em [`docs/rfcs/RFC-016-polymarket-intraday-horizon.md`](rfcs/RFC-016-polymarket-intraday-horizon.md).

## Próximo passo mínimo

A RFC-012 está **ativa em produção**. A RFC-013 tem as fases A–D mergeadas na
`main` e a migration 0014 aplicada, mas o serviço `polymarket-portfolio`
**ainda não existe no servidor** e a poda de `book_deltas` **ainda não roda**,
porque as duas coisas dependem do mesmo rebuild.

### 0. FEITO nas duas últimas sessões

PRs #37, #39, #40 e #41 mergeados e deployados; `polymarket-portfolio` criado no
servidor e corrigido; G1 confirmado em `INSUFFICIENT_DATA`. Nesta sessão: as
degenerações de **G2/G3/G4** fechadas com testes de regressão, o **registro da
aprovação do G6** implementado (relatórios + CLI), a **ponte de paper decidida
em documento**, e a config cunhada em **1.2.0**. O que segue é o que **ainda
não** foi feito.

### 1. (FEITO) Rebuild de profile com a config 1.2.0

Executado às 03:10Z de 2026-08-27, com `polymarket-portfolio` e `api`
reconstruídos. Boot confirmado em `config_version` **1.2.0** e o primeiro
relatório de gates cunhado (`report_id: 1`, `reason: "first_report"`).

### 2. Soak de 24 h

O segundo bloco de checagem **rodou** às 03:11Z de 2026-08-27 (seção acima) e
saiu limpo. O que falta é o soak: 24 h de observação contínua com os seis gates
medidos de hora em hora, `PORTFOLIO_REPLAY_OK` a cada ciclo, RAM estável e
nenhum `PORTFOLIO_GATE_REPORT_MINTED` inesperado — um relatório novo sem
mudança de veredito seria bug.

### 3. (ATIVA EM PRODUÇÃO) A ponte decisão → ordem de paper

Construída em 2026-08-27, com a provenance da entrada carimbada junto — o
requisito que a decisão 1 acrescentou. Detalhe e evidência na seção 13 de
[`docs/test-results/RFC-013-portfolio-engine.md`](test-results/RFC-013-portfolio-engine.md);
o desenho, agora com o que a implementação acrescentou, em
[`docs/architecture/decision-to-paper-bridge.md`](architecture/decision-to-paper-bridge.md).

- **Migration 0015** (a 0014 intocada): `paper_orders.decision_id` com índice
  único parcial, `'portfolio'` no CHECK de `source`, um CHECK que exige decisão
  se e somente se a fonte é `portfolio`, o índice parcial da fila da ponte, e a
  tabela `portfolio_position_entries` — imutável, `protected`, nunca podada.
- **Job `bridge`** a cada 30 s no runner do paper: lê o log (só leitura), revalida
  frescor de decisão e de livro, passa pela gate da RFC-012 com semântica de
  intent, chama `decideOrderType` + `acceptPaperOrder` em processo.
- **Carimbo** no passo 0 do ciclo `panel` do portfolio: preenche `paper_order_id`
  e grava a tese da entrada. A provenance entra **antes** do carimbo de propósito
  — o carimbo é o ponto de commit, então uma queda no meio custa um retry e não
  uma posição sem tese.
- **Dois defeitos de fail-open encontrados ao ligar a terceira fonte**, corrigidos
  antes de existirem: a ordem da ponte teria furado o **sanity veto** da RFC-012
  (três lugares decidiam por `source === "intent"`), e teria **desaparecido da
  lista de ordens abertas** (`parseOpenOrder` devolvia `null` para fonte
  desconhecida) — nunca preenchida, nunca cancelada, aberta para sempre.
- **Verificado** contra `postgres:18.4-bookworm` com as 15 migrations aplicadas:
  a matriz de recusa do banco, a ordem criada de ponta a ponta pelo caminho real
  de aceitação, e a provenance sobrevivendo à **exclusão** da linha de decisão.
  Gate de fonte completo verde (1.368 testes).

**FATO VERIFICADO — deployada em 2026-08-27 17:00Z** (PR #44, revisão
`be09bfcf` no servidor). Foram **dois** passos, não três, e um deles desmente
uma suposição que este handoff carregava:

- **O CD aplica as migrations.** O serviço `migrate` do Compose sobe junto no
  `up` do `server-update`, roda `apply.sh` e sai. Depois do CD a
  `schema_versions` já estava em **15**, com `portfolio_position_entries` e
  `paper_orders.decision_id` no banco, sem ninguém rodar nada à mão. O que o CD
  **não** faz continua sendo trocar a imagem dos containers de profile.
- **O rebuild de profile continua obrigatório e continua sendo a pegadinha.**
  Depois do CD, `docker compose ps` mostrava `polymarket-paper` como "Up About a
  minute" — mas `docker ps --format {{.CreatedAt}}` mostrava a imagem de
  **26/08 19:52**. O status é uptime do container, não idade da imagem; olhar o
  status teria feito a ponte parecer implantada sem estar. Rebuild executado em
  `polymarket-paper`, `polymarket-portfolio` e `polymarket-recorder` (este pela
  mudança na retenção).

Estado observado depois do rebuild:

| Sinal             | Valor                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| `PAPER_BOOT`      | 17:00:02Z, `execution_mode: paper`                                      |
| `BRIDGE_TICK`     | a cada 30 s, `considered: 0, accepted: 0, skipped: 0, aged_out: 38`     |
| `PORTFOLIO_BOOT`  | `config_version` **1.2.0**, hash `1c8a3316…` (inalterada)               |
| `PORTFOLIO_CYCLE` | `evaluated: 85`, `entrable: 0`, `positions: 0`, `open_breakers: 29`     |
| Erros em 5 min    | paper **0**, portfolio **0**, recorder **1** (o alarme de quota abaixo) |
| RAM               | paper 35,7 MiB/256; portfolio 28,4 MiB/192; recorder 92,7 MiB/832       |

**`aged_out: 38` é o resultado correto, não um defeito.** São as 38 entradas
aceitas que o motor gravou **antes** de a ponte existir; todas passaram da janela
de frescor de 30 s, e a ponte se recusa a executá-las contra um livro que já
andou. O contador cai sozinho conforme a quota poda o log (~3 dias). Enquanto
não cair, o `BRIDGE_TICK` sai em `warn` a cada 30 s com o mesmo 38 — ruidoso e
honesto. Se incomodar, o ajuste é contar só o que envelheceu **depois** do boot,
não silenciar.

Primeiro sinal a observar de verdade: **`paper_positions` ganhando linha**.
`paper_orders` crescendo sem posição nenhuma significa ordem passiva sem fill, e
o G2 continua parado. Com `entrable: 0` (nenhum modelo promovido na RFC-010) a
ponte pode ficar sem trabalho por bastante tempo — o que continua sendo o
resultado correto neste estado, não uma falha da ponte.

### 3b. Cadência de escrita do decision log (decisão 1, itens b e c)

Escrever a entrada só quando o veredito muda, como o ciclo de saída já faz;
medir antes o fator de redução real no log de produção (trocas de assinatura por
mercado por dia); registrar a interpretação de "toda intenção persiste"; e só
então TTL 180 → 90 em `retention.ts`. Fora do PR da ponte — são áreas
diferentes, e o carimbo de provenance é o que urge.

### 3c. Shadow replay de `custo_capital_anual` (decisão 2) — **FEITO, e a resposta não é um número**

**Entregue e rodado em produção em 2026-09-01** (RFC-017, PRs #72 e #73). A
varredura existe, roda sobre a janela inteira e é read-only por construção.

O que ela mede não é "qual taxa escolher", porque **nenhuma taxa da lista muda
decisão nenhuma**: com 0,15, 0,183, 0,20, 0,25, 0,30, 0,365 ou 0,40, a coluna
AÇÃO é 0 linhas / 0 mercados sobre as 20.340 decisões que chegam à conta, e a
busca de valor de virada não acha mudança de ação em todo o bracket
[0,12; 1000]. O lockup do livro é de horas; a carga máxima a r=0,40 é
0,0000827/ação contra um `edgeLiqMin` de 0,02.

**A decisão do proprietário muda de forma:** não é escolher entre 20% e 40%, é
decidir se o universo negociado deve passar a incluir horizontes de semanas — que
é onde o parâmetro volta a morder. Enquanto o livro for intradia, `1.2.0` e uma
hipotética `1.3.0` com 0,40 produzem **exatamente as mesmas decisões**.
Detalhe e tabela verbatim em
[`docs/test-results/RFC-017-shadow-replay.md`](test-results/RFC-017-shadow-replay.md).

### 3d. Chave do cap de fonte de resolução (decisão 3)

Trocar a chave do bucket `resolution_source` em `exposure.ts` de adapter para
família de cláusula de regra, com fallback nomeado. Não mexe na config (0,25
fica), mas muda sizing — entra com teste de que cláusulas diferentes deixam de
compartilhar bucket. Independente da ponte.

### 4. (histórico) Um único rebuild de profile no servidor

```sh
cd /opt/ganso-market && docker compose --env-file deploy/server.env \
  --profile polymarket up --build --detach \
  polymarket-recorder polymarket-estimator polymarket-paper \
  polymarket-resolution polymarket-portfolio
```

Esse rebuild faz **três** coisas de uma vez:

- **cria o `polymarket-portfolio`** (ativação da RFC-013);
- leva ao recorder a guarda do `DELETE` por fatia do #35, que é o que destrava
  a poda de `book_deltas` — sem ela o passo de quota aborta em toda execução;
- leva a observabilidade do #37 aos jobs supervisionados.

`docker compose up` recria o `nginx` quando a config muda, publicando as rotas
GET da RFC-013 (`opportunities`, `portfolio`, `gates`, `decisions`). Se o Nginx
não for recriado, incluir `nginx` na lista.

**Cuidado com a ordem (lição do `score_version` 1.1.0 queimado):**
`config/portfolio.json` e `config/factor-map.json` já estão no servidor pelo CD,
e o `polymarket-portfolio` vai cunhar as versões 1.0.0 de config e de mapa de
fatores no primeiro boot. Os arquivos são completos de propósito, então o hash é
propriedade do arquivo e não do binário — mas se um PR futuro mudar um default
do código **e** o arquivo ao mesmo tempo, o rebuild tem que sair na mesma janela
do merge.

### 5. Observação pós-ativação

- Log esperado no boot: `PORTFOLIO_BOOT` com `config_version` **1.2.0**,
  `config_hash`, `factor_map_version` e `factor_map_hash`; depois
  `PORTFOLIO_CYCLE` a cada 60 s com `evaluated`, `entrable`, `state`,
  `positions`, `open_breakers` e `stale_marks`.
- Os outros dois jobs da fase E: `PORTFOLIO_EXIT_CYCLE` a cada 30 s (com zero
  posições abertas hoje: `evaluated: 0`) e `PORTFOLIO_GATES_MEASURED` no boot e
  a cada 1 h, com `overall: BLOCKED` e os seis gates. A auditoria de replay loga
  `PORTFOLIO_REPLAY_OK` no mesmo ciclo — `PORTFOLIO_REPLAY_MISMATCH` seria
  motivo para acordar alguém.
- `portfolio_gate_measurements` deve ter **6 linhas por hora**;
  `portfolio_g2_clock` uma linha por categoria com `clock_started`. Um
  `PORTFOLIO_G2_CLOCK_RESET` com `regime_fingerprint_changed` significa que a
  venue mudou fee/tick na categoria — o relógio de 60 dias do G2 voltou a zero
  para ela, e isso é o comportamento correto.
- Esperar `evaluated ≈ 98` (mercados elegíveis medidos) e `entrable` baixo ou
  zero: a RFC-010 não tem modelo promovido, então as estimativas são baseline de
  mercado e o critério de limite inferior raramente fecha. **Zero entradas é o
  resultado correto nesse estado**, não uma falha.
- `polymarket_decisions` e `portfolio_panel_snapshots` devem começar a crescer;
  `portfolio_state` deve ter exatamente uma linha em `NORMAL`.
- RAM dos dois serviços novos dentro de 192 MiB.
- Confirmar que a poda de `book_deltas` finalmente registra em
  `polymarket_retention_log` e que `n_live_tup` cai de forma sustentada.
- Painel: aba "Portfólio" no web app, atrás do login.

### 6. Pendências declaradas

- **KILL SWITCH ENGATADO — rearme pendente (um clique)**: engatado às
  2026-08-28 20:59:32Z por `RECORDER_STALE` durante a janela de manutenção
  autorizada (gap de 12,6 min do recorder); o recorder está saudável desde
  21:06:33Z. Rearmar pelo botão do painel (PR #46). Até lá o paper broker não
  aceita ordens e o soak do #52 não anda. **2026-08-31: segue engatado
  (~2,7 dias; zero ordens paper no período).**
- **Coletor onchain** — **RESOLVIDO em 2026-08-28 (#53)**: a causa real era
  histórico podado + lookback de 200 k blocos (seção da sessão 2026-08-28).
  Coletando desde 20:43Z; observar o catch-up do lookback (~80 min) e a
  primeira disputa capturada onchain.
- **Migration 0016** — **RESOLVIDA em 2026-08-31**: autorizada pelo
  proprietário e aplicada (índice CONCURRENTLY em 0,42 s + CD registrando a
  versão 16). A poda de `portfolio_decisions` fechou pela primeira vez:
  449.553 linhas por quota, zero `RETENTION_STEP_FAILED`. Checagem residual:
  a varredura diária de ~22:09Z deve sair silenciosa para decisions.
- **Redeclaração da quota de `book_deltas`**: decisão do proprietário de 28/08 —
  redeclarar com dado, após ~1 semana de ingestão observada pós-repack. Até lá
  a quota declarada segue 52 GiB com a tabela compacta em 19 GB.
  **2026-08-31: 28 GB físicos, ~3,3 GB/dia líquido; a semana fecha
  ~2026-09-04.**
- **Soaks de 24–48 h dos fixes de 28/08** — **fechados em 2026-08-31, exceto
  o do #52**: G2 com zero `PORTFOLIO_G2_CLOCK_RESET` em ~65 h (antes ~5/dia);
  `ONCHAIN_POLLED` estável com cursor avançando (195 eventos). O do #52
  (proporção canceladas/criadas em `paper_orders`) segue sem dado — zero
  ordens enquanto o kill switch estiver engatado.
- **Cap de fonte de resolução** — **decidido** em 2026-08-27: manter 0,25 e
  trocar a **chave** do bucket para família de cláusula de regra, em vez do
  adapter (hoje o cap capeia o livro inteiro em 25% da banca porque 460 de 570
  rule versions caem em UMA). PR pendente, com fallback nomeado para cláusula
  não classificável — um "unknown" silencioso recriaria o bucket gigante.
- **`docs/test-results/RFC-013-portfolio-engine.md`**: escrito nesta sessão,
  consolidando as fases A–E.
- **Soak de 24 h** da RFC-012 e da RFC-013 em produção: não medido.
- **Gates G1–G6**: todos medidos, **nenhum `PASS`** — e esse é o resultado
  correto: não há modelo promovido na RFC-010, nenhuma posição fechada em paper,
  nenhum circuit breaker exercitado em produção e nenhuma revisão escrita do
  proprietário. `rfc_009_status` permanece `BLOCKED`. Depois da auditoria de
  2026-08-27, nenhum deles pode passar por degeneração — o G5 é o único que não
  precisou de correção, porque sua única condição já compara duas origens
  diferentes (o parâmetro gravado da venue e o relógio persistido).
- **Quota do decision log** — **decidido** em 2026-08-27 (seção de decisões,
  item 1): aceitar ~3 dias por enquanto e declarar TTL de 90 dias. Fica aberto o
  que a decisão exige em código: (a) carimbar a provenance da entrada na posição
  — sem isso, quatro dos sete critérios de saída ficam inertes em toda posição
  com mais de ~3 dias, em silêncio; (b) escrever a entrada só quando o veredito
  muda, que é de onde vêm os 90 dias de verdade; (c) TTL 180 → 90 junto de (b),
  porque mudá-lo sozinho não muda nada — a quota poda antes.
- **Ponte decisão → ordem de paper**: **ativa em produção** desde 2026-08-27
  17:00Z (PR #44). Ainda não produziu ordem nenhuma, e o gargalo mudou duas
  vezes no mesmo dia: primeiro era o kill switch (engatado havia 35 h, achado
  pela própria ponte e rearmado às 20:48Z), depois voltou a ser o de sempre —
  das 18:17 às 21:15Z o motor não aceitou **nenhuma** entrada, porque
  `entrable: 0` sem modelo promovido na RFC-010. Falta observar
  `paper_positions` ganhando a primeira linha.
- **Kill switch do paper**: rearmado em 2026-08-27 20:48:54Z. O `engaged_at` de
  2026-08-26 permanece na linha, então o G3 continua enxergando que o switch foi
  exercitado. O rearme agora tem botão no painel (PR #46).
- **Alarme global de quota** — **medido em produção em 2026-08-27, e o alarme
  está certo.** A hipótese inicial desta sessão (o alarme seria artefato de
  inchaço) foi **refutada pela medição**: 114 GiB físicos contra **110 GiB
  vivos**, ou seja só ~4 GiB de inchaço. O dado retido realmente está acima do
  gatilho de 99 GiB. Registrado aqui porque o handoff anterior e o começo desta
  sessão diziam o contrário.
  - **Causa única e dominante**: `polymarket_book_deltas` com **95 GB vivos
    contra quota de 52 GB** — 43 GB acima da própria quota, 123 M linhas, e
    ~86% de toda a pegada viva do banco (95 de 110 GiB). Nenhuma outra tabela chega perto
    (segunda maior: `polymarket_book_snapshots`, 6,6 GB vivos sob quota de 8).
  - **A poda roda, mas não fecha**: `polymarket_retention_log` mostra 86,8 M
    linhas podadas em 26/08 (3 ações) e 52,6 M em 27/08 (**4 ações**, que é o
    teto de `MAX_QUOTA_ITERATIONS` por rodada diária), sempre por `quota`. E o corte
    pedido em 27/08 foi 24/08 13:03 enquanto a linha mais antiga da tabela é de
    **20/08 01:26**: a janela real é de **7 d 22 h**, não os ~3,4 d que a quota
    implica. A diferença é o portão de cobertura `series_1m` truncando a poda
    nos tokens com buraco — eles ficam para trás e seguram a tabela acima da
    quota. **Esse é o próximo item, e é o que está degradando de verdade.**
  - **Confirmado pela medição**: a redução de TTL do alarme é mesmo inerte onde
    estão os bytes. 7 d 22 h fica abaixo tanto do TTL de 14 d quanto dos 10,5 d
    que o fator deixaria, então ela não apagou uma linha sequer de
    `book_deltas` — só encurtou as tabelas pequenas de auditoria.
  - **Unidades**: os "121,5 GB" que o alarme logava e os "113 GB" do
    `pg_database_size` sempre foram o mesmo número — o alarme loga bytes crus e
    o `pg_size_pretty` rotula GiB como "GB". Não havia dupla contagem.
  - **Mudado no código**: o alarme passa a medir **bytes vivos**, igual à quota
    por tabela. Isso **não silencia** o alarme em produção (110 ≥ 99) e não era
    para silenciar — faz o alarme querer dizer o que diz, e manda o caso de
    inchaço para sinal próprio `RETENTION_GLOBAL_BLOAT`, que não encolhe TTL
    nenhum porque nenhum `DELETE` encolhe arquivo. `RetentionRunReport` ganha
    `totalLiveBytes`. Teste novo trava a invariante quotas-declaradas (95 GiB) <
    gatilho (99 GiB) — o que agora tem leitura operacional: **vivo acima do
    gatilho significa necessariamente quota não sendo cumprida**, como é o caso.
  - **Saiu de pé em 2026-08-28**: com o medidor de bytes vivos do #50 o vivo
    honesto ficou em 36,28 GB e o alarme (e o corte de 25% nos TTLs) parou; o
    inchaço físico foi para `RETENTION_GLOBAL_BLOAT` e o `VACUUM FULL` da
    janela de manutenção o removeu (116 → 38 GB). Ver a seção da sessão
    2026-08-28.
- **Poda da quota de `book_deltas` — causa achada e corrigida em 2026-08-27.**
  Investigação do porquê a tabela ficava em 95 GB contra quota de 52 GB. São
  dois defeitos que se alimentam, os dois no caminho da quota.
  - **(i) A interpolação assume taxa de chegada uniforme** e diz isso no próprio
    docstring. A realidade medida é rampa de ~50× dentro da janela, porque o
    universo de tokens cresceu: 542 416 linhas em 20/08, 4,3 M em 21/08, 4,7 M
    em 22/08, 2,0 M em 23/08, **27,1 M em 26/08**. Reconstruindo a última poda:
    precisava de 69,1 M de 123,1 M linhas → fração 0,561 → corte linear em
    **24/08 12:57**, e o log registra 24/08 13:03. Mas o bound de 25% do
    histograma equi-depth é 24/08 22:10, ou seja **o corte pedido cobria ~23%
    quando pediu 56%** — déficit de 2,4× em toda rodada.
  - **(ii) O laço de correção andava para trás.** Uma passada curta deixa
    déficit _maior_, mas o `rowsToDelete` é medido contra o alvo e algo foi
    apagado, então a fração seguinte era _menor_ e o corte seguinte **anterior**
    ao que acabara de podar — apaga nada e cai no ramo `QUOTA_UNMET`. O
    orçamento de `MAX_QUOTA_ITERATIONS = 4` valia **uma** passada sempre que o
    primeiro chute errasse, o que com densidade enviesada é toda rodada. O log
    confirma: uma ação por rodada, nunca quatro, e as rodadas a horas de
    distância são boots distintos (`runAtBoot`), não iterações.
  - **O elo**: o laço só andava para trás porque a âncora `min()` não avançava.
    Quem a segurava eram **82 de 681 tokens** travados em 20–23/08 pelo portão
    de cobertura `series_1m` — apenas ~0,5% das linhas (20/08 inteiro tem 542 mil
    de 123 M), mas ancorados na parte mais rala da janela. Os 0,5% que não podem
    ser apagados desabilitavam a correção para os outros 99,5%.
  - **Corrigido**: (1) o corte sai do `pg_stats.histogram_bounds`, que é o mapa
    fração-de-linhas → timestamp e não depende de densidade uniforme — leitura
    de catálogo, com guarda para `null_frac + most_common_freqs` acima de 5%
    (fora disso o histograma não descreve a tabela e cai no linear); (2) o laço
    é estritamente para a frente, com `floor` = último corte, e `QUOTA_UNMET`
    passa a ser precedido por `RETENTION_QUOTA_NO_PROGRESS` quando o corte não
    avança; (3) a âncora do fallback linear é `max(min(), floor)`, então tokens
    travados não prendem mais a estimativa.
  - **Validado contra o histograma real** (`null_frac` 0, `mcv_frac` 0, então o
    caminho novo é o que roda): o corte que o código novo escolheria é
    **26/08 10:04**, contra os 24/08 13:03 do antigo — **1,9 dia a mais** por
    passada, que é exatamente a lacuna que mantinha a tabela em ~2× a quota.
  - **Não medido**: o efeito em produção. Precisa de deploy e de uma rodada.
  - **Redeclarar depois de estabilizar**: a ingestão real é ~27 M linhas/dia
    (~21 GiB/dia), acima dos 15,3 GB/dia que os comentários assumem. A quota de
    52 GB compra **~1,9 dia** de deltas, não os ~3,4 d documentados — o que bate
    na leitura de microestrutura das RFC-011/013.
- **Decision log: a janela é pior do que a decisão 1 registrou.**
  `portfolio_decisions` tem 693 MB e 167 488 linhas em 1 d 6 h de operação
  (engine subiu 26/08 16:50) — ~545 MB/dia, ainda sem nenhuma poda registrada.
  Contra a quota de 0,9 GiB com alvo em 80%, a janela assenta em **~1,4 dia**,
  não nos ~3 dias que a decisão 1 assumiu. Isso não muda a decisão, **reforça**
  os itens (a)/(b)/(c) — em especial o (b), gravar só quando o veredito muda.
  `portfolio_panel_snapshots` acompanha: 450 MB nas mesmas 167 488 linhas.
- **`budget_used_pct` do painel mente pelo mesmo motivo, e ainda não foi
  mexido**: `GET /polymarket/data-quality` e o `storage` da read API somam
  `pg_total_relation_size` **só das tabelas `polymarket_*`** contra o orçamento
  inteiro de 110 GiB — físico, e de um subconjunto. Nunca foi o mesmo número do
  alarme (que soma a lista inteira de retenção), e agora diverge também na
  definição. Mudar a resposta dos dois endpoints é contrato de API e ficou de
  fora desta mudança de propósito.
- **`portfolio_panel_snapshots` declara 30 dias de TTL** e, pela mesma
  aritmética do decision log (quota de 0,54 GB amarrando antes do TTL — nada a
  ver com o alarme global), retém a ordem de 3. Sem consumidor profundo (a API só lê a linha
  mais nova por token), então é etiqueta errada e não perigo. Medir
  `pg_column_size` em produção e redeclarar.
- **`custo_capital_anual`** — **a varredura rodou em 2026-09-01 (RFC-017) e não
  deu um número, deu uma resposta diferente**: na população que existe hoje
  **nenhuma taxa entre 0,12 e 0,40 muda uma única decisão** (AÇÃO = 0 linhas / 0
  mercados sobre 20.340 decisões alcançáveis), e a busca de virada não acha
  mudança de ação nem a 100.000% a.a. A álgebra de 27/08 (`r > 0,1825/preço`)
  está certa e é o **sinal**; faltava a **magnitude**, que vem do lockup — o log
  tem 38 min e 3,67 h, e a carga máxima a r=0,40 é 0,0000827/ação contra
  `edgeLiqMin` de 0,02. Isso também corrige o registro de que na saída o
  parâmetro "já é vinculante": o critério 6 dispara 63× dentro do critério 1, ou
  seja, só em posição que o critério 1 já tirou. `config/portfolio.json`
  **continua em 1.2.0**, agora por um motivo medido: subir não faria nada. A
  decisão que sobra para o proprietário é sobre o **universo** (horizontes de
  semanas fariam o parâmetro voltar a morder), não sobre a taxa.
- **`g2MaxSinglePositionPnlShare = 0,25`** — **aprovado** pelo proprietário em
  2026-08-27; deixa de ser número do implementador. Revisão contra dado real
  quando o G2 tiver ≥ 100 posições fechadas, o que depende da ponte de paper.
- **PnL realizado por janela**: total exato; janelas diária/semanal atribuem pelo
  `resolved_at`, então realização por fechamento antecipado entra tarde. Detalhe
  e motivo em `docs/test-results/RFC-013-portfolio-engine.md` §9.
- **`consensus`/`nowcast` no `config/macro-calendar.json`** — **entregue em
  2026-08-31 (PR #63), com a ressalva que importa**: `cpi-2026-09` carrega o
  nowcast do Cleveland Fed (keyed por variável, com fonte e data de leitura); as
  outras 14 entradas seguem sem consenso porque **não há fonte oficial** para
  elas, e o motivo de cada família está no próprio arquivo (`_consensus_absent`).
  A ressalva: a medição mostrou que **isto não destrava a categoria macro** — os
  22 mercados macro de produção falham em `UNRECOGNIZED_VARIABLE` antes de o
  consenso ser lido, porque são mercados de MUDANÇA de juros e o modelo
  precifica NÍVEL. Fica aberto, e é **decisão do proprietário**: criar variável
  de mudança (`fed_rate_change_bps`, com brackets de 25 bps no parser) ou aceitar
  que `macro_scheduled` não produz evidência com o universo atual. Nowcast
  envelhece — o processo de atualização manual está no runbook fundamental.

Nenhum modelo é promovido antes de um gate PASS com os 100 mercados resolvidos

- ação manual do proprietário — nada nesta sessão muda essa invariante. A
  RFC-009 permanece bloqueada.

Operação do servidor: `cd /opt/ganso-market` seguido de `make server-status`,
`make server-health` ou `make server-logs`.

## Como atualizar este handoff

Ao concluir cada atividade:

1. atualizar data, RFC ativa e estado da sequência;
2. registrar somente comandos realmente executados e resultados reais;
3. registrar decisões, bloqueios e riscos que continuam abertos;
4. apontar a evidência versionada correspondente;
5. declarar explicitamente o próximo passo mínimo;
6. nunca incluir conteúdo de secrets, credenciais ou material de wallet.

Para localizar o commit corrente sem manter hash autorreferente neste arquivo:

```sh
git log -1 --oneline
```

## SESSÃO 2026-09-01 — RFC-015: O PAINEL DO OPERADOR (PR #76)

**FATO INFORMADO:** escopo aprovado pelo proprietário em 2026-08-28,
reposicionado por decisão dele para **depois** da cobertura de modelo.

**FATO VERIFICADO (produção, `release-sha` `18000c1c63133eeeefe3afe2d1dfc60c2e0768aa`,
deploy 2026-09-01 23:14Z, rebuild do profile `polymarket` às 23:19Z):** as
quatro publicações novas respondem no perímetro, os dois endpoints novos estão
registrados na API, e as duas consultas que ameaçavam o orçamento de 1 s foram
medidas de novo **depois** do deploy.

### O que a re-medição desmentiu, antes de qualquer linha de código

| Premissa de 28/08                                       | Medido em 01/09                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "os 308 terminais `unknown` são permanentes por design" | **confirmado, e agora com a data**: os 308 estão entre `2026-08-22 01:38Z` e `2026-08-25 01:33Z`, todos anteriores ao primeiro `valid_from` de `polymarket_market_metadata_versions` (`2026-08-25 01:42:43Z`). O rótulo "anterior a 25/08" é medido, não estimado. |
| "categorias: crypto, macro, weather"                    | confirmado: 1294 / 55 / 1, mais 34 sem categoria no histórico                                                                                                                                                                                                      |
| "o 500 do `/decisions` não foi investigado"             | **causa-raiz encontrada** (abaixo)                                                                                                                                                                                                                                 |
| "`/opportunities` a ~505 ms, fica para outro escopo"    | **786 ms** ao medir o plano, com sort externo em disco — entrou no escopo                                                                                                                                                                                          |
| "RFC-016 em produção → a aba Rápidos entra"             | entra, **e o universo tem 0 mercados com horizonte < 6 h** neste instante                                                                                                                                                                                          |
| "`end_ts` serve para ranquear por horizonte"            | **falso onde importa**: cobre 219 dos 372 tokens do painel; a cadeia versionada cobre 372, e onde ambos existem discordam em 0                                                                                                                                     |

### O 500 de 31/08 não era irreproduzível — era um orçamento de 1 segundo

```
Limit  (actual time=710.738..714.966 rows=500)
  -> Sort (decision_ts DESC, top-N heapsort)
       -> Parallel Seq Scan on portfolio_decisions   Buffers: shared read=92199
Execution Time: 715.150 ms
```

Não existe índice em `decision_ts` sozinho: os três que existem são compostos e
liderados por `decision_kind` / `condition_id` / `token_id`. E o orçamento:

```ts
// database.ts
const queryTimeoutMs =
  overrides.queryTimeoutMs ?? config.database.connectTimeoutMs;
//                                                  ^ config/runtime.json: 1000
poolConfig.statement_timeout = queryTimeoutMs;
```

Estimator, portfolio e resolution sobrescrevem para 60 s; paper e recorder para
30 s; o shadow-replay para 120 s. **A API não sobrescreve** — e é a única que
serve o painel. 715 ms frio contra 12 ms quente é exatamente a forma de um 500
que "não reproduz": o custo depende do cache, e a tabela crescia ~545 MB/dia sem
poda até a migration 0016. Em 31/08 18:21Z, antes da poda de 449 mil linhas, a
mesma varredura era múltiplos disso.

| consulta                    | antes                                                                   | depois                                          | medido em produção pós-deploy                     |
| --------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| `/polymarket/decisions`     | seq scan + sort, 92.199 buffers lidos, **715 ms**                       | index only scan backward na PK, 104 acertos     | **2,2 ms**                                        |
| `/polymarket/opportunities` | `DISTINCT ON` sem usar o índice, sort externo 9,5 MB/worker, **786 ms** | loose index scan (1 lookup por token + lateral) | **23,8 ms**, e 200/200 linhas com instante de fim |

`decision_id DESC` também conserta um defeito latente de paginação: um ciclo do
motor grava várias decisões com o **mesmo** `decision_ts`, então a ordem antiga
era ambígua entre empates. As duas listas coincidem em 490 das 500 linhas.

### `budget_used_pct`: a definição, antes da publicação

O endpoint somava `pg_total_relation_size` (**físico**) das tabelas
`polymarket_%` (**subconjunto**) contra o orçamento inteiro de 110 GiB, enquanto
`QUOTA_GLOBAL_ALARM` soma bytes **vivos** da lista **inteira** de retenção
(que inclui `paper_*`, `resolution_*`, `portfolio_*`). Base errada e população
errada: o número do painel nunca foi o número do alarme.

A correção não foi um segundo estimador — foi **extrair o primeiro**.
`measureTableSizes` sai do fecho de `createRetentionJob`, vira exportada, e
tanto o alarme quanto a read API a chamam. De quebra, a leitura das 74 tabelas
passou de 37 idas ao banco para **uma** consulta de catálogo: **16 ms**. A
resposta publica `live_bytes`, `physical_bytes` e `bloat_bytes` lado a lado,
porque "quanto está retido" e "quanto custa de disco" são perguntas diferentes.

### Perímetro — verificado de dentro do servidor

| location (todos `location =`, GET-only) | sem sessão | método errado                |
| --------------------------------------- | ---------- | ---------------------------- |
| `/api/polymarket/overview`              | 401        | 404 em POST/PUT/DELETE/PATCH |
| `/api/polymarket/events`                | 401        | 404 em POST/PUT/DELETE/PATCH |
| `/api/polymarket/data-quality`          | 401        | 404 em POST/PUT/DELETE/PATCH |
| `/api/polymarket/paper/performance`     | 401        | 404 em POST/PUT/DELETE/PATCH |

E as escritas seguem fechadas: `POST /paper/intents`, `/paper/orders`,
`/paper/kill-switch`, `/portfolio/halt` e `/portfolio/resume` → **404**. Controle
positivo de que a API tem as rotas (e não que o Nginx está mentindo): direto em
`api:3000`, as quatro devolvem `MISSING_BEARER_TOKEN`/`AUTH_UNAUTHENTICATED`
enquanto um caminho inventado devolve `ROUTE_NOT_FOUND`.

`scripts/tests/test_nginx_perimeter.py` passa a guardar uma **allowlist** de
caminhos sob `/paper` (rearme + performance) em vez de "só o rearme", com o
método permitido de cada um.

### O feed: cursor por fonte, não por instante

`GET /polymarket/events?after=` é keyset sobre tabelas que já existem — sem
migration. O cursor é `fonte:id,fonte:id,…`, um id monotônico por fonte, e não
um instante global: duas fontes gravando no mesmo milissegundo fariam um cursor
de instante **perder uma linha em silêncio**. Um cursor com fonte desconhecida
é **descartado**, não rejeitado, para sobreviver a um deploy que renomeie uma
fonte. Decisões só entram quando `outcome = 'ACCEPTED'` — são **262 de 234.571**;
as outras são `ENTRY/REJECTED` e enterrariam o resto.

### A aba "Rápidos" entra, e é verificada VAZIA na fatia que importa

A RFC-016 está em produção, então a condição do escopo está satisfeita e a aba
entrou. O que a medição obriga a dizer junto: **o universo não tinha nenhum
mercado com horizonte < 6 h** no instante da verificação — nem por `end_ts` nem
pela cadeia versionada (1121 versões abertas, 1121 com instante cheio, 0
vencendo em 6 h, próxima em `2026-09-02 04:00Z`). Não é defeito: 142 mercados
venceram **naquele dia** e as janelas de 10 s e 1 s rodaram até ~16:00Z. É um
vale entre lotes diários, e a aba diz isso na tela em vez de mostrar uma lista
vazia sem explicação.

O custo de ida-e-volta é `spread + 2 × (fee + slippage)` por cota, com os
componentes na tela ao lado do total — em produção hoje `fee` e `slippage` são
`0.000000` em toda linha do painel, então o ida-e-volta **é** o spread, e isso
precisa ser visível em vez de ser uma suposição.

### Controles positivos (a lente de degeneração, aplicada às verificações)

| verificação                         | controle rodado                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| perímetro exato sob `/paper`        | trocar `location =` por `^~` na performance → o teste falha com 2 erros                                                            |
| trava de método nos locations novos | remover o `if ($request_method != GET)` de `/events` → o teste falha                                                               |
| aviso de "recarregue"               | escrever um sha diferente em `deploy/release-sha` e recarregar → o aviso aparece na tela com os dois shas                          |
| rotas registradas na API            | um caminho inventado devolve `ROUTE_NOT_FOUND`, as quatro novas devolvem 401                                                       |
| `budget_used_pct` em bytes vivos    | a fixture dá `live_tup`/`dead_tup` de forma que vivo ≠ físico e inclui `portfolio_decisions`, que a definição antiga não enxergava |

### Limite honesto da verificação de navegador

**O login do proprietário não é meu.** A verificação de navegador rodou contra
um stub local servindo os valores **medidos no banco de produção neste dia**,
com a forma exata que os endpoints devolvem. Isso verifica a **renderização** de
números reais — PnL nas quatro abas, cards sem transbordo, textos em português,
`unknown` rotulado como "Sem categoria (anterior a 25/08)" com `<code>unknown</code>`
ao lado, faixa fixa ao rolar, aviso de recarregar. **Não verifica o fio.** O fio
foi verificado à parte, no servidor: perímetro, registro de rotas e as consultas
medidas direto no banco.

### ABERTO — `polymarket_book_deltas` parou às 22:43:47Z (não é desta sessão)

Encontrado durante a verificação, e a aba "Visão geral" nova é justamente onde
ele apareceria primeiro (card **Coleta**, "Último livro").

| fluxo                            | último registro          | linhas nos últimos 5 min |
| -------------------------------- | ------------------------ | ------------------------ |
| `polymarket_book_deltas`         | **2026-09-01 22:43:47Z** | **0**                    |
| `polymarket_book_snapshots`      | 23:19:48Z                | 186                      |
| `polymarket_book_snapshots_full` | 23:22:47Z                | 557                      |
| `polymarket_rtds_prices`         | 23:23:39Z                | 548                      |
| `polymarket_trades`              | 23:04:51Z                | 0                        |

Universo com **93 membros, 92 ainda vivos**, próximo fim em `2026-09-02 04:00Z`.
Nenhum `WS_SINGLE_CONNECTION_DOWN` nem `WS_BOTH_CONNECTIONS_DOWN` no período, e
`polymarket_data_gaps` não tem lacuna aberta — o rastreio de lacunas **não está
vendo** este buraco.

**Recuperou sozinho, no segundo restart.** O arco completo, medido:

| instante    | fato                                                           |
| ----------- | -------------------------------------------------------------- |
| `22:43:47Z` | último delta. O regime até ali era de ~9.000/min               |
| `23:14Z`    | merge do PR #76 e CD — o recorder ainda roda a imagem de 31/08 |
| `23:19Z`    | rebuild do profile `polymarket`. **Não recuperou**             |
| `23:34Z`    | restart dos containers pelo CD do PR #77                       |
| `23:36Z`    | 3.662 deltas                                                   |
| `23:38Z`    | **8.892 deltas em 186 tokens** — regime cheio de volta         |

**Por que não é desta sessão:** a parada começou 30 min antes do merge e até
23:19Z o recorder rodava a imagem de 31/08. E ela **sobreviveu a um restart**,
o que é o detalhe comportamental que interessa a quem for investigar: um
rebuild não bastou, o seguinte bastou.

**O defeito real não é a parada — é o silêncio.** Nenhum
`WS_SINGLE_CONNECTION_DOWN`, nenhum `WS_BOTH_CONNECTIONS_DOWN`, e
`polymarket_data_gaps` **sem uma única lacuna aberta** durante os 53 minutos. O
rastreio de lacunas não enxerga este modo de falha, então 53 minutos de
microestrutura sumiram sem que nada disparasse. A microestrutura das RFC-011/013
lê deltas: uma repetição mais longa faria a evidência do G2 parar de acumular em
silêncio. É área da RFC-007 e precisa de prompt próprio.

**O que o painel novo faz com isso:** o card **Coleta** da aba "Visão geral"
mostra `last_book_delta_age_ms` — durante a parada teria marcado "53 min" na
primeira coisa que o operador vê ao abrir o painel. É a primeira vez que este
modo de falha teria sido visível sem alguém rodar SQL.

## SESSÃO 2026-09-02 — RFC-018: AS DECISÕES DE CALIBRAÇÃO DE 27/08 VIRAM CÓDIGO (PRs #79–#84)

Seis PRs mergeados e **ativos em produção** (`release-sha a7c9e45`, confirmado
DENTRO dos containers de profile, nunca por `compose ps`). Migration 0018
aplicada às 01:05:14Z. Cada correção entrou com teste de regressão **verificado
falhando no código anterior**, e cada premissa do escopo foi **re-medida antes de
codar** — três caíram.

### As três premissas do escopo que a re-medição desmentiu

| Premissa (27–28/08)                                       | Medido em 2026-09-01/02                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `DATA_STALENESS` nunca foi exercitado                     | **falso**: 58 aberturas desde 28/08 20:54:48Z. Faltavam **dois** breakers, não três            |
| com (b), o TTL de 90 dias "passa a ser o limite que vale" | **falso**: a redução leva a janela a ~19 dias. A quota de 0,9 GB continua vencendo o TTL       |
| a chave nova do cap devolve diversificação ao livro       | **falso na população de hoje**: o bucket gigante continua com 81,5% — porque ele é **verdade** |

### Item 1 — o decision log grava quando o veredito muda (PR #79)

**Fator medido ANTES de codar** (a decisão exige medição, não estimativa), sobre
a janela retida de 2,17 dias, 226 953 linhas de entrada em 330 tokens:
assinatura `veredito | reason_code | binding constraint` mudaria **26 256** vezes
→ **8,6×** (8,3× em 31/08, 9,8× em 01/09).

**Fator VERIFICADO em produção** depois do rebuild (01:15Z):

| Janela                                  | Decisões/min | Fator vs 91,3 |
| --------------------------------------- | ------------ | ------------- |
| antes (00:20–01:14Z)                    | **91,3**     | —             |
| depois, incluindo os minutos de restart | 12,4         | 7,4×          |
| em regime, 9 min (01:20–01:29Z)         | 11,1         | 8,2×          |
| em regime, 19 min (01:20–01:39Z)        | 9,9          | 9,2×          |
| em regime, 29 min (01:20–01:49Z)        | **6,9**      | **13,1×**     |

**O número ainda está assentando, e para cima.** Os primeiros minutos depois do
restart contam como primeira avaliação todo token cuja última linha não casava a
assinatura, e essa onda vai saindo da janela. O 8,6× previsto do log histórico é
o piso conservador — sobre 2,17 dias inteiros, não sobre meia hora. **A medição
que vale é a de 24 h**, e ela é item de soak (abaixo).

O painel segue em **94,4 linhas/min** na mesma janela (a queda desde 100,7 é
rotatividade do universo, não a mudança).

O painel **mantém a cadência**: 100,7 linhas/minuto depois do deploy, como
desenhado — ele é a vista viva, e quem emagreceu foi o log.

**53% do que sobra é um par de vetos de staleness trocando de lugar**
(`BOOK_STALE` ↔ `DATA_STALE`, 14 045 transições na janela medida). Unificá-los
daria ~18×, mas é **outra** assinatura e a decisão nomeia esta. Registrado como
fato, não aplicado.

**Interpretação registrada (RFC-018 D1):** "toda intenção persiste" (RFC-013
tarefa 7) = toda intenção **DISTINTA** — a leitura que o ciclo de saída já tinha
aprovada. Sem esse registro, escrever menos leria como afrouxamento silencioso da
tarefa 7. A prova "o motor olhou" continua fora do log
(`portfolio_gate_measurements`, horária e `protected`) e agora também no
`PORTFOLIO_CYCLE`, que separa `evaluated` de `decisions_written`. **Nenhum
heartbeat novo foi acrescentado ao log.**

**TTL 180 → 90, e o número honesto:** 90 **continua não sendo o limite que
vale**. A 12,4 linhas/minuto (~17,9 mil/dia) × 3 634 B/linha, a quota de 0,9 GB
entrega **~19 dias** — "semanas", como a decisão previu, e uma ordem de grandeza
abaixo dos 90 declarados. As duas tabelas do portfolio foram podadas por `quota`
em **todas** as rodadas registradas no `polymarket_retention_log`, nenhuma por
TTL. O comentário no código diz isso em vez de deixar o número decorativo.

### Item 2 — o cap de fonte de resolução muda de chave, não de número (PR #80)

`caps.fonteResolucao` **fica em 0,25**. A chave passa de adapter para **família
de cláusula de regra** (léxico da RFC-012 sobre a `rule_version` em vigor as-of a
decisão), com fallback **nomeado**.

**MEDIDO sobre os 92 mercados do universo vivo — e desmente o benefício
esperado:**

| Chave NOVA                       | n   | %     | Chave de HOJE     | n   | %     |
| -------------------------------- | --- | ----- | ----------------- | --- | ----- |
| `OBJETIVA_UNICA:binance`         | 75  | 81,5% | adapter `0x6507…` | 74  | 80,4% |
| `OBJETIVA_UNICA:federal_reserve` | 11  | 12,0% | adapter `0x69c4…` | 9   | 9,8%  |
| `CLAUSULA_NAO_CLASSIFICADA`      | 5   | 5,4%  | adapter `0x2F5e…` | 5   | 5,4%  |
| `OBJETIVA_UNICA:chainlink+twap`  | 1   | 1,1%  | 4 URLs            | 4   | 4,3%  |

**O bucket gigante não some — porque ele é verdade.** 81,5% do universo vivo é
mesmo decidido pelo candle da Binance (o mesmo fato que a RFC-019 mediu). A chave
nova **não devolve teto ao livro**: com 0,25 de US$ 1.000 ele segue limitado a
~US$ 250 enquanto a concentração for essa. O que muda é **do que o bucket fala** —
antes "estes 74 usam o mesmo adapter" (encanamento de venue), agora "estes 75
morrem juntos se o feed da Binance mentir" (risco) — e os 11 mercados de taxa do
Fed, que o adapter jogava no mesmo balde, ganham o seu. O que a decisão temia
**não** aconteceu: o fallback nomeado ficou em 5,4%.

**Verificado em produção** (01:15:05Z): `portfolio_exposures` passou a carregar
`OBJETIVA_UNICA:binance` e `OBJETIVA_UNICA:federal_reserve` na dimensão
`resolution_source`, que **muda de valor, não de nome**.

**ACHADO LATERAL, registrado e NÃO corrigido:** os 5 de
`CLAUSULA_NAO_CLASSIFICADA` não são cláusulas inclassificáveis — são **quatro
fontes reais que o léxico não nomeia**: BCE, U.S. EIA, Bank of Japan (2) e IMF
Portwatch. Acrescentá-las mudaria `config/resolution-lexicon.json`, que é
**conteúdo endereçado pelo `score_version` da RFC-012**: derrubaria o `sourceRisk`
de 0,6 para 0, mudaria a precisão de regra e exigiria **cunhar versão de score
nova e re-pontuar**. É mudança da RFC-012, não desta. Até lá as quatro dividem um
bucket, o que **super**concentra — a direção segura.

**O container do portfolio passou a montar `config/resolution-lexicon.json`**, o
mesmo arquivo do serviço de resolução. Confirmado no boot: os dois logam
`lexicon_hash = 82ae4c54…`, idênticos. Quando o arquivo não está montado o boot
loga `PORTFOLIO_LEXICON_LOADED` com `level: warn` e `from_file: false` — o
fallback para o vocabulário embutido deixou de ser invisível.

### Item 3 — a metade "proposed" do breaker nunca chegava ao módulo (PR #81)

**Defeito, não falta de oportunidade.** A RFC-013 item 4(i) pede o breaker em
"`umaResolutionStatus` = **proposed/disputed** em qualquer posição". A condição
implementada lia só `disputeActive || action === 'CIRCUIT_BREAKER'`, e o estado
`proposed` **não chegava ao módulo**: `resolution_market_state` não tinha coluna
para a proposta, embora o `recompute.ts` já a calculasse e a descartasse.

Medido: 482 mercados em `proposed`, 340 em `settled`, `dispute_active` **falso em
781 de 781** e `effective_action = 'CIRCUIT_BREAKER'` **nunca**. A metade
"proposed" do nome era inalcançável nesta população — a lente de degeneração dos
gates aplicada a um controle: ele não falhava, ele não podia rodar.

**A chance real que ele perdeu:** a posição `0x71b5721c…` foi aberta em 01/09
11:59:06Z e atravessou uma proposta UMA viva de **16:04:52Z a 16:14:48Z** (bond
250, liveness 600 s) — ~10 ciclos de painel — em silêncio.

Migration 0018 (`resolution_market_state.proposal_active`, `NOT NULL DEFAULT
FALSE`), gravada como `proposalActive && !terminal`. **Sem backfill de
propósito**: derivar o status UMA numa migration seria uma segunda
implementação, divergente, do que o recompute já faz. Latência não é obstáculo —
mediana **0 s** sobre as 483 propostas registradas.

**Verificado em produção:** 3 mercados com `proposal_active = true` às 01:25Z
(nenhum deles com posição aberta, então o breaker corretamente segue calado), e o
G3 passou a reportar `breakers_missing: ["UMA_PROPOSED_OR_DISPUTED",
"RULE_CLARIFICATION"]` com `DATA_STALENESS` já em `breakers_exercised`.

**DECISÃO DO PROPRIETÁRIO (2026-09-02) — `RULE_CLARIFICATION`: esperar dado
real, sem construir mecanismo de injeção.** A lógica está correta e o gate é o
que a RFC pede; ele só nunca coincidiu (4 clarificações materiais em ~8 dias
contra 2 posições abertas de ~200 mercados ≈ **200 dias** de espera). O G3
devolve `INSUFFICIENT_DATA` de qualquer forma enquanto a base de evidência do G2
não existir, e com 30–100 mercados sob posição a taxa medida dá **~13 dias** —
dentro da janela de 60 dias do G2. Construir injeção hoje seria bypass de um gate
travado por outro motivo.

### Item 4 — `models-cli`, o registro de versão de modelo (PR #82)

Fecha o **BLOQUEIO/TODO** que estava aberto neste handoff. Até agora só o
catálogo do boot registrava versões (as **não calibradas** da imagem); treinar uma
calibrada não tinha caminho, e a alternativa era INSERT à mão — criar a linhagem
para a qual toda estimativa futura aponta sem nenhuma das checagens que a tornam
confiável.

CLI e não endpoint, pela razão do `gates-cli`. **Reusa `registerModel`**, então as
garantias são as mesmas: `model_id` existente é recusado
(`MODEL_VERSION_EXISTS`), nascimento em `shadow`, fronteira de regime antes do
statement, evento `registered`. Sem revisão de release legível recusa com
`GIT_SHA_UNAVAILABLE`.

```sh
docker compose exec -T api node apps/api/dist/models-cli.js list
docker compose exec -T api node apps/api/dist/models-cli.js show crypto_updown_gbm@1.1.0
docker compose exec -T api node apps/api/dist/models-cli.js register \
  --family crypto_updown_gbm --version 1.2.0 --category crypto_updown \
  --feature-set-version 1.2.0 --seed 42 < hyperparams.json
```

Hiperparâmetros por **stdin** como objeto JSON, nunca por bandeiras: são parte do
que a versão significa, e um corpo ilegível é recusado em vez de virar `{}`.

### Item 5 — a mensagem que faltava e o TTL do painel (PR #83)

`FEATURES_WINDOW_FAILED` continuava sem mensagem, com **zero ocorrências nas
últimas 24 h** — latente, e é a forma que o projeto já pagou duas vezes. O padrão
do #37 foi aplicado aos **quatro** sítios nus do mesmo arquivo
(`PAPER_HEARTBEAT_FAILED`, `FEATURES_WINDOW_FAILED`, `FEATURES_TICK_FAILED`,
`PAPER_BROKER_TICK_FAILED`).

`portfolio_panel_snapshots`: **TTL 30 → 2 dias**, redeclarado e não financiado.
Medido `pg_column_size` **2 031 B/linha** (p50 2 000, p95 2 408) a 106 201
linhas/dia contra quota de 0,54 GB → a quota entrega ~2,5 dias e a janela retida
observada era 2,05. Nada lê fundo (a API lê `DISTINCT ON (token_id)` e o detalhe
`LIMIT 1`). **Nenhuma quota nova foi inventada.**

### Achado da própria verificação — órfãos em `portfolio_exposures` (PR #84)

Às **01:14:48Z**, quando a chave da dimensão mudou, as duas linhas antigas do
adapter **não sumiram**: o upsert só escreve o que existe e nunca apaga o que
deixou de existir. Elas congelaram no último valor enquanto as novas avançavam.

**Não é cosmético:** `loadRiskSurvival` conta `utilization > 1` sobre **toda**
linha da tabela, então um órfão acima do cap reportaria um breach não bloqueado
pelo resto da vida do sistema e prenderia o **G3 em FAIL** por uma posição que
ninguém tem. O defeito é **anterior a esta sessão** (todo bucket cujo último
membro fecha já deixava órfão), mas a troca de chave o tornou material de uma vez
só. O sizing nunca foi afetado — `capHeadroomFor` lê as linhas em memória do
ciclo, nunca a tabela. **Verificado em produção às 01:26:42Z:** as 14 linhas da
tabela têm todas o mesmo `computed_at` e `resolution_source` só tem as duas
famílias de cláusula.

### `entryProvenanceFor` continua íntegro

O critério que motivou o item 1 inteiro. Verificado depois do deploy:
`portfolio_position_entries` (tabela `protected`, imutável por trigger, nunca
podada) tem **18 entradas carimbadas**, e as **duas** posições abertas têm
provenance. A poda do decision log não alcança essa tabela, então os quatro
critérios de saída que dependiam dela não voltam a ficar cegos — e agora o log
por trás deles também dura mais.

### Zero regressão nos gates

6 medições/hora mantidas (as contagens de 24 e 42 são os ciclos de boot dos
restarts), os seis gates com o mesmo veredito de antes
(`INSUFFICIENT_DATA`), **1 `PORTFOLIO_REPLAY_OK` e 0
`PORTFOLIO_REPLAY_MISMATCH`** desde o rebuild.

**Rajada de DNS às 01:59:17–01:59:24Z, e não é desta sessão.** Seis
`PORTFOLIO_FAILED` com `detail: "getaddrinfo EAI_AGAIN postgres"` durante o
recreate de containers do CD, com o portfolio em loop de restart até o DNS
embutido do Docker voltar. **`polymarket-paper` e `polymarket-resolution`
tiveram exatamente 6 cada, na mesma janela** — é a rede do Compose durante o
`up --force-recreate`, não código. Recuperou sozinho: **zero erros desde
01:59:30Z** e o ciclo de 01:59:46Z rodou limpo.

Vale registrar porque é o padrão do #37 trabalhando: o `detail` com a mensagem
real diagnosticou isso em uma linha. Sem ele o log diria `error_name: "Error"` e
a rajada teria custado uma investigação — que é exatamente o buraco que o item 5
fechou no `paper/runner.ts` no mesmo dia.

### O que fica aberto

- **Léxico não cobre 4 fontes reais** (BCE, EIA, BoJ, IMF Portwatch). Corrigir
  exige cunhar `score_version` novo e re-pontuar — trabalho da RFC-012.
- **`RULE_CLARIFICATION`** segue por exercitar, por decisão do proprietário:
  esperar a coincidência real, que fica provável quando a base do G2 existir.
- **Posição em mercado liquidado sem `resolved_at`:** `0x71b5721c…` settled em
  01/09 16:14Z, saiu do universo 16:26Z, e segue com 8,11 shares e `resolved_at`
  NULL em `paper_positions`. Fora do escopo desta sessão; é caminho da RFC-011.
- **Soak do item 1:** a janela retida do decision log era 2,23 dias às 01:40Z e
  deve crescer na direção de ~19 dias conforme a poda por quota rodar sobre a
  cadência nova. **Re-medir a taxa sobre 24 h** — meia hora não fecha o número —
  e a janela retida em 48 h.
- **`binding_constraint` diversificado não é verificável hoje.** O critério de
  verificação do escopo pedia isso, e as 187 decisões da janela pós-deploy são
  **100% `NOT_SIZED`**: com `entrable: 0` nenhuma entrada chega ao sizing, então
  nenhum cap pode ser o binding constraint, o de fonte de resolução inclusive.
  O que a chave nova faria com o campo só aparece quando o livro voltar a
  dimensionar entradas. Não é regressão: é a mesma população de antes.

## SESSÃO 2026-09-02 — REDECLARAÇÃO CONSCIENTE DA QUOTA DE `book_deltas` (PR da decisão)

A decisão de 28/08 era redeclarar a quota **com dado**, não deixar o alarme
decidir. A série pós-repack foi completada e a decisão foi tomada. **O número
não mudou — o que ele compra mudou por um fator de ~4.**

### Medição em produção (somente leitura, 2026-09-02 02:05–02:35Z)

| Grandeza | Medido |
| --- | --- |
| `book_deltas` vivo | **35,174 GiB** / 120.407.970 linhas |
| `book_deltas` físico | 35,82 GiB, `n_dead_tup = 0` (sem bloat) |
| Custo por linha | **313,67 B vivos** (heap 119 + 28 de tupla + (102 + 3×16)/0,9 de índice); o arquivo concorda em ~319 B/linha |
| Janela retida | 2026-08-20 01:26:41Z → **12,99 dias** |
| Última poda de `book_deltas` | **2026-08-28 10:28Z** — nenhuma desde então |
| Global (61 tabelas de retenção) | 51,72 GiB vivos / 58,48 GiB físicos, contra gatilho de 99 GiB |
| Disco do host | 64 G / 301 G (22%) |

**Linhas/dia (UTC), a série completa:** 20/08 542.416 (parcial, borda de poda) ·
21/08 4.308.116 · 22/08 4.695.202 · 23/08 2.008.609 · 24/08 4.871.448 ·
25/08 7.017.169 · 26/08 13.208.278 · 27/08 12.839.312 · 28/08 24.463.878 ·
29/08 10.523.066 · 30/08 9.782.842 · 31/08 9.433.124 · 01/09 15.588.234 ·
02/09 1.122.716 (parcial). Médias: **11,33 M/dia** (pós-repack, 29/08–01/09),
**13,69 M/dia** (7 dias), **15,59 M/dia** (dia mais movimentado, 01/09) —
ou **3,31 / 4,00 / 4,55 GiB/dia vivos**. Físico: 19 GiB (28/08 21:06Z) →
28 (31/08 13:20Z) → 35,82 (02/09 02:05Z).

**A premissa de "~3,3 GB/dia" do prompt só vale para a fatia 29–31/08.** A série
inteira é mais alta e muito variável (9,4 M a 15,6 M linhas/dia em dias normais).
E o achado que reenquadra tudo: **os ~15,3 GB/dia que justificaram os 52 GiB em
25/08 eram uma taxa INCHADA**. A linha custa 313,67 B; o pré-repack estava ~4×
inflado por tuplas mortas e bloat de índice, não por dado.

### Janela retida por token

827 tokens têm deltas (o registro tem 2.336). Janela por token: **mín 0,00 d,
mediana 0,59 d, máx 12,87 d**. **467 dos 827 (56,5%) não produzem delta há mais
de 24 h e seguram 63.541.217 linhas = 18,56 GiB = 52,8% da tabela**; os 360
ativos seguram 56.863.201 linhas (16,61 GiB). O token mais pesado sozinho tem
8.047.625 linhas (~2,4 GiB); os três maiores somam 19,3% da tabela.

### A cauda coverage-gated: a poda está TRAVADA (achado fora do escopo, PR separado)

Simulando o gate (`coverageCutoffForToken`) num corte de 7 dias: **161 de 161
tokens bloqueados, todos presos no PRÓPRIO minuto mais antigo, 0 linhas
liberáveis**, 24.684.160 linhas (7,21 GiB) retidas pelo gate.

A cobertura real é **99,917%** — só **223 minutos descobertos em 267.635**. 119
dos 161 tokens têm exatamente UM buraco (média 1,39, máximo 4). Tolerar o minuto
de borda de cada token avançaria a poda em **62,3 h em média** e liberaria
**24.092.606 linhas (7,04 GiB)** — 97,6% do que está bloqueado. **0,08% de
defeito de cobertura bloqueia 100% da poda.**

**Controle positivo (o mecanismo, não a correlação):** o token mais pesado tem
`series_1m` desde 20/08 01:13 mas deltas só desde **23/08 14:45** — e 14:45 é
justamente um dos 3 minutos descobertos dele (11.249 de 11.252 cobertos). Isso
prova que a poda rodou, parou EXATAMENTE num minuto descoberto, e esse minuto
virou o mais antigo. **O gate se auto-trava**: ele para no primeiro buraco, o
buraco vira a borda, e toda execução seguinte recalcula a mesma borda e apaga
zero. `bucket_start` usa o mesmo relógio de ingestão que `received_at`
(`bookpipe.ts`), então os buracos são corridas raras de borda de minuto — não um
artefato de chaveamento.

**Consequência datada:** o TTL de 14 dias começa a morder em ~2026-09-03 01:26Z
e vai pedir exclusão e apagar **zero**. A tabela cresce sem poda até o alarme
global (99 GiB vivos), cujo único gatilho é reduzir TTL — que também não apaga
nada. Tratado em PR separado por decisão do proprietário.

### Tabela de opções APRESENTADA ao proprietário (verbatim)

| Quota | Dias retidos (11,33 / 13,69 / 15,59 M linhas/dia) | % do orçamento | Folga até o gatilho | Efeito nos consumidores | Custo/risco |
| --- | --- | --- | --- | --- | --- |
| 32 GiB (~7 dias) | 9,7 / 8,0 / 7,0 | 29,1% de 110 GiB | 24,0 GiB | replay cai para ~1 semana; paper, G4 e RFC-013 intactos | joga fora 20 GiB de janela num disco 78% livre e força a poda a rodar justamente enquanto ela está travada |
| **52 GiB (manter)** | **15,7 / 13,0 / 11,4** | **47,3%** | **4,0 GiB** | replay ~13 dias; nada mais muda | nenhum; a quota passa a encostar no TTL de 14 dias |
| 55 GiB (teto sem mexer no orçamento) | 16,6 / 13,8 / 12,1 | 50,0% | 1,0 GiB | +0,8 dia de replay | queima 3 dos 4 GiB de folga do gatilho por menos de um dia |
| 64 GiB + orçamento 110 → 124 GiB | 19,3 / 16,0 / 14,1 | 51,6% de 124 GiB | 4,6 GiB (gatilho 111,6) | o TTL de 14 dias passa a ser o limite real | exige mover o orçamento global junto e redeclarar o alarme; ganho real de 1 a 3 dias |

**Efeito nos consumidores, medido no código, não estimado:** o paper lê uma
janela de features de **31 minutos** (`featurestore.ts`), então nenhuma opção
afeta a operação viva. O **G4 não depende da janela**: `broker.ts` persiste o
`consumedSlice` dentro do evento de fill exatamente para que "o replay do ledger
sobreviva ao TTL do `book_deltas`". A RFC-013 lê o livro corrente. **O único
consumidor que escala com a quota é o replay cru (RFC-007)** — pesquisa e
auditoria, não operação. As âncoras (`book_snapshots_full`, 30 d) e os
agregados de 1 min (`series_1m`, 0,86 GiB de 10 GiB) são independentes e
sobrevivem à poda dos deltas.

**Recomendação dada: manter 52 GiB** — o número foi declarado valendo 3,4 dias e
hoje entrega ~13, a 8% do TTL de 14 dias que já estava declarado; nada
operacional lê além de 31 minutos; e os 4 GiB de folga que sobram até o gatilho
valem mais do que o ~1 dia que uma subida compraria.

### DECISÃO DO PROPRIETÁRIO (2026-09-02 02:35Z, registrada)

1. **Quota de `book_deltas`: MANTIDA em 52 GiB**, redeclarada conscientemente
   com a série medida acima. O valor não muda; o racional que o acompanha no
   código muda inteiro, porque o antigo ("a quota morde em ~3,4 dias") é falso.
2. **Decidir agora, com 4,2 dos 7 dias.** A janela decidida em 28/08 fechava em
   **2026-09-04 21:06Z** e **faltavam 2 d 19 h**; o proprietário dispensou a
   espera com a série já na mesa. Registrado porque a decisão de 28/08 pedia a
   semana inteira: o intervalo de dias retidos (11,4 a 15,7) é largo justamente
   porque a variância entre dias é alta.
3. **A trava do gate de cobertura vai em PR separado**, com re-medição e teste
   de regressão próprios — não misturada com a redeclaração do número.

### Invariante

Soma declarada **95 GiB** < gatilho **99 GiB** (0,9 × 110 GiB), inalterada. O
teste ganhou o teto medido: a soma de todas as quotas **exceto** os deltas é
43 GiB, logo o teto dos deltas é **56 GiB exclusivo** — em 56 GiB a soma fica em
106.300.440.576 B, exatamente igual ao gatilho, e a comparação estrita reprova
(verificado com controle negativo). A asserção foi escrita como
`gatilho − demais` de propósito: na forma `deltas + (gatilho − declarado)` ela
seria algebricamente constante e nunca poderia falhar — a mesma degeneração de
"passa porque não há com o que comparar" que este arquivo já catalogou.

### Incidente ao vivo durante a medição (fora do escopo, não tocado)

O feed de deltas **parou em ~01:59Z e seguia parado às 02:31Z**: 18 linhas em
10 minutos contra ~104.000 esperadas, com `openConnections: 2`,
`reconnects: [0,0]` e `messagesForwarded: 14` — conexões vivas, stream mudo. Os
snapshots continuam fluindo (`fullSnapshots: 1057`). **Dois restarts não
resolveram** (o recreate do Compose às 01:59Z e o CD do #87 às 02:08Z). O kill
switch do paper engatou às **02:21:05Z** (`RECORDER_STALE`,
`orders_canceled: 0`) — o gatilho automático funcionando como projetado. É a
classe já registrada no #78 ("o defeito real é o silêncio, não a parada").

**Recuperou sozinho, ~2 h depois, sem intervenção** — a mesma assinatura do #78.
Linhas por hora, medidas depois: 01:00 **488.218** (saudável) · 02:00 **152** ·
03:00 **58** · 04:00 **19.784** (recuperando) · 05:00 386.678 · 06:00 508.398 ·
07:00 476.446 · 08:00 592.760 · 09:00 634.192. Parada de ~01:59Z a ~04:00Z,
~1 M linhas perdidas. O ritmo pós-recuperação (~500–630 mil/hora ≈ 13 M/dia)
cai **dentro** da faixa que a decisão usou, o que é a confirmação que importa:
a escolha não dependeu do período parado. **Efeito na medição:** as taxas da
série são um piso, não um teto — o dia 02/09 carrega duas horas de buraco.

## SESSÃO 2026-09-02 (2) — A PODA DE `book_deltas` ESTAVA TRAVADA: 0,08% de buraco bloqueava 100% da poda

Achado durante a medição da quota (sessão acima) e tratado em PR próprio por
decisão do proprietário. **Não é uma questão de tamanho de quota: qualquer
número que ele escolhesse seria inexequível**, porque o podador não conseguia
apagar uma linha sequer de `polymarket_book_deltas`.

### O defeito

`pruneCoveredToken` para no primeiro minuto sem agregado de 1 min
(`SERIES_COVERAGE_MISSING`) — e **esse minuto vira o minuto mais antigo
retido**. Toda execução seguinte recalcula a mesma borda, pede exclusão abaixo
dela e apaga **zero**. O gate **se auto-trava**: ele mesmo cria a condição que o
bloqueia.

**Medido em produção (2026-09-02), simulando o gate num corte de 7 dias:**

| Grandeza | Medido |
| --- | --- |
| Tokens com deltas mais antigos que o corte | 161 |
| Tokens bloqueados | **161 de 161** |
| Tokens presos no PRÓPRIO minuto mais antigo | **161** |
| Linhas liberáveis | **0** |
| Linhas retidas pelo gate | 24.684.160 (**7,21 GiB**) |
| Cobertura real dos minutos | **99,917%** (223 descobertos de 267.635) |
| Tokens com exatamente UM buraco | 119 (média 1,39, máximo 4) |
| Liberação se o minuto de borda for atravessado | 24.092.606 linhas (**7,04 GiB**), avanço médio de **62,3 h** por token |

**Controle positivo (o mecanismo, não a correlação):** o token mais pesado tem
`series_1m` desde 20/08 01:13 mas deltas só desde 23/08 14:45 — e 14:45 é um dos
3 minutos descobertos dele (11.249 de 11.252 cobertos). Só existe uma
explicação: a poda rodou, parou EXATAMENTE num minuto descoberto, e esse minuto
virou a borda. A última poda de `book_deltas` na vida do sistema foi em
**2026-08-28 10:28Z**.

### Por que atravessar a borda é correto — e só a borda

O minuto da frente é **parcial por construção**: ou é a borda do subscribe, ou é
onde a poda anterior parou. E o agregado de 1 min dele **nunca vai aparecer** —
`bookpipe.ts` só escreve o bucket que está enchendo no momento, chaveado pelo
mesmo relógio de ingestão do `received_at`; **não existe caminho de backfill**.
Esperar essa cobertura é esperar por algo que não pode chegar. Um buraco
**interior** continua parando o passe: atrás dele existe dado coberto mais
antigo, o que o torna uma falha de agregação real, digna de relatório e não de
exclusão.

A travessia apaga **exatamente um minuto** e é reportada em
`SERIES_COVERAGE_BOUNDARY_PRUNED` (nunca silenciosa), e o passe continua a
partir dali — então um token com vários buracos de borda converge **dentro de
uma execução** em vez de um buraco por varredura diária.

### Teste de regressão

O arquivo de teste **afirmava o congelamento como comportamento desejado**
(`"prunes nothing (and logs) when the token's first uncovered minute is its
oldest"`). Foi substituído por
`"crosses a coverage hole at the token's oldest minute instead of freezing
there"`, **verificado falhando no código anterior**: o código antigo emite o
DELETE em `06:00:00Z` (o próprio buraco — apaga nada) e o corrigido em
`06:01:00Z`, seguindo até o corte pedido. O teste do buraco **interior**
(`"truncates the prune at the hole"`) segue passando sem alteração — a
travessia não afrouxou esse caso.

### Urgência

O TTL de 14 dias começa a morder em **~2026-09-03 01:26Z** (o registro mais
antigo é de 20/08 01:26Z) e, sem esta correção, vai pedir exclusão e apagar
zero. `book_deltas` estava em **123.078.574 linhas / 37 GB físicos** às 09:51Z,
crescendo ~13 M linhas/dia, e cruza a quota de 52 GiB em ~4 dias. Depois disso o
único gatilho restante é o alarme global (99 GiB vivos), cuja única alavanca é
reduzir TTL — que também não apagaria nada.
