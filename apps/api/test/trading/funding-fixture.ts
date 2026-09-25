import type { FundingCommand } from "../../src/storage/fundingstore.js";
import { FUNDING_SOURCE } from "../../src/venues/hyperliquid/funding.js";
import { iso, start } from "./ledger-fixture.js";
export const hour = Math.ceil((start + 3600000) / 3600000) * 3600000;
// Deliberately non-aligned: preserve fundingHistory.time, not a guessed hour.
export const cut = hour + 76;
export function observation(
  rate = "0.0001",
  at = cut,
): NonNullable<FundingCommand["observation"]> {
  return {
    source: FUNDING_SOURCE,
    received_at: iso(at + 9000),
    row: { coin: "BTC", time: at, fundingRate: rate, premium: "0.0002" },
  };
}
export function request(id = "fund", rate = "0.0001"): FundingCommand {
  return {
    operation_id: id,
    period_hour: iso(hour),
    observation: observation(rate),
    oracle_object_id: "funding-oracle",
  };
}

/** Synthetic HTTP proof, never a recording or live venue settlement. */
export async function seedPaperOracle(
  pool: Pick<import("../../src/database.js").DatabasePool, "transaction">,
  scope: import("@ganso-market/contracts/trading").TradingScope,
  id: string,
  received: number,
  price = "64000000000",
  snapshotPatch: object = {},
) {
  const { market } = await import("./valuation-fixture.js");
  const { storeRetentionObjectTx, withBtcRetentionTransaction } =
    await import("../../src/storage/btc-retention.js");
  const o = market(received).context!.payload;
  if (o.payload.kind !== "mark_funding") throw new Error("fixture");
  const payload = {
    ...o,
    source_id: "hyperliquid:mainnet:info",
    parser_version: "hyperliquid.context-snapshot.v1",
    source_timestamp: null,
    quality: "unknown",
    payload: {
      ...o.payload,
      oracle_price: { ...o.payload.oracle_price, raw: price },
      snapshot: {
        basis: "http_response_date",
        requested_at: iso(received - 100),
        received_at: iso(received),
        server_date: new Date(received).toUTCString(),
        cache_status: "Miss from cloudfront",
        age: null,
        raw_context: { oraclePx: "fixture-only" },
        ...snapshotPatch,
      },
    },
  };
  await withBtcRetentionTransaction(pool, async (tx) => {
    await storeRetentionObjectTx(tx, {
      id,
      class: "raw",
      identity: scope,
      recordedAt: new Date(received),
      payload,
      dependencies: [],
    });
    await tx.query(
      "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,'context',NULL,$2)",
      [id, iso(received)],
    );
  });
}
