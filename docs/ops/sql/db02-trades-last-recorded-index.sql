-- DB-02 / RFC-037. Candidate validated on disposable PostgreSQL only.
-- Apply to an existing database only through the DB-04 operational plan.
-- Run as a standalone statement, never through the transactional migrator.
-- Intentionally no IF NOT EXISTS: a same-named invalid/different index must
-- fail visibly and be inspected before any retry. See ../DB-02-index-plan.md.
CREATE INDEX CONCURRENTLY polymarket_trades_data_api_condition_ts_idx
    ON polymarket_trades (condition_id, trade_ts DESC)
    WHERE provenance = 'data_api' AND trade_ts IS NOT NULL;
