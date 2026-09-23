-- G2-02.4: an empty, explicitly delimited new BTC corpus. No legacy DML.
CREATE TABLE btc_retention_policy (
  dataset_id TEXT PRIMARY KEY CHECK (dataset_id = 'btc-paper-v1'),
  policy_version TEXT NOT NULL CHECK (policy_version = 'btc-retention-v1'),
  hold BOOLEAN NOT NULL DEFAULT TRUE,
  raw_quota_bytes BIGINT NOT NULL DEFAULT 10737418240 CHECK (raw_quota_bytes BETWEEN 1 AND 10737418240),
  total_quota_bytes BIGINT NOT NULL DEFAULT 12884901888 CHECK (total_quota_bytes BETWEEN 1 AND 12884901888),
  raw_bytes BIGINT NOT NULL DEFAULT 0 CHECK (raw_bytes >= 0),
  total_bytes BIGINT NOT NULL DEFAULT 0 CHECK (total_bytes >= raw_bytes)
);
INSERT INTO btc_retention_policy(dataset_id, policy_version) VALUES ('btc-paper-v1', 'btc-retention-v1');

CREATE TABLE btc_retention_objects (
  object_id TEXT PRIMARY KEY CHECK (length(object_id) BETWEEN 1 AND 512),
  dataset_id TEXT NOT NULL REFERENCES btc_retention_policy(dataset_id),
  policy_version TEXT NOT NULL CHECK (policy_version = 'btc-retention-v1'),
  class TEXT NOT NULL CHECK (class IN ('raw', 'bar', 'log', 'decision', 'financial', 'experiment')),
  identity JSONB NOT NULL CHECK ((jsonb_typeof(identity) = 'object' AND identity ?& ARRAY['mode','instrument_id','instrument_version']
    AND identity->>'mode' = 'paper'
    AND length(identity->>'instrument_id') > 0 AND length(identity->>'instrument_version') > 0) IS TRUE),
  recorded_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  payload JSONB NOT NULL,
  CHECK ((class NOT IN ('decision', 'financial') OR (identity ?& ARRAY['account_id','experiment_id']
    AND length(identity->>'account_id') > 0 AND length(identity->>'experiment_id') > 0)) IS TRUE),
  CHECK ((class <> 'experiment' OR (identity ? 'experiment_id' AND length(identity->>'experiment_id') > 0)) IS TRUE),
  dependencies TEXT[] NOT NULL DEFAULT '{}',
  charged_bytes BIGINT NOT NULL CHECK (charged_bytes > 0)
);
CREATE INDEX btc_retention_expiry ON btc_retention_objects(expires_at, object_id) WHERE expires_at IS NOT NULL;
CREATE TABLE btc_retention_dependencies (
  object_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id) ON DELETE CASCADE,
  dependency_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id) ON DELETE RESTRICT,
  PRIMARY KEY (object_id, dependency_id),
  CHECK (object_id <> dependency_id)
);
CREATE INDEX btc_retention_dependents ON btc_retention_dependencies(dependency_id);
CREATE TABLE btc_retention_pins (
  pin_id TEXT PRIMARY KEY CHECK (length(pin_id) BETWEEN 1 AND 512),
  object_id TEXT NOT NULL REFERENCES btc_retention_objects(object_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1024),
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Shared transaction lock for writers, pins, HOLD changes and pruning.
CREATE FUNCTION btc_retention_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(741044, 4);
  RETURN NULL;
END $$;
CREATE FUNCTION btc_retention_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'BTC_RETENTION_IMMUTABLE';
END $$;
CREATE TRIGGER btc_policy_no_delete BEFORE DELETE OR TRUNCATE ON btc_retention_policy FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_immutable();
CREATE TRIGGER btc_policy_lock BEFORE UPDATE ON btc_retention_policy FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock();
CREATE TRIGGER btc_objects_lock BEFORE INSERT OR UPDATE OR DELETE ON btc_retention_objects FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock();
CREATE TRIGGER btc_pins_lock BEFORE INSERT ON btc_retention_pins FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock();
CREATE TRIGGER btc_objects_no_update BEFORE UPDATE OR TRUNCATE ON btc_retention_objects FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_immutable();
CREATE TRIGGER btc_pins_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON btc_retention_pins FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_immutable();
CREATE TRIGGER btc_dependencies_no_update BEFORE UPDATE OR TRUNCATE ON btc_retention_dependencies FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_immutable();
-- Dependencies are created from the immutable object envelope, never detached.
CREATE FUNCTION btc_retention_dependency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM btc_retention_objects WHERE object_id = NEW.object_id AND NEW.dependency_id = ANY(dependencies)) THEN
      RAISE EXCEPTION 'BTC_RETENTION_UNKNOWN_DEPENDENCY';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM btc_retention_objects WHERE object_id = OLD.object_id) THEN
    RAISE EXCEPTION 'BTC_RETENTION_IMMUTABLE';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER btc_dependencies_guard BEFORE INSERT OR DELETE ON btc_retention_dependencies FOR EACH ROW EXECUTE FUNCTION btc_retention_dependency_guard();

