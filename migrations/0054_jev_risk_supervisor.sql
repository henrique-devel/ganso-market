-- JE05: dormant risk/reservation/pilot journals. No seeds, deposits or executor.
CREATE TABLE jev_risk_events (
  account_id TEXT NOT NULL REFERENCES jev_accounts(account_id),
  sequence BIGINT NOT NULL CHECK(sequence>0),
  operation_id TEXT NOT NULL,
  checkpoint JSONB NOT NULL,
  evidence JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,sequence), UNIQUE(account_id,operation_id),
  CHECK(checkpoint->>'version' IS NOT DISTINCT FROM 'btc.jev-risk.v1'),
  CHECK(checkpoint->>'high_water_usd_raw' IS NOT NULL AND checkpoint->>'high_water_usd_raw' ~ '^(0|[1-9][0-9]*)$'),
  CHECK(checkpoint->>'ledger_sequence' IS NOT NULL AND checkpoint->>'ledger_sequence' ~ '^(0|[1-9][0-9]*)$')
);
CREATE TABLE jev_risk_reconciliations (
  account_id TEXT NOT NULL REFERENCES jev_accounts(account_id),
  operation_id TEXT NOT NULL,
  ledger_sequence BIGINT NOT NULL CHECK(ledger_sequence>=0),
  observed_at TIMESTAMPTZ NOT NULL,
  funding_through_at TIMESTAMPTZ NOT NULL,
  request JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,operation_id),
  CHECK(funding_through_at<=observed_at),
  CHECK(observed_at<=recorded_at)
);
CREATE TABLE jev_entry_events (
  account_id TEXT NOT NULL, owner_id TEXT NOT NULL, mode TEXT NOT NULL,
  profile_id TEXT NOT NULL, profile_version TEXT NOT NULL, experiment_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK(sequence>0), operation_id TEXT NOT NULL,
  order_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('reserved','cancel_requested','released')),
  plan_hash TEXT NOT NULL CHECK(plan_hash ~ '^[a-f0-9]{64}$'),
  plan JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,sequence), UNIQUE(account_id,operation_id),
  FOREIGN KEY(owner_id,account_id,mode,profile_id,profile_version,experiment_id)
    REFERENCES jev_bindings(owner_id,account_id,mode,profile_id,profile_version,experiment_id),
  CHECK(plan->>'version' IS NOT DISTINCT FROM 'btc.jev-sizing.v1'),
  CHECK(plan->'input'->>'order_id' IS NOT DISTINCT FROM order_id),
  CHECK(plan->'input'->'scope'->>'account_id' IS NOT DISTINCT FROM account_id),
  CHECK(plan->'input'->'scope'->>'owner_id' IS NOT DISTINCT FROM owner_id),
  CHECK(plan->'input'->'scope'->>'mode' IS NOT DISTINCT FROM mode),
  CHECK(plan->'input'->'scope'->>'profile_id' IS NOT DISTINCT FROM profile_id),
  CHECK(plan->'input'->'scope'->>'profile_version' IS NOT DISTINCT FROM profile_version),
  CHECK(plan->'input'->'scope'->>'experiment_id' IS NOT DISTINCT FROM experiment_id),
  CHECK(plan->>'quantity_btc_raw' IS NOT NULL AND plan->>'quantity_btc_raw' ~ '^[1-9][0-9]*$'),
  CHECK((plan->>'total_risk_usd_raw')::NUMERIC*10000 <= (plan->>'equity_usd_raw')::NUMERIC*100),
  CHECK((plan->>'entry_notional_usd_raw')::NUMERIC*10000 <= (plan->>'equity_usd_raw')::NUMERIC*5000)
);
CREATE INDEX jev_entry_latest ON jev_entry_events(account_id,order_id,sequence DESC);
ALTER TABLE jev_bindings ADD CONSTRAINT jev_binding_account_experiment UNIQUE(account_id,experiment_id);
CREATE TABLE jev_pilot_events (
  account_id TEXT NOT NULL, owner_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'live' CHECK(mode='live'),
  active_experiment_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK(sequence>0), operation_id TEXT NOT NULL,
  request JSONB NOT NULL, checkpoint JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,sequence), UNIQUE(account_id,operation_id),
  FOREIGN KEY(owner_id,account_id,mode) REFERENCES jev_accounts(owner_id,account_id,mode),
  FOREIGN KEY(account_id,active_experiment_id) REFERENCES jev_bindings(account_id,experiment_id),
  CHECK(checkpoint->>'active_experiment_id' IS NOT DISTINCT FROM active_experiment_id),
  CHECK(checkpoint->>'version' IS NOT DISTINCT FROM 'btc.jev-pilot-risk.v1'),
  CHECK(checkpoint->>'capital_admitted_usd_raw' IS NOT DISTINCT FROM '250000000'),
  CHECK(checkpoint->>'executor_enabled' IS NOT DISTINCT FROM 'false')
);
-- Every writer serializes on the same financial account, including direct SQL.
-- Journals cannot introduce a new quantity, reset HWM, or skip a sequence fence.
CREATE FUNCTION jev_risk_journal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old RECORD; old_state JSONB; old_seq BIGINT; new_state JSONB;
BEGIN
  PERFORM 1 FROM jev_accounts WHERE account_id=NEW.account_id FOR UPDATE;
  IF TG_TABLE_NAME='jev_entry_events' THEN
    SELECT * INTO old FROM jev_entry_events WHERE account_id=NEW.account_id AND order_id=NEW.order_id ORDER BY sequence DESC LIMIT 1;
    IF FOUND THEN
      IF NEW.plan_hash IS DISTINCT FROM old.plan_hash OR NEW.plan IS DISTINCT FROM old.plan OR old.status='released'
        OR NEW.status='reserved' THEN RAISE EXCEPTION 'JEV_RISK_RESERVATION_IMMUTABLE'; END IF;
    ELSIF NEW.status<>'reserved' THEN RAISE EXCEPTION 'JEV_RISK_RESERVATION_GENESIS'; END IF;
    SELECT COALESCE(MAX(sequence),0) INTO old_seq FROM jev_entry_events WHERE account_id=NEW.account_id;
  ELSE
    IF TG_TABLE_NAME='jev_risk_events' THEN
      SELECT sequence,checkpoint INTO old FROM jev_risk_events WHERE account_id=NEW.account_id ORDER BY sequence DESC LIMIT 1;
      old_state:=old.checkpoint; new_state:=NEW.checkpoint;
      IF old_state IS NOT NULL AND (
        (old_state->>'drawdown_blocked'='true' AND new_state->>'drawdown_blocked'<>'true') OR
        (old_state->>'day'=new_state->>'day' AND old_state->'daily_anchor_usd_raw' IS DISTINCT FROM new_state->'daily_anchor_usd_raw')
      ) THEN RAISE EXCEPTION 'JEV_RISK_LATCH_IMMUTABLE'; END IF;
    ELSE
      SELECT sequence,checkpoint INTO old FROM jev_pilot_events WHERE account_id=NEW.account_id ORDER BY sequence DESC LIMIT 1;
      old_state:=old.checkpoint->'risk'; new_state:=NEW.checkpoint->'risk';
      IF old.checkpoint->>'global_blocked'='true' AND NEW.active_experiment_id IS DISTINCT FROM old.checkpoint->>'active_experiment_id'
        THEN RAISE EXCEPTION 'JEV_RISK_GLOBAL_BLOCK_PRIORITY'; END IF;
      IF old.checkpoint->>'global_blocked'='true' AND NEW.checkpoint->>'global_blocked'='false' AND (
        NEW.request->>'action' IS DISTINCT FROM 'rearm' OR
        NEW.request->'operator_decision'->>'actor_id' IS DISTINCT FROM NEW.owner_id OR
        COALESCE(NEW.request->'operator_decision'->>'decision_id','')='' OR
        NEW.checkpoint->'observation'->>'flat' IS DISTINCT FROM 'true' OR
        NEW.checkpoint->'observation'->>'reconciled' IS DISTINCT FROM 'true' OR
        COALESCE(NEW.request->'operator_decision'->>'reason','')='' OR
        (NEW.checkpoint->'observation'->>'observed_at')::TIMESTAMPTZ > (new_state->>'observed_at')::TIMESTAMPTZ OR
        (NEW.checkpoint->'observation'->>'observed_at')::TIMESTAMPTZ < (new_state->>'observed_at')::TIMESTAMPTZ - INTERVAL '2 seconds' OR
        (NEW.checkpoint->'observation'->>'trading_balance_usd_raw')::NUMERIC + (NEW.checkpoint->'observation'->>'open_pnl_usd_raw')::NUMERIC <= (new_state->>'drawdown_floor_usd_raw')::NUMERIC
      ) THEN RAISE EXCEPTION 'JEV_RISK_OPERATOR_REARM_REQUIRED'; END IF;
    END IF;
    old_seq:=COALESCE(old.sequence,0);
    IF old_state IS NOT NULL AND (
      (new_state->>'high_water_usd_raw')::NUMERIC < (old_state->>'high_water_usd_raw')::NUMERIC OR
      (new_state->>'ledger_sequence')::NUMERIC < (old_state->>'ledger_sequence')::NUMERIC OR
      (new_state->>'observed_at')::TIMESTAMPTZ < (old_state->>'observed_at')::TIMESTAMPTZ
    ) THEN RAISE EXCEPTION 'JEV_RISK_HWM_OR_CLOCK_RESET'; END IF;
    IF (new_state->>'drawdown_floor_usd_raw')::NUMERIC IS DISTINCT FROM (new_state->>'high_water_usd_raw')::NUMERIC-12500000
      THEN RAISE EXCEPTION 'JEV_RISK_FIXED_DOLLAR_FLOOR'; END IF;
  END IF;
  IF NEW.sequence<>old_seq+1 THEN RAISE EXCEPTION 'JEV_RISK_SEQUENCE_FENCE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jev_risk_guard BEFORE INSERT ON jev_risk_events FOR EACH ROW EXECUTE FUNCTION jev_risk_journal_guard();
CREATE TRIGGER jev_entry_guard BEFORE INSERT ON jev_entry_events FOR EACH ROW EXECUTE FUNCTION jev_risk_journal_guard();
CREATE TRIGGER jev_pilot_guard BEFORE INSERT ON jev_pilot_events FOR EACH ROW EXECUTE FUNCTION jev_risk_journal_guard();
DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['jev_risk_events','jev_risk_reconciliations','jev_entry_events','jev_pilot_events'] LOOP
    EXECUTE format('CREATE TRIGGER jev_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jev_append_only()',name);
    EXECUTE format('CREATE TRIGGER jev_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only()',name);
  END LOOP;
END $$;
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT (component,version) DO NOTHING;
