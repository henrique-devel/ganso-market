-- RFC-012 runtime safety follow-up. Migration 0010 is checksum-pinned in
-- development environments, so retention compatibility and the execution
-- handshake live in a new migration.

-- Scores remain immutable in place, while DELETE is intentionally available
-- to the retention worker. The immutable score-version row preserves the
-- scoring definition after raw score rows age out; exact replay remains
-- bounded by the retention windows of the as-of inputs.
DROP TRIGGER IF EXISTS resolution_scores_guard_trg ON resolution_scores;
CREATE TRIGGER resolution_scores_guard_trg
    BEFORE UPDATE ON resolution_scores
    FOR EACH ROW EXECUTE FUNCTION resolution_scores_guard();

-- Every discrete source mutation that can change resolution_market_state is
-- mirrored transactionally into one ordered journal. The broker locks this
-- table before validating the runtime watermark, so a source writer either
-- commits before the check (and makes the runtime lag) or after the fill.
CREATE TABLE IF NOT EXISTS polymarket_resolution_input_changes (
    input_change_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN (
        'resolution_event', 'rule_version', 'param_version',
        'event_membership', 'market_metadata', 'universe_membership'
    )),
    source_key TEXT NOT NULL,
    condition_id TEXT NOT NULL CHECK (char_length(condition_id) BETWEEN 1 AND 128),
    observed_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT polymarket_resolution_input_changes_source_key_check
        CHECK (char_length(source_key) >= 1),
    UNIQUE (source, source_key)
);

-- Keep both journal constraints explicit on an idempotent schema reapplication.
-- Composite keys are encoded as JSON arrays (collision-free even when
-- identifiers contain punctuation), so source keys need only be non-empty.
ALTER TABLE polymarket_resolution_input_changes
    DROP CONSTRAINT IF EXISTS polymarket_resolution_input_changes_source_check;
ALTER TABLE polymarket_resolution_input_changes
    ADD CONSTRAINT polymarket_resolution_input_changes_source_check CHECK (
        source IN (
            'resolution_event', 'rule_version', 'param_version',
            'event_membership', 'market_metadata', 'universe_membership'
        )
    );

ALTER TABLE polymarket_resolution_input_changes
    DROP CONSTRAINT IF EXISTS polymarket_resolution_input_changes_source_key_check;
ALTER TABLE polymarket_resolution_input_changes
    ADD CONSTRAINT polymarket_resolution_input_changes_source_key_check
    CHECK (char_length(source_key) >= 1);

CREATE INDEX IF NOT EXISTS polymarket_resolution_input_changes_condition_idx
    ON polymarket_resolution_input_changes (condition_id, input_change_id);

CREATE OR REPLACE FUNCTION capture_resolution_input_change()
RETURNS TRIGGER AS $$
DECLARE
    row_json JSONB;
    captured_key TEXT;
    captured_condition TEXT;
    captured_at TIMESTAMPTZ;
BEGIN
    row_json := to_jsonb(NEW);
    captured_key := row_json ->> TG_ARGV[1];
    captured_condition := row_json ->> 'condition_id';
    captured_at := COALESCE(
        (row_json ->> TG_ARGV[2])::timestamptz,
        CURRENT_TIMESTAMP
    );
    IF captured_key IS NULL OR captured_condition IS NULL THEN
        RAISE EXCEPTION 'resolution input change lacks key or condition';
    END IF;
    INSERT INTO polymarket_resolution_input_changes
        (source, source_key, condition_id, observed_at)
    VALUES (TG_ARGV[0], captured_key, captured_condition, captured_at)
    ON CONFLICT (source, source_key) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION capture_resolution_event_membership_change()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO polymarket_resolution_input_changes
        (source, source_key, condition_id, observed_at)
    VALUES (
        'event_membership',
        jsonb_build_array(NEW.event_id, NEW.condition_id)::text,
        NEW.condition_id,
        NEW.received_at
    )
    ON CONFLICT (source, source_key) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION resolution_input_changes_guard()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'polymarket_resolution_input_changes rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS resolution_input_changes_guard_trg
    ON polymarket_resolution_input_changes;
CREATE TRIGGER resolution_input_changes_guard_trg
    BEFORE UPDATE OR DELETE ON polymarket_resolution_input_changes
    FOR EACH ROW EXECUTE FUNCTION resolution_input_changes_guard();

-- Install every source trigger before the backfill. CREATE TRIGGER holds a
-- ShareRowExclusiveLock until migration commit: source writers that arrived
-- before the lock are visible to the subsequent READ COMMITTED backfill, and
-- writers that arrive later cannot commit until the trigger is active.
DROP TRIGGER IF EXISTS resolution_event_input_change_trg
    ON polymarket_resolution_events;
