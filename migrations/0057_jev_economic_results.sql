-- JE08: immutable, inactive reference trajectories and economic cuts. No seeds.
CREATE TABLE jev_result_cuts (
  evidence_id TEXT PRIMARY KEY REFERENCES jev_evidence_objects(object_id) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL, account_id TEXT NOT NULL, mode TEXT NOT NULL,
  profile_id TEXT NOT NULL, profile_version TEXT NOT NULL, experiment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('metrics','benchmark')),
  sequence BIGINT NOT NULL CHECK(sequence>0), operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  parent_id TEXT REFERENCES jev_result_cuts(evidence_id) ON DELETE RESTRICT,
  as_of TIMESTAMPTZ NOT NULL,
  UNIQUE(account_id,kind,sequence), UNIQUE(account_id,kind,operation_id),
  FOREIGN KEY(owner_id,account_id,mode,profile_id,profile_version,experiment_id)
    REFERENCES jev_bindings(owner_id,account_id,mode,profile_id,profile_version,experiment_id),
  CHECK(mode IN ('paper','stress'))
);
CREATE INDEX jev_result_window ON jev_result_cuts(account_id,kind,as_of);
CREATE FUNCTION jev_result_cut_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e jev_evidence_objects; previous jev_result_cuts;
BEGIN
  SELECT * INTO STRICT e FROM jev_evidence_objects WHERE object_id=NEW.evidence_id;
  SELECT * INTO previous FROM jev_result_cuts WHERE account_id=NEW.account_id AND kind=NEW.kind ORDER BY sequence DESC LIMIT 1;
  IF e.kind<>'result' OR e.experiment_id<>NEW.experiment_id
    OR e.envelope->'scope'->>'owner_id' IS DISTINCT FROM NEW.owner_id
    OR e.envelope->'scope'->>'account_id' IS DISTINCT FROM NEW.account_id
    OR e.envelope->'scope'->>'mode' IS DISTINCT FROM NEW.mode
    OR e.envelope->'scope'->>'profile_id' IS DISTINCT FROM NEW.profile_id
    OR e.envelope->'scope'->>'profile_version' IS DISTINCT FROM NEW.profile_version
    OR e.recorded_at IS DISTINCT FROM NEW.as_of
    OR NEW.sequence<>COALESCE(previous.sequence,0)+1
    OR (previous.as_of IS NOT NULL AND NEW.as_of<previous.as_of)
    OR (NEW.kind='benchmark' AND NEW.parent_id IS DISTINCT FROM previous.evidence_id)
    OR (NEW.kind='metrics' AND NEW.parent_id IS NOT NULL)
    OR (NEW.kind='benchmark' AND e.envelope->'payload'->'original'->>'parent_id' IS DISTINCT FROM NEW.parent_id)
    THEN RAISE EXCEPTION 'JEV_RESULT_CUT_CONTRACT'; END IF;
  PERFORM jev_evidence_charge(1024,FALSE);
  RETURN NEW;
END $$;
CREATE TRIGGER jev_result_lock BEFORE INSERT ON jev_result_cuts FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock();
CREATE TRIGGER jev_result_guard BEFORE INSERT ON jev_result_cuts FOR EACH ROW EXECUTE FUNCTION jev_result_cut_guard();
CREATE TRIGGER jev_result_immutable BEFORE UPDATE OR DELETE ON jev_result_cuts FOR EACH ROW EXECUTE FUNCTION jev_append_only();
CREATE TRIGGER jev_result_no_truncate BEFORE TRUNCATE ON jev_result_cuts FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only();
CREATE OR REPLACE FUNCTION jev_evidence_allocated_bytes() RETURNS BIGINT LANGUAGE SQL STABLE AS $$
  SELECT pg_total_relation_size('jev_evidence_objects')+pg_total_relation_size('jev_evidence_dependencies')
    +pg_total_relation_size('jev_evidence_sources')+pg_total_relation_size('jev_evidence_pins')+pg_total_relation_size('jev_evidence_closures')
    +pg_total_relation_size('jev_cost_pools')+pg_total_relation_size('jev_decision_profile_contracts')+pg_total_relation_size('jev_decision_requests')
    +pg_total_relation_size('jev_decision_participants')+pg_total_relation_size('jev_decision_results')
    +pg_total_relation_size('jev_risk_events')+pg_total_relation_size('jev_risk_reconciliations')+pg_total_relation_size('jev_entry_events')+pg_total_relation_size('jev_pilot_events')
    +pg_total_relation_size('jev_execution_orders')+pg_total_relation_size('jev_execution_events')+pg_total_relation_size('jev_liquidity_claims')
    +pg_total_relation_size('jev_result_cuts')
$$;
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT(component,version) DO NOTHING;
