-- FIN-02 / RFC-038: additive ownership, with ledger-v1 readers unchanged.
-- The runner supplies the transaction. No historical event/order is rewritten,
-- no capital is allocated, and the future financial-v2 cache stays empty.
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '5s';

CREATE TABLE paper_financial_owners (
    account_id text NOT NULL CHECK (char_length(btrim(account_id)) BETWEEN 1 AND 64),
    strategy_id text NOT NULL CHECK (char_length(btrim(strategy_id)) BETWEEN 1 AND 64),
    initial_cash_usd text CHECK (initial_cash_usd ~ '^(0|[1-9][0-9]*)\.[0-9]{9}$'),
    capital_source_ref text NOT NULL CHECK (char_length(btrim(capital_source_ref)) > 0),
    ownership_version integer NOT NULL DEFAULT 1 CHECK (ownership_version > 0),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, strategy_id)
);

CREATE TABLE paper_order_owners (
    order_id text NOT NULL REFERENCES paper_orders (order_id),
    ownership_version integer NOT NULL DEFAULT 1 CHECK (ownership_version > 0),
    account_id text NOT NULL,
    strategy_id text NOT NULL,
    attribution_status text NOT NULL CHECK (attribution_status IN ('verified', 'unknown')),
    evidence_ref text NOT NULL CHECK (char_length(btrim(evidence_ref)) > 0),
    supersedes_version integer,
    recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (order_id, ownership_version),
    FOREIGN KEY (account_id, strategy_id) REFERENCES paper_financial_owners,
    FOREIGN KEY (order_id, supersedes_version) REFERENCES paper_order_owners,
    CHECK ((ownership_version = 1 AND supersedes_version IS NULL) OR
           (ownership_version > 1 AND supersedes_version IS NOT NULL
            AND supersedes_version > 0 AND supersedes_version < ownership_version)),
    CHECK ((attribution_status = 'unknown') =
           (account_id = 'legacy_unattributed' AND strategy_id = 'unknown'))
);

CREATE TABLE paper_ledger_owners (
    event_id bigint NOT NULL REFERENCES paper_ledger_events (event_id),
    ownership_version integer NOT NULL DEFAULT 1 CHECK (ownership_version > 0),
    account_id text NOT NULL,
    strategy_id text NOT NULL,
    attribution_status text NOT NULL CHECK (attribution_status IN ('verified', 'unknown')),
    evidence_ref text NOT NULL CHECK (char_length(btrim(evidence_ref)) > 0),
    supersedes_version integer,
    recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, ownership_version, account_id, strategy_id),
    FOREIGN KEY (account_id, strategy_id) REFERENCES paper_financial_owners,
    CHECK ((ownership_version = 1 AND supersedes_version IS NULL) OR
           (ownership_version > 1 AND supersedes_version IS NOT NULL
            AND supersedes_version > 0 AND supersedes_version < ownership_version)),
    CHECK ((attribution_status = 'unknown') =
           (account_id = 'legacy_unattributed' AND strategy_id = 'unknown'))
);
CREATE INDEX paper_ledger_owners_owner_event_idx
    ON paper_ledger_owners (account_id, strategy_id, event_id);

CREATE TABLE paper_owner_positions (
    account_id text NOT NULL,
    strategy_id text NOT NULL,
    token_id text NOT NULL CHECK (char_length(token_id) BETWEEN 1 AND 128),
    ownership_version integer NOT NULL DEFAULT 1 CHECK (ownership_version > 0),
    accounting_version text NOT NULL DEFAULT 'financial-v2' CHECK (char_length(accounting_version) > 0),
    condition_id text,
    outcome text CHECK (outcome IN ('affirmative', 'complement')),
    shares text NOT NULL DEFAULT '0.000000000'
        CHECK (shares ~ '^-?(0|[1-9][0-9]*)\.[0-9]{9}$' AND shares <> '-0.000000000'),
    cost_basis_usd text NOT NULL DEFAULT '0.000000000'
        CHECK (cost_basis_usd ~ '^(0|[1-9][0-9]*)\.[0-9]{9}$'),
    realized_pnl_usd text NOT NULL DEFAULT '0.000000000'
        CHECK (realized_pnl_usd ~ '^-?(0|[1-9][0-9]*)\.[0-9]{9}$' AND realized_pnl_usd <> '-0.000000000'),
    fees_paid_usd text NOT NULL DEFAULT '0.000000000'
        CHECK (fees_paid_usd ~ '^(0|[1-9][0-9]*)\.[0-9]{9}$'),
    opened_at timestamptz,
    resolved_at timestamptz,
    mark_value_signed_usd text
        CHECK (mark_value_signed_usd ~ '^-?(0|[1-9][0-9]*)\.[0-9]{9}$' AND mark_value_signed_usd <> '-0.000000000'),
    mark_stale boolean NOT NULL DEFAULT true,
    mark_source_ts timestamptz,
    mark_received_at timestamptz,
    last_event_id bigint REFERENCES paper_ledger_events (event_id),
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, strategy_id, token_id, ownership_version, accounting_version),
    FOREIGN KEY (account_id, strategy_id) REFERENCES paper_financial_owners
);

