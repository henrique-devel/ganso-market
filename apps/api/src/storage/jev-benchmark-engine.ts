import type { TradingInstrumentMetadata } from "@ganso-market/contracts/trading";
import {
  parseTradingContract,
  parseTradingAmount,
  assertInstrumentOrderConstraints,
} from "@ganso-market/contracts/trading";
import { walkIoc } from "../trading/broker.js";
import {
  fundingDelta,
  fundingPositions,
  fundingCoverage,
  type FundingReceipt,
  PAPER_FUNDING_MODEL,
} from "../trading/funding.js";
import { parseFinalFunding } from "../venues/hyperliquid/funding.js";
import { money, utc, floor, requireMetric, ratio } from "../trading/metrics.js";
import {
  projectFinancials,
  valueFinancials,
  contextSnapshotTime,
  type ValuationMarket,
  type MarketEvidence,
} from "../trading/valuation.js";
import { jevHash } from "./jev-hash.js";

export const JEV_BENCHMARK_POLICY = Object.freeze({
  version: "jev.benchmark.v1",
  capital_usd6: "250000000",
  exposure_bps: 5000,
  drawdown_usd6: "12500000",
  paper_latency_ms: 1000,
  stress_latency_ms: 2000,
  entry: "single_IOC_at_initial_ask_limit_cancel_unfilled_no_topup",
  exit: "reduce_only_IOC_at_observed_bids_after_latency_retry_residual",
  funding: PAPER_FUNDING_MODEL,
  reentry: false,
  rebalance: false,
  live_orders: false,
});
type Event = {
  sequence: string;
  occurred_at: string;
  payload:
    | {
        event_type: "fill";
        position_id: string;
        side: "buy" | "sell";
        quantity: { raw: string };
        price: { raw: string };
      }
    | { event_type: "fee" | "funding"; delta: { raw: string } };
};
export interface JevBenchmark {
  schema_version: typeof JEV_BENCHMARK_POLICY.version;
  mode: "paper" | "stress";
  reference_id: string;
  instrument_id: string;
  instrument_version: string;
  started_at: string;
  observed_at: string;
  phase: "entry_pending" | "holding" | "exit_pending" | "cash";
  entry_limit_usd6: string;
  target_quantity_btc8: string;
  initial_quantity_btc8: string | null;
  arrival_at: string;
  high_water_usd6: string;
  drawdown_triggered_at: string | null;
  events: Event[];
  receipts: FundingReceipt[];
  funding_hashes: Record<string, string>;
  funding_conflict: boolean;
  claims: {
    book_id: string;
    side: "buy" | "sell";
    price_usd_raw: string;
    quantity_btc_raw: string;
  }[];
}
export interface BenchmarkFunding {
  period_hour: string;
  received_at: string;
  row: unknown;
  oracle: MarketEvidence | null;
}
const arrival = (at: string, mode: "paper" | "stress") =>
  new Date(utc(at) + (mode === "stress" ? 2000 : 1000)).toISOString();
