-- Preserve original pairs and every account/version. Active slot is an append-only epoch.
CREATE TABLE jev_pair_epochs (LIKE jev_pairs INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE jev_pair_epochs ADD COLUMN epoch BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY;
ALTER TABLE jev_pair_epochs ADD COLUMN proposal_id TEXT NOT NULL;
ALTER TABLE jev_pair_epochs ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();
ALTER TABLE jev_pair_epochs ADD FOREIGN KEY(owner_id,proposal_id) REFERENCES jev_proposals(owner_id,proposal_id);
ALTER TABLE jev_pair_epochs ADD FOREIGN KEY(owner_id,profile_id,profile_version) REFERENCES jev_profiles(owner_id,profile_id,profile_version);
ALTER TABLE jev_pair_epochs ADD FOREIGN KEY(owner_id,paper_account_id,paper_mode,profile_id,profile_version,paper_experiment_id) REFERENCES jev_bindings(owner_id,account_id,mode,profile_id,profile_version,experiment_id);
ALTER TABLE jev_pair_epochs ADD FOREIGN KEY(owner_id,stress_account_id,stress_mode,profile_id,profile_version,stress_experiment_id) REFERENCES jev_bindings(owner_id,account_id,mode,profile_id,profile_version,experiment_id);
ALTER TABLE jev_pair_epochs ADD UNIQUE(owner_id,proposal_id);
CREATE TABLE jev_pair_retirements (
 slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 3),owner_id TEXT NOT NULL,profile_id TEXT NOT NULL,profile_version TEXT NOT NULL,
 original JSONB NOT NULL,retired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,profile_id,profile_version),
 FOREIGN KEY(owner_id,profile_id,profile_version) REFERENCES jev_profiles(owner_id,profile_id,profile_version)
);
CREATE VIEW jev_latest_pairs AS
 SELECT DISTINCT ON(slot) slot,owner_id,profile_id,profile_version,paper_account_id,stress_account_id,paper_experiment_id,stress_experiment_id
 FROM (SELECT 0::bigint AS epoch,slot,owner_id,profile_id,profile_version,paper_account_id,stress_account_id,paper_experiment_id,stress_experiment_id FROM jev_pairs
 UNION ALL SELECT epoch,slot,owner_id,profile_id,profile_version,paper_account_id,stress_account_id,paper_experiment_id,stress_experiment_id FROM jev_pair_epochs) history ORDER BY slot,epoch DESC;
CREATE VIEW jev_active_pairs AS SELECT q.* FROM jev_latest_pairs q WHERE NOT EXISTS(SELECT 1 FROM jev_pair_retirements r WHERE r.owner_id=q.owner_id AND r.profile_id=q.profile_id AND r.profile_version=q.profile_version);
CREATE FUNCTION jev_account_reconciled_flat(id TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM jev_ledger_events WHERE account_id=id AND event->'payload'->>'event_type'='fill' GROUP BY event->'payload'->>'position_id' HAVING SUM((event->'payload'->'quantity'->>'raw')::numeric*CASE WHEN event->'payload'->>'side'='buy' THEN 1 ELSE -1 END)<>0)
 AND NOT EXISTS(SELECT 1 FROM (SELECT DISTINCT ON(order_id) status FROM jev_entry_events WHERE account_id=id ORDER BY order_id,sequence DESC)x WHERE status<>'released')
 AND COALESCE((SELECT result->>'reconciled_flat'='true' FROM jev_execution_events WHERE account_id=id ORDER BY sequence DESC LIMIT 1),true)
 AND EXISTS(SELECT 1 FROM jev_risk_reconciliations r WHERE r.account_id=id AND r.ledger_sequence=(SELECT COALESCE(MAX(sequence),0) FROM jev_ledger_events WHERE account_id=id) AND r.funding_through_at>=date_trunc('hour',(SELECT MAX((event->>'occurred_at')::timestamptz) FROM jev_ledger_events WHERE account_id=id)) AND r.observed_at>=COALESCE((SELECT MAX(recorded_at) FROM jev_entry_events WHERE account_id=id),'-infinity'::timestamptz))
