// RFC-013 dashboard client: the query space that stands in for the weekly
// report.
//
// What is worth testing here is the part that can be silently wrong: the URL the
// filters build, and the tolerance of the parser. A dropped filter would answer
// a different question than the one asked, and a validator that throws on one
// malformed row would blank a whole page of evidence.

import { describe, expect, it, vi } from "vitest";

import { fetchGateMeasurements } from "../src/portfolio.js";
// Explicit .tsx: "../src/Portfolio.js" would resolve to src/portfolio.ts on a
// case-insensitive filesystem.
import { roundTripCost } from "../src/Portfolio.tsx";
import type { ResolutionFetcher } from "../src/resolution.js";

function jsonResponse(
  status: number,
  body: unknown,
): Pick<Response, "ok" | "status" | "json"> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

const PAGE = {
  simulation: "SIMULAÇÃO — SEM EXECUÇÃO REAL",
  calibrated_expectation: "~84% das carteiras rastreáveis perdem",
  page: { limit: 25, cursor: null, next_cursor: "990" },
  measurements: [
    {
      measurement_id: 991,
      gate: "G2",
      status: "INSUFFICIENT_DATA",
      reason_code: "G2_INSUFFICIENT_PAPER",
      metrics_json: { days: 1, closed_positions: 0 },
      config_version: "1.1.0",
      window_from: null,
      window_to: "2026-08-26T12:00:00.000Z",
      measured_at: "2026-08-26T12:00:00.000Z",
    },
  ],
};

function url(fetcher: { mock: { calls: unknown[][] } }): string {
  return String(fetcher.mock.calls[0]?.[0]);
}

describe("fetchGateMeasurements", () => {
  it("asks for nothing it was not given", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, PAGE));
    await fetchGateMeasurements("t", {}, fetcher as ResolutionFetcher);
    expect(url(fetcher)).toBe("/api/polymarket/gates/measurements");
  });

  it("puts every set filter in the query string", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, PAGE));
    await fetchGateMeasurements(
      "t",
      {
        gate: "G2",
        status: "FAIL",
        from: "2026-08-01T00:00:00Z",
        to: "2026-08-26T23:59:59Z",
        limit: 25,
        cursor: "990",
      },
      fetcher as ResolutionFetcher,
    );
    const query = url(fetcher);
    expect(query).toContain("gate=G2");
    expect(query).toContain("status=FAIL");
    expect(query).toContain("limit=25");
    expect(query).toContain("cursor=990");
    expect(query).toContain("from=2026-08-01");
    expect(query).toContain("to=2026-08-26");
  });

  it("omits an empty filter rather than sending a blank value", async () => {
    // `gate=` is not "all gates" to the endpoint; it is a value it would refuse.
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, PAGE));
    await fetchGateMeasurements(
      "t",
      { gate: "", status: "", cursor: "" },
      fetcher as ResolutionFetcher,
    );
    expect(url(fetcher)).toBe("/api/polymarket/gates/measurements");
  });

  it("returns the rows, the cursor and the calibrated expectation", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, PAGE));
    const outcome = await fetchGateMeasurements(
      "t",
      {},
      fetcher as ResolutionFetcher,
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") {
      return;
    }
    expect(outcome.value.measurements).toHaveLength(1);
    expect(outcome.value.measurements[0]?.gate).toBe("G2");
    expect(outcome.value.measurements[0]?.metrics.days).toBe(1);
    expect(outcome.value.nextCursor).toBe("990");
    expect(outcome.value.calibratedExpectation).toContain("84%");
  });

  it("drops an unusable row instead of failing the whole page", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        ...PAGE,
        measurements: [{ gate: null }, "nonsense", PAGE.measurements[0]],
      }),
    );
    const outcome = await fetchGateMeasurements(
      "t",
      {},
      fetcher as ResolutionFetcher,
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") {
      return;
    }
    expect(outcome.value.measurements).toHaveLength(1);
  });

  it("survives a page with no cursor and unparseable metrics", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        measurements: [{ gate: "G1", metrics_json: "{not json" }],
      }),
    );
    const outcome = await fetchGateMeasurements(
      "t",
      {},
      fetcher as ResolutionFetcher,
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") {
      return;
    }
    expect(outcome.value.nextCursor).toBeNull();
    expect(outcome.value.measurements[0]?.metrics).toEqual({});
    expect(outcome.value.measurements[0]?.status).toBeNull();
  });

  it("maps 401 to unauthorized so the panel can sign out", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    const outcome = await fetchGateMeasurements(
      "t",
      {},
      fetcher as ResolutionFetcher,
    );
    expect(outcome.kind).toBe("unauthorized");
  });
});

// ---------------------------------------------------------------------------
// RFC-015 §8: the "Rápidos" tab's arithmetic.

describe("roundTripCost", () => {
  it("charges the spread once and fees and slippage on both legs", () => {
    // Buying at the ask and selling at the bid loses the spread once; fees and
    // slippage are charged entering AND leaving.
    expect(
      roundTripCost({
        spread: "0.010000",
        fee: "0.001000",
        slippage: "0.002000",
      }),
    ).toBeCloseTo(0.016, 9);
  });

  it("reduces to the spread when there are no fees, which is production today", () => {
    // Measured 2026-09-01: every panel row carries fee 0.000000 and slippage
    // 0.000000, so the round trip IS the spread. The components stay on screen
    // so that stops being an invisible assumption.
    expect(
      roundTripCost({
        spread: "0.014000",
        fee: "0.000000",
        slippage: "0.000000",
      }),
    ).toBeCloseTo(0.014, 9);
  });

  it("treats a missing fee as zero but a missing spread as unknown", () => {
    // No spread means no book to cross: there is no honest number to print,
    // and 0 would read as "free".
    expect(
      roundTripCost({ spread: "0.020000", fee: null, slippage: null }),
    ).toBe(0.02);
    expect(
      roundTripCost({ spread: null, fee: "0.001", slippage: "0" }),
    ).toBeNull();
    expect(roundTripCost({ spread: "", fee: null, slippage: null })).toBeNull();
    expect(
      roundTripCost({ spread: "abc", fee: null, slippage: null }),
    ).toBeNull();
  });
});
