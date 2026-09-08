-- RFC-025 — Apêndice A, as três consultas COMO ESTÃO (D5: "usar como estão").
-- :t0 = agora − 24 h, :t1 = agora. Rodar antes do deploy (o "antes") e 24 h depois
-- (para A1/A3 do aceite 3); o recorte pós-rebuild de A2/A3 está em measure_after.sql.
\set t0 '(now() - interval $$24 hours$$)'
\set t1 '(now())'
\pset footer off

\echo '== A1: entradas das 24 h por reason_code, atribuidas ao kind aberto no instante =='
WITH d AS (SELECT decision_id, condition_id, decision_ts, reason_code FROM portfolio_decisions
           WHERE decision_kind = 'ENTRY' AND decision_ts >= :t0 AND decision_ts < :t1)
SELECT d.reason_code, b.kind, count(*) AS n, count(DISTINCT d.condition_id) AS markets
FROM d LEFT JOIN portfolio_circuit_breakers b
  ON d.reason_code = 'PORTFOLIO_CIRCUIT_BREAKER' AND b.condition_id = d.condition_id
 AND b.started_at <= d.decision_ts AND (b.ended_at IS NULL OR d.decision_ts < b.ended_at)
GROUP BY 1, 2 ORDER BY n DESC;

\echo '== A2: causa de cada PARAM_CHANGE (historia inteira) =='
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
WHERE b.kind = 'PARAM_CHANGE'
GROUP BY 1 ORDER BY n DESC;

\echo '== A3: universo rapido ("Up or Down") avaliado nas 24 h =='
SELECT count(DISTINCT d.condition_id) AS markets,
       count(DISTINCT d.condition_id) FILTER (WHERE d.reason_code = 'PORTFOLIO_CIRCUIT_BREAKER') AS markets_frozen,
       count(*) AS decisions,
       count(*) FILTER (WHERE d.reason_code = 'PORTFOLIO_CIRCUIT_BREAKER') AS decisions_frozen
FROM portfolio_decisions d JOIN polymarket_markets m ON m.condition_id = d.condition_id
WHERE d.decision_kind = 'ENTRY' AND d.decision_ts >= :t0 AND d.decision_ts < :t1
  AND m.question ILIKE '%Up or Down%';

\echo '== guarda: a SQL de paramChangedAt ainda e max(valid_from)? (contagem de versoes por mercado) =='
SELECT count(*) AS markets_com_versoes, sum(CASE WHEN n > 1 THEN 1 ELSE 0 END) AS com_mais_de_uma_versao
FROM (SELECT condition_id, count(*) AS n FROM polymarket_param_versions GROUP BY 1) t;
