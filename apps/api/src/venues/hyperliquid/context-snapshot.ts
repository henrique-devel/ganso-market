import { createHash, randomUUID } from "node:crypto";
import type {
  TradingInstrumentMetadata,
  TradingMarketObservation,
} from "@ganso-market/contracts/trading";
import { canonicalFingerprint } from "../../trading/replay.js";
import { contextSnapshotTime } from "../../trading/valuation.js";
import { normalizeHyperliquidFeed } from "./feed-normalizer.js";
import { parseHyperliquidBtcMetadata } from "./metadata.js";

/** Official metaAndAssetCtxs current-state endpoint; 20 weight / request, at most
 * 30/minute (<1200/minute IP allowance). No credentials, retries or paid API.
 * Date authenticates response generation only: source_timestamp stays null.
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
 * https://www.rfc-editor.org/rfc/rfc9110.html#name-date
 */
export async function fetchBtcContextSnapshot(
  metadata: TradingInstrumentMetadata,
  signal?: AbortSignal,
): Promise<TradingMarketObservation> {
  const { body, timing } = await fetchSnapshot(
    {
      type: "metaAndAssetCtxs",
      dex: "",
    },
    signal,
  );
  return normalizeBtcContextSnapshot(body, timing, metadata, randomUUID());
}
export async function fetchBtcBookSnapshot(
  metadata: TradingInstrumentMetadata,
  signal?: AbortSignal,
): Promise<TradingMarketObservation> {
  const { body, timing } = await fetchSnapshot(
    { type: "l2Book", coin: "BTC" },
    signal,
  );
  return {
    ...normalizeHyperliquidFeed(
      "book",
      body,
      timing.receivedAt,
      metadata.instrument.instrument_version,
      randomUUID(),
    )[0]!,
    source_id: "hyperliquid:mainnet:info",
    parser_version: "hyperliquid.book-snapshot.v1",
  };
}
async function fetchSnapshot(request: object, stopSignal?: AbortSignal) {
  const requestedAt = new Date().toISOString();
  const deadline = AbortSignal.timeout(1500);
  const signal = stopSignal
    ? AbortSignal.any([deadline, stopSignal])
    : deadline;
  const checkDeadline = () => {
    signal.throwIfAborted();
    // Also reject a late completion when event-loop delay postpones the timer.
    if (Date.now() - Date.parse(requestedAt) > 1500)
      throw new DOMException("Snapshot deadline exceeded", "TimeoutError");
  };
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store",
    },
    body: JSON.stringify(request),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error("BTC_CONTEXT_RESPONSE_REFUSED");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      checkDeadline();
      const { done, value } = await reader.read();
      checkDeadline();
      if (done) break;
      size += value.byteLength;
      if (size > 262144) throw new Error("BTC_CONTEXT_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } catch (error) {
    if (
      error instanceof DOMException &&
      error.name === "AbortError" &&
      signal.aborted
    )
      throw signal.reason;
    throw error;
  } finally {
    // Cancelling an already-aborted body can reject with AbortError; that must
    // not replace the original TimeoutError or payload refusal diagnostic.
    await reader.cancel().catch(() => {});
  }
  checkDeadline();
  return {
    body: JSON.parse(Buffer.concat(chunks).toString()),
    timing: {
      requestedAt,
      receivedAt: new Date().toISOString(),
      serverDate: response.headers.get("date"),
      cacheStatus: response.headers.get("x-cache"),
      age: response.headers.get("age"),
    },
  };
}
export function normalizeBtcContextSnapshot(
  body: unknown,
  timing: {
    requestedAt: string;
    receivedAt: string;
    serverDate: string | null;
    cacheStatus: string | null;
    age: string | null;
  },
  metadata: TradingInstrumentMetadata,
  observationId: string,
): TradingMarketObservation {
  if (!Array.isArray(body) || body.length !== 2 || !Array.isArray(body[1]))
    throw new Error("BTC_CONTEXT_RESPONSE_REFUSED");
  const current = parseHyperliquidBtcMetadata(body[0], timing.receivedAt);
  if (
    current.instrument.instrument_version !==
    metadata.instrument.instrument_version
  )
    throw new Error("BTC_COLLECTOR_METADATA_CHANGED");
  const index = body[0].universe.findIndex(
    (asset: { name: string }) => asset.name === "BTC",
  );
  if (body[0].universe.length !== body[1].length || index < 0)
    throw new Error("BTC_CONTEXT_RESPONSE_REFUSED");
  const snapshot = {
    basis: "http_response_date" as const,
    requested_at: timing.requestedAt,
    received_at: timing.receivedAt,
    server_date: timing.serverDate!,
    cache_status: timing.cacheStatus as "Miss from cloudfront",
    age: timing.age,
    raw_context: body[1][index],
  };
  if (!contextSnapshotTime(snapshot, timing.receivedAt))
    throw new Error("BTC_CONTEXT_TIME_UNPROVEN");
  const normalized = normalizeHyperliquidFeed(
    "context",
    { coin: "BTC", ctx: body[1][index] },
    timing.receivedAt,
    metadata.instrument.instrument_version,
    observationId,
  )[0]!;
  const payload = { ...normalized.payload, snapshot };
  return {
    ...normalized,
    source_id: "hyperliquid:mainnet:info",
    parser_version: "hyperliquid.context-snapshot.v1",
    payload,
    payload_hash: createHash("sha256")
      .update(canonicalFingerprint(payload))
      .digest("hex"),
  };
}
