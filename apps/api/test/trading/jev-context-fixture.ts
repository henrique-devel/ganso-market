import {
  parseTradingAmount,
  type TradingMarketData,
} from "@ganso-market/contracts/trading";
import {
  type JevContextInput,
  type JevContextRecord,
} from "../../src/storage/jev-context.js";
import {
  initialJevManifest,
  validateJevManifest,
} from "../../src/storage/jev-manifest.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { jevScope } from "../../src/storage/jev-ledger.js";
import type { ClosedBar } from "../../src/trading/bars.js";
import { jevIdentity, start, iso } from "./jev-v2-fixture.js";
export function contextFixture() {
  const manifest = initialJevManifest(1),
    identity = jevIdentity(),
    cut = start + 15 * 900000 + 12000;
  identity.bindings[0]!.profile.manifest_hash = validateJevManifest(manifest);
  const amount = (unit: "BTC" | "USD_PER_BTC", raw: string) =>
    parseTradingAmount(unit, { unit, decimals: unit === "BTC" ? 8 : 6, raw });
  const record = <T>(
    object_id: string,
    payload: T,
    at = cut,
  ): JevContextRecord<T> => ({
    object_id,
    payload,
    payload_hash: jevHash(payload),
    recorded_at: iso(at),
    received_at: iso(at),
  });
  const market = (
    kind: "book" | "mark_funding" | "trade",
    at = cut - 100,
  ): TradingMarketData =>
    ({
      schema_version: "trading.market-data.v1",
      instrument_id: identity.instrument.instrument_id,
      instrument_version: identity.instrument.instrument_version,
      source_id: "hyperliquid:mainnet:ws",
      parser_version: "hyperliquid.feed.v1",
      channel:
        kind === "mark_funding"
          ? "context"
          : kind === "trade"
            ? "trades"
            : "book",
      key: kind,
      source_timestamp: iso(at),
      received_at: iso(at),
      payload_hash: "a".repeat(64),
      quality: "fresh",
      gap_epoch: 0,
      revalidation: "none",
      continuity: "unproven",
      payload:
        kind === "book"
          ? {
              kind: "book",
              semantics: "full_snapshot_top_20",
              bids: [
                {
                  price: amount("USD_PER_BTC", "100000000"),
                  quantity: amount("BTC", "100000000"),
                  orders: 1,
                },
              ],
              asks: [
                {
                  price: amount("USD_PER_BTC", "102000000"),
                  quantity: amount("BTC", "100000000"),
                  orders: 1,
                },
              ],
            }
          : kind === "mark_funding"
            ? {
                kind: "mark_funding",
                mark_price: amount("USD_PER_BTC", "101000000"),
                oracle_price: amount("USD_PER_BTC", "100000000"),
                funding_rate: { raw: "-123456789012", decimals: 15 },
                funding_semantics: "current_context_not_settled_payment",
                funding_interval_seconds: 3600,
                settlement_timestamp: null,
              }
            : {
                kind: "trade",
                side: "buy",
                price: amount("USD_PER_BTC", "100000000"),
                quantity: amount("BTC", "100000000"),
                venue_trade_id: "1",
              },
    }) as TradingMarketData;
  const scope = jevScope(identity.bindings[0]!.binding, identity.instrument);
  const bars: Array<JevContextRecord<ClosedBar>> = [];
  for (let i = 0; i < 15; i++) {
    const end = start + (15 - i) * 900000;
    bars.push(
      record(
        `bar:${i}`,
        {
          schema_version: "trading.closed-bar.v1",
          build_version: "btc-observed-bars.v1",
          instrument_id: "hyperliquid:mainnet:BTC",
          instrument_version: scope.instrument_version,
          source_id: "hyperliquid:mainnet:ws",
          interval_ms: 900000,
          start_at: iso(end - 900000),
          end_at: iso(end),
          closed_at: iso(end + 10000),
          ohlc: {
            open: "100000000",
            high: "103000000",
            low: "99000000",
            close: "100000000",
            unit: "USD_PER_BTC",
            decimals: 6,
          },
          volume: { raw: "100000000", unit: "BTC", decimals: 8 },
          trade_count: 1,
          quality: {
            state: "observed_no_known_gap",
            reasons: [],
            continuity: "unproven",
          },
          input_ids: [`dep:${i}`],
        },
        end + 10000,
      ),
    );
  }
  const input: JevContextInput = {
    cut_at: iso(cut),
    account: record("account", {
      scope,
      observed_at: iso(cut),
      cash_usd_raw: "250000000",
      equity_usd_raw: "250000000",
      position: null,
      entries_paused: false,
      risk_blocked: false,
      recovery_ready: true,
    }),
    book: record("book", market("book")),
    mark_funding: record("funding", market("mark_funding")),
    trades: [record("trade", market("trade", cut - 30000))],
    bars,
    dependencies: bars.map((r, i) => ({
      object_id: `dep:${i}`,
      payload_hash: "b".repeat(64),
      recorded_at: r.recorded_at,
      received_at: r.received_at,
    })),
    coverage: record("coverage", {
      start_at: iso(cut - 60000),
      end_at: iso(cut),
      gaps: [],
    }),
  };
  return { manifest, identity, input, record, cut };
}
