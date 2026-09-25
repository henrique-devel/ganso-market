/** Structural inputs keep this pure core independent of adapter/runtime packages.
 * The storage adapter validates identity, event units and replay before projection. */
/** Public current-state response evidence, NOT a venue price-update timestamp.
 * Kept structural/pure so adapters, storage and financial readers apply one rule.
 */
export interface ContextSnapshot {
  basis: "http_response_date";
  requested_at: string;
  received_at: string;
  server_date: string;
  cache_status: "Miss from cloudfront";
  age: string | null;
  raw_context: unknown;
}
export function contextSnapshotTime(
  value: unknown,
  receivedAt: string,
): string | null {
  if (!value || typeof value !== "object") return null;
  const s = value as ContextSnapshot;
  const requested = Date.parse(s.requested_at),
    received = Date.parse(receivedAt),
    date = Date.parse(s.server_date);
  if (
    s.basis !== "http_response_date" ||
    s.received_at !== receivedAt ||
    s.cache_status !== "Miss from cloudfront" ||
    (s.age !== null && s.age !== "0") ||
    !Number.isSafeInteger(requested) ||
    !Number.isSafeInteger(received) ||
    !Number.isSafeInteger(date) ||
    new Date(requested).toISOString() !== s.requested_at ||
    new Date(received).toISOString() !== receivedAt ||
    new Date(date).toUTCString() !== s.server_date ||
    received < requested ||
    received - requested > 1500 ||
    date > received ||
    date < requested - 1000 ||
    received - date > 2500 ||
    !s.raw_context
  )
    return null;
  return new Date(date).toISOString();
}

