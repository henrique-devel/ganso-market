-- RFC-011 Parts C and D: the paper broker's orders, its append-only ledger,
-- the derived positions and the kill switch. SIMULATION ONLY: nothing here
-- stores an order signature, a wallet or any trading credential — these are
-- simulated orders against recorded public data. Prices/sizes/fees are
-- canonical decimal strings, never floats.
--
-- Database-level invariants of the RFC:
--   * no order row can exist without an explicit limit_price;
--   * no marketable (FAK/FOK) order can exist without worst_price;
--   * ledger events are immutable (UPDATE/DELETE refused by trigger) and
--     idempotent (unique idempotency_key absorbs duplicates and replays).

CREATE TABLE IF NOT EXISTS paper_orders (
    order_id TEXT PRIMARY KEY CHECK (char_length(order_id) BETWEEN 1 AND 64),
    token_id TEXT NOT NULL CHECK (char_length(token_id) BETWEEN 1 AND 128),
    condition_id TEXT,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    order_type TEXT NOT NULL CHECK (order_type IN ('GTC', 'GTD', 'FAK', 'FOK')),
    limit_price TEXT NOT NULL CHECK (char_length(limit_price) > 0),
    size TEXT NOT NULL CHECK (char_length(size) > 0),
    filled_size TEXT NOT NULL DEFAULT '0',
    amount_usd TEXT,
    post_only BOOLEAN NOT NULL DEFAULT TRUE,
    worst_price TEXT,
    expiration_s BIGINT,
    policy_reason TEXT,
    policy_version TEXT,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'intent')),
    status TEXT NOT NULL CHECK (status IN ('open', 'filled', 'canceled', 'rejected', 'expired')),
    -- Conservative queue position at accept: BEHIND all visible size at the
    -- level. Cancels ahead never improve it (RFC-011 C2).
    queue_ahead TEXT,
    decided_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    cancel_requested_at TIMESTAMPTZ,
    cancel_effective_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT paper_orders_marketable_needs_worst CHECK (
        order_type NOT IN ('FAK', 'FOK') OR worst_price IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS paper_orders_status_idx
    ON paper_orders (status, token_id);

-- Append-only event ledger: replaying it reconstructs positions and P&L bit
-- for bit. Every fill event carries the consumed book slice in payload_json,
-- so the replay stays valid after the book_deltas TTL prunes the raw data.
CREATE TABLE IF NOT EXISTS paper_ledger_events (
    event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 1 AND 256),
    event_type TEXT NOT NULL CHECK (
        event_type IN (
            'order_accepted', 'order_rejected', 'cancel_requested',
            'cancel_effective', 'fill', 'fill_denied_degradation', 'expired',
            'resolution', 'mark', 'kill_switch_engaged', 'kill_switch_rearmed'
        )
    ),
    order_id TEXT,
    token_id TEXT,
    condition_id TEXT,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    event_ts TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS paper_ledger_events_order_idx
    ON paper_ledger_events (order_id, event_ts);
CREATE INDEX IF NOT EXISTS paper_ledger_events_token_idx
    ON paper_ledger_events (token_id, event_ts);

CREATE OR REPLACE FUNCTION paper_ledger_events_guard() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'paper_ledger_events rows are immutable (append-only ledger)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS paper_ledger_events_guard_trg ON paper_ledger_events;
CREATE TRIGGER paper_ledger_events_guard_trg
    BEFORE UPDATE OR DELETE ON paper_ledger_events
    FOR EACH ROW EXECUTE FUNCTION paper_ledger_events_guard();

-- Derived positions (cache of the ledger; the replay test proves equality).
CREATE TABLE IF NOT EXISTS paper_positions (
    token_id TEXT PRIMARY KEY CHECK (char_length(token_id) BETWEEN 1 AND 128),
    condition_id TEXT,
    shares TEXT NOT NULL DEFAULT '0',
    cost_usd TEXT NOT NULL DEFAULT '0',
    realized_pnl_usd TEXT NOT NULL DEFAULT '0',
    fees_paid_usd TEXT NOT NULL DEFAULT '0',
    opened_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    lockup_s BIGINT,
    -- Mark to executable bid (never mid, never last): full-size book-walk
    -- proceeds, or the frozen value flagged stale.
    mark_value_usd TEXT,
    mark_stale BOOLEAN,
    marked_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Single-row kill switch state; engagements/rearms are ALSO ledger events.
CREATE TABLE IF NOT EXISTS paper_kill_switch (
    kill_switch_id INTEGER PRIMARY KEY DEFAULT 1 CHECK (kill_switch_id = 1),
    engaged BOOLEAN NOT NULL DEFAULT FALSE,
    reason TEXT,
    engaged_at TIMESTAMPTZ,
    rearmed_at TIMESTAMPTZ,
    -- Markets with an active UMA dispute while holding a position: entries
    -- frozen per market without engaging the global switch.
    frozen_markets_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(frozen_markets_json) = 'array'),
    -- Daily-loss trigger anchor: equity (realized + marks) at the first tick
    -- of the UTC day; the trigger compares the current equity against it.
    daily_anchor_date DATE,
    daily_anchor_equity_usd TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO paper_kill_switch (kill_switch_id) VALUES (1)
ON CONFLICT (kill_switch_id) DO NOTHING;

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
