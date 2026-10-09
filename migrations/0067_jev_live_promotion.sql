-- JE14: explicit operator authorization and durable singleton succession.
-- No activation, capital, qualification, venue validation or executor is seeded.
CREATE TABLE jev_live_venue_validations (
 identity_hash TEXT NOT NULL REFERENCES jev_live_identities(identity_hash),
 evidence_id TEXT PRIMARY KEY REFERENCES jev_evidence_objects(object_id),
 verified BOOLEAN NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE jev_live_activations (
 account_id TEXT PRIMARY KEY REFERENCES jev_accounts(account_id), owner_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, actor_id TEXT NOT NULL CHECK(actor_id=owner_id),
 identity_hash TEXT NOT NULL REFERENCES jev_live_identities(identity_hash),
 request JSONB NOT NULL, proof JSONB NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), UNIQUE(owner_id,idempotency_key),
 CHECK(request->>'version' IS NOT DISTINCT FROM 'jev.live-activation.v1'),
 CHECK(request->>'confirmed_capital_usd6' IS NOT DISTINCT FROM '250000000')
);
CREATE TABLE jev_live_promotions (
 account_id TEXT NOT NULL REFERENCES jev_accounts(account_id), owner_id TEXT NOT NULL,
 sequence BIGINT NOT NULL CHECK(sequence>0), state TEXT NOT NULL CHECK(state IN('active','draining','waiting')),
 profile_id TEXT NOT NULL, profile_version TEXT NOT NULL, experiment_id TEXT NOT NULL,
 proof JSONB NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,sequence),
 FOREIGN KEY(owner_id,profile_id,profile_version) REFERENCES jev_profiles(owner_id,profile_id,profile_version),
 FOREIGN KEY(owner_id,account_id,mode,profile_id,profile_version,experiment_id) REFERENCES jev_bindings(owner_id,account_id,mode,profile_id,profile_version,experiment_id),
 mode TEXT NOT NULL DEFAULT 'live' CHECK(mode='live')
);
CREATE FUNCTION jev_live_promotion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old jev_live_promotions; a jev_accounts; p JSONB;
BEGIN
 SELECT * INTO STRICT a FROM jev_accounts WHERE account_id=NEW.account_id FOR UPDATE;
 IF a.owner_id IS DISTINCT FROM NEW.owner_id OR a.mode<>'live' THEN RAISE EXCEPTION 'JEV_LIVE_OWNER'; END IF;
 SELECT checkpoint INTO p FROM jev_pilot_events WHERE account_id=NEW.account_id ORDER BY sequence DESC LIMIT 1;
 IF TG_TABLE_NAME='jev_live_activations' THEN
   IF NEW.identity_hash IS DISTINCT FROM (SELECT identity_hash FROM jev_live_identities WHERE account_id=NEW.account_id AND owner_id=NEW.owner_id AND environment='mainnet')
   OR NEW.proof->>'ready' IS DISTINCT FROM 'true' OR p->>'global_blocked' IS DISTINCT FROM 'false'
   OR p->'risk'->>'entries_paused' IS DISTINCT FROM 'false'
   OR p->'observation'->>'trading_balance_usd_raw' IS DISTINCT FROM '250000000'
   OR p->'observation'->>'flat' IS DISTINCT FROM 'true'
   THEN RAISE EXCEPTION 'JEV_LIVE_ACTIVATION_GATE'; END IF;
 ELSE
   SELECT * INTO old FROM jev_live_promotions WHERE account_id=NEW.account_id ORDER BY sequence DESC LIMIT 1;
   IF NEW.sequence<>COALESCE(old.sequence,0)+1 OR NOT EXISTS(SELECT 1 FROM jev_live_activations WHERE account_id=NEW.account_id)
   THEN RAISE EXCEPTION 'JEV_LIVE_SEQUENCE_OR_ACTIVATION'; END IF;
   IF NEW.state='active' THEN
     IF (old.state='active') OR (old.sequence IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jev_evidence_closures WHERE experiment_id=old.experiment_id AND closed_at<=clock_timestamp())) OR NEW.proof->>'ready' IS DISTINCT FROM 'true'
     OR p->>'global_blocked' IS DISTINCT FROM 'false' OR p->'risk'->>'entries_paused' IS DISTINCT FROM 'false'
     OR p->'observation'->>'flat' IS DISTINCT FROM 'true' OR p->'observation'->>'reconciled' IS DISTINCT FROM 'true'
     THEN RAISE EXCEPTION 'JEV_LIVE_PROMOTION_GATE'; END IF;
   ELSE
     IF old.sequence IS NULL OR NEW.profile_id IS DISTINCT FROM old.profile_id OR NEW.profile_version IS DISTINCT FROM old.profile_version
     OR NEW.experiment_id IS DISTINCT FROM old.experiment_id
     OR NOT EXISTS(SELECT 1 FROM jev_evaluation_cuts WHERE owner_id=NEW.owner_id AND profile_id=old.profile_id AND profile_version=old.profile_version AND state='failed' AND as_of<=clock_timestamp())
     THEN RAISE EXCEPTION 'JEV_LIVE_REPROOF_REQUIRED'; END IF;
   END IF;
 END IF;
 PERFORM jev_evidence_charge(octet_length(NEW.proof::text)+4096,TRUE); RETURN NEW;
