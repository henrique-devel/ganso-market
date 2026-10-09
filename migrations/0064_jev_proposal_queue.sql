CREATE TABLE jev_queue_snapshots (
 revision BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,owner_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,base_revision BIGINT NOT NULL CHECK(base_revision>=0),
 action TEXT NOT NULL CHECK(action IN('enqueue','remove','reorder','admission')),
 request JSONB NOT NULL,proposal_ids TEXT[] NOT NULL CHECK(cardinality(proposal_ids)<=3),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),UNIQUE(owner_id,idempotency_key)
);
CREATE INDEX jev_queue_latest ON jev_queue_snapshots(owner_id,revision DESC);
CREATE TABLE jev_generator_controls (
 owner_id TEXT PRIMARY KEY,enabled BOOLEAN NOT NULL DEFAULT false,
 admission_reference TEXT NOT NULL CHECK(length(admission_reference)>0),capacity_evidence_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id),
 successor_capacity_evidence_id TEXT REFERENCES btc_retention_objects(object_id)
);
CREATE FUNCTION jev_queue_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior TEXT[];rev BIGINT;
BEGIN
 SELECT revision,proposal_ids INTO rev,prior FROM jev_queue_snapshots WHERE owner_id=NEW.owner_id ORDER BY revision DESC LIMIT 1;
 prior:=COALESCE(prior,ARRAY[]::TEXT[]);
 IF NEW.recorded_at>clock_timestamp() OR NEW.base_revision<>COALESCE(rev,0) OR cardinality(NEW.proposal_ids)<>(SELECT count(DISTINCT id) FROM unnest(NEW.proposal_ids) id)
 OR EXISTS(SELECT 1 FROM unnest(NEW.proposal_ids) id WHERE NOT EXISTS(SELECT 1 FROM jev_proposal_events e WHERE e.owner_id=NEW.owner_id AND e.proposal_id=id AND kind='approved') OR EXISTS(SELECT 1 FROM jev_proposal_events e WHERE e.owner_id=NEW.owner_id AND e.proposal_id=id AND kind IN('withdrawn','vetoed','rejected','admitted')))
 OR (NEW.action='enqueue' AND (cardinality(NEW.proposal_ids)<>cardinality(prior)+1 OR NEW.proposal_ids[1:cardinality(prior)]<>prior))
 OR (NEW.action='reorder' AND (NOT NEW.proposal_ids @> prior OR NOT prior @> NEW.proposal_ids))
 OR (NEW.action IN('remove','admission') AND (cardinality(NEW.proposal_ids)<>cardinality(prior)-1 OR NOT prior @> NEW.proposal_ids))
 OR (NEW.action='remove' AND (NEW.proposal_ids IS DISTINCT FROM ARRAY(SELECT id FROM unnest(prior) WITH ORDINALITY AS u(id,n) WHERE id=ANY(NEW.proposal_ids) ORDER BY n) OR EXISTS(SELECT 1 FROM unnest(prior) id WHERE NOT(id=ANY(NEW.proposal_ids)) AND NOT EXISTS(SELECT 1 FROM jev_proposal_events e WHERE e.owner_id=NEW.owner_id AND e.proposal_id=id AND e.kind='withdrawn'))))
 OR (NEW.action='admission' AND NEW.proposal_ids IS DISTINCT FROM COALESCE(prior[2:cardinality(prior)],ARRAY[]::TEXT[]))
 THEN RAISE EXCEPTION 'JEV_QUEUE_CONFLICT';END IF;
 PERFORM jev_evidence_charge(octet_length(NEW.request::text)+2048,TRUE);RETURN NEW;
END $$;
CREATE TRIGGER jev_queue_guard BEFORE INSERT ON jev_queue_snapshots FOR EACH ROW EXECUTE FUNCTION jev_queue_guard();
CREATE TRIGGER jev_queue_lock BEFORE INSERT ON jev_queue_snapshots FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock();
CREATE TRIGGER jev_queue_immutable BEFORE UPDATE OR DELETE ON jev_queue_snapshots FOR EACH ROW EXECUTE FUNCTION jev_append_only();
CREATE TRIGGER jev_queue_no_truncate BEFORE TRUNCATE ON jev_queue_snapshots FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only();
ALTER FUNCTION jev_evidence_allocated_bytes() RENAME TO jev_evidence_allocated_bytes_before_queue;
CREATE FUNCTION jev_evidence_allocated_bytes() RETURNS BIGINT LANGUAGE SQL STABLE AS $$
 SELECT jev_evidence_allocated_bytes_before_queue()+pg_total_relation_size('jev_queue_snapshots')+pg_total_relation_size('jev_generator_controls')
$$;
INSERT INTO schema_versions(component,version,checksum_sha256) VALUES('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT(component,version) DO NOTHING;
