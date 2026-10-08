-- JE03: dormant evidence graph. No release of HOLD/pins, quota change or pruning.
CREATE TABLE jev_evidence_objects (
  object_id TEXT PRIMARY KEY CHECK(length(object_id) BETWEEN 1 AND 512),
  experiment_id TEXT NOT NULL REFERENCES jev_bindings(experiment_id),
  kind TEXT NOT NULL CHECK(kind IN ('inputs','context','response','decision','order','fill','funding','quality','cost','proposal','ledger','result','version')),
  recorded_at TIMESTAMPTZ NOT NULL,
  envelope JSONB NOT NULL,
  dependencies TEXT[] NOT NULL,
  sources TEXT[] NOT NULL,
  charged_bytes BIGINT NOT NULL CHECK(charged_bytes>0),
  CHECK(envelope->>'schema_version' IS NOT DISTINCT FROM 'jev.evidence.v1'),
  CHECK(envelope->>'object_id' IS NOT DISTINCT FROM object_id),
  CHECK(envelope->'scope'->>'experiment_id' IS NOT DISTINCT FROM experiment_id),
  CHECK(envelope->>'kind' IS NOT DISTINCT FROM kind),
  CHECK((envelope->>'payload_hash' ~ '^[a-f0-9]{64}$') IS TRUE),
  CHECK(jsonb_typeof(envelope->'payload') IS NOT DISTINCT FROM 'object'),
  CHECK(envelope->'dependencies' IS NOT DISTINCT FROM to_jsonb(dependencies)),
  CHECK(envelope->'sources' IS NOT DISTINCT FROM to_jsonb(sources))
);
CREATE INDEX jev_evidence_experiment ON jev_evidence_objects(experiment_id);
CREATE TABLE jev_evidence_dependencies (
  object_id TEXT NOT NULL REFERENCES jev_evidence_objects(object_id) ON DELETE CASCADE,
  dependency_id TEXT NOT NULL REFERENCES jev_evidence_objects(object_id) ON DELETE RESTRICT,
  PRIMARY KEY(object_id,dependency_id), CHECK(object_id<>dependency_id)
);
CREATE INDEX jev_evidence_dependents ON jev_evidence_dependencies(dependency_id);
-- Keep only actually required raw/projection references; no blanket raw copies.
CREATE TABLE jev_evidence_sources (
  object_id TEXT NOT NULL REFERENCES jev_evidence_objects(object_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id) ON DELETE RESTRICT,
  PRIMARY KEY(object_id,source_id)
);
CREATE INDEX jev_evidence_source_dependents ON jev_evidence_sources(source_id);
CREATE TABLE jev_evidence_pins (
  pin_id TEXT PRIMARY KEY CHECK(length(pin_id) BETWEEN 1 AND 512),
  object_id TEXT NOT NULL REFERENCES jev_evidence_objects(object_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1024)
);
CREATE TABLE jev_evidence_closures (
  experiment_id TEXT PRIMARY KEY REFERENCES jev_bindings(experiment_id),
  closed_at TIMESTAMPTZ NOT NULL, reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1024)
);
CREATE FUNCTION jev_evidence_allocated_bytes() RETURNS BIGINT LANGUAGE SQL STABLE AS $$
  SELECT pg_total_relation_size('jev_evidence_objects') + pg_total_relation_size('jev_evidence_dependencies')
    + pg_total_relation_size('jev_evidence_sources') + pg_total_relation_size('jev_evidence_pins')
    + pg_total_relation_size('jev_evidence_closures')
$$;
-- Existing shared 200 GB / stop 160 GB budget; count new relations too.
CREATE OR REPLACE FUNCTION btc_storage_allocated_bytes() RETURNS BIGINT LANGUAGE SQL STABLE AS $$
  SELECT pg_total_relation_size('btc_retention_objects') + pg_total_relation_size('btc_retention_dependencies')
    + pg_total_relation_size('btc_retention_pins') + pg_total_relation_size('btc_market_records')
    + pg_total_relation_size('btc_market_bars') + pg_total_relation_size('btc_market_head')
    + jev_evidence_allocated_bytes()
