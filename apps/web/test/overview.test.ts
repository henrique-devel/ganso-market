// RFC-015 clients for /overview, /events and /paper/performance.
//
// What can be silently wrong: a validator that turns a missing number into 0
// (the panel would claim a position is flat when it is unmarked), a cursor that
// is not sent (the feed would replay forever), and a parser that throws on one
// malformed row (one bad field would blank the whole page).

import { describe, expect, it, vi } from "vitest";

import {
  fetchEvents,
  fetchOverview,
  fetchPerformance,
} from "../src/overview.js";
// Explicit .tsx: on a case-insensitive filesystem "../src/Overview.js" would
// resolve to src/overview.ts, the client module next to it (same reason
// App.tsx spells its imports out).
import { precisaRecarregar } from "../src/Overview.tsx";
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

const OVERVIEW = {
  simulation: "SIMULAÇÃO — SEM EXECUÇÃO REAL",
  generated_at: "2026-09-01T17:00:00.000Z",
  release_sha: "5bb1caaa55aa2f044ded76618874aef0695f51d3",
  portfolio: {
    state: "NORMAL",
    reason: null,
    bankroll_usd: "1000.000000",
    high_water_mark_usd: "1001.465800",
    equity_usd: "998.791000",
    drawdown: "0.002670",
    realized_pnl_day_usd: "0.000000",
    realized_pnl_week_usd: "0.000000",
    manual_halt: false,
  },
  circuit_breakers: { open: 41, opened_last_hour: 88, most_recent_at: null },
  kill_switch: {
    engaged: false,
    reason: null,
    engaged_at: "2026-08-31T23:53:09Z",
    rearmed_at: "2026-09-01T01:46:56Z",
    frozen_count: 1,
  },
  rfc_009_status: "BLOCKED",
  gates: [
    {
      gate: "G1",
      status: "INSUFFICIENT_DATA",
      reason_code: "G1_CALIBRATION_NOT_MET",
      measured_at: "2026-09-01T16:27:18Z",
    },
  ],
  collection: {
    last_book_delta_at: "2026-09-01T16:59:52Z",
    last_book_delta_age_ms: 7278,
    open_gaps: 0,
    gaps_24h: 0,
    universe_members: 64,
  },
  model: {
    estimates_last_hour: 1233,
    last_estimate_at: "2026-09-01T16:59:39Z",
    active_models: 0,
    shadow_models: 2,
  },
  resolution: {
    markets: 750,
    blocked: 3,
    buffered: 12,
    open_violations: 0,
    open_divergences: 0,
  },
  paper: { open_orders: 0, positions: 2, fills_24h: 0 },
  storage: {
    budget_bytes: 118111600640,
    live_bytes: 42000000000,
    physical_bytes: 60000000000,
    bloat_bytes: 18000000000,
    budget_used_pct: 35.56,
  },
  limits: { drawdown_limit: 0.1 },
};

describe("fetchOverview", () => {
  it("parses the aggregate, converting numeric strings", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(jsonResponse(200, OVERVIEW)),
    ) as unknown as ResolutionFetcher;
    const result = await fetchOverview("token", fetcher);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.value.portfolio?.equity_usd).toBe(998.791);
    expect(result.value.portfolio?.drawdown).toBe(0.00267);
    expect(result.value.circuit_breakers.open).toBe(41);
    expect(result.value.kill_switch?.engaged).toBe(false);
    expect(result.value.gates).toHaveLength(1);
    expect(result.value.storage.budget_used_pct).toBe(35.56);
    expect(result.value.drawdown_limit).toBe(0.1);
    expect(result.value.release_sha).toBe(OVERVIEW.release_sha);
  });

  it("survives a body with the portfolio row missing", async () => {
    // The engine has not booted yet: no state row. The rest of the panel must
    // still render rather than the page going blank.
    const fetcher = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { ...OVERVIEW, portfolio: null })),
    ) as unknown as ResolutionFetcher;
    const result = await fetchOverview("token", fetcher);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.value.portfolio).toBeNull();
    expect(result.value.resolution.markets).toBe(750);
  });

  it("degrades every malformed section instead of throwing", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          portfolio: "not an object",
          gates: [{ status: "PASS" }, "junk", { gate: "G4" }],
          circuit_breakers: null,
          storage: [],
          limits: { drawdown_limit: "não é número" },
        }),
      ),
    ) as unknown as ResolutionFetcher;
    const result = await fetchOverview("token", fetcher);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.value.portfolio).toBeNull();
    // The gate without a name is dropped; the one with a name survives.
    expect(result.value.gates.map((gate) => gate.gate)).toEqual(["G4"]);
    expect(result.value.circuit_breakers.open).toBe(0);
    expect(result.value.storage.live_bytes).toBe(0);
    // A malformed limit falls back to the RFC-013 threshold rather than to 0,
    // which would draw the drawdown bar as instantly full.
    expect(result.value.drawdown_limit).toBe(0.1);
  });

  it("reports a 401 as unauthorized so the session can refresh", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(jsonResponse(401, {})),
    ) as unknown as ResolutionFetcher;
    expect((await fetchOverview("token", fetcher)).kind).toBe("unauthorized");
  });
});

