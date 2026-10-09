-- JE11 worker evidence only. No admission, qualification seed or account is created.
CREATE TABLE jev_worker_observation (
 singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton), generation BIGINT NOT NULL REFERENCES execution_worker_owners(generation),
 observed_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL
);
CREATE TABLE jev_engine_observations (
 evidence_id TEXT PRIMARY KEY REFERENCES jev_evidence_objects(object_id), owner_id TEXT NOT NULL,
 engine_version TEXT NOT NULL, engine_fingerprint TEXT NOT NULL CHECK(engine_fingerprint ~ '^[a-f0-9]{64}$'),
 start_at TIMESTAMPTZ NOT NULL,end_at TIMESTAMPTZ NOT NULL, valid BOOLEAN NOT NULL,
 streak_start_at TIMESTAMPTZ, original JSONB NOT NULL,
 CHECK(start_at<end_at AND end_at-start_at<=interval '121 seconds'),
 UNIQUE(owner_id,engine_fingerprint,end_at)
);
CREATE INDEX jev_engine_observation_latest ON jev_engine_observations(owner_id,end_at DESC);
CREATE FUNCTION jev_engine_observation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e jev_evidence_objects;
BEGIN
 SELECT * INTO STRICT e FROM jev_evidence_objects WHERE object_id=NEW.evidence_id;
 IF e.kind<>'quality' OR e.envelope->'scope'->>'owner_id' IS DISTINCT FROM NEW.owner_id
 OR e.envelope->'payload'->'original' IS DISTINCT FROM NEW.original
 OR NEW.original->>'origin' IS DISTINCT FROM 'observed_runtime'
 OR NEW.original->>'engine_fingerprint' IS DISTINCT FROM NEW.engine_fingerprint
 OR NEW.original->>'engine_version' IS DISTINCT FROM NEW.engine_version
 OR (NEW.original->>'start_at')::timestamptz IS DISTINCT FROM NEW.start_at
 OR (NEW.original->>'end_at')::timestamptz IS DISTINCT FROM NEW.end_at
 OR (NEW.original->>'valid')::boolean IS DISTINCT FROM NEW.valid
 OR (NEW.original->>'streak_start_at')::timestamptz IS DISTINCT FROM NEW.streak_start_at
 OR (NEW.valid AND ((NEW.original->>'covered_worker_ms')::bigint IS DISTINCT FROM EXTRACT(EPOCH FROM(NEW.end_at-NEW.start_at))*1000 OR (NEW.original->>'source_covered_ms')::bigint IS DISTINCT FROM EXTRACT(EPOCH FROM(NEW.end_at-NEW.start_at))*1000))
 THEN RAISE EXCEPTION 'JEV_ENGINE_OBSERVATION_CONTRACT'; END IF;
 PERFORM jev_evidence_charge(1024,FALSE);RETURN NEW;
END $$;
CREATE TRIGGER jev_engine_observation_lock BEFORE INSERT ON jev_engine_observations FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock();
CREATE TRIGGER jev_engine_observation_guard BEFORE INSERT ON jev_engine_observations FOR EACH ROW EXECUTE FUNCTION jev_engine_observation_guard();
CREATE TRIGGER jev_engine_observation_immutable BEFORE UPDATE OR DELETE ON jev_engine_observations FOR EACH ROW EXECUTE FUNCTION jev_append_only();
CREATE TRIGGER jev_engine_observation_no_truncate BEFORE TRUNCATE ON jev_engine_observations FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only();
CREATE OR REPLACE FUNCTION jev_evidence_allocated_bytes() RETURNS BIGINT LANGUAGE SQL STABLE AS $$
  SELECT pg_total_relation_size('jev_evidence_objects')+pg_total_relation_size('jev_evidence_dependencies')
    +pg_total_relation_size('jev_evidence_sources')+pg_total_relation_size('jev_evidence_pins')+pg_total_relation_size('jev_evidence_closures')
    +pg_total_relation_size('jev_cost_pools')+pg_total_relation_size('jev_decision_profile_contracts')+pg_total_relation_size('jev_decision_requests')
    +pg_total_relation_size('jev_decision_participants')+pg_total_relation_size('jev_decision_results')
    +pg_total_relation_size('jev_risk_events')+pg_total_relation_size('jev_risk_reconciliations')+pg_total_relation_size('jev_entry_events')+pg_total_relation_size('jev_pilot_events')
    +pg_total_relation_size('jev_execution_orders')+pg_total_relation_size('jev_execution_events')+pg_total_relation_size('jev_liquidity_claims')
    +pg_total_relation_size('jev_result_cuts')+pg_total_relation_size('jev_coverage_segments')+pg_total_relation_size('jev_engine_qualifications')+pg_total_relation_size('jev_evaluation_cuts')
    +pg_total_relation_size('jev_funding_receipts')+pg_total_relation_size('jev_infrastructure_events')+pg_total_relation_size('jev_operator_commands')
    +pg_total_relation_size('jev_worker_observation')+pg_total_relation_size('jev_engine_observations')
$$;
CREATE FUNCTION jev_engine_qualification_observed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p JSONB; deps TEXT[]; total_ms NUMERIC; first_at TIMESTAMPTZ; last_at TIMESTAMPTZ; bad BOOLEAN;
BEGIN
 IF NEW.engine_version='jev.scheduler.v2' AND NEW.qualified THEN
   SELECT envelope->'payload'->'original',dependencies INTO STRICT p,deps FROM jev_evidence_objects WHERE object_id=NEW.evidence_id;
   SELECT SUM(EXTRACT(EPOCH FROM(o.end_at-o.start_at))*1000),MIN(o.start_at),MAX(o.end_at),bool_or(NOT o.valid OR o.engine_fingerprint IS DISTINCT FROM p->>'engine_fingerprint' OR o.owner_id IS DISTINCT FROM NEW.owner_id)
   INTO total_ms,first_at,last_at,bad FROM jev_engine_observations o WHERE o.evidence_id=ANY(deps);
   IF NEW.end_at-NEW.start_at<interval '7 days' OR p->>'origin' IS DISTINCT FROM 'observed_runtime' OR total_ms IS NULL OR bad OR first_at IS DISTINCT FROM NEW.start_at OR last_at IS DISTINCT FROM NEW.end_at OR total_ms IS DISTINCT FROM EXTRACT(EPOCH FROM(NEW.end_at-NEW.start_at))*1000
    OR EXISTS(SELECT 1 FROM (SELECT start_at,LAG(end_at) OVER(ORDER BY start_at) AS previous_end FROM jev_engine_observations WHERE evidence_id=ANY(deps)) x WHERE previous_end IS NOT NULL AND previous_end<>start_at)
    THEN RAISE EXCEPTION 'JEV_QUALIFICATION_UNOBSERVED'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER jev_engine_qualification_observed_guard BEFORE INSERT ON jev_engine_qualifications FOR EACH ROW EXECUTE FUNCTION jev_engine_qualification_observed_guard();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT DO NOTHING;
