# RFC-007 — Polymarket: fundação de dados e recorder V2

**Status:** draft (reescrita de 2026-08-19; substitui a versão "analytics e paper trading" — baseline/modelos migraram para a RFC-010 e microestrutura/simulador para a RFC-011)
**Dependências:** RFC-001 (infraestrutura/monorepo) e RFC-002 (auth single-user)
**Habilita:** RFC-010 (modelo fundamental), RFC-011 (microestrutura e paper broker), RFC-012 (risco de resolução e grafo lógico) e RFC-013 (motor de portfólio e gates). Execução real permanece exclusiva da RFC-009, após gates + aprovação do proprietário.

## Prompt a executar

Você deve implementar a RFC-007 do Ganso Market: expandir o recorder Polymarket
já em produção (Gamma registry + snapshots top-10 a cada 2–5s via WebSocket,
tabelas `polymarket_markets` e `polymarket_book_snapshots`) para a fundação de
dados completa do módulo. Esta RFC é **somente dados**: coleta, versionamento,
qualidade, retenção e API de leitura. Nenhum modelo, sinal, simulador ou
execução é implementado aqui.

Justificativa (pesquisa 2026-08): não existe histórico oficial de book L2 — o
WSS não tem replay, o RTDS não tem replay e `/prices-history` só retorna pares
(t, p). O recorder próprio é a única fonte de microestrutura histórica, e
fontes de terceiros já provaram ser frágeis (archive.pmxt.dev foi desligado).
Tudo que as RFCs 010–013 vão consumir precisa começar a ser gravado agora.

### Objetivo

Gravar continuamente, com `source_ts` e `received_at` em todo registro, o
conjunto completo de dados exigido pelo plano do proprietário (2026-08-18):

1. Texto completo e versões das regras + fonte oficial de resolução + prazos.
2. Eventos, tags, outcomes e relações negative-risk.
3. Livro de ofertas **completo com deltas** (não só top-10) para o universo
   selecionado; bid/ask/spread/profundidade.
4. Trades.
5. Volume, open interest, holders e concentração.
6. Taxas, tick size e tamanho mínimo, em tempo real e versionados.
7. Clarificações, disputas UMA e mudanças de status.
8. Feeds externos da categoria crypto (Chainlink TWAP 30/60s — o dado que
   resolve os mercados — e Binance spot via RTDS).
9. Calendário macro oficial (BLS/BEA/FOMC) e valores oficiais dos releases,
   versionados — insumo do modelo fundamental (RFC-010).

Com qualidade auditável (gaps medidos, reconciliação por hash, replay
determinístico) e retenção dentro de 40 GB de PostgreSQL.

### Restrições não negociáveis

- Nenhuma autenticação CLOB L1/L2 de trading, wallet, signer, approvals,
  depósito ou chamada de ordem — escopo da RFC-009. Todas as fontes desta RFC
  são públicas e não exigem credencial de trading.
- Nenhum proxy/VPN/spoofing/evasão de geoblock. Acesso a partir do servidor
  real (Hetzner, Alemanha); risco jurisdicional é do proprietário (emenda de
  PRD de 2026-08-15).
- `execution_mode` do módulo aceita somente `paper`.
- Sem backup externo; sem retenção ilimitada (quotas e TTL abaixo).
- Dependências pinadas (lockfile + hash); SDKs somente do org oficial
  `github.com/Polymarket` (o nicho tem typosquatting documentado, ex.:
  usuário "dev-polymarket" clonando repositórios oficiais).
- Tratar 28/abr/2026 (cutover CLOB V2) como fronteira dura de regime em
  qualquer dado histórico importado.
- Verificar a documentação oficial atual antes de fixar endpoints/schemas.

### Fontes (todas públicas, sem auth de trading)

