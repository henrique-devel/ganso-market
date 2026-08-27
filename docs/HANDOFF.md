# Handoff do projeto Ganso Market

- Última atualização: 2026-08-27 (madrugada — degenerações de G2/G3/G4
  fechadas e **ativas em produção** com config 1.2.0, registro da aprovação do
  G6 implementado, ponte de paper decidida em documento, segundo bloco de
  checagem rodado pela primeira vez; **as quatro decisões de calibração do
  proprietário registradas**, um achado novo saído da primeira delas — a
  provenance da entrada expira antes da posição — e a **ponte decisão → ordem de
  paper implementada** com migration 0015, verificada contra PostgreSQL real e
  **ainda não deployada**)
- Branch principal: `main`
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
- **BLOQUEIO/TODO:** não existe CLI nem endpoint que **registre** uma versão
  nova de modelo; hoje o registro só acontece pelo catálogo no boot. Treinar
  uma versão calibrada exigirá esse caminho (registrado no runbook).

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
  PostgreSQL, por decisão de escopo atual.
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

### 3. (IMPLEMENTADA, não deployada) A ponte decisão → ordem de paper

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

**O que falta é deploy, e ele tem três passos como sempre:** merge, CD, e rebuild
de profile do `polymarket-paper` **e** do `polymarket-portfolio` — o binário
antigo do paper não tem o job `bridge` —, mais a migration 0015 aplicada. Primeiro
sinal a observar depois: `paper_positions` ganhando linha. `paper_orders` crescendo
sem posição nenhuma significa que as ordens passivas não estão sendo preenchidas,
e o G2 continua parado.

### 3b. Cadência de escrita do decision log (decisão 1, itens b e c)

Escrever a entrada só quando o veredito muda, como o ciclo de saída já faz;
medir antes o fator de redução real no log de produção (trocas de assinatura por
mercado por dia); registrar a interpretação de "toda intenção persiste"; e só
então TTL 180 → 90 em `retention.ts`. Fora do PR da ponte — são áreas
diferentes, e o carimbo de provenance é o que urge.

### 3c. Shadow replay de `custo_capital_anual` (decisão 2)

Varredura de taxas candidatas sobre o decision log gravado, usando
`inputs_json.replay`, medindo quantas decisões mudam de veredito, de tamanho e
de binding constraint. Roda contra a janela de ~3 dias que existe hoje (ou
depois de 3b). O número da varredura é o que cunha a config 1.3.0 — não antes.

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

- **Coletor onchain** (`JOB_FAILED job:"onchain"`, `ONCHAIN_POLLED` zerado): o
  `polygon-rpc.com` da config devolve 403 desde que a RFC-012 foi escrita; o
  failover está correto e a segunda URL funciona, então a causa real é outra e o
  #37 vai revelá-la. Considerar remover o endpoint morto da config.
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
- **Ponte decisão → ordem de paper**: implementada e verificada contra PostgreSQL
  real, **não deployada**. Precisa de merge, CD, migration 0015 e rebuild de
  profile do `polymarket-paper` e do `polymarket-portfolio`. Primeiro sinal a
  observar: `paper_positions` ganhando linha — `paper_orders` crescendo sem
  posição significa ordem passiva sem fill, e o G2 continua parado.
- **`portfolio_panel_snapshots` declara 30 dias de TTL** e, pela mesma
  aritmética, retém a ordem de 3. Sem consumidor profundo (a API só lê a linha
  mais nova por token), então é etiqueta errada e não perigo. Medir
  `pg_column_size` em produção e redeclarar.
- **`custo_capital_anual`** — **decidido** em 2026-08-27: subir para tornar
  vinculante, com o número saindo de um shadow replay sobre o decision log
  gravado. Correção do achado original: o cruzamento é `r > 0,1825 / preço`, não
  um único "18,3% a.a." — 19,2% só morde no topo da banda de compra e 36,5% é o
  necessário a meio preço. Na **saída** o parâmetro já é vinculante hoje (o
  critério 6 cobra o lockup integral), então subir também deixa a saída mais
  impaciente. `config/portfolio.json` fica em **1.2.0** até a varredura dar o
  número.
- **`g2MaxSinglePositionPnlShare = 0,25`** — **aprovado** pelo proprietário em
  2026-08-27; deixa de ser número do implementador. Revisão contra dado real
  quando o G2 tiver ≥ 100 posições fechadas, o que depende da ponte de paper.
- **PnL realizado por janela**: total exato; janelas diária/semanal atribuem pelo
  `resolved_at`, então realização por fechamento antecipado entra tarde. Detalhe
  e motivo em `docs/test-results/RFC-013-portfolio-engine.md` §9.
- `consensus`/`nowcast` no `config/macro-calendar.json` continua pendente.

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
