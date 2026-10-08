-- JE09: no admission, qualification, history or seeds are manufactured.
CREATE TABLE jev_coverage_segments (
  evidence_id TEXT PRIMARY KEY REFERENCES jev_evidence_objects(object_id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES jev_accounts(account_id),
  start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ NOT NULL,
  covered_ms BIGINT NOT NULL CHECK(covered_ms>=0),
  CHECK(start_at<end_at AND end_at-start_at<=interval '60 seconds'),
  CHECK(covered_ms<=EXTRACT(EPOCH FROM(end_at-start_at))*1000),
  UNIQUE(account_id,end_at)
);
CREATE INDEX jev_coverage_window ON jev_coverage_segments(account_id,start_at,end_at);
CREATE TABLE jev_engine_qualifications (
  evidence_id TEXT PRIMARY KEY REFERENCES jev_evidence_objects(object_id) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL, engine_version TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ NOT NULL,
  qualified BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK(start_at<end_at), CHECK(NOT qualified OR end_at-start_at>=interval '7 days')
);
CREATE INDEX jev_engine_qualification_lookup ON jev_engine_qualifications(owner_id,engine_version,end_at DESC);
CREATE TABLE jev_evaluation_cuts (
  evidence_id TEXT PRIMARY KEY REFERENCES jev_evidence_objects(object_id) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL, profile_id TEXT NOT NULL, profile_version TEXT NOT NULL,
  as_of TIMESTAMPTZ NOT NULL, phase TEXT NOT NULL CHECK(phase IN('initial','preview30','rolling90')),
  state TEXT NOT NULL CHECK(state IN('validating','eligible','inconclusive','failed')),
  FOREIGN KEY(owner_id,profile_id,profile_version) REFERENCES jev_profiles(owner_id,profile_id,profile_version),
  UNIQUE(owner_id,profile_id,profile_version,phase,as_of)
);
CREATE INDEX jev_evaluation_latest ON jev_evaluation_cuts(owner_id,profile_id,profile_version,as_of DESC);
CREATE FUNCTION jev_evaluation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e jev_evidence_objects; p JSONB; previous_end TIMESTAMPTZ;
BEGIN
  SELECT * INTO STRICT e FROM jev_evidence_objects WHERE object_id=NEW.evidence_id;
  p:=e.envelope->'payload'->'original';
  IF TG_TABLE_NAME='jev_coverage_segments' THEN
    SELECT MAX(end_at) INTO previous_end FROM jev_coverage_segments WHERE account_id=NEW.account_id;
    IF e.kind<>'quality' OR e.envelope->'scope'->>'account_id' IS DISTINCT FROM NEW.account_id
      OR (p->'window'->>'start_at')::timestamptz IS DISTINCT FROM NEW.start_at
      OR (p->'window'->>'end_at')::timestamptz IS DISTINCT FROM NEW.end_at
      OR (p->>'covered_ms')::bigint IS DISTINCT FROM NEW.covered_ms
      OR (p->>'denominator_ms')::bigint IS DISTINCT FROM EXTRACT(EPOCH FROM(NEW.end_at-NEW.start_at))*1000
      OR (SELECT COALESCE(SUM((v->>1)::bigint-(v->>0)::bigint),0) FROM jsonb_array_elements(p->'valid_intervals') v) IS DISTINCT FROM NEW.covered_ms
      OR EXISTS(SELECT 1 FROM (SELECT v,(LAG((v->>1)::bigint) OVER(ORDER BY n)) AS previous FROM jsonb_array_elements(p->'valid_intervals') WITH ORDINALITY AS x(v,n)) ranges
        WHERE (v->>0)::bigint<(EXTRACT(EPOCH FROM NEW.start_at)*1000)::bigint OR (v->>1)::bigint>(EXTRACT(EPOCH FROM NEW.end_at)*1000)::bigint OR (v->>0)::bigint>=(v->>1)::bigint OR previous>(v->>0)::bigint)
      OR p->>'schema_version' IS DISTINCT FROM 'jev.duration-coverage.v1' 
      OR (previous_end IS NOT NULL AND NEW.start_at<previous_end)
      THEN RAISE EXCEPTION 'JEV_COVERAGE_CONTRACT'; END IF;
  ELSIF TG_TABLE_NAME='jev_engine_qualifications' THEN
    IF e.kind<>'result' OR e.envelope->'scope'->>'owner_id' IS DISTINCT FROM NEW.owner_id
      OR p->>'schema_version' IS DISTINCT FROM 'jev.engine-qualification.v1'
      OR p->>'engine_version' IS DISTINCT FROM NEW.engine_version
      OR (p->>'start_at')::timestamptz IS DISTINCT FROM NEW.start_at
      OR (p->>'end_at')::timestamptz IS DISTINCT FROM NEW.end_at
      OR (p->>'qualified')::boolean IS DISTINCT FROM NEW.qualified
      OR (NEW.qualified AND (p->>'financial_continuity_proven' IS DISTINCT FROM 'true'
        OR p->>'execution_costs_funding_risk_recovery_proven' IS DISTINCT FROM 'true'
        OR cardinality(e.dependencies)=0))
      THEN RAISE EXCEPTION 'JEV_QUALIFICATION_CONTRACT'; END IF;
  ELSE
    IF e.kind<>'result' OR e.envelope->'scope'->>'owner_id' IS DISTINCT FROM NEW.owner_id
      OR e.envelope->'scope'->>'profile_id' IS DISTINCT FROM NEW.profile_id
      OR e.envelope->'scope'->>'profile_version' IS DISTINCT FROM NEW.profile_version
      OR p->>'schema_version' IS DISTINCT FROM 'jev.evaluation.v1'
      OR p->>'state' IS DISTINCT FROM NEW.state OR p->>'phase' IS DISTINCT FROM NEW.phase
      OR (p->>'as_of')::timestamptz IS DISTINCT FROM NEW.as_of
      OR p->>'manifest_hash' IS DISTINCT FROM (SELECT manifest_hash FROM jev_profiles WHERE owner_id=NEW.owner_id AND profile_id=NEW.profile_id AND profile_version=NEW.profile_version)
      OR (NEW.state='eligible' AND (p->>'engine_qualified' IS DISTINCT FROM 'true'
        OR jsonb_array_length(p->'accounts')<>2
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'accounts') a WHERE a->>'criterion_passed' IS DISTINCT FROM 'true' OR jsonb_array_length(a->'reasons')<>0 OR (a->>'episodes')::int<60 OR (a->>'coverage_ppm')::int<990000)
        OR NOT EXISTS(SELECT 1 FROM jev_engine_qualifications q WHERE q.evidence_id=ANY(e.dependencies) AND q.owner_id=NEW.owner_id AND q.qualified AND q.end_at<=NEW.as_of)))
      OR p->>'operational_admission' IS DISTINCT FROM 'false' 
      OR e.recorded_at<NEW.as_of
      OR EXISTS(SELECT 1 FROM jev_evaluation_cuts WHERE owner_id=NEW.owner_id AND profile_id=NEW.profile_id AND profile_version=NEW.profile_version AND as_of>NEW.as_of)
      OR (NEW.state<>'failed' AND NEW.phase<>'preview30' AND EXISTS(SELECT 1 FROM jev_evaluation_cuts WHERE owner_id=NEW.owner_id AND profile_id=NEW.profile_id AND profile_version=NEW.profile_version AND state='failed'))
      THEN RAISE EXCEPTION 'JEV_EVALUATION_CONTRACT'; END IF;
  END IF;
  PERFORM jev_evidence_charge(1024,FALSE); RETURN NEW;
