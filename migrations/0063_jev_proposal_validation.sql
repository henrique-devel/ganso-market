-- Single paid attempt per proposal, shared generation/validation pool. Dormant.
CREATE TABLE jev_proposal_requests (
 origin TEXT NOT NULL CHECK(origin IN('real','mock')),request_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,proposal_id TEXT NOT NULL,pool_month TEXT NOT NULL,
 purpose TEXT NOT NULL DEFAULT 'generation_validation' CHECK(purpose='generation_validation'),
 token UUID NOT NULL UNIQUE,model TEXT NOT NULL,tariff JSONB NOT NULL,payload JSONB NOT NULL,
 reserved_usd6 NUMERIC(18,0) NOT NULL CHECK(reserved_usd6>0),
 started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),deadline_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(origin,request_id),UNIQUE(owner_id,proposal_id),
 FOREIGN KEY(owner_id,proposal_id) REFERENCES jev_proposals(owner_id,proposal_id),
 FOREIGN KEY(origin,purpose,pool_month) REFERENCES jev_cost_pools(origin,purpose,month),CHECK(deadline_at>started_at)
);
CREATE TABLE jev_proposal_results (
 origin TEXT NOT NULL,request_id TEXT NOT NULL,cost_usd6 NUMERIC(18,0) CHECK(cost_usd6>=0),
 reason TEXT NOT NULL,rank INTEGER CHECK(rank BETWEEN 0 AND 2),original_response TEXT,
 response_hash TEXT CHECK(response_hash ~ '^[a-f0-9]{64}$'),usage JSONB,judgment JSONB,
 finished_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(origin,request_id),FOREIGN KEY(origin,request_id) REFERENCES jev_proposal_requests(origin,request_id),
 CHECK((original_response IS NULL)=(response_hash IS NULL)),
 CHECK(rank IS NULL OR (reason='ok' AND cost_usd6 IS NOT NULL AND judgment IS NOT NULL))
);
CREATE FUNCTION jev_generation_consumed(o TEXT,m TEXT) RETURNS NUMERIC LANGUAGE SQL STABLE AS $$
 SELECT COALESCE((SELECT SUM(COALESCE(s.cost_usd6,r.reserved_usd6)) FROM jev_decision_requests r LEFT JOIN jev_decision_results s USING(origin,request_id) WHERE r.origin=o AND r.purpose='generation_validation' AND r.pool_month=m),0)
 +COALESCE((SELECT SUM(COALESCE(s.cost_usd6,r.reserved_usd6)) FROM jev_proposal_requests r LEFT JOIN jev_proposal_results s USING(origin,request_id) WHERE r.origin=o AND r.pool_month=m),0)
$$;
CREATE FUNCTION jev_proposal_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p jev_cost_pools; proposal jev_proposals;
BEGIN
 SELECT * INTO STRICT p FROM jev_cost_pools WHERE origin=NEW.origin AND purpose='generation_validation' AND month=NEW.pool_month FOR UPDATE;
 SELECT * INTO STRICT proposal FROM jev_proposals WHERE owner_id=NEW.owner_id AND proposal_id=NEW.proposal_id;
 IF NOT p.enabled OR p.circuit_open OR NEW.pool_month<>to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') OR NEW.pool_month<>to_char(NEW.deadline_at AT TIME ZONE 'UTC','YYYY-MM')
 OR NEW.model IS DISTINCT FROM NEW.tariff->>'model' OR p.tariff_hash IS DISTINCT FROM encode(sha256(convert_to(jev_canonical_json(NEW.tariff),'UTF8')),'hex')
 OR NEW.started_at>clock_timestamp() OR EXISTS(SELECT 1 FROM jev_decision_requests WHERE origin=NEW.origin AND request_id=NEW.request_id)
 OR jev_generation_consumed(NEW.origin,NEW.pool_month)+NEW.reserved_usd6>p.limit_usd6
 OR NEW.payload->'state'->'proposal' IS DISTINCT FROM proposal.manifest
 OR EXISTS(SELECT 1 FROM jev_proposal_events WHERE owner_id=NEW.owner_id AND proposal_id=NEW.proposal_id AND kind IN('withdrawn','rejected','vetoed','admitted'))
 THEN RAISE EXCEPTION 'JEV_GENERATION_UNAVAILABLE'; END IF;
 PERFORM jev_evidence_charge(octet_length(NEW.payload::text)+2048,FALSE);RETURN NEW;
