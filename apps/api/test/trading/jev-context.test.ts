import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildJevContext } from "../../src/storage/jev-context.js";
import {
  initialJevManifest,
  validateJevManifest,
  validateJevSuccessor,
  type JevManifest,
} from "../../src/storage/jev-manifest.js";
import { atr14 } from "../../src/trading/indicators.js";
import { iso } from "./jev-v2-fixture.js";
import { contextFixture } from "./jev-context-fixture.js";
describe("JEV context and manifests", () => {
  it("fixes identical information/criteria with only 1/3/5-minute horizons differing", () => {
    for (const h of [1, 3, 5] as const)
      expect(
        JSON.parse(
          readFileSync(
            new URL(
              `../../../../config/trading/jev/horizon-${h}.json`,
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      ).toEqual(initialJevManifest(h));
    const manifests = [1, 3, 5].map((h) => initialJevManifest(h as 1 | 3 | 5));
    for (const m of manifests) {
      expect(validateJevManifest(m)).toMatch(/^[a-f0-9]{64}$/);
      expect({ ...m, horizon_minutes: 1 }).toEqual(manifests[0]);
    }
    expect(new Set(manifests.map(validateJevManifest)).size).toBe(3);
  });
  it("computes independent fixed-point book, flow, ATR14, RSI and signed funding", () => {
    const f = contextFixture(),
      c = buildJevContext(f.manifest, f.identity, f.input);
    expect(c.quality.state).toBe("observed_no_known_gap");
    expect(c.book).toMatchObject({
      mid: { raw: "101000000" },
      spread: { raw: "2000000" },
      bid_depth: { raw: "100000000" },
      imbalance: { raw: "0" },
    });
    expect(c.flow).toMatchObject({
      net: { raw: "100000000" },
      vwap: { raw: "100000000" },
      trades: 1,
      continuity: "unproven",
    });
    expect(c.indicators).toMatchObject({
      atr14: { raw: "4000000" },
      rsi14: { raw: "500000000" },
      returns: [
        { period_minutes: 15, value: { raw: "0" } },
        { period_minutes: 45, value: { raw: "0" } },
        { period_minutes: 75, value: { raw: "0" } },
      ],
    });
    expect(c.funding?.current_rate.raw).toBe("-123456789012");
    expect(c.account?.scope.account_id).toBe(f.identity.account.account_id);
    expect(atr14(f.input.bars.map((b) => b.payload.ohlc!))).toBe(4000000n);
  });
  it("excludes unknown/future source, receipt and recorded times", () => {
    for (const field of ["source_timestamp", "received_at"] as const) {
      const f = contextFixture();
      f.input.book = f.record("book", {
        ...f.input.book!.payload,
        [field]: iso(f.cut + 1),
      });
      expect(buildJevContext(f.manifest, f.identity, f.input).book).toBeNull();
    }
    const f = contextFixture();
    f.input.book = { ...f.input.book!, recorded_at: iso(f.cut + 1) };
    const c = buildJevContext(f.manifest, f.identity, f.input);
    expect(c.book).toBeNull();
    expect(c.input_refs.some((r) => r.object_id === "book")).toBe(false);
  });
  it.each([
    "gap",
    "missing_bar",
    "future_close",
    "missing_dependency",
    "future_dependency",
    "stale_book",
    "missing_coverage",
  ])("keeps %s explicit without interpolation", (kind) => {
    const f = contextFixture();
    if (kind === "gap")
      f.input.coverage = f.record("coverage", {
        ...f.input.coverage!.payload,
        gaps: [{ start_at: iso(f.cut - 500), end_at: null }],
      });
    if (kind === "missing_bar") f.input.bars.splice(3, 1);
    if (kind === "future_close")
      f.input.bars[0] = f.record("bar:0", {
        ...f.input.bars[0]!.payload,
        closed_at: iso(f.cut + 1),
      });
    if (kind === "missing_dependency") f.input.dependencies.pop();
    if (kind === "future_dependency")
      f.input.dependencies[0] = {
        ...f.input.dependencies[0]!,
        received_at: iso(f.cut + 1),
      };
    if (kind === "stale_book")
      f.input.book = f.record("book", {
        ...f.input.book!.payload,
        source_timestamp: iso(f.cut - 2001),
      });
    if (kind === "missing_coverage") f.input.coverage = null;
    expect(buildJevContext(f.manifest, f.identity, f.input).quality.state).toBe(
      "incomplete",
    );
  });
  it("rejects foreign state, financial units and changed payload hashes", () => {
    const f = contextFixture();
    f.input.account = f.record("account", {
      ...f.input.account.payload,
      scope: { ...f.input.account.payload.scope, account_id: "other" },
    });
    expect(() => buildJevContext(f.manifest, f.identity, f.input)).toThrow(
      /OWNERSHIP/,
    );
    const g = contextFixture();
    g.input.bars[0] = g.record("bar:0", {
      ...g.input.bars[0]!.payload,
      ohlc: { ...g.input.bars[0]!.payload.ohlc!, decimals: 2 as 6 },
    });
    expect(() => buildJevContext(g.manifest, g.identity, g.input)).toThrow(
      /UNIT/,
    );
    const h = contextFixture();
    h.input.account.payload.cash_usd_raw = "999";
    expect(buildJevContext(h.manifest, h.identity, h.input).account).toBeNull();
  });
  it("allows one reviewed component and freezes risk, cadence and exits", () => {
    const original = initialJevManifest(1),
      next = { ...original, horizon_minutes: 3 as const };
    expect(validateJevSuccessor(original, next)).not.toBe(
      validateJevManifest(original),
    );
    expect(() =>
      validateJevSuccessor(original, {
        ...next,
        context: { ...next.context, trade_window_seconds: 30 },
      }),
    ).toThrow(/ONE_COMPONENT/);
    expect(() =>
      validateJevManifest({
        ...original,
        exits: { ...original.exits, stop_atr_multiplier: 3 },
      } as unknown as JevManifest),
    ).toThrow(/FROZEN/);
    expect(() =>
      validateJevManifest({
        ...original,
        cadence: { ...original.cadence, fast_ms: 1000 },
      } as unknown as JevManifest),
    ).toThrow(/FROZEN/);
  });
});