$$;
CREATE FUNCTION jev_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q jev_active_pairs;
BEGIN
 SELECT * INTO STRICT q FROM jev_active_pairs WHERE slot=NEW.slot AND owner_id=NEW.owner_id AND profile_id=NEW.profile_id AND profile_version=NEW.profile_version;
 PERFORM 1 FROM jev_accounts WHERE account_id IN(q.paper_account_id,q.stress_account_id) ORDER BY account_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM jev_evaluation_cuts WHERE owner_id=NEW.owner_id AND profile_id=NEW.profile_id AND profile_version=NEW.profile_version AND state='failed' AND as_of<=clock_timestamp())
 OR NOT jev_account_reconciled_flat(q.paper_account_id) OR NOT jev_account_reconciled_flat(q.stress_account_id)
 OR (SELECT count(*) FROM jev_evidence_closures WHERE experiment_id IN(q.paper_experiment_id,q.stress_experiment_id) AND closed_at<=clock_timestamp())<>2
 OR EXISTS(SELECT 1 FROM jev_worker_controls WHERE account_id IN(q.paper_account_id,q.stress_account_id) AND (admitted OR NOT entries_paused))
 THEN RAISE EXCEPTION 'JEV_PAIR_NOT_RECONCILED';END IF;
 PERFORM jev_evidence_charge(octet_length(NEW.original::text)+2048,TRUE);RETURN NEW;
END $$;
CREATE TRIGGER jev_retirement_guard BEFORE INSERT ON jev_pair_retirements FOR EACH ROW EXECUTE FUNCTION jev_retirement_guard();
CREATE FUNCTION jev_pair_epoch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q jev_latest_pairs;
BEGIN
 SELECT * INTO q FROM jev_latest_pairs WHERE slot=NEW.slot;
 IF q.slot IS NULL OR q.owner_id IS DISTINCT FROM NEW.owner_id OR NOT EXISTS(SELECT 1 FROM jev_pair_retirements WHERE owner_id=q.owner_id AND profile_id=q.profile_id AND profile_version=q.profile_version)
 OR EXISTS(SELECT 1 FROM jev_active_pairs WHERE slot=NEW.slot)
 OR NOT EXISTS(SELECT 1 FROM jev_proposals p JOIN jev_proposal_requests r USING(owner_id,proposal_id) JOIN jev_proposal_results s USING(origin,request_id) WHERE p.owner_id=NEW.owner_id AND p.proposal_id=NEW.proposal_id AND p.profile_id=NEW.profile_id AND p.profile_version=NEW.profile_version AND r.origin='real' AND s.rank>0 AND s.cost_usd6 IS NOT NULL)
 OR EXISTS(SELECT 1 FROM jev_proposal_events WHERE owner_id=NEW.owner_id AND proposal_id=NEW.proposal_id AND kind IN('withdrawn','rejected','vetoed','admitted'))
 OR NEW.proposal_id IS DISTINCT FROM (SELECT proposal_ids[1] FROM jev_queue_snapshots WHERE owner_id=NEW.owner_id ORDER BY revision DESC LIMIT 1)
 THEN RAISE EXCEPTION 'JEV_SUCCESSION_GATE';END IF;
 PERFORM jev_evidence_charge(4096,FALSE);RETURN NEW;
END $$;
CREATE TRIGGER jev_pair_epoch_guard BEFORE INSERT ON jev_pair_epochs FOR EACH ROW EXECUTE FUNCTION jev_pair_epoch_guard();
DO $$ DECLARE name TEXT;BEGIN
 FOREACH name IN ARRAY ARRAY['jev_pair_epochs','jev_pair_retirements'] LOOP
 EXECUTE format('CREATE TRIGGER jev_proposal_lock BEFORE INSERT ON %I FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock()',name);
 EXECUTE format('CREATE TRIGGER jev_proposal_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jev_append_only()',name);
 EXECUTE format('CREATE TRIGGER jev_proposal_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only()',name);
 END LOOP;
END $$;
ALTER FUNCTION jev_evidence_allocated_bytes() RENAME TO jev_evidence_allocated_bytes_before_successions;
CREATE FUNCTION jev_evidence_allocated_bytes() RETURNS BIGINT LANGUAGE SQL STABLE AS $$
 SELECT jev_evidence_allocated_bytes_before_successions()+pg_total_relation_size('jev_pair_epochs')+pg_total_relation_size('jev_pair_retirements')
$$;
INSERT INTO schema_versions(component,version,checksum_sha256) VALUES('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT(component,version) DO NOTHING;
