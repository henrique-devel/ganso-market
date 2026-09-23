import type { TradingMarketData } from "@ganso-market/contracts/trading";
import { replayFinancials } from "../../src/storage/valuationstore.js";
import { parseTradingAmount } from "@ganso-market/contracts/trading";
import type { LedgerPayload } from "../../src/storage/ledger-contract.js";
import {
  genesisBatch,
  materializeLedgerBatch,
} from "../../src/storage/ledger-contract.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import { type ValuationMarket } from "../../src/trading/valuation.js";
import { normalizeHyperliquidFeed } from "../../src/venues/hyperliquid/feed-normalizer.js";
import { command, fill, identity, iso, start } from "./ledger-fixture.js";
import { health, metadata } from "./bars-fixture.js";
export function pricedFill(
  id: string,
  side: "buy" | "sell",
  quantity = "1000000",
  price = "64000000000",
): LedgerPayload {
  const p = fill(id, side, quantity);
  if (p.event_type !== "fill") throw new Error("fixture");
  return {
    ...p,
    price: parseTradingAmount("USD_PER_BTC", { ...p.price, raw: price }),
  };
}
export function history(payloads: LedgerPayload[], owner = "manual") {
  const id = identity(owner),
    scope = ledgerScope(id);
  return [
    ...materializeLedgerBatch(genesisBatch(id), "0", iso(start + 100_000)),
    ...(payloads.length
      ? materializeLedgerBatch(
          {
            transaction_id: "fixture",
            events: payloads.map((p, i) => command(`event:${i}`, p, scope)),
          },
          "1",
          iso(start + 100_000),
        )
      : []),
  ];
}
export const financial = (payloads: LedgerPayload[], owner = "manual") =>
  replayFinancials(identity(owner), history(payloads, owner));
export function market(at = start + 100_000): Omit<
  ValuationMarket,
  "context" | "book"
> & {
  context: { object_id: string; payload: TradingMarketData } | null;
  book: { object_id: string; payload: TradingMarketData } | null;
} {
  const event = (channel: "book" | "context", payload: unknown) => ({
    ...normalizeHyperliquidFeed(
      channel,
      payload,
      iso(at),
      metadata.instrument.instrument_version,
      "fixture",
    )[0]!,
    quality: "fresh" as const,
    gap_epoch: 0,
    revalidation: "none" as const,
    continuity: "unproven" as const,
  });
  const h = health(at);
  for (const channel of ["book", "context"] as const)
    h.channels[channel] = {
      status: "healthy",
      last_received_at: at,
      last_source_at: at,
      source_quality: "fresh",
      gap_epoch: 0,
      needs_revalidation: false,
    };
  const context = event("context", {
    coin: "BTC",
    ctx: { markPx: "65000", oraclePx: "64990", funding: "0.0001" },
  });
  return {
    as_of: iso(at),
    capture: { at, health: h },
    // Synthetic source timestamp ONLY for independent arithmetic fixtures.
    // Production activeAssetCtx has none and remains degraded.
    context: {
      object_id: "mark",
      payload: { ...context, source_timestamp: iso(at) },
    },
    book: {
      object_id: "book",
      payload: event("book", {
        coin: "BTC",
        time: at,
        levels: [
          [
            { px: "64900", sz: "0.006", n: 1 },
            { px: "64800", sz: "0.02", n: 1 },
          ],
          [
            { px: "65100", sz: "0.006", n: 1 },
            { px: "65200", sz: "0.02", n: 1 },
          ],
        ],
      }),
    },
  };
}
