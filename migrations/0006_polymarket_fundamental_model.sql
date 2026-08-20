-- RFC-010: Polymarket fundamental model (q + uncertainty). This schema stores
-- ESTIMATES ONLY. There is no order, signal, wallet, signer or trading-auth
-- column anywhere below, and nothing here may be used to execute anything.
-- Probabilities are canonical fixed-scale decimal strings (exactly six
-- fraction digits) so that a stored estimate is byte-reproducible; they are
-- never stored as floats. Every row carries provenance.

-- Model registry. One row per trained VERSION; rows are immutable except for
-- the lifecycle columns (status, gate pointer, timestamps), enforced by the
-- trigger at the bottom of this file.
CREATE TABLE IF NOT EXISTS fundamental_models (
    model_id TEXT PRIMARY KEY CHECK (char_length(model_id) BETWEEN 1 AND 128),
    model_family TEXT NOT NULL CHECK (char_length(model_family) BETWEEN 1 AND 64),
    -- Never a universal cross-category model: exactly one category per model.
    category TEXT NOT NULL CHECK (category IN ('crypto_updown', 'macro_scheduled')),
    version TEXT NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
    git_sha TEXT NOT NULL CHECK (git_sha ~ '^[0-9a-f]{40}$'),
    feature_set_version TEXT NOT NULL CHECK (char_length(feature_set_version) BETWEEN 1 AND 64),
    hyperparams_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    seed BIGINT NOT NULL DEFAULT 0,
    train_window_start TIMESTAMPTZ,
    train_window_end TIMESTAMPTZ,
    regime_mix BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL CHECK (status IN ('shadow', 'active', 'retired')),
    last_gate_report_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    promoted_at TIMESTAMPTZ,
    demoted_at TIMESTAMPTZ,
    retired_at TIMESTAMPTZ,
    UNIQUE (model_family, version),
    CONSTRAINT fundamental_models_train_window_ordered CHECK (
        train_window_start IS NULL
        OR train_window_end IS NULL
        OR train_window_end >= train_window_start
    ),
    -- 2026-04-28 (CLOB V2 cutover) is a hard regime boundary: a training
    -- window that crosses it must declare regime_mix explicitly.
    CONSTRAINT fundamental_models_regime_boundary CHECK (
        regime_mix IS TRUE
        OR train_window_start IS NULL
        OR train_window_end IS NULL
        OR NOT (
            train_window_start < TIMESTAMPTZ '2026-04-28 00:00:00+00'
            AND train_window_end > TIMESTAMPTZ '2026-04-28 00:00:00+00'
        )
    ),
    -- A regime-mixed model is never eligible for promotion.
    CONSTRAINT fundamental_models_regime_mix_never_active CHECK (
        regime_mix IS FALSE OR status <> 'active'
    )
);

-- At most one active model per category; everything else is shadow/retired.
CREATE UNIQUE INDEX IF NOT EXISTS fundamental_models_active_uidx
    ON fundamental_models (category)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS fundamental_models_category_idx
    ON fundamental_models (category, status);

-- Gate evaluations (walk-forward + block bootstrap). Immutable audit trail:
-- a PASS here is the only thing that can unlock shadow -> active.
CREATE TABLE IF NOT EXISTS fundamental_gate_reports (
    gate_report_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_id TEXT NOT NULL REFERENCES fundamental_models (model_id),
    category TEXT NOT NULL CHECK (category IN ('crypto_updown', 'macro_scheduled')),
    verdict TEXT NOT NULL CHECK (verdict IN ('PASS', 'NO_EVIDENCE_OF_ALPHA')),
    markets_covered INTEGER NOT NULL CHECK (markets_covered >= 0),
    observations INTEGER NOT NULL CHECK (observations >= 0),
    window_from TIMESTAMPTZ NOT NULL,
    window_to TIMESTAMPTZ NOT NULL,
    -- Brier/log loss for model and baseline, deltas with 95% block-bootstrap
    -- CI, per-horizon slices, reliability bins, interval coverage.
    metrics_json JSONB NOT NULL,
    failures_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(failures_json) = 'array'),
    git_sha TEXT NOT NULL,
    feature_set_version TEXT,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS fundamental_gate_reports_model_idx
    ON fundamental_gate_reports (model_id, evaluated_at DESC);

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fundamental_models_gate_fk'
    ) THEN
        ALTER TABLE fundamental_models
            ADD CONSTRAINT fundamental_models_gate_fk
            FOREIGN KEY (last_gate_report_id)
            REFERENCES fundamental_gate_reports (gate_report_id);
    END IF;
