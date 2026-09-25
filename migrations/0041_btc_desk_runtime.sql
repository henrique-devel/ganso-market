-- Manual paper consumer liveness and durable protective exit intents. No activation.
CREATE TABLE btc_desk_runtime (
  account_id TEXT PRIMARY KEY REFERENCES btc_desk_controls(account_id),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ready BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT NOT NULL,
  capture_id TEXT
);
CREATE TABLE btc_desk_exits (
  account_id TEXT NOT NULL REFERENCES btc_desk_controls(account_id),
  position_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,position_id)
);
CREATE TRIGGER btc_desk_exits_immutable BEFORE UPDATE OR DELETE ON btc_desk_exits
FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_desk_exits_no_truncate BEFORE TRUNCATE ON btc_desk_exits
FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT(component,version) DO NOTHING;
