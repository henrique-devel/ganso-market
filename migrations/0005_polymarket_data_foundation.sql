-- RFC-007: Polymarket data foundation. Read-only public data; no trading,
-- wallet, or auth material. Prices/sizes/fees are canonical decimal strings,
-- never floats. Every row carries source_ts (venue/emitter clock, when the
-- source provides one) and received_at (local clock).

-- Gamma events and event<->market relations (negRisk groups are events).
CREATE TABLE IF NOT EXISTS polymarket_events (
    event_id TEXT PRIMARY KEY CHECK (char_length(event_id) BETWEEN 1 AND 128),
    slug TEXT,
    title TEXT NOT NULL,
    neg_risk BOOLEAN NOT NULL DEFAULT FALSE,
    tags_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags_json) = 'array'),
    source_ts TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS polymarket_event_markets (
    event_id TEXT NOT NULL REFERENCES polymarket_events (event_id),
    condition_id TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, condition_id)
);

-- Versioned rules: a new row only when content changes; validity window
-- [valid_from, valid_to); open version has valid_to NULL.
CREATE TABLE IF NOT EXISTS polymarket_rule_versions (
    rule_version_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    condition_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    content_hash TEXT NOT NULL,
    description TEXT NOT NULL,
    resolution_source TEXT,
    resolved_by TEXT,
    end_date TIMESTAMPTZ,
    uma_end_date TIMESTAMPTZ,
    uma_bond TEXT,
    uma_reward TEXT,
    custom_liveness TEXT,
    automatically_resolved BOOLEAN,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_to TIMESTAMPTZ,
    source_ts TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (condition_id, version)
);

CREATE INDEX IF NOT EXISTS polymarket_rule_versions_asof_idx
    ON polymarket_rule_versions (condition_id, valid_from);

-- Versioned market parameters (fees/tick/min size/negRisk/fee curve).
CREATE TABLE IF NOT EXISTS polymarket_param_versions (
    param_version_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    condition_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    content_hash TEXT NOT NULL,
    fee_base_bps TEXT,
    maker_fee_bps TEXT,
    taker_fee_bps TEXT,
    fee_curve_json JSONB,
    tick_size TEXT,
    min_order_size TEXT,
    neg_risk BOOLEAN,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_to TIMESTAMPTZ,
    source_ts TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (condition_id, version)
);

CREATE INDEX IF NOT EXISTS polymarket_param_versions_asof_idx
    ON polymarket_param_versions (condition_id, valid_from);

-- Full L2 deltas, append-only (TTL 14d / quota 12 GB via retention job).
CREATE TABLE IF NOT EXISTS polymarket_book_deltas (
    delta_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    price TEXT NOT NULL,
    size TEXT NOT NULL,
    source_ts TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ingest_lag_ms INTEGER
);

CREATE INDEX IF NOT EXISTS polymarket_book_deltas_token_idx
    ON polymarket_book_deltas (token_id, received_at);

-- Full-depth book snapshots: replay anchors (subscribe/resync/periodic).
CREATE TABLE IF NOT EXISTS polymarket_book_snapshots_full (
    snapshot_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('subscribe', 'resync', 'anchor')),
    book_hash TEXT,
    bids_json JSONB NOT NULL CHECK (jsonb_typeof(bids_json) = 'array'),
    asks_json JSONB NOT NULL CHECK (jsonb_typeof(asks_json) = 'array'),
    source_ts TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ingest_lag_ms INTEGER
);

CREATE INDEX IF NOT EXISTS polymarket_book_snapshots_full_token_idx
    ON polymarket_book_snapshots_full (token_id, received_at DESC);