END $$;
DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['jev_coverage_segments','jev_engine_qualifications','jev_evaluation_cuts'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock()',name||'_lock',name);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION jev_evaluation_guard()',name||'_guard',name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jev_append_only()',name||'_immutable',name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only()',name||'_no_truncate',name);
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION jev_evidence_allocated_bytes() RETURNS BIGINT LANGUAGE SQL STABLE AS $$
  SELECT pg_total_relation_size('jev_evidence_objects')+pg_total_relation_size('jev_evidence_dependencies')
    +pg_total_relation_size('jev_evidence_sources')+pg_total_relation_size('jev_evidence_pins')+pg_total_relation_size('jev_evidence_closures')
    +pg_total_relation_size('jev_cost_pools')+pg_total_relation_size('jev_decision_profile_contracts')+pg_total_relation_size('jev_decision_requests')
    +pg_total_relation_size('jev_decision_participants')+pg_total_relation_size('jev_decision_results')
    +pg_total_relation_size('jev_risk_events')+pg_total_relation_size('jev_risk_reconciliations')+pg_total_relation_size('jev_entry_events')+pg_total_relation_size('jev_pilot_events')
    +pg_total_relation_size('jev_execution_orders')+pg_total_relation_size('jev_execution_events')+pg_total_relation_size('jev_liquidity_claims')
    +pg_total_relation_size('jev_result_cuts')+pg_total_relation_size('jev_coverage_segments')+pg_total_relation_size('jev_engine_qualifications')+pg_total_relation_size('jev_evaluation_cuts')
$$;
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT(component,version) DO NOTHING;