END
$migration$;

-- The single output of RFC-010. TTL 90 days for raw rows (retention job).
CREATE TABLE IF NOT EXISTS fundamental_estimates (
    estimate_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    market_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    category TEXT NOT NULL,
    decision_ts TIMESTAMPTZ NOT NULL,
    q TEXT NOT NULL CHECK (q ~ '^[01]\.[0-9]{6}$'),
    q_lo TEXT NOT NULL CHECK (q_lo ~ '^[01]\.[0-9]{6}$'),
    q_hi TEXT NOT NULL CHECK (q_hi ~ '^[01]\.[0-9]{6}$'),
    source TEXT NOT NULL CHECK (source IN ('MODEL', 'MARKET_BASELINE')),
    -- Shadow estimates exist for gating only and are invisible to consumers.
    status TEXT NOT NULL CHECK (status IN ('shadow', 'active')),
    model_id TEXT REFERENCES fundamental_models (model_id),
    model_version TEXT,
    feature_set_version TEXT,
    git_sha TEXT,
    -- source_ts of every input window used (book, external feed, calendar).
    data_refs JSONB,
    -- Executable microprice of the same book, always recorded for comparison.
    market_prob TEXT CHECK (market_prob IS NULL OR market_prob ~ '^[01]\.[0-9]{6}$'),
    exec_spread TEXT,
    book_stale BOOLEAN NOT NULL DEFAULT FALSE,
    feed_stale BOOLEAN NOT NULL DEFAULT FALSE,
    thin_book BOOLEAN NOT NULL DEFAULT FALSE,
    rule_changed_recently BOOLEAN NOT NULL DEFAULT FALSE,
    fallback_reason TEXT,
    interval_version TEXT NOT NULL,
    microprice_version TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Fixed-scale strings of equal length compare lexicographically exactly
    -- as they compare numerically.
    CONSTRAINT fundamental_estimates_interval_ordered CHECK (q_lo <= q AND q <= q_hi),
    CONSTRAINT fundamental_estimates_model_provenance CHECK (
        source <> 'MODEL'
        OR (
            model_id IS NOT NULL
            AND model_version IS NOT NULL
            AND feature_set_version IS NOT NULL
            AND git_sha IS NOT NULL
            AND data_refs IS NOT NULL
        )
    ),
    CONSTRAINT fundamental_estimates_baseline_provenance CHECK (
        source <> 'MARKET_BASELINE'
        OR (
            model_id IS NULL
            AND model_version IS NULL
            AND fallback_reason IS NOT NULL
            AND data_refs IS NOT NULL
        )
    ),
    -- A shadow estimate always comes from a model; the baseline is never shadow.
    CONSTRAINT fundamental_estimates_shadow_is_model CHECK (
        status <> 'shadow' OR source = 'MODEL'
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS fundamental_estimates_unique_idx
    ON fundamental_estimates (token_id, decision_ts, COALESCE(model_id, ''));

CREATE INDEX IF NOT EXISTS fundamental_estimates_market_idx
    ON fundamental_estimates (market_id, decision_ts);

CREATE INDEX IF NOT EXISTS fundamental_estimates_latest_idx
    ON fundamental_estimates (token_id, decision_ts DESC);

CREATE INDEX IF NOT EXISTS fundamental_estimates_category_idx
    ON fundamental_estimates (category, decision_ts DESC);

-- Label store for resolved markets. `publicly_knowable_ts` is the instant the
-- outcome became publicly knowable and is the only timestamp honest metrics
-- may index on; `onchain_resolution_ts` (and the UMA status that comes with
-- it) arrives LATER and must never be used as a feature.
CREATE TABLE IF NOT EXISTS fundamental_labels (
    token_id TEXT PRIMARY KEY,
    condition_id TEXT NOT NULL,
    category TEXT NOT NULL,
    label TEXT NOT NULL CHECK (label IN ('0', '0.5', '1')),
    publicly_knowable_ts TIMESTAMPTZ,
    onchain_resolution_ts TIMESTAMPTZ,
    disputed BOOLEAN NOT NULL DEFAULT FALSE,
    is_final BOOLEAN NOT NULL DEFAULT FALSE,
    provenance TEXT NOT NULL CHECK (provenance IN ('resolution_events', 'gamma')),
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_ts TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS fundamental_labels_condition_idx
    ON fundamental_labels (condition_id);

CREATE INDEX IF NOT EXISTS fundamental_labels_category_idx
    ON fundamental_labels (category, publicly_knowable_ts);

-- Immutable lifecycle/audit events, including NO_EVIDENCE_OF_ALPHA.
CREATE TABLE IF NOT EXISTS fundamental_model_events (
    model_event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'registered',
        'gate_pass',
        'no_evidence_of_alpha',
        'promoted',
        'demoted',
        'revalidation_required',
        'retired'
    )),
    gate_report_id BIGINT,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS fundamental_model_events_model_idx
    ON fundamental_model_events (model_id, at DESC);

-- Daily calibration report, materialized per category (model_id NULL means the
-- baseline-only report for a category with no model).
CREATE TABLE IF NOT EXISTS fundamental_calibration_reports (
    calibration_report_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category TEXT NOT NULL,
    model_id TEXT,
    window_from TIMESTAMPTZ NOT NULL,
    window_to TIMESTAMPTZ NOT NULL,
    observations INTEGER NOT NULL CHECK (observations >= 0),
    markets_covered INTEGER NOT NULL CHECK (markets_covered >= 0),
    payload_json JSONB NOT NULL,
    git_sha TEXT,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS fundamental_calibration_reports_idx
    ON fundamental_calibration_reports (category, generated_at DESC);

-- Model versions are immutable: only the lifecycle columns may change, and a
-- row may never be deleted.
CREATE OR REPLACE FUNCTION fundamental_models_guard() RETURNS TRIGGER AS $migration$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'fundamental_models rows are immutable and cannot be deleted';
    END IF;
    IF NEW.model_id <> OLD.model_id
        OR NEW.model_family <> OLD.model_family
        OR NEW.category <> OLD.category
        OR NEW.version <> OLD.version
        OR NEW.git_sha <> OLD.git_sha
        OR NEW.feature_set_version <> OLD.feature_set_version
        OR NEW.hyperparams_json <> OLD.hyperparams_json
        OR NEW.seed <> OLD.seed
        OR NEW.regime_mix <> OLD.regime_mix
        OR NEW.created_at <> OLD.created_at
        OR NEW.train_window_start IS DISTINCT FROM OLD.train_window_start
        OR NEW.train_window_end IS DISTINCT FROM OLD.train_window_end
    THEN
        RAISE EXCEPTION 'fundamental_models identity columns are immutable';
    END IF;
    RETURN NEW;
END
$migration$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fundamental_models_guard_trg ON fundamental_models;
CREATE TRIGGER fundamental_models_guard_trg
    BEFORE UPDATE OR DELETE ON fundamental_models
    FOR EACH ROW EXECUTE FUNCTION fundamental_models_guard();

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