$$;
CREATE FUNCTION jev_evidence_charge(bytes BIGINT, essential BOOLEAN) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE p btc_retention_policy; allocated BIGINT;
BEGIN
  IF bytes<=0 THEN RAISE EXCEPTION 'JEV_EVIDENCE_INVALID_CHARGE'; END IF;
  SELECT * INTO STRICT p FROM btc_retention_policy WHERE dataset_id='btc-paper-v1' FOR UPDATE;
  allocated := btc_storage_allocated_bytes();
  IF p.total_bytes+bytes>p.storage_limit_bytes OR allocated+bytes>p.storage_limit_bytes
    OR (NOT essential AND (p.total_bytes+bytes>LEAST(p.total_quota_bytes,p.storage_stop_bytes) OR allocated+bytes>p.storage_stop_bytes)) THEN
    RAISE EXCEPTION 'JEV_EVIDENCE_CAPACITY_REFUSED';
  END IF;
  UPDATE btc_retention_policy SET total_bytes=total_bytes+bytes WHERE dataset_id=p.dataset_id;
END $$;
CREATE FUNCTION jev_evidence_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b jev_bindings; a jev_accounts; dep TEXT; s JSONB; closed TIMESTAMPTZ;
BEGIN
  SELECT * INTO STRICT b FROM jev_bindings WHERE experiment_id=NEW.experiment_id;
  SELECT * INTO STRICT a FROM jev_accounts WHERE account_id=b.account_id;
  s := NEW.envelope->'scope';
  SELECT closed_at INTO closed FROM jev_evidence_closures WHERE experiment_id=NEW.experiment_id;
  IF s IS DISTINCT FROM ((b.binding-'started_at')||jsonb_build_object('instrument_id',a.instrument_id,'instrument_version',a.instrument_version))
    OR NEW.recorded_at>clock_timestamp() OR NEW.recorded_at<(b.binding->>'started_at')::TIMESTAMPTZ
    OR NEW.recorded_at IS DISTINCT FROM (NEW.envelope->>'recorded_at')::TIMESTAMPTZ
    OR (closed IS NOT NULL AND NEW.kind NOT IN ('ledger','result','version') AND NEW.recorded_at>closed)
    OR NEW.object_id=ANY(NEW.dependencies) OR cardinality(NEW.dependencies)>65536 OR cardinality(NEW.sources)>65536 THEN
    RAISE EXCEPTION 'JEV_EVIDENCE_INVALID_ENVELOPE';
  END IF;
  FOREACH dep IN ARRAY NEW.dependencies LOOP
    IF NOT EXISTS(SELECT 1 FROM jev_evidence_objects o WHERE o.object_id=dep
      AND o.envelope->'scope'->>'owner_id'=b.owner_id
      AND o.envelope->'scope'->>'instrument_id'=a.instrument_id
      AND o.envelope->'scope'->>'instrument_version'=a.instrument_version AND o.recorded_at<=NEW.recorded_at) THEN
      RAISE EXCEPTION 'JEV_EVIDENCE_MISSING_DEPENDENCY';
    END IF;
  END LOOP;
  FOREACH dep IN ARRAY NEW.sources LOOP
    IF NOT EXISTS(SELECT 1 FROM btc_retention_objects o WHERE o.object_id=dep
      AND o.identity->>'instrument_id'=a.instrument_id AND o.identity->>'instrument_version'=a.instrument_version
      AND o.class IN ('raw','bar','log') AND o.recorded_at<=NEW.recorded_at) THEN
      RAISE EXCEPTION 'JEV_EVIDENCE_MISSING_SOURCE';
    END IF;
  END LOOP;
  NEW.charged_bytes := octet_length(NEW.envelope::TEXT)+1024+(cardinality(NEW.dependencies)+cardinality(NEW.sources))*1024;
  RETURN NEW;
END $$;
CREATE FUNCTION jev_evidence_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM jev_evidence_charge(NEW.charged_bytes,NEW.kind IN ('ledger','result','cost'));
  INSERT INTO jev_evidence_dependencies SELECT NEW.object_id,unnest(NEW.dependencies);
  INSERT INTO jev_evidence_sources SELECT NEW.object_id,unnest(NEW.sources);
  RETURN NEW;
