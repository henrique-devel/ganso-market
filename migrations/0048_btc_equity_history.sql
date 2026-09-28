-- No admission seed: G2-12 capacity must be approved before sampling.
CREATE TABLE btc_equity_admissions (
  account_id TEXT PRIMARY KEY REFERENCES btc_ledger_accounts(account_id),
  start_at TIMESTAMPTZ NOT NULL CHECK (start_at > created_at),
  end_at TIMESTAMPTZ NOT NULL CHECK (end_at > start_at AND end_at <= start_at + interval '90 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  capacity_basis TEXT NOT NULL CHECK (length(capacity_basis) BETWEEN 10 AND 2000)
);
CREATE TABLE btc_equity_observations (
  account_id TEXT NOT NULL REFERENCES btc_ledger_accounts(account_id),
  slot TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL CHECK (observed_at >= slot AND observed_at < slot + interval '5 minutes'),
  evidence_id TEXT NOT NULL UNIQUE REFERENCES btc_retention_objects(object_id),
  PRIMARY KEY(account_id,slot)
);
CREATE TRIGGER btc_equity_observations_immutable BEFORE UPDATE OR DELETE ON btc_equity_observations
 FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_equity_observations_no_truncate BEFORE TRUNCATE ON btc_equity_observations
 FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT(component,version) DO NOTHING;
