import { jevHash } from "../../storage/jev-hash.js";
import {
  LIVE_VERSION,
  liveCheck,
  liveInteger,
  liveRaw,
  liveRecord,
  type LiveIdentity,
} from "./live-contract.js";
import type { createHyperliquidLiveBoundary } from "./live-auth.js";

export interface LiveFill {
  key: string;
  time: number;
  oid: number;
  cloid: string | null;
  side: "buy" | "sell";
  quantity_raw: string;
  price_raw: string;
  start_position_raw: string;
  fee_raw: string;
  realized_pnl_raw: string;
  maker: boolean;
  original: Record<string, unknown>;
}
export interface LiveFunding {
  key: string;
  time: number;
  amount_raw: string;
  position_raw: string;
  rate_raw: string;
  original: Record<string, unknown>;
}
export interface LiveOpenOrder {
  oid: number;
  cloid: string | null;
  side: "buy" | "sell";
  quantity_raw: string;
  limit_price_raw: string;
  reduce_only: boolean;
  position_stop: boolean;
  trigger_price_raw: string | null;
  original: Record<string, unknown>;
}
export interface LiveSnapshot {
  version: typeof LIVE_VERSION;
  identity_hash: string;
  snapshot_id: string;
  started_at: number;
  received_at: number;
  venue_at: number;
  position_raw: string;
  trading_balance_raw: string;
  equity_raw: string;
  open_pnl_raw: string;
  isolated_1x: boolean;
  history_complete: boolean;
  consistent: boolean;
  flat: boolean;
  orders: LiveOpenOrder[];
  fills: LiveFill[];
  funding: LiveFunding[];
  original: unknown;
}
function venueHash(v: unknown) {
  liveCheck(typeof v === "string" && /^0x[a-f0-9]{64}$/.test(v), "SOURCE_HASH");
  return v;
}
export function parseLiveFill(value: unknown): LiveFill {
  const x = liveRecord(value);
  liveCheck(
    x.coin === "BTC" &&
      (x.side === "A" || x.side === "B") &&
      typeof x.crossed === "boolean" &&
      x.feeToken === "USDC",
    "FILL_CONTRACT",
  );
  const q = liveRaw(x.sz, 8),
    px = liveRaw(x.px, 6);
  liveCheck(BigInt(q) > 0n && BigInt(px) > 0n, "FILL_AMOUNT");
  if (x.builderFee !== undefined)
    liveCheck(liveRaw(x.builderFee, 6) === "0", "UNEXPECTED_BUILDER_FEE");
  return {
    key: `fill:${venueHash(x.hash)}:${liveInteger(x.tid)}`,
    time: liveInteger(x.time),
    oid: liveInteger(x.oid, 1),
    cloid: typeof x.cloid === "string" ? x.cloid : null,
    side: x.side === "B" ? "buy" : "sell",
    quantity_raw: q,
    price_raw: px,
    start_position_raw: liveRaw(x.startPosition, 8),
    fee_raw: liveRaw(x.fee, 6),
    realized_pnl_raw: liveRaw(x.closedPnl, 6),
    maker: !x.crossed,
    original: x,
  };
}
export function parseLiveFunding(value: unknown): LiveFunding {
  const x = liveRecord(value),
    d = liveRecord(x.delta);
  liveCheck(d.type === "funding" && d.coin === "BTC", "FUNDING_CONTRACT");
  return {
    key: `funding:${venueHash(x.hash)}:${liveInteger(x.time)}`,
    time: liveInteger(x.time),
    amount_raw: liveRaw(d.usdc, 6),
    position_raw: liveRaw(d.szi, 8),
    rate_raw: liveRaw(d.fundingRate, 18),
    original: x,
  };
}
export function parseLiveOrders(value: unknown): LiveOpenOrder[] {
  liveCheck(Array.isArray(value) && value.length <= 2000, "ORDERS_RESPONSE");
  return value.map((v) => {
    const x = liveRecord(v);
    liveCheck(
      x.coin === "BTC" &&
        (x.side === "A" || x.side === "B") &&
        typeof x.reduceOnly === "boolean" &&
        typeof x.isPositionTpsl === "boolean" &&
        typeof x.isTrigger === "boolean",
      "ORDER_CONTRACT",
    );
    return {
      oid: liveInteger(x.oid, 1),
      cloid: typeof x.cloid === "string" ? x.cloid : null,
      side: x.side === "B" ? "buy" : "sell",
      quantity_raw: liveRaw(x.sz, 8),
      limit_price_raw: liveRaw(x.limitPx, 6),
      reduce_only: x.reduceOnly,
      position_stop:
        x.isPositionTpsl && x.isTrigger && x.orderType === "Stop Market",
      trigger_price_raw: x.isTrigger ? liveRaw(x.triggerPx, 6) : null,
      original: x,
    };
  });
}
/** Restart recovery is read-only at the venue. Unknown ownership/receipt/history
 * remains explicit in the durable journal; it does not release entry admission. */