| Fonte                                                         | Uso nesta RFC                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gamma API (`gamma-api.polymarket.com`)                        | Catálogo, regras (`description`), campos UMA, `negRisk`, `feeSchedule`, tags/eventos. **Paginação keyset** (`/markets/keyset`, `/events/keyset`, máx 100/página) — não usar offset.                                                                                                  |
| CLOB REST (`clob.polymarket.com`)                             | `/book` (snapshot + `tick_size` + `min_order_size` + `neg_risk` num call), `/clob-markets/{condition_id}` (`mts`, `mos`, `mbf/tbf`, `fd`, `itode`), `/fee-rate`, `/tick-size`, `/prices-history`.                                                                                    |
| WSS market (`ws-subscriptions-clob.polymarket.com/ws/market`) | `book` (snapshot + hash), `price_change` (deltas), `last_trade_price` (com `fee_rate_bps` e `transaction_hash`), `tick_size_change`; com `custom_feature_enabled`: `best_bid_ask`, `new_market`, `market_resolved`. PING a cada 10s.                                                 |
| Data API (`data-api.polymarket.com`)                          | `/trades` (com `takerOnly=false`; limit clampado a 10.000 e offset máx 10.000 — backfill por janelamento de timestamp), `/oi`, `/holders`, `/live-volume`.                                                                                                                           |
| RTDS (`ws-live-data.polymarket.com`)                          | `crypto_prices` (Binance spot), `crypto_prices_twap_thirty/sixty` (Chainlink TWAP que resolve os mercados crypto). PING 5s; **sem replay** — gravação contínua obrigatória.                                                                                                          |
| Fontes macro oficiais (BLS, BEA, Federal Reserve)             | Calendário versionado de eventos macro agendados (datas/horários em UTC) e valores oficiais no instante da publicação, com `source_ts`/`received_at`; nowcasts públicos (Cleveland Fed, CME FedWatch) quando o modelo macro da RFC-010 for ativado, cada um com `source_ts` próprio. |
| On-chain (opcional, fase 2 desta RFC)                         | Eventos `OrderFilled` do CTF Exchange V2 (`0xE111180000d2663C0091e4f400237545B87B996B`) via Envio HyperSync (token grátis) — o subgraph Goldsky antigo é incompleto pós-V2. Única fonte confiável de direção de agressor (o feed WS erra ~41% das direções).                         |

Rate limits oficiais folgados para single-user (global 15.000 req/10s; Gamma
`/markets` 300/10s; CLOB `/book` 1.500/10s; Data `/trades` 200/10s; exceder =
throttling, não ban). O design deve respeitar margem de 50% dos limites.

### Universo

- **Categorias-alvo:** (a) crypto/preço de ativos (BTC, ETH e majors: mercados
  de threshold diário/semanal e séries curtas 5min/15min/1h — são os de menor
  taxa de disputa, 0,6%, e menor wash trading, 3%); (b) macro agendado
  (Fed/FOMC, CPI, NFP, PIB — resolução por publicação oficial datada).
- **Exclusões duras:** eleições, live sports, mentions, geopolítica,
  outcomes placeholder de augmented negRisk (gravar somente outcomes
  **nomeados**), mercados com `description` vazia, mercados com fonte de
  resolução subjetiva ("consenso de mídia", critério estético).
- **Caps:** 50–100 mercados ativos / 100–200 token IDs com L2 completo.
  Cap é aplicado por prioridade: (1º) macro agendado com catalisador ≤ 30
  dias; (2º) crypto threshold diário/semanal; (3º) séries curtas crypto.
  Universo re-selecionado a cada ciclo Gamma (10 min); entrada/saída de
  mercado do universo é registrada com timestamp e motivo.
- Liquidez avaliada por **profundidade de book e spread**, nunca por volume
  bruto (~25% do volume da plataforma é wash trading — Columbia, nov/2025).

### Orçamento

- Até 40 GB de PostgreSQL para o módulo (quotas por tipo abaixo somam 30 GB;
  4 GB de headroom para índices/WAL/bloat; 6 GB reservados para as tabelas
  das RFCs 010–013, que citam essa reserva).
- Aplicações do módulo até 3 GB de RAM em carga (book cache em memória
  limitado ao universo; sem Redis).
