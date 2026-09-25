import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BASELINE_FINGERPRINT,
  canonicalBaselineJson,
  validateBaselineManifest,
} from "../../src/storage/baseline-manifest.js";
import {
  plannedRisk,
  requireRiskCaps,
  riskCeil,
} from "../../src/trading/risk.js";
import { fundingDelta } from "../../src/trading/funding.js";

const source = readFileSync(
  new URL("../../../../config/trading/baseline.json", import.meta.url),
  "utf8",
);
const contract = readFileSync(
  new URL(
    "../../../../docs/contracts/btc-baseline-manifest-v1.md",
    import.meta.url,
  ),
  "utf8",
);

describe("G2-07.1 frozen experiment (no strategy runtime)", () => {
  it("pins the normative text and semantic config with compatible runtime contracts", () => {
    const receipt = validateBaselineManifest(source, contract);
    expect(receipt.fingerprint).toBe(BASELINE_FINGERPRINT);
    expect(receipt.manifest_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(`sha256:${receipt.manifest_hash}`).toBe(receipt.fingerprint);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(JSON.parse(receipt.canonical_json).activation).toEqual({
      baseline_enabled: false,
      jev_enabled: false,
      live_enabled: false,
      start_at: null,
      additional_spend_usd_raw: "0",
    });
    expect(() => validateBaselineManifest(source, `${contract}\n`)).toThrow(
      "CONTRACT_HASH",
    );
  });
  it("survives whitespace/key ordering and replay without changing identity", () => {
    const m = JSON.parse(source);
    const reordered = Object.fromEntries(Object.entries(m).reverse());
    expect(
      validateBaselineManifest(JSON.stringify(reordered), contract),
    ).toEqual(validateBaselineManifest(source, contract));
    expect(canonicalBaselineJson({ z: [2, 1], a: { y: 0, x: "USD6" } })).toBe(
      '{"a":{"x":"USD6","y":0},"z":[2,1]}',
    );
  });
  it.each([
    ["risk", "exposure_bps", 2501],
    ["risk", "entry_risk_bps", 26],
    ["risk", "daily_loss_bps", 151],
    ["risk", "drawdown_bps", 501],
    ["risk", "fee_bps_per_leg", 4],
    ["risk", "funding_planning_periods", 0],
    ["signal", "warmup_1h", 11],
    ["signal", "warmup_15m", 14],
    ["signal", "sma_fast", 12],
    ["signal", "stop_atr_multiple", 0],
    ["signal", "decision_delay_ms", 0],
    ["exits", "max_holding_ms", 21600001],
    ["execution", "intent_ttl_ms", 1000],
    ["funding", "rate_decimals", 9],
    ["funding", "price_source_timestamp", "2026-09-25T00:00:00.000Z"],
    ["funding", "fidelity", "venue_settlement"],
    ["accounting", "btc_decimals", 9],
    ["activation", "baseline_enabled", true],
    ["activation", "jev_enabled", true],
    ["activation", "live_enabled", true],
    ["jev", "real_budget_usd_raw", "5000000"],
    ["jev", "resize", true],
    ["evaluation", "days", 1],
  ])("rejects silent change to %s.%s", (section, key, value) => {
    const m = JSON.parse(source);
    m[section as string][key as string] = value;
    expect(() => validateBaselineManifest(JSON.stringify(m), contract)).toThrow(
      "NOT_FROZEN",
    );
  });
  it("rejects extra fields, duplicate/escaped keys, array reorder and invalid numeric JSON", () => {
    const m = JSON.parse(source);
    m.unknown = true;
    expect(() => validateBaselineManifest(JSON.stringify(m), contract)).toThrow(
      "NOT_FROZEN",
    );
    expect(() =>
      validateBaselineManifest(
        source.replace('"leverage": 1', '"leverage": 2, "leverage": 1'),
        contract,
      ),
    ).toThrow("DUPLICATE_KEY");
    expect(() =>
      validateBaselineManifest('{"a":0,"\\u0061":0}', contract),
    ).toThrow("DUPLICATE_KEY");
    const arrayChange = JSON.parse(source);
    arrayChange.exits.priority.reverse();
    expect(() =>
      validateBaselineManifest(JSON.stringify(arrayChange), contract),
    ).toThrow("NOT_FROZEN");
    for (const value of [1.5, NaN, Infinity, -0, Number.MAX_SAFE_INTEGER + 1])
      expect(() => canonicalBaselineJson(value)).toThrow("JSON_NUMBER");
    expect(() => canonicalBaselineJson({ invalid: undefined })).toThrow(
      "JSON_OBJECT",
    );
  });
});

describe("manual normative vectors, independent of future strategy implementation", () => {
  it("checks long/short/neutral SMA and breakout examples using exact sums", () => {
    const vectors = [
      {
        hours: [...Array<number>(8).fill(98000), 99000, 99200, 99400, 99600],
        open: 99700,
        previous: 99900,
        direction: 1,
      },
      {
        hours: [
          ...Array<number>(8).fill(102000),
          101000,
          100800,
          100600,
          100400,
        ],
        open: 100300,
        previous: 100100,
        direction: -1,
      },
    ];
    for (const v of vectors) {
      const sum4 = v.hours.slice(-4).reduce((a, b) => a + b, 0);
      const sum12 = v.hours.reduce((a, b) => a + b, 0);
      expect(Math.sign(v.hours.at(-1)! * 4 - sum4)).toBe(v.direction);
      expect(Math.sign(sum4 * 12 - sum12 * 4)).toBe(v.direction);
      expect(Math.sign(100000 - v.previous)).toBe(v.direction);
      expect(Math.sign(100000 - v.open)).toBe(v.direction);
    }
    expect(4 * 100000 * 12).toBe(12 * 100000 * 4); // neutral equality
    const m = JSON.parse(source);
    expect(11 < m.signal.warmup_1h).toBe(true); // healthy but insufficient
    const atr = riskCeil(14n * 500_000000n, 14n);
    expect(atr).toBe(500_000000n);
    expect(100000_000000n - 2n * atr).toBe(99000_000000n);
    expect(100000_000000n + 2n * atr).toBe(101000_000000n);
  });
  it.each(["buy", "sell"] as const)(
    "checks %s costs, maximum lot, and core risk precedence",
    (side) => {
      const stop = side === "buy" ? 99000_000000n : 101000_000000n;
      const cap = 100100_000000n;
      const exit = stop > cap ? stop : cap;
      const budget = (q: bigint) =>
        plannedRisk(
          {
            side,
            quantity_btc_raw: q.toString(),
            price_cap_usd_raw: cap.toString(),
            fee_bps: 5,
            risk_plan: {
              stop_price_usd_raw: stop.toString(),
              entry_floor_usd_raw: "99900000000",
            },
          },
          5,
        ) +
        riskCeil(q * stop * 10n, 10n ** 12n) +
        7n * riskCeil(q * exit * 10n ** 14n, 10n ** 26n);
      expect(budget(100000n)).toBe(side === "buy" ? 1369170n : 1372250n);
      expect(budget(182000n)).toBe(side === "buy" ? 2491895n : 2497495n);
      expect(() =>
        requireRiskCaps("1000000000", 182182000n, budget(182000n)),
      ).not.toThrow();
      expect(() =>
        requireRiskCaps("1000000000", 183183000n, budget(183000n)),
      ).toThrow("PLANNED_LIMIT");
      expect(() =>
        requireRiskCaps("1000000000", 200200000n, budget(200000n)),
      ).toThrow("PLANNED_LIMIT");
    },
  );
  it("checks inclusive 6h deadline from first fill and signed funding micro rounding", () => {
    const first = Date.parse("2026-09-25T12:15:12.345Z");
    const deadline = first + JSON.parse(source).exits.max_holding_ms;
    expect(Date.parse("2026-09-25T18:15:12.344Z") >= deadline).toBe(false);
    expect(Date.parse("2026-09-25T18:15:12.345Z") >= deadline).toBe(true);
    expect(fundingDelta("1", "100000000001", "100000000000000", 18)).toBe("-1");
    expect(fundingDelta("-1", "100000000001", "100000000000000", 18)).toBe("0");
  });
});
