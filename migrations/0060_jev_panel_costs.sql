-- JE11 manual infrastructure is append-only and excluded from all strategy formulas.
CREATE TABLE jev_infrastructure_events (
 sequence BIGSERIAL PRIMARY KEY, owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 month TEXT NOT NULL CHECK(month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 usd6 NUMERIC(18,0) NOT NULL CHECK(usd6>=0), request JSONB NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_id,idempotency_key),
 CHECK(request->>'month' IS NOT DISTINCT FROM month), CHECK(request->>'usd6' IS NOT DISTINCT FROM usd6::text)
);
CREATE INDEX jev_infrastructure_latest ON jev_infrastructure_events(owner_id,month,sequence DESC);
CREATE INDEX jev_participant_account ON jev_decision_participants(account_id,origin,request_id);
CREATE TRIGGER jev_infrastructure_lock BEFORE INSERT ON jev_infrastructure_events FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock();
CREATE TRIGGER jev_infrastructure_charge BEFORE INSERT ON jev_infrastructure_events FOR EACH ROW EXECUTE FUNCTION jev_decision_contract_charge();
CREATE TRIGGER jev_infrastructure_immutable BEFORE UPDATE OR DELETE ON jev_infrastructure_events FOR EACH ROW EXECUTE FUNCTION jev_append_only();
CREATE TRIGGER jev_infrastructure_no_truncate BEFORE TRUNCATE ON jev_infrastructure_events FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only();

ALTER TABLE jev_worker_controls ADD COLUMN operator_close_requested BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE jev_operator_commands (
 owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('pause','emergency')),
 request JSONB NOT NULL, account_ids TEXT[] NOT NULL CHECK(cardinality(account_ids) BETWEEN 1 AND 6),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,idempotency_key)
);
CREATE INDEX jev_operator_account ON jev_operator_commands USING gin(account_ids);
CREATE TRIGGER jev_operator_lock BEFORE INSERT ON jev_operator_commands FOR EACH STATEMENT EXECUTE FUNCTION btc_retention_lock();
CREATE TRIGGER jev_operator_charge BEFORE INSERT ON jev_operator_commands FOR EACH ROW EXECUTE FUNCTION jev_decision_contract_charge();
CREATE TRIGGER jev_operator_immutable BEFORE UPDATE OR DELETE ON jev_operator_commands FOR EACH ROW EXECUTE FUNCTION jev_append_only();
CREATE TRIGGER jev_operator_no_truncate BEFORE TRUNCATE ON jev_operator_commands FOR EACH STATEMENT EXECUTE FUNCTION jev_append_only();
CREATE OR REPLACE FUNCTION jev_evidence_allocated_bytes() RETURNS BIGINT LANGUAGE SQL STABLE AS $$
  SELECT pg_total_relation_size('jev_evidence_objects')+pg_total_relation_size('jev_evidence_dependencies')
    +pg_total_relation_size('jev_evidence_sources')+pg_total_relation_size('jev_evidence_pins')+pg_total_relation_size('jev_evidence_closures')
    +pg_total_relation_size('jev_cost_pools')+pg_total_relation_size('jev_decision_profile_contracts')+pg_total_relation_size('jev_decision_requests')
    +pg_total_relation_size('jev_decision_participants')+pg_total_relation_size('jev_decision_results')
    +pg_total_relation_size('jev_risk_events')+pg_total_relation_size('jev_risk_reconciliations')+pg_total_relation_size('jev_entry_events')+pg_total_relation_size('jev_pilot_events')
    +pg_total_relation_size('jev_execution_orders')+pg_total_relation_size('jev_execution_events')+pg_total_relation_size('jev_liquidity_claims')
    +pg_total_relation_size('jev_result_cuts')+pg_total_relation_size('jev_coverage_segments')+pg_total_relation_size('jev_engine_qualifications')+pg_total_relation_size('jev_evaluation_cuts')
    +pg_total_relation_size('jev_funding_receipts')+pg_total_relation_size('jev_infrastructure_events')+pg_total_relation_size('jev_operator_commands')
$$;
CREATE INDEX jev_panel_fills ON jev_execution_events(account_id,sequence DESC) WHERE jsonb_array_length(result->'fills')>0;
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT DO NOTHING;