describe("fetchEvents", () => {
  it("omits the cursor on a first load and sends it afterwards", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, { events: [], page: { next_cursor: "estado:5" } }),
      ),
    ) as unknown as ResolutionFetcher & { mock: { calls: unknown[][] } };

    await fetchEvents("token", null, fetcher);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("/api/polymarket/events");

    await fetchEvents("token", "estado:5,decisao:9", fetcher);
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(
      "/api/polymarket/events?after=estado%3A5%2Cdecisao%3A9",
    );
  });

  it("parses events and drops rows without a source or an id", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          events: [
            {
              source: "estado",
              kind: "PORTFOLIO_STATE",
              event_id: 4,
              occurred_at: "2026-09-01T10:00:00Z",
              severity: "alert",
              summary: "NORMAL → HALTED",
              detail: { to_state: "HALTED" },
            },
            { kind: "SEM_FONTE", event_id: 5 },
            { source: "decisao" },
            "lixo",
          ],
          page: { next_cursor: "estado:4" },
        }),
      ),
    ) as unknown as ResolutionFetcher;
    const result = await fetchEvents("token", null, fetcher);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.value.events).toHaveLength(1);
    expect(result.value.events[0]?.severity).toBe("alert");
    expect(result.value.nextCursor).toBe("estado:4");
  });

  it("falls back to info for a severity it does not recognise", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          events: [{ source: "g2", event_id: 1, severity: "catastrofe" }],
          page: {},
        }),
      ),
    ) as unknown as ResolutionFetcher;
    const result = await fetchEvents("token", null, fetcher);
    if (result.kind !== "ok") {
      throw new Error("esperava ok");
    }
    expect(result.value.events[0]?.severity).toBe("info");
    expect(result.value.nextCursor).toBeNull();
  });
});

describe("fetchPerformance", () => {
  it("keeps an unrealised null as null, never as zero", async () => {
    // The report returns null when an open position has no executable mark.
    // Printing 0 would tell the operator there is no open risk.
    const fetcher = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          columns: {
            optimistic_realized_usd: "1.500000",
            base_realized_usd: "-0.725400",
            base_unrealized_usd: null,
            base_net_usd: null,
            stress_realized_usd: "-1.100000",
            note: "optimistic is diagnostic only",
          },
          fees_paid_usd: "0.031000",
        }),
      ),
    ) as unknown as ResolutionFetcher;
    const result = await fetchPerformance("token", fetcher);
    if (result.kind !== "ok") {
      throw new Error("esperava ok");
    }
    expect(result.value.base_unrealized_usd).toBeNull();
    expect(result.value.base_net_usd).toBeNull();
    expect(result.value.base_realized_usd).toBe(-0.7254);
    expect(result.value.fees_paid_usd).toBe(0.031);
  });

  it("survives a body with no columns block", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { simulation: "…" })),
    ) as unknown as ResolutionFetcher;
    const result = await fetchPerformance("token", fetcher);
    if (result.kind !== "ok") {
      throw new Error("esperava ok");
    }
    expect(result.value.base_realized_usd).toBeNull();
  });
});

describe("precisaRecarregar", () => {
  // The lesson of 2026-08-31, as a unit. The rearm button "did not work" for
  // an hour because the SPA in memory was an old bundle; logging in inside the
  // app does not reload it and index.html is no-store, so one reload fixed it
  // and nothing on screen said so. This is the only carona whose entire value
  // is that it FIRES, so it gets a test that fails if it stops firing.
  const A = "a".repeat(40);
  const B = "b".repeat(40);

  it("warns when the bundle and the API are on different revisions", () => {
    expect(precisaRecarregar(A, B)).toBe(true);
  });

  it("says nothing when they match", () => {
    expect(precisaRecarregar(A, A)).toBe(false);
  });

  it("says nothing when either side is unknown", () => {
    // A dev checkout leaves the release-sha placeholder literal, and an older
    // API does not report one at all. Warning in either case would train the
    // operator to ignore the warning.
    expect(precisaRecarregar("unknown", A)).toBe(false);
    expect(precisaRecarregar(A, "unknown")).toBe(false);
    expect(precisaRecarregar(A, null)).toBe(false);
    expect(precisaRecarregar("unknown", null)).toBe(false);
  });
});