export async function recoverLiveAccount(input: {
  boundary: ReturnType<typeof createHyperliquidLiveBoundary>;
  execution: import("./live-execution.js").LiveExecution;
  from: number;
  clock?: () => number;
}) {
  const { execution } = input,
    clock = input.clock ?? Date.now,
    store = execution.store;
  try {
    const requests = await store.operations();
    const receipts =
      await store.events<import("./live-execution.js").LiveReceipt>("receipt");
    for (const r of requests) {
      const latest = receipts
        .filter((e) => e.operation_id === r.operation_id)
        .at(-1);
      if (!latest || latest.state === "uncertain") await execution.recover(r);
    }
    const snapshot = await collectLiveSnapshot(
      input.boundary,
      input.from,
      clock,
    );
    await store.save(snapshot);
    const observedReceipts =
      await store.events<import("./live-execution.js").LiveReceipt>("receipt");
    const owns = (cloid: string | null, oid: number) =>
      requests.some(
        (r) =>
          r.cloid === cloid ||
          observedReceipts.some(
            (e) => e.operation_id === r.operation_id && e.oid === oid,
          ),
      );
    const unknown =
      snapshot.orders.some((o) => !owns(o.cloid, o.oid)) ||
      snapshot.fills.some((f) => !owns(f.cloid, f.oid));
    const pending =
      !snapshot.history_complete ||
      !snapshot.consistent ||
      unknown ||
      (await store.latest()).pending;
    if (pending)
      await store.append("gap", `gap:recovery:${snapshot.snapshot_id}`, {
        reason: unknown ? "VENUE_OWNERSHIP_UNKNOWN" : "RECONCILIATION_REQUIRED",
        snapshot_id: snapshot.snapshot_id,
      });
    return { snapshot, pending };
  } catch {
    await store.append("gap", `gap:recovery:${clock()}`, {
      reason: "RECONCILIATION_UNAVAILABLE",
    });
    return { snapshot: null, pending: true };
  }
}
export function parseLivePosition(value: unknown) {
  const x = liveRecord(value),
    margin = liveRecord(x.marginSummary);
  liveCheck(
    Array.isArray(x.assetPositions) && x.assetPositions.length <= 100,
    "POSITION_RESPONSE",
  );
  const positions = x.assetPositions.map((p) =>
    liveRecord(liveRecord(p).position),
  );
  liveCheck(
    positions.every((p) => p.coin === "BTC" || liveRaw(p.szi, 8) === "0") &&
      positions.filter((p) => p.coin === "BTC").length <= 1,
    "EXTRA_POSITION",
  );
  const p = positions.find((p) => p.coin === "BTC");
  const leverage = p ? liveRecord(p.leverage) : null;
  const position_raw = p ? liveRaw(p.szi, 8) : "0",
    pnl = p ? liveRaw(p.unrealizedPnl, 6) : "0";
  const balance = liveRaw(margin.totalRawUsd, 6),
    equity = liveRaw(margin.accountValue, 6);
  liveCheck(
    BigInt(balance) + BigInt(pnl) === BigInt(equity),
    "BALANCE_DIVERGENCE",
  );
  return {
    venue_at: liveInteger(x.time),
    position_raw,
    trading_balance_raw: balance,
    equity_raw: equity,
    open_pnl_raw: pnl,
    isolated_1x:
      !!leverage && leverage.type === "isolated" && leverage.value === 1,
  };
}
/** Inclusive timestamp pagination. Never advance by +1 and silently skip same-ms data.
 * A saturated timestamp or 10k retained-fill ceiling is an explicit gap. */
export async function livePages<
  T extends { key: string; time: number },
