-- S6 inactive library: append-only observations, pending states and one settlement
-- per owner/hour. Each financial event remains in the existing immutable ledger.
CREATE TABLE btc_funding_results (
  account_id TEXT NOT NULL REFERENCES btc_ledger_accounts(account_id),
  operation_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK(sequence > 0),
  period_hour TIMESTAMPTZ NOT NULL,
  cutoff TIMESTAMPTZ,
  status TEXT NOT NULL CHECK(status IN ('pending','settled','conflict','duplicate')),
  request JSONB NOT NULL,
  result JSONB NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id),
  PRIMARY KEY(account_id,operation_id),
  UNIQUE(account_id,sequence),
  CHECK(result->>'schema_version' IS NOT DISTINCT FROM 'btc.funding.v1'),
  CHECK(result->>'status' IS NOT DISTINCT FROM status),
  CHECK(request->>'operation_id' IS NOT DISTINCT FROM operation_id),
  CHECK(status <> 'settled' OR cutoff IS NOT NULL),
  CHECK((result->>'period_hour')::TIMESTAMPTZ IS NOT DISTINCT FROM period_hour),
  CHECK((result->>'cutoff')::TIMESTAMPTZ IS NOT DISTINCT FROM cutoff),
  CHECK(cutoff IS NULL OR (cutoff >= period_hour AND cutoff < period_hour + INTERVAL '1 hour'))
);
CREATE UNIQUE INDEX btc_funding_one_settlement ON btc_funding_results(account_id,period_hour) WHERE status='settled';
CREATE INDEX btc_funding_period ON btc_funding_results(account_id,period_hour,sequence);
CREATE TRIGGER btc_funding_immutable BEFORE UPDATE OR DELETE ON btc_funding_results FOR EACH ROW EXECUTE FUNCTION btc_ledger_immutable();
CREATE TRIGGER btc_funding_no_truncate BEFORE TRUNCATE ON btc_funding_results FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
-- Serialize even direct SQL fills with settlement writers; historical entries
-- remain immutable and no new fill may change an already-settled economic cut.
CREATE FUNCTION btc_funding_fill_cutoff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM btc_ledger_accounts WHERE account_id=NEW.account_id FOR UPDATE;
  IF NEW.event_type='fill' AND EXISTS (
    SELECT 1 FROM btc_funding_results WHERE account_id=NEW.account_id
      AND status='settled' AND cutoff >= (NEW.event->>'occurred_at')::TIMESTAMPTZ
  ) THEN RAISE EXCEPTION 'BTC_LEDGER_SETTLED_FUNDING_CUTOFF'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER btc_funding_fill_cutoff BEFORE INSERT ON btc_ledger_events FOR EACH ROW EXECUTE FUNCTION btc_funding_fill_cutoff();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component,version) DO NOTHING;
