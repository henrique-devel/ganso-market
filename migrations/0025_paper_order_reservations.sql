-- FIN-05: additive, reconstructible reservation-v1 projection; no capital seed.
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '5s';

CREATE TABLE paper_order_reservations (
    order_id text PRIMARY KEY,
    ownership_version integer NOT NULL CHECK (ownership_version = 1),
    account_id text NOT NULL,
    strategy_id text NOT NULL,
    reservation_version text NOT NULL CHECK (reservation_version = 'reservation-v1'),
    cash_remaining_usd numeric NOT NULL CHECK (cash_remaining_usd >= 0 AND scale(cash_remaining_usd) <= 9),
    risk_remaining_usd numeric NOT NULL CHECK (risk_remaining_usd >= 0 AND scale(risk_remaining_usd) <= 9),
    shares_remaining numeric NOT NULL CHECK (shares_remaining >= 0 AND scale(shares_remaining) <= 9),
    inventory_side text CHECK (inventory_side IN ('BUY','SELL')),
    state text NOT NULL CHECK (state IN ('active','consumed','released')),
    last_event_id bigint NOT NULL REFERENCES paper_ledger_events,
    updated_at timestamptz NOT NULL,
    FOREIGN KEY (order_id, ownership_version) REFERENCES paper_order_owners,
    FOREIGN KEY (account_id, strategy_id) REFERENCES paper_financial_owners,
    CHECK (state = 'active' OR (cash_remaining_usd = 0 AND risk_remaining_usd = 0 AND shares_remaining = 0))
);
CREATE INDEX paper_order_reservations_owner_idx ON paper_order_reservations (account_id,strategy_id) WHERE state='active';
CREATE TRIGGER retention_evidence_write_lock_trg BEFORE INSERT OR UPDATE ON paper_order_reservations
    FOR EACH STATEMENT EXECUTE FUNCTION retention_evidence_writer_lock();
CREATE TRIGGER retention_evidence_delete_guard_trg BEFORE DELETE OR TRUNCATE ON paper_order_reservations
    FOR EACH STATEMENT EXECUTE FUNCTION retention_evidence_delete_guard();

CREATE FUNCTION paper_reservation_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM paper_order_owners a WHERE a.order_id=NEW.order_id
        AND a.ownership_version=NEW.ownership_version AND a.account_id=NEW.account_id AND a.strategy_id=NEW.strategy_id) THEN
        RAISE EXCEPTION 'FIN05_OWNER_CONFLICT';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER paper_reservation_identity_guard_trg BEFORE INSERT OR UPDATE ON paper_order_reservations
    FOR EACH ROW EXECUTE FUNCTION paper_reservation_identity_guard();

