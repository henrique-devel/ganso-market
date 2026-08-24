import { describe, expect, it } from "vitest";

import type { QueryResult, SqlExecutor } from "../../../src/database.js";
import {
  acceptPaperOrder,
  brokerTick,
  engageKillSwitch,
  killSwitchTriggersTick,
  loadKillSwitch,
  markTick,
  requestCancel,
  settlementTick,
} from "../../../src/polymarket/paper/brokerstore.js";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// An in-memory world behind a fake pool that implements the exact SQL the
// store issues, INCLUDING its time bounds and mutations — the scenarios below
// are the RFC-011 mandatory tests for latency, queueing, cancellation,
// expiry, fees, settlement, marks and the kill switch.

interface World {
  orders: Row[];
  ledger: Row[];
  positions: Row[];
  kill: Row;
  snapshots: Array<{
    token_id: string;
    received_at: Date;
    source_ts: Date | null;
    bids_json: unknown;
    asks_json: unknown;
  }>;
  params: Array<{
    condition_id: string;
    param_version_id: number;
    version: number;
    valid_from: Date;
    tick_size: string;
    min_order_size: string;
    taker_fee_bps: string | null;
    neg_risk: boolean;
  }>;
  trades: Array<{
    trade_id: number;
    token_id: string;
    price: string;
    size: string | null;
    ts: Date;
  }>;
  resolutions: Array<{
    resolution_event_id: number;
    condition_id: string;
    event_type: string;
    payload_json: Record<string, unknown>;
    received_at: Date;
  }>;
  markets: Array<{
    condition_id: string;
    clob_token_ids: string[];
    neg_risk: boolean;
  }>;
}

function emptyWorld(): World {
  return {
    orders: [],
    ledger: [],
    positions: [],
    kill: {
      engaged: false,
      reason: null,
      frozen_markets_json: [],
      daily_anchor_date: null,
      daily_anchor_equity_usd: null,
    },
    snapshots: [],
    params: [],
    trades: [],
    resolutions: [],
    markets: [],
  };
}

function num(value: unknown): number {
  return typeof value === "string" ? Number(value) : (value as number);
}

