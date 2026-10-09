-- JE15 bounded runtime projection. No identities, activations or capital seeded.
CREATE OR REPLACE FUNCTION jev_live_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Orderly retirement is allowed only by the currently fenced process itself.
 -- All ordinary claim/renew/takeover invariants below remain unchanged.
 IF TG_OP='UPDATE' AND NEW.identity_hash=OLD.identity_hash AND NEW.process_id=OLD.process_id
 AND NEW.generation=OLD.generation AND NEW.lease_until<=clock_timestamp()
 AND EXISTS(SELECT 1 FROM execution_worker_head WHERE worker_id::text=OLD.process_id AND lease_until>clock_timestamp())
 THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'JEV_LIVE_OWNER_FENCE'; END IF;
 IF NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '10 seconds' OR NEW.process_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$' THEN RAISE EXCEPTION 'JEV_LIVE_OWNER_FENCE'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.generation<>1 THEN RAISE EXCEPTION 'JEV_LIVE_OWNER_FENCE'; END IF; RETURN NEW;
 END IF;
 IF NEW.identity_hash<>OLD.identity_hash OR NEW.generation<OLD.generation
 OR (OLD.lease_until<=clock_timestamp() AND NEW.generation=OLD.generation)
 OR NEW.generation>OLD.generation+1 OR (NEW.generation=OLD.generation AND NEW.process_id<>OLD.process_id)
 OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '10 seconds'
 THEN RAISE EXCEPTION 'JEV_LIVE_OWNER_FENCE'; END IF; RETURN NEW;
END $$;

ALTER TABLE jev_live_events DROP CONSTRAINT jev_live_events_kind_check;
ALTER TABLE jev_live_events ADD CONSTRAINT jev_live_events_kind_check
 CHECK(kind IN('snapshot','fill','funding','receipt','gap','protection','balance','metadata'));
CREATE TABLE jev_live_runtime (
 identity_hash TEXT PRIMARY KEY REFERENCES jev_live_identities(identity_hash),
 generation BIGINT NOT NULL REFERENCES execution_worker_owners(generation),
 code_sha TEXT NOT NULL CHECK(code_sha ~ '^[a-f0-9]{40}$'),
 observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 state JSONB NOT NULL CHECK(state->>'version' IS NOT DISTINCT FROM 'jev.live-runtime.v1'),
 CHECK(octet_length(state::text)<16384)
);
CREATE FUNCTION jev_live_runtime_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM execution_worker_head h JOIN execution_worker_owners o USING(generation)
 WHERE h.generation=NEW.generation AND h.worker_id=o.worker_id AND o.code_sha=NEW.code_sha
 AND h.lease_until>clock_timestamp())
 THEN RAISE EXCEPTION 'JEV_LIVE_RUNTIME_FENCED'; END IF;
 NEW.observed_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER jev_live_runtime_guard BEFORE INSERT OR UPDATE ON jev_live_runtime
 FOR EACH ROW EXECUTE FUNCTION jev_live_runtime_guard();
ALTER FUNCTION jev_evidence_allocated_bytes() RENAME TO jev_evidence_allocated_bytes_before_runtime;
CREATE FUNCTION jev_evidence_allocated_bytes() RETURNS BIGINT LANGUAGE SQL STABLE AS $$
 SELECT jev_evidence_allocated_bytes_before_runtime()+pg_total_relation_size('jev_live_runtime')
$$;
-- The larger live workload is a new engine fingerprint. It must retain the
-- observed seven-day qualification guard; old v2 evidence remains immutable.
CREATE OR REPLACE FUNCTION jev_engine_qualification_observed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p JSONB; deps TEXT[]; total_ms NUMERIC; first_at TIMESTAMPTZ; last_at TIMESTAMPTZ; bad BOOLEAN;
BEGIN
 IF NEW.engine_version IN('jev.scheduler.v2','jev.scheduler.v3') AND NEW.qualified THEN
   SELECT envelope->'payload'->'original',dependencies INTO STRICT p,deps FROM jev_evidence_objects WHERE object_id=NEW.evidence_id;
   SELECT SUM(EXTRACT(EPOCH FROM(o.end_at-o.start_at))*1000),MIN(o.start_at),MAX(o.end_at),bool_or(NOT o.valid OR o.engine_fingerprint IS DISTINCT FROM p->>'engine_fingerprint' OR o.owner_id IS DISTINCT FROM NEW.owner_id)
   INTO total_ms,first_at,last_at,bad FROM jev_engine_observations o WHERE o.evidence_id=ANY(deps);
   IF NEW.end_at-NEW.start_at<interval '7 days' OR p->>'origin' IS DISTINCT FROM 'observed_runtime' OR total_ms IS NULL OR bad OR first_at IS DISTINCT FROM NEW.start_at OR last_at IS DISTINCT FROM NEW.end_at OR total_ms IS DISTINCT FROM EXTRACT(EPOCH FROM(NEW.end_at-NEW.start_at))*1000
    OR EXISTS(SELECT 1 FROM (SELECT start_at,LAG(end_at) OVER(ORDER BY start_at) AS previous_end FROM jev_engine_observations WHERE evidence_id=ANY(deps)) x WHERE previous_end IS NOT NULL AND previous_end<>start_at)
    THEN RAISE EXCEPTION 'JEV_QUALIFICATION_UNOBSERVED'; END IF;
 END IF; RETURN NEW;
END $$;
INSERT INTO schema_versions(component,version,checksum_sha256) VALUES('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT(component,version) DO NOTHING;
