-- Read-only drilldown access paths. No rewritten financial records or activation.
CREATE INDEX btc_ioc_order_receipts ON btc_ioc_results(account_id,order_id,operation_id);
CREATE INDEX btc_desk_position_orders ON btc_desk_orders(account_id,(reservation->'order'->>'position_id'),order_id);
INSERT INTO schema_versions(component,version,checksum_sha256)
VALUES ('foundation', :'migration_version'::INTEGER, :'migration_checksum')
ON CONFLICT(component,version) DO NOTHING;
