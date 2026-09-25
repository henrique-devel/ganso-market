import { describe, expect, it } from "vitest";
import {
  assertInstrumentOrderConstraints,
  parseTradingIntent,
} from "@ganso-market/contracts/trading";
import {
  decideBaseline,
  baselineCosts,
  baselineSize,
  revalidateBaseline,
  baselineAmount,
  baselineQuantity,
} from "../../src/storage/baseline-policy.js";
import {
  baselineAtr,
  baselinePrice,
  baselineTrend,
} from "../../src/trading/strategies/baseline.js";
import { reservationHold } from "../../src/trading/reservations.js";
import {
  baselineHash,
  baselineIso,
} from "../../src/storage/baseline-inputs.js";
import {
  fixture,
  environment,
  rehash,
  tick,
  AT,
  T,
  px,
  record,
} from "./baseline-fixture.js";

describe("frozen baseline indicators and integer sizing", () => {
  it("caps exposure at the maximum gross mark/cap and cannot pledge unrealized gains", () => {
    const input = fixture(),
      decision = decideBaseline(input),
      env = environment(input);
    const order = structuredClone(decision.command!.order);
    order.risk_plan!.stop_price_usd_raw = px(99700);
    expect(baselineSize(env, order, 100000000000000n, 300000000n)).toBe(
      249000n,
    );
    env.finance.balance_usd_raw = "100000000";
    expect(baselineSize(env, order, 100000000000000n, 300000000n)).toBe(99000n);
    env.finance.balance_usd_raw = "1000000";
    expect(baselineSize(env, order, 100000000000000n, 300000000n)).toBe(0n);
  });

  it.each(["long", "short"] as const)(
    "reproduces the independent %s vector, exact costs and maximum lot",
    (side) => {
      const input = fixture(side),
        d = decideBaseline(input);
      expect(d.state).toBe(`candidate_${side}`);
      expect(d.candidate).toMatchObject({
        direction: side,
        atr_usd_raw: px(500),
        distance_usd_raw: px(1000),
        stop_usd_raw: px(side === "long" ? 99000 : 101000),
        lower_usd_raw: px(99900),
        upper_usd_raw: px(100100),
        quantity_btc_raw: "182000",
      });
      expect(d.candidate!.costs.budget_usd_raw).toBe(
        side === "long" ? "2491895" : "2497495",
      );
      const costs = baselineCosts(
        { ...d.command!.order, quantity_btc_raw: "100000" },
        100000000000000n,
        1000000000n,
      );
      expect(costs).toMatchObject({
        core_usd_raw: side === "long" ? "1200100" : "1200550",
        exit_slippage_usd_raw: side === "long" ? "99000" : "101000",
        funding_usd_raw: side === "long" ? "70070" : "70700",
        budget_usd_raw: side === "long" ? "1369170" : "1372250",
      });
      expect(
        BigInt(
          baselineCosts(
            { ...d.command!.order, quantity_btc_raw: "183000" },
            100000000000000n,
            1000000000n,
          ).budget_usd_raw,
        ),
      ).toBeGreaterThan(2500000n);
      expect(d.command!.order.price_cap_usd_raw).toBe(px(100100));
      expect(d.intent!.terms.limit_price.raw).toBe(
        px(side === "long" ? 100100 : 99900),
      );
      expect(d.command!.intent.latency_ms).toBe(1000);
      expect(d.command!.order.valid_until).toBe(baselineIso(AT + 5000));
      expect(() =>
        parseTradingIntent(
          d.intent,
          {
            schema_version: "trading.v1",
            mode: "paper",
            account_id: input.registration.scope.account_id,
            experiment_id: input.registration.scope.experiment_id,
            purpose: "baseline",
            settlement_currency: "USD",
          },
          {
            schema_version: "trading.v1",
            mode: "paper",
            experiment_id: input.registration.scope.experiment_id,
            strategy_version: d.policy_version,
            manifest_hash: input.registration.manifest_fingerprint.slice(7),
            started_at: input.registration.start_at,
          },
          input.metadata!.payload.instrument,
        ),
      ).not.toThrow();
    },
  );
  it("preserves strict equality and does not round SMA comparisons", () => {
    expect(decideBaseline(fixture("neutral")).state).toBe("neutral");
    expect(
      baselineTrend(["10", "10", "10", "10", ...Array<string>(8).fill("1")]),
    ).toBe(null);
    expect(
      baselineTrend(["11", "10", "10", "10", ...Array<string>(8).fill("1")]),
    ).toBe("long");
    const input = fixture();
    input.quarters.records[0]!.payload.ohlc!.close =
      input.quarters.records[1]!.payload.ohlc!.high;
    rehash(input.quarters.records[0]!);
    expect(decideBaseline(input).state).toBe("neutral");
    input.quarters.records[0]!.payload.ohlc!.close = px(100000);
    input.quarters.records[0]!.payload.ohlc!.open = px(100000);
    rehash(input.quarters.records[0]!);
    expect(decideBaseline(input).state).toBe("neutral");
  });
  it("ceil-rounds ATR once after summing true ranges including previous closes", () => {
    const candles = Array.from({ length: 15 }, () => ({
      open: "100",
      high: "101",
      low: "100",
      close: "100",
    }));
    expect(baselineAtr(candles)).toBe(1n);
    candles[0]!.high = "102";
    expect(baselineAtr(candles)).toBe(2n);
    candles[14]!.close = "200";
    expect(baselineAtr(candles)).toBe(9n);
    expect(() => baselineAtr(candles.slice(1))).toThrow("ATR_LENGTH");
  });
  it("rounds outward across decimal/significant digit boundaries and integer exemptions", () => {
    const metadata = fixture().metadata!.payload;
    for (const [n, up, down] of [
      [99999900001n, 100000000000n, 99999000000n],
      [12345100000n, 12346000000n, 12345000000n],
      [100000000001n, 100001000000n, 100000000000n],
    ]) {
      expect(baselinePrice(n!, 1n, "up", metadata)).toBe(up);
      expect(baselinePrice(n!, 1n, "down", metadata)).toBe(down);
      for (const p of [up!, down!])
        expect(() =>
          assertInstrumentOrderConstraints(
            metadata,
            baselineAmount(p.toString()),
            baselineQuantity("1000000"),
          ),
        ).not.toThrow();
    }
    expect(baselinePrice(0n, 1n, "down", metadata)).toBe(null);
    const custom = {
      instrument: { tick_size: { raw: "300000" } },
      price_rules: {
        max_decimals: 1,
        max_significant_digits: 5,
        integer_prices_exempt: true,
      },
    };
    expect(baselinePrice(100000000000n, 1n, "up", custom)).toBe(100002000000n);
    expect(baselinePrice(100000000000n, 1n, "down", custom)).toBe(99999000000n);
  });
  it("uses a positive conservative funding floor and vetoes excessive costs without raising size", () => {
    const input = fixture();
    input.funding[0]!.payload.rate!.raw = "0";
    rehash(input.funding[0]!);
    expect(decideBaseline(input).candidate!.quantity_btc_raw).toBe("182000");
    input.funding[0]!.payload.rate!.raw = "-100000000000000";
    rehash(input.funding[0]!);
    expect(decideBaseline(input).candidate!.costs.funding_usd_raw).toBe(
      "127533",
    );
    input.funding[0]!.payload.rate!.raw = "40000000000000000";
    rehash(input.funding[0]!);
    const veto = decideBaseline(input);
    expect(veto.state).toBe("rejected");
    expect(veto.direction).toBe("long");
    expect(veto.reasons).toContain("cost_veto");
    expect(veto.command).toBe(null);
  });
  it("uses settled collateral capacity, minimum notional and inclusive risk boundaries", () => {
    const input = fixture();
    input.account.payload.projection.balance_usd_raw = "11005500";
    input.account.payload.risk.equity_usd_raw = "11005500";
    input.account.payload.risk.daily_anchor_usd_raw = "11005500";
    input.account.payload.risk.high_water_usd_raw = "11005500";
    rehash(input.account);
    const small = decideBaseline(input);
    expect(small.state).toBe("rejected");
    expect(small.reasons).toContain("size_below_minimum");
    const normal = fixture();
    const first = decideBaseline(normal);
    const e = BigInt(first.candidate!.costs.budget_usd_raw) * 400n;
    normal.account.payload.projection.balance_usd_raw = e.toString();
    normal.account.payload.risk.equity_usd_raw = e.toString();
    normal.account.payload.risk.high_water_usd_raw = e.toString();
    normal.account.payload.risk.daily_anchor_usd_raw = e.toString();
    rehash(normal.account);
    expect(decideBaseline(normal).candidate!.quantity_btc_raw).toBe("182000");
    normal.account.payload.projection.balance_usd_raw = (e - 1n).toString();
    normal.account.payload.risk.equity_usd_raw = (e - 1n).toString();
    rehash(normal.account);
    expect(decideBaseline(normal).candidate!.quantity_btc_raw).toBe("181000");
  });
});

