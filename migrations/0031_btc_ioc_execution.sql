-- Inert paper IOC library. No seeds, workers, routes or changes to applied migrations.
CREATE TABLE btc_ioc_intents (
  account_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  intent JSONB NOT NULL CHECK(jsonb_typeof(intent)='object'),
  evidence_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id),
  PRIMARY KEY(account_id,order_id),
  FOREIGN KEY(account_id,order_id) REFERENCES btc_order_acceptances(account_id,order_id),
  CHECK(intent->>'schema_version' IS NOT DISTINCT FROM 'btc.ioc.v1')
);
CREATE TABLE btc_ioc_results (
  account_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  request JSONB NOT NULL CHECK(jsonb_typeof(request)='object'),
  result JSONB NOT NULL CHECK(jsonb_typeof(result)='object'),
  evidence_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id),
  PRIMARY KEY(account_id,operation_id),
  FOREIGN KEY(account_id,order_id) REFERENCES btc_ioc_intents(account_id,order_id),
  CHECK(request->>'operation_id' IS NOT DISTINCT FROM operation_id),
  CHECK(result->>'schema_version' IS NOT DISTINCT FROM 'btc.ioc.v1')
);
CREATE INDEX btc_ioc_depth ON btc_ioc_results(account_id,(result->>'book_key')) WHERE result->>'book_key' IS NOT NULL;
CREATE TRIGGER btc_ioc_intents_immutable BEFORE UPDATE OR DELETE ON btc_ioc_intents FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_ioc_intents_no_truncate BEFORE TRUNCATE ON btc_ioc_intents FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_ioc_results_immutable BEFORE UPDATE OR DELETE ON btc_ioc_results FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_ioc_results_no_truncate BEFORE TRUNCATE ON btc_ioc_results FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component,version) DO NOTHING;
