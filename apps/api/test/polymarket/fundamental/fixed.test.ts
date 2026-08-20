import { describe, expect, it } from "vitest";

import {
  div,
  divRound,
  formatProbabilityScaled,
  formatScaled,
  MAX_PROB_SCALED,
  MIN_PROB_SCALED,
  mul,
  parseScaled,
  probabilityToScaled,
  scaledToNumber,
  SCALE,
} from "../../../src/polymarket/fundamental/fixed.js";

describe("parseScaled", () => {
  it("parses canonical decimal strings exactly", () => {
    expect(parseScaled("0")).toBe(0n);
    expect(parseScaled("1")).toBe(SCALE);
    expect(parseScaled("0.5")).toBe(500_000_000n);
    expect(parseScaled("0.000000001")).toBe(1n);
    expect(parseScaled("123.456")).toBe(123_456_000_000n);
  });

  it("refuses anything that is not a plain decimal number", () => {
    for (const value of [
      "",
      " 1",
      "1 ",
      "1e3",
      "NaN",
      "Infinity",
      "0x10",
      "1,5",
      ".5",
      "1.",
      "--1",
    ]) {
      expect(parseScaled(value)).toBeNull();
    }
  });

  it("refuses precision it would have to throw away", () => {
    // Ten fraction digits with a non-zero tail cannot be represented exactly.
    expect(parseScaled("0.0000000001")).toBeNull();
    // A zero tail beyond the scale is representable and is accepted.
    expect(parseScaled("0.5000000000")).toBe(500_000_000n);
  });

  it("never round-trips through a float", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; in fixed point it is exact.
    const tenth = parseScaled("0.1") ?? 0n;
    const fifth = parseScaled("0.2") ?? 0n;
    expect(tenth + fifth).toBe(parseScaled("0.3"));
  });
});

describe("arithmetic", () => {
  it("multiplies and divides at the working scale", () => {
    const price = parseScaled("0.49") ?? 0n;
    const size = parseScaled("500") ?? 0n;
    expect(formatScaled(mul(price, size), 2)).toBe("245.00");
    expect(formatScaled(div(mul(price, size), price), 2)).toBe("500.00");
  });

  it("rounds half away from zero and never divides by zero", () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 2n)).toBe(2n);
    expect(divRound(1n, 0n)).toBe(0n);
    expect(div(1n, 0n)).toBe(0n);
  });
});

describe("formatProbabilityScaled", () => {
  it("emits exactly six fraction digits", () => {
    expect(formatProbabilityScaled(509_850_985n)).toBe("0.509851");
    expect(formatProbabilityScaled(500_000_000n)).toBe("0.500000");
    expect(formatProbabilityScaled(SCALE)).toBe("0.999000");
  });

  it("truncates into [0.001, 0.999] so no bound ever leaves the range", () => {
    expect(formatProbabilityScaled(0n)).toBe("0.001000");
    expect(formatProbabilityScaled(-1n)).toBe("0.001000");
    expect(formatProbabilityScaled(SCALE * 2n)).toBe("0.999000");
    expect(formatProbabilityScaled(MIN_PROB_SCALED * 1_000n)).toBe("0.001000");
    expect(formatProbabilityScaled(MAX_PROB_SCALED * 1_000n)).toBe("0.999000");
  });

  it("is byte-identical for identical inputs", () => {
    const first = formatProbabilityScaled(123_456_789n);
    const second = formatProbabilityScaled(123_456_789n);
    expect(first).toBe(second);
    // Fixed-width strings compare lexicographically exactly as numerically,
    // which is what the database CHECK (q_lo <= q <= q_hi) relies on.
    expect(formatProbabilityScaled(1n) < formatProbabilityScaled(SCALE)).toBe(
      true,
    );
  });
});

describe("probability conversion", () => {
  it("round-trips a double through the working scale", () => {
    expect(probabilityToScaled(0.5)).toBe(500_000_000n);
    expect(scaledToNumber(500_000_000n)).toBe(0.5);
  });

  it("clamps non-finite and out-of-range doubles instead of propagating them", () => {
    expect(probabilityToScaled(Number.NaN)).toBe(0n);
    expect(probabilityToScaled(-1)).toBe(0n);
    expect(probabilityToScaled(2)).toBe(SCALE);
  });
});
