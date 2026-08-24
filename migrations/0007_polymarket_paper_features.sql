-- RFC-011 Part A: microstructure feature windows. Aggregated features per
-- token per window (1s/10s/1m) computed from data the RFC-007 recorder already
-- persisted — the raw book is never re-persisted here. Prices/sizes/ratios are
-- canonical decimal strings, never floats. Every row carries the newest
-- source_ts of its inputs and computed_at (local clock); no input may postdate
-- window_end (anti-look-ahead, enforced in code and tested).
--
-- Simulation scope only: nothing in this schema stores an order, a wallet or
-- any trading credential.

CREATE TABLE IF NOT EXISTS paper_feature_windows (
    token_id TEXT NOT NULL CHECK (char_length(token_id) BETWEEN 1 AND 128),
    window_kind TEXT NOT NULL CHECK (window_kind IN ('1s', '10s', '1m')),
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL CHECK (window_end > window_start),
    -- Newest venue timestamp among the inputs (null when none carried one).
    source_ts TIMESTAMPTZ,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Book state at window_end (latest snapshot received at or before it).
    book_valid BOOLEAN NOT NULL,
    book_invalid_reason TEXT CHECK (
        book_invalid_reason IN ('NO_BOOK', 'BOOK_STALE', 'BOOK_CROSSED', 'DEPTH_BELOW_SREF', 'SPREAD_TOO_WIDE')
    ),

    -- A1 spread.
    best_bid TEXT,
    best_ask TEXT,
    mid TEXT,
    spread_quoted TEXT,
    half_spread_bps TEXT,
    exec_spread_sref TEXT,
    microprice TEXT,
    thin_book BOOLEAN,

    -- A2 depth by level / executable depth at k ticks / top-of-book fraction.
    bid_depth_top1 TEXT,
    ask_depth_top1 TEXT,
    bid_depth_top10 TEXT,
    ask_depth_top10 TEXT,
    top_frac_bid TEXT,
    top_frac_ask TEXT,
    depth_ticks_json JSONB CHECK (depth_ticks_json IS NULL OR jsonb_typeof(depth_ticks_json) = 'object'),

    -- A3 imbalance.
    imbalance_top1 TEXT,
    imbalance_top10 TEXT,

    -- A4 aggressor flow. The public WS direction field is FORBIDDEN as a
    -- source (RFC-011); until the onchain OrderFilled reconciliation exists
    -- the direction is UNAVAILABLE and only unsigned volume is published. The
    -- CHECK makes silent degradation impossible at the database level.
    trades_count INTEGER NOT NULL DEFAULT 0 CHECK (trades_count >= 0),
    volume_unsigned TEXT,
    volume_signed TEXT,
    flow_direction_status TEXT NOT NULL DEFAULT 'UNAVAILABLE' CHECK (
        flow_direction_status IN ('UNAVAILABLE', 'ONCHAIN')
    ),
    CONSTRAINT paper_feature_windows_signed_needs_onchain CHECK (
        volume_signed IS NULL OR flow_direction_status = 'ONCHAIN'
    ),

    -- A5 cancel/repost velocity (from L2 deltas inside the window).
    cancel_events INTEGER NOT NULL DEFAULT 0 CHECK (cancel_events >= 0),
    update_events INTEGER NOT NULL DEFAULT 0 CHECK (update_events >= 0),
    levels_touched INTEGER NOT NULL DEFAULT 0 CHECK (levels_touched >= 0),

    -- A6 recent realized volatility of the mid and jump count in the window.
    vol_1m TEXT,
    vol_5m TEXT,
    vol_30m TEXT,
    jump_count INTEGER NOT NULL DEFAULT 0 CHECK (jump_count >= 0),

    -- A7 staleness.
    last_trade_age_ms BIGINT,
    book_staleness_ms BIGINT,

    -- A8 time to catalyst / resolution (minutes; negative when already past).
    mins_to_catalyst INTEGER,
    mins_to_end_date INTEGER,
    mins_to_uma_end INTEGER,

    PRIMARY KEY (token_id, window_kind, window_start)
);

-- Pruning and API reads scan by kind + recency.
CREATE INDEX IF NOT EXISTS paper_feature_windows_kind_start_idx
    ON paper_feature_windows (window_kind, window_start);

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
