-- The per-edge guard repeatedly detoasted/scanned a complete bar dependency
-- array: quadratic work, observed to exceed the existing 5s write budget.
-- Validate an INSERT statement as a set, expanding each immutable envelope once.
-- No history rewrite, retention policy, quota, HOLD, timeout or worker change.
CREATE FUNCTION btc_retention_dependencies_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    WITH owners AS MATERIALIZED (
      SELECT DISTINCT object_id FROM added_edges
    ), envelopes AS MATERIALIZED (
      SELECT o.object_id, o.dependencies
      FROM owners a JOIN btc_retention_objects o USING (object_id)
    ), declared AS MATERIALIZED (
      SELECT object_id, unnest(dependencies) AS dependency_id FROM envelopes
    )
    SELECT 1 FROM added_edges a
    LEFT JOIN declared d USING (object_id, dependency_id)
    WHERE d.object_id IS NULL
  ) THEN
    RAISE EXCEPTION 'BTC_RETENTION_UNKNOWN_DEPENDENCY';
  END IF;
  RETURN NULL;
END $$;
-- Keep deletion protected per row, including the existing controlled cascade
-- after an authorized leaf deletion. Primary/foreign keys remain untouched.
DROP TRIGGER btc_dependencies_guard ON btc_retention_dependencies;
CREATE TRIGGER btc_dependencies_guard BEFORE DELETE ON btc_retention_dependencies
  FOR EACH ROW EXECUTE FUNCTION btc_retention_dependency_guard();
CREATE TRIGGER btc_dependencies_insert_guard AFTER INSERT ON btc_retention_dependencies
  REFERENCING NEW TABLE AS added_edges FOR EACH STATEMENT
  EXECUTE FUNCTION btc_retention_dependencies_insert_guard();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component,version) DO NOTHING;
