-- RFC-016: the real end INSTANT of a market on the flat registry row.
--
-- Gamma returns both `endDate` (a full instant, e.g. "2026-08-31T23:00:00Z")
-- and `endDateIso` (date-only, "2026-08-31"). Since RFC-007 the instant has
-- been stored in polymarket_rule_versions.end_date (TIMESTAMPTZ, versioned,
-- part of the normative content hash), and every consumer that reads THAT
-- column computes the horizon correctly. polymarket_markets only ever got the
-- lossy date-only copy, in a TEXT column, and it is the obvious place to read.
--
-- Two consumers read it and were wrong by up to 24 h. Measured in production
-- on 2026-08-31:
--
--   * fundamental/labels.ts fed the date-only value to publiclyKnowableInstant,
--     which takes the MINIMUM of it and the UMA proposal instant. 1,572 of
--     1,670 labels (94%) carry publicly_knowable_ts at exactly 00:00:00, a
--     median of 16 h before the market's real end. calibration.ts filters
--     evidence with `decision_ts < publicly_knowable_ts`, so 38,200 of 74,412
--     scoreable MODEL estimates were silently discarded -- including 8,063 of
--     8,063 made in the market's last hour of life, which is precisely what
--     the 10 s cadence exists to produce.
--
--   * paper/runner.ts computed `endDate - now` from the date-only value, went
--     negative for most of the day, and a negative horizon satisfies the
--     `<= 1 h` test in windowKindsForHorizon: 63,951 of 84,772 10s windows
--     over 6 h (75%) were computed for markets whose real horizon exceeded 6 h.
--
-- This column closes the trap. It is NULLABLE with no default and there is NO
-- backfill: end_ts is filled prospectively as Gamma re-observes each market,
-- the same pattern migration 0010 used for question_id. Rows that never get
-- re-observed keep NULL, and the consumers fall back to the versioned rule's
-- end_date, which is what repairs the historical set without ever rewriting a
-- row.
--
-- Deliberately NOT added to polymarket_market_metadata_versions: the as-of
-- history of a market's end instant already exists, and is correct, in
-- polymarket_rule_versions.end_date. A second as-of chain for the same fact
-- could diverge from the first with no way to tell which was right.
-- polymarket_markets.end_ts is current identity, mutable in place like every
-- other column of that table, and never takes precedence over the as-of chain.
--
-- The partial index carries the WHERE clause every new query uses ("markets
-- closest to expiry"); a market with no observed instant is never a candidate.
--
-- 0016 and everything before it are not touched.

ALTER TABLE polymarket_markets
    ADD COLUMN IF NOT EXISTS end_ts TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS polymarket_markets_end_ts_idx
    ON polymarket_markets (end_ts)
    WHERE end_ts IS NOT NULL;

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