- Dimensionar ingestão para bursts de ~1.000 updates/s (relato de recording
  profissional): escrita em lote (COPY/batch insert), fila interna com
  backpressure e descarte controlado **nunca silencioso** (gap registrado).

### Tarefas

1. **Registry e catálogo (expandir o existente).** Poll Gamma keyset a cada
   10 min: mercados, eventos, tags, outcomes, `conditionId`, `clobTokenIds`,
   `negRisk`/`negRiskOther` e relações evento↔mercados (grupos negRisk
   persistidos como entidade própria, insumo do grafo lógico da RFC-012 e dos caps de grupo da RFC-013).
   IDs canônicos: `condition_id` + `token_id`.
2. **Regras versionadas.** Persistir `description` (o texto da regra),
   `resolutionSource`, `resolvedBy`, `endDate`, `umaEndDate`, `umaBond`,
   `umaReward`, `customLiveness`, `automaticallyResolved` com versionamento
   por diff: nova linha somente quando o conteúdo muda (comparar com
   `updatedAt` e hash do texto). Diff de `description` = clarificação
   detectada → registrar evento `rule_change` (não existe feed oficial de
   clarificações; 43% das disputas vêm de wording).
3. **Parâmetros de mercado versionados.** `feeSchedule`/`fee-rate` (bps),
   `tick_size`, `min_order_size`, `neg_risk` flag, curva `fd` de
   `/clob-markets/{condition_id}` — snapshot no onboarding do mercado + nova
   versão a cada mudança (evento WS `tick_size_change`; re-poll de fees 1x/h).
   Fees mudam por categoria ao longo do tempo (ex.: sports em 10/jul/2026) —
   toda versão carrega vigência `[valid_from, valid_to)`.
4. **Livro completo com deltas.** Para o universo selecionado, assinar o WSS
   market e persistir: snapshot `book` completo (com `hash`) no subscribe e
   a cada re-sync; todo `price_change` (delta por nível; size 0 = remoção)
   em tabela append-only `polymarket_book_deltas` com `seq` local
   monotônico. Manter book cache em memória e verificar consistência pelo
   `hash` do evento `book`. **Duas conexões WS independentes** com dedupe
   por conteúdo (o feed dropa mensagens; uma conexão não basta); divergência
   entre conexões → re-sync via REST `/book`. Manter os snapshots top-10 a
   cada 2–5s já existentes como série derivada (compatibilidade).
5. **Trades.** Persistir `last_trade_price` do WS (com `fee_rate_bps` real e
   `transaction_hash`) e poll incremental de `/trades` com `takerOnly=false`
   e janelamento por timestamp para backfill (~3 anos disponíveis por
   mercado). Marcar a proveniência (ws|data_api|onchain). Fase 2 opcional:
   `OrderFilled` on-chain via HyperSync para direção de agressor ground-truth.
6. **Séries amostradas (só existe valor corrente na API).** A cada 15 min por
   mercado do universo: OI (`/oi`), volume (`/live-volume`), top holders por
   outcome (`/holders`) e métricas derivadas de concentração (share do top-1
   e top-5, nº de holders). A cada 1 min: agregado OHLC de mid, best bid/ask,
   spread e profundidade top-1/top-5/top-10 (derivado do book cache).
7. **Status, disputas e resolução.** Poll de `umaResolutionStatus(es)` a cada
   2 min para o universo (+ evento WS `market_resolved` com
   `winning_asset_id`). Registrar transições como eventos imutáveis:
   `proposed`, `disputed`, `resolved`, `closed`, além de `rule_change` da
   tarefa 2. Persistir o desfecho final incluindo o caso 50/50. Essa tabela
   alimenta o circuit breaker da RFC-012 e a medição própria de taxa de
   disputa/P1–P4 (não existem estatísticas independentes confiáveis).
8. **RTDS crypto.** Gravar continuamente `crypto_prices_twap_thirty/sixty`
   (Chainlink TWAP — zero basis risk com a resolução) e `crypto_prices`
   (Binance spot) para os ativos referenciados pelo universo. Reconexão com
   backoff; buraco de feed = gap registrado (não há replay).
