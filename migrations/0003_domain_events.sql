-- RFC-004 domain events, quarantine, and lifecycle projections. Monetary values
-- are exact integers (BIGINT), never floats. Real and virtual reserves are
-- distinct columns. No external backup is introduced.

CREATE TABLE IF NOT EXISTS domain_events (
    domain_event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    event_id TEXT NOT NULL UNIQUE CHECK (char_length(event_id) BETWEEN 1 AND 256),
    event_type TEXT NOT NULL CHECK (event_type ~ '^[A-Z][A-Za-z0-9]{0,63}$'),
    program_id TEXT NOT NULL CHECK (char_length(program_id) BETWEEN 32 AND 44),
    slot BIGINT NOT NULL CHECK (slot >= 0),
    commitment TEXT NOT NULL CHECK (commitment IN ('processed', 'confirmed', 'finalized')),
    signature TEXT,
    instruction_index INTEGER CHECK (instruction_index IS NULL OR instruction_index >= 0),
    inner_index INTEGER CHECK (inner_index IS NULL OR inner_index >= 0),
    parser_version TEXT NOT NULL,
    mint TEXT,
    curve TEXT,
    pool TEXT,
    source_ts TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    normalized_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    reason_code TEXT CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
);

CREATE INDEX IF NOT EXISTS domain_events_slot_idx ON domain_events (slot DESC);
CREATE INDEX IF NOT EXISTS domain_events_mint_idx ON domain_events (mint) WHERE mint IS NOT NULL;
CREATE INDEX IF NOT EXISTS domain_events_pool_idx ON domain_events (pool) WHERE pool IS NOT NULL;
CREATE INDEX IF NOT EXISTS domain_events_type_idx ON domain_events (event_type);

-- Unknown discriminators or layouts are quarantined and alerted, never dropped
-- silently and never applied to projections (DATA-05).
CREATE TABLE IF NOT EXISTS event_quarantine (
    quarantine_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    program_id TEXT NOT NULL,
    discriminator TEXT NOT NULL CHECK (discriminator ~ '^[0-9a-f]{16}$'),
    slot BIGINT NOT NULL CHECK (slot >= 0),
    signature TEXT,
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reason_code TEXT NOT NULL DEFAULT 'UNKNOWN_DISCRIMINATOR'
        CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
);

CREATE INDEX IF NOT EXISTS event_quarantine_received_idx
    ON event_quarantine (received_at DESC);

-- Bonding-curve projection. Reserves are absolute post-event snapshots taken
-- from the on-chain TradeEvent, so application is idempotent and cannot go
-- negative. Real and virtual reserves are kept distinct (DATA-03).
CREATE TABLE IF NOT EXISTS bonding_curve_state (
    mint TEXT PRIMARY KEY,
    bonding_curve TEXT,
    creator TEXT,
    virtual_sol_reserves BIGINT NOT NULL DEFAULT 0 CHECK (virtual_sol_reserves >= 0),
    virtual_token_reserves BIGINT NOT NULL DEFAULT 0 CHECK (virtual_token_reserves >= 0),
    real_sol_reserves BIGINT NOT NULL DEFAULT 0 CHECK (real_sol_reserves >= 0),
    real_token_reserves BIGINT NOT NULL DEFAULT 0 CHECK (real_token_reserves >= 0),
    complete BOOLEAN NOT NULL DEFAULT FALSE,
    migrated_pool TEXT,
    last_slot BIGINT NOT NULL DEFAULT 0 CHECK (last_slot >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Canonical PumpSwap pool projection.
CREATE TABLE IF NOT EXISTS pumpswap_pool_state (
    pool TEXT PRIMARY KEY,
    base_mint TEXT,
    quote_mint TEXT,
    creator TEXT,
    pool_base_reserves BIGINT NOT NULL DEFAULT 0 CHECK (pool_base_reserves >= 0),
    pool_quote_reserves BIGINT NOT NULL DEFAULT 0 CHECK (pool_quote_reserves >= 0),
    last_slot BIGINT NOT NULL DEFAULT 0 CHECK (last_slot >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
