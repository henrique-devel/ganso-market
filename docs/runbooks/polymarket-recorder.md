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
bytes por tabela e % do orçamento de 110 GiB) e os demais endpoints de leitura
da RFC-007. Atenção ao ler o `budget_used_pct` dali: ele soma **bytes físicos**
e só das tabelas `polymarket_*`, contra o orçamento inteiro — não é o número que
o alarme global usa.

## Separar dado retido de inchaço

O orçamento global é defendido em **bytes vivos**, porque podar linha é a única
alavanca que a retenção tem e `DELETE` não encolhe arquivo. Antes de concluir
que o banco estourou o orçamento, separar as duas coisas:

```bash
docker compose exec postgres psql -U ganso_market -d ganso_market -c \
  "SELECT pg_size_pretty(sum(pg_total_relation_size(c.oid)))                AS fisico,
          pg_size_pretty(sum(pg_total_relation_size(c.oid)
            * s.n_live_tup / NULLIF(s.n_live_tup + s.n_dead_tup, 0))::bigint) AS vivo,
          pg_size_pretty(pg_database_size(current_database()))               AS banco
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r';"
```

`vivo` é o que o `QUOTA_GLOBAL_ALARM` compara com os 110 GiB. O plano declarado
de retenção soma 95 GiB (85,875 GiB nas tabelas podáveis, 9,125 GiB nas
protegidas), então `vivo` acima do gatilho de 99 GiB só é possível se as tabelas
**protegidas** passarem do tamanho declarado — e a redução de TTL do alarme não
alcança tabela protegida. Nesse caso o alarme está certo e o remédio não; é
decisão do proprietário. `fisico - vivo` é o inchaço, e só um rewrite o devolve.

Para ver de onde vem o inchaço, por tabela:

```bash
docker compose exec postgres psql -U ganso_market -d ganso_market -c \
  "SELECT c.relname,
          pg_size_pretty(pg_total_relation_size(c.oid)) AS fisico,
          s.n_live_tup, s.n_dead_tup,
          round(100.0 * s.n_dead_tup / NULLIF(s.n_live_tup + s.n_dead_tup, 0), 1) AS pct_morto
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_stat_all_tables s ON s.relid = c.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15;"
```

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
  `polymarket_retention_log`; 90% dos 110 GiB globais **de bytes vivos** →
  alarme `QUOTA_GLOBAL_ALARM` nos logs. Tabelas de metadados nunca são podadas.
- **`RETENTION_GLOBAL_BLOAT`:** o footprint físico passou de 90% do orçamento
  mas o dado retido não. Não é alarme e **não** encolhe TTL nenhum: `DELETE` não
  devolve página ao arquivo, então podar aqui só destruiria dado retido sem
  mover o número. O remédio é `VACUUM FULL`/`pg_repack` na tabela inchada — lock
  exclusivo, decisão do proprietário, nunca do job diário. Ver a query abaixo
  para separar vivo de inchaço antes de decidir.
- **Formato de frame RTDS/Data API mudou:** frames desconhecidos são contados
  (`rtds_unknown_frames` no STATUS) e não derrubam o processo; verificar a
  documentação oficial e ajustar os parsers.
- O recorder grava dados públicos; nada aqui executa ordens nem toca wallet.
