-- G2-06.1. Derived read models only. No account activation or ledger changes.
-- Old accounts remain explicitly unavailable until an append/audited recovery
-- builds their financial projection. Production has no accounts at rollout.
ALTER TABLE btc_ledger_projections ADD COLUMN desk_projection JSONB
  CHECK(desk_projection IS NULL OR desk_projection->>'schema_version' = 'btc.desk-projection.v1');

CREATE TABLE btc_desk_orders (
  account_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  filled_btc_raw NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK(filled_btc_raw >= 0),
  reservation JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(account_id,order_id),
  FOREIGN KEY(account_id,order_id) REFERENCES btc_order_acceptances(account_id,order_id)
);
CREATE INDEX btc_desk_active_orders ON btc_desk_orders(account_id,order_id)
  WHERE reservation->>'status' = 'active';
INSERT INTO btc_desk_orders(account_id,order_id,sequence,reservation,recorded_at,filled_btc_raw)
SELECT DISTINCT ON(account_id,order_id) account_id,order_id,sequence,reservation,recorded_at,
  SUM(CASE WHEN action='consume' THEN (request->>'quantity_btc_raw')::numeric ELSE 0 END)
    OVER(PARTITION BY account_id,order_id)
FROM btc_reservation_events ORDER BY account_id,order_id,sequence DESC;
CREATE FUNCTION btc_desk_order_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO btc_desk_orders(account_id,order_id,sequence,reservation,recorded_at,filled_btc_raw)
  VALUES(NEW.account_id,NEW.order_id,NEW.sequence,NEW.reservation,NEW.recorded_at,
    CASE WHEN NEW.action='consume' THEN (NEW.request->>'quantity_btc_raw')::numeric ELSE 0 END)
  ON CONFLICT(account_id,order_id) DO UPDATE
    SET sequence=EXCLUDED.sequence,reservation=EXCLUDED.reservation,recorded_at=EXCLUDED.recorded_at,
        filled_btc_raw=btc_desk_orders.filled_btc_raw+EXCLUDED.filled_btc_raw
    WHERE btc_desk_orders.sequence < EXCLUDED.sequence;
  RETURN NEW;
END $$;
CREATE TRIGGER btc_desk_order_projection AFTER INSERT ON btc_reservation_events
FOR EACH ROW EXECUTE FUNCTION btc_desk_order_head();

INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT (component,version) DO NOTHING;
