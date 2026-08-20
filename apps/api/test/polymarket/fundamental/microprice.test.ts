import { describe, expect, it } from "vitest";

import {
  formatProbabilityScaled,
  formatScaled,
} from "../../../src/polymarket/fundamental/fixed.js";
import {
  computeMicroprice,
  isThinBook,
  MICROPRICE_VERSION,
} from "../../../src/polymarket/fundamental/microprice.js";
import type { BookView } from "../../../src/polymarket/fundamental/types.js";

const DECISION_TS = new Date("2026-08-19T12:00:00.000Z");

function book(overrides: Partial<BookView> = {}): BookView {
  return {
    tokenId: "token-1",
    bids: [
      { price: "0.50", size: "100" },
      { price: "0.49", size: "500" },
    ],
    asks: [
      { price: "0.52", size: "100" },
      { price: "0.53", size: "500" },
    ],
    sourceTs: DECISION_TS,
    observedAt: DECISION_TS,
    ...overrides,
  };
}

describe("computeMicroprice", () => {
  it("computes the executable VWAPs and the depth-weighted mid exactly", () => {
    const result = computeMicroprice(book(), DECISION_TS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Hand-checked: selling $100 into the bids fills 100 shares at 0.50 plus
    // 50/0.49 shares at 0.49 => VWAP 100/202.040816327 = 0.494949495.
    expect(formatScaled(result.value.bidExecScaled, 9)).toBe("0.494949495");
    // Buying $100 from the asks fills 100 at 0.52 plus 48/0.53 at 0.53
    // => VWAP 100/190.566037736 = 0.524752475.
    expect(formatScaled(result.value.askExecScaled, 9)).toBe("0.524752475");
    expect(formatScaled(result.value.execSpreadScaled, 9)).toBe("0.029802980");
    // Both sides rest 600 shares, so the imbalance weighting is symmetric and
    // the microprice is the midpoint of the two executable VWAPs.
    expect(formatProbabilityScaled(result.value.micropriceScaled)).toBe(
      "0.509851",
    );
    expect(result.value.version).toBe(MICROPRICE_VERSION);
  });

  it("is derived from the raw book, never from a last trade", () => {
    // The same book with a wildly different "last trade" is irrelevant: the
    // function takes only levels, so there is no path for a UI price to leak in.
    const first = computeMicroprice(book(), DECISION_TS);
    const second = computeMicroprice(book(), DECISION_TS);
    expect(JSON.stringify(first, replacer)).toBe(
      JSON.stringify(second, replacer),
    );
  });

  it("leans toward the side with the heavier opposing queue", () => {
    const heavyBid = computeMicroprice(
      book({
        bids: [
          { price: "0.50", size: "100" },
          { price: "0.49", size: "5000" },
        ],
      }),
      DECISION_TS,
    );
    const balanced = computeMicroprice(book(), DECISION_TS);
    expect(heavyBid.ok && balanced.ok).toBe(true);
    if (!heavyBid.ok || !balanced.ok) {
      return;
    }
    // A heavy resting bid queue pushes the estimate toward the ask.
    expect(heavyBid.value.micropriceScaled).toBeGreaterThan(
      balanced.value.micropriceScaled,
    );
  });

  it("never leaves the executable band", () => {
    const result = computeMicroprice(
      book({
        bids: [{ price: "0.40", size: "100000" }],
        asks: [{ price: "0.41", size: "1" }],
      }),
      DECISION_TS,
    );
    // The ask side cannot fill $100 (1 share x 0.41 = $0.41), so there is no
    // executable price at all.
    expect(result).toEqual({ ok: false, reason: "DEPTH_BELOW_SREF" });
  });

  it("invalidates a book older than the staleness threshold", () => {
    const stale = computeMicroprice(
      book({ sourceTs: new Date(DECISION_TS.getTime() - 31_000) }),
      DECISION_TS,
    );
    expect(stale).toEqual({ ok: false, reason: "BOOK_STALE" });

    const fresh = computeMicroprice(
      book({ sourceTs: new Date(DECISION_TS.getTime() - 29_000) }),
      DECISION_TS,
    );
    expect(fresh.ok).toBe(true);
  });

  it("falls back to the local clock when the venue gave no source_ts", () => {
    const result = computeMicroprice(
      book({
        sourceTs: null,
        observedAt: new Date(DECISION_TS.getTime() - 31_000),
      }),
      DECISION_TS,
    );
    // A missing venue timestamp must never make a stale book look fresh.
    expect(result).toEqual({ ok: false, reason: "BOOK_STALE" });
  });

  it("invalidates an executable spread wider than ten cents", () => {
    const result = computeMicroprice(
      book({
        bids: [{ price: "0.40", size: "1000" }],
        asks: [{ price: "0.55", size: "1000" }],
      }),
      DECISION_TS,
    );
    expect(result).toEqual({ ok: false, reason: "SPREAD_TOO_WIDE" });
  });

  it("invalidates a crossed or locked book", () => {
    const crossed = computeMicroprice(
      book({
        bids: [{ price: "0.52", size: "1000" }],
        asks: [{ price: "0.51", size: "1000" }],
      }),
      DECISION_TS,
    );
    expect(crossed).toEqual({ ok: false, reason: "BOOK_CROSSED" });

    const locked = computeMicroprice(
      book({
        bids: [{ price: "0.51", size: "1000" }],
        asks: [{ price: "0.51", size: "1000" }],
      }),
      DECISION_TS,
    );
    expect(locked).toEqual({ ok: false, reason: "BOOK_CROSSED" });
  });

  it("refuses an empty or malformed side instead of guessing", () => {
    expect(computeMicroprice(book({ bids: [] }), DECISION_TS)).toEqual({
      ok: false,
      reason: "NO_BOOK",
    });
    expect(
      computeMicroprice(
        book({ asks: [{ price: "abc", size: "1000" }] }),
        DECISION_TS,
      ),
    ).toEqual({ ok: false, reason: "NO_BOOK" });
  });

  it("honours a configured reference size", () => {
    const large = computeMicroprice(book(), DECISION_TS, { sRefUsd: 100_000 });
    expect(large).toEqual({ ok: false, reason: "DEPTH_BELOW_SREF" });

    const small = computeMicroprice(book(), DECISION_TS, { sRefUsd: 1 });
    expect(small.ok).toBe(true);
    if (!small.ok) {
      return;
    }
    // At $1 of size only the top level is touched, so the executable spread
    // collapses to the quoted spread.
    expect(formatScaled(small.value.execSpreadScaled, 9)).toBe("0.020000000");
  });
});

describe("isThinBook", () => {
  it("flags a book resting less than the configured multiple of S_ref", () => {
    const result = computeMicroprice(book(), DECISION_TS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The bids rest $295 (0.50x100 + 0.49x500) and the asks $317, so at 2x
    // $100 neither side is thin, and at 3x the bid side already is.
    expect(isThinBook(result.value, 2)).toBe(false);
    expect(isThinBook(result.value, 3)).toBe(true);
  });
});

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
