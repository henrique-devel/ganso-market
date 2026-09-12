-- DB-03 candidate only: NOT a migration; do not run on the server in DB-03.
-- Execute outside a transaction only after the DB-04 write/space/WAL gate.
-- No IF NOT EXISTS: a name collision requires inspecting the existing index.
CREATE INDEX CONCURRENTLY polymarket_rtds_prices_asof_idx
    ON polymarket_rtds_prices
    (feed, symbol, COALESCE(source_ts, received_at) DESC, rtds_price_id DESC);