CREATE FUNCTION paper_ownership_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'FIN02_OWNERSHIP_APPEND_ONLY: ' || TG_TABLE_NAME || ' ' || TG_OP;
END;
$$;

-- New evidence shares DATA-02's writer lock and unconditional HOLD. Existing
-- 0023 table inventory/guards stay intact; there is no deletion/pin exemption.
DO $$
DECLARE evidence_table text;
BEGIN
    FOREACH evidence_table IN ARRAY ARRAY[
        'paper_financial_owners', 'paper_order_owners', 'paper_ledger_owners', 'paper_owner_positions'
    ] LOOP
        EXECUTE format('CREATE TRIGGER retention_evidence_write_lock_trg '
            'BEFORE INSERT OR UPDATE ON %I FOR EACH STATEMENT '
            'EXECUTE FUNCTION retention_evidence_writer_lock()', evidence_table);
        EXECUTE format('CREATE TRIGGER retention_evidence_delete_guard_trg '
            'BEFORE DELETE OR TRUNCATE ON %I FOR EACH STATEMENT '
            'EXECUTE FUNCTION retention_evidence_delete_guard()', evidence_table);
        IF evidence_table <> 'paper_owner_positions' THEN
            EXECUTE format('CREATE TRIGGER paper_ownership_append_only_trg '
                'BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT '
                'EXECUTE FUNCTION paper_ownership_append_only()', evidence_table);
        END IF;
    END LOOP;
END;
$$;

-- Unknown capital blocks absolute equity/admission even when the order's
-- prospective owner is verified. No default bankroll is copied per strategy.
INSERT INTO paper_financial_owners (account_id, strategy_id, initial_cash_usd, capital_source_ref)
VALUES ('legacy_unattributed', 'unknown', NULL, 'unestablished:FIN-02');

CREATE FUNCTION paper_order_financial_identity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.order_id, NEW.token_id, NEW.condition_id, NEW.side, NEW.size, NEW.source, NEW.strategy_id,
           NEW.decision_id, NEW.limit_price, NEW.order_type, NEW.worst_price, NEW.amount_usd, NEW.post_only, NEW.expiration_s)
       IS DISTINCT FROM ROW(OLD.order_id, OLD.token_id, OLD.condition_id, OLD.side, OLD.size, OLD.source, OLD.strategy_id,
           OLD.decision_id, OLD.limit_price, OLD.order_type, OLD.worst_price, OLD.amount_usd, OLD.post_only, OLD.expiration_s) THEN
        RAISE EXCEPTION 'FIN02_ORDER_IDENTITY_IMMUTABLE: %', OLD.order_id;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER paper_order_financial_identity_guard_trg
    BEFORE UPDATE ON paper_orders FOR EACH ROW EXECUTE FUNCTION paper_order_financial_identity_guard();

