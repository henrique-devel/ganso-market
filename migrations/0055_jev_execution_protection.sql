-- JE06: one dormant maker/IOC account contract, no activation or historical rewrite.
CREATE TABLE jev_execution_orders (
  account_id TEXT NOT NULL REFERENCES jev_accounts(account_id),
  order_id TEXT NOT NULL, decision_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK(plan_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(account_id,order_id), UNIQUE(account_id,decision_id)
);
CREATE TABLE jev_execution_events (
  account_id TEXT NOT NULL, owner_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('paper','stress')),
  profile_id TEXT NOT NULL, profile_version TEXT NOT NULL, experiment_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK(sequence>0), operation_id TEXT NOT NULL,
  request JSONB NOT NULL, state JSONB NOT NULL, result JSONB NOT NULL, evidence JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,sequence), UNIQUE(account_id,operation_id),
  FOREIGN KEY(owner_id,account_id,mode,profile_id,profile_version,experiment_id)
    REFERENCES jev_bindings(owner_id,account_id,mode,profile_id,profile_version,experiment_id),
  CHECK(state->>'schema_version' IS NOT DISTINCT FROM 'btc.jev-execution.v1'),
  CHECK(result->'state' IS NOT DISTINCT FROM state),
  CHECK(jsonb_typeof(evidence)='array'),
  CHECK(state->'maker'->'plan'->'input'->'scope'->>'account_id' IS NOT DISTINCT FROM account_id),
  CHECK(state->'maker'->'plan'->'input'->'scope'->>'experiment_id' IS NOT DISTINCT FROM experiment_id),
  CHECK(state->'maker'->'plan'->'input'->'scope'->>'owner_id' IS NOT DISTINCT FROM owner_id),
  CHECK(state->'maker'->'plan'->'input'->'scope'->>'mode' IS NOT DISTINCT FROM mode),
  CHECK(state->'maker'->'plan'->'input'->'scope'->>'profile_id' IS NOT DISTINCT FROM profile_id),
  CHECK(state->'maker'->'plan'->'input'->'scope'->>'profile_version' IS NOT DISTINCT FROM profile_version),
  CHECK((state->>'observed_at')::TIMESTAMPTZ<=recorded_at)
);
CREATE TABLE jev_liquidity_claims (
  account_id TEXT NOT NULL REFERENCES jev_accounts(account_id), liquidity_key TEXT NOT NULL,
  operation_id TEXT NOT NULL, quantity_raw NUMERIC(38,0) NOT NULL CHECK(quantity_raw>0),
  capacity_raw NUMERIC(38,0) NOT NULL CHECK(capacity_raw>0), original JSONB NOT NULL,
  PRIMARY KEY(account_id,liquidity_key,operation_id),
  CHECK(quantity_raw<=capacity_raw)
);
CREATE INDEX jev_execution_latest ON jev_execution_events(account_id,sequence DESC);
CREATE FUNCTION jev_execution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_state JSONB; previous BIGINT; used NUMERIC; capacity NUMERIC; plan JSONB; protected JSONB; prior_protected JSONB; net NUMERIC; opened NUMERIC;
BEGIN
  PERFORM 1 FROM jev_accounts WHERE account_id=NEW.account_id FOR UPDATE;
  IF TG_TABLE_NAME='jev_liquidity_claims' THEN
    SELECT COALESCE(sum(quantity_raw),0),max(capacity_raw) INTO used,capacity FROM jev_liquidity_claims WHERE account_id=NEW.account_id AND liquidity_key=NEW.liquidity_key;
    IF used+NEW.quantity_raw>NEW.capacity_raw OR (capacity IS NOT NULL AND capacity<>NEW.capacity_raw) THEN RAISE EXCEPTION 'JEV_EXECUTION_LIQUIDITY_CONSERVATION'; END IF;
    PERFORM jev_evidence_charge(octet_length(NEW.original::TEXT)+1024,TRUE);
  ELSIF TG_TABLE_NAME='jev_execution_orders' THEN
    SELECT e.plan INTO STRICT plan FROM jev_entry_events e WHERE e.account_id=NEW.account_id AND e.order_id=NEW.order_id AND e.plan_hash=NEW.plan_hash AND e.status='reserved' ORDER BY e.sequence DESC LIMIT 1;
    IF plan->'input'->>'decision_id' IS DISTINCT FROM NEW.decision_id THEN RAISE EXCEPTION 'JEV_EXECUTION_DECISION'; END IF;
    PERFORM jev_evidence_charge(1024,FALSE);
  ELSE
    SELECT sequence,state INTO previous,old_state FROM jev_execution_events WHERE account_id=NEW.account_id ORDER BY sequence DESC LIMIT 1;
    IF NEW.sequence<>COALESCE(previous,0)+1 THEN RAISE EXCEPTION 'JEV_EXECUTION_SEQUENCE'; END IF;
    IF old_state IS NOT NULL AND (NEW.state->>'observed_at')::TIMESTAMPTZ<(old_state->>'observed_at')::TIMESTAMPTZ THEN RAISE EXCEPTION 'JEV_EXECUTION_CLOCK'; END IF;
    IF NOT EXISTS(SELECT 1 FROM jev_execution_orders o WHERE o.account_id=NEW.account_id AND o.order_id=NEW.state->'maker'->'plan'->'input'->>'order_id' AND o.plan_hash=NEW.state->'maker'->>'plan_hash') THEN RAISE EXCEPTION 'JEV_EXECUTION_ORDER'; END IF;
    protected:=NEW.state->'protection'; prior_protected:=old_state->'protection';
    SELECT COALESCE(sum(CASE WHEN event->'payload'->>'side'='buy' THEN (event->'payload'->'quantity'->>'raw')::NUMERIC ELSE -(event->'payload'->'quantity'->>'raw')::NUMERIC END),0),
      COALESCE(sum(CASE WHEN event->'payload'->>'order_id'=NEW.state->'maker'->'plan'->'input'->>'order_id' THEN (event->'payload'->'quantity'->>'raw')::NUMERIC ELSE 0 END),0)
      INTO net,opened FROM jev_ledger_events WHERE account_id=NEW.account_id AND event->'payload'->>'event_type'='fill' AND event->'payload'->>'position_id'=NEW.state->'maker'->'plan'->'input'->>'order_id';
    IF opened IS DISTINCT FROM (NEW.state->'maker'->>'filled_btc_raw')::NUMERIC OR
      abs(net) IS DISTINCT FROM COALESCE((protected->>'quantity_btc_raw')::NUMERIC,0) OR
      (net>0 AND protected->>'direction' IS DISTINCT FROM 'long') OR
      (net<0 AND protected->>'direction' IS DISTINCT FROM 'short') THEN RAISE EXCEPTION 'JEV_EXECUTION_LEDGER_CONSERVATION'; END IF;
    IF jsonb_typeof(protected)='object' THEN
      IF protected->'scope' IS DISTINCT FROM NEW.state->'maker'->'plan'->'input'->'scope'
        OR protected->>'position_id' IS DISTINCT FROM NEW.state->'maker'->'plan'->'input'->>'order_id'
        OR (protected->>'maximum_exit_at')::TIMESTAMPTZ IS DISTINCT FROM (protected->>'first_fill_at')::TIMESTAMPTZ+INTERVAL '6 hours'
        OR (protected->>'quantity_btc_raw')::NUMERIC<0 THEN RAISE EXCEPTION 'JEV_EXECUTION_PROTECTION'; END IF;
      IF jsonb_typeof(prior_protected)='object' AND protected->>'position_id'=prior_protected->>'position_id'
        AND (protected-'quantity_btc_raw') IS DISTINCT FROM (prior_protected-'quantity_btc_raw') THEN RAISE EXCEPTION 'JEV_EXECUTION_ANCHOR_RESET'; END IF;
    END IF;
    IF old_state->'maker'->'plan'->'input'->>'order_id'=NEW.state->'maker'->'plan'->'input'->>'order_id' AND (
      old_state->'maker'->'plan' IS DISTINCT FROM NEW.state->'maker'->'plan' OR
      (NEW.state->'maker'->>'filled_btc_raw')::NUMERIC<(old_state->'maker'->>'filled_btc_raw')::NUMERIC OR
      (NEW.state->'maker'->>'filled_btc_raw')::NUMERIC>(NEW.state->'maker'->'plan'->>'quantity_btc_raw')::NUMERIC OR
      (old_state->'maker'->>'ack_at' IS NOT NULL AND old_state->'maker'->>'ack_at' IS DISTINCT FROM NEW.state->'maker'->>'ack_at') OR
      (old_state->'maker'->>'status' IN ('filled','cancelled','rejected') AND old_state->'maker'->>'status' IS DISTINCT FROM NEW.state->'maker'->>'status')
    ) THEN RAISE EXCEPTION 'JEV_EXECUTION_ORDER_IMMUTABLE'; END IF;
    PERFORM jev_evidence_charge(octet_length(NEW.evidence::TEXT)+octet_length(NEW.state::TEXT)+octet_length(NEW.result::TEXT)+2048,NEW.request->>'action'<>'submit');
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['jev_execution_orders','jev_execution_events','jev_liquidity_claims'] LOOP
    EXECUTE format('CREATE TRIGGER jev_execution_lock BEFORE INSERT ON %I FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock()',name);
    EXECUTE format('CREATE TRIGGER jev_execution_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION jev_execution_guard()',name);
    EXECUTE format('CREATE TRIGGER jev_execution_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jev_append_only()',name);
    EXECUTE format('CREATE TRIGGER jev_execution_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only()',name);
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION jev_evidence_allocated_bytes() RETURNS BIGINT LANGUAGE SQL STABLE AS $$
  SELECT pg_total_relation_size('jev_evidence_objects')+pg_total_relation_size('jev_evidence_dependencies')
    +pg_total_relation_size('jev_evidence_sources')+pg_total_relation_size('jev_evidence_pins')+pg_total_relation_size('jev_evidence_closures')
    +pg_total_relation_size('jev_cost_pools')+pg_total_relation_size('jev_decision_profile_contracts')+pg_total_relation_size('jev_decision_requests')
    +pg_total_relation_size('jev_decision_participants')+pg_total_relation_size('jev_decision_results')
    +pg_total_relation_size('jev_risk_events')+pg_total_relation_size('jev_risk_reconciliations')+pg_total_relation_size('jev_entry_events')+pg_total_relation_size('jev_pilot_events')
    +pg_total_relation_size('jev_execution_orders')+pg_total_relation_size('jev_execution_events')+pg_total_relation_size('jev_liquidity_claims')
$$;
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT(component,version) DO NOTHING;
