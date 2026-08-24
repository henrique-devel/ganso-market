-- RFC-012: resolution-risk score and logical market graph. ANALYTICS ONLY:
-- nothing here stores an order, a wallet, a signer or any trading credential —
-- these are scores, vetoes, EV buffers and consistency signals computed over
-- data the RFC-007 recorder already captured. Prices/sizes/probabilities are
-- canonical decimal strings, never floats.
--
-- Database-level invariants of the RFC:
--   * score rows and score versions are immutable (reproducibility of every
--     paper decision that referenced them);
--   * the onchain UMA event history and the derived dispute timeline are
--     append-only (the module's own dispute statistics depend on them);
--   * a curated graph edge cannot exist without author and justification.

-- The onchain collector (task 1, part 2) maps UMA Adapter events by
-- questionID; the registry captures Gamma's questionID here. Nullable and
-- backfilled as the registry re-observes each market — markets that left the
-- universe before this migration simply stay unmapped.
ALTER TABLE polymarket_markets ADD COLUMN IF NOT EXISTS question_id TEXT;

CREATE INDEX IF NOT EXISTS polymarket_markets_question_id_idx
    ON polymarket_markets (question_id)
    WHERE question_id IS NOT NULL;

-- One immutable row per score-configuration version. A weight/lexicon change
-- MUST become a new score_version (the runner refuses to boot when the same
-- version names different content); old scores stay reproducible forever.
CREATE TABLE IF NOT EXISTS resolution_score_versions (
    score_version TEXT PRIMARY KEY CHECK (char_length(score_version) BETWEEN 1 AND 64),
    config_hash TEXT NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
    lexicon_hash TEXT NOT NULL CHECK (lexicon_hash ~ '^[0-9a-f]{64}$'),
    weights_json JSONB NOT NULL CHECK (jsonb_typeof(weights_json) = 'object'),
    thresholds_json JSONB NOT NULL CHECK (jsonb_typeof(thresholds_json) = 'object'),
    priors_json JSONB NOT NULL CHECK (jsonb_typeof(priors_json) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION resolution_score_versions_guard() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'resolution_score_versions rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS resolution_score_versions_guard_trg ON resolution_score_versions;
CREATE TRIGGER resolution_score_versions_guard_trg
    BEFORE UPDATE OR DELETE ON resolution_score_versions
    FOR EACH ROW EXECUTE FUNCTION resolution_score_versions_guard();

-- Append-only score series: one row per recomputation, with the full feature
-- decomposition. The score R is in [0, 1] at fixed six-digit scale.
CREATE TABLE IF NOT EXISTS resolution_scores (
    score_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    condition_id TEXT NOT NULL CHECK (char_length(condition_id) BETWEEN 1 AND 128),
    score_version TEXT NOT NULL,
    rule_version INTEGER CHECK (rule_version > 0),
    score TEXT NOT NULL CHECK (score ~ '^[01]\.[0-9]{6}$'),
    action TEXT NOT NULL CHECK (action IN ('NONE', 'BUFFER', 'VETO', 'CIRCUIT_BREAKER')),
    -- Price-independent buffer component per share (the price-dependent 50/50
    -- tail is evaluated at decision time against the executable price).
    resolution_buffer TEXT CHECK (resolution_buffer ~ '^[01]\.[0-9]{6}$'),
    p_5050 TEXT CHECK (p_5050 ~ '^[01]\.[0-9]{6}$'),
    expected_lockup_s BIGINT CHECK (expected_lockup_s >= 0),
    p95_lockup_s BIGINT CHECK (p95_lockup_s >= 0),
    prior_kind TEXT NOT NULL CHECK (prior_kind IN ('external', 'measured')),
    features_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(features_json) = 'object'),
    hard_flags_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(hard_flags_json) = 'array'),
    justification TEXT,
    trigger TEXT NOT NULL CHECK (trigger IN ('rule_change', 'status_change', 'sweep', 'boot', 'backtest')),
    computed_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS resolution_scores_condition_idx
    ON resolution_scores (condition_id, computed_at DESC);

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'resolution_scores_version_fk'
    ) THEN
        ALTER TABLE resolution_scores
            ADD CONSTRAINT resolution_scores_version_fk
            FOREIGN KEY (score_version)
            REFERENCES resolution_score_versions (score_version);
    END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION resolution_scores_guard() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'resolution_scores rows are immutable (append-only series)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS resolution_scores_guard_trg ON resolution_scores;
CREATE TRIGGER resolution_scores_guard_trg
    BEFORE UPDATE OR DELETE ON resolution_scores
    FOR EACH ROW EXECUTE FUNCTION resolution_scores_guard();

-- Current state per market (cache of the latest score row plus the group
-- coupling): the row the paper broker's enforcement gate consults.
CREATE TABLE IF NOT EXISTS resolution_market_state (
    condition_id TEXT PRIMARY KEY CHECK (char_length(condition_id) BETWEEN 1 AND 128),
    score_id BIGINT,
    score TEXT CHECK (score ~ '^[01]\.[0-9]{6}$'),
    score_version TEXT,
    action TEXT NOT NULL CHECK (action IN ('NONE', 'BUFFER', 'VETO', 'CIRCUIT_BREAKER')),
    -- Worst of the market's own action and its event group's (negRisk groups
    -- freeze together; the group also inherits the worst score for caps).
    effective_action TEXT NOT NULL CHECK (effective_action IN ('NONE', 'BUFFER', 'VETO', 'CIRCUIT_BREAKER')),
    resolution_buffer TEXT CHECK (resolution_buffer ~ '^[01]\.[0-9]{6}$'),
    p_5050 TEXT CHECK (p_5050 ~ '^[01]\.[0-9]{6}$'),
    expected_lockup_s BIGINT CHECK (expected_lockup_s >= 0),
    p95_lockup_s BIGINT CHECK (p95_lockup_s >= 0),
    dispute_active BOOLEAN NOT NULL DEFAULT FALSE,
    suspect_jump BOOLEAN NOT NULL DEFAULT FALSE,
    hard_flags_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(hard_flags_json) = 'array'),
    event_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(event_ids_json) = 'array'),
    group_worst_score TEXT CHECK (group_worst_score ~ '^[01]\.[0-9]{6}$'),
    justification TEXT,
    prior_kind TEXT CHECK (prior_kind IN ('external', 'measured')),
    computed_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Clarification classification over the RFC-007 rule_change events: material
