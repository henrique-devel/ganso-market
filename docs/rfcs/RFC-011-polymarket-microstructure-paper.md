# RFC-011 — Polymarket: microestrutura e paper broker

**Status:** accepted (2026-08-23 — refinada após verificação de prontidão; decisões de RAM, disco e sequenciamento aprovadas pelo proprietário)
**Dependências:** RFC-007 (recorder: registry Gamma, snapshots top-10, trades, regras versionadas, feeSchedule), RFC-010 (modelo fundamental — probabilidade `q` e limite inferior `q_lo`)
**Habilita:** RFC-009 (execução live) — o track record do paper broker desta RFC é insumo obrigatório dos gates; a RFC-013 (portfólio) consome as features e o ledger daqui

### Estado verificado das dependências (2026-08-23)

Verificação de prontidão executada contra o código e a produção (branch
`claude/rfc-011-readiness-2a6695`):

- **Prontos:** registry Gamma; snapshots top-10; book deltas L2 + âncoras +
  replay determinístico em instante arbitrário (`replay.ts`, endpoint
  `GET /polymarket/books/{token_id}?at=`); feeSchedule/tick/min_size
  versionados com consulta as-of (`/params?at=`); evento `tick_size_change`
  roteado para nova versão de parâmetro; disputas UMA e resolução com
  `outcomePrices` (via polling Gamma + `pollPendingOnce` de 10 min);
  calendário macro versionado; `q`/`q_lo`/`q_hi` publicados por
  `fundamental_estimates` e `GET /polymarket/estimates/latest`; microprice
  executável por book-walk **já versionado e declarado compartilhado com esta
  RFC** (`apps/api/src/polymarket/fundamental/microprice.ts` — é a primitiva
  da marcação a bid executável da Parte D2); `execution_mode` fail-closed em
  `paper`; retenção TTL+quota extensível (`retention.ts`); observabilidade
  JSON + `/data-quality`.
- **Parciais:** trades do WS perdem `size`, `fee_rate_bps` e
  `transaction_hash` no parser (ver Pré-trabalho abaixo — afeta C2 e C4);
  latência WS só tem lag one-way `ingest_lag_ms` p50/p99, sem round-trip
  (afeta C1 — usar default conservador); a verificação de CI de ausência de
  execução existe só para o módulo da RFC-010 e sem padrões EIP-712 (a
  tarefa 10 cria a do módulo paper).
- **Não existem:** pipeline onchain `OrderFilled`/HyperSync (fase 2 opcional
  da RFC-007 — a feature A4 de direção nasce `UNAVAILABLE`); parser WS de
  `market_resolved` (código morto — o polling Gamma cobre C5); qualquer
  emissor de intents (a tarefa 9 define o struct aqui); qualquer código,
  tabela ou serviço de paper broker.
- **Nota de sequenciamento:** a RFC-010 está em produção com modelos em
  `shadow` e gate `NO_EVIDENCE_OF_ALPHA` (8/100 mercados). Esta RFC **não**
  exige modelo promovido: opera com ordens manuais e intents (tarefa 9), e o
  consumo de `q`/`q_lo` usa o baseline publicado. Iniciar antes do gate PASS
  foi **aprovado pelo proprietário em 2026-08-23** (coerente com a decisão de
  "desenvolver o fluxo inteiro primeiro e só depois incrementar") e está
  registrado no HANDOFF. A promoção de modelo continua exigindo gate PASS +
  ação manual — isso não muda aqui.

## Prompt a executar

Você deve implementar a RFC-011 do Ganso Market: o modelo de microestrutura
(features sobre os dados gravados pela RFC-007), a política determinística de
tipo de ordem e o **paper broker** — um simulador de execução deliberadamente
pessimista, com ledger próprio e P&L marcado a bid executável. Nada aqui toca
execução real: não há assinatura de ordem, auth L1/L2 de trading, wallet ou
chamada a `POST /order` da CLOB. Isso é escopo exclusivo da RFC-009.

### Objetivo

