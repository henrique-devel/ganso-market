-- JE02: additive, dormant JEV v2 registry. No seeds, credentials or admission.
CREATE TABLE jev_profiles (
  owner_id TEXT NOT NULL, profile_id TEXT NOT NULL, profile_version TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK(manifest_hash ~ '^[a-f0-9]{64}$'),
  profile JSONB NOT NULL, manifest JSONB NOT NULL,
  technical_state TEXT NOT NULL DEFAULT 'registered' CHECK(technical_state='registered'),
  financial_state TEXT NOT NULL DEFAULT 'unqualified' CHECK(financial_state='unqualified'),
  PRIMARY KEY(owner_id,profile_id,profile_version), UNIQUE(owner_id,manifest_hash),
  CHECK(profile->>'schema_version' IS NOT DISTINCT FROM 'trading.jev.v2'),
  CHECK(profile->>'owner_id' IS NOT DISTINCT FROM owner_id),
  CHECK(profile->>'profile_id' IS NOT DISTINCT FROM profile_id),
  CHECK(profile->>'profile_version' IS NOT DISTINCT FROM profile_version),
  CHECK(profile->>'manifest_hash' IS NOT DISTINCT FROM manifest_hash)
);
CREATE TABLE jev_accounts (
  account_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('paper','stress','live')),
  instrument_id TEXT NOT NULL CHECK(instrument_id='hyperliquid:mainnet:BTC'),
  instrument_version TEXT NOT NULL,
  identity JSONB NOT NULL,
  executor_enabled BOOLEAN NOT NULL DEFAULT FALSE CHECK(NOT executor_enabled),
  UNIQUE(owner_id,account_id,mode), UNIQUE(account_id,instrument_id,instrument_version),
  CHECK(identity->'account'->>'schema_version' IS NOT DISTINCT FROM 'trading.jev.v2'),
  CHECK(identity->'account'->>'owner_id' IS NOT DISTINCT FROM owner_id),
  CHECK(identity->'account'->>'account_id' IS NOT DISTINCT FROM account_id),
  CHECK(identity->'account'->>'mode' IS NOT DISTINCT FROM mode),
  CHECK(identity->'account'->>'executor_enabled' IS NOT DISTINCT FROM 'false'),
  CHECK(identity->'account'->'capital_limit' IS NOT DISTINCT FROM '{"unit":"USD","decimals":6,"raw":"250000000"}'::jsonb),
  CHECK(identity->'account'->'initial_allocation' IS NOT DISTINCT FROM jsonb_build_object('unit','USD','decimals',6,'raw',CASE WHEN mode='live' THEN '0' ELSE '250000000' END)),
  CHECK(identity->'account'->>'capital_origin' IS NOT DISTINCT FROM CASE WHEN mode='live' THEN 'unfunded_live' ELSE 'fictitious' END),
  CHECK(identity->'instrument'->>'instrument_id' IS NOT DISTINCT FROM instrument_id),
  CHECK(identity->'instrument'->>'instrument_version' IS NOT DISTINCT FROM instrument_version)
);
-- The financial identity survives every later profile. A second ID is never a reset.
CREATE UNIQUE INDEX jev_live_singleton ON jev_accounts((TRUE)) WHERE mode='live';
CREATE TABLE jev_bindings (
  experiment_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, account_id TEXT NOT NULL,
  mode TEXT NOT NULL, profile_id TEXT NOT NULL, profile_version TEXT NOT NULL,
  binding JSONB NOT NULL,
  FOREIGN KEY(owner_id,account_id,mode) REFERENCES jev_accounts(owner_id,account_id,mode),
  FOREIGN KEY(owner_id,profile_id,profile_version) REFERENCES jev_profiles(owner_id,profile_id,profile_version),
  UNIQUE(owner_id,account_id,mode,profile_id,profile_version,experiment_id),
  CHECK(binding->>'schema_version' IS NOT DISTINCT FROM 'trading.jev.v2'),
  CHECK(binding->>'owner_id' IS NOT DISTINCT FROM owner_id),
  CHECK(binding->>'account_id' IS NOT DISTINCT FROM account_id),
  CHECK(binding->>'mode' IS NOT DISTINCT FROM mode),
  CHECK(binding->>'profile_id' IS NOT DISTINCT FROM profile_id),
  CHECK(binding->>'profile_version' IS NOT DISTINCT FROM profile_version),
  CHECK(binding->>'experiment_id' IS NOT DISTINCT FROM experiment_id)
);
CREATE TABLE jev_pairs (
  slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 1 AND 3), owner_id TEXT NOT NULL,
  profile_id TEXT NOT NULL, profile_version TEXT NOT NULL,
  paper_account_id TEXT NOT NULL UNIQUE, stress_account_id TEXT NOT NULL UNIQUE,
  paper_experiment_id TEXT NOT NULL UNIQUE, stress_experiment_id TEXT NOT NULL UNIQUE,
  paper_mode TEXT NOT NULL DEFAULT 'paper' CHECK(paper_mode='paper'),
  stress_mode TEXT NOT NULL DEFAULT 'stress' CHECK(stress_mode='stress'),
  UNIQUE(owner_id,profile_id,profile_version),
  CHECK(paper_account_id<>stress_account_id),
  FOREIGN KEY(owner_id,paper_account_id,paper_mode,profile_id,profile_version,paper_experiment_id) REFERENCES jev_bindings(owner_id,account_id,mode,profile_id,profile_version,experiment_id),
  FOREIGN KEY(owner_id,stress_account_id,stress_mode,profile_id,profile_version,stress_experiment_id) REFERENCES jev_bindings(owner_id,account_id,mode,profile_id,profile_version,experiment_id)
);
CREATE TABLE jev_ledger_transactions (
  account_id TEXT NOT NULL REFERENCES jev_accounts(account_id), transaction_id TEXT NOT NULL,
  request JSONB NOT NULL, PRIMARY KEY(account_id,transaction_id),
  CHECK(request->>'transaction_id' IS NOT DISTINCT FROM transaction_id)
);
CREATE TABLE jev_ledger_events (
  account_id TEXT NOT NULL, sequence BIGINT NOT NULL CHECK(sequence>0),
  event_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('paper','stress')),
  profile_id TEXT NOT NULL, profile_version TEXT NOT NULL, experiment_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL, instrument_version TEXT NOT NULL,
  transaction_id TEXT NOT NULL, event JSONB NOT NULL,
  PRIMARY KEY(account_id,sequence), UNIQUE(account_id,event_id),
  FOREIGN KEY(account_id,transaction_id) REFERENCES jev_ledger_transactions(account_id,transaction_id),
  FOREIGN KEY(account_id,instrument_id,instrument_version) REFERENCES jev_accounts(account_id,instrument_id,instrument_version),
  FOREIGN KEY(owner_id,account_id,mode,profile_id,profile_version,experiment_id) REFERENCES jev_bindings(owner_id,account_id,mode,profile_id,profile_version,experiment_id),
  CHECK(event->>'schema_version' IS NOT DISTINCT FROM 'trading.jev.v2'),
  CHECK(event->>'account_id' IS NOT DISTINCT FROM account_id),
  CHECK(event->>'owner_id' IS NOT DISTINCT FROM owner_id),
  CHECK(event->>'mode' IS NOT DISTINCT FROM mode),
  CHECK(event->>'profile_id' IS NOT DISTINCT FROM profile_id),
  CHECK(event->>'profile_version' IS NOT DISTINCT FROM profile_version),
  CHECK(event->>'experiment_id' IS NOT DISTINCT FROM experiment_id),
  CHECK(event->>'instrument_id' IS NOT DISTINCT FROM instrument_id),
  CHECK(event->>'instrument_version' IS NOT DISTINCT FROM instrument_version),
  CHECK(event->>'event_id' IS NOT DISTINCT FROM event_id),
  CHECK(event->>'sequence' IS NOT DISTINCT FROM sequence::TEXT),
  CHECK(event->>'idempotency_key' IS NOT DISTINCT FROM idempotency_key),
  CHECK(event->>'transaction_id' IS NOT DISTINCT FROM transaction_id)
);
CREATE FUNCTION jev_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'JEV_APPEND_ONLY'; END $$;
DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['jev_profiles','jev_accounts','jev_bindings','jev_pairs','jev_ledger_transactions','jev_ledger_events'] LOOP
    EXECUTE format('CREATE TRIGGER jev_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jev_append_only()',name);
    EXECUTE format('CREATE TRIGGER jev_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only()',name);
  END LOOP;
END $$;
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT (component,version) DO NOTHING;
