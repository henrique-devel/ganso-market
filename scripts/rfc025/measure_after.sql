-- RFC-025 — as MESMAS A1-A3 do Apendice A, com os dois recortes que o proprio
-- apendice marca em comentario ativados (aceites 1 e 2), mais o aceite 4.
--
-- Rodar 24 h APOS o rebuild do servico polymarket-portfolio:
--   ssh -i ~/.ssh/id_ed25519 root@178.105.65.251 \
--     'docker exec -i ganso-market-postgres-1 psql -U ganso_market -d ganso_market -f /dev/stdin' \
--     < scripts/rfc025/measure_after.sql
--
-- :rebuild = 2026-09-08T14:19:53Z (release-sha 60486008c3b7aa83208addf4d9851ef452e5cfbd)
\set rebuild '(timestamptz $$2026-09-08T14:19:53Z$$)'
\set t0 '(now() - interval $$24 hours$$)'
\set t1 '(now())'
\pset footer off

\echo '== A1 (aceite 3) — entradas das 24 h por reason_code. ANTES: 1,81 % em disjuntor (317 de 17 484) =='
WITH d AS (SELECT decision_id, condition_id, decision_ts, reason_code FROM portfolio_decisions
           WHERE decision_kind = 'ENTRY' AND decision_ts >= :t0 AND decision_ts < :t1)
SELECT d.reason_code, b.kind, count(*) AS n, count(DISTINCT d.condition_id) AS markets
FROM d LEFT JOIN portfolio_circuit_breakers b
  ON d.reason_code = 'PORTFOLIO_CIRCUIT_BREAKER' AND b.condition_id = d.condition_id
 AND b.started_at <= d.decision_ts AND (b.ended_at IS NULL OR d.decision_ts < b.ended_at)
GROUP BY 1, 2 ORDER BY n DESC;

\echo '== A2 (aceite 1) — causa de cada PARAM_CHANGE aberto DEPOIS do rebuild. Alvo: 0 por v1 e 0 por NULL->valor =='
WITH v AS (SELECT condition_id, version, valid_from, fee_base_bps, taker_fee_bps, fee_curve_json, tick_size,
             lag(fee_base_bps)   OVER w AS p_base, lag(taker_fee_bps) OVER w AS p_taker,
             lag(fee_curve_json) OVER w AS p_curve, lag(tick_size)    OVER w AS p_tick
           FROM polymarket_param_versions WINDOW w AS (PARTITION BY condition_id ORDER BY version))
SELECT CASE WHEN v.version = 1 THEN 'v1'
            WHEN v.p_base IS NULL AND v.fee_base_bps IS NOT NULL AND v.p_taker IS NOT DISTINCT FROM v.taker_fee_bps
                 AND v.p_curve IS NOT DISTINCT FROM v.fee_curve_json AND v.p_tick IS NOT DISTINCT FROM v.tick_size THEN 'fee_base NULL->valor'
            WHEN v.p_tick IS NOT NULL AND v.tick_size IS DISTINCT FROM v.p_tick THEN 'tick_size real'
            WHEN v.p_taker IS NOT NULL AND v.taker_fee_bps IS DISTINCT FROM v.p_taker THEN 'taker_fee real'
            WHEN v.p_curve IS NOT NULL AND v.fee_curve_json IS DISTINCT FROM v.p_curve THEN 'fee_curve real'
            WHEN v.p_base IS NOT NULL AND v.fee_base_bps IS DISTINCT FROM v.p_base THEN 'fee_base real'
            WHEN v.condition_id IS NULL THEN 'sem casamento' ELSE 'outro' END AS causa,
       count(*) AS n
FROM portfolio_circuit_breakers b
LEFT JOIN v ON v.condition_id = b.condition_id
           AND v.valid_from = (b.detail_json->>'param_changed_at')::timestamptz
WHERE b.kind = 'PARAM_CHANGE' AND b.started_at > :rebuild
GROUP BY 1 ORDER BY n DESC;

