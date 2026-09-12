-- DATA-02 / RFC-041: fail-closed evidence hold, including the legacy pruner.
-- Local reviewable migration artifact. PostgreSQL validation must use a
-- disposable test database; production application is a separate delivery gate.
-- This version has NO deletion capability, quota override or per-row exception.
-- Unknown economic/reference closure and raw horizons keep the entire table.
-- The migration runner supplies the transaction. No scans/data rewrites or
-- replacement of existing immutability guards. Writers resume after the short
-- selector/pin transaction; the selector enforces a hard transaction deadline.
-- Production verification must assess contention before regular selector use.
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '5s';

CREATE FUNCTION retention_evidence_policy_version() RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT 'data-02-v1'::text $$;

-- Explicit inventory, not a wildcard/prefix discovered at execution time.
-- 69 evidence/configuration tables plus four held Solana residuals. Auth and
-- schema migration bookkeeping are deliberately outside the data policy.
CREATE FUNCTION retention_evidence_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT ARRAY[
    'app_settings',
    'audit_events',
    'bonding_curve_state',
    'domain_events',
    'event_quarantine',
    'fast_config_versions',
    'fast_wallet_state',
    'fundamental_calibration_reports',
    'fundamental_estimates',
    'fundamental_gate_reports',
    'fundamental_labels',
    'fundamental_model_events',
    'fundamental_models',
    'graph_edges',
    'graph_sanity_vetoes',
    'graph_violations',
    'paper_feature_windows',
    'paper_fill_reports',
    'paper_fill_samples',
    'paper_kill_switch',
    'paper_ledger_events',
    'paper_markouts',
    'paper_orders',
    'paper_positions',
    'polymarket_book_deltas',
    'polymarket_book_snapshots',
    'polymarket_book_snapshots_full',
    'polymarket_data_gaps',
    'polymarket_event_markets',
    'polymarket_events',
    'polymarket_macro_calendar',
    'polymarket_macro_releases',
    'polymarket_market_metadata_versions',
    'polymarket_markets',
    'polymarket_oi_holders',
    'polymarket_param_versions',
    'polymarket_resolution_events',
    'polymarket_resolution_input_changes',
    'polymarket_retention_log',
    'polymarket_rtds_1m',
    'polymarket_rtds_prices',
    'polymarket_rule_versions',
    'polymarket_series_1m',
    'polymarket_trades',
    'polymarket_universe_log',
    'portfolio_circuit_breakers',
    'portfolio_config_versions',
    'portfolio_cycle_summary',
    'portfolio_decision_hourly',
    'portfolio_decisions',
    'portfolio_exposures',
    'portfolio_factor_map_versions',
    'portfolio_g2_clock',
    'portfolio_g2_clock_events',
    'portfolio_gate_measurements',
    'portfolio_gate_reports',
    'portfolio_panel_snapshots',
    'portfolio_position_entries',
    'portfolio_state',
    'portfolio_state_events',
    'pumpswap_pool_state',
    'resolution_adjudication_samples',
    'resolution_clarifications',
    'resolution_layer_divergences',
    'resolution_market_state',
    'resolution_onchain_cursor',
    'resolution_onchain_events',
    'resolution_reports',
    'resolution_runtime_state',
    'resolution_score_versions',
    'resolution_scores',
    'resolution_uma_timeline',
    'strategy_decisions'
]::text[] $$;

-- Selector and pin callers acquire this BEFORE taking a READ COMMITTED
-- snapshot. Writers acquire the shared key at statement start and hold it to
-- commit. Exclusive callers fail immediately behind any writer, without queuing
-- an exclusive waiter that would stall later writers. A writer arriving during
-- a short exclusive transaction waits until commit, then continues normally.
CREATE FUNCTION retention_evidence_lock() RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
    IF NOT pg_catalog.pg_try_advisory_xact_lock(741041, 2) THEN
        RAISE EXCEPTION USING ERRCODE = '55P03',
            MESSAGE = 'DATA02_EVIDENCE_LOCK_BUSY';
    END IF;
