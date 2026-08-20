import { describe, expect, it } from "vitest";
import { buildInterval } from "../../../src/polymarket/fundamental/interval.js";
import { probabilityToScaled } from "../../../src/polymarket/fundamental/fixed.js";

const base = {
  qScaled: probabilityToScaled(0.5),
  execSpreadScaled: probabilityToScaled(0.02),
  sigma: 0.05,
  bookAgeMs: 0,
  maxBookAgeMs: 30_000,
  maxFeedAgeMs: 120_000,
  timeToResolutionMs: 30 * 60_000,
  widenFactor: 1,
};

describe("feed age widening", () => {
  it("prints both half widths", () => {
    const withoutFeed = buildInterval({ ...base, feedAgeMs: null });
    const withFeed = buildInterval({ ...base, feedAgeMs: 119_000 });
    const fresh = buildInterval({ ...base, feedAgeMs: 0 });
    const typical = buildInterval({ ...base, feedAgeMs: 45_000 });
    console.log(JSON.stringify({
      nullHalf: withoutFeed.halfWidthScaled.toString(),
      nullMult: withoutFeed.stalenessMultiplier,
      nullLo: withoutFeed.qLoScaled.toString(),
      nullHi: withoutFeed.qHiScaled.toString(),
      f119Half: withFeed.halfWidthScaled.toString(),
      f119Mult: withFeed.stalenessMultiplier,
      f119Lo: withFeed.qLoScaled.toString(),
      f119Hi: withFeed.qHiScaled.toString(),
      freshHalf: fresh.halfWidthScaled.toString(),
      typicalHalf: typical.halfWidthScaled.toString(),
      typicalMult: typical.stalenessMultiplier,
    }, null, 2));
    expect(withoutFeed.halfWidthScaled).toBe(fresh.halfWidthScaled);
  });
});
