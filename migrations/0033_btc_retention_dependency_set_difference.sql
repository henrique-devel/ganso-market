-- Production statistics estimate almost all dependency arrays as 0/1 edges.
-- 0032's anti-join can therefore choose nested loops for rare 20k+ edge bars.
-- EXCEPT computes the undeclared set without an early-exit join strategy;
-- hash/sort set difference stays bounded even with inaccurate array estimates.
-- Existing data, triggers, FKs, pins, HOLD, quotas and timeouts are unchanged.
CREATE OR REPLACE FUNCTION btc_retention_dependencies_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    WITH owners AS MATERIALIZED (
      SELECT DISTINCT object_id FROM added_edges
    ), envelopes AS MATERIALIZED (
      SELECT o.object_id, o.dependencies
      FROM owners a JOIN btc_retention_objects o USING (object_id)
    )
    SELECT object_id, dependency_id FROM added_edges
    EXCEPT
    SELECT object_id, unnest(dependencies) FROM envelopes
  ) THEN
    RAISE EXCEPTION 'BTC_RETENTION_UNKNOWN_DEPENDENCY';
  END IF;
  RETURN NULL;
END $$;
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component,version) DO NOTHING;