function validateMetadata(metadata: TradingInstrumentMetadata) {
  parseTradingContract("instrument", metadata.instrument);
  requireMetric(
    metadata.schema_version === "trading.instrument-metadata.v1" &&
      metadata.instrument.instrument_id === "hyperliquid:mainnet:BTC" &&
      money(parseTradingAmount("RATE", metadata.fees.taker).raw) >= 0n,
    "BENCHMARK_METADATA",
  );
}
function valuation(state: JevBenchmark, market: ValuationMarket) {
  const qty = state.events.reduce(
    (q, e) =>
      e.payload.event_type === "fill"
        ? q +
          (e.payload.side === "buy" ? 1n : -1n) * money(e.payload.quantity.raw)
        : q,
    0n,
  );
  const cash = state.events.reduce(
    (q, e) =>
      e.payload.event_type === "fee" || e.payload.event_type === "funding"
        ? q + money(e.payload.delta.raw)
        : q,
    250000000n,
  );
  const ledger = {
    schema_version: "benchmark",
    scope: {
      mode: "paper" as const,
      account_id: "benchmark",
      experiment_id: "benchmark",
      instrument_id: state.instrument_id,
      instrument_version: state.instrument_version,
    },
    last_sequence: String(state.events.length),
    cash_usd_raw: cash.toString(),
    positions:
      qty === 0n
        ? []
        : [{ position_id: "benchmark", quantity_btc_raw: qty.toString() }],
  };
  requireMetric(qty >= 0n, "BENCHMARK_REDUCE_ONLY");
  return valueFinancials(projectFinancials(ledger, state.events), market);
}
export function startJevBenchmark(
  mode: "paper" | "stress",
  metadata: TradingInstrumentMetadata,
  market: ValuationMarket,
  reference_id = "benchmark",
): JevBenchmark {
  requireMetric(
    (mode === "paper" || mode === "stress") &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(reference_id),
    "BENCHMARK_MODE",
  );
  utc(market.as_of);
  validateMetadata(metadata);
  const state: JevBenchmark = {
    schema_version: "jev.benchmark.v1",
    mode,
    reference_id,
    instrument_id: metadata.instrument.instrument_id,
    instrument_version: metadata.instrument.instrument_version,
    started_at: market.as_of,
    observed_at: market.as_of,
    phase: "entry_pending",
    entry_limit_usd6: "0",
    target_quantity_btc8: "0",
    initial_quantity_btc8: null,
    arrival_at: arrival(market.as_of, mode),
    high_water_usd6: "250000000",
    drawdown_triggered_at: null,
    events: [],
    receipts: [],
    funding_hashes: {},
    funding_conflict: false,
    claims: [],
  };
  const v = valuation(state, market),
    book = market.book?.payload.payload;
  requireMetric(
    v.closing.quality === "fresh" &&
      v.maintenance.usable_for_risk &&
      book?.kind === "book" &&
      book.asks.length > 0 &&
      metadata.instrument.origin.received_at <= market.as_of,
    "BENCHMARK_ENTRY_EVIDENCE",
  );
  state.entry_limit_usd6 = book.asks[0]!.price.raw;
  const step = money(metadata.instrument.quantity_step.raw);
  state.target_quantity_btc8 = (
    floor(125000000n * 100000000n, money(state.entry_limit_usd6) * step) * step
  ).toString();
  requireMetric(
    money(state.target_quantity_btc8) > 0n,
    "BENCHMARK_INITIAL_QUANTITY",
  );
  assertInstrumentOrderConstraints(
    metadata,
    parseTradingAmount("USD_PER_BTC", book.asks[0]!.price),
    parseTradingAmount("BTC", {
      unit: "BTC",
      decimals: 8,
      raw: state.target_quantity_btc8,
    }),
  );
  return state;
}
function coverage(state: JevBenchmark, at: string) {
  // The terminal cash phase can never reopen. Funding after its last fill
  // cannot alter the trajectory; still require every potentially held hour.
  const last = state.events
    .filter((e) => e.payload.event_type === "fill")
    .at(-1);
  return fundingCoverage(
    state.events,
    state.receipts,
    state.phase === "cash" && last ? last.occurred_at : at,
  );
}
/** Independent virtual trajectory. All executions walk the observed book at
 * arrival, with finite depth and per-reference claims. No strategy fills,
 * wallet, transfer, JEV cost, or current-price reconstruction is accepted. */
