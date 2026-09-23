import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { trading } from "../src/index.js";
import type {
  BtcPrice,
  BtcQuantity,
  TradingContracts,
  TradingProbability,
  TradingRate,
  UsdAmount,
} from "../src/trading/index.js";

const {
  parseTradingAmount: amount,
  parseTradingContract: parse,
  tradingIdempotencyKey: key,
} = trading;
const version = { schema_version: trading.TRADING_VERSION };
const scope = {
  mode: "paper",
  account_id: "manual",
  experiment_id: "exp-1",
  instrument_id: "BTC-PERP",
  instrument_version: "meta-1",
} as const;
const t0 = "2026-09-22T12:00:00.000Z";
const t1 = "2026-09-22T12:00:01.000Z";
const t2 = "2026-09-22T12:00:02.000Z";
const usd = (raw: string) => amount("USD", { unit: "USD", decimals: 6, raw });
const btc = (raw: string) => amount("BTC", { unit: "BTC", decimals: 8, raw });
const price = (raw: string) =>
  amount("USD_PER_BTC", { unit: "USD_PER_BTC", decimals: 6, raw });
const rate = (raw: string) =>
  amount("RATE", { unit: "RATE", decimals: 9, raw });
function fixtures() {
  const data = {
    ...version,
    instrument_id: scope.instrument_id,
    instrument_version: scope.instrument_version,
    source_id: "venue-public",
    source_event_id: "book-42",
    kind: "book",
    source_timestamp: t0,
    received_at: t1,
    parser_version: "1.0.0",
    payload_hash: "a".repeat(64),
    quality: "fresh",
  };
  const instrument = {
    ...version,
    instrument_id: scope.instrument_id,
    instrument_version: scope.instrument_version,
    venue_id: "fixture",
    venue_symbol: "BTC",
    kind: "linear_perpetual",
    base_currency: "BTC",
    quote_currency: "USD",
    settlement_currency: "USD",
    tick_size: price("100000"),
    quantity_step: btc("1000"),
    origin: { ...data, kind: "metadata", source_event_id: "metadata-1" },
  };
  const account = {
    ...version,
    account_id: scope.account_id,
    experiment_id: scope.experiment_id,
    mode: "paper",
    purpose: "manual",
    settlement_currency: "USD",
  };
  const experiment = {
    ...version,
    experiment_id: scope.experiment_id,
    mode: "paper",
    manifest_hash: "b".repeat(64),
    strategy_version: "1.0.0",
    started_at: t0,
  };
  const terms = {
    side: "buy",
    quantity: btc("10000"),
    limit_price: price("60000100000"),
    reduce_only: false,
    time_in_force: "IOC",
  };
  const intent = {
    ...version,
    ...scope,
    intent_id: "intent-1",
    idempotency_key: key(scope, "intent", "intent-1"),
    decision: {
      decision_id: "decision-1",
      decided_at: t1,
      origin: { kind: "manual", actor_id: "operator" },
      inputs: [data],
    },
    terms,
  };
  const order = {
    ...version,
    ...scope,
    order_id: "order-1",
    intent_id: intent.intent_id,
    decision_id: intent.decision.decision_id,
    idempotency_key: key(scope, "order", "order-1"),
    accepted_at: t1,
    terms,
  };
  const execution = {
    ...version,
    ...scope,
    execution_id: "fill-1",
    order_id: order.order_id,
    intent_id: intent.intent_id,
    decision_id: order.decision_id,
    idempotency_key: key(scope, "execution", "fill-1"),
    executed_at: t2,
    side: "buy",
    quantity: btc("4000"),
    price: price("60000000000"),
    fee: usd("12"),
    liquidity: "taker",
    evidence: [data],
  };
  const ledger = {
    ...version,
    ...scope,
    event_id: "event-1",
    idempotency_key: key(scope, "ledger", "event-1"),
    transaction_id: "transaction-1",
    sequence: "1",
    cause_id: execution.execution_id,
    occurred_at: t2,
    recorded_at: t2,
    payload: {
      event_type: "fill",
      execution_id: execution.execution_id,
      order_id: order.order_id,
      position_id: "position-1",
      side: "buy",
      quantity: execution.quantity,
      price: execution.price,
    },
  };
  return {
    data,
    instrument,
    account,
    experiment,
    intent,
    order,
    execution,
    ledger,
  };
}
afterEach(() => vi.unstubAllEnvs());

