-- FIN-03 / FIN-07: preserve the old anchor for rollback; new accounting keeps
-- each owner's UTC-day equity-change anchor separate. No capital/history seed.
ALTER TABLE paper_kill_switch ADD COLUMN daily_owner_anchors_json JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(daily_owner_anchors_json) = 'object');

INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component,version) DO NOTHING;
