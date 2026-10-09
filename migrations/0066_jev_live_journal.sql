-- JE13, deliberately inert: no account, control, credential or activation seed.
-- 0062–0065 are reserved by the still-open JE12 PR; this additive migration is 0066.
CREATE TABLE jev_live_identities (
 identity_hash TEXT PRIMARY KEY CHECK(identity_hash ~ '^[a-f0-9]{64}$'),
 account_id TEXT NOT NULL UNIQUE REFERENCES jev_accounts(account_id), owner_id TEXT NOT NULL,
 environment TEXT NOT NULL CHECK(environment IN ('mainnet','testnet')),
 account_address TEXT NOT NULL CHECK(account_address ~ '^0x[a-f0-9]{40}$'),
 signer_address TEXT NOT NULL CHECK(signer_address ~ '^0x[a-f0-9]{40}$'),
 identity JSONB NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(environment,account_address), UNIQUE(environment,signer_address),
 CHECK(identity->>'version' IS NOT DISTINCT FROM 'hyperliquid.live.v1'),
 CHECK(identity->>'mode' IS NOT DISTINCT FROM 'live'),
 CHECK(identity->>'account_id' IS NOT DISTINCT FROM account_id),
 CHECK(identity->>'owner_id' IS NOT DISTINCT FROM owner_id),
 CHECK(identity->>'environment' IS NOT DISTINCT FROM environment),
 CHECK(identity->>'account_address' IS NOT DISTINCT FROM account_address),
 CHECK(identity->>'signer_address' IS NOT DISTINCT FROM signer_address)
);
CREATE TABLE jev_live_owners (
 identity_hash TEXT PRIMARY KEY REFERENCES jev_live_identities(identity_hash),
 process_id TEXT NOT NULL, generation BIGINT NOT NULL CHECK(generation>0),
 lease_until TIMESTAMPTZ NOT NULL
);
CREATE TABLE jev_live_requests (
 identity_hash TEXT NOT NULL REFERENCES jev_live_identities(identity_hash), operation_id TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), reservation JSONB NOT NULL,
 environment TEXT NOT NULL, signer_address TEXT NOT NULL, nonce BIGINT NOT NULL CHECK(nonce>0),
 generation BIGINT NOT NULL CHECK(generation>0), recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(identity_hash,operation_id), UNIQUE(environment,signer_address,nonce)
);
CREATE UNIQUE INDEX jev_live_cloid ON jev_live_requests(identity_hash,(reservation->>'cloid'));
CREATE TABLE jev_live_events (
 identity_hash TEXT NOT NULL REFERENCES jev_live_identities(identity_hash),
 event_key TEXT NOT NULL CHECK(length(event_key) BETWEEN 1 AND 512),
 kind TEXT NOT NULL CHECK(kind IN ('snapshot','fill','funding','receipt','gap','protection','balance')),
 payload_hash TEXT NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'), payload JSONB NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(identity_hash,event_key), CHECK(octet_length(payload::text)<=1048576)
);
CREATE INDEX jev_live_event_latest ON jev_live_events(identity_hash,kind,recorded_at DESC,event_key);
CREATE FUNCTION jev_live_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a jev_accounts;
BEGIN
 SELECT * INTO STRICT a FROM jev_accounts WHERE account_id=NEW.account_id FOR UPDATE;
 IF a.mode<>'live' OR a.owner_id<>NEW.owner_id OR NEW.account_address='0x0000000000000000000000000000000000000000'
 OR NEW.signer_address='0x0000000000000000000000000000000000000000'
 OR (NEW.identity->>'vault_address' IS NOT NULL AND NEW.identity->>'vault_address'<>NEW.account_address)
 OR length(NEW.identity->>'signer_generation') NOT BETWEEN 1 AND 160
 THEN RAISE EXCEPTION 'JEV_LIVE_IDENTITY'; END IF;
 PERFORM jev_evidence_charge(1024,FALSE); RETURN NEW;
