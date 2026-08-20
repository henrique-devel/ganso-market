# Runbook — recorder Polymarket (fundação de dados, RFC-007)

O recorder grava dados públicos da Polymarket no PostgreSQL local. É **somente
leitura de dados públicos**: não há autenticação de trading, wallet, ordens ou
execução.

## O que ele grava (RFC-007)

| Coletor                                                                                              | Cadência                                           | Tabelas                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Registry Gamma (mercados, eventos, tags, negRisk, universo crypto+macro)                             | 10 min                                             | `polymarket_markets`, `polymarket_events`, `polymarket_event_markets`, `polymarket_universe_log`                   |
| Regras e parâmetros versionados (diff por hash; `rule_change` em clarificação)                       | 10 min + 1 h (fees) + evento WS `tick_size_change` | `polymarket_rule_versions`, `polymarket_param_versions`, `polymarket_resolution_events`                            |
| Livro L2 completo (WS duplo com dedupe; snapshot no subscribe/resync + âncora 1/min; deltas em lote) | contínuo                                           | `polymarket_book_deltas`, `polymarket_book_snapshots_full`, `polymarket_book_snapshots` (top-10, série compatível) |
| Agregados de book 1 min (OHLC de mid, spread, profundidade)                                          | 1 min                                              | `polymarket_series_1m`                                                                                             |
| Trades (WS `last_trade_price` + backfill Data API janelado)                                          | contínuo + 5 min                                   | `polymarket_trades`                                                                                                |
| OI/volume/holders/concentração                                                                       | 15 min                                             | `polymarket_oi_holders`                                                                                            |
| Status UMA (transições imutáveis proposed/disputed/resolved/closed)                                  | 2 min                                              | `polymarket_resolution_events`                                                                                     |
| RTDS crypto (Chainlink TWAP 30/60 s + Binance spot)                                                  | contínuo (~1 s)                                    | `polymarket_rtds_prices`, `polymarket_rtds_1m`                                                                     |
| Calendário macro (BLS/BEA/FOMC, arquivo versionado) + releases BLS                                   | boot + 10 min                                      | `polymarket_macro_calendar`, `polymarket_macro_releases`                                                           |
| Qualidade (gaps, reconciliação horária vs REST) e retenção (TTL + quotas)                            | contínuo / 1 h / 24 h                              | `polymarket_data_gaps`, `polymarket_retention_log`                                                                 |

Todo registro carrega `source_ts` (relógio da origem, quando existe) e
`received_at` (relógio local). Nenhum buraco de coleta é silencioso: viram
linhas em `polymarket_data_gaps`.

## Serviço e rede

- Serviço Compose `polymarket-recorder`, atrás do profile `polymarket` (não
  sobe com `make up` nem no smoke de CI).
- Reusa a imagem da API e roda `node apps/api/dist/polymarket-recorder.js`
  (orquestrador da RFC-007 com todos os coletores supervisionados).
- Redes `backend` (PostgreSQL) e `edge` (egress para as APIs públicas).
  **Não publica porta no host.**
- Monta `config/macro-calendar.json` (calendário macro versionado — revisar
  as entradas `"estimated": true` contra as fontes `_source` oficiais).
- `mem_limit` 1024 MiB (book cache L2 do universo + filas de lote); orçamento
  agregado do Compose validado por `scripts/check_compose_policy.py`.

## Operar em desenvolvimento

```bash
make up            # sobe a base (postgres, migrate, api, web, nginx)
make recorder-up   # sobe o recorder Polymarket
make recorder-logs # acompanha os logs (JSON; reason_code STATUS a cada 5 min)
make recorder-down # encerra o recorder
```

## Operar no servidor standalone

```bash
cd /opt/ganso-market
docker compose --env-file deploy/server.env --profile polymarket \
  up --build --detach polymarket-recorder
docker compose --env-file deploy/server.env --profile polymarket \
  logs --follow --tail 100 polymarket-recorder
```

Depois de qualquer deploy que altere o código do recorder, repita o
`up --build` acima (o deploy padrão não troca a imagem do profile).

## Verificar que está gravando

```bash
docker compose exec postgres psql -U ganso_market -d ganso_market -c \
  "SELECT (SELECT count(*) FROM polymarket_markets)        AS mercados,
          (SELECT count(*) FROM polymarket_book_deltas)    AS deltas,
          (SELECT count(*) FROM polymarket_book_snapshots_full) AS snapshots_full,
          (SELECT count(*) FROM polymarket_trades)         AS trades,
          (SELECT count(*) FROM polymarket_rtds_prices)    AS rtds,
          (SELECT count(*) FROM polymarket_rule_versions)  AS regras,
          (SELECT count(*) FROM polymarket_data_gaps)      AS gaps;"
```

A API autenticada expõe `GET /polymarket/data-quality` (gaps, lag p50/p99,
bytes por tabela e % do orçamento de 40 GB) e os demais endpoints de leitura
da RFC-007.

## Incidentes conhecidos e resposta

- **WS de mercado cai:** reconexão automática com backoff; uma conexão caída
  (do par) não é gap; as duas caídas simultâneas geram gap `clob_ws` e
  re-sync no retorno.
- **Divergência de book:** a reconciliação horária contra o REST `/book`
  agenda re-sync e registra gap `reconcile_divergence`.
- **Fila de deltas estourou (burst):** o excedente mais antigo é descartado e
  registrado como gap `internal/delta_queue_overflow` — nunca silencioso.
- **RTDS sem replay:** desconexão vira gap `rtds/ws_disconnect`; o buraco é
  real e permanente (não há como repor).
- **Quota:** ao atingir 90% da quota de um tipo, poda até 80% com linha em
  `polymarket_retention_log`; 90% dos 40 GB globais → alarme
  `QUOTA_GLOBAL_ALARM` nos logs. Tabelas de metadados nunca são podadas.
- **Formato de frame RTDS/Data API mudou:** frames desconhecidos são contados
  (`rtds_unknown_frames` no STATUS) e não derrubam o processo; verificar a
  documentação oficial e ajustar os parsers.
- O recorder grava dados públicos; nada aqui executa ordens nem toca wallet.
