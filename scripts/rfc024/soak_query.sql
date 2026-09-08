-- RFC-024 — leitura do soak de 3 dias UTC.
--
-- Somente leitura. Roda com psql direto no container do Postgres, e NAO pela
-- API: a agregacao de populacao varre `polymarket_markets` inteira e nao cabe
-- no `statement_timeout` da rota. O `fast_coverage` do
-- `GET /polymarket/data-quality` publica os mesmos numeros para o painel; esta
-- consulta e a versao que o operador roda a mao.
--
--   docker exec -i ganso-market-postgres-1 \
--     psql -U ganso_market -d ganso_market -f /dev/stdin < scripts/rfc024/soak_query.sql
--
-- Criterios de aceite (RFC-024): com_livro_t15/emitidos >= 90 % por dia,
-- lead_mediano_min >= 60, bytes vivos de polymarket_book_deltas <= 52 GiB.
\pset pager off

\echo '=== 1) cobertura e lead, por dia UTC de FIM do mercado ==='
WITH serie AS (
  SELECT pm.condition_id, pm.clob_token_ids,
         COALESCE(pm.end_ts, rv.end_date) AS fim
    FROM polymarket_markets pm
    LEFT JOIN (SELECT DISTINCT ON (condition_id) condition_id, end_date
                 FROM polymarket_rule_versions
                ORDER BY condition_id, valid_from DESC) rv
      ON rv.condition_id = pm.condition_id
   WHERE pm.slug ~ '^bitcoin-up-or-down-[a-z]+-[0-9]{1,2}-[0-9]{4}-[0-9]{1,2}(am|pm)-et$'
),
dias AS (
  SELECT s.condition_id, s.fim, date_trunc('day', s.fim) AS dia,
         jsonb_array_elements_text(
           CASE jsonb_typeof(s.clob_token_ids)
             WHEN 'array' THEN s.clob_token_ids ELSE '[]'::jsonb END) AS token_id
    FROM serie s
   WHERE s.fim >= date_trunc('day', now()) - INTERVAL '4 days'
     AND s.fim <  date_trunc('day', now()) + INTERVAL '1 day'
),
por_mercado AS (
  SELECT d.condition_id, d.dia, d.fim,
         (SELECT min(ul.at) FROM polymarket_universe_log ul
           WHERE ul.condition_id = d.condition_id AND ul.action = 'enter') AS primeiro_enter,
         EXISTS (SELECT 1 FROM polymarket_universe_log ul
                  WHERE ul.condition_id = d.condition_id AND ul.action = 'enter'
                    AND ul.reason LIKE '%\_series') AS por_serie,
         bool_or(EXISTS (SELECT 1 FROM polymarket_series_1m sm
                          WHERE sm.token_id = d.token_id
                            AND sm.bucket_start >= d.fim - INTERVAL '15 minutes'
                            AND sm.bucket_start <  d.fim - INTERVAL '14 minutes'
                            AND sm.updates_count >= 1)) AS tem_livro
    FROM dias d
   GROUP BY d.condition_id, d.dia, d.fim
)
SELECT dia::date,
       count(*) AS emitidos,
       count(*) FILTER (WHERE tem_livro) AS com_livro_t15,
       CASE WHEN count(*) = 0 THEN NULL
            ELSE round(100.0 * count(*) FILTER (WHERE tem_livro) / count(*), 1)
       END AS cobertura_pct,
       count(*) FILTER (WHERE primeiro_enter <= fim - INTERVAL '60 minutes') AS catalogados_60min,
       count(*) FILTER (WHERE por_serie) AS entradas_por_serie,
       round(percentile_cont(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(EPOCH FROM (fim - primeiro_enter)) / 60.0)::numeric, 1) AS lead_mediano_min
  FROM por_mercado
 GROUP BY dia ORDER BY dia;

\echo '=== 2) bytes VIVOS de book_deltas (mesma formula do measureTableSizes) ==='
SELECT round(pg_total_relation_size(c.oid)/1073741824.0, 3) AS fisico_gib,
       round(((COALESCE(NULLIF(s.n_live_tup,0), c.reltuples::bigint)
               * (w.heap_width + 28 + (ix.index_key_width + ix.index_count*16)/0.9)
               + COALESCE(ts.n_live_tup,0)*2048)/1073741824.0)::numeric, 3) AS VIVOS_GIB,
       46.8 AS gatilho_gib, 52.0 AS quota_gib,
       COALESCE(s.n_live_tup, c.reltuples::bigint) AS live_rows
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
  LEFT JOIN pg_stat_all_tables ts ON ts.relid = c.reltoastrelid
  LEFT JOIN LATERAL (SELECT sum(st.avg_width)::float8 AS heap_width FROM pg_stats st
                      WHERE st.schemaname = n.nspname AND st.tablename = c.relname) w ON true
  LEFT JOIN LATERAL (SELECT count(DISTINCT i.indexrelid)::float8 AS index_count,
                            COALESCE(sum(st.avg_width),0)::float8 AS index_key_width
                       FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey::int2[]) AS k(attnum)
                       LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
                       LEFT JOIN pg_stats st ON st.schemaname = n.nspname
                            AND st.tablename = c.relname AND st.attname = a.attname
                      WHERE i.indrelid = c.oid AND i.indisvalid) ix ON true
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND c.relname = 'polymarket_book_deltas';

\echo '=== 3) subscribe_book_missing por dia ==='
SELECT date_trunc('day', gap_start)::date AS dia,
       count(*) AS lacunas,
       count(*) FILTER (WHERE gap_end IS NULL) AS abertas,
       round(avg(EXTRACT(EPOCH FROM (COALESCE(gap_end, now()) - gap_start)))::numeric, 1) AS dur_media_s
  FROM polymarket_data_gaps
 WHERE cause = 'subscribe_book_missing'
   AND gap_start >= now() - INTERVAL '4 days'
 GROUP BY 1 ORDER BY 1;

\echo '=== 4) poda de book_deltas no soak (ttl e quota) ==='
SELECT cause, count(*) AS rodadas, sum(rows_deleted) AS linhas, max(at) AS ultima
  FROM polymarket_retention_log
 WHERE table_name = 'polymarket_book_deltas' AND at >= now() - INTERVAL '4 days'
 GROUP BY cause ORDER BY cause;
