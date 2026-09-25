import { describe, expect, it } from "vitest";
import {
  parseTradingContract,
  tradingIdempotencyKey,
} from "@ganso-market/contracts/trading";
import {
  baselinePosition,
  manageBaselineExit,
  revalidateBaselineExit,
  type BaselineExitInput,
} from "../../src/storage/baseline-exits.js";
import {
  decideBaseline,
  baselineAmount,
  baselineQuantity,
} from "../../src/storage/baseline-policy.js";
import {
  baselineHash,
  baselineIso,
} from "../../src/storage/baseline-inputs.js";
import { reservationHold } from "../../src/trading/reservations.js";
import { fixture, rehash, tick, AT, T, px } from "./baseline-fixture.js";

function opened(direction: "long" | "short" = "long") {
  const input = fixture(direction),
    decision = decideBaseline(input),
    order = decision.command!.order,
    scope = input.registration.scope;
  const fill = (n: number, occurred = AT + 2345 + n, q = "91000") =>
    parseTradingContract("ledger", {
      schema_version: "trading.v1",
      ...scope,
      event_id: `fill:${n}`,
      idempotency_key: tradingIdempotencyKey(scope, "ledger", `fill:${n}`),
      transaction_id: `tx:${n}`,
      sequence: `${n + 2}`,
      cause_id: order.order_id,
      occurred_at: baselineIso(occurred),
      recorded_at: baselineIso(occurred),
      payload: {
        event_type: "fill",
        execution_id: `execution:${n}`,
        order_id: order.order_id,
        position_id: order.position_id,
        side: order.side,
        quantity: baselineQuantity(q),
        price: baselineAmount(px(100000)),
      },
    });
  const fills = [fill(0), fill(1)];
  const position = baselinePosition(decision, fills, baselineIso(AT + 3000));
  const signed = direction === "long" ? "182000" : "-182000";
  Object.assign(input.account.payload.projection, {
    positions: [
      {
        position_id: order.position_id,
        quantity_btc_raw: signed,
        cost_usd14_raw: (182000n * 100000000000n).toString(),
        realized_usd14_raw: "0",
      },
    ],
  });
  tick(input, AT + 3000);
  const run = (extra: Partial<BaselineExitInput> = {}) =>
    manageBaselineExit({
      ...input,
      now: input.decision_at,
      position,
      liquidatable: false,
      attempts: [],
      ...extra,
    });
  return { input, decision, position, fill, fills, run };
}

