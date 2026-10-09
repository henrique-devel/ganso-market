-- JE12 immutable proposals. No generation, funding or admission is enabled.
CREATE TABLE jev_proposals (
 owner_id TEXT NOT NULL, proposal_id TEXT NOT NULL, fingerprint TEXT NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 parent_profile_id TEXT NOT NULL,parent_profile_version TEXT NOT NULL,
 profile_id TEXT NOT NULL,profile_version TEXT NOT NULL,manifest JSONB NOT NULL,
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 512),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,proposal_id),UNIQUE(owner_id,fingerprint),UNIQUE(owner_id,profile_id,profile_version),
 FOREIGN KEY(owner_id,parent_profile_id,parent_profile_version) REFERENCES jev_profiles(owner_id,profile_id,profile_version)
);
CREATE TABLE jev_proposal_events (
 sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,owner_id TEXT NOT NULL,proposal_id TEXT NOT NULL,
 event_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('withdrawn','rejected','approved','vetoed','unavailable','admitted')),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 512),original JSONB NOT NULL DEFAULT '{}'::jsonb,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_id,event_id),FOREIGN KEY(owner_id,proposal_id) REFERENCES jev_proposals(owner_id,proposal_id)
);
CREATE INDEX jev_proposal_latest ON jev_proposal_events(owner_id,proposal_id,sequence DESC);
CREATE FUNCTION jev_canonical_json(value JSONB) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result TEXT;
BEGIN
 CASE jsonb_typeof(value)
 WHEN 'object' THEN SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||jev_canonical_json(v),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(value) x(key,v);
 WHEN 'array' THEN SELECT '['||COALESCE(string_agg(jev_canonical_json(v),',' ORDER BY n),'')||']' INTO result FROM jsonb_array_elements(value) WITH ORDINALITY x(v,n);
 ELSE result:=value::text;
 END CASE;RETURN result;
END $$;
CREATE FUNCTION jev_proposal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent JSONB; n INTEGER; normalized JSONB;
BEGIN
 SELECT manifest INTO STRICT parent FROM jev_profiles WHERE owner_id=NEW.owner_id AND profile_id=NEW.parent_profile_id AND profile_version=NEW.parent_profile_version;
 n:=(CASE WHEN NEW.manifest->'horizon_minutes'<>parent->'horizon_minutes' THEN 1 ELSE 0 END)
  +(CASE WHEN NEW.manifest#>'{context,trade_window_seconds}'<>parent#>'{context,trade_window_seconds}' THEN 1 ELSE 0 END)
  +(CASE WHEN NEW.manifest#>'{context,information_set}'<>parent#>'{context,information_set}' THEN 1 ELSE 0 END)
  +(CASE WHEN NEW.manifest->'decision'<>parent->'decision' THEN 1 ELSE 0 END);
 normalized:=jsonb_set(jsonb_set(jsonb_set(NEW.manifest,'{horizon_minutes}',parent->'horizon_minutes'),'{context,trade_window_seconds}',parent#>'{context,trade_window_seconds}'),'{context,information_set}',parent#>'{context,information_set}');
 IF NEW.fingerprint IS DISTINCT FROM encode(sha256(convert_to(jev_canonical_json(NEW.manifest),'UTF8')),'hex') OR n<>1 OR normalized IS DISTINCT FROM parent
 OR NOT (NEW.manifest->'horizon_minutes' <@ '[1,3,5]'::jsonb)
 OR NOT (NEW.manifest#>'{context,trade_window_seconds}' <@ '[30,60,120]'::jsonb)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(parent#>'{generator,information_sets}') s WHERE s=NEW.manifest#>'{context,information_set}')
 THEN RAISE EXCEPTION 'JEV_ONE_COMPONENT_CHANGE';END IF;
 IF EXISTS(SELECT 1 FROM jev_proposals WHERE owner_id=NEW.owner_id AND manifest=NEW.manifest)
 OR EXISTS(SELECT 1 FROM jev_profiles WHERE owner_id=NEW.owner_id AND manifest=NEW.manifest)
 THEN RAISE EXCEPTION 'JEV_PROPOSAL_FINGERPRINT_COLLISION';END IF;
 IF NEW.created_at>clock_timestamp() THEN RAISE EXCEPTION 'JEV_FUTURE_PROPOSAL';END IF;
 PERFORM jev_evidence_charge(octet_length(NEW.manifest::text)+2048,FALSE);RETURN NEW;
END $$;
CREATE TRIGGER jev_proposal_guard BEFORE INSERT ON jev_proposals FOR EACH ROW EXECUTE FUNCTION jev_proposal_guard();
CREATE FUNCTION jev_proposal_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.recorded_at>clock_timestamp() OR EXISTS(SELECT 1 FROM jev_proposal_events WHERE owner_id=NEW.owner_id AND proposal_id=NEW.proposal_id AND kind IN('withdrawn','rejected','vetoed','admitted')) THEN RAISE EXCEPTION 'JEV_PROPOSAL_TERMINAL';END IF;
 PERFORM jev_evidence_charge(octet_length(NEW.original::text)+1024,TRUE);RETURN NEW;
END $$;
CREATE TRIGGER jev_proposal_event_guard BEFORE INSERT ON jev_proposal_events FOR EACH ROW EXECUTE FUNCTION jev_proposal_event_guard();
DO $$ DECLARE name TEXT;BEGIN
 FOREACH name IN ARRAY ARRAY['jev_proposals','jev_proposal_events'] LOOP
 EXECUTE format('CREATE TRIGGER jev_proposal_lock BEFORE INSERT ON %I FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock()',name);
 EXECUTE format('CREATE TRIGGER jev_proposal_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jev_append_only()',name);
 EXECUTE format('CREATE TRIGGER jev_proposal_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only()',name);
 END LOOP;
END $$;
-- Add permanent proposal history to the shared storage budget without altering old checksums.
ALTER FUNCTION jev_evidence_allocated_bytes() RENAME TO jev_evidence_allocated_bytes_before_je12;
CREATE FUNCTION jev_evidence_allocated_bytes() RETURNS BIGINT LANGUAGE SQL STABLE AS $$
 SELECT jev_evidence_allocated_bytes_before_je12()+pg_total_relation_size('jev_proposals')+pg_total_relation_size('jev_proposal_events')
$$;
INSERT INTO schema_versions(component,version,checksum_sha256) VALUES('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT(component,version) DO NOTHING;