\echo '== aceite 1, segunda metade — todo detail_json pos-rebuild tem changed_fields nao vazio =='
SELECT count(*) AS param_change_pos_rebuild,
       count(*) FILTER (WHERE jsonb_array_length(coalesce(detail_json->'changed_fields','[]'::jsonb)) > 0) AS com_changed_fields,
       count(*) FILTER (WHERE detail_json ? 'version') AS com_version,
       count(*) FILTER (WHERE detail_json ? 'from') AS com_from
FROM portfolio_circuit_breakers WHERE kind = 'PARAM_CHANGE' AND started_at > :rebuild;

\echo '== A3 (aceite 2) — universo rapido DESCOBERTO depois do rebuild. ANTES: 100 % sob disjuntor =='
SELECT count(DISTINCT d.condition_id) AS markets,
       count(DISTINCT d.condition_id) FILTER (WHERE d.reason_code = 'PORTFOLIO_CIRCUIT_BREAKER') AS markets_frozen,
       count(*) AS decisions,
       count(*) FILTER (WHERE d.reason_code = 'PORTFOLIO_CIRCUIT_BREAKER') AS decisions_frozen
FROM portfolio_decisions d JOIN polymarket_markets m ON m.condition_id = d.condition_id
WHERE d.decision_kind = 'ENTRY' AND d.decision_ts >= :t0 AND d.decision_ts < :t1
  AND m.question ILIKE '%Up or Down%' AND m.received_at > :rebuild;

\echo '== aceite 2, a regua exata — PRIMEIRA decisao de cada Up-or-Down descoberto pos-rebuild. ANTES: 50 de 50 em disjuntor =='
WITH novos AS (SELECT m.condition_id FROM polymarket_markets m
               WHERE m.question ILIKE '%Up or Down%' AND m.received_at > :rebuild),
primeira AS (SELECT d.condition_id, d.reason_code,
                    row_number() OVER (PARTITION BY d.condition_id ORDER BY d.decision_ts) AS rn
             FROM portfolio_decisions d JOIN novos n ON n.condition_id = d.condition_id
             WHERE d.decision_kind = 'ENTRY')
SELECT (SELECT count(*) FROM novos) AS descobertos_pos_rebuild,
       count(*) AS com_decisao,
       count(*) FILTER (WHERE reason_code = 'PORTFOLIO_CIRCUIT_BREAKER') AS primeira_em_disjuntor,
       count(*) FILTER (WHERE reason_code <> 'PORTFOLIO_CIRCUIT_BREAKER') AS primeira_livre
FROM primeira WHERE rn = 1;

\echo '== aceite 2, detalhe — qual reason_code recebe a primeira decisao dos recem-descobertos =='
WITH novos AS (SELECT m.condition_id FROM polymarket_markets m
               WHERE m.question ILIKE '%Up or Down%' AND m.received_at > :rebuild),
primeira AS (SELECT d.condition_id, d.reason_code,
                    row_number() OVER (PARTITION BY d.condition_id ORDER BY d.decision_ts) AS rn
             FROM portfolio_decisions d JOIN novos n ON n.condition_id = d.condition_id
             WHERE d.decision_kind = 'ENTRY')
SELECT reason_code, count(*) AS n FROM primeira WHERE rn = 1 GROUP BY 1 ORDER BY 2 DESC;

\echo '== aceite 4 — contagem por kind, 24 h DEPOIS vs 24 h ANTES do rebuild. Alvo: razao 0,5-2 em DATA_STALENESS e UMA_*, RULE_CLARIFICATION segue 0 =='
SELECT kind,
       count(*) FILTER (WHERE started_at > :rebuild AND started_at <= :rebuild + interval '24 hours') AS depois_24h,
       count(*) FILTER (WHERE started_at <= :rebuild AND started_at > :rebuild - interval '24 hours') AS antes_24h
FROM portfolio_circuit_breakers GROUP BY 1 ORDER BY 1;

\echo '== estado agora — disjuntores abertos por kind =='
SELECT kind, count(*) AS abertos, count(DISTINCT condition_id) AS mercados,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (now()-started_at))/60)) AS p50_min
FROM portfolio_circuit_breakers WHERE ended_at IS NULL GROUP BY 1 ORDER BY 2 DESC;
