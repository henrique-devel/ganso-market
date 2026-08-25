import { describe, expect, it, vi } from "vitest";

import {
  authorizedGet,
  fetchDivergences,
  fetchGraph,
  fetchGraphViolations,
  fetchMarketDetail,
  fetchMeasurementReports,
  fetchPipeline,
  fetchResolutionRisk,
  fetchSanityVetoes,
  type ResolutionFetcher,
} from "../src/resolution.js";

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

describe("authorizedGet", () => {
  it("sends the bearer token and returns the validated value", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { n: 7 }));
    const outcome = await authorizedGet(
      "/api/polymarket/resolution-risk",
      "token-1",
      (body) => body as { n: number },
      fetcher as ResolutionFetcher,
    );
    expect(outcome).toEqual({ kind: "ok", value: { n: 7 } });
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer token-1",
    );
  });

  it("maps 401 to unauthorized", async () => {
    const outcome = await authorizedGet(
      "/x",
      "expired",
      (body) => body,
      vi.fn().mockResolvedValue(jsonResponse(401, {})),
    );
    expect(outcome).toEqual({ kind: "unauthorized" });
  });

  it("maps non-2xx, network failures and invalid JSON to error", async () => {
    const server = await authorizedGet(
      "/x",
      "t",
      (body) => body,
      vi.fn().mockResolvedValue(jsonResponse(500, {})),
    );
    const network = await authorizedGet(
      "/x",
      "t",
      (body) => body,
      vi.fn().mockRejectedValue(new Error("offline")),
    );
    const badJson = await authorizedGet(
      "/x",
      "t",
      (body) => body,
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error("not json")),
      }),
    );
    const rejected = await authorizedGet(
      "/x",
      "t",
      () => null,
      vi.fn().mockResolvedValue(jsonResponse(200, {})),
    );
    expect(server).toEqual({ kind: "error" });
    expect(network).toEqual({ kind: "error" });
    expect(badJson).toEqual({ kind: "error" });
    expect(rejected).toEqual({ kind: "error" });
  });
});

describe("fetchResolutionRisk", () => {
  it("parses a full market row including *_json fields sent as strings", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        markets: [
          {
            condition_id: "0xcond1",
            question: "Pergunta?",
            category: "politics",
            neg_risk: true,
            score: "0.472000",
            score_version: "v3",
            action: "BUFFER",
            effective_action: "VETO",
            resolution_buffer: "0.020000",
            p_5050: "0.310000",
            expected_lockup_s: 7200,
            p95_lockup_s: 172800,
            dispute_active: true,
            suspect_jump: false,
            hard_flags_json: '["EARLY_EXPIRATION"]',
            event_ids_json: ["evt-1"],
            group_worst_score: "0.910000",
            justification: "Motivo.",
            prior_kind: "measured",
            computed_at: "2026-08-24T11:57:00.000Z",
          },
        ],
      }),
    );
    const outcome = await fetchResolutionRisk("t", fetcher);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") {
      return;
    }
    const market = outcome.value.markets[0];
    expect(market?.score).toBeCloseTo(0.472);
    expect(market?.effective_action).toBe("VETO");
    expect(market?.hard_flags).toEqual(["EARLY_EXPIRATION"]);
    expect(market?.event_ids).toEqual(["evt-1"]);
    expect(market?.group_worst_score).toBeCloseTo(0.91);
  });

  it("tolerates garbage bodies and rows without throwing", async () => {
    const garbage = await fetchResolutionRisk(
      "t",
      vi.fn().mockResolvedValue(jsonResponse(200, "lixo")),
    );
    expect(garbage).toEqual({ kind: "ok", value: { markets: [] } });

    const partial = await fetchResolutionRisk(
      "t",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          markets: [
            { condition_id: "0xok", score: "abc", action: "EXPLODE" },
            { question: "sem id" },
            42,
            null,
          ],
        }),
      ),
    );
    expect(partial.kind).toBe("ok");
    if (partial.kind !== "ok") {
      return;
    }
    expect(partial.value.markets).toHaveLength(1);
    const market = partial.value.markets[0];
    expect(market).toMatchObject({
      condition_id: "0xok",
      question: "",
      score: null,
      action: null,
      dispute_active: false,
      hard_flags: [],
      event_ids: [],
    });
  });
});