END $$;
CREATE TRIGGER jev_proposal_request_guard BEFORE INSERT ON jev_proposal_requests FOR EACH ROW EXECUTE FUNCTION jev_proposal_request_guard();
-- Old decision requests use the same shared pool, including these attempts.
CREATE FUNCTION jev_shared_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p jev_cost_pools;
BEGIN
 IF EXISTS(SELECT 1 FROM jev_proposal_requests WHERE origin=NEW.origin AND request_id=NEW.request_id) THEN RAISE EXCEPTION 'JEV_REQUEST_ID_COLLISION';END IF;
 IF NEW.purpose='generation_validation' AND NEW.reserved_usd6>0 THEN
 SELECT * INTO STRICT p FROM jev_cost_pools WHERE origin=NEW.origin AND purpose=NEW.purpose AND month=NEW.pool_month FOR UPDATE;
 IF jev_generation_consumed(NEW.origin,NEW.pool_month)+NEW.reserved_usd6>p.limit_usd6 THEN RAISE EXCEPTION 'JEV_POOL_EXHAUSTED';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER jev_shared_generation_guard BEFORE INSERT ON jev_decision_requests FOR EACH ROW EXECUTE FUNCTION jev_shared_generation_guard();
CREATE FUNCTION jev_proposal_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jev_proposal_requests;
BEGIN
 SELECT * INTO STRICT r FROM jev_proposal_requests WHERE origin=NEW.origin AND request_id=NEW.request_id;
 IF (NEW.rank IS NOT NULL AND (NEW.original_response IS NULL OR NEW.usage IS NULL)) OR NEW.cost_usd6>r.reserved_usd6 OR NEW.finished_at>clock_timestamp() OR (NEW.rank>0 AND (NEW.judgment->>'choice' NOT IN('strong','adequate') OR NEW.reason<>'ok'))
 OR (NEW.original_response IS NOT NULL AND NEW.response_hash IS DISTINCT FROM encode(sha256(convert_to(NEW.original_response,'UTF8')),'hex'))
 THEN RAISE EXCEPTION 'JEV_PROPOSAL_RESULT';END IF;
 IF NEW.cost_usd6 IS NULL THEN UPDATE jev_cost_pools SET circuit_open=true WHERE origin=NEW.origin AND purpose='generation_validation' AND month=r.pool_month;END IF;
 PERFORM jev_evidence_charge(COALESCE(octet_length(NEW.original_response),0)+2048,TRUE);RETURN NEW;
END $$;
CREATE TRIGGER jev_proposal_result_guard BEFORE INSERT ON jev_proposal_results FOR EACH ROW EXECUTE FUNCTION jev_proposal_result_guard();
DO $$ DECLARE name TEXT;BEGIN
 FOREACH name IN ARRAY ARRAY['jev_proposal_requests','jev_proposal_results'] LOOP
 EXECUTE format('CREATE TRIGGER jev_proposal_lock BEFORE INSERT ON %I FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock()',name);
 EXECUTE format('CREATE TRIGGER jev_proposal_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jev_append_only()',name);
 EXECUTE format('CREATE TRIGGER jev_proposal_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only()',name);
 END LOOP;
END $$;
CREATE FUNCTION jev_proposal_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='approved' AND NOT EXISTS(SELECT 1 FROM jev_proposal_requests r JOIN jev_proposal_results s USING(origin,request_id) WHERE r.owner_id=NEW.owner_id AND r.proposal_id=NEW.proposal_id AND s.reason='ok' AND s.rank>0 AND s.cost_usd6 IS NOT NULL AND NEW.original->>'request_id'=r.request_id AND NEW.original->>'origin'=r.origin)
 THEN RAISE EXCEPTION 'JEV_PROPOSAL_APPROVAL_REQUIRED';END IF;RETURN NEW;
END $$;
CREATE TRIGGER jev_proposal_approval_guard BEFORE INSERT ON jev_proposal_events FOR EACH ROW EXECUTE FUNCTION jev_proposal_approval_guard();
ALTER FUNCTION jev_evidence_allocated_bytes() RENAME TO jev_evidence_allocated_bytes_before_validation;
CREATE FUNCTION jev_evidence_allocated_bytes() RETURNS BIGINT LANGUAGE SQL STABLE AS $$
 SELECT jev_evidence_allocated_bytes_before_validation()+pg_total_relation_size('jev_proposal_requests')+pg_total_relation_size('jev_proposal_results')
$$;
INSERT INTO schema_versions(component,version,checksum_sha256) VALUES('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT(component,version) DO NOTHING;
