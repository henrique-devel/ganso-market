-- No credentials, tariff, funding, enabled budgets, or challenger seeds.
CREATE TABLE btc_jev_budgets (
  origin TEXT PRIMARY KEY CHECK(origin IN ('real','mock')),
  month TEXT NOT NULL CHECK(month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  provision_reference TEXT NOT NULL CHECK(length(provision_reference) BETWEEN 1 AND 200),
  tariff_hash TEXT NOT NULL CHECK(tariff_hash ~ '^sha256:[a-f0-9]{64}$'),
  limit_usd6 NUMERIC(18,0) NOT NULL CHECK(limit_usd6>0 AND limit_usd6<=5000000),
  committed_usd6 NUMERIC(18,0) NOT NULL DEFAULT 0 CHECK(committed_usd6>=0 AND committed_usd6<=limit_usd6),
  failures INTEGER NOT NULL DEFAULT 0 CHECK(failures>=0),
  circuit_open BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE btc_jev_calls (
  origin TEXT NOT NULL REFERENCES btc_jev_budgets(origin),
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  token UUID NOT NULL UNIQUE,
  month TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL CHECK(deadline_at>started_at),
  reserved_usd6 NUMERIC(18,0) NOT NULL CHECK(reserved_usd6>0),
  result JSONB NOT NULL,
  finished_at TIMESTAMPTZ,
  PRIMARY KEY(origin,request_id)
);
CREATE INDEX btc_jev_pending ON btc_jev_calls(origin,deadline_at) WHERE finished_at IS NULL;
CREATE FUNCTION btc_jev_call_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'JEV_CALL_IMMUTABLE'; END IF;
  IF OLD.finished_at IS NOT NULL OR NEW.finished_at IS NULL OR
    (to_jsonb(NEW)-'result'-'finished_at') IS DISTINCT FROM (to_jsonb(OLD)-'result'-'finished_at')
    THEN RAISE EXCEPTION 'JEV_CALL_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER btc_jev_call_guard BEFORE UPDATE OR DELETE ON btc_jev_calls FOR EACH ROW EXECUTE FUNCTION btc_jev_call_guard();
CREATE TRIGGER btc_jev_calls_no_truncate BEFORE TRUNCATE ON btc_jev_calls FOR EACH STATEMENT EXECUTE FUNCTION btc_ledger_immutable();
CREATE FUNCTION btc_jev_budget_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.month IS DISTINCT FROM OLD.month AND EXISTS(SELECT 1 FROM btc_jev_calls WHERE origin=OLD.origin AND finished_at IS NULL)
    THEN RAISE EXCEPTION 'JEV_PENDING_BILLING_MONTH'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER btc_jev_budget_guard BEFORE UPDATE ON btc_jev_budgets FOR EACH ROW EXECUTE FUNCTION btc_jev_budget_guard();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT(component,version) DO NOTHING;