9. **Timestamps.** Todo registro tem `source_ts` (timestamp do emissor;
   epoch-ms convertido a `timestamptz` — regressão obrigatória: o crash-loop
   de source_ts já ocorreu em produção, commit `350d3c9`) e `received_at`
   (relógio local NTP-sincronizado). Persistir também `ingest_lag_ms` como
   coluna derivada para monitoramento.
10. **Qualidade de dados.**
    - Tabela `data_gaps`: toda desconexão WS, re-sync, descarte por
      backpressure, poll falho ou buraco de sequência gera linha com
      `[gap_start, gap_end]`, fonte, token_id e causa.
    - Reconciliação horária: book reconstruído (snapshot + deltas) vs REST
      `/book` + `hash`; divergência → re-sync + linha em `data_gaps`.
    - Replay determinístico: função que reconstrói o book de qualquer
      token_id em qualquer instante coberto, a partir de snapshot âncora +
      deltas, com verificação por hash quando disponível.
    - Métricas exportadas: uptime por feed, gaps/dia, p50/p99 de
      `ingest_lag_ms`, updates/s, bytes/dia por tabela, % do orçamento usado.
11. **Retenção (TTL + quota; pruning diário; quota vence TTL).**

    | Tipo de dado                                                                                 | TTL alvo                | Quota dura |
    | -------------------------------------------------------------------------------------------- | ----------------------- | ---------- |
    | `book_deltas` (L2 cru do universo)                                                           | 14 dias                 | 12 GB      |
    | Snapshots completos de book (âncoras de replay, 1/min + re-syncs)                            | 30 dias                 | 4 GB       |
    | Snapshots top-10 (2–5s, série existente)                                                     | 90 dias                 | 4 GB       |
    | Trades (WS + Data API)                                                                       | 365 dias                | 3 GB       |
    | Agregados 1 min (mid/spread/profundidade)                                                    | sem TTL                 | 3 GB       |
    | OI/volume/holders/concentração (15 min)                                                      | sem TTL                 | 1 GB       |
    | RTDS cru (TWAP + spot, ~1s)                                                                  | 90 dias                 | 2 GB       |
    | RTDS agregado 1 min                                                                          | sem TTL                 | 0,5 GB     |
    | Metadados, regras versionadas, fees/tick versionados, eventos de status/disputa, `data_gaps` | sem TTL (nunca podados) | 0,5 GB     |

    Ao atingir 90% da quota de um tipo, podar o mais antigo até 80% e
    registrar o corte; ao atingir 90% dos 40 GB globais, alarmar e reduzir
    TTLs efetivos na ordem da tabela (de cima para baixo). Antes de podar
    `book_deltas`, garantir que os agregados 1 min do período já existem.

12. **Calendário e releases macro.** Persistir o calendário oficial
    BLS/BEA/FOMC versionado (timezone UTC explícito) e os valores oficiais
    dos releases no instante da publicação (`source_ts` = horário oficial,
    `received_at` local). Falha de fonte gera linha em `data_gaps`, nunca
    valor presumido.

### API mínima

Read-only, atrás da auth da RFC-002; nenhum endpoint de trading/wallet:

- `GET /polymarket/markets` (filtros: categoria, status, no-universo)
- `GET /polymarket/markets/{condition_id}` (estado atual + versões vigentes)
- `GET /polymarket/markets/{condition_id}/rules?at=<ts>` (versão vigente em t)
- `GET /polymarket/markets/{condition_id}/params?at=<ts>` (fees/tick/min size em t)
- `GET /polymarket/books/{token_id}?at=<ts>&depth=N` (replay do book em t)
- `GET /polymarket/books/{token_id}/deltas?from=&to=` (paginado)
- `GET /polymarket/trades?token_id=&from=&to=`
- `GET /polymarket/series/{token_id}?metric=spread|depth|oi|holders&from=&to=`
- `GET /polymarket/resolution-events?condition_id=` (status/disputas/clarificações)
- `GET /polymarket/data-quality` (gaps, uptime, lag, uso de quota)
- `GET /polymarket/universe?at=<ts>` (composição do universo em t + motivos)