CREATE FUNCTION btc_retention_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p btc_retention_policy; dep TEXT;
BEGIN
  SELECT * INTO STRICT p FROM btc_retention_policy WHERE dataset_id = NEW.dataset_id FOR UPDATE;
  IF NEW.policy_version <> p.policy_version OR NEW.recorded_at > clock_timestamp() THEN
    RAISE EXCEPTION 'BTC_RETENTION_INVALID_ENVELOPE';
  END IF;
  NEW.expires_at := CASE NEW.class
    WHEN 'raw' THEN ((NEW.recorded_at AT TIME ZONE 'UTC') + interval '7 days') AT TIME ZONE 'UTC'
    WHEN 'bar' THEN ((NEW.recorded_at AT TIME ZONE 'UTC') + interval '12 months') AT TIME ZONE 'UTC'
    WHEN 'log' THEN ((NEW.recorded_at AT TIME ZONE 'UTC') + interval '14 days') AT TIME ZONE 'UTC'
    ELSE NULL END;
  -- Conservative logical charge includes envelope, heap/index overhead and edges.
  NEW.charged_bytes := octet_length(NEW.payload::text) + octet_length(NEW.identity::text)
    + octet_length(NEW.object_id) + octet_length(NEW.dependencies::text) + 1024
    + cardinality(NEW.dependencies) * 1024;
  -- Existing references must share the instrument; the FK rejects absent evidence.
  FOREACH dep IN ARRAY NEW.dependencies LOOP
    IF NOT EXISTS (SELECT 1 FROM btc_retention_objects o WHERE o.object_id = dep
      AND o.identity->>'instrument_id' = NEW.identity->>'instrument_id') THEN
      RAISE EXCEPTION 'BTC_RETENTION_MISSING_EVIDENCE';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER btc_objects_insert BEFORE INSERT ON btc_retention_objects FOR EACH ROW EXECUTE FUNCTION btc_retention_insert();
CREATE FUNCTION btc_retention_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p btc_retention_policy;
BEGIN
  SELECT * INTO STRICT p FROM btc_retention_policy WHERE dataset_id = NEW.dataset_id FOR UPDATE;
  IF NEW.class NOT IN ('decision', 'financial') AND (
    p.total_bytes + NEW.charged_bytes > p.total_quota_bytes OR p.raw_bytes >= p.raw_quota_bytes OR
    (NEW.class = 'raw' AND p.raw_bytes + NEW.charged_bytes > p.raw_quota_bytes) OR
    pg_total_relation_size('btc_retention_objects') + pg_total_relation_size('btc_retention_dependencies')
      + pg_total_relation_size('btc_retention_pins') >= 15032385536
  ) THEN
    RAISE EXCEPTION 'BTC_RETENTION_CAPACITY_REFUSED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE btc_retention_policy SET total_bytes = total_bytes + NEW.charged_bytes,
    raw_bytes = raw_bytes + CASE WHEN NEW.class = 'raw' THEN NEW.charged_bytes ELSE 0 END
    WHERE dataset_id = NEW.dataset_id;
  INSERT INTO btc_retention_dependencies(object_id, dependency_id)
    SELECT NEW.object_id, unnest(NEW.dependencies);
  RETURN NEW;
END $$;
CREATE TRIGGER btc_objects_link AFTER INSERT ON btc_retention_objects FOR EACH ROW EXECUTE FUNCTION btc_retention_link();

CREATE FUNCTION btc_retention_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('ganso.btc_retention_policy', true) IS DISTINCT FROM 'btc-retention-v1'
    OR (SELECT hold FROM btc_retention_policy WHERE dataset_id = OLD.dataset_id)
    OR OLD.expires_at IS NULL OR OLD.expires_at > clock_timestamp()
    OR EXISTS (SELECT 1 FROM btc_retention_pins WHERE object_id = OLD.object_id)
    OR EXISTS (SELECT 1 FROM btc_retention_dependencies WHERE dependency_id = OLD.object_id) THEN
    RAISE EXCEPTION 'BTC_RETENTION_PROTECTED';
  END IF;
  UPDATE btc_retention_policy SET total_bytes = total_bytes - OLD.charged_bytes,
    raw_bytes = raw_bytes - CASE WHEN OLD.class = 'raw' THEN OLD.charged_bytes ELSE 0 END
    WHERE dataset_id = OLD.dataset_id;
  RETURN OLD;
END $$;
CREATE TRIGGER btc_objects_delete BEFORE DELETE ON btc_retention_objects FOR EACH ROW EXECUTE FUNCTION btc_retention_delete();

INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component,version) DO NOTHING;