-- Trades from WS (last_trade_price) and Data API backfill, deduped by source id.
CREATE TABLE IF NOT EXISTS polymarket_trades (
    trade_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_id TEXT NOT NULL,
    condition_id TEXT,
    price TEXT NOT NULL,
    size TEXT,
    side TEXT CHECK (side IN ('BUY', 'SELL')),
    fee_rate_bps TEXT,
    transaction_hash TEXT,
    provenance TEXT NOT NULL CHECK (provenance IN ('ws', 'data_api')),
    external_id TEXT,
    trade_ts TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS polymarket_trades_external_uidx
    ON polymarket_trades (provenance, external_id)
    WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS polymarket_trades_ws_uidx
    ON polymarket_trades (token_id, transaction_hash, price, side)
    WHERE provenance = 'ws' AND transaction_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS polymarket_trades_token_ts_idx
    ON polymarket_trades (token_id, trade_ts);

-- The read API (/polymarket/trades) filters and orders by the effective
-- timestamp COALESCE(trade_ts, received_at); this expression index keeps that
-- ORDER BY off a full sort. Expression must match the query text exactly.
CREATE INDEX IF NOT EXISTS polymarket_trades_token_effective_ts_idx
    ON polymarket_trades (token_id, (COALESCE(trade_ts, received_at)));

-- 1-minute aggregates derived from the in-memory book (kept forever, 3 GB quota).
CREATE TABLE IF NOT EXISTS polymarket_series_1m (
    token_id TEXT NOT NULL,
    bucket_start TIMESTAMPTZ NOT NULL,
    mid_open TEXT,
    mid_high TEXT,
    mid_low TEXT,
    mid_close TEXT,
    best_bid TEXT,
    best_ask TEXT,
    spread TEXT,
    bid_depth_top1 TEXT,
    bid_depth_top5 TEXT,
    bid_depth_top10 TEXT,
    ask_depth_top1 TEXT,
    ask_depth_top5 TEXT,
    ask_depth_top10 TEXT,
    updates_count INTEGER NOT NULL DEFAULT 0,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (token_id, bucket_start)
);

-- Sampled open interest / volume / holders / concentration (15 min).
CREATE TABLE IF NOT EXISTS polymarket_oi_holders (
    sample_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    condition_id TEXT NOT NULL,
    token_id TEXT,
    open_interest TEXT,
    live_volume TEXT,
    holders_count INTEGER,
    top1_share TEXT,
    top5_share TEXT,
    holders_json JSONB,
    source_ts TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS polymarket_oi_holders_condition_idx
    ON polymarket_oi_holders (condition_id, received_at);

-- Immutable resolution/status timeline (never pruned): UMA transitions,
-- rule_change clarifications, WS market_resolved.
CREATE TABLE IF NOT EXISTS polymarket_resolution_events (
    resolution_event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    condition_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (
        event_type IN ('proposed', 'disputed', 'resolved', 'closed', 'rule_change', 'market_resolved')
    ),
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_ts TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS polymarket_resolution_events_condition_idx
    ON polymarket_resolution_events (condition_id, received_at);

-- Data-quality gaps: every disconnect, dropped message, failed poll, resync.
CREATE TABLE IF NOT EXISTS polymarket_data_gaps (
    gap_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source TEXT NOT NULL CHECK (
        source IN ('gamma', 'clob_ws', 'clob_rest', 'data_api', 'rtds', 'macro', 'internal')
    ),
    token_id TEXT,
    gap_start TIMESTAMPTZ NOT NULL,
    gap_end TIMESTAMPTZ,
    cause TEXT NOT NULL,
    details_json JSONB,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS polymarket_data_gaps_source_idx
    ON polymarket_data_gaps (source, gap_start);

-- Universe membership log: enter/exit/rejections with reason.
CREATE TABLE IF NOT EXISTS polymarket_universe_log (
    universe_log_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    condition_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('enter', 'exit', 'rejected_cap', 'rejected_filter')),
    reason TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS polymarket_universe_log_condition_idx
    ON polymarket_universe_log (condition_id, at);

-- RTDS raw prices (Chainlink TWAP 30/60 + Binance spot) and 1-min aggregates.
CREATE TABLE IF NOT EXISTS polymarket_rtds_prices (
    rtds_price_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    feed TEXT NOT NULL CHECK (feed IN ('spot', 'twap30', 'twap60')),
    symbol TEXT NOT NULL,
    price TEXT NOT NULL,
    source_ts TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ingest_lag_ms INTEGER
);

CREATE INDEX IF NOT EXISTS polymarket_rtds_prices_feed_idx
    ON polymarket_rtds_prices (feed, symbol, received_at);

CREATE TABLE IF NOT EXISTS polymarket_rtds_1m (
    feed TEXT NOT NULL CHECK (feed IN ('spot', 'twap30', 'twap60')),
    symbol TEXT NOT NULL,
    bucket_start TIMESTAMPTZ NOT NULL,
    open TEXT,
    high TEXT,
    low TEXT,
    close TEXT,
    samples INTEGER NOT NULL DEFAULT 0,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (feed, symbol, bucket_start)
);

-- Macro calendar (versioned) and official release values (never pruned).
CREATE TABLE IF NOT EXISTS polymarket_macro_calendar (
    macro_calendar_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('bls', 'bea', 'fomc')),
    event_key TEXT NOT NULL,
    event_name TEXT NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    payload_json JSONB,
    source_ts TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source, event_key, version)
);

CREATE TABLE IF NOT EXISTS polymarket_macro_releases (
    macro_release_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('bls', 'bea', 'fomc')),
    event_key TEXT NOT NULL,
    value TEXT,
    published_at TIMESTAMPTZ,
    payload_json JSONB,
    source_ts TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source, event_key)
);

-- Retention actions (audit of pruning; never pruned).
CREATE TABLE IF NOT EXISTS polymarket_retention_log (
    retention_log_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_name TEXT NOT NULL,
    cause TEXT NOT NULL CHECK (cause IN ('ttl', 'quota')),
    pruned_before TIMESTAMPTZ NOT NULL,
    rows_deleted BIGINT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