CREATE FUNCTION paper_order_assign_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE owner_strategy text := CASE WHEN NEW.source = 'fast' THEN NEW.strategy_id ELSE 'main' END;
BEGIN
    IF NEW.source = 'fast' AND owner_strategy = 'main' THEN
        RAISE EXCEPTION 'FIN02_OWNERSHIP_CONFLICT: main is reserved for the primary paper strategy';
    END IF;
    INSERT INTO paper_financial_owners (account_id, strategy_id, initial_cash_usd, capital_source_ref)
    VALUES ('paper', owner_strategy, NULL, 'unestablished:FIN-02') ON CONFLICT DO NOTHING;
    INSERT INTO paper_order_owners
        (order_id, account_id, strategy_id, attribution_status, evidence_ref)
    VALUES (NEW.order_id, 'paper', owner_strategy, 'verified',
        'FIN-02:prospective:' || NEW.source || ':order:' || NEW.order_id);
    RETURN NULL;
END;
$$;
CREATE TRIGGER paper_order_assign_owner_trg
    AFTER INSERT ON paper_orders FOR EACH ROW EXECUTE FUNCTION paper_order_assign_owner();

CREATE VIEW paper_attributed_ledger_v1 AS
SELECT e.*, COALESCE(o.account_id, 'legacy_unattributed') AS account_id,
       COALESCE(o.strategy_id, 'unknown') AS strategy_id,
       COALESCE(o.ownership_version, 1) AS ownership_version,
       COALESCE(o.attribution_status, 'unknown') AS attribution_status,
       COALESCE(o.evidence_ref, 'FIN-02:legacy:no-attribution-evidence') AS evidence_ref
FROM paper_ledger_events e
LEFT JOIN paper_ledger_owners o ON o.event_id = e.event_id AND o.ownership_version = 1;

