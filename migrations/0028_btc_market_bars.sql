-- G2-04.3: bounded BTC projections; retention objects remain the evidence source.
-- No legacy DML, writer activation or HOLD changes.
CREATE TABLE btc_market_records (
  object_id TEXT PRIMARY KEY REFERENCES btc_retention_objects(object_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('metadata','book','trades','context','capture')),
  source_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX btc_market_source ON btc_market_records(kind, source_at, object_id);
CREATE INDEX btc_market_received ON btc_market_records(kind, received_at DESC, object_id);
CREATE TABLE btc_market_bars (
  interval_ms INTEGER NOT NULL CHECK (interval_ms IN (900000,3600000)),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  object_id TEXT NOT NULL UNIQUE REFERENCES btc_retention_objects(object_id) ON DELETE CASCADE,
  PRIMARY KEY(interval_ms, start_at),
  CHECK (end_at = start_at + interval_ms * interval '1 millisecond'),
  CHECK (mod((extract(epoch FROM start_at) * 1000)::bigint, interval_ms) = 0)
);
CREATE TABLE btc_market_head (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 128),
  metadata_id TEXT REFERENCES btc_retention_objects(object_id) ON DELETE SET NULL,
  last_capture_at TIMESTAMPTZ NOT NULL,
  next_15m TIMESTAMPTZ NOT NULL,
  next_1h TIMESTAMPTZ NOT NULL
);
-- Charge extra room for each market projection/index in the same quota transaction.
-- Alphabetical trigger order: after btc_objects_insert computes the original charge.
CREATE FUNCTION btc_market_projection_charge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.object_id LIKE 'btc-market:%' THEN
    NEW.charged_bytes := NEW.charged_bytes + 2048;
    IF pg_total_relation_size('btc_retention_objects') + pg_total_relation_size('btc_retention_dependencies')
      + pg_total_relation_size('btc_retention_pins') + pg_total_relation_size('btc_market_records')
      + pg_total_relation_size('btc_market_bars') + pg_total_relation_size('btc_market_head') >= 15032385536 THEN
      RAISE EXCEPTION 'BTC_RETENTION_CAPACITY_REFUSED';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER btc_objects_projection_charge BEFORE INSERT ON btc_retention_objects FOR EACH ROW EXECUTE FUNCTION btc_market_projection_charge();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component,version) DO NOTHING;