-- vs cosmetic diff of the rule text, one immutable row per new rule version.
CREATE TABLE IF NOT EXISTS resolution_clarifications (
    clarification_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    condition_id TEXT NOT NULL CHECK (char_length(condition_id) BETWEEN 1 AND 128),
    rule_version INTEGER NOT NULL CHECK (rule_version > 1),
    classification TEXT NOT NULL CHECK (classification IN ('material', 'cosmetic')),
    changed_fields_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(changed_fields_json) = 'array'),
    detail_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail_json) = 'object'),
    -- The clarification instant is the new rule version's valid_from.
    valid_from TIMESTAMPTZ NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT resolution_clarifications_dedupe UNIQUE (condition_id, rule_version)
);

CREATE OR REPLACE FUNCTION resolution_clarifications_guard() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'resolution_clarifications rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS resolution_clarifications_guard_trg ON resolution_clarifications;
CREATE TRIGGER resolution_clarifications_guard_trg
    BEFORE UPDATE OR DELETE ON resolution_clarifications
    FOR EACH ROW EXECUTE FUNCTION resolution_clarifications_guard();

-- Derived UMA request timeline (task 1): proposed -> (disputed -> reset) ->
-- (disputed -> DVM) -> settled, at most 2 requests, results P1..P4. Rows come
-- from the Gamma status timeline (v1) and the onchain UMA Adapter events
-- (part 2); replays and out-of-order deliveries are absorbed by the dedupe
-- constraint, never by mutating an existing row.
CREATE TABLE IF NOT EXISTS resolution_uma_timeline (
    timeline_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    condition_id TEXT NOT NULL CHECK (char_length(condition_id) BETWEEN 1 AND 128),
    question_id TEXT,
    request_index INTEGER NOT NULL CHECK (request_index IN (1, 2)),
    state TEXT NOT NULL CHECK (
        state IN ('proposed', 'disputed', 'reset', 'dvm', 'settled', 'flagged', 'paused', 'unpaused')
    ),
    result TEXT CHECK (result IN ('P1', 'P2', 'P3', 'P4')),
    payouts_json JSONB CHECK (payouts_json IS NULL OR jsonb_typeof(payouts_json) = 'array'),
    bond TEXT,
    custom_liveness TEXT,
    source TEXT NOT NULL CHECK (source IN ('gamma', 'onchain')),
    source_ref TEXT,
    occurred_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT resolution_uma_timeline_dedupe
        UNIQUE (condition_id, source, request_index, state, occurred_at)
);

CREATE INDEX IF NOT EXISTS resolution_uma_timeline_condition_idx
    ON resolution_uma_timeline (condition_id, occurred_at);

CREATE OR REPLACE FUNCTION resolution_uma_timeline_guard() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'resolution_uma_timeline rows are immutable (append-only timeline)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS resolution_uma_timeline_guard_trg ON resolution_uma_timeline;
CREATE TRIGGER resolution_uma_timeline_guard_trg
    BEFORE UPDATE OR DELETE ON resolution_uma_timeline
    FOR EACH ROW EXECUTE FUNCTION resolution_uma_timeline_guard();

