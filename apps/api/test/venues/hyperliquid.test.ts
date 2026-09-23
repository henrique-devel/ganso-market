import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertInstrumentOrderConstraints,
  parseTradingAmount,
} from "@ganso-market/contracts/trading";
import {
  parseHyperliquidBtcMetadata,
  HyperliquidMetadataError,
} from "../../src/venues/hyperliquid/metadata.js";
import { createHyperliquidPublicAdapter } from "../../src/venues/hyperliquid/public.js";

const at = "2026-09-23T05:40:13.550Z";
// Minimal fixture matching the public meta observation; never treated as a live feed.
function fixture() {
  return {
    universe: [
      { name: "ETH", szDecimals: 4, maxLeverage: 25, marginTableId: 55 },
      { name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 56 },
    ],
    collateralToken: 0,
    marginTables: [
      [
        56,
        {
          description: "tiered 40x",
          marginTiers: [
            { lowerBound: "0.0", maxLeverage: 40 },
            { lowerBound: "150000000.0", maxLeverage: 20 },
          ],
        },
      ],
    ],
  };
}
const parse = (response: unknown = fixture()) =>
  parseHyperliquidBtcMetadata(response, at);
const price = (raw: string) =>
  parseTradingAmount("USD_PER_BTC", { raw, unit: "USD_PER_BTC", decimals: 6 });
const quantity = (raw: string) =>
  parseTradingAmount("BTC", { raw, unit: "BTC", decimals: 8 });

