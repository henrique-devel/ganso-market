import { HttpTransport } from "@nktkas/hyperliquid";
import { fundingHistory } from "@nktkas/hyperliquid/api/info";
import { FUNDING_HOUR_MS } from "../../trading/funding.js";

// Official sources checked 2026-09-23:
// https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
// Historical rows have coin, fundingRate, premium, time; NO settlement oracle.
// activeAssetCtx/metaAndAssetCtxs and predictedFundings are NOT final evidence.
export const FUNDING_SOURCE = "hyperliquid:mainnet:fundingHistory";
export function fundingTime(value: string) {
  const n = Date.parse(value);
  if (
    !Number.isSafeInteger(n) ||
    n < FUNDING_HOUR_MS ||
    new Date(n).toISOString() !== value
  )
    throw new Error("BTC_FUNDING_TIME");
  return n;
}
export function fundingHour(value: string) {
  const n = fundingTime(value);
  if (n % FUNDING_HOUR_MS) throw new Error("BTC_FUNDING_HOUR");
  return n;
}
export function parseFinalFunding(
  row: unknown,
  periodHour: string,
  receivedAt: string,
  decimals: 9 | 18 = 9,
) {
  const hour = fundingHour(periodHour),
    received = fundingTime(receivedAt);
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw new Error("BTC_FUNDING_HISTORY_ROW");
  const p = row as Record<string, unknown>;
  if (
    Object.keys(p).sort().join() !== "coin,fundingRate,premium,time" ||
    p.coin !== "BTC" ||
    !Number.isSafeInteger(p.time) ||
    typeof p.fundingRate !== "string" ||
    typeof p.premium !== "string" ||
    !/^-?\d+(\.\d+)?$/.test(p.fundingRate) ||
    !/^-?\d+(\.\d+)?$/.test(p.premium) ||
    p.fundingRate.length > 80 ||
    p.premium.length > 80
  )
    throw new Error("BTC_FUNDING_HISTORY_ROW");
  const at = p.time as number;
  if (at < hour || at >= hour + FUNDING_HOUR_MS || at > received)
    throw new Error("BTC_FUNDING_HISTORY_TIME");
  // Compare the complete decimal before any scale conversion, including rates
  // too precise for the selected ledger representation. Never round a rate.
  const [whole, fraction = ""] = p.fundingRate.replace(/^-/, "").split(".");
  const coefficient =
    BigInt(whole! + fraction) * (p.fundingRate.startsWith("-") ? -1n : 1n);
  const denominator = 10n ** BigInt(fraction.length);
  if (
    coefficient * 100n > 4n * denominator ||
    coefficient * 100n < -4n * denominator
  )
    throw new Error("BTC_FUNDING_RATE_RANGE");
  const scale = 10n ** BigInt(decimals);
  const rate =
    (coefficient * scale) % denominator === 0n
      ? (coefficient * scale) / denominator
      : null;
  return {
    cutoff: new Date(at).toISOString(),
    rate_raw: rate?.toString() ?? null,
    precision: rate === null ? `inexact_RATE${decimals}` : "exact",
  };
}
/** Explicit bounded free public read only. No timer, retry, background polling,
 * wallet or credentials. Reconciliation receives the raw reply as evidence. */
export async function fetchFinalBtcFunding(
  periodHour: string,
  signal?: AbortSignal,
) {
  const startTime = fundingHour(periodHour);
  const rows = await fundingHistory(
    {
      transport: new HttpTransport({
        apiUrl: "https://api.hyperliquid.xyz",
        isTestnet: false,
        timeout: 8000,
      }),
    },
    { coin: "BTC", startTime, endTime: startTime + FUNDING_HOUR_MS - 1 },
    signal,
  );
  if (rows.length > 2) throw new Error("BTC_FUNDING_HISTORY_LIMIT");
  return {
    source: FUNDING_SOURCE,
    received_at: new Date().toISOString(),
    rows,
  };
}
