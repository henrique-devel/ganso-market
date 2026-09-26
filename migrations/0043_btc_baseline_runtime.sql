-- Explicit prospective activation only; no seeds or changes to existing owners.
CREATE TABLE btc_baseline_registrations (
  account_id TEXT PRIMARY KEY REFERENCES btc_desk_controls(account_id),
  registration JSONB NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id)
);
CREATE TABLE btc_baseline_decisions (
  account_id TEXT NOT NULL REFERENCES btc_baseline_registrations(account_id),
  bar_end_at TIMESTAMPTZ NOT NULL,
  decision_id TEXT NOT NULL UNIQUE,
  decision JSONB NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id),
  PRIMARY KEY(account_id,bar_end_at)
);
CREATE TABLE btc_baseline_events (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES btc_baseline_registrations(account_id),
  event_key TEXT NOT NULL,
  position_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('admission','execution','position','exit_plan')),
  payload JSONB NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id),
  UNIQUE(account_id,event_key)
);
CREATE INDEX btc_baseline_position_events ON btc_baseline_events(account_id,position_id,kind,sequence DESC);
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['btc_baseline_registrations','btc_baseline_decisions','btc_baseline_events'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable()',t||'_immutable',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable()',t||'_no_truncate',t);
  END LOOP;
END $$;
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT(component,version) DO NOTHING;
