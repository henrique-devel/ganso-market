-- Owner-approved budget: decimal 200 GB, collection stops at 80% (160 GB).
-- Preserve corpus, counters, HOLD, pins and the immutable evidence policy.
ALTER TABLE btc_retention_policy
  ADD COLUMN storage_limit_bytes BIGINT NOT NULL DEFAULT 200000000000
    CHECK (storage_limit_bytes = 200000000000),
  ADD COLUMN storage_stop_bytes BIGINT NOT NULL DEFAULT 160000000000
    CHECK (storage_stop_bytes * 5 = storage_limit_bytes * 4),
  DROP CONSTRAINT btc_retention_policy_raw_quota_bytes_check,
  DROP CONSTRAINT btc_retention_policy_total_quota_bytes_check,
  ALTER COLUMN raw_quota_bytes SET DEFAULT 200000000000,
  ALTER COLUMN total_quota_bytes SET DEFAULT 200000000000,
  ADD CHECK (raw_quota_bytes BETWEEN 1 AND 200000000000),
  ADD CHECK (total_quota_bytes BETWEEN 1 AND 200000000000);
UPDATE btc_retention_policy
  SET raw_quota_bytes = 200000000000, total_quota_bytes = 200000000000;

CREATE FUNCTION btc_storage_allocated_bytes() RETURNS BIGINT LANGUAGE SQL STABLE AS $$
  SELECT pg_total_relation_size('btc_retention_objects')
    + pg_total_relation_size('btc_retention_dependencies')
    + pg_total_relation_size('btc_retention_pins')
    + pg_total_relation_size('btc_market_records')
    + pg_total_relation_size('btc_market_bars')
    + pg_total_relation_size('btc_market_head')
$$;

CREATE OR REPLACE FUNCTION btc_retention_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p btc_retention_policy; allocated BIGINT;
BEGIN
  SELECT * INTO STRICT p FROM btc_retention_policy WHERE dataset_id = NEW.dataset_id FOR UPDATE;
  allocated := btc_storage_allocated_bytes();
  -- Remaining 20% permits essential accounting/closure after collection stops.
  -- Even essential writes respect the full budget; never bypass as financial.
  IF p.total_bytes + NEW.charged_bytes > p.storage_limit_bytes
    OR allocated >= p.storage_limit_bytes THEN
    RAISE EXCEPTION 'BTC_RETENTION_CAPACITY_REFUSED' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.class NOT IN ('decision', 'financial') AND (
    p.total_bytes >= p.storage_stop_bytes OR
    p.total_bytes + NEW.charged_bytes > LEAST(p.total_quota_bytes, p.storage_stop_bytes) OR
    p.raw_bytes >= LEAST(p.raw_quota_bytes, p.storage_stop_bytes) OR
    (NEW.class = 'raw' AND p.raw_bytes + NEW.charged_bytes > LEAST(p.raw_quota_bytes, p.storage_stop_bytes)) OR
    allocated >= p.storage_stop_bytes
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

CREATE OR REPLACE FUNCTION btc_market_projection_charge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.object_id LIKE 'btc-market:%' THEN
    NEW.charged_bytes := NEW.charged_bytes + 2048;
    IF btc_storage_allocated_bytes() >=
      (SELECT storage_stop_bytes FROM btc_retention_policy WHERE dataset_id = NEW.dataset_id) THEN
      RAISE EXCEPTION 'BTC_RETENTION_CAPACITY_REFUSED';
    END IF;
  END IF;
  RETURN NEW;
END $$;

INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component,version) DO NOTHING;
