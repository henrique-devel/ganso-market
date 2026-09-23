-- S7 inactive paper library. Position budgets replay existing ledger; only
-- decisions/execution receipts need new durable, append-only storage.
CREATE TABLE btc_margin_results (
  account_id TEXT NOT NULL REFERENCES btc_ledger_accounts(account_id),
  operation_id TEXT NOT NULL,
  position_id TEXT NOT NULL,
  request JSONB NOT NULL,
  result JSONB NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id),
  PRIMARY KEY(account_id,operation_id),
  CHECK(result->>'schema_version' IS NOT DISTINCT FROM 'btc.margin.v1'),
  CHECK(request->>'operation_id' IS NOT DISTINCT FROM operation_id),
  CHECK(request->>'position_id' IS NOT DISTINCT FROM position_id),
  CHECK(result->>'evidence_id' IS NOT DISTINCT FROM evidence_id),
  CHECK(result->>'market_id' IS NOT DISTINCT FROM 'counterfactual:' || account_id)
);
CREATE INDEX btc_margin_depth ON btc_margin_results(account_id,(result->>'book_key'));
CREATE TRIGGER btc_margin_immutable BEFORE UPDATE OR DELETE ON btc_margin_results FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_margin_no_truncate BEFORE TRUNCATE ON btc_margin_results FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component,version) DO NOTHING;