CREATE TRIGGER resolution_event_input_change_trg
    AFTER INSERT ON polymarket_resolution_events
    FOR EACH ROW EXECUTE FUNCTION capture_resolution_input_change(
        'resolution_event', 'resolution_event_id', 'received_at'
    );

DROP TRIGGER IF EXISTS rule_version_input_change_trg
    ON polymarket_rule_versions;
CREATE TRIGGER rule_version_input_change_trg
    AFTER INSERT ON polymarket_rule_versions
    FOR EACH ROW EXECUTE FUNCTION capture_resolution_input_change(
        'rule_version', 'rule_version_id', 'received_at'
    );

DROP TRIGGER IF EXISTS param_version_input_change_trg
    ON polymarket_param_versions;
CREATE TRIGGER param_version_input_change_trg
    AFTER INSERT ON polymarket_param_versions
    FOR EACH ROW EXECUTE FUNCTION capture_resolution_input_change(
        'param_version', 'param_version_id', 'received_at'
    );

DROP TRIGGER IF EXISTS event_membership_input_change_trg
    ON polymarket_event_markets;
CREATE TRIGGER event_membership_input_change_trg
    AFTER INSERT ON polymarket_event_markets
    FOR EACH ROW EXECUTE FUNCTION capture_resolution_event_membership_change();

DROP TRIGGER IF EXISTS universe_membership_input_change_trg
    ON polymarket_universe_log;
CREATE TRIGGER universe_membership_input_change_trg
    AFTER INSERT ON polymarket_universe_log
    FOR EACH ROW EXECUTE FUNCTION capture_resolution_input_change(
        'universe_membership', 'universe_log_id', 'at'
    );

-- These two membership sources are append-only logs. Rejecting row mutation
-- makes the INSERT-only journal triggers complete by construction while still
-- allowing TRUNCATE in throwaway integration databases.
CREATE OR REPLACE FUNCTION polymarket_event_markets_append_only_guard()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'polymarket_event_markets rows are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS polymarket_event_markets_append_only_guard_trg
    ON polymarket_event_markets;
CREATE TRIGGER polymarket_event_markets_append_only_guard_trg
    BEFORE UPDATE OR DELETE ON polymarket_event_markets
    FOR EACH ROW EXECUTE FUNCTION polymarket_event_markets_append_only_guard();

CREATE OR REPLACE FUNCTION polymarket_universe_log_append_only_guard()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'polymarket_universe_log rows are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS polymarket_universe_log_append_only_guard_trg
    ON polymarket_universe_log;
CREATE TRIGGER polymarket_universe_log_append_only_guard_trg
    BEFORE UPDATE OR DELETE ON polymarket_universe_log
    FOR EACH ROW EXECUTE FUNCTION polymarket_universe_log_append_only_guard();

-- Idempotent upgrade backfill. The source primary keys, plus the source
-- namespace, form a collision-free key; event membership uses an ordered JSON
-- tuple so no delimiter escaping convention is required.
INSERT INTO polymarket_resolution_input_changes
    (source, source_key, condition_id, observed_at)
SELECT source, source_key, condition_id, observed_at
  FROM (
    SELECT 'resolution_event'::text AS source,
           resolution_event_id::text AS source_key,
           condition_id, received_at AS observed_at
      FROM polymarket_resolution_events
    UNION ALL
    SELECT 'rule_version', rule_version_id::text, condition_id, received_at
      FROM polymarket_rule_versions
    UNION ALL
    SELECT 'param_version', param_version_id::text, condition_id, received_at
      FROM polymarket_param_versions
    UNION ALL
    SELECT 'event_membership',
           jsonb_build_array(event_id, condition_id)::text,
           condition_id, received_at
      FROM polymarket_event_markets
    UNION ALL
    SELECT 'universe_membership', universe_log_id::text, condition_id, at
      FROM polymarket_universe_log
  ) existing
 ORDER BY observed_at, source, source_key
ON CONFLICT (source, source_key) DO NOTHING;