-- Rebuild from immutable accepts, fills and effective terminal events, never
-- from order status/filled_size or elapsed time. Repeating it changes no value.
CREATE FUNCTION paper_reconcile_reservations(owner_account text, owner_strategy text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM paper_financial_owners WHERE account_id=owner_account AND strategy_id=owner_strategy FOR NO KEY UPDATE;
    INSERT INTO paper_order_reservations
        (order_id,ownership_version,account_id,strategy_id,reservation_version,cash_remaining_usd,
         risk_remaining_usd,shares_remaining,inventory_side,state,last_event_id,updated_at)
    SELECT o.order_id,1,a.account_id,a.strategy_id,'reservation-v1',
        round(ceil(leftover.qty * (e.payload_json->'reservation'->>'cash_per_share')::numeric * 1e9)/1e9,9),
        round(ceil(leftover.qty * (e.payload_json->'reservation'->>'risk_per_share')::numeric * 1e9)/1e9,9),
        leftover.qty,e.payload_json->'reservation'->>'inventory_side',
        CASE WHEN effects.filled >= o.size::numeric THEN 'consumed' WHEN effects.terminal THEN 'released' ELSE 'active' END,
        effects.last_id,effects.last_ts
    FROM paper_orders o JOIN paper_order_owners a ON a.order_id=o.order_id AND a.ownership_version=1
    JOIN paper_ledger_events e ON e.order_id=o.order_id AND e.event_type='order_accepted'
    CROSS JOIN LATERAL (
        SELECT COALESCE(sum((x.payload_json->>'size')::numeric) FILTER (WHERE x.event_type='fill' AND x.order_id=o.order_id),0) AS filled,
            COALESCE(bool_or(x.event_type IN ('cancel_effective','expired','resolution')),false) AS terminal,
            max(x.event_id) AS last_id,max(x.event_ts) AS last_ts
        FROM paper_ledger_events x WHERE (x.order_id=o.order_id OR (x.event_type='resolution'
            AND (x.token_id=o.token_id OR x.condition_id=o.condition_id))) AND x.event_id>=e.event_id
            AND x.event_type IN ('order_accepted','fill','cancel_effective','expired','resolution')
    ) effects
    CROSS JOIN LATERAL (SELECT CASE WHEN effects.terminal THEN 0 ELSE greatest(0,o.size::numeric-effects.filled) END AS qty) leftover
    WHERE a.account_id=owner_account AND a.strategy_id=owner_strategy
        AND e.payload_json->'reservation'->>'version'='reservation-v1'
    ON CONFLICT (order_id) DO UPDATE SET cash_remaining_usd=EXCLUDED.cash_remaining_usd,
        risk_remaining_usd=EXCLUDED.risk_remaining_usd,shares_remaining=EXCLUDED.shares_remaining,
        state=EXCLUDED.state,last_event_id=EXCLUDED.last_event_id,updated_at=EXCLUDED.updated_at
    WHERE ROW(paper_order_reservations.cash_remaining_usd,paper_order_reservations.risk_remaining_usd,
        paper_order_reservations.shares_remaining,paper_order_reservations.state,paper_order_reservations.last_event_id,paper_order_reservations.updated_at)
        IS DISTINCT FROM ROW(EXCLUDED.cash_remaining_usd,EXCLUDED.risk_remaining_usd,EXCLUDED.shares_remaining,
            EXCLUDED.state,EXCLUDED.last_event_id,EXCLUDED.updated_at);
END;
$$;

-- FIN-02's BEFORE retry trigger acquires order/token first. Lock the financial
-- owner for ALL monetary writers, including pre-reservation orders. Sorted
-- owners give a deterministic order for global resolution and opposing owners.
CREATE FUNCTION paper_reservation_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r paper_order_reservations%ROWTYPE; o paper_orders%ROWTYPE; c jsonb;
BEGIN
    IF NEW.event_type NOT IN ('order_accepted','fill','cancel_effective','expired','resolution') THEN RETURN NEW; END IF;
    PERFORM 1 FROM paper_financial_owners f WHERE EXISTS (
        SELECT 1 FROM paper_order_owners a JOIN paper_orders p USING(order_id)
        WHERE a.ownership_version=1 AND a.account_id=f.account_id AND a.strategy_id=f.strategy_id
        AND (a.order_id=NEW.order_id OR (NEW.event_type='resolution' AND (p.token_id=NEW.token_id OR p.condition_id=NEW.condition_id)))
    ) OR (NEW.event_type='resolution' AND EXISTS (
        SELECT 1 FROM paper_ledger_owners a JOIN paper_ledger_events e USING(event_id)
        WHERE a.ownership_version=1 AND a.account_id=f.account_id AND a.strategy_id=f.strategy_id AND e.token_id=NEW.token_id
    )) ORDER BY f.account_id,f.strategy_id FOR NO KEY UPDATE;
    IF EXISTS (SELECT 1 FROM paper_ledger_events WHERE idempotency_key=NEW.idempotency_key) THEN RETURN NEW; END IF;
    IF NEW.event_type='resolution' AND EXISTS (
        SELECT 1 FROM paper_order_reservations r JOIN paper_orders p USING(order_id)
        JOIN paper_ledger_events e ON e.order_id=p.order_id AND e.event_type='fill'
        WHERE p.token_id=NEW.token_id AND (e.event_ts,e.idempotency_key) > (NEW.event_ts,NEW.idempotency_key)
    ) THEN RAISE EXCEPTION 'FIN05_RESOLUTION_BEFORE_FILL'; END IF;
    SELECT * INTO o FROM paper_orders WHERE order_id=NEW.order_id;
    IF NEW.event_type='order_accepted' AND NEW.payload_json ? 'reservation' THEN
        c := NEW.payload_json->'reservation';
        IF c->>'version' IS DISTINCT FROM 'reservation-v1' OR c->>'ownership_version' IS DISTINCT FROM '1'
            OR c->>'accounting_version' IS DISTINCT FROM 'financial-v2' OR c->>'risk_version' IS DISTINCT FROM 'payoff-v1'
            OR NOT EXISTS (SELECT 1 FROM paper_order_owners a WHERE a.order_id=NEW.order_id AND a.ownership_version=1
                AND a.account_id=c->>'account_id' AND a.strategy_id=c->>'strategy_id')
            OR NOT (paper_financial_decimal9(c->'cash_per_share') >= 0 AND paper_financial_decimal9(c->'risk_per_share') >= 0
                AND paper_financial_decimal9(c->'fee_per_share') >= 0 AND paper_financial_decimal9(c->'price_bound') BETWEEN 0 AND 1)
            OR paper_financial_decimal9(c->'cash_per_share') IS NULL OR paper_financial_decimal9(c->'risk_per_share') IS NULL
            OR paper_financial_decimal9(c->'fee_per_share') IS NULL OR paper_financial_decimal9(c->'price_bound') IS NULL THEN
            RAISE EXCEPTION 'FIN05_CONTRACT_INVALID';
        END IF;
        IF EXISTS (SELECT 1 FROM paper_ledger_events WHERE order_id=NEW.order_id AND event_type='order_accepted') THEN
            RAISE EXCEPTION 'FIN05_ACCEPTANCE_CONFLICT';
        END IF;
    ELSIF NEW.event_type='fill' THEN
        SELECT * INTO r FROM paper_order_reservations WHERE order_id=NEW.order_id;
        IF FOUND THEN
            SELECT payload_json->'reservation' INTO c FROM paper_ledger_events WHERE order_id=NEW.order_id AND event_type='order_accepted';
            IF r.state<>'active' OR (NEW.payload_json->>'size')::numeric > r.shares_remaining
                OR NEW.event_ts < r.updated_at
                OR (o.side='BUY' AND (NEW.payload_json->>'price')::numeric > (c->>'price_bound')::numeric)
                OR (o.side='SELL' AND (NEW.payload_json->>'price')::numeric < (c->>'price_bound')::numeric)
                OR COALESCE((NEW.payload_json->>'fee')::numeric,0) > ceil((NEW.payload_json->>'size')::numeric * (c->>'fee_per_share')::numeric * 1e9)/1e9 THEN
                RAISE EXCEPTION 'FIN05_FILL_OUTSIDE_RESERVATION';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER paper_reservation_event_guard_trg BEFORE INSERT ON paper_ledger_events
    FOR EACH ROW EXECUTE FUNCTION paper_reservation_event_guard();

-- A final constraint on event cashflows covers fractional-nano rounding across
-- multiple fills as well as bare-pool financial writers. Rounding matches
-- financial-v2 (half away from zero), while reservations round upward.
CREATE FUNCTION paper_reservation_assert_balances(owner_account text, owner_strategy text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE cash numeric; held numeric;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM paper_order_reservations WHERE account_id=owner_account AND strategy_id=owner_strategy) THEN RETURN; END IF;
    SELECT initial_cash_usd::numeric INTO cash FROM paper_financial_owners
        WHERE account_id=owner_account AND strategy_id=owner_strategy;
    SELECT cash + COALESCE(sum(CASE WHEN e.event_type='fill' THEN
        (CASE e.payload_json->>'side' WHEN 'BUY' THEN -1 ELSE 1 END)
            * round((e.payload_json->>'size')::numeric * (e.payload_json->>'price')::numeric,9)
        ELSE round(COALESCE((SELECT p.shares FROM paper_open_owner_tokens(e.event_ts,e.idempotency_key,e.event_id,e.token_id) p
            WHERE p.account_id=owner_account AND p.strategy_id=owner_strategy),0) * (e.payload_json->>'outcome_price')::numeric,9)
        END - COALESCE((e.payload_json->>'fee')::numeric,0)),0) INTO cash
    FROM paper_attributed_ledger_v1 e WHERE e.account_id=owner_account AND e.strategy_id=owner_strategy
        AND e.event_type IN ('fill','resolution');
    SELECT COALESCE(sum(cash_remaining_usd),0) INTO held FROM paper_order_reservations
        WHERE account_id=owner_account AND strategy_id=owner_strategy;
    IF cash IS NULL OR cash < held THEN RAISE EXCEPTION 'FIN05_CASH_UNAVAILABLE'; END IF;
    IF EXISTS (
        SELECT 1 FROM paper_order_reservations r JOIN paper_orders o USING(order_id)
        LEFT JOIN LATERAL paper_open_owner_tokens(for_token_id => o.token_id) p ON p.account_id=r.account_id AND p.strategy_id=r.strategy_id AND p.token_id=o.token_id
        WHERE r.account_id=owner_account AND r.strategy_id=owner_strategy AND r.state='active' AND r.inventory_side IS NOT NULL
        GROUP BY o.token_id,r.inventory_side,p.shares
        HAVING sum(r.shares_remaining) > greatest(0,COALESCE(p.shares,0) * CASE r.inventory_side WHEN 'SELL' THEN 1 ELSE -1 END)
    ) THEN RAISE EXCEPTION 'FIN05_INVENTORY_UNAVAILABLE'; END IF;
END;
$$;

CREATE FUNCTION paper_reservation_event_project() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner record;
BEGIN
    IF NEW.event_type NOT IN ('order_accepted','fill','cancel_effective','expired','resolution') THEN RETURN NULL; END IF;
    FOR owner IN SELECT DISTINCT a.account_id,a.strategy_id FROM paper_order_owners a JOIN paper_orders p USING(order_id)
        WHERE a.ownership_version=1 AND (p.order_id=NEW.order_id OR (NEW.event_type='resolution'
            AND (p.token_id=NEW.token_id OR p.condition_id=NEW.condition_id))) ORDER BY a.account_id,a.strategy_id
    LOOP
        PERFORM paper_reconcile_reservations(owner.account_id,owner.strategy_id);
        PERFORM paper_reservation_assert_balances(owner.account_id,owner.strategy_id);
    END LOOP;
    RETURN NULL;
END;
$$;
CREATE TRIGGER paper_reservation_event_project_trg AFTER INSERT ON paper_ledger_events
    FOR EACH ROW EXECUTE FUNCTION paper_reservation_event_project();

INSERT INTO schema_versions (component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum') ON CONFLICT (component,version) DO NOTHING;
