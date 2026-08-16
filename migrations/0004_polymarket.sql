-- RFC-007 (anticipated) Polymarket recorder tables: a versioned market registry
-- and periodic top-of-book snapshots. Public data only; no trading, wallet, or
-- auth material. Prices/sizes and tick/reward parameters are stored as canonical
-- decimal strings, never floats.

CREATE TABLE IF NOT EXISTS polymarket_markets (
    condition_id TEXT PRIMARY KEY CHECK (char_length(condition_id) BETWEEN 1 AND 128),
    question TEXT NOT NULL,
    slug TEXT,
    category TEXT,
    neg_risk BOOLEAN NOT NULL DEFAULT FALSE,
    clob_token_ids JSONB NOT NULL CHECK (jsonb_typeof(clob_token_ids) = 'array'),
    rules TEXT,
    rules_version INTEGER NOT NULL DEFAULT 1 CHECK (rules_version > 0),
    tick_size TEXT,
    min_order_size TEXT,
    rewards_min_size TEXT,
    rewards_max_spread TEXT,
    fee_type TEXT,
    end_date_iso TEXT,
    active BOOLEAN,
    closed BOOLEAN,
    source_ts TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS polymarket_markets_category_idx
    ON polymarket_markets (category);

-- Top-of-book snapshots (top 10 per side), persisted every few seconds rather
-- than every delta. source_ts is the venue timestamp; received_at is local.
CREATE TABLE IF NOT EXISTS polymarket_book_snapshots (
    snapshot_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_id TEXT NOT NULL,
    condition_id TEXT,
    book_hash TEXT,
    source_ts TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    bids_json JSONB NOT NULL CHECK (jsonb_typeof(bids_json) = 'array'),
    asks_json JSONB NOT NULL CHECK (jsonb_typeof(asks_json) = 'array')
);

CREATE INDEX IF NOT EXISTS polymarket_book_snapshots_token_idx
    ON polymarket_book_snapshots (token_id, received_at DESC);

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