export function advanceJevBenchmark(
  input: JevBenchmark,
  metadata: TradingInstrumentMetadata,
  market: ValuationMarket,
  funding: readonly BenchmarkFunding[] = [],
) {
  const state = structuredClone(input);
  validateMetadata(metadata);
  requireMetric(
    state.schema_version === JEV_BENCHMARK_POLICY.version &&
      ["paper", "stress"].includes(state.mode) &&
      state.instrument_id === metadata.instrument.instrument_id &&
      state.instrument_version === metadata.instrument.instrument_version &&
      utc(market.as_of) >= utc(state.observed_at) &&
      state.events.length <= 20000 &&
      funding.length <= 24 &&
      metadata.instrument.origin.received_at <= market.as_of,
    "BENCHMARK_STATE",
  );
  state.observed_at = market.as_of;
  const append = (payload: Event["payload"], at = market.as_of) =>
    state.events.push({
      sequence: String(state.events.length + 1),
      occurred_at: at,
      payload,
    });
  for (const f of funding) {
    requireMetric(f.received_at <= market.as_of, "BENCHMARK_FUTURE_FUNDING");
    const final = parseFinalFunding(f.row, f.period_hour, f.received_at, 18);
    const hash = jevHash(f.row),
      previous = state.funding_hashes[f.period_hour];
    if (previous) {
      if (previous !== hash) state.funding_conflict = true;
      continue;
    }
    const quantities = fundingPositions(state.events, final.cutoff);
    const o = f.oracle?.payload,
      p = o?.payload;
    const validOracle =
      p?.kind === "mark_funding" &&
      o?.instrument_id === state.instrument_id &&
      o.instrument_version === state.instrument_version &&
      o.parser_version === "hyperliquid.context-snapshot.v1" &&
      o.source_id === "hyperliquid:mainnet:info" &&
      o.received_at <= final.cutoff &&
      utc(final.cutoff) - utc(o.received_at) <= 5000 &&
      contextSnapshotTime(p.snapshot, o.received_at) !== null;
    if (
      final.rate_raw === null ||
      quantities.ambiguous.length ||
      (quantities.positions.length > 0 && !validOracle)
    )
      continue;
    const positions = quantities.positions.map((q) => ({
      ...q,
      delta_usd_raw: fundingDelta(
        q.quantity_btc_raw,
        p?.kind === "mark_funding" ? p.oracle_price.raw : "0",
        final.rate_raw!,
        18,
      ),
    }));
    for (const p of positions)
      append(
        { event_type: "funding", delta: { raw: p.delta_usd_raw } },
        final.cutoff,
      );
    state.receipts.push({
      schema_version: "btc.funding.v1",
      model_version: PAPER_FUNDING_MODEL,
      period_hour: f.period_hour,
      cutoff: final.cutoff,
      status: "settled",
      reason: "observed_final_rate",
      basis: PAPER_FUNDING_MODEL,
      oracle_usd_raw: p?.kind === "mark_funding" ? p.oracle_price.raw : null,
      positions,
      evidence_id: hash,
    });
    state.funding_hashes[f.period_hour] = hash;
  }
  const observeRisk = (v: ReturnType<typeof valuation>) => {
    const equity = v.maintenance.equity_usd_raw;
    if (
      equity !== null &&
      coverage(state, market.as_of).usable_for_risk &&
      !state.funding_conflict
    ) {
      if (money(equity) > money(state.high_water_usd6))
        state.high_water_usd6 = equity;
      if (
        state.phase === "holding" &&
        money(state.high_water_usd6) - money(equity) >= 12500000n
      ) {
        state.phase = "exit_pending";
        state.drawdown_triggered_at = market.as_of;
        state.arrival_at = arrival(market.as_of, state.mode);
      }
    }
  };
  let v = valuation(state, market);
  let covered = coverage(state, market.as_of);
  observeRisk(v);
  const book = market.book?.payload,
    open =
      v.positions.find((p) => p.position_id === "benchmark")
        ?.quantity_btc_raw ?? "0";
  if (
    (state.phase === "entry_pending" || state.phase === "exit_pending") &&
    market.as_of >= state.arrival_at &&
    v.closing.quality === "fresh" &&
    book?.payload.kind === "book" &&
    book.source_timestamp !== null &&
    book.source_timestamp >= state.arrival_at &&
    book.source_timestamp <= book.received_at
  ) {
    const side = state.phase === "entry_pending" ? "buy" : "sell";
    const fills = walkIoc({
      side,
      quantity: side === "buy" ? state.target_quantity_btc8 : open,
      limit: side === "buy" ? state.entry_limit_usd6 : "1",
      priceCap: "99999999999999999999999999999999999999",
      step: metadata.instrument.quantity_step.raw,
      feeRate: (
        money(metadata.fees.taker.raw) * (state.mode === "stress" ? 2n : 1n)
      ).toString(),
      levels: side === "buy" ? book.payload.asks : book.payload.bids,
      consumed: state.claims.filter(
        (c) => c.book_id === market.book!.object_id && c.side === side,
      ),
    });
    for (const f of fills) {
      append({
        event_type: "fill",
        position_id: "benchmark",
        side,
        quantity: { raw: f.quantity_btc_raw },
        price: { raw: f.price_usd_raw },
      });
      append({
        event_type: "fee",
        delta: { raw: (-money(f.fee_usd_raw)).toString() },
      });
      state.claims.push({ book_id: market.book!.object_id, side, ...f });
    }
    const executed = fills.reduce((q, f) => q + money(f.quantity_btc_raw), 0n);
    if (side === "buy") {
      state.initial_quantity_btc8 = executed.toString();
      state.phase = executed > 0n ? "holding" : "cash";
    } else {
      state.phase = executed === money(open) ? "cash" : "exit_pending";
      state.arrival_at = arrival(market.as_of, state.mode);
    }
  }
  v = valuation(state, market);
  requireMetric(state.events.length <= 20000, "BENCHMARK_EVENT_LIMIT");
  observeRisk(v);
  covered = coverage(state, market.as_of);
  const complete =
    covered.usable_for_risk &&
    !state.funding_conflict &&
    v.maintenance.unrealized_pnl_usd_raw !== null;
  const trajectory = {
    reference_id: state.reference_id,
    mode: state.mode,
    instrument_id: state.instrument_id,
    instrument_version: state.instrument_version,
    started_at: state.started_at,
  };
  return {
    state,
    observation: {
      trajectory,
      at: market.as_of,
      equity_usd6: complete ? v.maintenance.equity_usd_raw : null,
      realized_usd6: v.realized_pnl_usd_raw,
      open_usd6: v.maintenance.unrealized_pnl_usd_raw,
      fees_usd6: (-money(v.fees_usd_raw)).toString(),
      funding_usd6: v.funding_usd_raw,
      quantity_btc8:
        v.positions.find((p) => p.position_id === "benchmark")
          ?.quantity_btc_raw ?? "0",
      funding_complete: covered.usable_for_risk && !state.funding_conflict,
      phase: state.phase,
      high_water_usd6: state.high_water_usd6,
      drawdown_triggered_at: state.drawdown_triggered_at,
    },
    policy: JEV_BENCHMARK_POLICY,
  };
}
export type BenchmarkObservation = ReturnType<
  typeof advanceJevBenchmark
>["observation"];
/** Exact persisted endpoints only. Never initialize or buy at a window edge. */
export function jevBenchmarkWindow(
  opening: BenchmarkObservation,
  closing: BenchmarkObservation,
) {
  requireMetric(
    utc(opening.at) < utc(closing.at) &&
      jevHash(opening.trajectory) === jevHash(closing.trajectory),
    "BENCHMARK_WINDOW",
  );
  const pnl =
    opening.equity_usd6 === null || closing.equity_usd6 === null
      ? null
      : money(closing.equity_usd6) - money(opening.equity_usd6);
  return {
    schema_version: "jev.benchmark-window.v1",
    window: { start_at: opening.at, end_at: closing.at },
    cash: { capital_usd6: "250000000", pnl_usd6: "0", return_ppm: "0" },
    btc_protected: {
      pnl_usd6: pnl?.toString() ?? null,
      return_ppm: pnl === null ? null : ratio(pnl, 250000000n),
    },
    convention: JEV_BENCHMARK_POLICY,
    real_capital_reserved_usd6: "0",
  };
}