-- One durable lease owned by the active resolution process. A new process
-- generation invalidates every resting paper order accepted by its
-- predecessor. Watermarks make readiness conditional on having consumed all
-- rule/status inputs visible to the broker.
CREATE TABLE IF NOT EXISTS resolution_runtime_state (
    runtime_id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (runtime_id = 1),
    generation UUID NOT NULL,
    score_version TEXT NOT NULL CHECK (char_length(score_version) BETWEEN 1 AND 64),
    ready BOOLEAN NOT NULL DEFAULT FALSE,
    started_at TIMESTAMPTZ NOT NULL,
    ready_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ NOT NULL,
    lease_expires_at TIMESTAMPTZ NOT NULL,
    last_success_at TIMESTAMPTZ,
    processed_resolution_event_id BIGINT NOT NULL DEFAULT 0
        CHECK (processed_resolution_event_id >= 0),
    processed_rule_version_id BIGINT NOT NULL DEFAULT 0
        CHECK (processed_rule_version_id >= 0),
    processed_input_change_id BIGINT NOT NULL DEFAULT 0
        CHECK (processed_input_change_id >= 0),
    graph_evaluated_at TIMESTAMPTZ,
    graph_valid_until TIMESTAMPTZ,
    failure_reason TEXT,
    stopped_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT resolution_runtime_ready_times_check CHECK (
        NOT ready OR (
            ready_at IS NOT NULL
            AND last_success_at IS NOT NULL
            AND graph_evaluated_at IS NOT NULL
            AND graph_valid_until IS NOT NULL
        )
    ),
    CONSTRAINT resolution_runtime_graph_freshness_check CHECK (
        (graph_evaluated_at IS NULL AND graph_valid_until IS NULL)
        OR (
            graph_evaluated_at IS NOT NULL
            AND graph_valid_until IS NOT NULL
            AND graph_valid_until > graph_evaluated_at
        )
    )
);

-- Declare the journal cursor defensively so local and ephemeral migration
-- re-execution preserves any existing runtime row.
ALTER TABLE resolution_runtime_state
    ADD COLUMN IF NOT EXISTS processed_input_change_id BIGINT
    NOT NULL DEFAULT 0;

ALTER TABLE resolution_runtime_state
    ADD COLUMN IF NOT EXISTS graph_evaluated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS graph_valid_until TIMESTAMPTZ;

ALTER TABLE resolution_runtime_state
    DROP CONSTRAINT IF EXISTS resolution_runtime_processed_input_change_check;
ALTER TABLE resolution_runtime_state
    ADD CONSTRAINT resolution_runtime_processed_input_change_check
    CHECK (processed_input_change_id >= 0);

ALTER TABLE resolution_runtime_state
    DROP CONSTRAINT IF EXISTS resolution_runtime_ready_times_check;
ALTER TABLE resolution_runtime_state
    ADD CONSTRAINT resolution_runtime_ready_times_check CHECK (
        NOT ready OR (
            ready_at IS NOT NULL
            AND last_success_at IS NOT NULL
            AND graph_evaluated_at IS NOT NULL
            AND graph_valid_until IS NOT NULL
        )
    );

ALTER TABLE resolution_runtime_state
    DROP CONSTRAINT IF EXISTS resolution_runtime_graph_freshness_check;
ALTER TABLE resolution_runtime_state
    ADD CONSTRAINT resolution_runtime_graph_freshness_check CHECK (
        (graph_evaluated_at IS NULL AND graph_valid_until IS NULL)
        OR (
            graph_evaluated_at IS NOT NULL
            AND graph_valid_until IS NOT NULL
            AND graph_valid_until > graph_evaluated_at
        )
    );

-- NULL marks orders created before the runtime handshake, or accepted while
-- the runtime was unhealthy. They are cancel-only and can never execute.
ALTER TABLE paper_orders
    ADD COLUMN IF NOT EXISTS resolution_generation UUID,
    ADD COLUMN IF NOT EXISTS resolution_risk_check_pending BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS resolution_risk_claim UUID,
    ADD COLUMN IF NOT EXISTS resolution_risk_claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS resolution_cancel_reason TEXT,
    ADD COLUMN IF NOT EXISTS resolution_cancel_details_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE paper_orders
    DROP CONSTRAINT IF EXISTS paper_orders_resolution_cancel_details_check;
ALTER TABLE paper_orders
    ADD CONSTRAINT paper_orders_resolution_cancel_details_check
    CHECK (jsonb_typeof(resolution_cancel_details_json) = 'object');

ALTER TABLE paper_orders
    DROP CONSTRAINT IF EXISTS paper_orders_resolution_risk_claim_check;
ALTER TABLE paper_orders
    ADD CONSTRAINT paper_orders_resolution_risk_claim_check CHECK (
        (resolution_risk_check_pending
         AND resolution_risk_claim IS NOT NULL
         AND resolution_risk_claimed_at IS NOT NULL)
        OR
        (NOT resolution_risk_check_pending
         AND resolution_risk_claim IS NULL
         AND resolution_risk_claimed_at IS NULL)
    );

CREATE INDEX IF NOT EXISTS paper_orders_resolution_generation_open_idx
    ON paper_orders (resolution_generation, token_id)
    WHERE status = 'open';

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
