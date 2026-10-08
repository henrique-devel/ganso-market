-- JE07: dormant JEV admission, durable process fencing and API command outbox.
-- No account seeds, financial DML, funding or operational activation.
CREATE TABLE execution_worker_owners (
 generation BIGINT PRIMARY KEY CHECK(generation>0),
 worker_id UUID NOT NULL UNIQUE,
 code_sha TEXT NOT NULL CHECK(code_sha ~ '^[a-f0-9]{40}$'),
 claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE execution_worker_head (
 singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
 generation BIGINT NOT NULL REFERENCES execution_worker_owners(generation),
 worker_id UUID NOT NULL,
 lease_until TIMESTAMPTZ NOT NULL
);
CREATE TABLE jev_worker_controls (
 account_id TEXT PRIMARY KEY REFERENCES jev_accounts(account_id),
 admitted BOOLEAN NOT NULL DEFAULT false,
 entries_paused BOOLEAN NOT NULL DEFAULT true,
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
 admission_reference TEXT,
 funding_debit_rate9_raw NUMERIC(38,0),
 cost_evidence_id TEXT,
 CHECK(NOT admitted OR (admission_reference IS NOT NULL AND length(admission_reference)>0)),
 CHECK(funding_debit_rate9_raw IS NULL OR funding_debit_rate9_raw BETWEEN 0 AND 1000000000)
);
CREATE TABLE jev_worker_cadences (
 account_id TEXT PRIMARY KEY REFERENCES jev_accounts(account_id),
 generation BIGINT NOT NULL REFERENCES execution_worker_owners(generation),
 state JSONB NOT NULL,
 pending_request_id TEXT,
 pending_cut_at TIMESTAMPTZ,
 CHECK((pending_request_id IS NULL)=(pending_cut_at IS NULL))
);
CREATE TABLE jev_worker_cycles (
 request_id TEXT NOT NULL,
 account_id TEXT NOT NULL REFERENCES jev_accounts(account_id),
 phase TEXT NOT NULL CHECK(phase IN ('scheduled','completed','discarded','recovered')),
 generation BIGINT NOT NULL REFERENCES execution_worker_owners(generation),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 data JSONB NOT NULL,
 PRIMARY KEY(request_id,account_id,phase)
);
CREATE TABLE execution_command_queue (
 account_id TEXT NOT NULL REFERENCES btc_ledger_accounts(account_id),
 idempotency_key TEXT NOT NULL,
 attempt INTEGER NOT NULL CHECK(attempt>0),
 session_id UUID NOT NULL REFERENCES auth_sessions(session_id),
 token_hash TEXT NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 action TEXT NOT NULL CHECK(action IN ('pause','cancel','close','submit')),
 intent TEXT NOT NULL CHECK(length(intent)<=16384),
 request JSONB NOT NULL,
 queued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,idempotency_key,attempt)
);
CREATE TABLE execution_command_results (
 account_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 attempt INTEGER NOT NULL CHECK(attempt>0),
 result JSONB,
 error_code TEXT,
 error_status INTEGER,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,idempotency_key,attempt),
 FOREIGN KEY(account_id,idempotency_key,attempt) REFERENCES execution_command_queue,
 CHECK((result IS NOT NULL AND error_code IS NULL AND error_status IS NULL) OR
       (result IS NULL AND error_code IS NOT NULL AND error_status BETWEEN 400 AND 599))
);
CREATE FUNCTION execution_worker_control_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.revision := OLD.revision+1;
 RETURN NEW;
END $$;
CREATE TRIGGER jev_worker_control_revision BEFORE UPDATE ON jev_worker_controls
FOR EACH ROW EXECUTE FUNCTION execution_worker_control_revision();
CREATE FUNCTION execution_worker_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'EXECUTION_WORKER_IMMUTABLE'; END $$;
CREATE TRIGGER execution_worker_owners_immutable BEFORE UPDATE OR DELETE ON execution_worker_owners FOR EACH ROW EXECUTE FUNCTION execution_worker_immutable();
CREATE TRIGGER jev_worker_cycles_immutable BEFORE UPDATE OR DELETE ON jev_worker_cycles FOR EACH ROW EXECUTE FUNCTION execution_worker_immutable();
CREATE TRIGGER execution_command_queue_immutable BEFORE UPDATE OR DELETE ON execution_command_queue FOR EACH ROW EXECUTE FUNCTION execution_worker_immutable();
CREATE TRIGGER execution_command_results_immutable BEFORE UPDATE OR DELETE ON execution_command_results FOR EACH ROW EXECUTE FUNCTION execution_worker_immutable();
CREATE TRIGGER execution_worker_owners_no_truncate BEFORE TRUNCATE ON execution_worker_owners FOR EACH STATEMENT EXECUTE FUNCTION execution_worker_immutable();
CREATE TRIGGER jev_worker_cycles_no_truncate BEFORE TRUNCATE ON jev_worker_cycles FOR EACH STATEMENT EXECUTE FUNCTION execution_worker_immutable();
CREATE TRIGGER execution_command_queue_no_truncate BEFORE TRUNCATE ON execution_command_queue FOR EACH STATEMENT EXECUTE FUNCTION execution_worker_immutable();
CREATE TRIGGER execution_command_results_no_truncate BEFORE TRUNCATE ON execution_command_results FOR EACH STATEMENT EXECUTE FUNCTION execution_worker_immutable();
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT DO NOTHING;