describe("fetchDivergences", () => {
  it("returns empty sets for missing fields and drops invalid rows", async () => {
    const empty = await fetchDivergences(
      "t",
      vi.fn().mockResolvedValue(jsonResponse(200, {})),
    );
    expect(empty).toEqual({ kind: "ok", value: { active: [], recent: [] } });

    const mixed = await fetchDivergences(
      "t",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          active: [
            {
              condition_id: "0xd",
              direction: "rfc012_only",
              rfc012_action: "VETO",
              position_held: true,
              started_at: "2026-08-24T10:00:00.000Z",
            },
            "não é linha",
          ],
          recent: "quebrado",
        }),
      ),
    );
    expect(mixed.kind).toBe("ok");
    if (mixed.kind !== "ok") {
      return;
    }
    expect(mixed.value.recent).toEqual([]);
    expect(mixed.value.active).toHaveLength(1);
    expect(mixed.value.active[0]).toMatchObject({
      direction: "rfc012_only",
      rfc012_action: "VETO",
      position_held: true,
      rfc011_frozen: false,
      ended_at: null,
    });
  });
});

describe("fetchGraphViolations", () => {
  it("returns empty sets on garbage and extracts half_life_s from details_json", async () => {
    const empty = await fetchGraphViolations(
      "t",
      vi.fn().mockResolvedValue(jsonResponse(200, [])),
    );
    expect(empty).toEqual({ kind: "ok", value: { active: [], recent: [] } });

    const parsed = await fetchGraphViolations(
      "t",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          active: [
            {
              edge_key: "edge-abc",
              kind: "complement",
              magnitude_net: "0.012500",
              magnitude_bps: 42,
              suppressed: false,
              details_json: '{"half_life_s": 120}',
            },
          ],
          recent: [
            {
              edge_key: "edge-def",
              details_json: { half_life_s: 60 },
            },
            { sem_chave: true },
          ],
        }),
      ),
    );
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") {
      return;
    }
    expect(parsed.value.active[0]?.half_life_s).toBe(120);
    expect(parsed.value.active[0]?.magnitude_net).toBeCloseTo(0.0125);
    expect(parsed.value.recent).toHaveLength(1);
    expect(parsed.value.recent[0]?.half_life_s).toBe(60);
  });
});

describe("fetchSanityVetoes", () => {
  it("never throws on garbage and keeps valid rows", async () => {
    const garbage = await fetchSanityVetoes(
      "t",
      vi.fn().mockResolvedValue(jsonResponse(200, 12)),
    );
    expect(garbage).toEqual({ kind: "ok", value: { active: [], recent: [] } });

    const parsed = await fetchSanityVetoes(
      "t",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          active: [
            {
              condition_id: "0xv",
              q: "0.420000",
              neighbor_price: 0.55,
              estimate_status: "shadow",
            },
          ],
        }),
      ),
    );
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") {
      return;
    }
    expect(parsed.value.active[0]).toMatchObject({
      condition_id: "0xv",
      q: 0.42,
      neighbor_price: 0.55,
      estimate_status: "shadow",
      magnitude: null,
    });
  });
});

describe("fetchPipeline", () => {
  it("degrades a missing body to a null kill switch and empty lists", async () => {
    const outcome = await fetchPipeline(
      "t",
      vi.fn().mockResolvedValue(jsonResponse(200, {})),
    );
    expect(outcome).toEqual({
      kind: "ok",
      value: {
        kill_switch: null,
        open_orders: [],
        positions: [],
        divergences_active: null,
        checked_at: null,
      },
    });
  });

  it("parses kill switch, orders and positions", async () => {
    const outcome = await fetchPipeline(
      "t",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          kill_switch: {
            engaged: true,
            reason: "DIVERGENCE_SPIKE",
            engaged_at: "2026-08-24T09:00:00.000Z",
            rearmed_at: null,
            frozen_markets_json: '["0xcond1"]',
          },
          open_orders: [
            { order_id: "ord-1", side: "BUY", limit_price: "0.410000" },
            { faltando: "id" },
          ],
          positions: [
            {
              token_id: "tok-1",
              cost_usd: 10,
              mark_value_usd: "12.5",
              mark_stale: true,
            },
          ],
          divergences_active: 2,
          checked_at: "2026-08-24T12:00:00.000Z",
        }),
      ),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") {
      return;
    }
    expect(outcome.value.kill_switch).toMatchObject({
      engaged: true,
      reason: "DIVERGENCE_SPIKE",
      frozen_markets: ["0xcond1"],
    });
    expect(outcome.value.open_orders).toHaveLength(1);
    expect(outcome.value.open_orders[0]?.limit_price).toBeCloseTo(0.41);
    expect(outcome.value.positions[0]).toMatchObject({
      token_id: "tok-1",
      mark_value_usd: 12.5,
      mark_stale: true,
    });
    expect(outcome.value.divergences_active).toBe(2);
  });
});

