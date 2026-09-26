-- Additive request ownership. No account/genesis, budget, credential or activation.
CREATE TABLE btc_jev_challenger_requests (
  account_id TEXT NOT NULL,
  bar_end_at TIMESTAMPTZ NOT NULL,
  decision_id TEXT NOT NULL UNIQUE REFERENCES btc_baseline_decisions(decision_id),
  evidence_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id),
  request_id TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK(origin IN ('real','mock')),
  model TEXT NOT NULL,
  request JSONB NOT NULL,
  fence JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','dispatching','final')),
  outcome JSONB,
  PRIMARY KEY(account_id,bar_end_at),
  FOREIGN KEY(account_id,bar_end_at) REFERENCES btc_baseline_decisions(account_id,bar_end_at),
  CHECK ((state='final')=(outcome IS NOT NULL))
);
CREATE FUNCTION btc_jev_challenger_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'JEV_CHALLENGER_IMMUTABLE'; END IF;
  IF OLD.state='final' OR
    (OLD.state='prepared' AND NEW.state<>'dispatching') OR
    (OLD.state='dispatching' AND NEW.state<>'final') OR
    (to_jsonb(NEW)-'state'-'outcome') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'outcome')
    THEN RAISE EXCEPTION 'JEV_CHALLENGER_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER btc_jev_challenger_guard BEFORE UPDATE OR DELETE ON btc_jev_challenger_requests FOR EACH ROW EXECUTE FUNCTION btc_jev_challenger_guard();
CREATE TRIGGER btc_jev_challenger_no_truncate BEFORE TRUNCATE ON btc_jev_challenger_requests FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT(component,version) DO NOTHING;
