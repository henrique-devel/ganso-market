-- RFC-011 tasks 7/8: the post-fill markout dataset (A10) and the P(fill)
-- calibration dataset + reports (A9). These are the RFC-009 validation
-- datasets: 180-day retention inside the approved 0.4 GB sub-quota.
-- Simulation scope only; canonical decimal strings, never floats.

-- One row per paper fill per horizon: how the market moved AFTER we filled,
-- signed by our side (negative = adverse selection against the fill).
CREATE TABLE IF NOT EXISTS paper_markouts (
    markout_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fill_key TEXT NOT NULL CHECK (char_length(fill_key) BETWEEN 1 AND 256),
    order_id TEXT,
    token_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    taker BOOLEAN NOT NULL,
    fill_price TEXT NOT NULL,
    fill_size TEXT NOT NULL,
    fill_ts TIMESTAMPTZ NOT NULL,
    horizon_s INTEGER NOT NULL CHECK (horizon_s IN (1, 10, 60, 300)),
    -- Mid and executable bid at fill_ts + horizon, minus the fill price,
    -- signed by the side. NULL when no valid book existed at the horizon.
    mid_markout TEXT,
    exec_bid_markout TEXT,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (fill_key, horizon_s)
);

CREATE INDEX IF NOT EXISTS paper_markouts_token_idx
    ON paper_markouts (token_id, fill_ts);

-- P(fill) calibration samples, generated from RECORDER data alone: at t0 a
-- hypothetical passive order at `distance_ticks` from the touch joins behind
-- the visible depth; the label says whether traded volume at that level
-- within `life_s` exceeded the queue. Labeled in a second pass, once t0 +
-- life_s is entirely in the past (walk-forward by construction).
CREATE TABLE IF NOT EXISTS paper_fill_samples (
    sample_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    sampled_at TIMESTAMPTZ NOT NULL,
    distance_ticks INTEGER NOT NULL CHECK (distance_ticks >= 0),
    level_price TEXT NOT NULL,
    queue_ahead TEXT NOT NULL,
    life_s INTEGER NOT NULL CHECK (life_s > 0),
    -- Covariates at t0 (from the recorded windows; UNAVAILABLE stays null).
    churn_events INTEGER,
    vol_1m TEXT,
    -- Label: null until the labeling pass; then TRUE/FALSE.
    filled BOOLEAN,
    labeled_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (token_id, side, sampled_at, distance_ticks, life_s)
);

CREATE INDEX IF NOT EXISTS paper_fill_samples_unlabeled_idx
    ON paper_fill_samples (sampled_at)
    WHERE filled IS NULL;

-- Weekly walk-forward calibration report: empirical fill rates per bucket
-- with a confidence interval, stamped with the exact data window used.
CREATE TABLE IF NOT EXISTS paper_fill_reports (
    report_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    data_from TIMESTAMPTZ,
    data_to TIMESTAMPTZ,
    samples_total INTEGER NOT NULL DEFAULT 0,
    buckets_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(buckets_json) = 'array')
);

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
