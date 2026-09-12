-- DB-03 candidate; promotion requires the measured plan in DB-03-asof-plan.md.
-- $1 symbols, $2 feeds, $3 decision timestamp; no TTL/price lower-bound filter.
SELECT sample.symbol, sample.feed, sample.price, sample.source_ts, sample.received_at
FROM (SELECT DISTINCT unnest($1::text[]) AS symbol) symbols
CROSS JOIN (SELECT DISTINCT unnest($2::text[]) AS feed) feeds
CROSS JOIN LATERAL (
    SELECT symbol, feed, price, source_ts, received_at
    FROM polymarket_rtds_prices
    WHERE symbol = symbols.symbol AND feed = feeds.feed
      AND COALESCE(source_ts, received_at) <= $3
      AND received_at <= $3
    ORDER BY COALESCE(source_ts, received_at) DESC, rtds_price_id DESC
    LIMIT 1
) sample
ORDER BY sample.symbol, sample.feed;
