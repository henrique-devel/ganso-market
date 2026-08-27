-- RFC-013 + RFC-011: the decision -> paper order bridge, plus the entry
-- provenance the exit cycle needs to outlive the decision log.
--
-- SIMULATION ONLY. This migration adds no wallet, signer, private key, trading
-- credential or real order path, and the two scope guards (paper/scope.test.ts,
-- portfolio/scope.test.ts) fail the build if one appears. It connects a
-- decision engine to a simulator; real execution stays exclusive to RFC-009,
-- behind gates G1-G6.
--
-- Design decided in docs/architecture/decision-to-paper-bridge.md: the decision
-- log is the outbox, the consumer lives in the `paper` module, and neither
-- module writes to the other's tables. The join key travels with the ORDER
-- (paper_orders.decision_id) rather than only with the decision, because
-- paper_orders is not inside the decision log's quota - the record of what was
-- SENT survives the pruning of what was DECIDED.
--
-- 0014 is not touched.

-- The order carries the decision that produced it. Deliberately NOT a foreign
-- key: portfolio_decisions is a pruned series (quota binds around three days)
-- and an FK would either block that pruning or cascade-delete the order, which
-- is the record we specifically want to keep longer than its decision.
ALTER TABLE paper_orders
    ADD COLUMN IF NOT EXISTS decision_id BIGINT
        CHECK (decision_id IS NULL OR decision_id > 0);

-- 'portfolio' joins the sources a simulated order can have. The original CHECK
-- was declared inline on the column, so PostgreSQL named it
-- paper_orders_source_check; drop by that name and re-add it named explicitly.
ALTER TABLE paper_orders
    DROP CONSTRAINT IF EXISTS paper_orders_source_check;
ALTER TABLE paper_orders
    ADD CONSTRAINT paper_orders_source_check
    CHECK (source IN ('manual', 'intent', 'portfolio'));

-- Only a portfolio-sourced order may carry a decision, and it must carry one:
-- an order claiming to come from a decision that names none would be
-- unauditable, and a manual order naming a decision would be a false trail.
ALTER TABLE paper_orders
    DROP CONSTRAINT IF EXISTS paper_orders_decision_source_check;
ALTER TABLE paper_orders
    ADD CONSTRAINT paper_orders_decision_source_check
    CHECK ((source = 'portfolio') = (decision_id IS NOT NULL));

-- Idempotency of the bridge, enforced by the database rather than by the job:
-- one decision can produce at most one order, so a crash between accepting and
-- stamping cannot duplicate an order on the next tick.
CREATE UNIQUE INDEX IF NOT EXISTS paper_orders_decision_id_key
    ON paper_orders (decision_id)
    WHERE decision_id IS NOT NULL;

-- The bridge's own work queue: accepted entries not yet turned into an order.
-- Partial, so it stays the size of the backlog and not of the log.
CREATE INDEX IF NOT EXISTS portfolio_decisions_bridge_pending_idx
    ON portfolio_decisions (decision_id)
    WHERE outcome = 'ACCEPTED'
      AND decision_kind = 'ENTRY'
      AND paper_order_id IS NULL;

-- What the entry committed to believing, copied out of the decision at the
-- moment the order was accepted.
--
-- Why this table exists at all: the exit cycle compares a held position against
-- its ENTRY, reading the entry's row out of portfolio_decisions. That log has a
-- TTL of months but a quota that prunes it in about three days, so any position
-- held longer lost the thesis it was entered on - and four of the seven exit
-- criteria (invalidation, model-move, source change, rule-precision downgrade)
-- silently stop being able to fire, because each defaults to "we do not know
-- that it moved" when the entry is missing. That default is honest when the row
-- never existed and is silent degeneration when retention removed it.
--
-- Append-only and never pruned (retention.ts marks it `protected`). One row per
-- accepted entry, so re-entering the same token after a close records a new
-- thesis instead of overwriting the old one; the exit cycle reads the newest row
-- for the token. Volume is one row per position, not per cycle.
CREATE TABLE IF NOT EXISTS portfolio_position_entries (
    decision_id BIGINT PRIMARY KEY,
    condition_id TEXT NOT NULL CHECK (char_length(condition_id) BETWEEN 1 AND 128),
    token_id TEXT NOT NULL CHECK (char_length(token_id) BETWEEN 1 AND 128),
    market_side TEXT NOT NULL CHECK (market_side IN ('YES', 'NO')),
    paper_order_id TEXT NOT NULL CHECK (char_length(paper_order_id) BETWEEN 1 AND 64),
    entry_decision_ts TIMESTAMPTZ NOT NULL,
    -- The interval that justified the entry. Same 6-digit form as everywhere
    -- else, so a q, a score and a price stay comparable across modules.
    q_lo TEXT CHECK (q_lo ~ '^[01]\.[0-9]{6}$'),
    q_hi TEXT CHECK (q_hi ~ '^[01]\.[0-9]{6}$'),
    rule_version INTEGER CHECK (rule_version IS NULL OR rule_version > 0),
    resolution_source TEXT,
    rule_precision TEXT CHECK (rule_precision ~ '^[01]\.[0-9]{6}$'),
    -- Field 12 as an evaluable level: what the conservative estimate has to stay
    -- above for the thesis to hold. It is the executable price PLUS costs, so it
    -- is a money quantity and not strictly a probability - it can exceed 1 in
    -- principle, and refusing such a row would block the stamp for a value that
    -- is not nonsense (a level above 1 simply cannot be met, which is the
    -- conservative reading: the reason to hold is already gone).
    invalidation_prob_lower_below TEXT
        CHECK (invalidation_prob_lower_below ~ '^[0-9]{1,3}\.[0-9]{6}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS portfolio_position_entries_token_idx
    ON portfolio_position_entries (token_id, entry_decision_ts DESC);

-- Immutable for the same reason the decision log is: this row IS the record of
-- what the entry believed. A rewrite would let today's opinion edit the past and
-- make the exit criteria compare today against today.
CREATE OR REPLACE FUNCTION portfolio_position_entries_guard() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'portfolio_position_entries rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS portfolio_position_entries_guard_trg ON portfolio_position_entries;
CREATE TRIGGER portfolio_position_entries_guard_trg
    BEFORE UPDATE OR DELETE ON portfolio_position_entries
    FOR EACH ROW EXECUTE FUNCTION portfolio_position_entries_guard();

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