END $$;
CREATE FUNCTION jev_evidence_edge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE present BOOLEAN;
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM jev_evidence_objects WHERE object_id=OLD.object_id) THEN RAISE EXCEPTION 'JEV_APPEND_ONLY'; END IF;
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME='jev_evidence_dependencies' THEN
    SELECT NEW.dependency_id=ANY(dependencies) INTO present FROM jev_evidence_objects WHERE object_id=NEW.object_id;
  ELSE
    SELECT NEW.source_id=ANY(sources) INTO present FROM jev_evidence_objects WHERE object_id=NEW.object_id;
  END IF;
  IF present IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'JEV_EVIDENCE_UNKNOWN_EDGE'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION jev_evidence_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.closed_at>clock_timestamp() OR NEW.closed_at<(SELECT (binding->>'started_at')::TIMESTAMPTZ FROM jev_bindings WHERE experiment_id=NEW.experiment_id)
    OR EXISTS(SELECT 1 FROM jev_evidence_objects WHERE experiment_id=NEW.experiment_id AND recorded_at>NEW.closed_at AND kind NOT IN ('ledger','result','version')) THEN
    RAISE EXCEPTION 'JEV_EVIDENCE_INVALID_CLOSURE';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION jev_evidence_pin_charge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM jev_evidence_charge(1024,TRUE); RETURN NEW; END $$;
CREATE FUNCTION jev_evidence_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('ganso.jev_retention_policy',TRUE) IS DISTINCT FROM 'jev-evidence-v1'
    OR (SELECT hold FROM btc_retention_policy WHERE dataset_id='btc-paper-v1')
    OR OLD.kind IN ('ledger','result','version')
    OR NOT EXISTS(SELECT 1 FROM jev_evidence_closures WHERE experiment_id=OLD.experiment_id AND ((closed_at AT TIME ZONE 'UTC')+interval '180 days') AT TIME ZONE 'UTC'<=clock_timestamp())
    OR EXISTS(SELECT 1 FROM jev_evidence_pins WHERE object_id=OLD.object_id)
    OR EXISTS(SELECT 1 FROM jev_evidence_dependencies WHERE dependency_id=OLD.object_id) THEN
    RAISE EXCEPTION 'JEV_EVIDENCE_PROTECTED';
  END IF;
  UPDATE btc_retention_policy SET total_bytes=total_bytes-OLD.charged_bytes WHERE dataset_id='btc-paper-v1';
  RETURN OLD;
END $$;
CREATE FUNCTION btc_jev_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM jev_evidence_sources WHERE source_id=OLD.object_id) THEN RAISE EXCEPTION 'BTC_RETENTION_PROTECTED'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER btc_jev_source_guard BEFORE DELETE ON btc_retention_objects FOR EACH ROW EXECUTE FUNCTION btc_jev_source_guard();
CREATE TRIGGER jev_evidence_insert BEFORE INSERT ON jev_evidence_objects FOR EACH ROW EXECUTE FUNCTION jev_evidence_insert();
CREATE TRIGGER jev_evidence_link AFTER INSERT ON jev_evidence_objects FOR EACH ROW EXECUTE FUNCTION jev_evidence_link();
CREATE TRIGGER jev_evidence_delete BEFORE DELETE ON jev_evidence_objects FOR EACH ROW EXECUTE FUNCTION jev_evidence_delete();
CREATE TRIGGER jev_evidence_close BEFORE INSERT ON jev_evidence_closures FOR EACH ROW EXECUTE FUNCTION jev_evidence_close();
CREATE TRIGGER jev_evidence_closure_charge AFTER INSERT ON jev_evidence_closures FOR EACH ROW EXECUTE FUNCTION jev_evidence_pin_charge();
CREATE TRIGGER jev_evidence_pin_charge AFTER INSERT ON jev_evidence_pins FOR EACH ROW EXECUTE FUNCTION jev_evidence_pin_charge();
DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['jev_evidence_objects','jev_evidence_dependencies','jev_evidence_sources','jev_evidence_closures','jev_evidence_pins'] LOOP
    EXECUTE format('CREATE TRIGGER jev_evidence_lock BEFORE INSERT OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock()',name);
    EXECUTE format('CREATE TRIGGER jev_evidence_no_update BEFORE UPDATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only()',name);
    EXECUTE format('CREATE TRIGGER jev_evidence_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only()',name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['jev_evidence_closures','jev_evidence_pins'] LOOP
    EXECUTE format('CREATE TRIGGER jev_evidence_no_delete BEFORE DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only()',name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['jev_evidence_dependencies','jev_evidence_sources'] LOOP
    EXECUTE format('CREATE TRIGGER jev_evidence_edge_guard BEFORE INSERT OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jev_evidence_edge_guard()',name);
  END LOOP;
END $$;
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT (component,version) DO NOTHING;