-- Same accepted string precision as parseScaled; invalid historical payloads
-- remain untouched and do not suddenly become ownership/settlement evidence.
CREATE FUNCTION paper_financial_decimal9(value jsonb) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE WHEN jsonb_typeof(value) = 'string'
        AND value #>> '{}' ~ '^-?[0-9]+(\.[0-9]{1,9}0*)?$'
        THEN (value #>> '{}')::numeric END
$$;

-- Ownership membership only, not a cash/equity/exposure calculation. Exact
-- numeric quantities retain both owners when their signed token amounts net 0.
-- Strict cutoff excludes a just-inserted resolution from its own owner set.
CREATE FUNCTION paper_open_owner_tokens(
    before_event_ts timestamptz DEFAULT NULL,
    before_idempotency_key text DEFAULT NULL,
    exclude_event_id bigint DEFAULT NULL,
    for_token_id text DEFAULT NULL
) RETURNS TABLE (account_id text, strategy_id text, token_id text, condition_id text, shares numeric)
LANGUAGE sql VOLATILE AS $$
    WITH events AS MATERIALIZED (
        SELECT e.* FROM paper_attributed_ledger_v1 e
        WHERE e.event_type IN ('fill', 'resolution') AND e.token_id IS NOT NULL
          AND (for_token_id IS NULL OR e.token_id = for_token_id)
          AND ((e.event_type = 'fill' AND e.payload_json->>'side' IN ('BUY', 'SELL')
                AND paper_financial_decimal9(e.payload_json->'price') IS NOT NULL
                AND paper_financial_decimal9(e.payload_json->'size') IS NOT NULL)
               OR (e.event_type = 'resolution'
                   AND paper_financial_decimal9(e.payload_json->'outcome_price') IS NOT NULL))
          AND (exclude_event_id IS NULL OR e.event_id <> exclude_event_id)
          AND (before_event_ts IS NULL OR e.event_ts < before_event_ts OR
               (e.event_ts = before_event_ts AND e.idempotency_key < before_idempotency_key))
    ), resolutions AS (
        SELECT DISTINCT ON (e.account_id, e.strategy_id, e.token_id)
            e.account_id, e.strategy_id, e.token_id, e.event_ts, e.idempotency_key
        FROM events e WHERE e.event_type = 'resolution'
        ORDER BY e.account_id, e.strategy_id, e.token_id, e.event_ts DESC, e.idempotency_key DESC
    )
    SELECT e.account_id, e.strategy_id, e.token_id, max(e.condition_id),
           sum((CASE e.payload_json->>'side' WHEN 'BUY' THEN 1 WHEN 'SELL' THEN -1 END)
               * paper_financial_decimal9(e.payload_json->'size')) AS shares
    FROM events e LEFT JOIN resolutions r
      ON (r.account_id, r.strategy_id, r.token_id) = (e.account_id, e.strategy_id, e.token_id)
    WHERE e.event_type = 'fill' AND (r.event_ts IS NULL OR
          (e.event_ts, e.idempotency_key) > (r.event_ts, r.idempotency_key))
    GROUP BY e.account_id, e.strategy_id, e.token_id
    HAVING sum((CASE e.payload_json->>'side' WHEN 'BUY' THEN 1 WHEN 'SELL' THEN -1 END)
               * paper_financial_decimal9(e.payload_json->'size')) <> 0
$$;

CREATE FUNCTION paper_ledger_retry_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE previous paper_ledger_events%ROWTYPE;
BEGIN
    -- Raw/bare-pool producers use the broker's existing order -> token order.
    -- Reentrant locks are harmless when the broker already holds these keys.
    IF NEW.order_id IS NOT NULL THEN
        PERFORM 1 FROM paper_orders WHERE order_id = NEW.order_id FOR KEY SHARE;
    END IF;
    IF NEW.token_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.token_id, 0));
    END IF;
    -- Existing broker lock order remains order/token, then this key. Concurrent
    -- retries compare the winner after commit rather than silently swallowing a
    -- different financial event under ON CONFLICT DO NOTHING.
    PERFORM pg_advisory_xact_lock(hashtextextended('FIN-02:ledger:' || NEW.idempotency_key, 0));
    SELECT * INTO previous FROM paper_ledger_events WHERE idempotency_key = NEW.idempotency_key;
    IF FOUND THEN
        IF ROW(NEW.event_type, NEW.order_id, NEW.token_id, NEW.condition_id)
           IS DISTINCT FROM ROW(previous.event_type, previous.order_id, previous.token_id, previous.condition_id)
           OR (NEW.event_type NOT IN ('mark', 'kill_switch_engaged', 'kill_switch_rearmed')
               AND NEW.payload_json IS DISTINCT FROM previous.payload_json)
           OR (NEW.event_type IN ('fill', 'resolution') AND NEW.event_ts IS DISTINCT FROM previous.event_ts) THEN
            RAISE EXCEPTION 'FIN02_IDEMPOTENCY_CONFLICT: %', NEW.idempotency_key;
        END IF;
        -- Non-monetary producers restamp retries. Their first instant wins;
        -- monetary timestamps above must agree. No stored row is updated.
        NEW.event_ts := previous.event_ts;
    ELSE
        IF NEW.event_type = 'fill' AND (
            NEW.payload_json->>'side' IS NULL OR NEW.payload_json->>'side' NOT IN ('BUY', 'SELL')
            OR paper_financial_decimal9(NEW.payload_json->'size') IS NULL
            OR paper_financial_decimal9(NEW.payload_json->'size') <= 0
            OR paper_financial_decimal9(NEW.payload_json->'price') IS NULL
            OR paper_financial_decimal9(NEW.payload_json->'price') NOT BETWEEN 0 AND 1
        ) THEN
            RAISE EXCEPTION 'FIN02_FINANCIAL_PAYLOAD_INVALID: fill %', NEW.idempotency_key;
        END IF;
        IF NEW.event_type = 'resolution' AND (
            paper_financial_decimal9(NEW.payload_json->'outcome_price') IS NULL
            OR paper_financial_decimal9(NEW.payload_json->'outcome_price') NOT BETWEEN 0 AND 1
        ) THEN
            RAISE EXCEPTION 'FIN02_FINANCIAL_PAYLOAD_INVALID: resolution %', NEW.idempotency_key;
        END IF;
        IF NEW.event_type IN ('fill', 'resolution', 'mark') AND NEW.payload_json ? 'fee' AND (
            paper_financial_decimal9(NEW.payload_json->'fee') IS NULL
            OR paper_financial_decimal9(NEW.payload_json->'fee') < 0
        ) THEN
            RAISE EXCEPTION 'FIN02_FINANCIAL_PAYLOAD_INVALID: fee %', NEW.idempotency_key;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER paper_ledger_retry_guard_trg
    BEFORE INSERT ON paper_ledger_events FOR EACH ROW EXECUTE FUNCTION paper_ledger_retry_guard();