Responder, para cada oportunidade que a RFC-010 sinalizar, as perguntas
"quando e como entrar, a que preço realmente executável, com que chance de
fill e a que custo" — e provar (ou refutar) o edge num simulador que erra
sempre para o lado conservador. Motivação empírica: paper trading com realismo
de execução inverte P&L de estratégias que pareciam lucrativas (relato
comunitário: "PnL agregado vira negativo; muito do que parecia lucrativo era
otimismo de execução"), fills reais chegam 2–10¢ piores que o book visto, e a
degradação esperada paper→live é de 20–50%. O simulador desta RFC existe para
absorver essa diferença antes que ela custe capital.

### Restrições não negociáveis

- Somente modo `paper`. Nenhuma autenticação CLOB de trading, signer, wallet,
  approval, depósito ou chamada real de ordem. Busca de código no CI confirma
  ausência desses caminhos (mesma verificação da RFC-007).
- **Nenhuma ordem — nem paper — sem limite explícito de preço.** Ordens
  marketáveis (FAK/FOK) exigem `worst_price` obrigatório; o validador rejeita
  qualquer ordem sem ele. Não existe "market order" no paper broker.
- Simulação pessimista por construção: em qualquer ambiguidade (posição de
  fila, latência, partial fill, fee), o simulador escolhe o resultado pior
  para o bot. É proibido presumir fill otimista (condição de parada
  desta RFC).
- Features de **direção de fluxo agressor** não podem usar o campo de direção
  do feed WS público (concorda só ~59% com o agressor real onchain; Kyle
  lambda inferido do feed inverte sinal em 43–60% das janelas — arXiv
  2604.24366). Fontes válidas: `OrderFilled` onchain (Envio HyperSync, pipeline
  da RFC-007/backfill) e, para tempo real, `last_trade_price` do WS tratado
  como trade sem direção confiável até reconciliação.
- Fronteira dura de regime em 28/abr/2026 (cutover V2): nenhum parâmetro do
  simulador (latência, fill rate, spreads) pode ser calibrado com dados
  pré-V2; usar exclusivamente o que o recorder próprio gravou.
- Sem VPN/proxy/contorno de geoblock; sem backup externo.
- UI e respostas de API exibem "SIMULAÇÃO — SEM EXECUÇÃO REAL".

### Orçamento

- As tabelas desta RFC usam a reserva compartilhada de 6 GB das RFCs 010–013
  definida na RFC-007. **Estado medido (2026-08-23):** as tabelas
  `fundamental_*` já alocam 4,7 GB dessa reserva em `retention.ts`, sobrando
  ~1,3 GB. Sub-quotas **aprovadas pelo proprietário em 2026-08-23**:
  features em janelas 0,6 GB; markouts + calibração de P(fill) 0,4 GB;
  ledger + ordens paper 0,3 GB. Quota vence TTL, como em toda a retenção do
  módulo.
- Feature pipeline + paper broker dentro do teto de 3 GB de RAM do módulo
  Polymarket (somado aos collectors da RFC-007). **Restrição concreta:** o
  gate de CI `check_compose_policy.py` limita a soma dos `mem_limit` do
  Compose a 4 GiB e a folga atual é de 128 MiB. **Decisão aprovada pelo
  proprietário em 2026-08-23:** criar o serviço `polymarket-paper` com
  256 MiB, reduzindo `model-worker` (stub sem modelo) para caber no cap.
  **Nota de implementação:** o corte foi para **96 MiB**, não os 128
  cogitados — o cap do `check_compose_policy.py` é estrito (`< 4 GiB`) e
  com 128 o agregado cairia exatamente em 4 GiB; com 96 fica em 4064 MiB.
  O runner nunca vive no estimador — o `scope.test.ts` da RFC-010 proíbe
  qualquer caminho de ordem naquele módulo.
- Persistência dentro da quota compartilhada de 40 GB do PostgreSQL:
  features agregadas em janelas (1s/10s/1min), nunca re-persistir o book cru;
  ledger e ordens paper são pequenos (single-user).
- Computação incremental orientada a evento (novo snapshot/trade → update de
  janela), sem re-scan de histórico em hot path.
- TTL: features por token 30 dias; markouts e amostras de calibração de fill
  180 dias (são o dataset de validação da RFC-009); ledger paper sem TTL até
  a quota (é o track record dos gates).

### Parte A — Features de microestrutura

Todas as features levam `source_ts` e `received_ts`, são computadas por
`token_id` e persistidas em janelas. Nenhuma feature pode olhar dado posterior
ao timestamp da decisão (teste de look-ahead obrigatório).

1. **Spread**: spread cotado (ask−bid), half-spread em bps do mid, e spread
   efetivo por tamanho S (book-walk de S shares nos dois lados). Referência de
   sanidade pré-V2: half-spread cotado mediano ~400 bps em 40–60¢ e
   1.300–1.800 bps abaixo de 10¢ — re-medir no V2 e alertar se divergir em
   ordem de grandeza.
2. **Profundidade por nível**: tamanho nos 10 melhores níveis de cada lado;
   profundidade executável acumulada a k ticks do touch (k=1,2,5,10);
   fração top-of-book / top-10 (pré-V2 ~13,6% — o topo do livro é fino;
   sizing nunca pelo touch).
3. **Imbalance**: (bid_depth − ask_depth)/(bid_depth + ask_depth) no top-1 e
   no top-k, por janela.
4. **Fluxo agressor**: volume assinado por janela, exclusivamente das fontes
   válidas acima; OFI/pressão só quando houver reconciliação onchain; enquanto
   não houver, publicar volume não-assinado e marcar a feature de direção como
   `UNAVAILABLE` (nunca degradar silenciosamente para o campo do WS).
   **Estado na entrega:** o pipeline onchain `OrderFilled` (Envio HyperSync)
   não está implementado (fase 2 opcional da RFC-007), então esta feature
   nasce `UNAVAILABLE` publicando apenas volume não-assinado — isso não
   bloqueia a RFC; a política de ordem (Parte B) não depende dela.
5. **Velocidade de cancel/repost**: taxa de eventos `price_change` com
   remoção (size→0) e reposição por nível por janela; proxy de quote churn e
   de MM ativo no mercado.
6. **Volatilidade recente**: vol realizada do mid em janelas de 1/5/30 min;
   contagem de jumps (>N ticks entre snapshots consecutivos).
7. **Idade do último trade**: agora − ts do último `last_trade_price`;
   staleness do book (idade do último snapshot/delta aceito).
8. **Tempo até catalisador e até resolução**: minutos até o próximo
   catalisador conhecido (calendário macro versionado: CPI/FOMC; vencimento
   do bucket crypto) e até `endDate`/`umaEndDate` do Gamma. Racional
   Glosten-Milgrom: adverse selection piora perto de eventos informacionais —
   esta feature alimenta a política de ordem (item B4).
9. **Probabilidade de fill (passivo)**: modelo empírico P(fill | distância ao
   touch em ticks, profundidade à frente, churn, vol, tempo restante da
   ordem), calibrado apenas com dados do recorder (trades observados no nível
   vs fila estimada). Publicar com intervalo, walk-forward, nunca k-fold.
10. **Adverse selection pós-fill (markout)**: para cada fill paper, mid (e bid
    executável) a +1s/+10s/+60s/+300s menos preço do fill, assinado pelo lado.
    Referência: markout passivo −0,7 a −1,7¢ quando o fair externo move contra
    a quote — o markout é a métrica que decide se a quote deveria ter sido
    cancelada.

### Parte B — Política de tipo de ordem

Política determinística, sem discricionariedade, registrada com cada ordem
(campo `policy_reason`):

1. **Default: passivo.** GTC ou GTD com flag post-only (rejeita se cruzaria o
   spread). Justificativa econômica gravada: maker paga fee zero e recebe
   rebates; taker em crypto paga a fee mais cara (feeRate 0,07; pico
   ~US$ 1,75/100 shares a p=0,5, fórmula `fee = C × feeRate × p × (1−p)`).
2. **GTD sem urgência**: replicar a semântica V2 — `expiration` em segundos
   Unix (vs `timestamp` do struct em ms), expira 1 minuto antes do declarado,
   mínimo 3 minutos no futuro; para vida útil de N s usar `now + 60 + N`. O
   paper broker aplica exatamente esse buffer.
3. **FAK/FOK somente com `worst_price` explícito** e somente quando
   `q_lo − pior_preço_estimado_por_book_walk > fee_taker + margem` (fee taker
   pela categoria vigente no feeSchedule versionado). O simulador respeita o
   `worst_price`: book-walk para além dele deixa o resto da ordem não
   preenchida (FAK) ou cancela tudo (FOK).
4. **Regras de recuo**: alargar/puxar quotes quando `tempo_até_catalisador`
   cair abaixo de limiar configurável e quando o fair externo (Chainlink TWAP
   via RTDS, para crypto) mover contra a quote — uso defensivo do sinal
   externo (cancelar quote stale), nunca ataque taker (markout taker +1s é
   negativo em todos os símbolos medidos).
5. **Taker delay simulado**: ordens marketáveis em crypto/finance sofrem delay
   de 250 ms antes do match, com **cancelamento bloqueado durante o delay** —
   o simulador aplica o book do timestamp `decisão + latência + 250ms`, não o
   book visto na decisão.
6. **Validador local de ordem** (pré-condição de qualquer ordem paper):
   replicar a sequência oficial de arredondamento (preço para baixo, shares
   para baixo, valor USD até Amount+4 para cima e depois para baixo até
   Amount), com precisões por tick (0,1→1/2/3; 0,01→2/2/4; 0,005→3/2/5;
   0,0025→4/2/6; 0,001→3/2/5; 0,0001→4/2/6); validar `min_order_size` e
   `tick_size` do último `GET /book` gravado; reagir ao evento
   `tick_size_change`. Ordem que não passa no validador nem entra no ledger.

### Parte C — Simulador paper (paper broker)

1. **Book-walk taker**: executar contra o book gravado em
   `t_decisão + latência_simulada` (latência amostrada de distribuição medida
   do próprio recorder: p50/p95 de round-trip WS + margem configurável;
   default conservador se ainda não houver medição). Consome níveis na ordem,
   respeita `worst_price`, gera partial fills por nível.
   **Estado na entrega:** o recorder mede hoje apenas o lag one-way de
   ingestão (`ingest_lag_ms`, p50/p99 em `/data-quality`); o PONG do WS é
   descartado sem cronometrar, logo não existe round-trip medido. Usar
   default conservador configurável (proposta: 1.000 ms, nunca abaixo do
   p99 do lag one-way corrente) até haver medição própria; cronometrar o
   PONG é pré-trabalho opcional (abaixo).
2. **Fila passiva conservadora**: ordem passiva entra **atrás de toda a
   profundidade visível** no nível no momento do aceite. Fill passivo só
   ocorre quando o volume de trades observado no nível (via
   `last_trade_price` gravado) exceder a fila à frente; cancels à frente
   **não** melhoram a posição do bot (conservador por design); se o nível é
   varrido, o bot só participa do resíduo após a fila. Fills parciais
   passivos permitidos; a porção preenchida não é cancelável.
3. **Cancelamento com latência**: cancel também sofre latência simulada;
   trades que chegam entre o pedido de cancel e sua efetivação ainda podem
   preencher a ordem (adverse selection realista); cancel proibido durante o
   taker delay (item B5).
4. **Fees versionadas por categoria**: cobradas no match usando o
   `feeSchedule` vigente gravado pela RFC-007 (as fees mudam ao longo do
   tempo por categoria — ex.: sports em 10/jul/2026); reconciliar com o
   `fee_rate_bps` real do evento WS `last_trade_price` quando disponível e
   registrar a divergência. Rebates maker e taker **não** entram no P&L
   líquido (upside não confiável; taker rebate tem relato de não-pagamento) —
   se estimados, aparecem em linha separada "não realizada".
5. **Resolução trinária 0/1/0,5**: ao evento `market_resolved`
   (`winning_asset_id`) ou resolução via Gamma — **fonte operante hoje: o
   polling Gamma com `pollPendingOnce` (10 min), que grava `outcomePrices`
   em `polymarket_resolution_events`; o caminho WS `market_resolved` é
   código morto no parser (TODO da RFC-007, não bloqueia)** — o ledger
   liquida shares a
   US$ 1 (vencedor), US$ 0 (perdedor) ou US$ 0,50 (resultado 50/50). Em
   mercados negRisk o desfecho 0,5 é estruturalmente impossível (o
   NegRiskAdapter reverte `[1,1]`) — o simulador deve rejeitar 0,5 nesses
   mercados e tratá-lo como erro de dados. Registrar o lockup real
   (decisão→resolução) por posição.
6. **Haircut de estresse**: parâmetro global `stress_slippage` (default: +1
   tick em cada fill taker; modo estresse: +2 a +10¢ conforme relato de fills
   reais 2–10¢ piores) e `fill_degradation` (fração de fills passivos
   aleatoriamente negados, default 0,3). O relatório de performance publica
   sempre três colunas: otimista (sem haircut, apenas para diagnóstico),
   base conservadora e estresse.

### Parte D — Ledger paper e P&L

1. Ledger de eventos imutáveis e idempotentes (append-only):
   `order_accepted`, `order_rejected(reason)`, `cancel_requested`,
   `cancel_effective`, `fill(partial|full, price, size, fee, fee_schedule_id)`,
   `resolution(0|1|0.5)`, `mark`. Replay do ledger reconstrói posições e P&L
   bit a bit.
2. **Marcação a bid executável**: posição marcada pelo proventos de um
   book-walk de saída do tamanho total da posição no lado de liquidação
   (bid para posição comprada), no book gravado mais recente e válido —
   nunca mid, nunca last trade (o preço do site é midpoint/last e não é
   executável). Book stale (idade > limiar) marca a posição como `STALE_MARK`
   e congela o valor com flag, sem inventar preço.
3. P&L: realizado (fills + resoluções − fees) e não realizado (mark), bruto e
   líquido; custo de capital/lockup reportado por posição (E[lockup] entra no
   hurdle da RFC-010, aqui só se mede o realizado).
4. Kill switch paper: `POST /polymarket/paper/kill-switch` cancela todas as
   ordens paper abertas, bloqueia novas ordens até rearm manual e registra o
   evento no ledger. Gatilhos automáticos: perda diária paper acima de limiar
   configurável, staleness global do recorder, disputa UMA detectada em
   mercado com posição (congela entradas naquele mercado).

### Pré-trabalho (correções de escopo RFC-007, antes da Parte C)

1. **Obrigatório — parser de trades WS descarta campos.**
   `parseLastTrade` em `apps/api/src/polymarket/messages.ts` constrói um
   literal com apenas 6 campos e descarta `size`, `fee_rate_bps` e
   `transaction_hash` do frame cru; em produção, `polymarket_trades` com
   `provenance='ws'` tem esses três campos NULL e o índice de dedupe WS
   (`WHERE transaction_hash IS NOT NULL`) nunca se aplica. Sem `size` em
   tempo real, a fila passiva (C2) não tem volume por nível; sem
   `fee_rate_bps`, a reconciliação de fee (C4) não existe; sem
   `transaction_hash`, a futura reconciliação onchain (A4) perde a chave de
   junção. Corrigir o parser para carregar os três campos, corrigir o teste
   (hoje ele monta a mensagem à mão com os campos e não exercita o caminho
   real) e lembrar do rebuild explícito do recorder no deploy (o CD não
   troca a imagem de profile).
2. **Opcional — round-trip WS:** cronometrar o PONG em `dualws.ts` e expor
   p50/p95 (hoje o PONG é descartado); enquanto não houver, vale o default
   conservador de C1.
3. **Opcional — sync do calendário macro:** agendar junto do job de 10 min
   em vez de só no boot (fragilidade registrada no HANDOFF em 2026-08-23;
   alimenta a feature A8).

### Tarefas

1. Schema PostgreSQL de features (janelas 1s/10s/1min por token) + jobs
   incrementais orientados a evento, com TTLs e pruning por quota.
2. Implementar as 10 features da Parte A com testes unitários por feature
   (fixtures de book/trades gravados).
3. Implementar o validador local de ordem (B6) com tabela de precisões por
   tick e a sequência exata de arredondamento; fixtures cobrindo todos os
   tick sizes.
4. Implementar a política de tipo de ordem (B1–B5) como função pura
   `decide_order_type(contexto) → {tipo, preço_limite, worst_price?, ttl?,
policy_reason}`; proibir por tipo qualquer saída sem limite de preço.
5. Implementar o paper broker (C1–C6) como serviço que consome o stream do
   recorder e o relógio simulado/real; nenhum acesso à CLOB de trading.
6. Implementar ledger, marcação a bid executável, P&L e kill switch (D1–D4).
7. Implementar coleta de markout pós-fill e o dataset de calibração de
   P(fill) (A9–A10), com job de re-calibração walk-forward semanal.
8. Relatório de performance: fill rate por tipo/distância, slippage previsto
   vs realizado, markout médio por bucket, P&L nas três colunas
   (otimista/base/estresse), comparação com baseline "não operar".
9. Integração com RFC-010: o paper broker aceita intents
   `{token_id, lado, q, q_lo, tamanho_máx}` e devolve decisão da política +
   resultado simulado; sem RFC-010 ativa, aceita ordens manuais via API.
   **Interface concreta:** não existe emissor de intents (o escopo da
   RFC-010 proíbe o módulo fundamental de emitir sinal/ordem), então o
   struct de intent é definido aqui e o consumo de `q`/`q_lo` se dá por
   polling de `GET /polymarket/estimates/latest` ou leitura direta de
   `fundamental_estimates` (respeitando o filtro de frescor de 5 min).
10. Documento explícito de ausência de execução real + verificação automática
    no CI (grep por endpoints/domains de trading, structs EIP-712 de ordem).
    **Implementação:** clonar
    `apps/api/test/polymarket/fundamental/scope.test.ts` para o módulo
    paper, acrescentando padrões EIP-712 (`signTypedData`, `EIP712Domain`,
    `verifyingContract`) que o guard existente não cobre.

### API mínima

- `POST /polymarket/paper/orders` — corpo exige `token_id`, `side`,
  `size`, `limit_price`; `order_type` ∈ {GTC, GTD, FAK, FOK}; `post_only`
  (bool, default true para GTC/GTD); `worst_price` obrigatório para FAK/FOK;
  `ttl_s` para GTD. Sem `limit_price` → 422.
- `DELETE /polymarket/paper/orders/{id}`
- `GET /polymarket/paper/orders?status=open|filled|canceled|rejected`
- `GET /polymarket/paper/positions` — com mark a bid executável, flag
  `STALE_MARK`, lockup corrente.
- `GET /polymarket/paper/performance` — três colunas
  (otimista/base/estresse), fill rate, slippage, markout, fees pagas.
- `POST /polymarket/paper/kill-switch` e `POST /polymarket/paper/kill-switch/rearm`
- `GET /polymarket/microstructure/{token_id}` — snapshot corrente das
  features da Parte A com `source_ts`/`received_ts` e flags `UNAVAILABLE`.

Nenhum endpoint de trading real, wallet ou depósito.

### Artefatos

- Feature pipeline + schema e TTLs.
- Validador local de ordem (tick/size/amount) com fixtures.
- Política de tipo de ordem (função pura + testes).
- Paper broker (book-walk, fila conservadora, latência, cancel, taker delay,
  fees versionadas, resolução 0/1/0,5, haircuts).
- Ledger append-only + marcação a bid executável + kill switch.
- Dataset de markout e calibração de P(fill).
- Relatório de performance em três colunas.
- Documento de ausência de execução + verificação de CI.

### Testes obrigatórios

- Cada feature da Parte A contra fixtures com resultado esperado; teste de
  look-ahead (feature computada em t não muda quando chegam dados > t).
- Feature de direção: garantir que o campo de direção do WS **não** é lido
  (teste de código) e que sem reconciliação onchain a saída é `UNAVAILABLE`.
- Validador: todos os tick sizes da tabela; ordem abaixo de `min_order_size`
  rejeitada; sequência de arredondamento byte a byte contra casos da doc.
- Ordem sem `limit_price` → 422; FAK/FOK sem `worst_price` → 422; nenhum
  caminho de código cria ordem sem limite (teste de propriedade).
- Book-walk: partial fill por nível, respeito ao `worst_price`, FAK vs FOK.
- Fila passiva: fill só após trades excederem a fila à frente; cancels à
  frente não melhoram posição; porção preenchida não cancelável.
- Latência e taker delay: fill usa o book de `t+lat(+250ms)`, não o da
  decisão; cancel durante delay rejeitado; trade entre cancel_requested e
  cancel_effective ainda preenche.
- Fees: schedule versionado aplicado pelo `fee_schedule_id` da época do fill;
  mudança de schedule no meio de uma posição não reescreve fills antigos;
  reconciliação com `fee_rate_bps` diverge → evento registrado.
- Resolução: YES, NO e 0,5 (paga US$ 0,50); 0,5 em negRisk → erro, nunca
  liquidação silenciosa.
- Ledger: replay determinístico reconstrói posições/P&L; eventos duplicados e
  out-of-order são idempotentes. Cada fill grava o trecho de book efetivamente
  consumido (níveis e tamanhos), tornando o replay independente do TTL dos
  `book_deltas` da RFC-007.
- Mark: book stale → `STALE_MARK`, valor congelado; mark usa book-walk do
  tamanho total, não o touch.
- Kill switch: cancela tudo, bloqueia novas ordens, exige rearm; gatilho de
  disputa UMA congela entradas no mercado afetado.
- Boot falha se `execution_mode != paper`; busca de código confirma ausência
  de auth/wallet/ordem real.
- Soak de 24h com o recorder live dentro do orçamento de RAM/disco.

### Critérios de aceite

- Nenhuma ordem paper existe no ledger sem `limit_price`; nenhuma marketável
  sem `worst_price`.
- Todo fill paper é reproduzível pelo ledger + trecho de book persistido no
  próprio fill, mesmo após o pruning dos `book_deltas`.
- O relatório de performance sempre publica as três colunas; a coluna
  "otimista" nunca é usada em gate — gates da RFC-009 leem exclusivamente a
  coluna base conservadora ou estresse.
- P(fill) e markout calibrados apenas com dados pós-V2 do recorder próprio;
  re-calibração walk-forward registrada.
- Marcação de posição é sempre bid executável por book-walk ou `STALE_MARK` —
  nunca mid/last.
- Kill switch funcional e testado; disputa UMA em mercado com posição congela
  entradas.
- Não existe caminho de execução real (verificação de CI verde).

### Condições de parada

Pare se:

- a tarefa pedir qualquer forma de execução real, assinatura de ordem, auth
  de trading ou contorno de geoblock (escopo RFC-009 / proibido);
- o simulador precisar presumir fill otimista, posição de fila melhor que
  "atrás de toda a profundidade visível", ou latência menor que a medida;
- alguma feature de direção só puder ser obtida do campo de direção do feed
  WS;
- a calibração exigir dados pré-28/abr/2026 ou arquivos de terceiros não
  auditáveis como fonte primária;
- o pipeline estourar o orçamento de 3 GB de RAM ou a quota de PostgreSQL sem
  possibilidade de agregação/TTL;
- algum componente solicitar private key, credencial de trading ou approve de
  token nesta fase.