describe("fetchMeasurementReports", () => {
  it("returns an empty report list on garbage", async () => {
    const outcome = await fetchMeasurementReports(
      "t",
      vi.fn().mockResolvedValue(jsonResponse(200, { reports: "x" })),
    );
    expect(outcome).toEqual({ kind: "ok", value: { reports: [] } });
  });

  it("parses categories_json and backtest_json even when sent as strings", async () => {
    const outcome = await fetchMeasurementReports(
      "t",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          reports: [
            {
              report_id: "rep-1",
              generated_at: "2026-08-23T00:00:00.000Z",
              score_version: "v3",
              categories_json: JSON.stringify([
                {
                  category: "politics",
                  resolved: 120,
                  disputed: 2,
                  dispute_rate: 0.0167,
                  dispute_rate_ci: { low: 0.002, high: 0.058 },
                  prior_in_use: "measured",
                  lockup_median_s: 7200,
                },
                { sem_categoria: true },
              ]),
              backtest_json: {
                n_resolved: 25,
                disputed: 4,
                vetoed_disputed: 3,
                coverage: 0.75,
                coverage_ci: { low: 0.194, high: 0.994 },
                clean: 21,
                vetoed_clean: 1,
                false_positive_rate: 0.048,
              },
            },
          ],
        }),
      ),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") {
      return;
    }
    const report = outcome.value.reports[0];
    expect(report?.categories).toHaveLength(1);
    expect(report?.categories[0]).toMatchObject({
      category: "politics",
      dispute_rate_ci: { low: 0.002, high: 0.058 },
      lockup_p95_s: null,
    });
    expect(report?.backtest).toMatchObject({
      n_resolved: 25,
      coverage: 0.75,
      false_positive_ci: null,
    });
  });
});

describe("fetchMarketDetail", () => {
  it("requests the encoded condition id and degrades missing fields", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const outcome = await fetchMarketDetail("0x/estranho", "t", fetcher);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/polymarket/resolution-risk/0x%2Festranho",
    );
    expect(outcome).toEqual({
      kind: "ok",
      value: {
        state: null,
        features: [],
        hard_flags: [],
        justification: null,
        prior_kind: null,
        computed_at: null,
        uma_timeline: [],
        clarifications: [],
      },
    });
  });

  it("parses features, timeline and clarifications", async () => {
    const outcome = await fetchMarketDetail(
      "0xcond1",
      "t",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          state: "SCORED",
          latest_score: {
            features_json: {
              dispute_rate: {
                value: 0.02,
                weight: 0.4,
                contribution: 0.008,
                note: "prior medido",
              },
              lixo: "não é objeto",
            },
            hard_flags_json: ["EARLY_EXPIRATION"],
            justification: "Motivo.",
            prior_kind: "measured",
            computed_at: "2026-08-24T11:57:00.000Z",
          },
          uma_timeline: [
            {
              request_index: 0,
              state: "Proposed",
              result: "YES",
              payouts_json: [1, 0],
              bond: "750",
              source: "chain",
              occurred_at: "2026-08-24T08:00:00.000Z",
            },
          ],
          clarifications: [
            {
              rule_version: "2",
              classification: "material",
              changed_fields_json: '["description"]',
              valid_from: "2026-08-20T00:00:00.000Z",
            },
          ],
        }),
      ),
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") {
      return;
    }
    expect(outcome.value.features).toEqual([
      {
        name: "dispute_rate",
        value: 0.02,
        weight: 0.4,
        contribution: 0.008,
        note: "prior medido",
      },
    ]);
    expect(outcome.value.uma_timeline[0]).toMatchObject({
      request_index: 0,
      bond: 750,
      payouts: "[1,0]",
    });
    expect(outcome.value.clarifications[0]?.changed_fields).toEqual([
      "description",
    ]);
  });
});

describe("fetchGraph", () => {
  it("returns empty node and edge lists on garbage", async () => {
    const outcome = await fetchGraph(
      "t",
      vi.fn().mockResolvedValue(jsonResponse(200, null)),
    );
    expect(outcome).toEqual({ kind: "ok", value: { nodes: [], edges: [] } });
  });
});