CREATE FUNCTION paper_ledger_owner_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE event paper_ledger_events%ROWTYPE;
        bound paper_order_owners%ROWTYPE;
        original paper_orders%ROWTYPE;
        open_count integer;
        matched_count integer;
BEGIN
    SELECT * INTO STRICT event FROM paper_ledger_events WHERE event_id = NEW.event_id;
    IF NEW.supersedes_version IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM paper_ledger_owners WHERE event_id = NEW.event_id
        AND ownership_version = NEW.supersedes_version
    ) THEN
        RAISE EXCEPTION 'FIN02_OWNERSHIP_CONFLICT: missing prior attribution';
    END IF;
    IF event.order_id IS NOT NULL THEN
        SELECT * INTO original FROM paper_orders WHERE order_id = event.order_id;
        IF FOUND THEN
            SELECT * INTO bound FROM paper_order_owners
            WHERE order_id = event.order_id AND ownership_version = NEW.ownership_version;
            IF NOT FOUND OR ROW(NEW.account_id, NEW.strategy_id, NEW.attribution_status)
               IS DISTINCT FROM ROW(bound.account_id, bound.strategy_id, bound.attribution_status)
               OR ROW(event.token_id, event.condition_id)
               IS DISTINCT FROM ROW(original.token_id, original.condition_id)
               OR (event.event_type = 'fill' AND event.payload_json->>'side' IS DISTINCT FROM original.side) THEN
                RAISE EXCEPTION 'FIN02_OWNERSHIP_CONFLICT: event % must match frozen order %', event.event_id, event.order_id;
            END IF;
        ELSIF event.event_type <> 'order_rejected' OR NEW.attribution_status <> 'unknown' THEN
            RAISE EXCEPTION 'FIN02_OWNERSHIP_CONFLICT: missing order %', event.order_id;
        END IF;
    ELSIF event.event_type IN ('resolution', 'mark') AND NEW.ownership_version = 1 THEN
        SELECT count(*), count(*) FILTER (WHERE o.account_id = NEW.account_id
            AND o.strategy_id = NEW.strategy_id AND o.condition_id IS NOT DISTINCT FROM event.condition_id)
        INTO open_count, matched_count
        FROM paper_open_owner_tokens(event.event_ts, event.idempotency_key, event.event_id, event.token_id) o;
        IF event.token_id IS NULL OR (matched_count <> 1 AND
           NOT (open_count = 0 AND NEW.attribution_status = 'unknown')) THEN
            RAISE EXCEPTION 'FIN02_OWNERSHIP_CONFLICT: global event must match open token owner/condition';
        END IF;
        IF open_count > 1 AND COALESCE(paper_financial_decimal9(event.payload_json->'fee'), 0) <> 0 THEN
            RAISE EXCEPTION 'FIN02_GLOBAL_FEE_UNATTRIBUTED: %', event.idempotency_key;
        END IF;
    ELSIF event.event_type = 'order_rejected' AND NEW.attribution_status <> 'unknown' THEN
        RAISE EXCEPTION 'FIN02_OWNERSHIP_CONFLICT: rejection has no order evidence';
    ELSIF event.event_type NOT IN ('resolution', 'mark', 'order_rejected') THEN
        RAISE EXCEPTION 'FIN02_OWNERSHIP_CONFLICT: financial event requires an order';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER paper_ledger_owner_validate_trg
    BEFORE INSERT ON paper_ledger_owners FOR EACH ROW EXECUTE FUNCTION paper_ledger_owner_validate();

CREATE FUNCTION paper_late_owner_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE event paper_ledger_events%ROWTYPE;
BEGIN
    SELECT * INTO STRICT event FROM paper_ledger_events WHERE event_id = NEW.event_id;
    IF event.event_type = 'fill' AND EXISTS (
        SELECT 1 FROM paper_ledger_events r
        WHERE r.event_type = 'resolution' AND r.token_id = event.token_id
          AND paper_financial_decimal9(r.payload_json->'outcome_price') IS NOT NULL
          AND (r.event_ts, r.idempotency_key) > (event.event_ts, event.idempotency_key)
          AND NOT EXISTS (
              SELECT 1 FROM paper_attributed_ledger_v1 o WHERE o.event_id = r.event_id
              AND o.ownership_version = NEW.ownership_version
              AND o.account_id = NEW.account_id AND o.strategy_id = NEW.strategy_id
          )
    ) THEN
        -- Previously unseen late owners require audited resolution attribution.
        -- Late partial fills of already associated owners remain valid.
        RAISE EXCEPTION 'FIN02_LATE_OWNER_REQUIRES_ATTRIBUTION: %', event.idempotency_key;
    END IF;
    RETURN NULL;
