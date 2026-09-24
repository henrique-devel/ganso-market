-- S9 paper recovery only. No seeds, runtime activation or historical rewrites.
CREATE TABLE btc_recovery_owners (
  account_id TEXT NOT NULL REFERENCES btc_ledger_accounts(account_id),
  generation BIGINT NOT NULL CHECK(generation > 0),
  worker_id UUID NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,generation),
  UNIQUE(account_id,worker_id),
  UNIQUE(account_id,generation,worker_id)
);
CREATE TABLE btc_recovery_heads (
  account_id TEXT PRIMARY KEY REFERENCES btc_ledger_accounts(account_id),
  generation BIGINT NOT NULL,
  worker_id UUID NOT NULL,
  lease_until TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','blocked')),
  reason TEXT,
  FOREIGN KEY(account_id,generation,worker_id) REFERENCES btc_recovery_owners(account_id,generation,worker_id)
);
CREATE TABLE btc_recovery_checkpoints (
  account_id TEXT NOT NULL REFERENCES btc_ledger_accounts(account_id),
  sequence BIGINT NOT NULL CHECK(sequence > 0),
  generation BIGINT NOT NULL,
  version TEXT NOT NULL CHECK(version='btc.recovery.v1'),
  digest TEXT NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
  cursors JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,sequence),
  FOREIGN KEY(account_id,generation) REFERENCES btc_recovery_owners(account_id,generation)
);
CREATE TRIGGER btc_recovery_owners_immutable BEFORE UPDATE OR DELETE ON btc_recovery_owners FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_recovery_owners_no_truncate BEFORE TRUNCATE ON btc_recovery_owners FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_recovery_checkpoints_immutable BEFORE UPDATE OR DELETE ON btc_recovery_checkpoints FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_recovery_checkpoints_no_truncate BEFORE TRUNCATE ON btc_recovery_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component,version) DO NOTHING;