END;
$$;

CREATE FUNCTION retention_evidence_writer_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(741041, 2);
    RETURN NULL;
END;
$$;

CREATE FUNCTION retention_evidence_delete_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'DATA02_EVIDENCE_HOLD: ' || TG_TABLE_NAME || ' ' || TG_OP;
END;
$$;

-- Statement triggers also refuse zero-row DELETE and empty-table TRUNCATE.
-- Existing ledger, strategy/configuration and gate row guards remain intact.
DO $$
DECLARE
    evidence_table text;
    evidence_schema text := current_schema();
BEGIN
    FOREACH evidence_table IN ARRAY retention_evidence_tables() LOOP
        EXECUTE format(
            'CREATE TRIGGER retention_evidence_write_lock_trg '
            'BEFORE INSERT OR UPDATE ON %I.%I FOR EACH STATEMENT '
            'EXECUTE FUNCTION %I.retention_evidence_writer_lock()',
            evidence_schema, evidence_table, evidence_schema
        );
        EXECUTE format(
            'CREATE TRIGGER retention_evidence_delete_guard_trg '
            'BEFORE DELETE OR TRUNCATE ON %I.%I FOR EACH STATEMENT '
            'EXECUTE FUNCTION %I.retention_evidence_delete_guard()',
            evidence_schema, evidence_table, evidence_schema
        );
    END LOOP;
END;
$$;

-- V1 pins are table-wide supersets: no invented dataset horizon or L2 anchor.
-- Removing a pin is audited and does NOT lift the unconditional evidence hold.
CREATE TABLE retention_evidence_pins (
    pin_id text PRIMARY KEY CHECK (char_length(btrim(pin_id)) BETWEEN 1 AND 128),
    dataset_id text NOT NULL CHECK (char_length(btrim(dataset_id)) BETWEEN 1 AND 256),
    table_name text NOT NULL CHECK (table_name = ANY(retention_evidence_tables())),
    reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2048),
    artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE retention_pin_events (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation text NOT NULL CHECK (operation IN ('INSERT', 'DELETE')),
    pin jsonb NOT NULL CHECK (jsonb_typeof(pin) = 'object'),
    occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX retention_evidence_pins_table_idx
    ON retention_evidence_pins (table_name, pin_id);

CREATE FUNCTION retention_evidence_pins_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT pg_catalog.pg_try_advisory_xact_lock(741041, 2) THEN
        RAISE EXCEPTION USING ERRCODE = '55P03',
            MESSAGE = 'DATA02_EVIDENCE_LOCK_BUSY';
    END IF;
    IF TG_OP IN ('UPDATE', 'TRUNCATE') THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'DATA02_PIN_IMMUTABLE: use audited DELETE/INSERT';
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER retention_evidence_pins_lock_trg
    BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON retention_evidence_pins
    FOR EACH STATEMENT EXECUTE FUNCTION retention_evidence_pins_lock();

CREATE FUNCTION retention_evidence_pins_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE format(
        'INSERT INTO %I.retention_pin_events (operation, pin) VALUES ($1, $2)',
        TG_TABLE_SCHEMA
    ) USING TG_OP, CASE WHEN TG_OP = 'INSERT' THEN to_jsonb(NEW) ELSE to_jsonb(OLD) END;
    RETURN NULL;
END;
$$;

CREATE TRIGGER retention_evidence_pins_audit_trg
    AFTER INSERT OR DELETE ON retention_evidence_pins
    FOR EACH ROW EXECUTE FUNCTION retention_evidence_pins_audit();

CREATE TRIGGER retention_pin_events_guard_trg
    BEFORE UPDATE OR DELETE OR TRUNCATE ON retention_pin_events
    FOR EACH STATEMENT EXECUTE FUNCTION retention_evidence_delete_guard();

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