describe("as-of, precedence and durable deterministic decisions", () => {
  it.each([false, true])(
    "distinguishes initial warmup from missing historical bars (gap=%s)",
    (gap) => {
      const input = fixture();
      input.hours.records.pop();
      if (!gap)
        input.hours.first_complete_start_at =
          input.hours.records.at(-1)!.payload.start_at;
      expect(decideBaseline(input).state).toBe(
        gap ? "data_unavailable" : "warmup",
      );
    },
  );
  it.each([
    "gap",
    "zero_trades",
    "ohlc",
    "future_close",
    "wrong_version",
    "null_ohlc",
    "missing_input",
    "late_input",
    "hash",
    "missing_middle",
    "continuity",
    "late_bar",
  ])("refuses %s evidence even with a price signal", (reason) => {
    const input = fixture(),
      row = input.hours.records[3]!;
    switch (reason) {
      case "gap":
        row.payload.quality.reasons = ["capture_gap"];
        break;
      case "zero_trades":
        row.payload.trade_count = 0;
        break;
      case "ohlc":
        row.payload.ohlc!.low = px(1000000);
        break;
      case "future_close":
        row.payload.closed_at = baselineIso(AT + 1);
        break;
      case "wrong_version":
        row.payload.instrument_version = "other";
        break;
      case "null_ohlc":
        row.payload.ohlc = null;
        break;
      case "missing_input":
        row.payload.input_ids.push("absent");
        break;
      case "late_input":
        input.hours.dependencies[6]!.received_at = baselineIso(AT + 1);
        break;
      case "missing_middle":
        input.hours.records.splice(3, 1);
        break;
      case "continuity":
        row.payload.quality.state = "incomplete";
        break;
      case "late_bar":
        row.recorded_at = baselineIso(AT + 1);
        break;
    }
    rehash(row);
    if (reason === "hash") row.payload_hash = "0".repeat(64);
    const d = decideBaseline(input);
    expect(d.state).toBe("data_unavailable");
    expect(d.intent).toBe(null);
  });
  it("ignores bars in formation/future and future corrections; input order does not change the decision", () => {
    const input = fixture(),
      d = decideBaseline(input);
    const future = structuredClone(input.quarters.records[0]!);
    future.object_id = "future";
    future.payload.end_at = baselineIso(T + 900000);
    input.quarters.records.push(future);
    const late = structuredClone(input.quarters.records[0]!);
    late.object_id = "late";
    late.recorded_at = baselineIso(AT + 1);
    late.payload.ohlc!.close = px(1);
    rehash(late);
    input.quarters.records.push(late);
    input.quarters.records.reverse();
    input.hours.records.reverse();
    input.hours.dependencies.reverse();
    expect(decideBaseline(input)).toEqual(d);
  });
  it.each([-1, 0, 49999, 50000])(
    "binds the decision window at delta %sms",
    (delta) => {
      const input = fixture();
      tick(input, AT + delta);
      const d = decideBaseline(input);
      expect(d.state).toBe(
        delta < 0 || delta >= 50000
          ? "missed_decision_window"
          : "candidate_long",
      );
    },
  );
  it("replays the persisted result instead of current bars, and rejects identity/version drift", () => {
    const input = fixture(),
      d = decideBaseline(input);
    tick(input, AT + 60000);
    input.hours.records = [];
    input.previous = d;
    expect(decideBaseline(input)).toEqual(d);
    Object.assign(input.registration.scope, { account_id: "other" });
    expect(() => decideBaseline(input)).toThrow("REPLAY_SCOPE");
    input.registration.manifest_fingerprint =
      "changed" as typeof input.registration.manifest_fingerprint;
    expect(() => decideBaseline(input)).toThrow("REGISTRATION");
  });
  it("keeps all causes while applying precedence, and cannot enter while HOLD/pauses are set", () => {
    const input = fixture();
    input.enabled = false;
    input.hours.records = [];
    input.account.payload.entries_paused = true;
    input.account.payload.hold = true;
    rehash(input.account);
    const disabled = decideBaseline(input);
    expect(disabled.state).toBe("disabled");
    expect(disabled.reasons).toEqual(
      expect.arrayContaining([
        "disabled",
        "data_unavailable",
        "hold",
        "entries_paused",
      ]),
    );
    const paused = fixture();
    paused.account.payload.entries_paused = true;
    paused.account.payload.risk.state = "REDUCE_ONLY";
    rehash(paused.account);
    const d = decideBaseline(paused);
    expect(d.state).toBe("rejected");
    expect(d.direction).toBe("long");
    expect(d.candidate!.quantity_btc_raw).toBe("182000");
    expect(d.command).toBe(null);
    paused.account.payload.entries_paused = false;
    rehash(paused.account);
    expect(decideBaseline(paused).reasons).toContain("risk_pause");
  });
  it.each(["book", "context", "funding", "metadata", "recovery"])(
    "fails closed for unavailable %s",
    (kind) => {
      const input = fixture();
      if (kind === "book" || kind === "context") input.market[kind] = null;
      if (kind === "metadata") input.metadata = null;
      if (kind === "funding") input.funding = [];
      if (kind === "recovery") {
        input.account.payload.recovery_ready = false;
        rehash(input.account);
      }
      expect(decideBaseline(input).state).toBe("data_unavailable");
    },
  );
  it("rejects stale/future market receipts, a changed fee and pending or old final funding", () => {
    for (const alter of [
      (e: ReturnType<typeof fixture>) => {
        e.market.book!.recorded_at = baselineIso(AT + 1);
      },
      (e: ReturnType<typeof fixture>) => {
        Object.assign(e.market.book!.payload, {
          source_timestamp: baselineIso(AT - 2001),
        });
        rehash(e.market.book!);
      },
      (e: ReturnType<typeof fixture>) => {
        Object.assign(e.metadata!.payload.fees.taker, { raw: "0" });
        rehash(e.metadata!);
      },
      (e: ReturnType<typeof fixture>) => {
        e.funding[0]!.payload.status = "pending";
        rehash(e.funding[0]!);
      },
      (e: ReturnType<typeof fixture>) => {
        e.funding[0]!.payload.rate!.decimals = 9 as 18;
        rehash(e.funding[0]!);
      },
      (e: ReturnType<typeof fixture>) => {
        e.funding[0]!.payload.period_hour = "2024-01-01T11:00:00.000Z";
        rehash(e.funding[0]!);
      },
    ]) {
      const input = fixture();
      alter(input);
      expect(decideBaseline(input).state).toBe("data_unavailable");
    }
  });
  it("prevents pyramiding, pending increases/exits and same-bar reentry", () => {
    for (const flag of ["reservation", "exit", "same_bar"]) {
      const input = fixture();
      if (flag === "reservation")
        input.account.payload.reservations.push(
          reservationHold(decideBaseline(input).command!.order, 182000n),
        );
      if (flag === "exit") input.account.payload.exit_pending = true;
      if (flag === "same_bar")
        input.account.payload.last_closed_bar_end_at = baselineIso(T);
      rehash(input.account);
      expect(decideBaseline(input).state).toBe("position_managed");
    }
  });
});

