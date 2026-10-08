import {
  assertJevOwnership,
  parseTradingAmount,
  requireJev,
  type JevScope,
  type TradingMarketData,
} from "@ganso-market/contracts/trading";
import { atr14 } from "../trading/indicators.js";
import { type ClosedBar } from "../trading/bars.js";
import { jevScope, type JevLedgerIdentity } from "./jev-ledger.js";
import { type JevManifest, validateJevManifest } from "./jev-manifest.js";
import { jevHash } from "./jev-hash.js";
export interface JevContextRef {
  object_id: string;
  payload_hash: string;
  recorded_at: string;
  received_at: string;
}
export interface JevContextRecord<T> extends JevContextRef {
  payload: T;
}
export interface JevAccountContext {
  scope: JevScope;
  observed_at: string;
  cash_usd_raw: string;
  equity_usd_raw: string | null;
  position: null | {
    position_id: string;
    direction: "long" | "short";
    quantity_btc_raw: string;
    entry_price_raw: string;
    stop_price_raw: string;
    first_fill_at: string;
  };
  entries_paused: boolean;
  risk_blocked: boolean;
  recovery_ready: boolean;
}
export interface JevContextInput {
  cut_at: string;
  account: JevContextRecord<JevAccountContext>;
  book: JevContextRecord<TradingMarketData> | null;
  mark_funding: JevContextRecord<TradingMarketData> | null;
  trades: JevContextRecord<TradingMarketData>[];
  bars: JevContextRecord<ClosedBar>[];
  dependencies: JevContextRef[];
  coverage: JevContextRecord<{
    start_at: string;
    end_at: string;
    gaps: { start_at: string; end_at: string | null }[];
  }> | null;
}
export function jevTime(s: string) {
  const n = Date.parse(s);
  requireJev(
    Number.isSafeInteger(n) && n >= 0 && new Date(n).toISOString() === s,
    "TIME",
  );
  return n;
}
const refKnown = (r: JevContextRef, at: number) =>
  !!r.object_id &&
  r.object_id.length <= 512 &&
  /^[a-f0-9]{64}$/.test(r.payload_hash) &&
  jevTime(r.recorded_at) <= at &&
  jevTime(r.received_at) <= at;
const known = <T>(r: JevContextRecord<T>, at: number) =>
  refKnown(r, at) && jevHash(r.payload) === r.payload_hash;
