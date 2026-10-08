-- JE04: persistent principal decisions. No pool funding, seeds or activation.
CREATE TABLE jev_cost_pools (
  origin TEXT NOT NULL CHECK(origin IN ('real','mock')),
  purpose TEXT NOT NULL CHECK(purpose IN ('operation','generation_validation')),
  month TEXT NOT NULL CHECK(month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  limit_usd6 NUMERIC(18,0) NOT NULL,
  tariff_hash TEXT NOT NULL CHECK(tariff_hash ~ '^[a-f0-9]{64}$'),
  enabled BOOLEAN NOT NULL DEFAULT FALSE, circuit_open BOOLEAN NOT NULL DEFAULT FALSE,
  provision_reference TEXT NOT NULL CHECK(length(provision_reference) BETWEEN 1 AND 200),
  billing_bound_reference TEXT NOT NULL CHECK(length(billing_bound_reference) BETWEEN 1 AND 200),
  PRIMARY KEY(origin,purpose,month),
  CHECK(limit_usd6=CASE WHEN purpose='operation' THEN 8000000 ELSE 2000000 END)
);
-- v1 remains replayable, but cannot provide a second simultaneously enabled pool.
CREATE FUNCTION jev_pool_exclusive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(741044,4);
  IF NEW.enabled AND TG_TABLE_NAME='jev_cost_pools' AND EXISTS(SELECT 1 FROM btc_jev_budgets WHERE origin=NEW.origin AND enabled) THEN RAISE EXCEPTION 'JEV_LEGACY_POOL_ACTIVE'; END IF;
  IF NEW.enabled AND TG_TABLE_NAME='btc_jev_budgets' AND EXISTS(SELECT 1 FROM jev_cost_pools WHERE origin=NEW.origin AND enabled AND month=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM')) THEN RAISE EXCEPTION 'JEV_PRINCIPAL_POOL_ACTIVE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jev_pool_exclusive BEFORE INSERT ON jev_cost_pools FOR EACH ROW EXECUTE FUNCTION jev_pool_exclusive();
CREATE TRIGGER jev_legacy_pool_exclusive BEFORE INSERT OR UPDATE ON btc_jev_budgets FOR EACH ROW EXECUTE FUNCTION jev_pool_exclusive();
CREATE TABLE jev_decision_profile_contracts (
  origin TEXT NOT NULL CHECK(origin IN ('real','mock')),
  owner_id TEXT NOT NULL, profile_id TEXT NOT NULL, profile_version TEXT NOT NULL,
  model TEXT NOT NULL CHECK(model ~ '^jev-[0-9]+\.[0-9]+\.[0-9]+$'),
  questions_version TEXT NOT NULL CHECK(questions_version='jev.principal-questions.v1'),
  PRIMARY KEY(origin,owner_id,profile_id,profile_version),
  FOREIGN KEY(owner_id,profile_id,profile_version) REFERENCES jev_profiles(owner_id,profile_id,profile_version)
);
CREATE FUNCTION jev_decision_contract_charge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM jev_evidence_charge(1024,FALSE); RETURN NEW; END $$;
CREATE TRIGGER jev_decision_contract_charge AFTER INSERT ON jev_decision_profile_contracts FOR EACH ROW EXECUTE FUNCTION jev_decision_contract_charge();
CREATE TABLE jev_decision_requests (
  origin TEXT NOT NULL CHECK(origin IN ('real','mock')), request_id TEXT NOT NULL,
  purpose TEXT NOT NULL, pool_month TEXT,
  token UUID NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
  batch_hash TEXT NOT NULL CHECK(batch_hash ~ '^[a-f0-9]{64}$'), batch JSONB NOT NULL,
  tariff JSONB, reserved_usd6 NUMERIC(18,0) NOT NULL CHECK(reserved_usd6>=0),
  started_at TIMESTAMPTZ NOT NULL, deadline_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(origin,request_id),
  FOREIGN KEY(origin,purpose,pool_month) REFERENCES jev_cost_pools(origin,purpose,month),
  CHECK(batch->>'schema_version' IS NOT DISTINCT FROM 'jev.principal-decision.v1'),
  CHECK(batch->>'request_id' IS NOT DISTINCT FROM request_id),
  CHECK(batch->>'purpose' IS NOT DISTINCT FROM purpose),
  CHECK((reserved_usd6=0 AND pool_month IS NULL) OR (reserved_usd6>0 AND pool_month IS NOT NULL AND tariff IS NOT NULL AND deadline_at>started_at))
);
CREATE INDEX jev_decision_monthly_cost ON jev_decision_requests(origin,started_at);
CREATE INDEX jev_decision_pending ON jev_decision_requests(origin,purpose,pool_month,deadline_at) WHERE reserved_usd6>0;
CREATE TABLE jev_decision_participants (
  origin TEXT NOT NULL, request_id TEXT NOT NULL, account_id TEXT NOT NULL,
  owner_id TEXT NOT NULL, mode TEXT NOT NULL, profile_id TEXT NOT NULL,
  profile_version TEXT NOT NULL, experiment_id TEXT NOT NULL,
  context_id TEXT NOT NULL REFERENCES jev_evidence_objects(object_id) ON DELETE RESTRICT,
  PRIMARY KEY(origin,request_id,account_id),
  FOREIGN KEY(origin,request_id) REFERENCES jev_decision_requests(origin,request_id),
  FOREIGN KEY(owner_id,account_id,mode,profile_id,profile_version,experiment_id) REFERENCES jev_bindings(owner_id,account_id,mode,profile_id,profile_version,experiment_id)
);
CREATE INDEX jev_decision_context ON jev_decision_participants(context_id);
CREATE FUNCTION jev_journal_context_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM jev_decision_participants WHERE context_id=OLD.object_id) THEN RAISE EXCEPTION 'JEV_EVIDENCE_PROTECTED'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER jev_journal_context_guard BEFORE DELETE ON jev_evidence_objects FOR EACH ROW EXECUTE FUNCTION jev_journal_context_guard();
CREATE TABLE jev_decision_results (
  origin TEXT NOT NULL, request_id TEXT NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL, cost_usd6 NUMERIC(18,0) CHECK(cost_usd6>=0),
  result JSONB NOT NULL,
  PRIMARY KEY(origin,request_id),
  FOREIGN KEY(origin,request_id) REFERENCES jev_decision_requests(origin,request_id),
  CHECK(result->>'schema_version' IS NOT DISTINCT FROM 'jev.principal-decision.v1'),
  CHECK(result->>'origin' IS NOT DISTINCT FROM origin),
  CHECK(result->'batch'->>'request_id' IS NOT DISTINCT FROM request_id),
  CHECK(result->>'cost_usd6' IS NOT DISTINCT FROM cost_usd6::TEXT)
);
CREATE FUNCTION jev_pool_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'UPDATE' OR (to_jsonb(NEW)-'circuit_open'-'enabled') IS DISTINCT FROM (to_jsonb(OLD)-'circuit_open'-'enabled')
    OR (OLD.circuit_open AND NOT NEW.circuit_open) OR (NOT OLD.enabled AND NEW.enabled) THEN RAISE EXCEPTION 'JEV_POOL_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jev_pool_guard BEFORE UPDATE OR DELETE ON jev_cost_pools FOR EACH ROW EXECUTE FUNCTION jev_pool_guard();
CREATE TRIGGER jev_pool_no_truncate BEFORE TRUNCATE ON jev_cost_pools FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only();
CREATE FUNCTION jev_decision_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p jev_cost_pools; consumed NUMERIC;
BEGIN
  IF NEW.reserved_usd6>0 THEN
    IF jsonb_typeof(NEW.tariff) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'JEV_TARIFF_REQUIRED'; END IF;
    SELECT * INTO STRICT p FROM jev_cost_pools WHERE origin=NEW.origin AND purpose=NEW.purpose AND month=NEW.pool_month FOR UPDATE;
    IF NOT p.enabled OR p.circuit_open OR NEW.pool_month<>to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM')
      OR NEW.pool_month<>to_char(NEW.deadline_at AT TIME ZONE 'UTC','YYYY-MM') THEN RAISE EXCEPTION 'JEV_POOL_UNAVAILABLE'; END IF;
    SELECT COALESCE(sum(COALESCE(s.cost_usd6,r.reserved_usd6)),0) INTO consumed FROM jev_decision_requests r
      LEFT JOIN jev_decision_results s USING(origin,request_id) WHERE r.origin=NEW.origin AND r.purpose=NEW.purpose AND r.pool_month=NEW.pool_month;
    IF consumed+NEW.reserved_usd6>p.limit_usd6 THEN RAISE EXCEPTION 'JEV_POOL_EXHAUSTED'; END IF;
  END IF;
  PERFORM jev_evidence_charge(octet_length(NEW.batch::TEXT)+2048,NEW.reserved_usd6=0);
  RETURN NEW;
END $$;
CREATE TRIGGER jev_decision_request_guard BEFORE INSERT ON jev_decision_requests FOR EACH ROW EXECUTE FUNCTION jev_decision_request_guard();
CREATE FUNCTION jev_decision_participant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jev_decision_requests; e jev_evidence_objects; p JSONB;
BEGIN
  SELECT * INTO STRICT r FROM jev_decision_requests WHERE origin=NEW.origin AND request_id=NEW.request_id;
  SELECT * INTO STRICT e FROM jev_evidence_objects WHERE object_id=NEW.context_id;
  SELECT value INTO STRICT p FROM jsonb_array_elements(r.batch->'participants') WHERE value->>'context_id'=NEW.context_id;
  IF e.kind<>'context' OR e.experiment_id<>NEW.experiment_id OR e.envelope->'payload'->'context' IS DISTINCT FROM p->'context'
    OR p->'context'->'scope' IS DISTINCT FROM e.envelope->'scope'
    OR p->'context'->'scope'->>'account_id' IS DISTINCT FROM NEW.account_id
    OR p->'context'->'scope'->>'owner_id' IS DISTINCT FROM NEW.owner_id
    OR p->'context'->'scope'->>'mode' IS DISTINCT FROM NEW.mode
    OR p->'context'->'scope'->>'profile_id' IS DISTINCT FROM NEW.profile_id
    OR p->'context'->'scope'->>'profile_version' IS DISTINCT FROM NEW.profile_version
    OR EXISTS(SELECT 1 FROM jev_evidence_closures WHERE experiment_id=NEW.experiment_id) THEN RAISE EXCEPTION 'JEV_DECISION_BINDING'; END IF;
  PERFORM jev_evidence_charge(1024, r.reserved_usd6=0);
  RETURN NEW;
END $$;
CREATE TRIGGER jev_decision_participant_guard BEFORE INSERT ON jev_decision_participants FOR EACH ROW EXECUTE FUNCTION jev_decision_participant_guard();
CREATE FUNCTION jev_decision_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jev_decision_requests;
BEGIN
  SELECT * INTO STRICT r FROM jev_decision_requests WHERE origin=NEW.origin AND request_id=NEW.request_id;
  IF NEW.result->'batch' IS DISTINCT FROM r.batch OR NEW.result->>'batch_hash' IS DISTINCT FROM r.batch_hash
    OR NEW.cost_usd6>r.reserved_usd6 OR (r.reserved_usd6=0 AND NEW.cost_usd6 IS DISTINCT FROM 0::NUMERIC)
    OR (SELECT count(*) FROM jev_decision_participants WHERE origin=NEW.origin AND request_id=NEW.request_id)<>jsonb_array_length(r.batch->'participants')
    OR NEW.finished_at IS DISTINCT FROM (NEW.result->>'finished_at')::TIMESTAMPTZ THEN RAISE EXCEPTION 'JEV_DECISION_RESULT'; END IF;
  PERFORM jev_evidence_charge(octet_length(NEW.result::TEXT)+1024,TRUE);
  RETURN NEW;
END $$;
CREATE TRIGGER jev_decision_result_guard BEFORE INSERT ON jev_decision_results FOR EACH ROW EXECUTE FUNCTION jev_decision_result_guard();
DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['jev_decision_profile_contracts','jev_decision_requests','jev_decision_participants','jev_decision_results'] LOOP
    EXECUTE format('CREATE TRIGGER jev_decision_lock BEFORE INSERT ON %I FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock()',name);
    EXECUTE format('CREATE TRIGGER jev_decision_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jev_append_only()',name);
    EXECUTE format('CREATE TRIGGER jev_decision_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only()',name);
  END LOOP;
END $$;
-- Permanent audit journal participates in the existing shared storage budget.
CREATE OR REPLACE FUNCTION jev_evidence_allocated_bytes() RETURNS BIGINT LANGUAGE SQL STABLE AS $$
  SELECT pg_total_relation_size('jev_evidence_objects')+pg_total_relation_size('jev_evidence_dependencies')
    +pg_total_relation_size('jev_evidence_sources')+pg_total_relation_size('jev_evidence_pins')+pg_total_relation_size('jev_evidence_closures')
    +pg_total_relation_size('jev_cost_pools')+pg_total_relation_size('jev_decision_profile_contracts')+pg_total_relation_size('jev_decision_requests')
    +pg_total_relation_size('jev_decision_participants')+pg_total_relation_size('jev_decision_results')
$$;
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT(component,version) DO NOTHING;