describe("public BTC metadata boundary", () => {
  it("normalizes the named BTC asset, exact money and referenced tiers", () => {
    const m = parse();
    expect(m.venue_asset_index).toBe(1); // never assume index zero
    expect(m.instrument.quantity_step.raw).toBe("1000");
    expect(m.instrument.tick_size.raw).toBe("100000");
    expect(m.price_rules).toEqual({
      max_decimals: 1,
      max_significant_digits: 5,
      integer_prices_exempt: true,
    });
    expect(m.minimum_order_notional.raw).toBe("10000000");
    expect(m.collateral).toMatchObject({
      currency: "USDC",
      oracle_quote_currency: "USDT",
    });
    expect(m.margin.tiers).toEqual([
      {
        lower_bound: { raw: "0", decimals: 6, unit: "USD" },
        max_leverage: 40,
        maintenance_rate: { numerator: "1", denominator: "80" },
      },
      {
        lower_bound: { raw: "150000000000000", decimals: 6, unit: "USD" },
        max_leverage: 20,
        maintenance_rate: { numerator: "1", denominator: "40" },
      },
    ]);
    expect(m.margin.selected_leverage).toBeNull();
    expect(m.fees.maker.raw).toBe("150000");
    expect(m.fees.taker.raw).toBe("450000");
    expect(m.fees.account_effective).toBeNull();
    expect(m.fees.unknown_reason).toBeTruthy();
    expect(m.funding).toMatchObject({
      interval_seconds: 3600,
      formula_period_seconds: 28800,
      current_rate: null,
      payment_price: "oracle",
      positive_rate_payer: "long",
    });
    expect(m.funding.interest_rate_per_formula_period.raw).toBe("100000");
    expect(m.funding.max_absolute_rate_per_interval.raw).toBe("40000000");
    expect(m.instrument.origin).toMatchObject({
      quality: "unknown",
      source_timestamp: at,
      received_at: at,
    });
    expect(m.provenance).toMatchObject({
      venue_timestamp: null,
      venue_revision: null,
      sdk: "@nktkas/hyperliquid@0.33.3",
    });
  });
  it("versions rules, not receipt time or unrelated assets", () => {
    const base = parse();
    const other = fixture();
    other.universe[0]!.maxLeverage = 20;
    const later = parseHyperliquidBtcMetadata(
      other,
      "2026-09-23T06:00:00.000Z",
    );
    expect(later.instrument.instrument_version).toBe(
      base.instrument.instrument_version,
    );
    expect(later.provenance.response_hash).not.toBe(
      base.provenance.response_hash,
    );
    other.universe[1]!.szDecimals = 4;
    expect(parse(other).instrument.instrument_version).not.toBe(
      base.instrument.instrument_version,
    );
    expect(
      parse({ ...fixture(), harmlessNewField: "ignored" }).instrument
        .instrument_version,
    ).toBe(base.instrument.instrument_version);
  });
  it("uses documented implicit single tiers without rounding repeating maintenance rates", () => {
    const f = fixture();
    f.universe[1]!.marginTableId = 3;
    f.universe[1]!.maxLeverage = 3;
    f.marginTables = [];
    expect(parse(f).margin.tiers[0]!.maintenance_rate).toEqual({
      numerator: "1",
      denominator: "6",
    });
  });
  it.each(["strictIsolated", "noCross"])(
    "preserves %s without choosing a mode",
    (mode) => {
      const f = fixture();
      Object.assign(f.universe[1]!, { marginMode: mode, onlyIsolated: true });
      expect(parse(f).margin.mode_constraint).toBe(
        mode === "noCross" ? "isolated_only" : "strict_isolated",
      );
    },
  );
  it.each([
    ["missing BTC", { universe: [], marginTables: [], collateralToken: 0 }],
    [
      "numeric strings",
      {
        ...fixture(),
        universe: [{ ...fixture().universe[1], szDecimals: "5" }],
      },
    ],
    [
      "unsupported precision",
      { ...fixture(), universe: [{ ...fixture().universe[1], szDecimals: 7 }] },
    ],
    [
      "fractional precision",
      {
        ...fixture(),
        universe: [{ ...fixture().universe[1], szDecimals: 4.5 }],
      },
    ],
    [
      "duplicate BTC",
      {
        ...fixture(),
        universe: [fixture().universe[1], fixture().universe[1]],
      },
    ],
    [
      "delisted BTC",
      {
        ...fixture(),
        universe: [{ ...fixture().universe[1], isDelisted: true }],
      },
    ],
    [
      "unknown margin mode",
      {
        ...fixture(),
        universe: [{ ...fixture().universe[1], marginMode: "newMode" }],
      },
    ],
    [
      "legacy ambiguous margin flag",
      {
        ...fixture(),
        universe: [{ ...fixture().universe[1], onlyIsolated: true }],
      },
    ],
    [
      "contradictory margin flags",
      {
        ...fixture(),
        universe: [
          {
            ...fixture().universe[1],
            onlyIsolated: false,
            marginMode: "noCross",
          },
        ],
      },
    ],
    [
      "growth mode",
      {
        ...fixture(),
        universe: [{ ...fixture().universe[1], growthMode: "enabled" }],
      },
    ],
    ["unknown collateral", { ...fixture(), collateralToken: 1 }],
    ["missing collateral", { ...fixture(), collateralToken: undefined }],
    ["missing margin table", { ...fixture(), marginTables: [] }],
    [
      "duplicate margin table",
      {
        ...fixture(),
        marginTables: [...fixture().marginTables, ...fixture().marginTables],
      },
    ],
    [
      "empty tiers",
      { ...fixture(), marginTables: [[56, { marginTiers: [] }]] },
    ],
    [
      "base leverage mismatch",
      {
        ...fixture(),
        marginTables: [
          [56, { marginTiers: [{ lowerBound: "0", maxLeverage: 20 }] }],
        ],
      },
    ],
    [
      "nonzero first bound",
      {
        ...fixture(),
        marginTables: [
          [56, { marginTiers: [{ lowerBound: "1", maxLeverage: 40 }] }],
        ],
      },
    ],
    [
      "inexact bound",
      {
        ...fixture(),
        marginTables: [
          [56, { marginTiers: [{ lowerBound: "0.0000001", maxLeverage: 40 }] }],
        ],
      },
    ],
    [
      "exponent bound",
      {
        ...fixture(),
        marginTables: [
          [56, { marginTiers: [{ lowerBound: "1e8", maxLeverage: 40 }] }],
        ],
      },
    ],
    [
      "unsorted tiers",
      {
        ...fixture(),
        marginTables: [
          [
            56,
            {
              marginTiers: [
                { lowerBound: "0", maxLeverage: 40 },
                { lowerBound: "0", maxLeverage: 20 },
              ],
            },
          ],
        ],
      },
    ],
  ])("rejects %s", (_name, data) => {
    expect(() => parse(data)).toThrow(HyperliquidMetadataError);
  });
  it.each(["2026-02-30T00:00:00.000Z", "2026-09-23", "invalid"])(
    "rejects observation timestamp %s",
    (timestamp) => {
      expect(() => parseHyperliquidBtcMetadata(fixture(), timestamp)).toThrow(
        HyperliquidMetadataError,
      );
    },
  );
});

