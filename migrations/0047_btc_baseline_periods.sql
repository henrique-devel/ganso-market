-- Prospective continuation; no seed, account, genesis or historical rewrite.
CREATE TABLE btc_baseline_periods (
  account_id TEXT NOT NULL REFERENCES btc_baseline_registrations(account_id),
  operation_id TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL CHECK (end_at = start_at + interval '30 days'),
  period JSONB NOT NULL,
  request JSONB NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id),
  PRIMARY KEY(account_id, operation_id),
  UNIQUE(account_id, start_at)
);
CREATE TRIGGER btc_baseline_periods_immutable BEFORE UPDATE OR DELETE ON btc_baseline_periods
  FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_baseline_periods_no_truncate BEFORE TRUNCATE ON btc_baseline_periods
  FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT(component,version) DO NOTHING;
