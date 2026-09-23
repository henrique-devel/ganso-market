-- G2-05.1. Paper identities/ledger only; no seeds, legacy writes or activation.
CREATE TABLE btc_ledger_accounts (
  account_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL UNIQUE,
  instrument_id TEXT NOT NULL CHECK (instrument_id = 'hyperliquid:mainnet:BTC'),
  instrument_version TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'paper' CHECK(mode = 'paper'),
  status TEXT NOT NULL DEFAULT 'disabled' CHECK(status = 'disabled'),
  identity JSONB NOT NULL CHECK(jsonb_typeof(identity) = 'object'),
  UNIQUE(account_id, experiment_id, instrument_id, instrument_version),
  CHECK(identity->'account'->>'account_id' IS NOT DISTINCT FROM account_id),
  CHECK(identity->'account'->>'experiment_id' IS NOT DISTINCT FROM experiment_id),
  CHECK(identity->'experiment'->>'experiment_id' IS NOT DISTINCT FROM experiment_id),
  CHECK(identity->'account'->>'mode' IS NOT DISTINCT FROM mode),
  CHECK(identity->'experiment'->>'mode' IS NOT DISTINCT FROM mode),
  CHECK(identity->'instrument'->>'instrument_id' IS NOT DISTINCT FROM instrument_id),
  CHECK(identity->'instrument'->>'instrument_version' IS NOT DISTINCT FROM instrument_version)
);
CREATE TABLE btc_ledger_transactions (
  account_id TEXT NOT NULL REFERENCES btc_ledger_accounts(account_id),
  transaction_id TEXT NOT NULL,
  request JSONB NOT NULL CHECK(jsonb_typeof(request) = 'object'),
  PRIMARY KEY(account_id, transaction_id),
  CHECK(request->>'transaction_id' IS NOT DISTINCT FROM transaction_id)
);
CREATE TABLE btc_ledger_events (
  account_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  instrument_version TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK(sequence > 0),
  event_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  transaction_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('cash','fill','fee','funding','liquidation')),
  event JSONB NOT NULL CHECK(jsonb_typeof(event) = 'object'),
  PRIMARY KEY(account_id, sequence),
  UNIQUE(account_id, event_id),
  FOREIGN KEY(account_id, experiment_id, instrument_id, instrument_version)
    REFERENCES btc_ledger_accounts(account_id, experiment_id, instrument_id, instrument_version),
  FOREIGN KEY(account_id, transaction_id) REFERENCES btc_ledger_transactions(account_id, transaction_id),
  CHECK(event->>'account_id' IS NOT DISTINCT FROM account_id),
  CHECK(event->>'experiment_id' IS NOT DISTINCT FROM experiment_id),
  CHECK(event->>'instrument_id' IS NOT DISTINCT FROM instrument_id),
  CHECK(event->>'instrument_version' IS NOT DISTINCT FROM instrument_version),
  CHECK(event->>'sequence' IS NOT DISTINCT FROM sequence::TEXT),
  CHECK(event->>'event_id' IS NOT DISTINCT FROM event_id),
  CHECK(event->>'idempotency_key' IS NOT DISTINCT FROM idempotency_key),
  CHECK(event->>'transaction_id' IS NOT DISTINCT FROM transaction_id),
  CHECK(event->'payload'->>'event_type' IS NOT DISTINCT FROM event_type),
  CHECK(event->>'mode' IS NOT DISTINCT FROM 'paper'),
  CHECK(event->>'schema_version' IS NOT DISTINCT FROM 'trading.v1')
);
CREATE INDEX btc_ledger_transaction_events ON btc_ledger_events(account_id, transaction_id, sequence);
CREATE TABLE btc_ledger_projections (
  account_id TEXT PRIMARY KEY REFERENCES btc_ledger_accounts(account_id),
  projection JSONB NOT NULL CHECK(jsonb_typeof(projection) = 'object'),
  CHECK(projection->'scope'->>'account_id' IS NOT DISTINCT FROM account_id),
  CHECK(projection->>'schema_version' IS NOT DISTINCT FROM 'btc.ledger.v1')
);
CREATE FUNCTION btc_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'BTC_LEDGER_APPEND_ONLY';
END $$;
CREATE TRIGGER btc_ledger_accounts_immutable BEFORE UPDATE OR DELETE ON btc_ledger_accounts FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_ledger_accounts_no_truncate BEFORE TRUNCATE ON btc_ledger_accounts FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_ledger_transactions_immutable BEFORE UPDATE OR DELETE ON btc_ledger_transactions FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_ledger_transactions_no_truncate BEFORE TRUNCATE ON btc_ledger_transactions FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_ledger_events_immutable BEFORE UPDATE OR DELETE ON btc_ledger_events FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_ledger_events_no_truncate BEFORE TRUNCATE ON btc_ledger_events FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component,version) DO NOTHING;
