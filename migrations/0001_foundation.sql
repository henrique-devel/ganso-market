CREATE TABLE IF NOT EXISTS schema_versions (
    component TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    checksum_sha256 TEXT NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (component, version)
);

CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY CHECK (setting_key ~ '^[a-z][a-z0-9_.-]{0,127}$'),
    value_json JSONB NOT NULL,
    value_schema_version INTEGER NOT NULL CHECK (value_schema_version > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT app_settings_value_is_not_null CHECK (jsonb_typeof(value_json) IS NOT NULL)
);

COMMENT ON TABLE app_settings IS
    'Non-secret single-user settings only. Secret material is prohibited.';

CREATE TABLE IF NOT EXISTS audit_events (
    audit_event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    correlation_id TEXT NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 64),
    event_type TEXT NOT NULL CHECK (event_type ~ '^[A-Z][A-Z0-9_]{0,127}$'),
    reason_code TEXT NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
    details_json JSONB NOT NULL DEFAULT '{}'::JSONB,
    CONSTRAINT audit_events_details_is_object CHECK (jsonb_typeof(details_json) = 'object')
);

CREATE INDEX IF NOT EXISTS audit_events_occurred_at_idx
    ON audit_events (occurred_at DESC, audit_event_id DESC);

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
