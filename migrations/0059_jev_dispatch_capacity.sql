-- JE10 additive admission seam. Boot never inserts proof or admits a pair.
-- Applied migrations, financial histories and existing controls stay intact.
ALTER TABLE jev_worker_controls ADD COLUMN capacity_evidence_id TEXT
 REFERENCES btc_retention_objects(object_id);
CREATE TABLE jev_funding_receipts (
 account_id TEXT NOT NULL REFERENCES jev_accounts(account_id),
 operation_id TEXT NOT NULL,
 sequence BIGINT NOT NULL CHECK(sequence>0),
 period_hour TIMESTAMPTZ NOT NULL,
 receipt JSONB NOT NULL,
 evidence_id TEXT NOT NULL REFERENCES jev_evidence_objects(object_id),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,operation_id), UNIQUE(account_id,sequence),
 CHECK((receipt->>'period_hour')::timestamptz IS NOT DISTINCT FROM period_hour),
 CHECK(receipt->>'evidence_id' IS NOT DISTINCT FROM evidence_id),
 CHECK(receipt->>'schema_version' IS NOT DISTINCT FROM 'btc.funding.v1'),
 CHECK(receipt->>'status' IN ('pending','settled','conflict','duplicate'))
);
CREATE INDEX jev_funding_by_hour ON jev_funding_receipts(account_id,period_hour,sequence);
CREATE FUNCTION jev_funding_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior BIGINT;
BEGIN
 PERFORM 1 FROM jev_accounts WHERE account_id=NEW.account_id FOR UPDATE;
 SELECT COALESCE(MAX(sequence),0) INTO prior FROM jev_funding_receipts WHERE account_id=NEW.account_id;
 IF NEW.sequence<>prior+1 OR NOT EXISTS(SELECT 1 FROM jev_evidence_objects WHERE object_id=NEW.evidence_id AND envelope->'scope'->>'account_id'=NEW.account_id AND kind='funding' AND envelope->'payload'->'original'=NEW.receipt)
 THEN RAISE EXCEPTION 'JEV_FUNDING_RECEIPT_SCOPE_OR_SEQUENCE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER jev_funding_receipt_guard BEFORE INSERT ON jev_funding_receipts
 FOR EACH ROW EXECUTE FUNCTION jev_funding_receipt_guard();
CREATE TRIGGER jev_funding_receipts_immutable BEFORE UPDATE OR DELETE ON jev_funding_receipts
 FOR EACH ROW EXECUTE FUNCTION execution_worker_immutable();
CREATE TRIGGER jev_funding_receipts_no_truncate BEFORE TRUNCATE ON jev_funding_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION execution_worker_immutable();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT DO NOTHING;