END $$;
CREATE FUNCTION jev_live_venue_validation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e jev_evidence_objects; i jev_live_identities;
BEGIN
 SELECT * INTO STRICT e FROM jev_evidence_objects WHERE object_id=NEW.evidence_id;
 SELECT * INTO STRICT i FROM jev_live_identities WHERE identity_hash=NEW.identity_hash;
 IF e.envelope->'scope'->>'owner_id' IS DISTINCT FROM i.owner_id OR e.envelope->'scope'->>'account_id' IS DISTINCT FROM i.account_id OR i.environment<>'mainnet' OR e.kind<>'quality' OR e.envelope->'payload'->'original'->>'version' IS DISTINCT FROM 'jev.venue-validation.v1'
 OR e.envelope->'payload'->'original'->>'identity_hash' IS DISTINCT FROM NEW.identity_hash
 OR e.envelope->'payload'->'original'->>'origin' IS DISTINCT FROM 'observed_venue_trial'
 OR (e.envelope->'payload'->'original'->>'verified')::boolean IS DISTINCT FROM NEW.verified
 THEN RAISE EXCEPTION 'JEV_LIVE_VENUE_PROOF'; END IF;
 PERFORM jev_evidence_charge(2048,FALSE); RETURN NEW;
END $$;
CREATE TRIGGER jev_live_activation_guard BEFORE INSERT ON jev_live_activations FOR EACH ROW EXECUTE FUNCTION jev_live_promotion_guard();
CREATE TRIGGER jev_live_promotion_guard BEFORE INSERT ON jev_live_promotions FOR EACH ROW EXECUTE FUNCTION jev_live_promotion_guard();
CREATE TRIGGER jev_live_venue_guard BEFORE INSERT ON jev_live_venue_validations FOR EACH ROW EXECUTE FUNCTION jev_live_venue_validation_guard();
DO $$ DECLARE name TEXT; BEGIN
 FOREACH name IN ARRAY ARRAY['jev_live_venue_validations','jev_live_activations','jev_live_promotions'] LOOP
 EXECUTE format('CREATE TRIGGER jev_live_control_lock BEFORE INSERT ON %I FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock()',name);
 EXECUTE format('CREATE TRIGGER jev_live_control_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jev_append_only()',name);
 EXECUTE format('CREATE TRIGGER jev_live_control_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only()',name);
 END LOOP;
END $$;
ALTER FUNCTION jev_evidence_allocated_bytes() RENAME TO jev_evidence_allocated_bytes_before_promotion;
CREATE FUNCTION jev_evidence_allocated_bytes() RETURNS BIGINT LANGUAGE SQL STABLE AS $$
 SELECT jev_evidence_allocated_bytes_before_promotion()+pg_total_relation_size('jev_live_venue_validations')+pg_total_relation_size('jev_live_activations')+pg_total_relation_size('jev_live_promotions')
$$;
INSERT INTO schema_versions(component,version,checksum_sha256) VALUES('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT(component,version) DO NOTHING;
