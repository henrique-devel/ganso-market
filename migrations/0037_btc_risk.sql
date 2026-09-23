-- S8 inactive paper controls. Each row owns its immutable policy, anchors,
-- observed valuation and command. No accounts, consumer or runtime activation.
CREATE TABLE btc_risk_events (
  account_id TEXT NOT NULL REFERENCES btc_ledger_accounts(account_id),
  sequence BIGINT NOT NULL CHECK(sequence > 0),
  operation_id TEXT NOT NULL,
  request JSONB NOT NULL,
  checkpoint JSONB NOT NULL,
  evidence JSONB NOT NULL,
  PRIMARY KEY(account_id,sequence),
  UNIQUE(account_id,operation_id),
  CHECK(checkpoint->>'version' IS NOT DISTINCT FROM 'btc.risk.v1'),
  CHECK((checkpoint->>'state' IN ('NORMAL','REDUCE_ONLY','HALTED')) IS TRUE),
  CHECK(checkpoint ?& ARRAY['day','daily_anchor_usd_raw','high_water_usd_raw','external_cash_usd_raw','equity_usd_raw','ledger_sequence','observed_at','history_complete','reasons']),
  CHECK(request->>'operation_id' IS NOT DISTINCT FROM operation_id)
);
CREATE TRIGGER btc_risk_immutable BEFORE UPDATE OR DELETE ON btc_risk_events FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_risk_no_truncate BEFORE TRUNCATE ON btc_risk_events FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component,version) DO NOTHING;
