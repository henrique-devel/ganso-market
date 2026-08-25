-- Retention needs an index on the exact column it prunes by.
--
-- Every table below already had a composite index leading with token_id (or an
-- equivalent entity key) and no standalone index on its retention time column.
-- The consequence, measured in production on 2026-08-25: the quota cutoff probe
-- (ORDER BY received_at OFFSET n LIMIT 1) planned as a full parallel sort of
-- 232 million rows over 76 GB, and the batched DELETE planned as a sequential
-- scan. The daily job could not finish either, so polymarket_book_deltas grew
-- to 6.3x its quota and the database to 89 GB against a 40 GB budget.
--
-- These are plain (non-CONCURRENT) CREATE INDEX statements because the migrator
-- runs every file with --single-transaction. On a fresh database the tables are
-- empty and the build is instant. On an already-large database the index must
-- be created with CREATE INDEX CONCURRENTLY before deploying, which makes the
-- matching statement here an inert no-op via IF NOT EXISTS. That is how this
-- migration was applied to the existing production database: the
-- polymarket_book_deltas index was built concurrently first.

CREATE INDEX IF NOT EXISTS polymarket_book_deltas_received_at_idx
    ON polymarket_book_deltas (received_at);

CREATE INDEX IF NOT EXISTS polymarket_book_snapshots_received_at_idx
    ON polymarket_book_snapshots (received_at);

CREATE INDEX IF NOT EXISTS polymarket_book_snapshots_full_received_at_idx
    ON polymarket_book_snapshots_full (received_at);

CREATE INDEX IF NOT EXISTS polymarket_trades_received_at_idx
    ON polymarket_trades (received_at);

CREATE INDEX IF NOT EXISTS polymarket_series_1m_bucket_start_idx
    ON polymarket_series_1m (bucket_start);

CREATE INDEX IF NOT EXISTS polymarket_oi_holders_received_at_idx
    ON polymarket_oi_holders (received_at);

CREATE INDEX IF NOT EXISTS polymarket_rtds_prices_received_at_idx
    ON polymarket_rtds_prices (received_at);

CREATE INDEX IF NOT EXISTS polymarket_rtds_1m_bucket_start_idx
    ON polymarket_rtds_1m (bucket_start);

CREATE INDEX IF NOT EXISTS fundamental_estimates_received_at_idx
    ON fundamental_estimates (received_at);

CREATE INDEX IF NOT EXISTS paper_feature_windows_window_start_idx
    ON paper_feature_windows (window_start);

CREATE INDEX IF NOT EXISTS paper_ledger_events_received_at_idx
    ON paper_ledger_events (received_at);

CREATE INDEX IF NOT EXISTS paper_orders_created_at_idx
    ON paper_orders (created_at);

CREATE INDEX IF NOT EXISTS paper_markouts_fill_ts_idx
    ON paper_markouts (fill_ts);

CREATE INDEX IF NOT EXISTS paper_fill_samples_sampled_at_idx
    ON paper_fill_samples (sampled_at);

CREATE INDEX IF NOT EXISTS resolution_scores_received_at_idx
    ON resolution_scores (received_at);

CREATE INDEX IF NOT EXISTS resolution_adjudication_samples_received_at_idx
    ON resolution_adjudication_samples (received_at);

CREATE INDEX IF NOT EXISTS graph_violations_received_at_idx
    ON graph_violations (received_at);

CREATE INDEX IF NOT EXISTS resolution_layer_divergences_received_at_idx
    ON resolution_layer_divergences (received_at);

-- graph_sanity_vetoes is pruned with closedRowsOnly: only rows whose ended_at
-- is populated are eligible, so the partial index matches the prune predicate
-- exactly and stays small while vetoes are open.
CREATE INDEX IF NOT EXISTS graph_sanity_vetoes_ended_at_idx
    ON graph_sanity_vetoes (ended_at)
    WHERE ended_at IS NOT NULL;

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
