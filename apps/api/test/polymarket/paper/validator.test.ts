import { describe, expect, it } from "vitest";

import { parseScaled } from "../../../src/polymarket/fundamental/fixed.js";
import {
  officialAmountUsd,
  TICK_PRECISIONS,
  validateOrder,
  type OrderDraft,
} from "../../../src/polymarket/paper/validator.js";

const NOW_MS = 1_787_000_000_000;

function draft(overrides: Partial<OrderDraft> = {}): OrderDraft {
  return {
    tokenId: "token-1",
    side: "BUY",
    orderType: "GTC",
    limitPrice: "0.56",
    size: "10.56",
    ...overrides,
  };
}

const PARAMS = { tickSize: "0.01", minOrderSize: "5", negRisk: false };

describe("per-tick precision table (byte-for-byte)", () => {
  const cases: Array<{
    tick: string;
    price: string;
    size: string;
    expectPrice: string;
    expectSize: string;
    expectAmount: string;
  }> = [
    // price digits / size digits / amount digits per official table.
    {
      tick: "0.1",
      price: "0.5",
      size: "2.999",
      expectPrice: "0.5",
      expectSize: "2.99",
      expectAmount: "1.495",
    },
    {
      tick: "0.01",
      price: "0.567891",
      size: "10.5678",
      expectPrice: "0.56",
      expectSize: "10.56",
      expectAmount: "5.9136",
    },
    {
      tick: "0.005",
      price: "0.105",
      size: "1.011",
      expectPrice: "0.105",
      expectSize: "1.01",
      expectAmount: "0.10605",
    },
    {
      tick: "0.0025",
      price: "0.3325",
      size: "3.333",
      expectPrice: "0.3325",
      expectSize: "3.33",
      expectAmount: "1.107225",
    },
    {
      tick: "0.001",
      price: "0.123",
      size: "0.5",
      expectPrice: "0.123",
      expectSize: "0.50",
      expectAmount: "0.06150",
    },
    {
      tick: "0.0001",
      price: "0.1234",
      size: "7.77",
      expectPrice: "0.1234",
      expectSize: "7.77",
      expectAmount: "0.958818",
    },
  ];

  it("covers every tick size the venue supports", () => {
    expect(cases.map((c) => c.tick).sort()).toEqual(
      [...TICK_PRECISIONS.keys()].sort(),
    );
  });

  for (const c of cases) {
    it(`tick ${c.tick}: price/size round down, amount follows the sequence`, () => {
      const result = validateOrder(
        draft({ limitPrice: c.price, size: c.size }),
        { tickSize: c.tick, minOrderSize: "0.1", negRisk: false },
        NOW_MS,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.limitPrice).toBe(c.expectPrice);
        expect(result.value.size).toBe(c.expectSize);
        expect(result.value.amountUsd).toBe(c.expectAmount);
      }
    });
  }

  it("the up-then-down amount sequence changes the result when it must", () => {
    // Raw product 0.3 x 0.39999999 = 0.119999997: a plain floor at 2 digits
    // would say 0.11; the official round-UP at amount+4 first lifts it to
    // 0.120000, and the floor then keeps 0.12.
    const price = parseScaled("0.3");
    const size = parseScaled("0.39999999");
    if (price === null || size === null) {
      throw new Error("fixture must parse");
    }
    expect(officialAmountUsd(price, size, 2)).toBe("0.12");
  });
});

describe("hard refusals", () => {
  it("no order without an explicit limit price", () => {
    const result = validateOrder(draft({ limitPrice: "" }), PARAMS, NOW_MS);
    expect(result).toEqual({ ok: false, reason: "MISSING_LIMIT_PRICE" });
  });

  it("FAK and FOK demand worst_price", () => {
    for (const orderType of ["FAK", "FOK"] as const) {
      const result = validateOrder(draft({ orderType }), PARAMS, NOW_MS);
      expect(result).toEqual({ ok: false, reason: "MISSING_WORST_PRICE" });
    }
  });

  it("worst_price must bound the walk away from the limit", () => {
    const buy = validateOrder(
      draft({ orderType: "FAK", worstPrice: "0.40" }),
      PARAMS,
      NOW_MS,
    );
    expect(buy).toEqual({ ok: false, reason: "WORST_PRICE_INCOHERENT" });
    const sell = validateOrder(
      draft({ side: "SELL", orderType: "FAK", worstPrice: "0.60" }),
      PARAMS,
      NOW_MS,
    );
    expect(sell).toEqual({ ok: false, reason: "WORST_PRICE_INCOHERENT" });
  });

  it("size below min_order_size is refused", () => {
    const result = validateOrder(draft({ size: "4.99" }), PARAMS, NOW_MS);
    expect(result).toEqual({ ok: false, reason: "SIZE_BELOW_MIN" });
  });

  it("a price off the tick grid is refused, not silently snapped", () => {
    const result = validateOrder(
      draft({ limitPrice: "0.3333", size: "10" }),
      { tickSize: "0.0025", minOrderSize: "1", negRisk: false },
      NOW_MS,
    );
    expect(result).toEqual({ ok: false, reason: "TICK_MISALIGNED" });
  });

  it("prices outside (tick, 1 - tick) are refused", () => {
    expect(
      validateOrder(draft({ limitPrice: "0.005" }), PARAMS, NOW_MS),
    ).toEqual({ ok: false, reason: "PRICE_OUT_OF_RANGE" });
    expect(validateOrder(draft({ limitPrice: "1" }), PARAMS, NOW_MS)).toEqual({
      ok: false,
      reason: "PRICE_OUT_OF_RANGE",
    });
  });

  it("an unknown tick size fails closed", () => {
    const result = validateOrder(
      draft(),
      { tickSize: "0.02", minOrderSize: "5", negRisk: false },
      NOW_MS,
    );
    expect(result).toEqual({ ok: false, reason: "UNKNOWN_TICK_SIZE" });
  });
});

describe("GTD semantics (B2)", () => {
  it("declared expiration is now + 60 + N seconds", () => {
    const result = validateOrder(
      draft({ orderType: "GTD", ttlS: 300 }),
      PARAMS,
      NOW_MS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.expirationS).toBe(1_787_000_000 + 60 + 300);
    }
  });

  it("a declared expiration under 3 minutes away is refused", () => {
    const result = validateOrder(
      draft({ orderType: "GTD", ttlS: 60 }),
      PARAMS,
      NOW_MS,
    );
    expect(result).toEqual({ ok: false, reason: "INVALID_TTL" });
    // 120 s of useful life plus the 60 s buffer clears exactly 3 minutes.
    const boundary = validateOrder(
      draft({ orderType: "GTD", ttlS: 120 }),
      PARAMS,
      NOW_MS,
    );
    expect(boundary.ok).toBe(true);
  });

  it("non-positive or fractional ttl is refused", () => {
    for (const ttlS of [0, -5, 1.5]) {
      expect(
        validateOrder(draft({ orderType: "GTD", ttlS }), PARAMS, NOW_MS),
      ).toEqual({ ok: false, reason: "INVALID_TTL" });
    }
  });
});

describe("post-only defaults (B1)", () => {
  it("resting orders default to post-only; marketable ones cannot be", () => {
    const resting = validateOrder(draft(), PARAMS, NOW_MS);
    expect(resting.ok && resting.value.postOnly).toBe(true);
    const marketable = validateOrder(
      draft({ orderType: "FAK", worstPrice: "0.60", postOnly: true }),
      PARAMS,
      NOW_MS,
    );
    expect(marketable.ok && !marketable.value.postOnly).toBe(true);
  });
});