function worldPool(world: World): SqlExecutor {
  return {
    query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      const rows = ((): Row[] => {
        // --- paper_orders ---
        if (text.startsWith("INSERT INTO paper_orders")) {
          world.orders.push({
            order_id: params[0],
            token_id: params[1],
            condition_id: params[2],
            side: params[3],
            order_type: params[4],
            limit_price: params[5],
            size: params[6],
            amount_usd: params[7],
            post_only: params[8],
            worst_price: params[9],
            expiration_s: params[10],
            policy_reason: params[11],
            policy_version: params[12],
            source: params[13],
            status: "open",
            filled_size: "0",
            queue_ahead: null,
            decided_at: params[14],
            accepted_at: params[15],
            cancel_requested_at: null,
            cancel_effective_at: null,
            closed_at: null,
            created_at: params[14],
          });
          return [];
        }
        if (
          text.startsWith(
            "SELECT order_id, token_id, condition_id, side, order_type, limit_price",
          )
        ) {
          return world.orders.filter((o) => o["status"] === "open");
        }
        if (
          text.startsWith(
            "SELECT order_id, token_id, condition_id, order_type, status",
          )
        ) {
          return world.orders.filter((o) => o["order_id"] === params[0]);
        }
        if (
          text.includes("SET status = $2, filled_size = $3, closed_at = $4")
        ) {
          for (const order of world.orders) {
            if (order["order_id"] === params[0] && order["status"] === "open") {
              order["status"] = params[1];
              order["filled_size"] = params[2];
              order["closed_at"] = params[3];
            }
          }
          return [];
        }
        if (text.includes("SET cancel_requested_at = $2")) {
          for (const order of world.orders) {
            if (order["order_id"] === params[0] && order["status"] === "open") {
              order["cancel_requested_at"] = params[1];
            }
          }
          return [];
        }
        if (text.includes("SET queue_ahead = $2")) {
          for (const order of world.orders) {
            if (
              order["order_id"] === params[0] &&
              order["queue_ahead"] === null
            ) {
              order["queue_ahead"] = params[1];
            }
          }
          return [];
        }
        if (text.includes("SET filled_size = $2 WHERE order_id = $1")) {
          for (const order of world.orders) {
            if (order["order_id"] === params[0] && order["status"] === "open") {
              order["filled_size"] = params[1];
            }
          }
          return [];
        }
        if (
          text.includes(
            "SET status = 'canceled', cancel_requested_at = COALESCE",
          )
        ) {
          for (const order of world.orders) {
            if (order["order_id"] === params[0] && order["status"] === "open") {
              order["status"] = "canceled";
              order["closed_at"] = params[1];
            }
          }
          return [];
        }
        if (
          text.startsWith(
            "SELECT order_id, token_id, condition_id FROM paper_orders WHERE status = 'open'",
          )
        ) {
          return world.orders.filter((o) => o["status"] === "open");
        }

        // --- ledger ---
        if (text.startsWith("INSERT INTO paper_ledger_events")) {
          const key = params[0] as string;
          if (world.ledger.some((e) => e["idempotency_key"] === key)) {
            return []; // duplicate absorbed; rowCount 0 via marker below
          }
          world.ledger.push({
            idempotency_key: key,
            event_type: params[1],
            order_id: params[2],
            token_id: params[3],
            condition_id: params[4],
            payload_json: JSON.parse(params[5] as string) as Row,
            event_ts: params[6],
            inserted: true,
          });
          return [{ inserted: true }];
        }
        if (text.includes("FROM paper_ledger_events WHERE token_id = $1")) {
          return world.ledger.filter((e) => e["token_id"] === params[0]);
        }

        // --- positions ---
        if (text.startsWith("INSERT INTO paper_positions")) {
          const existing = world.positions.find(
            (p) => p["token_id"] === params[0],
          );
          const next = {
            token_id: params[0],
            condition_id: params[1],
            shares: params[2],
            cost_usd: params[3],
            realized_pnl_usd: params[4],
            fees_paid_usd: params[5],
            opened_at: params[6],
            resolved_at: params[7],
            lockup_s: params[8],
            mark_value_usd: existing?.["mark_value_usd"] ?? null,
            mark_stale: existing?.["mark_stale"] ?? null,
          };
          if (existing !== undefined) {
            Object.assign(existing, next);
          } else {
            world.positions.push(next);
          }
          return [];
        }
        if (
          text.startsWith(
            "SELECT p.token_id, p.condition_id FROM paper_positions p",
          )
        ) {
          return world.positions.filter(
            (p) => num(p["shares"]) !== 0 && p["condition_id"] !== null,
          );
        }
        if (
          text.startsWith(
            "SELECT token_id, condition_id, shares FROM paper_positions",
          )
        ) {
          return world.positions.filter((p) => num(p["shares"]) !== 0);
        }
        if (text.includes("SET mark_value_usd = $2, mark_stale = FALSE")) {
          for (const position of world.positions) {
            if (position["token_id"] === params[0]) {
              position["mark_value_usd"] = params[1];
              position["mark_stale"] = false;
            }
          }
          return [];
        }
        if (text.includes("SET mark_stale = TRUE")) {
          for (const position of world.positions) {
            if (position["token_id"] === params[0]) {
              position["mark_stale"] = true;
            }
          }
          return [];
        }
        if (text.includes("SUM(realized_pnl_usd::numeric)")) {
          let realized = 0;
          let unrealized = 0;
          for (const p of world.positions) {
            realized += num(p["realized_pnl_usd"] ?? 0);
            const shares = num(p["shares"] ?? 0);
            if (shares !== 0) {
              const mark =
                p["mark_value_usd"] === null ||
                p["mark_value_usd"] === undefined
                  ? num(p["cost_usd"] ?? 0)
                  : num(p["mark_value_usd"]);
              const cost = num(p["cost_usd"] ?? 0);
              unrealized += shares > 0 ? mark - cost : cost - mark;
            }
          }
          return [
            { realized: String(realized), unrealized: String(unrealized) },
          ];
        }

        // --- kill switch ---
        if (text.startsWith("SELECT engaged, reason, frozen_markets_json")) {
          return [world.kill];
        }
        if (text.startsWith("SELECT daily_anchor_date")) {
          return [world.kill];
        }
        if (text.includes("SET engaged = TRUE")) {
          world.kill["engaged"] = true;
          world.kill["reason"] = params[0];
          return [];
        }
        if (text.includes("SET engaged = FALSE")) {
          world.kill["engaged"] = false;
          world.kill["reason"] = null;
          return [];
        }
        if (text.includes("SET frozen_markets_json")) {
          const frozen = world.kill["frozen_markets_json"] as string[];
          if (!frozen.includes(params[0] as string)) {
            frozen.push(params[0] as string);
          }
          return [];
        }
        if (text.includes("SET daily_anchor_date = $1")) {
          world.kill["daily_anchor_date"] = params[0];
          world.kill["daily_anchor_equity_usd"] = params[1];
          return [];
        }

        // --- recorder data ---
        if (text.includes("SELECT MAX(received_at) AS newest")) {
          const newest = world.snapshots.reduce<Date | null>(
            (acc, s) =>
              acc === null || s.received_at.getTime() > acc.getTime()
                ? s.received_at
                : acc,
            null,
          );
          return [{ newest }];
        }
        if (text.includes("FROM polymarket_book_snapshots")) {
          const eligible = world.snapshots
            .filter(
              (s) =>
                s.token_id === params[0] &&
                s.received_at.getTime() <= (params[1] as Date).getTime(),
            )
            .sort((a, b) => b.received_at.getTime() - a.received_at.getTime());
          const first = eligible[0];
          return first === undefined ? [] : [first as unknown as Row];
        }
        if (text.includes("FROM polymarket_param_versions")) {
          const eligible = world.params
            .filter(
              (p) =>
                p.condition_id === params[0] &&
                p.valid_from.getTime() <= (params[1] as Date).getTime(),
            )
            .sort((a, b) => b.version - a.version);
          const first = eligible[0];
          return first === undefined ? [] : [first as unknown as Row];
        }
        if (text.includes("FROM polymarket_trades")) {
          return world.trades
            .filter(
              (t) =>
                t.token_id === params[0] &&
                t.size !== null &&
                Number(t.price) === Number(params[1]) &&
                t.ts.getTime() > (params[2] as Date).getTime() &&
                t.ts.getTime() <= (params[3] as Date).getTime(),
            )
            .sort(
              (a, b) =>
                a.ts.getTime() - b.ts.getTime() || a.trade_id - b.trade_id,
            )
            .map((t) => ({
              trade_id: t.trade_id,
              size: t.size,
              effective_ts: t.ts,
            }));
        }
        if (
          text.includes("FROM polymarket_resolution_events") &&
          text.includes("JOIN paper_positions")
        ) {
          const held = new Set(
            world.positions
              .filter((p) => num(p["shares"]) !== 0)
              .map((p) => p["condition_id"]),
          );
          const disputed = new Set(
            world.resolutions
              .filter(
                (r) => r.event_type === "disputed" && held.has(r.condition_id),
              )
              .map((r) => r.condition_id),
          );
          return [...disputed].map((condition_id) => ({ condition_id }));
        }
        if (text.includes("FROM polymarket_resolution_events")) {
          const eligible = world.resolutions
            .filter(
              (r) =>
                r.condition_id === params[0] &&
                (r.event_type === "resolved" ||
                  r.event_type === "market_resolved"),
            )
            .sort((a, b) => b.received_at.getTime() - a.received_at.getTime());
          const first = eligible[0];
          return first === undefined ? [] : [first as unknown as Row];
        }
        if (text.includes("FROM polymarket_markets")) {
          return world.markets.filter(
            (m) => m.condition_id === params[0],
          ) as unknown as Row[];
        }
        throw new Error(`world pool has no handler for: ${text.slice(0, 80)}`);
      })();
      return Promise.resolve({
        rows: rows as R[],
        rowCount: rows.length,
      });
    },
  };
}