END $$;
CREATE FUNCTION jev_live_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i jev_live_identities; o jev_live_owners; b jev_bindings; e jev_entry_events; r JSONB; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 SELECT * INTO STRICT i FROM jev_live_identities WHERE identity_hash=NEW.identity_hash;
 PERFORM 1 FROM jev_accounts WHERE account_id=i.account_id FOR UPDATE;
 SELECT * INTO STRICT o FROM jev_live_owners WHERE identity_hash=NEW.identity_hash FOR UPDATE;
 r:=NEW.reservation;
 SELECT * INTO STRICT b FROM jev_bindings WHERE experiment_id=r->'scope'->>'experiment_id';
 IF o.generation<>NEW.generation OR o.lease_until<=now_at OR r->'identity' IS DISTINCT FROM i.identity
 OR r->>'operation_id' IS DISTINCT FROM NEW.operation_id OR r->>'request_hash' IS DISTINCT FROM NEW.request_hash
 OR (r->>'nonce')::bigint IS DISTINCT FROM NEW.nonce OR (r->>'generation')::bigint IS DISTINCT FROM NEW.generation
 OR NEW.environment<>i.environment OR NEW.signer_address<>i.signer_address
 OR b.account_id<>i.account_id OR b.owner_id<>i.owner_id OR b.mode<>'live'
 OR r->'scope'->>'owner_id' IS DISTINCT FROM i.owner_id OR r->'scope'->>'account_id' IS DISTINCT FROM i.account_id
 OR r->'scope'->>'mode' IS DISTINCT FROM 'live' OR r->'scope'->>'profile_id' IS DISTINCT FROM b.profile_id
 OR r->'scope'->>'profile_version' IS DISTINCT FROM b.profile_version
 OR r->'scope'->>'instrument_id' IS DISTINCT FROM 'hyperliquid:'||i.environment||':BTC'
 OR NEW.nonce<EXTRACT(EPOCH FROM now_at)*1000-2000 OR NEW.nonce>EXTRACT(EPOCH FROM now_at)*1000+1000
 OR (r->>'expires_after')::bigint<=NEW.nonce OR (r->>'expires_after')::bigint>NEW.nonce+2000
 THEN RAISE EXCEPTION 'JEV_LIVE_REQUEST_FENCE'; END IF;
 IF r->>'kind'='entry' THEN
  SELECT * INTO STRICT e FROM jev_entry_events WHERE account_id=i.account_id AND order_id=r->'request'->'plan'->'input'->>'order_id' ORDER BY sequence DESC LIMIT 1;
  IF e.status<>'reserved' OR e.plan IS DISTINCT FROM r->'request'->'plan' OR e.plan->'input'->'scope' IS DISTINCT FROM r->'scope' THEN RAISE EXCEPTION 'JEV_LIVE_FINANCIAL_RESERVATION'; END IF;
 END IF;
 PERFORM jev_evidence_charge(octet_length(r::text)+1024,FALSE); RETURN NEW;
END $$;
CREATE FUNCTION jev_live_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i jev_live_identities;
BEGIN
 SELECT * INTO STRICT i FROM jev_live_identities WHERE identity_hash=NEW.identity_hash;
 PERFORM 1 FROM jev_accounts WHERE account_id=i.account_id FOR UPDATE;
 IF NEW.kind='snapshot' AND (NEW.payload->>'version' IS DISTINCT FROM 'hyperliquid.live.v1' OR NEW.payload->>'identity_hash' IS DISTINCT FROM NEW.identity_hash)
 THEN RAISE EXCEPTION 'JEV_LIVE_SNAPSHOT_OWNER'; END IF;
 PERFORM jev_evidence_charge(octet_length(NEW.payload::text)+1024,TRUE);RETURN NEW;
END $$;
CREATE TRIGGER jev_live_identity_guard BEFORE INSERT ON jev_live_identities FOR EACH ROW EXECUTE FUNCTION jev_live_identity_guard();
CREATE TRIGGER jev_live_request_guard BEFORE INSERT ON jev_live_requests FOR EACH ROW EXECUTE FUNCTION jev_live_request_guard();
CREATE TRIGGER jev_live_event_guard BEFORE INSERT ON jev_live_events FOR EACH ROW EXECUTE FUNCTION jev_live_event_guard();
CREATE FUNCTION jev_live_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'JEV_LIVE_OWNER_FENCE'; END IF;
 IF NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '10 seconds' OR NEW.process_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$' THEN RAISE EXCEPTION 'JEV_LIVE_OWNER_FENCE'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.generation<>1 THEN RAISE EXCEPTION 'JEV_LIVE_OWNER_FENCE'; END IF; RETURN NEW;
 END IF;
 IF NEW.identity_hash<>OLD.identity_hash OR NEW.generation<OLD.generation
 OR (OLD.lease_until<=clock_timestamp() AND NEW.generation=OLD.generation)
 OR NEW.generation>OLD.generation+1 OR (NEW.generation=OLD.generation AND NEW.process_id<>OLD.process_id)
 OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '10 seconds'
 THEN RAISE EXCEPTION 'JEV_LIVE_OWNER_FENCE'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER jev_live_owner_guard BEFORE INSERT OR UPDATE OR DELETE ON jev_live_owners FOR EACH ROW EXECUTE FUNCTION jev_live_owner_guard();
CREATE TRIGGER jev_live_owner_no_truncate BEFORE TRUNCATE ON jev_live_owners FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only();
DO $$ DECLARE n TEXT; BEGIN
 FOREACH n IN ARRAY ARRAY['jev_live_identities','jev_live_requests','jev_live_events'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jev_append_only()',n||'_immutable',n);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only()',n||'_no_truncate',n);
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock()',n||'_quota_lock',n);
 END LOOP;
END $$;
-- Preserve the old accounting function rather than copying its full historical body.
ALTER FUNCTION jev_evidence_allocated_bytes() RENAME TO jev_evidence_allocated_bytes_before_live;
CREATE FUNCTION jev_evidence_allocated_bytes() RETURNS BIGINT LANGUAGE SQL STABLE AS $$
 SELECT jev_evidence_allocated_bytes_before_live()+pg_total_relation_size('jev_live_identities')+
 pg_total_relation_size('jev_live_owners')+pg_total_relation_size('jev_live_requests')+pg_total_relation_size('jev_live_events')
$$;
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT DO NOTHING;