-- Raw UMA Adapter events read from the public Polygon RPC (task 1, part 2).
-- Event names verified against Polymarket/uma-ctf-adapter (v2.0.0 and main):
-- the two deployed adapters share the lifecycle signatures; V2 emits
-- QuestionEmergencyResolved where V3 emits QuestionManuallyResolved.
CREATE TABLE IF NOT EXISTS resolution_onchain_events (
    onchain_event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    adapter_address TEXT NOT NULL CHECK (adapter_address ~ '^0x[0-9a-f]{40}$'),
    event_name TEXT NOT NULL CHECK (
        event_name IN (
            'QuestionInitialized', 'QuestionPaused', 'QuestionUnpaused',
            'QuestionFlagged', 'QuestionUnflagged', 'QuestionReset',
            'QuestionResolved', 'QuestionEmergencyResolved', 'QuestionManuallyResolved'
        )
    ),
    question_id TEXT NOT NULL CHECK (question_id ~ '^0x[0-9a-f]{64}$'),
    args_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(args_json) = 'object'),
    block_number BIGINT NOT NULL CHECK (block_number >= 0),
    block_ts TIMESTAMPTZ,
    tx_hash TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
    log_index INTEGER NOT NULL CHECK (log_index >= 0),
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT resolution_onchain_events_dedupe UNIQUE (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS resolution_onchain_events_question_idx
    ON resolution_onchain_events (question_id, block_number);

CREATE OR REPLACE FUNCTION resolution_onchain_events_guard() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'resolution_onchain_events rows are immutable (append-only log)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS resolution_onchain_events_guard_trg ON resolution_onchain_events;
CREATE TRIGGER resolution_onchain_events_guard_trg
    BEFORE UPDATE OR DELETE ON resolution_onchain_events
    FOR EACH ROW EXECUTE FUNCTION resolution_onchain_events_guard();

-- Collector cursor: last block scanned per adapter (restart resumes here).
CREATE TABLE IF NOT EXISTS resolution_onchain_cursor (
    adapter_address TEXT PRIMARY KEY CHECK (adapter_address ~ '^0x[0-9a-f]{40}$'),
    last_block BIGINT NOT NULL CHECK (last_block >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Adjudication premium series (task 7): once the outcome is publicly proposed,
-- the executable price's distance to 0/1 is the market-implied adjudication
-- risk. Sampled while the market sits in the settlement window.
CREATE TABLE IF NOT EXISTS resolution_adjudication_samples (
    sample_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    condition_id TEXT NOT NULL CHECK (char_length(condition_id) BETWEEN 1 AND 128),
    token_id TEXT NOT NULL CHECK (char_length(token_id) BETWEEN 1 AND 128),
    exec_bid TEXT,
    exec_ask TEXT,
    premium TEXT NOT NULL CHECK (premium ~ '^[01]\.[0-9]{6}$'),
    proposed_at TIMESTAMPTZ,
    sampled_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT resolution_adjudication_dedupe UNIQUE (token_id, sampled_at)
);

CREATE INDEX IF NOT EXISTS resolution_adjudication_condition_idx
    ON resolution_adjudication_samples (condition_id, sampled_at);

-- Logical market graph (Escopo B). Pair edges (IMPLIES/EQUIV/LADDER) name the
-- two markets; group edges (MUTEX/NEGRISK) name the Gamma event or carry an
-- explicit member list. A curated edge always records author + justification.
CREATE TABLE IF NOT EXISTS graph_edges (
    edge_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    edge_key TEXT NOT NULL CHECK (char_length(edge_key) BETWEEN 1 AND 512),
    kind TEXT NOT NULL CHECK (kind IN ('MUTEX', 'IMPLIES', 'EQUIV', 'LADDER', 'NEGRISK')),
    from_condition_id TEXT,
    to_condition_id TEXT,
    event_id TEXT,
    members_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(members_json) = 'array'),
    origin TEXT NOT NULL CHECK (origin IN ('structural', 'curated')),
    confidence TEXT NOT NULL CHECK (confidence ~ '^[01]\.[0-9]{6}$'),
    author TEXT,
    justification TEXT,
    params_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params_json) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT graph_edges_key_unique UNIQUE (edge_key),
    CONSTRAINT graph_edges_curated_needs_author CHECK (
        origin <> 'curated' OR (author IS NOT NULL AND justification IS NOT NULL)
    ),
    CONSTRAINT graph_edges_pair_or_group CHECK (
        (
            kind IN ('MUTEX', 'NEGRISK')
            AND (event_id IS NOT NULL OR jsonb_array_length(members_json) > 0)
        )
        OR (
            kind IN ('IMPLIES', 'EQUIV', 'LADDER')
            AND from_condition_id IS NOT NULL
            AND to_condition_id IS NOT NULL
        )
    )
);

-- Violations: stateful records opened when a check stays beyond the cost band
-- for k consecutive evaluations, closed when the book returns inside it.
-- Magnitude is net of costs; executable size comes from a book-walk over the
-- recorded depth (never the theoretical size).
CREATE TABLE IF NOT EXISTS graph_violations (
    violation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    edge_id BIGINT NOT NULL,
    edge_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('MUTEX', 'IMPLIES', 'EQUIV', 'LADDER', 'NEGRISK')),
    started_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    snapshots_count INTEGER NOT NULL DEFAULT 1 CHECK (snapshots_count > 0),
    magnitude_net TEXT,
    magnitude_bps TEXT,
    executable_size TEXT,
    executable_notional_usd TEXT,
    tolerance TEXT NOT NULL,
    -- Task 15: a "violation" on a node under VETO/CIRCUIT_BREAKER reflects
    -- adjudication risk, not logical mispricing — recorded but never a signal.
    suppressed BOOLEAN NOT NULL DEFAULT FALSE,
    signal_emitted BOOLEAN NOT NULL DEFAULT FALSE,
    details_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details_json) = 'object'),
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS graph_violations_active_idx
    ON graph_violations (edge_key)
    WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS graph_violations_started_idx
    ON graph_violations (started_at);

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'graph_violations_edge_fk'
    ) THEN
        ALTER TABLE graph_violations
            ADD CONSTRAINT graph_violations_edge_fk
            FOREIGN KEY (edge_id) REFERENCES graph_edges (edge_id);
    END IF;