const T0 = new Date("2026-08-24T12:00:00.000Z");
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);
const silentSink = (): void => undefined;

function seedMarket(world: World): void {
  world.markets.push({
    condition_id: "0xcond",
    clob_token_ids: ["tok-yes", "tok-no"],
    neg_risk: false,
  });
  world.params.push({
    condition_id: "0xcond",
    param_version_id: 7,
    version: 1,
    valid_from: at(-86_400_000),
    tick_size: "0.01",
    min_order_size: "5",
    taker_fee_bps: "700",
    neg_risk: false,
  });
}

function seedBook(
  world: World,
  offsetMs: number,
  bidPrice: string,
  askPrice: string,
  size = "100",
): void {
  world.snapshots.push({
    token_id: "tok-yes",
    received_at: at(offsetMs),
    source_ts: at(offsetMs - 500),
    bids_json: [{ price: bidPrice, size }],
    asks_json: [{ price: askPrice, size }],
  });
}

async function acceptOrder(
  world: World,
  overrides: Partial<{
    orderId: string;
    side: "BUY" | "SELL";
    orderType: "GTC" | "GTD" | "FAK" | "FOK";
    limitPrice: string;
    size: string;
    worstPrice: string | null;
    ttlS: number | null;
    clockMs: number;
  }> = {},
): Promise<ReturnType<typeof acceptPaperOrder>> {
  const pool = worldPool(world);
  return acceptPaperOrder(
    pool,
    {
      orderId: overrides.orderId ?? "order-1",
      draft: {
        tokenId: "tok-yes",
        side: overrides.side ?? "BUY",
        orderType: overrides.orderType ?? "GTC",
        limitPrice: overrides.limitPrice ?? "0.48",
        size: overrides.size ?? "20",
        worstPrice: overrides.worstPrice ?? null,
        ttlS: overrides.ttlS ?? null,
      },
      conditionId: "0xcond",
      source: "manual",
    },
    {
      clock: () => at(overrides.clockMs ?? 0),
      latencyMs: 1_000,
      logSink: silentSink,
    },
  );
}