export interface Amount {
  raw: string;
  unit: string;
  decimals: number;
}
interface TradingBookLevel {
  price: Amount;
  quantity: Amount;
}
interface TradingMarketData {
  schema_version: string;
  instrument_id: string;
  instrument_version: string;
  source_id: string;
  parser_version: string;
  channel: string;
  source_timestamp: string | null;
  received_at: string;
  quality: string;
  gap_epoch: number;
  payload:
    | {
        kind: "book";
        semantics: string;
        bids: readonly TradingBookLevel[];
        asks: readonly TradingBookLevel[];
      }
    | {
        kind: "mark_funding";
        mark_price: Amount;
        oracle_price: Amount;
        snapshot?: unknown;
      }
    | { kind: "trade" };
}
export interface LedgerProjection {
  schema_version: string;
  scope: {
    mode: "paper";
    account_id: string;
    experiment_id: string;
    instrument_id: string;
    instrument_version: string;
  };
  last_sequence: string;
  cash_usd_raw: string;
  positions: readonly { position_id: string; quantity_btc_raw: string }[];
}
interface FinancialEvent {
  sequence: string;
  payload:
    | {
        event_type: "fill";
        position_id: string;
        side: "buy" | "sell";
        quantity: { raw: string };
        price: { raw: string };
      }
    | { event_type: "fee" | "funding"; delta: { raw: string } }
    | { event_type: "cash" | "liquidation" };
}
/** Valuation contract v1 policy; neither a provider freshness claim nor a clock. */
export const VALUATION_LIMITS = Object.freeze({
  sourceAgeMs: 10_000,
  bookAgeMs: 2000,
  markAgeMs: 5000,
  futureToleranceMs: 1000,
});
export const VALUATION_VERSION = "btc.valuation.v1" as const;
const BTC_SCALE = 100_000_000n;
const abs = (n: bigint) => (n < 0n ? -n : n);
const sign = (n: bigint) => (n < 0n ? -1n : 1n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
/** Conservative floor to USD micro-units, including negative sub-micro PnL. */
const usd = (n: bigint) =>
  (n / BTC_SCALE - (n < 0n && n % BTC_SCALE !== 0n ? 1n : 0n)).toString();
export interface Position {
  position_id: string;
  quantity_btc_raw: string;
  /** Absolute weighted cost, USD at 14 decimals (BTC8 * price6). */
  cost_usd14_raw: string;
  /** Signed cumulative realized PnL, USD at 14 decimals. */
  realized_usd14_raw: string;
}
export interface FinancialProjection {
  schema_version: typeof VALUATION_VERSION;
  ledger: LedgerProjection;
  positions: readonly Position[];
  realized_pnl_usd_raw: string;
  /** Cash flows from S1 plus realized PnL; never free margin. */
  balance_usd_raw: string;
  fees_usd_raw: string;
  funding_usd_raw: string;
}
/** Weighted average cost. On partial closes allocate floor(cost * closed / qty)
 * at USD14 precision, retaining the remainder in the open position. A full
 * close consumes all remaining cost. Reversals close first, then open excess.
 * Round cumulative realized PnL once per account, never once per fill. Fees and
 * funding already change S1 cash; reserve is not an expense and slippage is
 * already in fill.price. External realized_pnl events remain unsupported. */
export function projectFinancials(
  ledger: LedgerProjection,
  events: readonly FinancialEvent[],
): FinancialProjection {
  const positions = new Map<string, Position>();
  let fees = 0n,
    funding = 0n;
  for (const event of [...events].sort((a, b) =>
    BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1,
  )) {
    const p = event.payload;
    if (p.event_type === "fee") fees += BigInt(p.delta.raw);
    if (p.event_type === "funding") funding += BigInt(p.delta.raw);
    if (p.event_type !== "fill") continue;
    const prev = positions.get(p.position_id);
    const before = BigInt(prev?.quantity_btc_raw ?? "0"),
      quantity = BigInt(p.quantity.raw),
      price = BigInt(p.price.raw);
    const delta = p.side === "buy" ? quantity : -quantity;
    let cost = BigInt(prev?.cost_usd14_raw ?? "0"),
      realized = BigInt(prev?.realized_usd14_raw ?? "0");
    if (before === 0n || sign(before) === sign(delta)) cost += quantity * price;
    else {
      const closed = min(abs(before), quantity);
      const allocated = (cost * closed) / abs(before);
      realized += sign(before) * (closed * price - allocated);
      cost -= allocated;
      if (quantity > closed) cost = (quantity - closed) * price;
    }
    positions.set(p.position_id, {
      position_id: p.position_id,
      quantity_btc_raw: (before + delta).toString(),
      cost_usd14_raw: cost.toString(),
      realized_usd14_raw: realized.toString(),
    });
  }
  const ordered = [...positions.values()].sort((a, b) =>
    a.position_id < b.position_id ? -1 : a.position_id > b.position_id ? 1 : 0,
  );
  const realized = usd(
    ordered.reduce((sum, p) => sum + BigInt(p.realized_usd14_raw), 0n),
  );
  return {
    schema_version: VALUATION_VERSION,
    ledger,
    positions: ordered,
    realized_pnl_usd_raw: realized,
    balance_usd_raw: (
      BigInt(ledger.cash_usd_raw) + BigInt(realized)
    ).toString(),
    fees_usd_raw: fees.toString(),
    funding_usd_raw: funding.toString(),
  };
}
export interface MarketEvidence {
  object_id: string;
  payload: TradingMarketData;
}
export interface ValuationCapture {
  at: number;
  health: {
    socket: { connected: boolean; alive: boolean };
    channels: Record<
      "book" | "context",
      { status: string; needs_revalidation: boolean; gap_epoch: number }
    >;
  };
}
export interface ValuationMarket {
  as_of: string;
  context: MarketEvidence | null;
  book: MarketEvidence | null;
  capture: ValuationCapture | null;
}
function time(value: string): number {
  const n = Date.parse(value);
  if (!Number.isSafeInteger(n) || n < 0 || new Date(n).toISOString() !== value)
    throw new Error("BTC_VALUATION_INVALID_TIME");
  return n;
}
function validAmount(
  value: { raw: string; unit: string; decimals: number },
  unit: string,
  decimals: number,
): boolean {
  return (
    value.unit === unit &&
    value.decimals === decimals &&
    /^[1-9][0-9]{0,77}$/.test(value.raw)
  );
}
type ValuationQuality =
  | "fresh"
  | "missing"
  | "incompatible"
  | "future"
  | "stale"
  | "feed_unavailable"
  | "source_time_unproven"
  | "invalid";
function quality(
  projection: FinancialProjection,
  market: ValuationMarket,
  kind: "book" | "context",
): ValuationQuality {
  const row = market[kind],
    now = time(market.as_of),
    event = row?.payload;
  if (!event) return "missing";
  const scope = projection.ledger.scope;
  const snapshotTime =
    event.payload.kind === "mark_funding" &&
    event.source_id === "hyperliquid:mainnet:info" &&
    event.parser_version === "hyperliquid.context-snapshot.v1" &&
    event.source_timestamp === null
      ? contextSnapshotTime(event.payload.snapshot, event.received_at)
      : null;
  if (
    event.instrument_id !== scope.instrument_id ||
    event.instrument_version !== scope.instrument_version ||
    event.channel !== kind ||
    !(
      (event.source_id === "hyperliquid:mainnet:ws" &&
        event.parser_version === "hyperliquid.feed.v1") ||
      (kind === "book" &&
        event.source_id === "hyperliquid:mainnet:info" &&
        event.parser_version === "hyperliquid.book-snapshot.v1") ||
      (kind === "context" && snapshotTime !== null)
    ) ||
    event.schema_version !== "trading.market-data.v1"
  )
    return "incompatible";
  const received = time(event.received_at),
    source =
      snapshotTime !== null
        ? time(snapshotTime)
        : event.source_timestamp === null
          ? null
          : time(event.source_timestamp);
  const maxAge =
    kind === "book" ? VALUATION_LIMITS.bookAgeMs : VALUATION_LIMITS.markAgeMs;
  if (
    received > now ||
    (source !== null &&
      (source > now || source > received + VALUATION_LIMITS.futureToleranceMs))
  )
    return "future";
  if (
    now - received > maxAge ||
    (source !== null && now - source > maxAge) ||
    event.quality === "stale"
  )
    return "stale";
  const capture = market.capture,
    channel = capture?.health.channels[kind];
  if (
    !capture ||
    capture.at > now ||
    capture.at < received ||
    now - capture.at > maxAge ||
    !capture.health.socket.connected ||
    !capture.health.socket.alive ||
    !channel ||
    channel.status !== "healthy" ||
    channel.needs_revalidation ||
    channel.gap_epoch !== event.gap_epoch
  )
    return "feed_unavailable";
  if (source === null || (!snapshotTime && event.quality !== "fresh"))
    return "source_time_unproven";
  return "fresh";
}
function validBook(levels: readonly TradingBookLevel[], bids: boolean) {
  if (levels.length > 20) return false;
  return levels.every(
    (level, i) =>
      validAmount(level.price, "USD_PER_BTC", 6) &&
      validAmount(level.quantity, "BTC", 8) &&
      (i === 0 ||
        (bids
          ? BigInt(levels[i - 1]!.price.raw) > BigInt(level.price.raw)
          : BigInt(levels[i - 1]!.price.raw) < BigInt(level.price.raw))),
  );
}
/** Read-only estimate, not execution or a risk authorization. No fallback from
 * mark to oracle/book/mid. Unknown source time exposes observations but no safe
 * equity. Fresh top-20 depth is finite and shared by positions on the same side.
 * Closing estimates are gross of future fees/funding (not yet ledger events). */
export function valueFinancials(
  projection: FinancialProjection,
  market: ValuationMarket,
) {
  time(market.as_of);
  const balance = BigInt(projection.balance_usd_raw),
    open = projection.positions.filter((p) => p.quantity_btc_raw !== "0");
  const context = market.context?.payload;
  let markQuality = quality(projection, market, "context");
  const prices =
    context?.payload.kind === "mark_funding" ? context.payload : null;
  if (
    context &&
    (!prices ||
      !validAmount(prices.mark_price, "USD_PER_BTC", 6) ||
      !validAmount(prices.oracle_price, "USD_PER_BTC", 6))
  )
    markQuality = "invalid";
  const canMark = markQuality === "fresh";
  const snapshotTime =
    context?.source_id === "hyperliquid:mainnet:info" &&
    context.payload.kind === "mark_funding"
      ? contextSnapshotTime(context.payload.snapshot, context.received_at)
      : null;
  const unrealized =
    open.length === 0
      ? "0"
      : canMark && prices
        ? usd(
            open.reduce(
              (sum, p) =>
                sum +
                sign(BigInt(p.quantity_btc_raw)) *
                  (abs(BigInt(p.quantity_btc_raw)) *
                    BigInt(prices.mark_price.raw) -
                    BigInt(p.cost_usd14_raw)),
              0n,
            ),
          )
        : null;
  let bookQuality = quality(projection, market, "book");
  const payload = market.book?.payload.payload;
  const book = payload?.kind === "book" ? payload : null;
  if (
    payload &&
    (!book ||
      book.semantics !== "full_snapshot_top_20" ||
      !validBook(book.bids, true) ||
      !validBook(book.asks, false) ||
      (book.bids.length > 0 &&
        book.asks.length > 0 &&
        BigInt(book.bids[0]!.price.raw) >= BigInt(book.asks[0]!.price.raw)))
  )
    bookQuality = "invalid";
  const depth = {
    sell:
      (bookQuality === "fresh" ? book : null)?.bids.map((l) => ({
        price: BigInt(l.price.raw),
        remaining: BigInt(l.quantity.raw),
      })) ?? [],
    buy:
      (bookQuality === "fresh" ? book : null)?.asks.map((l) => ({
        price: BigInt(l.price.raw),
        remaining: BigInt(l.quantity.raw),
      })) ?? [],
  };
  let closePnl = 0n;
  const exits = open.map((p) => {
    const q = BigInt(p.quantity_btc_raw),
      side = q > 0n ? ("sell" as const) : ("buy" as const);
    let remaining = abs(q),
      notional = 0n;
    if (bookQuality === "fresh")
      for (const level of depth[side]) {
        const take = min(remaining, level.remaining);
        notional += take * level.price;
        remaining -= take;
        level.remaining -= take;
        if (remaining === 0n) break;
      }
    const filled = abs(q) - remaining;
    const pnl =
      filled > 0n
        ? sign(q) * (notional - (BigInt(p.cost_usd14_raw) * filled) / abs(q))
        : null;
    if (pnl !== null) closePnl += pnl;
    return {
      position_id: p.position_id,
      side,
      requested_btc_raw: abs(q).toString(),
      executable_btc_raw: filled.toString(),
      unfilled_btc_raw: remaining.toString(),
      executable_notional_usd_raw: filled > 0n ? usd(notional) : null,
      pnl_usd_raw: pnl === null ? null : usd(pnl),
    };
  });
  const complete = exits.every((p) => p.unfilled_btc_raw === "0");
  return {
    ...projection,
    as_of: market.as_of,
    units: {
      money: "USD/6",
      quantity: "BTC/8",
      price: "USD_PER_BTC/6",
      cost_basis: "USD/14",
      rounding:
        "cost allocation floor at USD14 with remainder retained; aggregate signed PnL floor at USD6",
    },
    maintenance: {
      quality: markQuality,
      status: canMark
        ? "available"
        : markQuality === "source_time_unproven"
          ? "degraded"
          : "unavailable",
      mark_price: prices?.mark_price ?? null,
      oracle_price: prices?.oracle_price ?? null,
      evidence: market.context?.object_id ?? null,
      source_timestamp: context?.source_timestamp ?? null,
      freshness_timestamp: snapshotTime ?? context?.source_timestamp ?? null,
      timestamp_basis: snapshotTime
        ? "http_response_date"
        : context?.source_timestamp
          ? "venue_event"
          : "unknown",
      received_at: context?.received_at ?? null,
      unrealized_pnl_usd_raw: unrealized,
      equity_usd_raw:
        unrealized === null ? null : (balance + BigInt(unrealized)).toString(),
      usable_for_risk: canMark,
    },
    closing: {
      quality: bookQuality,
      status:
        open.length === 0
          ? "flat"
          : bookQuality !== "fresh"
            ? "unavailable"
            : complete
              ? "complete"
              : "partial",
      evidence: market.book?.object_id ?? null,
      source_timestamp: market.book?.payload.source_timestamp ?? null,
      received_at: market.book?.payload.received_at ?? null,
      positions: exits,
      gross_pnl_usd_raw:
        open.length === 0 || exits.some((p) => p.pnl_usd_raw !== null)
          ? usd(closePnl)
          : null,
      gross_equity_usd_raw: complete
        ? (balance + BigInt(usd(closePnl))).toString()
        : null,
      future_costs: "excluded_unincurred_fees_and_funding",
      depth_semantics:
        "observed_top_20_shared_per_account_not_a_fill_guarantee",
    },
  };
}

/** Today's UTC realized PnL + incurred fees/funding, excluding capital flows.
 * Late funding is assigned to occurred_at's day. S8 adds unrealized/anchors. */
export function dailyFinancialCosts(
  ledger: LedgerProjection,
  events: readonly (FinancialEvent & { occurred_at: string })[],
  asOf: string,
) {
  const day = asOf.slice(0, 10) + "T00:00:00.000Z";
  const current = projectFinancials(
    ledger,
    events.filter((e) => e.occurred_at <= asOf),
  );
  const previous = projectFinancials(
    ledger,
    events.filter((e) => e.occurred_at < day),
  );
  const delta = (
    key: "realized_pnl_usd_raw" | "fees_usd_raw" | "funding_usd_raw",
  ) => BigInt(current[key]) - BigInt(previous[key]);
  return {
    day_start: day,
    realized_pnl_usd_raw: delta("realized_pnl_usd_raw").toString(),
    fees_usd_raw: delta("fees_usd_raw").toString(),
    funding_usd_raw: delta("funding_usd_raw").toString(),
    net_realized_costs_usd_raw: (
      delta("realized_pnl_usd_raw") +
      delta("fees_usd_raw") +
      delta("funding_usd_raw")
    ).toString(),
  };
}