### Artefatos

- Collectors (Gamma, CLOB REST, WSS ×2 com dedupe, Data API, RTDS) como
  serviços supervisionados (systemd) com restart e backoff.
- Migrações das tabelas novas (`book_deltas`, `book_snapshots_full`,
  `trades`, `series_1m`, `oi_holders`, `rule_versions`, `param_versions`,
  `resolution_events`, `data_gaps`, `universe_log`).
- Módulo de replay/reconstrução de book com verificação por hash.
- Job de retenção/pruning + job de reconciliação horária.
- API de leitura + página mínima de status (feeds, gaps, quota) — UI exibe
  "SIMULAÇÃO — SEM EXECUÇÃO REAL".
- Fixtures de mensagens WS reais (book, price_change, tick_size_change,
  last_trade_price, market_resolved) para testes offline.
- Runbook: reconexão, re-sync, esgotamento de quota, mudança de schema da
  venue.

### Testes obrigatórios

- Snapshot + deltas recompõem o book byte a byte; hash confere; teste com
  deltas duplicados, fora de ordem e size=0 (remoção de nível).
- Dedupe de duas conexões WS: mensagem perdida numa conexão não gera gap;
  perdida nas duas gera linha em `data_gaps`.
- Reconnect, 429/5xx com backoff, e re-sync REST após divergência de hash.
- `source_ts` epoch-ms → timestamptz (regressão do crash-loop) e persistência
  sobrevive a falha transitória do Postgres sem derrubar o collector.
- Versionamento: mudança de `description`, fee, tick e status gera exatamente
  uma versão nova com vigência correta; consulta `?at=` retorna a versão certa.
- Backfill de `/trades` por janelamento não duplica nem perde trades no
  limite de 10.000.
- Pruning respeita quotas, nunca toca nos tipos "nunca podados", e só poda
  `book_deltas` com agregados 1 min já materializados.
- Replay `GET /books/{token_id}?at=` bate com snapshot âncora conhecido.
- Universo: mercado excluído (eleição/live sports/placeholder negRisk) nunca
  entra; cap de 100 mercados/200 tokens é rejeitado com log, não estourado.
- Busca de código confirma ausência de auth de trading/wallet/ordem real.
- Soak de 24h com o universo cheio: RAM < 3 GB, crescimento de disco
  compatível com as quotas, zero gap não registrado.

### Critérios de aceite

- 7 dias contínuos de gravação do universo com uptime ≥ 99% por feed e 100%
  dos gaps registrados em `data_gaps` (nenhum buraco silencioso).
- Replay determinístico de book validado por hash em amostra de ≥ 20
  token_ids × 24h.
- Toda linha de toda tabela tem `source_ts` e `received_at` não nulos.
- Regras, fees, tick e min size consultáveis "as-of" qualquer instante
  coberto; pelo menos um `rule_change` real capturado ou simulado em teste.
- Uso de disco ≤ 40 GB com pruning comprovado em teste de quota.
- Nenhum caminho de execução real; API é read-only.
- Métricas de qualidade expostas e alarmes de quota/lag funcionando.

### Condições de parada

Pare e reporte se:

- a tarefa pedir execução real, credencial de trading, private key ou
  contorno de geoblock (VPN/proxy/spoofing);
- endpoints/schemas oficiais V2 divergirem da doc e não puderem ser
  verificados (ex.: campos do evento `price_change` mudarem);
- o volume real do universo estourar o orçamento de 40 GB mesmo após reduzir
  TTLs — reduzir o universo exige decisão do proprietário;
- a ingestão exigir descarte silencioso para acompanhar o feed;
- qualquer dependência precisar ser instalada de fora do org oficial
  Polymarket ou sem pin de versão.
