-- Internal, inactive paper model. Immutable receipts, queue history and exclusive
-- whole-trade budgets per account; existing ledger/reservation ownership is reused.
CREATE TABLE btc_passive_results (
  account_id TEXT NOT NULL REFERENCES btc_ledger_accounts(account_id),
  operation_id TEXT NOT NULL,
  request JSONB NOT NULL,
  result JSONB NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id),
  PRIMARY KEY(account_id,operation_id),
  CHECK(request->>'operation_id' IS NOT DISTINCT FROM operation_id),
  CHECK(result->>'schema_version' IS NOT DISTINCT FROM 'btc.passive.v1')
);
CREATE TABLE btc_passive_events (
  account_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK(sequence > 0),
  operation_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  state JSONB NOT NULL CHECK(jsonb_typeof(state)='object'),
  evidence_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id),
  PRIMARY KEY(account_id,sequence),
  UNIQUE(account_id,operation_id,order_id),
  FOREIGN KEY(account_id,order_id) REFERENCES btc_order_acceptances(account_id,order_id),
  FOREIGN KEY(account_id,operation_id) REFERENCES btc_passive_results(account_id,operation_id),
  CHECK(state->'reservation'->'order'->>'order_id' IS NOT DISTINCT FROM order_id),
  CHECK(state->'intent'->>'schema_version' IS NOT DISTINCT FROM 'btc.passive.v1')
);
CREATE INDEX btc_passive_order_head ON btc_passive_events(account_id,order_id,sequence DESC);
CREATE TABLE btc_passive_trades (
  account_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  source_at TIMESTAMPTZ NOT NULL,
  venue_trade_id TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id),
  operation_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id),
  PRIMARY KEY(account_id,instrument_id,source_at,venue_trade_id),
  FOREIGN KEY(account_id,operation_id) REFERENCES btc_passive_results(account_id,operation_id)
);
CREATE TRIGGER btc_passive_results_immutable BEFORE UPDATE OR DELETE ON btc_passive_results FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_passive_results_no_truncate BEFORE TRUNCATE ON btc_passive_results FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_passive_events_immutable BEFORE UPDATE OR DELETE ON btc_passive_events FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_passive_events_no_truncate BEFORE TRUNCATE ON btc_passive_events FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_passive_trades_immutable BEFORE UPDATE OR DELETE ON btc_passive_trades FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_passive_trades_no_truncate BEFORE TRUNCATE ON btc_passive_trades FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component,version) DO NOTHING;
