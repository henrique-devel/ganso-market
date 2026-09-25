import type { ClosedBar } from "../../src/trading/bars.js";
import type {
  BaselineRecord,
  BaselineBars,
} from "../../src/storage/baseline-inputs.js";
import {
  baselineHash,
  baselineIso,
  baselineEnvironment,
} from "../../src/storage/baseline-inputs.js";
import type { BaselineDecisionInput } from "../../src/storage/baseline-policy.js";
import { BASELINE_FINGERPRINT } from "../../src/storage/baseline-manifest.js";
import { metadata } from "./bars-fixture.js";
import { financial, market } from "./valuation-fixture.js";
import { normalizeBtcContextSnapshot } from "../../src/venues/hyperliquid/context-snapshot.js";
import { valueFinancials } from "../../src/trading/valuation.js";
export const T = Date.parse("2024-01-01T12:15:00.000Z");
export const AT = T + 10000;
export const px = (n: number) => (BigInt(n) * 1000000n).toString();
export function record<T>(
  object_id: string,
  payload: T,
  at: number,
): BaselineRecord<T> {
  return {
    object_id,
    payload,
    payload_hash: baselineHash(payload),
    recorded_at: baselineIso(at),
  };
}
export function rehash<T>(row: BaselineRecord<T>) {
  row.payload_hash = baselineHash(row.payload);
}
export function bars(
  interval: 900000 | 3600000,
  values: { open: string; high: string; low: string; close: string }[],
): BaselineBars {
  const end = Math.floor(T / interval) * interval;
  const records = values.map((v, i) => {
    const bEnd = end - i * interval;
    const b: ClosedBar = {
      schema_version: "trading.closed-bar.v1",
      build_version: "btc-observed-bars.v1",
      instrument_id: "hyperliquid:mainnet:BTC",
      instrument_version: metadata.instrument.instrument_version,
      source_id: "hyperliquid:mainnet:ws",
      interval_ms: interval,
      start_at: baselineIso(bEnd - interval),
      end_at: baselineIso(bEnd),
      closed_at: baselineIso(bEnd + 10000),
      ohlc: { ...v, unit: "USD_PER_BTC", decimals: 6 },
      volume: { raw: "100000", unit: "BTC", decimals: 8 },
      trade_count: 10,
      quality: {
        state: "observed_no_known_gap",
        reasons: [],
        continuity: "unproven",
      },
      input_ids: [`trade:${interval}:${i}`, `capture:${interval}:${i}`],
    };
    return record(`bar:${interval}:${bEnd}`, b, bEnd + 10000);
  });
  return {
    records,
    first_complete_start_at: records.at(-1)!.payload.start_at,
    dependencies: records.flatMap((r) =>
      r.payload.input_ids.map((id) => ({
        object_id: id,
        payload_hash: "a".repeat(64),
        received_at: r.payload.closed_at,
        recorded_at: r.recorded_at,
      })),
    ),
  };
}
export function fixture(
  direction: "long" | "short" | "neutral" = "long",
): BaselineDecisionInput {
  const closes =
    direction === "long"
      ? [99600, 99400, 99200, 99000, ...Array<number>(8).fill(98000)]
      : direction === "short"
        ? [100400, 100600, 100800, 101000, ...Array<number>(8).fill(102000)]
        : Array<number>(12).fill(100000);
  const hours = bars(
    3600000,
    closes.map((n) => ({
      open: px(n),
      high: px(n + 100),
      low: px(n - 100),
      close: px(n),
    })),
  );
  const quarters = bars(
    900000,
    Array.from({ length: 15 }, (_, i) =>
      direction === "short"
        ? i === 0
          ? {
              open: px(100300),
              high: px(100400),
              low: px(99900),
              close: px(100000),
            }
          : i === 1
            ? {
                open: px(100200),
                high: px(100600),
                low: px(100100),
                close: px(100200),
              }
            : {
                open: px(100200),
                high: px(100450),
                low: px(99950),
                close: px(100200),
              }
        : i === 0
          ? {
              open: px(99700),
              high: px(100100),
              low: px(99600),
              close: px(100000),
            }
          : i === 1
            ? {
                open: px(99800),
                high: px(99900),
                low: px(99400),
                close: px(99800),
              }
            : {
                open: px(99800),
                high: px(100050),
                low: px(99550),
                close: px(99800),
              },
    ),
  );
  const projection = financial([], "baseline");
  const scope = projection.ledger.scope;
  const m = market(AT);
  const book = m.book!.payload;
  if (book.payload.kind !== "book") throw new Error("fixture");
  Object.assign(book.payload, {
    bids: [
      {
        price: { raw: px(99990), unit: "USD_PER_BTC", decimals: 6 },
        quantity: { raw: "10000000", unit: "BTC", decimals: 8 },
        orders: 1,
      },
    ],
    asks: [
      {
        price: { raw: px(100010), unit: "USD_PER_BTC", decimals: 6 },
        quantity: { raw: "10000000", unit: "BTC", decimals: 8 },
        orders: 1,
      },
    ],
  });
  const context = {
    ...normalizeBtcContextSnapshot(
      [
        {
          universe: [
            { name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 40 },
          ],
          marginTables: [],
          collateralToken: 0,
        },
        [{ markPx: "100000", oraclePx: "100000", funding: "0.0001" }],
      ],
      {
        requestedAt: baselineIso(AT - 200),
        receivedAt: baselineIso(AT),
        serverDate: new Date(AT).toUTCString(),
        cacheStatus: "Miss from cloudfront",
        age: null,
      },
      metadata,
      "baseline-fixture",
    ),
    quality: "unknown" as const,
    gap_epoch: 0,
    revalidation: "current_state_only" as const,
    continuity: "unproven" as const,
  };
  const e: BaselineDecisionInput = {
    enabled: true,
    decision_at: baselineIso(AT),
    bar_end_at: baselineIso(T),
    hours,
    quarters,
    registration: {
      scope,
      policy_version: "btc.baseline.trend.v1",
      manifest_fingerprint: BASELINE_FINGERPRINT,
      code_sha: "b".repeat(40),
      metadata_hash: baselineHash(metadata),
      registered_at: "2024-01-01T00:00:00.000Z",
      start_at: "2024-01-01T00:15:00.000Z",
    },
    metadata: record(
      "metadata",
      structuredClone(metadata),
      Date.parse(metadata.instrument.origin.received_at),
    ),
    account: record(
      "account",
      {
        projection,
        risk: {
          version: "btc.risk.v1",
          state: "NORMAL",
          history_complete: true,
          reasons: [],
          day: "2024-01-01",
          daily_anchor_usd_raw: "1000000000",
          high_water_usd_raw: "1000000000",
          external_cash_usd_raw: "0",
          equity_usd_raw: "1000000000",
          ledger_sequence: projection.ledger.last_sequence,
          observed_at: baselineIso(AT),
        },
        reservations: [],
        funding_usable_for_risk: true,
        recovery_ready: true,
        accounting_consistent: true,
        entries_paused: false,
        hold: false,
        exit_pending: false,
        last_closed_bar_end_at: null,
      },
      AT,
    ),
    market: {
      book: record("book", book, AT),
      context: record("context", context, AT),
      capture: record("capture", m.capture!, AT),
    },
    funding: [
      record(
        "funding",
        {
          schema_version: "btc.funding.v1",
          model_version: "btc.funding.paper-precut.v2",
          rate: { raw: "100000000000000", unit: "RATE", decimals: 18 },
          period_hour: "2024-01-01T12:00:00.000Z",
          cutoff: "2024-01-01T12:00:00.123Z",
          status: "settled",
          reason: "no_eligible_exposure",
          basis: null,
          oracle_usd_raw: null,
          positions: [],
          evidence_id: "funding",
        },
        T - 1000,
      ),
    ],
  };
  return e;
}
/** Advance observed market evidence, preserving its original HTTP limitations. */
export function tick(e: BaselineDecisionInput, at: number) {
  e.decision_at = baselineIso(at);
  for (const row of [e.market.book, e.market.context]) {
    if (!row) continue;
    Object.assign(row.payload, { received_at: baselineIso(at) });
    if (row.payload.source_timestamp !== null)
      Object.assign(row.payload, { source_timestamp: baselineIso(at) });
    if (
      row.payload.payload.kind === "mark_funding" &&
      row.payload.payload.snapshot
    )
      Object.assign(row.payload.payload.snapshot, {
        requested_at: baselineIso(at - 200),
        received_at: baselineIso(at),
        server_date: new Date(at).toUTCString(),
      });
    row.recorded_at = baselineIso(at);
    rehash(row);
  }
  e.market.capture!.payload.at = at;
  e.market.capture!.recorded_at = baselineIso(at);
  rehash(e.market.capture!);
  e.account.payload.risk.observed_at = baselineIso(at);
  e.account.recorded_at = baselineIso(at);
  const f = valueFinancials(e.account.payload.projection, {
    as_of: baselineIso(at),
    book: e.market.book,
    context: e.market.context,
    capture: e.market.capture!.payload,
  });
  e.account.payload.risk.equity_usd_raw = f.maintenance.equity_usd_raw;
  rehash(e.account);
}
export function environment(e: BaselineDecisionInput) {
  return baselineEnvironment(e, Date.parse(e.decision_at));
}