describe("BTC trading.v1 exact boundaries", () => {
  it("keeps BTC, USD, price, rate and probability distinct in TypeScript", () => {
    expectTypeOf<BtcQuantity>().not.toEqualTypeOf<UsdAmount>();
    expectTypeOf<BtcPrice>().not.toEqualTypeOf<TradingProbability>();
    expectTypeOf<TradingRate>().not.toEqualTypeOf<TradingProbability>();
    // @ts-expect-error USD is never BTC, even with the same raw integer.
    const invalid: BtcQuantity = usd("100");
    expect(invalid.unit).toBe("USD");
  });
  it("round trips JSON and large signed amounts without floats", () => {
    const value = usd("-9007199254740993123456789");
    expect(amount("USD", JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(price("60000100000").raw).toBe("60000100000");
    expect(rate("-250000").raw).toBe("-250000");
  });
  it.each(["1.0", "01", "-0", "+1", "1e8", " 1", 0.1, Number.NaN])(
    "rejects imprecise/noncanonical raw %j",
    (raw) => {
      expect(() => amount("BTC", { unit: "BTC", decimals: 8, raw })).toThrow(
        TypeError,
      );
    },
  );
  it("rejects unit/scale swaps and probability clamping", () => {
    expect(() => amount("BTC", usd("100"))).toThrow();
    expect(() =>
      amount("BTC", { unit: "BTC", decimals: 9, raw: "10" }),
    ).toThrow();
    for (const raw of ["-1", "1000001"])
      expect(() =>
        amount("PROBABILITY", { unit: "PROBABILITY", decimals: 6, raw }),
      ).toThrow();
    for (const raw of ["0", "1000000"])
      expect(
        amount("PROBABILITY", { unit: "PROBABILITY", decimals: 6, raw }).raw,
      ).toBe(raw);
  });
  it("rejects inexact tick/lot sizes and nonpositive quanta without rounding", () => {
    trading.assertTradingQuantum(btc("10000"), btc("1000"));
    for (const step of ["0", "-1000", "3000"])
      expect(() =>
        trading.assertTradingQuantum(btc("10000"), btc(step)),
      ).toThrow();
    const f = fixtures();
    for (const terms of [
      { ...f.intent.terms, quantity: btc("10001") },
      { ...f.intent.terms, limit_price: price("60000100001") },
    ]) {
      expect(() =>
        trading.parseTradingIntent(
          { ...f.intent, terms },
          f.account,
          f.experiment,
          f.instrument,
        ),
      ).toThrow();
    }
  });
});

describe("identity, provenance and modes", () => {
  it("accepts each small contract fixture and the decision/order/fill chain", () => {
    const f = fixtures();
    for (const kind of Object.keys(f) as (keyof TradingContracts)[])
      expect(parse(kind, f[kind])).toEqual(f[kind]);
    const intent = trading.parseTradingIntent(
      f.intent,
      f.account,
      f.experiment,
      f.instrument,
    );
    const order = trading.parseTradingOrder(f.order, intent, f.instrument);
    expect(
      trading.parseTradingExecution(f.execution, order, f.instrument).quantity
        .raw,
    ).toBe("4000");
  });
  it.each(["live", "testnet", "", null, undefined])(
    "rejects mode %j in every owned contract",
    (mode) => {
      const f = fixtures();
      for (const kind of [
        "account",
        "experiment",
        "intent",
        "order",
        "execution",
        "ledger",
      ] as const)
        expect(() => parse(kind, { ...f[kind], mode })).toThrow();
    },
  );
  it.each(["", "fixture-only-invalid-credential", "undefined"])(
    "private-key environment value %j cannot change paper mode",
    (value) => {
      for (const name of [
        "PRIVATE_KEY",
        "HYPERLIQUID_PRIVATE_KEY",
        "EXECUTION_MODE",
      ])
        vi.stubEnv(name, value);
      expect(parse("account", fixtures().account).mode).toBe("paper");
      expect(() =>
        parse("account", { ...fixtures().account, mode: "live" }),
      ).toThrow();
      expect(() =>
        parse("account", { ...fixtures().account, private_key: value }),
      ).toThrow();
    },
  );
  it("requires every identity/provenance field and rejects undeclared fields", () => {
    const f = fixtures();
    for (const kind of Object.keys(f) as (keyof TradingContracts)[]) {
      for (const field of Object.keys(f[kind])) {
        const copy = { ...f[kind] } as Record<string, unknown>;
        delete copy[field];
        expect(() => parse(kind, copy), `${kind}.${field}`).toThrow();
      }
      expect(() =>
        parse(kind, { ...f[kind], binary_outcome: "YES" }),
      ).toThrow();
    }
    expect(() => parse("data", { ...f.data, source_event_id: " " })).toThrow();
    expect(() =>
      parse("intent", {
        ...f.intent,
        decision: { ...f.intent.decision, inputs: [] },
      }),
    ).toThrow();
  });
  it.each([
    "2026-09-22T12:00:00+00:00",
    "2026-09-22T12:00:00Z",
    "2026-02-30T12:00:00.000Z",
    "2026-09-22T12:00:60.000Z",
  ])("rejects noncanonical/invalid UTC %s", (received_at) => {
    expect(() => parse("data", { ...fixtures().data, received_at })).toThrow();
  });
  it("preserves stale/unknown status, but never uses it as fill evidence or admits future inputs", () => {
    const f = fixtures();
    for (const quality of ["stale", "unknown"]) {
      const data = { ...f.data, quality };
      expect(parse("data", data).quality).toBe(quality);
      expect(() =>
        parse("execution", { ...f.execution, evidence: [data] }),
      ).toThrow();
    }
    expect(() =>
      parse("intent", {
        ...f.intent,
        decision: {
          ...f.intent.decision,
          inputs: [{ ...f.data, received_at: t2 }],
        },
      }),
    ).toThrow();
    expect(() =>
      parse("execution", {
        ...f.execution,
        evidence: [{ ...f.data, kind: "mark" }],
      }),
    ).toThrow();
  });
  it("keys retries by scoped identity, not time, payload or delimiter concatenation", () => {
    const f = fixtures();
    expect(trading.tradingDataKey(f.data)).toBe(
      trading.tradingDataKey({ ...f.data, received_at: t2 }),
    );
    expect(trading.tradingDataKey(f.data)).toBe(
      trading.tradingDataKey({
        ...f.data,
        instrument_version: "meta-2",
        parser_version: "2.0.0",
      }),
    );
    expect(key(scope, "order", "order-1")).toBe(
      key({ ...scope, instrument_version: "meta-2" }, "order", "order-1"),
    );
    expect(key(scope, "order", "order-1")).not.toBe(
      key({ ...scope, account_id: "baseline" }, "order", "order-1"),
    );
    expect(
      key({ ...scope, account_id: "a:b", experiment_id: "c" }, "order", "1"),
    ).not.toBe(
      key({ ...scope, account_id: "a", experiment_id: "b:c" }, "order", "1"),
    );
    expect(() =>
      parse("order", { ...f.order, idempotency_key: f.intent.idempotency_key }),
    ).toThrow();
  });
  it("rejects ownership, decision, metadata and order-term drift", () => {
    const f = fixtures();
    expect(() =>
      trading.parseTradingIntent(
        f.intent,
        { ...f.account, experiment_id: "other" },
        f.experiment,
        f.instrument,
      ),
    ).toThrow();
    for (const patch of [
      { account_id: "other" },
      { experiment_id: "other" },
      { instrument_version: "other" },
      { decision_id: "other" },
      { terms: { ...f.order.terms, side: "sell" } },
    ]) {
      const order = { ...f.order, ...patch };
      order.idempotency_key = key(order, "order", order.order_id);
      expect(() =>
        trading.parseTradingOrder(order, f.intent, f.instrument),
      ).toThrow();
    }
    for (const patch of [
      { quantity: btc("11000") },
      { price: price("60000200000") },
      { side: "sell" },
      { order_id: "other" },
    ])
      expect(() =>
        trading.parseTradingExecution(
          { ...f.execution, ...patch },
          f.order,
          f.instrument,
        ),
      ).toThrow();
  });
  it("requires a future expiry for GTD and forbids an expiry on IOC", () => {
    const f = fixtures();
    expect(() =>
      parse("order", {
        ...f.order,
        terms: { ...f.order.terms, expires_at: t2 },
      }),
    ).toThrow();
    expect(() =>
      parse("order", {
        ...f.order,
        terms: { ...f.order.terms, time_in_force: "GTD" },
      }),
    ).toThrow();
    const order = {
      ...f.order,
      terms: { ...f.order.terms, time_in_force: "GTD", expires_at: t2 },
    };
    expect(parse("order", order).terms.time_in_force).toBe("GTD");
    expect(() =>
      trading.parseTradingExecution(f.execution, order, f.instrument),
    ).toThrow();
  });
  it("records all perpetual event shapes, including signed funding and delayed receipt", () => {
    const f = fixtures();
    const origin = { ...f.data, kind: "funding", received_at: t2 };
    const payloads = [
      {
        event_type: "cash",
        delta: usd("1000000000"),
        reason: "initial_allocation",
      },
      ...["margin_reserved", "margin_released"].map((event_type) => ({
        event_type,
        order_id: "order-1",
        reservation_id: "reservation-1",
        amount: usd("1000000"),
      })),
      f.ledger.payload,
      { event_type: "fee", execution_id: "fill-1", delta: usd("-12") },
      {
        event_type: "funding",
        position_id: "position-1",
        period_start: "2026-09-22T11:00:00.000Z",
        period_end: t0,
        rate: rate("-250000"),
        delta: usd("42"),
        origin,
      },
      {
        event_type: "realized_pnl",
        execution_id: "fill-1",
        position_id: "position-1",
        delta: usd("-23"),
      },
      {
        event_type: "mark",
        position_id: "position-1",
        price: price("60000000000"),
        unrealized_pnl: usd("123"),
        maintenance_margin: usd("1000"),
        origin: { ...origin, kind: "mark" },
      },
      {
        event_type: "liquidation",
        position_id: "position-1",
        execution_id: "fill-1",
      },
      {
        event_type: "reversal",
        reverses_event_id: "event-0",
        reason: "correction",
      },
    ];
    for (const payload of payloads)
      expect(
        parse("ledger", { ...f.ledger, occurred_at: t0, payload }).payload,
      ).toEqual(payload);
    expect(() => parse("ledger", { ...f.ledger, sequence: 1 })).toThrow();
    expect(() =>
      parse("ledger", {
        ...f.ledger,
        payload: {
          event_type: "fee",
          execution_id: "fill-1",
          delta: btc("12"),
        },
      }),
    ).toThrow();
  });
});
