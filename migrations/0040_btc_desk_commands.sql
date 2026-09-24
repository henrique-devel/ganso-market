-- G2-06.2: explicit owner binding, activation gate and durable command receipts.
-- No accounts, keys, grants or activation are seeded by a deploy.
CREATE TABLE btc_desk_controls (
  account_id TEXT PRIMARY KEY REFERENCES btc_ledger_accounts(account_id),
  owner_account_id BIGINT NOT NULL REFERENCES auth_accounts(account_id),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  broker TEXT NOT NULL CHECK (broker IN ('ioc','passive')),
  latency_ms INTEGER NOT NULL DEFAULT 250 CHECK (latency_ms BETWEEN 1 AND 60000),
  signing_key TEXT NOT NULL CHECK (signing_key ~ '^[0-9a-f]{64}$')
);
CREATE TABLE btc_desk_commands (
  account_id TEXT NOT NULL REFERENCES btc_desk_controls(account_id),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
  session_id UUID NOT NULL,
  request JSONB NOT NULL,
  result JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,idempotency_key)
);
-- Financial command receipts are append-only, including across session expiry.
CREATE TRIGGER btc_desk_commands_immutable BEFORE UPDATE OR DELETE ON btc_desk_commands
FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_desk_commands_no_truncate BEFORE TRUNCATE ON btc_desk_commands
FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
