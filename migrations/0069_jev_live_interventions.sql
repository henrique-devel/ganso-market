-- JE16 extends authenticated all-account commands to six fictitious accounts
-- and the single previously activated live account. Existing audit is immutable.
ALTER TABLE jev_operator_commands DROP CONSTRAINT jev_operator_commands_account_ids_check;
ALTER TABLE jev_operator_commands ADD CONSTRAINT jev_operator_commands_account_ids_check
 CHECK(cardinality(account_ids) BETWEEN 1 AND 7);

ALTER TABLE jev_live_events DROP CONSTRAINT jev_live_events_kind_check;
ALTER TABLE jev_live_events ADD CONSTRAINT jev_live_events_kind_check
 CHECK(kind IN('snapshot','fill','funding','receipt','gap','protection','balance','metadata','intervention'));

CREATE INDEX jev_live_intervention_command ON jev_live_events(identity_hash,(payload->>'command_key'),recorded_at DESC,event_key DESC) WHERE kind='intervention';

INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT DO NOTHING;