describe("exact order constraints for the core", () => {
  it.each(["123456000000", "100000000000", "1234500000", "12345000000"])(
    "allows integer exemption / valid 5-digit price %s",
    (raw) => {
      expect(() =>
        assertInstrumentOrderConstraints(
          parse(),
          price(raw),
          quantity("100000000"),
        ),
      ).not.toThrow();
    },
  );
  it.each(["12345600000", "10000100000", "1234510000"])(
    "rejects fractional price with >5 significant digits %s",
    (raw) => {
      expect(() =>
        assertInstrumentOrderConstraints(
          parse(),
          price(raw),
          quantity("100000000"),
        ),
      ).toThrow();
    },
  );
  it("enforces the exact minimum and rejects sub-lot, sub-tick and nonpositive amounts", () => {
    const m = parse();
    expect(() =>
      assertInstrumentOrderConstraints(
        m,
        price("100000000000"),
        quantity("10000"),
      ),
    ).not.toThrow();
    expect(() =>
      assertInstrumentOrderConstraints(
        m,
        price("100000000000"),
        quantity("9000"),
      ),
    ).toThrow("minimum");
    expect(() =>
      assertInstrumentOrderConstraints(
        m,
        price("100000000000"),
        quantity("10001"),
      ),
    ).toThrow();
    expect(() =>
      assertInstrumentOrderConstraints(
        m,
        price("100000010000"),
        quantity("10000"),
      ),
    ).toThrow();
    expect(() =>
      assertInstrumentOrderConstraints(m, price("0"), quantity("10000")),
    ).toThrow();
    expect(() =>
      assertInstrumentOrderConstraints(
        m,
        price("100000000000"),
        quantity("-10000"),
      ),
    ).toThrow();
  });
});

describe("inert public SDK adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it("is idle at construction and sends exactly one public mainnet meta request", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fixture()), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const adapter = createHyperliquidPublicAdapter();
    expect(fetch).not.toHaveBeenCalled();
    const result = await adapter.getBtcMetadata();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.hyperliquid.xyz/info");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ type: "meta", dex: "" });
    expect(result.instrument.venue_symbol).toBe("BTC");
    expect(Object.keys(adapter)).toEqual(["getBtcMetadata"]);
  });
  it("does not trust the SDK response types", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"universe":[]}', {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(
      createHyperliquidPublicAdapter().getBtcMetadata(),
    ).rejects.toMatchObject({ code: "incompatible_response" });
  });
  it("reports unavailable network without fallback or retry", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetch);
    await expect(
      createHyperliquidPublicAdapter().getBtcMetadata(),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("reports HTTP rate limiting without retry", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("rate limit", { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      createHyperliquidPublicAdapter().getBtcMetadata(),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("bounds stalled requests to eight seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener(
              "abort",
              () => reject(init.signal!.reason),
              { once: true },
            );
          }),
      ),
    );
    const result = expect(
      createHyperliquidPublicAdapter().getBtcMetadata(),
    ).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(8000);
    await result;
  });
});
