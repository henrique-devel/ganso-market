-- RFC-013: portfolio engine, entry/exit criteria and the RFC-009 gates.
-- Analytics and paper simulation only. There is no wallet, signer, private key,
-- trading credential or real order path in this migration or in the module that
-- owns it, and portfolio/scope.test.ts fails the build if one appears.
--
-- Money and sizes are canonical decimal strings, never floats: the module does
-- its arithmetic in scaled bigints (fundamental/fixed.ts) and stores the
-- formatted result. Probabilities keep the 6-digit form the RFC-010/012 tables
-- already use, so a score, a q and a price are comparable across modules
-- without reparsing conventions.

-- The versioned parameter set. Immutable by trigger: changing a parameter mints
-- a new version, and a decision keeps the hash of the version that produced it,
-- so a parameter change can never rewrite a past decision (RFC-013
-- "Restrições não negociáveis").
CREATE TABLE IF NOT EXISTS portfolio_config_versions (
    config_version_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    version TEXT NOT NULL UNIQUE CHECK (char_length(version) BETWEEN 1 AND 32),
    config_hash TEXT NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
    content_json JSONB NOT NULL,
    valid_from TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION portfolio_config_versions_guard() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'portfolio_config_versions rows are immutable: mint a new version';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS portfolio_config_versions_guard_trg ON portfolio_config_versions;
CREATE TRIGGER portfolio_config_versions_guard_trg
    BEFORE UPDATE OR DELETE ON portfolio_config_versions
    FOR EACH ROW EXECUTE FUNCTION portfolio_config_versions_guard();

-- Market -> economic factor mapping (task 4). Versioned for the same reason as
-- the config: two markets on the same factor are sized as ONE bet, so changing
-- the mapping changes what "one bet" means and must be auditable.
CREATE TABLE IF NOT EXISTS portfolio_factor_map_versions (
    factor_map_version_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    version TEXT NOT NULL UNIQUE CHECK (char_length(version) BETWEEN 1 AND 32),
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    content_json JSONB NOT NULL,
    valid_from TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS portfolio_factor_map_versions_guard_trg ON portfolio_factor_map_versions;
CREATE TRIGGER portfolio_factor_map_versions_guard_trg
    BEFORE UPDATE OR DELETE ON portfolio_factor_map_versions
    FOR EACH ROW EXECUTE FUNCTION portfolio_config_versions_guard();

-- The decision log (task 7). Every intent — entry, exit, veto, resize — lands
-- here with the inputs that produced it, the config hash in force, the binding
-- limiter and the timestamp of the OLDEST datum used. book_json carries the
-- book excerpt itself so replay does not depend on the raw delta/snapshot
-- retention window ("replay independente do TTL dos dados crus").
--
-- Append-only by trigger; DELETE stays available to the retention worker, as
-- with resolution_scores.
CREATE TABLE IF NOT EXISTS portfolio_decisions (
    decision_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    decision_kind TEXT NOT NULL CHECK (
        decision_kind IN ('ENTRY', 'EXIT', 'VETO', 'RESIZE')
    ),
    condition_id TEXT NOT NULL CHECK (char_length(condition_id) BETWEEN 1 AND 128),
    token_id TEXT NOT NULL CHECK (char_length(token_id) BETWEEN 1 AND 128),
    -- Which leg the decision is about. YES/NO is the economic side; BUY/SELL is
    -- what the paper broker would receive.
    market_side TEXT NOT NULL CHECK (market_side IN ('YES', 'NO')),
    order_side TEXT NOT NULL CHECK (order_side IN ('BUY', 'SELL')),
    decision_ts TIMESTAMPTZ NOT NULL,

    -- RFC-010 inputs. q_lo is what the entry criterion uses; q is recorded for
    -- the panel and never for the gate.
    q TEXT CHECK (q ~ '^[01]\.[0-9]{6}$'),
    q_lo TEXT CHECK (q_lo ~ '^[01]\.[0-9]{6}$'),
    q_hi TEXT CHECK (q_hi ~ '^[01]\.[0-9]{6}$'),
    estimate_source TEXT CHECK (
        estimate_source IN ('MODEL', 'MARKET_BASELINE')
    ),

    -- Executable price from the book-walk over the recorded raw book. Never a
    -- midpoint, never a last trade.
    exec_price TEXT CHECK (exec_price ~ '^[01]\.[0-9]{6}$'),
    worst_price TEXT CHECK (worst_price ~ '^[01]\.[0-9]{6}$'),
    best_price TEXT CHECK (best_price ~ '^[01]\.[0-9]{6}$'),

    -- Cost decomposition (task 1). Every component is per share.
    fee_expected TEXT CHECK (fee_expected ~ '^-?[0-9]{1,12}\.[0-9]{6}$'),
    slippage TEXT CHECK (slippage ~ '^-?[0-9]{1,12}\.[0-9]{6}$'),
    capital_cost TEXT CHECK (capital_cost ~ '^-?[0-9]{1,12}\.[0-9]{6}$'),
    resolution_buffer TEXT CHECK (resolution_buffer ~ '^-?[0-9]{1,12}\.[0-9]{6}$'),
    costs_total TEXT CHECK (costs_total ~ '^-?[0-9]{1,12}\.[0-9]{6}$'),
    safety_margin TEXT CHECK (safety_margin ~ '^-?[0-9]{1,12}\.[0-9]{6}$'),
    edge_gross TEXT CHECK (edge_gross ~ '^-?[0-9]{1,12}\.[0-9]{6}$'),
    edge_net TEXT CHECK (edge_net ~ '^-?[0-9]{1,12}\.[0-9]{6}$'),

    -- Sizing (task 3). kelly_cap is the CEILING; size_shares is the min() of
    -- every limiter, and binding_constraint names which one bound it.
    size_shares TEXT CHECK (size_shares ~ '^[0-9]{1,15}\.[0-9]{6}$'),
    kelly_cap_shares TEXT CHECK (kelly_cap_shares ~ '^[0-9]{1,15}\.[0-9]{6}$'),
    notional_usd TEXT CHECK (notional_usd ~ '^[0-9]{1,15}\.[0-9]{6}$'),
    binding_constraint TEXT NOT NULL CHECK (
        binding_constraint IN (
            'KELLY_CAP', 'DEPTH_TAKE_PCT', 'UNCERTAINTY_SHRINK',
            'CORRELATION_FACTOR', 'RULE_PRECISION', 'CAP_ENTRADA',
            'CAP_MERCADO', 'CAP_GRUPO_CORRELACIONADO', 'CAP_CATEGORIA',
            'CAP_FONTE_RESOLUCAO', 'CAP_CATALISADOR_JANELA',
            'CAP_CAPITAL_BLOQUEADO', 'SLIPPAGE_MAX_PCT_EDGE',
            'MIN_ORDER_SIZE', 'NOT_SIZED'
        )
    ),
    -- Every limiter's computed value, so the min() is auditable and any single
    -- limiter can be shown to have been the binding one.
    limiters_json JSONB NOT NULL,

    -- Provenance and reproducibility.
    config_version TEXT NOT NULL,
    config_hash TEXT NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
    factor_map_version TEXT NOT NULL,
    rule_version INTEGER CHECK (rule_version IS NULL OR rule_version > 0),
    param_version INTEGER CHECK (param_version IS NULL OR param_version > 0),
    resolution_score_version TEXT,
    resolution_action TEXT CHECK (
        resolution_action IS NULL OR resolution_action IN (
            'NONE', 'BUFFER', 'VETO', 'CIRCUIT_BREAKER'
        )
    ),
    -- No look-ahead: the newest input may not postdate the decision, and the
    -- oldest input is what the staleness TTL is measured against.
    oldest_input_ts TIMESTAMPTZ NOT NULL,
    newest_input_ts TIMESTAMPTZ NOT NULL,
    book_json JSONB NOT NULL,
    inputs_json JSONB NOT NULL,

    outcome TEXT NOT NULL CHECK (outcome IN ('ACCEPTED', 'REJECTED')),
    reason_code TEXT,
    portfolio_state TEXT NOT NULL CHECK (
        portfolio_state IN ('NORMAL', 'REDUCE_ONLY', 'HALTED')
    ),
    -- Set once the paper broker accepted an order for this decision.
    paper_order_id TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT portfolio_decisions_no_lookahead CHECK (
        newest_input_ts <= decision_ts AND oldest_input_ts <= newest_input_ts
    ),
    -- A rejection always says why; an acceptance never invents a reason.
    CONSTRAINT portfolio_decisions_rejection_needs_reason CHECK (
        (outcome = 'REJECTED') = (reason_code IS NOT NULL)
    ),
    -- An accepted ENTRY/RESIZE must be sized and must name a real limiter.
    CONSTRAINT portfolio_decisions_accepted_entry_is_sized CHECK (
        outcome <> 'ACCEPTED'
        OR decision_kind NOT IN ('ENTRY', 'RESIZE')
        OR (size_shares IS NOT NULL AND binding_constraint <> 'NOT_SIZED')
    ),
    -- The lower-bound criterion is structural: an accepted entry must carry the
    -- interval that justified it. Storing only the mean would make the RFC's
    -- central invariant unverifiable after the fact.
    CONSTRAINT portfolio_decisions_accepted_entry_has_bound CHECK (
        outcome <> 'ACCEPTED'
        OR decision_kind <> 'ENTRY'
        OR (q_lo IS NOT NULL AND q_hi IS NOT NULL AND exec_price IS NOT NULL)
    )
);

CREATE OR REPLACE FUNCTION portfolio_decisions_guard() RETURNS trigger AS $$
BEGIN
    -- paper_order_id is the single field the broker stamps after the accept, so
    -- the decision row can be written before the order exists without leaving
    -- the log mutable. Everything else stays append-only.
    IF NEW.paper_order_id IS DISTINCT FROM OLD.paper_order_id
       AND OLD.paper_order_id IS NULL
       AND (to_jsonb(NEW) - 'paper_order_id') = (to_jsonb(OLD) - 'paper_order_id')
    THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'portfolio_decisions rows are append-only (only paper_order_id may be stamped once)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS portfolio_decisions_guard_trg ON portfolio_decisions;
CREATE TRIGGER portfolio_decisions_guard_trg
    BEFORE UPDATE ON portfolio_decisions
    FOR EACH ROW EXECUTE FUNCTION portfolio_decisions_guard();

CREATE INDEX IF NOT EXISTS portfolio_decisions_market_idx
    ON portfolio_decisions (condition_id, decision_ts DESC);
CREATE INDEX IF NOT EXISTS portfolio_decisions_token_idx
    ON portfolio_decisions (token_id, decision_ts DESC);
CREATE INDEX IF NOT EXISTS portfolio_decisions_kind_idx
    ON portfolio_decisions (decision_kind, decision_ts DESC);
CREATE INDEX IF NOT EXISTS portfolio_decisions_received_at_idx
    ON portfolio_decisions (received_at);

-- Continuous exposure state (task 4), one row per (dimension, key). Worst case
-- means TOTAL LOSS of the position: a binary book can gap from a high price to
-- near zero, so every cap is consumed by the full notional, never by a
-- mark-to-market or a stop-protected fraction.
CREATE TABLE IF NOT EXISTS portfolio_exposures (
    exposure_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dimension TEXT NOT NULL CHECK (
        dimension IN (
            'market', 'event', 'category', 'resolution_source', 'factor',
            'catalyst_window', 'locked_capital', 'total'
        )
    ),
    dimension_key TEXT NOT NULL CHECK (char_length(dimension_key) BETWEEN 1 AND 256),
    worst_case_usd TEXT NOT NULL CHECK (worst_case_usd ~ '^[0-9]{1,15}\.[0-9]{6}$'),
    cap_usd TEXT NOT NULL CHECK (cap_usd ~ '^[0-9]{1,15}\.[0-9]{6}$'),
    utilization TEXT NOT NULL CHECK (utilization ~ '^[0-9]{1,6}\.[0-9]{6}$'),
    position_count INTEGER NOT NULL CHECK (position_count >= 0),
    -- Estimated cost of unwinding every position in this bucket, from the exit
    -- book-walk. Liquidity is depth and effective spread, never volume.
    unwind_cost_usd TEXT CHECK (unwind_cost_usd ~ '^[0-9]{1,15}\.[0-9]{6}$'),
    detail_json JSONB,
    computed_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (dimension, dimension_key)
);

-- The portfolio state machine. Single row by construction.
CREATE TABLE IF NOT EXISTS portfolio_state (
    portfolio_id INTEGER PRIMARY KEY DEFAULT 1 CHECK (portfolio_id = 1),
    state TEXT NOT NULL CHECK (state IN ('NORMAL', 'REDUCE_ONLY', 'HALTED')),
    reason TEXT,
    -- Simulated notional bankroll, from the versioned config, plus REALIZED
    -- PnL only. Unrealized marks never expand a cap: that direction is the
    -- forbidden one.
    bankroll_usd TEXT NOT NULL CHECK (bankroll_usd ~ '^-?[0-9]{1,15}\.[0-9]{6}$'),
    -- Equity (bankroll + open mark - open cost) high-water mark, which is what
    -- drawdown_max is measured against.
    high_water_mark_usd TEXT NOT NULL CHECK (high_water_mark_usd ~ '^-?[0-9]{1,15}\.[0-9]{6}$'),
    equity_usd TEXT NOT NULL CHECK (equity_usd ~ '^-?[0-9]{1,15}\.[0-9]{6}$'),
    drawdown TEXT NOT NULL CHECK (drawdown ~ '^[0-9]{1,6}\.[0-9]{6}$'),
    realized_pnl_day_usd TEXT NOT NULL CHECK (realized_pnl_day_usd ~ '^-?[0-9]{1,15}\.[0-9]{6}$'),
    realized_pnl_week_usd TEXT NOT NULL CHECK (realized_pnl_week_usd ~ '^-?[0-9]{1,15}\.[0-9]{6}$'),
    day_bucket DATE NOT NULL,
    week_start DATE NOT NULL,
    reduce_only_until TIMESTAMPTZ,
    halted_at TIMESTAMPTZ,
    -- HALTED never clears on a timer: it needs the manual resume endpoint.
    manual_halt BOOLEAN NOT NULL DEFAULT FALSE,
    config_version TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT portfolio_state_halted_has_timestamp CHECK (
        (state = 'HALTED') = (halted_at IS NOT NULL)
    ),
    CONSTRAINT portfolio_state_needs_reason CHECK (
        state = 'NORMAL' OR reason IS NOT NULL
    )
);

-- Append-only audit of every transition, including the manual ones.
CREATE TABLE IF NOT EXISTS portfolio_state_events (
    state_event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    from_state TEXT NOT NULL CHECK (
        from_state IN ('NORMAL', 'REDUCE_ONLY', 'HALTED')
    ),
    to_state TEXT NOT NULL CHECK (
        to_state IN ('NORMAL', 'REDUCE_ONLY', 'HALTED')
    ),
    reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 256),
    trigger_source TEXT NOT NULL CHECK (
        trigger_source IN ('daily_loss', 'weekly_loss', 'drawdown', 'manual',
                           'window_expired', 'boot')
    ),
    detail_json JSONB,
    at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION portfolio_state_events_guard() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'portfolio_state_events rows are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS portfolio_state_events_guard_trg ON portfolio_state_events;
CREATE TRIGGER portfolio_state_events_guard_trg
    BEFORE UPDATE OR DELETE ON portfolio_state_events
    FOR EACH ROW EXECUTE FUNCTION portfolio_state_events_guard();

-- Circuit breakers (task 4). Distinct from the RFC-012 market-level breaker:
-- these freeze NEW ENTRIES portfolio-wide or per market and force an exit
-- re-evaluation. RFC-012 stays the authoritative resolution-risk layer and is
-- consulted separately; this table records what the portfolio engine itself
-- observed.
CREATE TABLE IF NOT EXISTS portfolio_circuit_breakers (
    breaker_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind TEXT NOT NULL CHECK (
        kind IN ('UMA_PROPOSED_OR_DISPUTED', 'PRICE_JUMP_NO_CATALYST',
                 'RULE_CLARIFICATION', 'PARAM_CHANGE', 'DATA_STALENESS')
    ),
    scope TEXT NOT NULL CHECK (scope IN ('market', 'token', 'portfolio')),
    condition_id TEXT,
    token_id TEXT,
    detail_json JSONB NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT portfolio_circuit_breakers_scope_key CHECK (
        (scope = 'portfolio' AND condition_id IS NULL AND token_id IS NULL)
        OR (scope = 'market' AND condition_id IS NOT NULL)
        OR (scope = 'token' AND token_id IS NOT NULL)
    ),
    CONSTRAINT portfolio_circuit_breakers_window CHECK (
        ended_at IS NULL OR ended_at >= started_at
    )
);

CREATE INDEX IF NOT EXISTS portfolio_circuit_breakers_open_idx
    ON portfolio_circuit_breakers (kind, condition_id, token_id)
    WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS portfolio_circuit_breakers_ended_at_idx
    ON portfolio_circuit_breakers (ended_at)
    WHERE ended_at IS NOT NULL;

-- The opportunity panel (task 6), one snapshot per market per evaluation. A
-- vetoed opportunity is stored WITH its veto reason: the panel may never show
-- a vetoed market as "almost entrable" without saying why.
CREATE TABLE IF NOT EXISTS portfolio_panel_snapshots (
    snapshot_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    condition_id TEXT NOT NULL CHECK (char_length(condition_id) BETWEEN 1 AND 128),
    token_id TEXT NOT NULL CHECK (char_length(token_id) BETWEEN 1 AND 128),
    computed_at TIMESTAMPTZ NOT NULL,
    panel_json JSONB NOT NULL,
    decision_id BIGINT REFERENCES portfolio_decisions (decision_id) ON DELETE SET NULL,
    entrable BOOLEAN NOT NULL,
    vetoed BOOLEAN NOT NULL,
    veto_reason TEXT,
    config_version TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT portfolio_panel_snapshots_veto_needs_reason CHECK (
        vetoed = FALSE OR veto_reason IS NOT NULL
    ),
    CONSTRAINT portfolio_panel_snapshots_veto_not_entrable CHECK (
        vetoed = FALSE OR entrable = FALSE
    ),
    UNIQUE (token_id, computed_at)
);

CREATE INDEX IF NOT EXISTS portfolio_panel_snapshots_received_at_idx
    ON portfolio_panel_snapshots (received_at);
CREATE INDEX IF NOT EXISTS portfolio_panel_snapshots_latest_idx
    ON portfolio_panel_snapshots (token_id, computed_at DESC);

-- Continuous gate measurement (tasks 8 and 9). Never pruned: this is the
-- evidence trail behind any future RFC-009 decision. A FAIL always carries a
-- reason code (NO_EVIDENCE_OF_ALPHA or the gate's own code) and the numbers
-- that produced it, including confidence intervals.
CREATE TABLE IF NOT EXISTS portfolio_gate_measurements (
    measurement_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    gate TEXT NOT NULL CHECK (gate IN ('G1', 'G2', 'G3', 'G4', 'G5', 'G6')),
    status TEXT NOT NULL CHECK (
        status IN ('PASS', 'FAIL', 'INSUFFICIENT_DATA')
    ),
    reason_code TEXT,
    metrics_json JSONB NOT NULL,
    config_version TEXT NOT NULL,
    window_from TIMESTAMPTZ,
    window_to TIMESTAMPTZ,
    measured_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT portfolio_gate_measurements_failure_needs_reason CHECK (
        status = 'PASS' OR reason_code IS NOT NULL
    ),
    CONSTRAINT portfolio_gate_measurements_window CHECK (
        window_from IS NULL OR window_to IS NULL OR window_to >= window_from
    )
);

CREATE OR REPLACE FUNCTION portfolio_gate_measurements_guard() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'portfolio_gate_measurements rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS portfolio_gate_measurements_guard_trg ON portfolio_gate_measurements;
CREATE TRIGGER portfolio_gate_measurements_guard_trg
    BEFORE UPDATE OR DELETE ON portfolio_gate_measurements
    FOR EACH ROW EXECUTE FUNCTION portfolio_gate_measurements_guard();

CREATE INDEX IF NOT EXISTS portfolio_gate_measurements_gate_idx
    ON portfolio_gate_measurements (gate, measured_at DESC);

-- The weekly automatic report (task 8). overall_status is BLOCKED unless every
-- gate is PASS; the engine computes it and a test proves a single FAIL keeps
-- RFC-009 blocked.
CREATE TABLE IF NOT EXISTS portfolio_gate_reports (
    report_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    generated_at TIMESTAMPTZ NOT NULL,
    window_from TIMESTAMPTZ NOT NULL,
    window_to TIMESTAMPTZ NOT NULL,
    gates_json JSONB NOT NULL,
    overall_status TEXT NOT NULL CHECK (
        overall_status IN ('BLOCKED', 'READY_FOR_OWNER_REVIEW')
    ),
    -- G6 is a human act: the written record of the owner's review, or NULL.
    approval_json JSONB,
    config_version TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT portfolio_gate_reports_window CHECK (window_to >= window_from)
);

CREATE INDEX IF NOT EXISTS portfolio_gate_reports_generated_idx
    ON portfolio_gate_reports (generated_at DESC);

-- G5 (regime freshness). The G2 clock is per category and resets whenever the
-- venue's regime fingerprint changes for that category — a fee schedule, tick
-- or rule change resets the 60-day clock rather than being averaged into it.
CREATE TABLE IF NOT EXISTS portfolio_g2_clock (
    category TEXT PRIMARY KEY CHECK (char_length(category) BETWEEN 1 AND 64),
    clock_start TIMESTAMPTZ NOT NULL,
    regime_fingerprint TEXT NOT NULL CHECK (regime_fingerprint ~ '^[0-9a-f]{64}$'),
    last_reset_reason TEXT,
    last_reset_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Append-only history of the resets, so a passing G2 can always be traced to
-- the regime it was measured under.
CREATE TABLE IF NOT EXISTS portfolio_g2_clock_events (
    clock_event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category TEXT NOT NULL CHECK (char_length(category) BETWEEN 1 AND 64),
    previous_start TIMESTAMPTZ,
    new_start TIMESTAMPTZ NOT NULL,
    previous_fingerprint TEXT,
    new_fingerprint TEXT NOT NULL CHECK (new_fingerprint ~ '^[0-9a-f]{64}$'),
    reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 256),
    at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS portfolio_g2_clock_events_guard_trg ON portfolio_g2_clock_events;
CREATE TRIGGER portfolio_g2_clock_events_guard_trg
    BEFORE UPDATE OR DELETE ON portfolio_g2_clock_events
    FOR EACH ROW EXECUTE FUNCTION portfolio_state_events_guard();

-- Retention time-column indexes for the two series tables this migration adds
-- that carry a TTL (0013 established the rule: no pruned table without one).
CREATE INDEX IF NOT EXISTS portfolio_exposures_computed_at_idx
    ON portfolio_exposures (computed_at);

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