END
$migration$;

-- Sanity vetoes over the fundamental model (task 14): the estimate q violated
-- a graph constraint against the neighbours' executable prices; the
-- model-dependent signal is blocked and the market baseline stands.
CREATE TABLE IF NOT EXISTS graph_sanity_vetoes (
    veto_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    condition_id TEXT NOT NULL CHECK (char_length(condition_id) BETWEEN 1 AND 128),
    token_id TEXT NOT NULL CHECK (char_length(token_id) BETWEEN 1 AND 128),
    model_id TEXT,
    estimate_status TEXT CHECK (estimate_status IN ('shadow', 'active')),
    q TEXT NOT NULL CHECK (q ~ '^[01]\.[0-9]{6}$'),
    edge_id BIGINT,
    edge_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('MUTEX', 'IMPLIES', 'EQUIV', 'LADDER', 'NEGRISK')),
    neighbor_condition_id TEXT,
    neighbor_price TEXT,
    tolerance TEXT NOT NULL,
    magnitude TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    details_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details_json) = 'object'),
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS graph_sanity_vetoes_active_idx
    ON graph_sanity_vetoes (token_id)
    WHERE ended_at IS NULL;

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'graph_sanity_vetoes_edge_fk'
    ) THEN
        ALTER TABLE graph_sanity_vetoes
            ADD CONSTRAINT graph_sanity_vetoes_edge_fk
            FOREIGN KEY (edge_id) REFERENCES graph_edges (edge_id);
    END IF;
END
$migration$;

-- Divergence between the two circuit-breaker layers (owner decision 4,
-- 2026-08-24): this module's state is authoritative, the RFC-011 dispute
-- trigger stays as independent redundancy, and every disagreement — in either
-- direction — is recorded and exposed, never silently reconciled.
CREATE TABLE IF NOT EXISTS resolution_layer_divergences (
    divergence_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    condition_id TEXT NOT NULL CHECK (char_length(condition_id) BETWEEN 1 AND 128),
    direction TEXT NOT NULL CHECK (direction IN ('rfc012_only', 'rfc011_only')),
    rfc012_action TEXT NOT NULL,
    rfc011_frozen BOOLEAN NOT NULL,
    position_held BOOLEAN NOT NULL DEFAULT FALSE,
    started_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    details_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details_json) = 'object'),
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS resolution_layer_divergences_active_idx
    ON resolution_layer_divergences (condition_id)
    WHERE ended_at IS NULL;

-- Own-measurement reports (dispute rate per category, P1..P4 distribution,
-- 50/50 frequency, observed lockup, veto backtest) — statistics that exist
-- nowhere else; every report declares its real sample size.
CREATE TABLE IF NOT EXISTS resolution_reports (
    report_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    data_from TIMESTAMPTZ,
    data_to TIMESTAMPTZ,
    categories_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(categories_json) = 'array'),
    backtest_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(backtest_json) = 'object'),
    score_version TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