describe("acceptance", () => {
  it("accepts a passive order with the simulated latency", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    const outcome = await acceptOrder(world);
    expect(outcome.status).toBe("accepted");
    expect(world.orders[0]?.["status"]).toBe("open");
    expect(
      world.ledger.filter((e) => e["event_type"] === "order_accepted"),
    ).toHaveLength(1);
  });

  it("post-only that would cross is rejected with a ledger event", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    const outcome = await acceptOrder(world, { limitPrice: "0.53" });
    expect(outcome).toMatchObject({
      status: "rejected",
      httpStatus: 422,
      reason: "POST_ONLY_WOULD_CROSS",
    });
    expect(
      world.ledger.filter((e) => e["event_type"] === "order_rejected"),
    ).toHaveLength(1);
    expect(world.orders).toHaveLength(0);
  });

  it("validator failures surface as 422 with the exact reason", async () => {
    const world = emptyWorld();
    seedMarket(world);
    const outcome = await acceptOrder(world, { size: "4" });
    expect(outcome).toMatchObject({
      status: "rejected",
      httpStatus: 422,
      reason: "SIZE_BELOW_MIN",
    });
  });
});

describe("taker execution (C1 + B5)", () => {
  it("executes against the book of accept + 250ms, not the decision book", async () => {
    const world = emptyWorld();
    seedMarket(world);
    // Decision-time book: cheap ask. Book at exec (accept+delay): worse ask.
    seedBook(world, -2_000, "0.40", "0.50");
    seedBook(world, 1_100, "0.40", "0.55");
    await acceptOrder(world, {
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
      size: "20",
    });
    // accepted_at = T0+1000; exec at T0+1250; now = T0+2000.
    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });
    const fills = world.ledger.filter((e) => e["event_type"] === "fill");
    expect(fills).toHaveLength(1);
    const payload = fills[0]?.["payload_json"] as Row;
    expect(payload["price"]).toBe("0.550000");
    expect(payload["taker"]).toBe(true);
    // The fee comes from the versioned schedule (700 bps) at the exec price.
    expect(payload["fee_param_version_id"]).toBe(7);
    expect(payload["fee"]).toBe("0.346500");
    // The consumed slice rides inside the event for TTL-proof replay.
    expect(payload["book_slice"]).toEqual([
      { price: "0.550000", size: "20.000000" },
    ]);
    expect(world.orders[0]?.["status"]).toBe("filled");
    // Position cache refreshed from the ledger replay.
    expect(world.positions[0]?.["shares"]).toBe("20.000000");
  });

  it("cancel is BLOCKED during the taker delay", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50");
    await acceptOrder(world, {
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
    });
    // now = T0+1100: inside [accepted_at, accepted_at + 250ms).
    const outcome = await requestCancel(worldPool(world), "order-1", {
      clock: () => at(1_100),
      logSink: silentSink,
    });
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: "CANCEL_BLOCKED_TAKER_DELAY",
    });
  });

  it("FOK dies whole when the size cannot fill within worst", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.40", "0.50", "10");
    seedBook(world, 1_100, "0.40", "0.50", "10");
    await acceptOrder(world, {
      orderType: "FOK",
      limitPrice: "0.50",
      worstPrice: "0.50",
      size: "20",
    });
    await brokerTick(worldPool(world), {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });
    expect(world.ledger.filter((e) => e["event_type"] === "fill")).toHaveLength(
      0,
    );
    expect(world.orders[0]?.["status"]).toBe("canceled");
  });
});

