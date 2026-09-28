-- Future decisions share their already pinned immutable retention payload.
-- Existing rows, hashes, charges, pins and economic contracts are unchanged.
CREATE FUNCTION btc_decision_projection(payload JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT (payload - 'input_refs' #- '{signal,input_refs}') ||
    jsonb_build_object('storage_version','btc.decision-projection.v1')
$$;

CREATE FUNCTION btc_share_decision_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evidence JSONB;
BEGIN
  -- Old writers remain valid while the compatible API is rolling out.
  IF NOT (NEW.decision ? 'storage_version') THEN RETURN NEW; END IF;
  IF NEW.decision->>'storage_version' IS DISTINCT FROM 'btc.decision-projection.v1'
  THEN RAISE EXCEPTION 'BTC_DECISION_STORAGE_VERSION'; END IF;
  SELECT payload INTO evidence FROM btc_retention_objects
    WHERE object_id=NEW.evidence_id AND class='decision';
  IF evidence IS NULL OR evidence IS DISTINCT FROM (NEW.decision - 'storage_version')
    OR evidence->>'decision_id' IS DISTINCT FROM NEW.decision_id
    OR evidence->'registration'->'scope'->>'account_id' IS DISTINCT FROM NEW.account_id
    OR (evidence->>'bar_end_at')::timestamptz IS DISTINCT FROM NEW.bar_end_at
    OR NOT EXISTS(SELECT 1 FROM btc_retention_pins WHERE object_id=NEW.evidence_id)
  THEN RAISE EXCEPTION 'BTC_DECISION_EVIDENCE_MISMATCH'; END IF;
  NEW.decision := btc_decision_projection(evidence);
  RETURN NEW;
END $$;
CREATE TRIGGER btc_share_decision_evidence BEFORE INSERT ON btc_baseline_decisions
  FOR EACH ROW EXECUTE FUNCTION btc_share_decision_evidence();

-- Full economic decisions, for runtime/replay readers. The projection remains
-- available to bounded UI queries without detoasting the large input graph.
CREATE VIEW btc_baseline_decisions_full AS
SELECT d.account_id,d.bar_end_at,d.decision_id,d.decision AS projection,
  CASE WHEN d.decision->>'storage_version'='btc.decision-projection.v1'
    THEN o.payload ELSE d.decision END AS decision,d.evidence_id
FROM btc_baseline_decisions d
JOIN btc_retention_objects o ON o.object_id=d.evidence_id;

INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT(component,version) DO NOTHING;