describe("admission and execution never chase a changed market or resize", () => {
  it("requires the original candidate, reservation, post-latency book and original TTL", () => {
    const input = fixture(),
      d = decideBaseline(input);
    expect(revalidateBaseline(d, input, input.decision_at, "admit").state).toBe(
      "ready",
    );
    input.account.payload.reservations = [
      reservationHold(d.command!.order, 182000n),
    ];
    rehash(input.account);
    expect(
      revalidateBaseline(d, input, input.decision_at, "execute").state,
    ).toBe("waiting");
    tick(input, AT + 1000);
    expect(
      revalidateBaseline(d, input, input.decision_at, "execute").state,
    ).toBe("waiting");
    tick(input, AT + 1001);
    expect(
      revalidateBaseline(d, input, input.decision_at, "execute").state,
    ).toBe("ready");
    tick(input, AT + 5000);
    expect(
      revalidateBaseline(d, input, input.decision_at, "execute").reasons,
    ).toContain("intent_expired");
  });
  it("rejects a lost price band, triggered stop, vanished collateral or missing reservation without mutation", () => {
    for (const kind of ["band", "stop", "balance", "reservation"]) {
      const input = fixture(),
        d = decideBaseline(input),
        original = baselineHash(d);
      input.account.payload.reservations = [
        reservationHold(d.command!.order, 182000n),
      ];
      if (kind === "balance")
        input.account.payload.projection.balance_usd_raw = "1000000";
      if (kind === "reservation") input.account.payload.reservations = [];
      if (input.market.book!.payload.payload.kind === "book") {
        if (kind === "band")
          Object.assign(input.market.book!.payload.payload.asks[0]!.price, {
            raw: px(101000),
          });
        if (kind === "stop")
          Object.assign(input.market.book!.payload.payload.bids[0]!.price, {
            raw: px(99000),
          });
      }
      tick(input, AT + 1500);
      expect(
        revalidateBaseline(d, input, input.decision_at, "execute").state,
      ).toBe("rejected");
      expect(baselineHash(d)).toBe(original);
    }
  });
  it("does not accept a known invalid revision just because an older bar was valid", () => {
    const input = fixture();
    const invalid = structuredClone(input.hours.records[0]!);
    invalid.recorded_at = baselineIso(Date.parse(invalid.recorded_at) - 1);
    invalid.payload.closed_at = baselineIso(T - 2000);
    invalid.payload.quality.state = "incomplete";
    invalid.object_id = "first-invalid";
    rehash(invalid);
    input.hours.records.push(invalid);
    expect(decideBaseline(input).state).toBe("data_unavailable");
    const unknown = record("unrecognized-account", input.account.payload, AT);
    unknown.payload_hash = "0".repeat(64);
    input.account = unknown;
    expect(() => decideBaseline(input)).toThrow("ACCOUNT_EVIDENCE");
  });
});
