-- S3 library only. No account seeds, activation, legacy writes or ledger rewrite.
CREATE TABLE btc_order_acceptances (
  account_id TEXT NOT NULL REFERENCES btc_ledger_accounts(account_id),
  order_id TEXT NOT NULL,
  request JSONB NOT NULL CHECK(jsonb_typeof(request)='object'),
  accepted_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(account_id,order_id),
  CHECK(request->>'order_id' IS NOT DISTINCT FROM order_id),
  CHECK(request->>'schema_version' IS NOT DISTINCT FROM 'btc.reservations.v1')
);
CREATE TABLE btc_reservation_events (
  account_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK(sequence > 0),
  operation_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('reserve','consume','release')),
  request JSONB NOT NULL CHECK(jsonb_typeof(request)='object'),
  reservation JSONB NOT NULL CHECK(jsonb_typeof(reservation)='object'),
  ledger_transaction_id TEXT,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(account_id,sequence),
  UNIQUE(account_id,operation_id),
  FOREIGN KEY(account_id,order_id) REFERENCES btc_order_acceptances(account_id,order_id),
  FOREIGN KEY(account_id,ledger_transaction_id) REFERENCES btc_ledger_transactions(account_id,transaction_id),
  CHECK(reservation->'order'->>'order_id' IS NOT DISTINCT FROM order_id),
  CHECK(request->>'action' IS NOT DISTINCT FROM action),
  CHECK(request->>'operation_id' IS NOT DISTINCT FROM operation_id),
  CHECK((action='consume') = (ledger_transaction_id IS NOT NULL))
);
CREATE INDEX btc_reservation_order_history ON btc_reservation_events(account_id,order_id,sequence DESC);
CREATE TRIGGER btc_order_acceptances_immutable BEFORE UPDATE OR DELETE ON btc_order_acceptances FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_order_acceptances_no_truncate BEFORE TRUNCATE ON btc_order_acceptances FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_reservation_events_immutable BEFORE UPDATE OR DELETE ON btc_reservation_events FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_reservation_events_no_truncate BEFORE TRUNCATE ON btc_reservation_events FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component,version) DO NOTHING;
