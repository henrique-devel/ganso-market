-- JE17 read-only presentation over immutable venue journals. No account,
-- capital, observation, admission or activation is created by this migration.
CREATE INDEX jev_live_cashflow_time ON jev_live_events
 (identity_hash,kind,((payload->>'time')::bigint) DESC,event_key DESC)
 WHERE kind IN('fill','funding');
CREATE INDEX jev_live_receipt_operation ON jev_live_events
 (identity_hash,(payload->>'operation_id'),recorded_at DESC,event_key DESC)
 WHERE kind='receipt';
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT(component,version) DO NOTHING;