const rate = (n: bigint, d: bigint) => ({
  unit: "RATE" as const,
  decimals: 9 as const,
  raw: ((n * 1000000000n) / d).toString(),
});
const price = (n: bigint) => ({
  unit: "USD_PER_BTC" as const,
  decimals: 6 as const,
  raw: n.toString(),
});
const quantity = (n: bigint) => ({
  unit: "BTC" as const,
  decimals: 8 as const,
  raw: n.toString(),
});
/** Pure common context. No signal, interpolation, admission, clock or JEV call. */
export function buildJevContext(
  manifest: JevManifest,
  identity: JevLedgerIdentity,
  input: JevContextInput,
) {
  const manifestHash = validateJevManifest(manifest),
    at = jevTime(input.cut_at),
    reasons = new Set<string>();
  requireJev(
    input.trades.length <= 32768 &&
      input.bars.length <= 200 &&
      input.dependencies.length <= 65536,
    "CONTEXT_LIMIT",
  );
  const scope = input.account.payload.scope,
    pair = identity.bindings.find(
      (x) => x.binding.experiment_id === scope.experiment_id,
    );
  requireJev(pair, "CONTEXT_BINDING");
  assertJevOwnership(
    scope,
    pair.binding,
    identity.account,
    pair.profile,
    jevScope(pair.binding, identity.instrument),
  );
  requireJev(input.cut_at >= pair.binding.started_at, "CONTEXT_BEFORE_BINDING");
  requireJev(pair.profile.manifest_hash === manifestHash, "CONTEXT_MANIFEST");
  const refs = new Map<string, JevContextRef>();
  const remember = (r: JevContextRef) => {
    const ref = {
      object_id: r.object_id,
      payload_hash: r.payload_hash,
      recorded_at: r.recorded_at,
      received_at: r.received_at,
    };
    const old = refs.get(r.object_id);
    requireJev(!old || jevHash(old) === jevHash(ref), "INPUT_COLLISION");
    refs.set(r.object_id, ref);
  };
  const dependencies = new Map(
    input.dependencies
      .filter((r) => refKnown(r, at))
      .map((r) => [r.object_id, r]),
  );
  let account: JevAccountContext | null = null;
  if (
    known(input.account, at) &&
    jevTime(input.account.payload.observed_at) <= at &&
    at - jevTime(input.account.payload.observed_at) <=
      manifest.freshness.account_ms
  ) {
    const a = input.account.payload;
    for (const raw of [
      a.cash_usd_raw,
      ...(a.equity_usd_raw === null ? [] : [a.equity_usd_raw]),
    ])
      parseTradingAmount("USD", { unit: "USD", decimals: 6, raw });
    if (a.position) {
      const p = a.position;
      parseTradingAmount("BTC", {
        unit: "BTC",
        decimals: 8,
        raw: p.quantity_btc_raw,
      });
      requireJev(
        BigInt(p.quantity_btc_raw) > 0n &&
          ["long", "short"].includes(p.direction) &&
          jevTime(p.first_fill_at) <= at,
        "POSITION",
      );
      for (const raw of [p.entry_price_raw, p.stop_price_raw]) {
        parseTradingAmount("USD_PER_BTC", {
          unit: "USD_PER_BTC",
          decimals: 6,
          raw,
        });
        requireJev(BigInt(raw) > 0n, "PRICE");
      }
    }
    account = a;
    remember(input.account);
  } else reasons.add("ACCOUNT_STALE_OR_UNKNOWN");
  const marketKnown = (
    r: JevContextRecord<TradingMarketData> | null,
    age: number,
  ) => {
    if (!r || !known(r, at)) return false;
    const p = r.payload;
    return (
      p.instrument_id === scope.instrument_id &&
      p.instrument_version === scope.instrument_version &&
      p.quality === "fresh" &&
      p.source_timestamp !== null &&
      jevTime(p.source_timestamp) <= at &&
      jevTime(p.received_at) <= at &&
      at - jevTime(p.source_timestamp) <= age &&
      at - jevTime(p.received_at) <= age
    );
  };
  let book = null;
  if (
    marketKnown(input.book, manifest.freshness.book_ms) &&
    input.book!.payload.payload.kind === "book"
  ) {
    const r = input.book!,
      p = r.payload.payload;
    requireJev(p.kind === "book", "BOOK_KIND");
    const bids = p.bids.slice(0, manifest.context.book_levels),
      asks = p.asks.slice(0, manifest.context.book_levels);
    requireJev(
      bids.length > 0 &&
        asks.length > 0 &&
        p.bids.length <= 20 &&
        p.asks.length <= 20,
      "BOOK_DEPTH",
    );
    for (const [levels, side] of [
      [p.bids, 1],
      [p.asks, -1],
    ] as const)
      for (let i = 0; i < levels.length; i++) {
        const l = levels[i]!;
        parseTradingAmount("USD_PER_BTC", l.price);
        parseTradingAmount("BTC", l.quantity);
        requireJev(
          BigInt(l.price.raw) > 0n &&
            BigInt(l.quantity.raw) > 0n &&
            (!i ||
              (side === 1
                ? BigInt(levels[i - 1]!.price.raw) > BigInt(l.price.raw)
                : BigInt(levels[i - 1]!.price.raw) < BigInt(l.price.raw))),
          "BOOK_LEVEL",
        );
      }
    const bid = BigInt(bids[0]!.price.raw),
      ask = BigInt(asks[0]!.price.raw);
    requireJev(bid < ask, "CROSSED_BOOK");
    const bq = bids.reduce((n, l) => n + BigInt(l.quantity.raw), 0n),
      aq = asks.reduce((n, l) => n + BigInt(l.quantity.raw), 0n);
    const depth = (ls: typeof bids) => ({
      unit: "USD" as const,
      decimals: 6 as const,
      raw: (
        ls.reduce(
          (n, l) => n + BigInt(l.quantity.raw) * BigInt(l.price.raw),
          0n,
        ) / 100000000n
      ).toString(),
    });
    book = {
      best_bid: price(bid),
      best_ask: price(ask),
      mid: price((bid + ask) / 2n),
      spread: price(ask - bid),
      bid_depth: depth(bids),
      ask_depth: depth(asks),
      imbalance: rate(bq - aq, bq + aq),
    };
    remember(r);
  } else reasons.add("BOOK_STALE_OR_UNKNOWN");
  let funding = null;
  if (
    marketKnown(input.mark_funding, manifest.freshness.mark_funding_ms) &&
    input.mark_funding!.payload.payload.kind === "mark_funding"
  ) {
    const r = input.mark_funding!,
      p = r.payload.payload;
    requireJev(p.kind === "mark_funding", "FUNDING_KIND");
    parseTradingAmount("USD_PER_BTC", p.mark_price);
    parseTradingAmount("USD_PER_BTC", p.oracle_price);
    requireJev(
      /^(0|-?[1-9][0-9]*)$/.test(p.funding_rate.raw) &&
        Number.isSafeInteger(p.funding_rate.decimals) &&
        p.funding_rate.decimals >= 0 &&
        p.funding_rate.decimals <= 18,
      "FUNDING_RATE",
    );
    funding = {
      mark_price: p.mark_price,
      oracle_price: p.oracle_price,
      current_rate: p.funding_rate,
      semantics: "current_context_not_settled_payment" as const,
    };
    remember(r);
  } else reasons.add("MARK_FUNDING_STALE_OR_UNKNOWN");
  const from = at - manifest.context.trade_window_seconds * 1000;
  const coverage = input.coverage;
  const covered =
    coverage &&
    known(coverage, at) &&
    jevTime(coverage.payload.start_at) <= from &&
    jevTime(coverage.payload.end_at) === at &&
    coverage.payload.gaps.every(
      (g) =>
        jevTime(g.start_at) >= at ||
        (g.end_at !== null && jevTime(g.end_at) <= from),
    );
  if (covered) remember(coverage);
  else reasons.add("FLOW_WINDOW_INCOMPLETE");
  const seen = new Set<string>();
  const trades = input.trades.filter((r) => {
    if (!known(r, at)) return false;
    const p = r.payload;
    if (
      p.payload.kind !== "trade" ||
      p.source_timestamp === null ||
      jevTime(p.source_timestamp) < from ||
      jevTime(p.source_timestamp) >= at
    )
      return false;
    requireJev(
      p.instrument_id === scope.instrument_id &&
        p.instrument_version === scope.instrument_version,
      "TRADE_INSTRUMENT",
    );
    if (p.quality !== "fresh" || jevTime(p.received_at) > at) {
      reasons.add("TRADE_QUALITY");
      return false;
    }
    requireJev(!seen.has(p.key), "DUPLICATE_TRADE");
    seen.add(p.key);
    remember(r);
    return true;
  });
  let buy = 0n,
    sell = 0n,
    notional = 0n;
  for (const r of trades) {
    const p = r.payload.payload;
    requireJev(p.kind === "trade", "TRADE_KIND");
    parseTradingAmount("BTC", p.quantity);
    parseTradingAmount("USD_PER_BTC", p.price);
    requireJev(
      BigInt(p.quantity.raw) > 0n && BigInt(p.price.raw) > 0n,
      "TRADE_AMOUNT",
    );
    requireJev(["buy", "sell"].includes(p.side), "TRADE_SIDE");
    const q = BigInt(p.quantity.raw);
    if (p.side === "buy") buy += q;
    else sell += q;
    notional += q * BigInt(p.price.raw);
  }
  const flow = {
    window_seconds: manifest.context.trade_window_seconds,
    quality:
      covered && !reasons.has("TRADE_QUALITY")
        ? "observed_no_known_gap"
        : "incomplete",
    continuity: "unproven",
    buy: quantity(buy),
    sell: quantity(sell),
    net: quantity(buy - sell),
    vwap: buy + sell ? price(notional / (buy + sell)) : null,
    trades: trades.length,
  };
  const barsByEnd = new Map<string, JevContextRecord<ClosedBar>>();
  for (const r of [...input.bars].sort(
    (a, b) =>
      a.recorded_at.localeCompare(b.recorded_at) ||
      a.object_id.localeCompare(b.object_id),
  )) {
    if (
      !known(r, at) ||
      jevTime(r.payload.end_at) > at ||
      jevTime(r.payload.closed_at) > at
    )
      continue;
    if (!barsByEnd.has(r.payload.end_at)) barsByEnd.set(r.payload.end_at, r);
  }
  const latest = Math.floor(at / 900000) * 900000;
  const bars: JevContextRecord<ClosedBar>[] = [];
  for (let index = 0; index < 15; index++) {
    const end = latest - index * 900000,
      r = barsByEnd.get(new Date(end).toISOString()),
      p = r?.payload;
    if (
      !r ||
      !p ||
      p.schema_version !== "trading.closed-bar.v1" ||
      p.build_version !== "btc-observed-bars.v1" ||
      p.interval_ms !== 900000 ||
      jevTime(p.start_at) !== end - 900000 ||
      end % 900000 !== 0 ||
      p.instrument_id !== scope.instrument_id ||
      p.instrument_version !== scope.instrument_version ||
      p.quality.state !== "observed_no_known_gap" ||
      !p.ohlc ||
      p.input_ids.length === 0 ||
      !p.input_ids.every((id) => dependencies.has(id))
    ) {
      reasons.add("BARS_INCOMPLETE");
      break;
    }
    const { ohlc: o } = p;
    requireJev(o.unit === "USD_PER_BTC" && o.decimals === 6, "BAR_UNIT");
    for (const raw of [o.open, o.high, o.low, o.close]) {
      parseTradingAmount("USD_PER_BTC", {
        unit: "USD_PER_BTC",
        decimals: 6,
        raw,
      });
      requireJev(BigInt(raw) > 0n, "BAR_PRICE");
    }
    requireJev(
      BigInt(o.high) >= BigInt(o.open) &&
        BigInt(o.high) >= BigInt(o.close) &&
        BigInt(o.low) <= BigInt(o.open) &&
        BigInt(o.low) <= BigInt(o.close),
      "BAR_OHLC",
    );
    bars.push(r);
    remember(r);
    for (const id of p.input_ids) remember(dependencies.get(id)!);
  }
  let indicators = null;
  if (bars.length === 15) {
    const candles = bars.map((r) => r.payload.ohlc!);
    let gain = 0n,
      loss = 0n;
    for (let i = 0; i < 14; i++) {
      const d = BigInt(candles[i]!.close) - BigInt(candles[i + 1]!.close);
      if (d > 0n) gain += d;
      else loss -= d;
    }
    indicators = {
      atr14: price(atr14(candles)),
      rsi14: manifest.context.information_set.includes("rsi")
        ? gain + loss
          ? rate(gain, gain + loss)
          : rate(1n, 2n)
        : null,
      returns: manifest.context.return_periods.map((period) => ({
        period_minutes: period * 15,
        value: rate(
          BigInt(candles[0]!.close) - BigInt(candles[period]!.close),
          BigInt(candles[period]!.close),
        ),
      })),
      last_closed_bar_end_at: bars[0]!.payload.end_at,
    };
  }
  return {
    schema_version: "btc.jev-context.v1",
    manifest_hash: manifestHash,
    cut_at: input.cut_at,
    scope,
    account,
    book,
    flow,
    funding,
    indicators,
    quality: {
      state: reasons.size ? "incomplete" : "observed_no_known_gap",
      reasons: [...reasons].sort(),
      continuity: "unproven",
    },
    input_refs: [...refs.values()].sort((a, b) =>
      a.object_id.localeCompare(b.object_id),
    ),
  };
}
