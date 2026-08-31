-- The FK portfolio_panel_snapshots.decision_id -> portfolio_decisions is
-- ON DELETE SET NULL, so every DELETE on portfolio_decisions pays one lookup
-- on portfolio_panel_snapshots per deleted row to enforce it.
--
-- Measured in production on 2026-08-28 (EXPLAIN ANALYZE of a single-row
-- DELETE inside a rolled-back transaction): 125 ms per deleted row, dominated
-- by the RI trigger seq-scanning ~600 MB of panel snapshots, because
-- decision_id has no index. No viable batch closes at that cost (7,600 rows
-- x 125 ms ~ 950 s against a 30 s statement timeout), so the
-- portfolio_decisions quota (0.9 GB) never closed and the table grew
-- ~0.5 GB/day: 2,443 MB and 596,751 rows on 2026-08-31, with the retention
-- scan logging one RETENTION_STEP_FAILED ("Query read timeout" /
-- "canceling statement due to statement timeout") per run. This was the
-- stop-condition blocker registered by the 2026-08-28 hotfix block;
-- authorized by the owner on 2026-08-31.
--
-- Plain (non-CONCURRENT) CREATE INDEX because the migrator runs every file
-- with --single-transaction. On a fresh database the table is empty and the
-- build is instant. On the existing production database the index is built
-- with CREATE INDEX CONCURRENTLY before deploying, which makes this
-- statement an inert no-op via IF NOT EXISTS - the same protocol used by
-- migration 0013.
--
-- 0014 and 0015 are not touched.

CREATE INDEX IF NOT EXISTS portfolio_panel_snapshots_decision_id_idx
    ON portfolio_panel_snapshots (decision_id);

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