>(input: {
  request: (startTime: number, endTime: number) => Promise<unknown>;
  parse: (v: unknown) => T;
  start: number;
  end: number;
  cap: number;
}) {
  const rows = new Map<string, T>();
  let cursor = input.start;
  for (let page = 0; page < 24; page += 1) {
    const value = await input.request(cursor, input.end);
    liveCheck(
      Array.isArray(value) && value.length <= input.cap,
      "PAGE_RESPONSE",
    );
    const parsed = value.map(input.parse);
    for (const row of parsed) {
      liveCheck(row.time >= cursor && row.time <= input.end, "PAGE_CLOCK");
      const old = rows.get(row.key);
      liveCheck(!old || jevHash(old) === jevHash(row), "SOURCE_COLLISION");
      rows.set(row.key, row);
    }
    liveCheck(rows.size < 10000, "HISTORY_TRUNCATED");
    if (value.length < input.cap)
      return [...rows.values()].sort(
        (a, b) => a.time - b.time || a.key.localeCompare(b.key),
      );
    const next = Math.max(...parsed.map((r) => r.time));
    liveCheck(next > cursor, "PAGE_SATURATED_TIMESTAMP");
    cursor = next;
  }
  throw new Error("HYPERLIQUID_LIVE_PAGE_LIMIT");
}
export async function collectLiveSnapshot(
  boundary: ReturnType<typeof createHyperliquidLiveBoundary>,
  start: number,
  clock: () => number = Date.now,
): Promise<LiveSnapshot> {
  const started_at = clock();
  liveCheck(start <= started_at, "HISTORY_START");
  const before = await boundary.info("clearinghouseState"),
    ordersBefore = await boundary.info("frontendOpenOrders");
  const fills = await livePages({
    request: (startTime, endTime) =>
      boundary.info("userFillsByTime", {
        startTime,
        endTime,
        aggregateByTime: false,
      }),
    parse: parseLiveFill,
    start,
    end: started_at,
    cap: 2000,
  });
  const funding = await livePages({
    request: (startTime, endTime) =>
      boundary.info("userFunding", { startTime, endTime }),
    parse: parseLiveFunding,
    start,
    end: started_at,
    cap: 500,
  });
  const active = liveRecord(
    await boundary.info("activeAssetData", { coin: "BTC" }),
  );
  liveCheck(
    active.user === boundary.identity.account_address && active.coin === "BTC",
    "ACTIVE_ASSET_OWNER",
  );
  const activeLeverage = liveRecord(active.leverage);
  const after = await boundary.info("clearinghouseState"),
    ordersAfter = await boundary.info("frontendOpenOrders"),
    received_at = clock();
  const a = parseLivePosition(before),
    b = parseLivePosition(after),
    orders = parseLiveOrders(ordersAfter);
  const consistent =
    jevHash({ ...a, venue_at: 0 }) === jevHash({ ...b, venue_at: 0 }) &&
    jevHash(ordersBefore) === jevHash(ordersAfter) &&
    b.venue_at >= a.venue_at &&
    b.venue_at <= received_at &&
    received_at - a.venue_at <= 2000 &&
    received_at - started_at <= 2000;
  let q = 0n,
    history_complete = true;
  const ordered: LiveFill[] = [];
  for (const time of [...new Set(fills.map((f) => f.time))]) {
    const group = fills.filter((f) => f.time === time);
    while (group.length) {
      if (group.filter((f) => BigInt(f.start_position_raw) === q).length > 1)
        history_complete = false;
      let index = group.findIndex((f) => BigInt(f.start_position_raw) === q);
      if (index < 0) {
        history_complete = false;
        index = 0;
      }
      const f = group.splice(index, 1)[0]!;
      ordered.push(f);
      q =
        BigInt(f.start_position_raw) +
        (f.side === "buy" ? 1n : -1n) * BigInt(f.quantity_raw);
    }
  }
  history_complete &&= q === BigInt(b.position_raw);
  const original = {
    before,
    after,
    active,
    orders_before: ordersBefore,
    orders_after: ordersAfter,
    fill_keys: ordered.map((f) => f.key),
    funding_keys: funding.map((f) => f.key),
  };
  return {
    version: LIVE_VERSION,
    identity_hash: jevHash(boundary.identity),
    snapshot_id: jevHash({ original, started_at, received_at }),
    started_at,
    received_at,
    ...b,
    isolated_1x:
      activeLeverage.type === "isolated" &&
      activeLeverage.value === 1 &&
      (b.position_raw === "0" || b.isolated_1x),
    consistent,
    history_complete,
    flat:
      b.position_raw === "0" &&
      orders.length === 0 &&
      consistent &&
      history_complete,
    orders,
    fills: ordered,
    funding,
    original,
  };
}
export function requireLiveFreshSnapshot(
  i: LiveIdentity,
  s: LiveSnapshot,
  now: number,
) {
  liveCheck(
    s.identity_hash === jevHash(i) &&
      s.version === LIVE_VERSION &&
      s.received_at <= now &&
      s.venue_at <= now &&
      now - s.started_at <= 2000 &&
      s.consistent,
    "RECONCILIATION_REQUIRED",
  );
}