describe("baseline persistent exits, without an automatic executor", () => {
  it("revalidates exits against the real post-latency book without entry or funding permission", () => {
    const { input, position, run } = opened();
    tick(input, Date.parse(position.deadline));
    const plan = run();
    input.account.payload.reservations = [
      reservationHold(plan.command!.order, 182000n),
    ];
    input.account.payload.entries_paused = true;
    input.account.payload.funding_usable_for_risk = false;
    input.account.payload.risk.state = "REDUCE_ONLY";
    rehash(input.account);
    expect(
      revalidateBaselineExit(
        plan,
        { ...input, liquidatable: false },
        input.decision_at,
      ).state,
    ).toBe("waiting");
    tick(input, Date.parse(position.deadline) + 1001);
    expect(
      revalidateBaselineExit(
        plan,
        { ...input, liquidatable: false },
        input.decision_at,
      ).state,
    ).toBe("ready");
    input.account.payload.risk.state = "HALTED";
    rehash(input.account);
    expect(
      revalidateBaselineExit(
        plan,
        { ...input, liquidatable: false },
        input.decision_at,
      ).reasons,
    ).toContain("accounting_halt");
    tick(input, Date.parse(position.deadline) + 5000);
    expect(
      revalidateBaselineExit(
        plan,
        { ...input, liquidatable: false },
        input.decision_at,
      ).reasons,
    ).toContain("intent_expired");
  });

  it("uses the first actual fill, preserves partial/restart time, and rejects a changed origin", () => {
    const { decision, fills, position } = opened();
    expect(position.opened_at).toBe(baselineIso(AT + 2345));
    expect(position.deadline).toBe(baselineIso(AT + 2345 + 21600000));
    expect(
      baselinePosition(
        decision,
        [...fills].reverse(),
        baselineIso(AT + 4000),
        position,
      ),
    ).toEqual(position);
    expect(() =>
      baselinePosition(
        decision,
        fills.slice(1),
        baselineIso(AT + 4000),
        position,
      ),
    ).toThrow("POSITION_CHANGED");
    expect(() =>
      baselinePosition(decision, [], baselineIso(AT + 4000)),
    ).toThrow("ENTRY_FILLS");
  });
  it.each(["long", "short"] as const)(
    "triggers %s stop inclusively and selects only the observed closing side",
    (direction) => {
      const { input, position, run } = opened(direction);
      const book = input.market.book!.payload.payload;
      if (book.kind !== "book") throw new Error("fixture");
      const stop = BigInt(position.stop_usd_raw);
      Object.assign(book.bids[0]!.price, {
        raw: (direction === "long" ? stop : stop - 1000000n).toString(),
      });
      Object.assign(book.asks[0]!.price, {
        raw: (direction === "short" ? stop : stop + 1000000n).toString(),
      });
      const side = direction === "long" ? book.bids : book.asks;
      Object.assign(book, {
        [direction === "long" ? "bids" : "asks"]: [
          ...side,
          {
            ...side[0],
            price: {
              ...side[0]!.price,
              raw: (
                stop + (direction === "long" ? -10000000n : 10000000n)
              ).toString(),
            },
          },
        ],
      });
      rehash(input.market.book!);
      const result = run();
      expect(result.state).toBe("reduce_candidate");
      expect(result.reason).toBe("stop");
      expect(result.command!.order).toMatchObject({
        intent: "reduce",
        side: direction === "long" ? "sell" : "buy",
        quantity_btc_raw: "182000",
      });
      expect(result.command!.intent.limit_price_usd_raw).toBe(
        (stop + (direction === "long" ? -10000000n : 10000000n)).toString(),
      );
      expect(result.command!.intent.latency_ms).toBe(1000);
      expect(result.command!.order.valid_until).toBe(
        baselineIso(Date.parse(input.decision_at) + 5000),
      );
    },
  );
  it("requests time exit exactly at 6h and persists it through missing books, warmup and entry pauses", () => {
    const { input, position, run } = opened();
    const deadline = Date.parse(position.deadline);
    input.account.payload.entries_paused = true;
    input.hours.records = [];
    input.quarters.records = [];
    tick(input, deadline - 1);
    expect(run().state).toBe("holding");
    tick(input, deadline);
    const exit = run();
    expect(exit.state).toBe("reduce_candidate");
    expect(exit.position.reasons).toEqual(["max_holding"]);
    expect(exit.overdue_ms).toBe(0);
    input.market.book = null;
    input.market.context = null;
    tick(input, deadline + 1000);
    const pending = run({ position: exit.position });
    expect(pending.state).toBe("exit_pending");
    expect(pending.pending_causes).toContain("book_unavailable");
    expect(pending.position.requested_at).toBe(position.deadline);
    expect(pending.overdue_ms).toBe(1000);
    expect(pending.command).toBe(null);
  });
  it("does not infer a stopped price or exit fill from stale/gapped candles", () => {
    const { input, run } = opened();
    input.market.book = null;
    input.hours.records[0]!.payload.ohlc!.close = px(1);
    tick(input, AT + 4000);
    const result = run();
    expect(result.state).toBe("holding");
    expect(result.command).toBe(null);
    input.market.book = fixture().market.book; // old receipt is stale at this tick
    tick(input, AT + 7000);
    Object.assign(input.market.book!.payload, {
      source_timestamp: baselineIso(AT),
    });
    rehash(input.market.book!);
    expect(run().state).toBe("holding");
  });
  it("exits on neutral trend only in a valid decision context, without needing quarter warmup or Jev", () => {
    const { input, run } = opened();
    input.quarters.records = [];
    input.account.payload.entries_paused = true;
    rehash(input.account);
    const context = {
      bar_end_at: baselineIso(T),
      hours: fixture("neutral").hours,
    };
    expect(run({ decision_context: context }).position.reasons).toEqual([
      "trend",
    ]);
    context.hours.records.pop();
    expect(run({ decision_context: context }).state).toBe("holding");
    tick(input, T + 60000);
    expect(
      run({
        decision_context: {
          bar_end_at: baselineIso(T),
          hours: fixture("neutral").hours,
        },
      }).state,
    ).toBe("holding");
  });
  it("preserves all exit causes and prioritizes reconciliation, liquidation, risk, stop, time and trend", () => {
    const { input, position, run } = opened();
    const now = Date.parse(position.deadline);
    tick(input, now);
    input.account.payload.risk.state = "REDUCE_ONLY";
    input.account.payload.risk.reasons = ["daily_loss"];
    rehash(input.account);
    if (input.market.book!.payload.payload.kind === "book")
      Object.assign(input.market.book!.payload.payload.bids[0]!.price, {
        raw: position.stop_usd_raw,
      });
    rehash(input.market.book!);
    const result = run();
    expect(result.reason).toBe("risk_pause");
    expect(result.position.reasons).toEqual([
      "risk_pause",
      "stop",
      "max_holding",
    ]);
    expect(run({ liquidatable: true }).state).toBe("liquidation_required");
    expect(run({ liquidatable: true }).reason).toBe("liquidation");
    input.account.payload.risk.state = "HALTED";
    rehash(input.account);
    const halted = run({ liquidatable: true });
    expect(halted.state).toBe("reconcile");
    expect(halted.reason).toBe("accounting_halt");
    expect(halted.command).toBe(null);
    expect(halted.position.reasons).toEqual([
      "accounting_halt",
      "liquidation",
      "risk_pause",
      "stop",
      "max_holding",
    ]);
  });
  it("cancels increases, blocks concurrent IOC and retries only a newer economic book", () => {
    const { input, position, decision, run } = opened();
    tick(input, Date.parse(position.deadline));
    input.account.payload.reservations = [
      reservationHold(decision.command!.order, 1000n),
    ];
    rehash(input.account);
    const result = run();
    expect(result.cancel_order_ids).toEqual([decision.command!.order.order_id]);
    const attempt = {
      order_id: result.command!.order.order_id,
      book_key: result.book_key!,
      source_at: input.market.book!.payload.source_timestamp!,
      status: "active" as const,
    };
    expect(run({ attempts: [attempt] }).pending_causes).toContain(
      "ioc_in_flight",
    );
    expect(
      run({ attempts: [{ ...attempt, status: "terminal" }] }).pending_causes,
    ).toContain("new_observed_book_required");
    input.market.book!.object_id = "another-id-same-economic-book";
    expect(
      run({ attempts: [{ ...attempt, status: "terminal" }] }).pending_causes,
    ).toContain("new_observed_book_required");
    tick(input, Date.parse(input.decision_at) + 1000);
    expect(run({ attempts: [{ ...attempt, status: "terminal" }] }).state).toBe(
      "reduce_candidate",
    );
  });
  it("retains stop and exit request after a rebound and never rearms a halted account", () => {
    const { input, run } = opened();
    if (input.market.book!.payload.payload.kind === "book")
      Object.assign(input.market.book!.payload.payload.bids[0]!.price, {
        raw: px(99000),
      });
    rehash(input.market.book!);
    const first = run();
    const before = baselineHash(first.position);
    if (input.market.book!.payload.payload.kind === "book")
      Object.assign(input.market.book!.payload.payload.bids[0]!.price, {
        raw: px(99990),
      });
    tick(input, AT + 4000);
    const rebound = run({ position: first.position });
    expect(rebound.state).toBe("reduce_candidate");
    expect(baselineHash(rebound.position)).toBe(before);
    input.account.payload.risk.state = "HALTED";
    input.account.payload.risk.reasons = [];
    rehash(input.account);
    expect(run({ position: first.position }).state).toBe("reconcile");
  });
  it("does not expose a fill path; stale metadata/dust stays pending and zero inventory closes the episode", () => {
    const { input, position, run } = opened();
    tick(input, Date.parse(position.deadline));
    input.metadata = null;
    expect(run().pending_causes).toContain("metadata_unavailable");
    input.metadata = fixture().metadata;
    Object.assign(input.account.payload.projection.positions[0]!, {
      quantity_btc_raw: "1",
    });
    tick(input, Date.parse(input.decision_at));
    expect(run().pending_causes).toContain("order_constraints_unavailable");
    Object.assign(input.account.payload.projection.positions[0]!, {
      quantity_btc_raw: "0",
    });
    tick(input, Date.parse(input.decision_at));
    const closed = run();
    expect(closed.state).toBe("closed");
    expect(closed.command).toBe(null);
  });
});