END;
$$;
-- Deferred only so multirow INSERT(fill,resolution) validates after every
-- AFTER INSERT attribution has run. Failure still rolls back the transaction.
CREATE CONSTRAINT TRIGGER paper_late_owner_validate_trg
    AFTER INSERT ON paper_ledger_owners DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION paper_late_owner_validate();

CREATE FUNCTION paper_ledger_assign_owners() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE affected_count integer;
BEGIN
    IF NEW.event_type IN ('kill_switch_engaged', 'kill_switch_rearmed') THEN
        RETURN NULL; -- Global diagnostics carry no invented monetary owner.
    END IF;
    IF NEW.order_id IS NOT NULL AND EXISTS (SELECT 1 FROM paper_orders WHERE order_id = NEW.order_id) THEN
        -- Only new prospective orders have evidence. An old order encountered
        -- by a new fill/cancel stays unknown, even when strategy_id is present.
        INSERT INTO paper_order_owners (order_id, account_id, strategy_id, attribution_status, evidence_ref)
        VALUES (NEW.order_id, 'legacy_unattributed', 'unknown', 'unknown',
            'FIN-02:legacy:order:' || NEW.order_id) ON CONFLICT DO NOTHING;
        INSERT INTO paper_ledger_owners (event_id, account_id, strategy_id, attribution_status, evidence_ref)
        SELECT NEW.event_id, o.account_id, o.strategy_id, o.attribution_status, o.evidence_ref
        FROM paper_order_owners o WHERE o.order_id = NEW.order_id AND o.ownership_version = 1;
    ELSIF NEW.event_type IN ('resolution', 'mark') AND NEW.order_id IS NULL AND NEW.token_id IS NOT NULL THEN
        INSERT INTO paper_ledger_owners (event_id, account_id, strategy_id, attribution_status, evidence_ref)
        SELECT NEW.event_id, o.account_id, o.strategy_id,
            CASE WHEN o.account_id = 'legacy_unattributed' AND o.strategy_id = 'unknown' THEN 'unknown' ELSE 'verified' END,
            'FIN-02:open-token:' || NEW.token_id || ':at:' || NEW.idempotency_key
        FROM paper_open_owner_tokens(NEW.event_ts, NEW.idempotency_key, NEW.event_id, NEW.token_id) o;
        GET DIAGNOSTICS affected_count = ROW_COUNT;
        IF affected_count > 1 AND COALESCE(paper_financial_decimal9(NEW.payload_json->'fee'), 0) <> 0 THEN
            RAISE EXCEPTION 'FIN02_GLOBAL_FEE_UNATTRIBUTED: %', NEW.idempotency_key;
        END IF;
        IF affected_count = 0 THEN
            INSERT INTO paper_ledger_owners (event_id, account_id, strategy_id, attribution_status, evidence_ref)
            VALUES (NEW.event_id, 'legacy_unattributed', 'unknown', 'unknown', 'FIN-02:legacy:no-open-owner-evidence');
        END IF;
    ELSIF NEW.event_type = 'order_rejected' THEN
        INSERT INTO paper_ledger_owners (event_id, account_id, strategy_id, attribution_status, evidence_ref)
        VALUES (NEW.event_id, 'legacy_unattributed', 'unknown', 'unknown', 'FIN-02:rejection:no-order-evidence');
    ELSE
        RAISE EXCEPTION 'FIN02_OWNERSHIP_CONFLICT: event % has no provable order/token', NEW.idempotency_key;
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER paper_ledger_assign_owners_trg
    AFTER INSERT ON paper_ledger_events FOR EACH ROW EXECUTE FUNCTION paper_ledger_assign_owners();

INSERT INTO schema_versions (component, version, checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component, version) DO NOTHING;