describe("conservative passive queue (C2 + C3)", () => {
  it("joins behind all visible depth and fills only beyond the queue", async () => {
    const world = emptyWorld();
    seedMarket(world);
    // 100 resting at our level: the queue ahead.
    seedBook(world, -2_000, "0.48", "0.52", "100");
    seedBook(world, 900, "0.48", "0.52", "100");
    await acceptOrder(world, { size: "20" });
    // 60 traded: still behind the queue.
    world.trades.push({
      trade_id: 1,
      token_id: "tok-yes",
      price: "0.48",
      size: "60",
      ts: at(2_000),
    });
    await brokerTick(worldPool(world), {
      clock: () => at(3_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });
    expect(world.ledger.filter((e) => e["event_type"] === "fill")).toHaveLength(
      0,
    );
    // 70 more traded: 130 total, 30 beyond the queue -> at most 20 for us.
    world.trades.push({
      trade_id: 2,
      token_id: "tok-yes",
      price: "0.48",
      size: "70",
      ts: at(4_000),
    });
    await brokerTick(worldPool(world), {
      clock: () => at(5_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });
    const events = world.ledger.filter(
      (e) =>
        e["event_type"] === "fill" ||
        e["event_type"] === "fill_denied_degradation",
    );
    expect(events).toHaveLength(1);
    const payload = events[0]?.["payload_json"] as Row;
    expect(payload["size"]).toBe("20.000000");
    // Maker pays zero fee when the fill lands (denials carry no fee at all).
    if (events[0]?.["event_type"] === "fill") {
      expect(payload["fee"]).toBe("0.000000");
      expect(world.orders[0]?.["status"]).toBe("filled");
    } else {
      expect(world.orders[0]?.["status"]).toBe("open");
    }
  });

  it("a trade between cancel_requested and cancel_effective still fills", async () => {
    const world = emptyWorld();
    seedMarket(world);
    // Empty level: queue ahead is zero.
    seedBook(world, -2_000, "0.47", "0.52", "0");
    seedBook(world, 900, "0.47", "0.52", "0");
    await acceptOrder(world, { limitPrice: "0.48", size: "20" });
    // Cancel requested at T0+2000; latency 1000 -> effective T0+3000.
    await requestCancel(worldPool(world), "order-1", {
      clock: () => at(2_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });
    // Adverse trade inside the window still hits us.
    world.trades.push({
      trade_id: 1,
      token_id: "tok-yes",
      price: "0.48",
      size: "10",
      ts: at(2_500),
    });
    await brokerTick(worldPool(world), {
      clock: () => at(4_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });
    const fills = world.ledger.filter(
      (e) =>
        e["event_type"] === "fill" ||
        e["event_type"] === "fill_denied_degradation",
    );
    expect(fills).toHaveLength(1);
    expect(
      world.ledger.filter((e) => e["event_type"] === "cancel_effective"),
    ).toHaveLength(1);
    expect(world.orders[0]?.["status"]).toBe("canceled");
  });

  it("re-running the tick over the same data adds nothing (idempotent)", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.47", "0.52", "0");
    seedBook(world, 900, "0.47", "0.52", "0");
    await acceptOrder(world, { limitPrice: "0.48", size: "5" });
    world.trades.push({
      trade_id: 1,
      token_id: "tok-yes",
      price: "0.48",
      size: "10",
      ts: at(2_000),
    });
    const deps = {
      clock: () => at(3_000),
      latencyMs: 1_000,
      logSink: silentSink,
    };
    await brokerTick(worldPool(world), deps);
    const after = world.ledger.length;
    await brokerTick(worldPool(world), deps);
    await brokerTick(worldPool(world), deps);
    expect(world.ledger.length).toBe(after);
  });

  it("GTD expires one minute before the declared expiration", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.47", "0.52", "0");
    seedBook(world, 900, "0.47", "0.52", "0");
    // ttl 120s: declared = T0 + 60 + 120 = T0+180s; venue expiry T0+120s.
    await acceptOrder(world, {
      orderType: "GTD",
      limitPrice: "0.48",
      ttlS: 120,
    });
    await brokerTick(worldPool(world), {
      clock: () => at(121_000),
      latencyMs: 1_000,
      logSink: silentSink,
    });
    expect(world.orders[0]?.["status"]).toBe("expired");
    expect(
      world.ledger.filter((e) => e["event_type"] === "expired"),
    ).toHaveLength(1);
  });
});

describe("settlement (C5)", () => {
  function seedPosition(world: World, shares: string, cost: string): void {
    world.positions.push({
      token_id: "tok-yes",
      condition_id: "0xcond",
      shares,
      cost_usd: cost,
      realized_pnl_usd: "0",
      fees_paid_usd: "0",
      opened_at: at(-3_600_000),
      resolved_at: null,
      lockup_s: null,
      mark_value_usd: null,
      mark_stale: null,
    });
    // The replay needs the fill that built the position.
    world.ledger.push({
      idempotency_key: "seed:fill",
      event_type: "fill",
      order_id: "seed",
      token_id: "tok-yes",
      condition_id: "0xcond",
      payload_json: { side: "BUY", price: "0.50", size: shares, fee: "0" },
      event_ts: at(-3_600_000),
    });
  }

  it("settles YES at 1.00 through the ledger and records the lockup", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedPosition(world, "10", "5");
    world.resolutions.push({
      resolution_event_id: 99,
      condition_id: "0xcond",
      event_type: "resolved",
      payload_json: { outcomePrices: ["1", "0"] },
      received_at: at(0),
    });
    await settlementTick(worldPool(world), {
      clock: () => at(0),
      logSink: silentSink,
    });
    const resolution = world.ledger.find(
      (e) => e["event_type"] === "resolution",
    );
    expect((resolution?.["payload_json"] as Row)["outcome_price"]).toBe(
      "1.000000",
    );
    expect(world.positions[0]?.["shares"]).toBe("0.000000");
    expect(world.positions[0]?.["realized_pnl_usd"]).toBe("5.000000");
    expect(world.positions[0]?.["lockup_s"]).toBe(3_600);
  });

  it("a 50/50 outcome in a negRisk market freezes the market, never settles", async () => {
    const world = emptyWorld();
    seedMarket(world);
    const market = world.markets[0];
    if (market !== undefined) {
      market.neg_risk = true;
    }
    seedPosition(world, "10", "5");
    world.resolutions.push({
      resolution_event_id: 99,
      condition_id: "0xcond",
      event_type: "resolved",
      payload_json: { outcomePrices: ["0.5", "0.5"] },
      received_at: at(0),
    });
    await settlementTick(worldPool(world), {
      clock: () => at(0),
      logSink: silentSink,
    });
    expect(
      world.ledger.filter((e) => e["event_type"] === "resolution"),
    ).toHaveLength(0);
    expect(world.kill["frozen_markets_json"]).toContain("0xcond");
    expect(world.positions[0]?.["shares"]).toBe("10");
  });
});

describe("mark to executable bid (D2)", () => {
  it("marks with a full-size walk and freezes under a stale book", async () => {
    const world = emptyWorld();
    seedMarket(world);
    world.positions.push({
      token_id: "tok-yes",
      condition_id: "0xcond",
      shares: "100",
      cost_usd: "48",
      realized_pnl_usd: "0",
      fees_paid_usd: "0",
      opened_at: at(-3_600_000),
      resolved_at: null,
      lockup_s: null,
      mark_value_usd: null,
      mark_stale: null,
    });
    world.snapshots.push({
      token_id: "tok-yes",
      received_at: at(-1_000),
      source_ts: at(-1_500),
      bids_json: [
        { price: "0.50", size: "60" },
        { price: "0.45", size: "40" },
      ],
      asks_json: [{ price: "0.55", size: "100" }],
    });
    await markTick(worldPool(world), {
      clock: () => at(0),
      logSink: silentSink,
    });
    // 60 x 0.50 + 40 x 0.45 = 48: the whole size, never the touch.
    expect(world.positions[0]?.["mark_value_usd"]).toBe("48.000000");
    expect(world.positions[0]?.["mark_stale"]).toBe(false);

    // One hour later with no fresh book: STALE_MARK, value frozen.
    await markTick(worldPool(world), {
      clock: () => at(3_600_000),
      logSink: silentSink,
    });
    expect(world.positions[0]?.["mark_stale"]).toBe(true);
    expect(world.positions[0]?.["mark_value_usd"]).toBe("48.000000");
  });
});

describe("kill switch (D4)", () => {
  it("engaging cancels every open order and blocks new ones until rearm", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -2_000, "0.48", "0.52");
    await acceptOrder(world);
    await engageKillSwitch(worldPool(world), "MANUAL", at(1_000), {
      logSink: silentSink,
    });
    expect(world.orders[0]?.["status"]).toBe("canceled");
    const blocked = await acceptOrder(world, { orderId: "order-2" });
    expect(blocked).toMatchObject({
      status: "rejected",
      reason: "KILL_SWITCH_ENGAGED",
    });
    const state = await loadKillSwitch(worldPool(world));
    expect(state.engaged).toBe(true);
  });

  it("global recorder staleness engages the switch", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -10 * 60_000, "0.48", "0.52");
    await killSwitchTriggersTick(worldPool(world), {
      clock: () => at(0),
      logSink: silentSink,
    });
    expect(world.kill["engaged"]).toBe(true);
    expect(world.kill["reason"]).toBe("RECORDER_STALE");
  });

  it("a daily loss beyond the limit engages the switch", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -1_000, "0.48", "0.52");
    world.positions.push({
      token_id: "tok-yes",
      condition_id: "0xcond",
      shares: "0",
      cost_usd: "0",
      realized_pnl_usd: "0",
      fees_paid_usd: "0",
      mark_value_usd: null,
      mark_stale: null,
      opened_at: null,
      resolved_at: null,
      lockup_s: null,
    });
    const deps = {
      clock: () => at(0),
      logSink: silentSink,
      dailyLossLimitUsd: "50",
    };
    // First tick anchors the day at equity 0.
    await killSwitchTriggersTick(worldPool(world), deps);
    expect(world.kill["engaged"]).toBe(false);
    // The day turns against us beyond the limit.
    const position = world.positions[0];
    if (position !== undefined) {
      position["realized_pnl_usd"] = "-80";
    }
    await killSwitchTriggersTick(worldPool(world), deps);
    expect(world.kill["engaged"]).toBe(true);
    expect(world.kill["reason"]).toBe("DAILY_LOSS_LIMIT");
  });

  it("a UMA dispute on a held market freezes that market only", async () => {
    const world = emptyWorld();
    seedMarket(world);
    seedBook(world, -1_000, "0.48", "0.52");
    world.positions.push({
      token_id: "tok-yes",
      condition_id: "0xcond",
      shares: "10",
      cost_usd: "5",
      realized_pnl_usd: "0",
      fees_paid_usd: "0",
      mark_value_usd: "5",
      mark_stale: false,
      opened_at: at(-1_000),
      resolved_at: null,
      lockup_s: null,
    });
    world.resolutions.push({
      resolution_event_id: 1,
      condition_id: "0xcond",
      event_type: "disputed",
      payload_json: {},
      received_at: at(-500),
    });
    await killSwitchTriggersTick(worldPool(world), {
      clock: () => at(0),
      logSink: silentSink,
    });
    expect(world.kill["engaged"]).toBe(false);
    expect(world.kill["frozen_markets_json"]).toContain("0xcond");
    const blocked = await acceptOrder(world, { orderId: "order-9" });
    expect(blocked).toMatchObject({
      status: "rejected",
      reason: "MARKET_FROZEN_DISPUTE",
    });
  });
});
