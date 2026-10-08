/** Position protection is independent of JEV decisions and baseline signals. */
import {
  assertTradingQuantum,
  parseTradingAmount,
  requireJev,
  type JevScope,
  type TradingInstrumentMetadata,
} from "@ganso-market/contracts/trading";
import { venueGridPrice } from "../trading/price-grid.js";
import { canonicalFingerprint } from "../trading/replay.js";
import { jevTime } from "./jev-context.js";
import { validateJevManifest, type JevManifest } from "./jev-manifest.js";
export interface JevProtection {
  schema_version: "btc.jev-protection.v1";
  manifest_hash: string;
  scope: JevScope;
  position_id: string;
  direction: "long" | "short";
  first_fill_at: string;
  first_fill_price_raw: string;
  entry_atr14_raw: string;
  stop_price_raw: string;
  quantity_btc_raw: string;
  maximum_exit_at: string;
}
export function initialJevProtection(
  m: JevManifest,
  input: {
    scope: JevScope;
    position_id: string;
    direction: "long" | "short";
    first_fill_at: string;
    first_fill_price_raw: string;
    quantity_btc_raw: string;
    atr14_raw: string;
    atr_captured_at: string;
    decision_at: string;
  },
  metadata: TradingInstrumentMetadata,
): JevProtection {
  const hash = validateJevManifest(m),
    at = jevTime(input.first_fill_at);
  requireJev(
    jevTime(input.atr_captured_at) <= jevTime(input.decision_at) &&
      jevTime(input.decision_at) <= at &&
      input.scope.instrument_id === metadata.instrument.instrument_id &&
      input.scope.instrument_version ===
        metadata.instrument.instrument_version &&
      ["long", "short"].includes(input.direction),
    "PROTECTION_IDENTITY",
  );
  const fill = BigInt(
      parseTradingAmount("USD_PER_BTC", {
        unit: "USD_PER_BTC",
        decimals: 6,
        raw: input.first_fill_price_raw,
      }).raw,
    ),
    atr = BigInt(
      parseTradingAmount("USD_PER_BTC", {
        unit: "USD_PER_BTC",
        decimals: 6,
        raw: input.atr14_raw,
      }).raw,
    );
  const q = parseTradingAmount("BTC", {
    unit: "BTC",
    decimals: 8,
    raw: input.quantity_btc_raw,
  });
  assertTradingQuantum(q, metadata.instrument.quantity_step);
  requireJev(BigInt(q.raw) > 0n && fill > 0n && atr > 0n, "PROTECTION_AMOUNTS");
  const target = fill + (input.direction === "long" ? -1n : 1n) * 2n * atr;
  const stop = venueGridPrice(
    target,
    1n,
    input.direction === "long" ? "up" : "down",
    metadata,
  );
  requireJev(
    stop !== null && (input.direction === "long" ? stop < fill : stop > fill),
    "STOP_GRID",
  );
  return {
    schema_version: "btc.jev-protection.v1",
    manifest_hash: hash,
    scope: input.scope,
    position_id: input.position_id,
    direction: input.direction,
    first_fill_at: input.first_fill_at,
    first_fill_price_raw: input.first_fill_price_raw,
    entry_atr14_raw: input.atr14_raw,
    stop_price_raw: stop.toString(),
    quantity_btc_raw: q.raw,
    maximum_exit_at: new Date(at + m.exits.maximum_holding_ms).toISOString(),
  };
}
/** Partial fills never change price/ATR/time anchors. Only protected quantity changes. */
export function updateJevPartialProtection(
  p: JevProtection,
  fill: {
    scope: JevScope;
    position_id: string;
    occurred_at: string;
    quantity_btc_raw: string;
  },
  metadata: TradingInstrumentMetadata,
): JevProtection {
  requireJev(
    canonicalFingerprint(p.scope) === canonicalFingerprint(fill.scope) &&
      p.position_id === fill.position_id &&
      jevTime(fill.occurred_at) >= jevTime(p.first_fill_at),
    "PARTIAL_OWNER",
  );
  const q = parseTradingAmount("BTC", {
    unit: "BTC",
    decimals: 8,
    raw: fill.quantity_btc_raw,
  });
  assertTradingQuantum(q, metadata.instrument.quantity_step);
  requireJev(BigInt(q.raw) > 0n, "PARTIAL_QUANTITY");
  return {
    ...p,
    quantity_btc_raw: (BigInt(p.quantity_btc_raw) + BigInt(q.raw)).toString(),
  };
}
/** Urgent close requests are independent of JEV, cadence and response availability. */
export function jevMandatoryExit(
  m: JevManifest,
  p: JevProtection,
  input: {
    now_at: string;
    mark_price_raw: string | null;
    mark_at: string | null;
    protection_confirmed: boolean;
    risk_blocked: boolean;
  },
) {
  requireJev(p.manifest_hash === validateJevManifest(m), "PROTECTION_VERSION");
  const now = jevTime(input.now_at);
  requireJev(now >= jevTime(p.first_fill_at), "EXIT_CLOCK");
  const reasons: string[] = [];
  if (now >= jevTime(p.maximum_exit_at)) reasons.push("MAXIMUM_HOLDING_TIME");
  if (input.risk_blocked) reasons.push("RISK_BLOCKED");
  if (!input.protection_confirmed) reasons.push("PROTECTION_UNCONFIRMED");
  if (
    input.mark_at === null ||
    input.mark_price_raw === null ||
    jevTime(input.mark_at) > now ||
    now - jevTime(input.mark_at) > m.freshness.mark_funding_ms
  )
    reasons.push("PROTECTION_MARK_UNKNOWN");
  else {
    const mark = BigInt(
      parseTradingAmount("USD_PER_BTC", {
        unit: "USD_PER_BTC",
        decimals: 6,
        raw: input.mark_price_raw,
      }).raw,
    );
    requireJev(mark > 0n, "MARK_PRICE");
    if (
      p.direction === "long"
        ? mark <= BigInt(p.stop_price_raw)
        : mark >= BigInt(p.stop_price_raw)
    )
      reasons.push("FIXED_STOP");
  }
  return {
    request_close: reasons.length > 0,
    reasons,
    reduce_only: true,
    time_in_force: "IOC" as const,
  };
}
