import { describe, expect, it } from "vitest";

import type { QueryResult, SqlExecutor } from "../../../src/database.js";
import {
  formatScaled,
  parseScaled,
} from "../../../src/polymarket/fundamental/fixed.js";
import { DEFAULT_RESOLUTION_CONFIG } from "../../../src/polymarket/resolution/config.js";
import {
  toScaledLevels,
  type MarketLeg,
} from "../../../src/polymarket/resolution/evaluate.js";
import type { ActiveEdge } from "../../../src/polymarket/resolution/graph.js";
import {
  groupSanityFindings,
  pairSanityFindings,
  sanityCheck,
} from "../../../src/polymarket/resolution/sanity.js";
import type { FreshModelEstimate } from "../../../src/polymarket/resolution/store.js";

type Row = Record<string, unknown>;
type LevelInput = ReadonlyArray<{ price: string; size: string }>;

function scaled(value: string): bigint {
  const parsed = parseScaled(value);
  if (parsed === null) {
    throw new Error(`unparseable scaled value: ${value}`);
  }
  return parsed;
}

const EPSILON = scaled("0.005");

function leg(
  conditionId: string,
  tokenId: string,
  bids: LevelInput,
  asks: LevelInput,
  feeRate = "0",
): MarketLeg {
  return {
    conditionId,
    tokenId,
    books: { bids: toScaledLevels(bids), asks: toScaledLevels(asks) },
    feeRate: scaled(feeRate),
  };
}

function estimate(tokenId: string, q: string): FreshModelEstimate {
  return {
    tokenId,
    conditionId: null,
    q,
    modelId: "m@1",
    status: "shadow",
    decisionTs: new Date(),
  };
}

function estimatesOf(
  ...items: FreshModelEstimate[]
): Map<string, FreshModelEstimate> {
  return new Map(items.map((item) => [item.tokenId, item]));
}

function pairEdge(kind: "IMPLIES" | "EQUIV"): ActiveEdge {
  return {
    edgeId: 1,
    edgeKey: `${kind}:A->B`,
    kind,
    fromConditionId: "A",
    toConditionId: "B",
    eventId: null,
    members: [],
    confidence: "0.900000",
  };
}

function groupEdge(members: readonly string[]): ActiveEdge {
  return {
    edgeId: 2,
    edgeKey: "NEGRISK:event:evt-1",
    kind: "NEGRISK",
    fromConditionId: null,
    toConditionId: null,
    eventId: "evt-1",
    members,
    confidence: "1.000000",
  };
}

function level(price: string): LevelInput {
  return [{ price, size: "100" }];
}

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  const item = items[0];
  if (item === undefined) {
    throw new Error("expected exactly one finding");
  }
  return item;
}

describe("pairSanityFindings", () => {
  it("opens q_gt_ask when q(from) exceeds ask(to) beyond epsilon plus fee", () => {
    // fee = 0.07 x 0.50 x 0.50 = 0.0175; tolerance = 0.005 + 0.0175 = 0.0225.
    const from = leg("A", "tokA", [], []);
    const to = leg("B", "tokB", [], level("0.50"), "0.07");
    const found = pairSanityFindings(
      pairEdge("IMPLIES"),
      from,
      to,
      estimatesOf(estimate("tokA", "0.550000")),
      EPSILON,
    );
    const finding = only(found);
    expect(finding.detail["check"]).toBe("q_gt_ask");
    expect(finding.conditionId).toBe("A");
    expect(finding.tokenId).toBe("tokA");
    expect(finding.neighborConditionId).toBe("B");
    expect(finding.neighborPrice).toBe(scaled("0.50"));
    expect(formatScaled(finding.tolerance, 6)).toBe("0.022500");
    expect(formatScaled(finding.magnitude, 6)).toBe("0.050000");
  });

  it("stays silent when q(from) sits inside the ask band", () => {
    // 0.52 <= 0.50 + 0.0225: inside the cost band, nothing to veto.
    const from = leg("A", "tokA", [], []);
    const to = leg("B", "tokB", [], level("0.50"), "0.07");
    const found = pairSanityFindings(
      pairEdge("IMPLIES"),
      from,
      to,
      estimatesOf(estimate("tokA", "0.520000")),
      EPSILON,
    );
    expect(found).toHaveLength(0);
  });

  it("opens q_lt_bid when q(to) sits below bid(from) beyond the band", () => {
    // fee 0: tolerance = 0.005; 0.55 < 0.60 - 0.005.
    const from = leg("A", "tokA", level("0.60"), []);
    const to = leg("B", "tokB", [], []);
    const found = pairSanityFindings(
      pairEdge("IMPLIES"),
      from,
      to,
      estimatesOf(estimate("tokB", "0.550000")),
      EPSILON,
    );
    const finding = only(found);
    expect(finding.detail["check"]).toBe("q_lt_bid");
    expect(finding.conditionId).toBe("B");
    expect(finding.tokenId).toBe("tokB");
    expect(finding.neighborConditionId).toBe("A");
    expect(finding.neighborPrice).toBe(scaled("0.60"));
    expect(formatScaled(finding.tolerance, 6)).toBe("0.005000");
    expect(formatScaled(finding.magnitude, 6)).toBe("0.050000");
  });

  it("stays silent when q(to) sits inside the bid band", () => {
    // 0.596 >= 0.60 - 0.005: inside the band.
    const from = leg("A", "tokA", level("0.60"), []);
    const to = leg("B", "tokB", [], []);
    const found = pairSanityFindings(
      pairEdge("IMPLIES"),
      from,
      to,
      estimatesOf(estimate("tokB", "0.596000")),
      EPSILON,
    );
    expect(found).toHaveLength(0);
  });

  it("runs the mirrored q_gt_ask check for EQUIV edges only", () => {
    // Only q(B) is present and only A has an ask: the finding can only come
    // from the EQUIV mirror. 0.56 > 0.50 + 0.005.
    const from = leg("A", "tokA", [], level("0.50"));
    const to = leg("B", "tokB", [], []);
    const estimates = estimatesOf(estimate("tokB", "0.560000"));

    const equiv = pairSanityFindings(
      pairEdge("EQUIV"),
      from,
      to,
      estimates,
      EPSILON,
    );
    const finding = only(equiv);
    expect(finding.detail["check"]).toBe("q_gt_ask");
    expect(finding.tokenId).toBe("tokB");
    expect(finding.neighborConditionId).toBe("A");
    expect(finding.neighborPrice).toBe(scaled("0.50"));
    expect(formatScaled(finding.magnitude, 6)).toBe("0.060000");

    const implies = pairSanityFindings(
      pairEdge("IMPLIES"),
      from,
      to,
      estimates,
      EPSILON,
    );
    expect(implies).toHaveLength(0);
  });

  it("treats a missing estimate as an absence: nothing to veto", () => {
    const from = leg("A", "tokA", level("0.60"), level("0.70"));
    const to = leg("B", "tokB", level("0.10"), level("0.20"));
    const found = pairSanityFindings(
      pairEdge("EQUIV"),
      from,
      to,
      estimatesOf(),
      EPSILON,
    );
    expect(found).toHaveLength(0);
  });

  it("skips a check whose book side is empty even with the estimate present", () => {
    // q(A) grossly high, but B has no asks: the q_gt_ask check has no
    // executable price to compare against.
    const from = leg("A", "tokA", [], []);
    const to = leg("B", "tokB", [], []);
    const found = pairSanityFindings(
      pairEdge("IMPLIES"),
      from,
      to,
      estimatesOf(estimate("tokA", "0.990000")),
      EPSILON,
    );
    expect(found).toHaveLength(0);
  });
});

describe("groupSanityFindings", () => {
  it("opens q_gt_group_ceiling when q exceeds 1 minus the others' bids", () => {
    // ceiling = 1 - (0.40 + 0.45) = 0.15; tolerance = 0.005 (fees 0);
    // 0.20 > 0.155 with magnitude 0.20 - 0.15 = 0.05.
    const legs = [
      leg("C1", "tok1", [], []),
      leg("C2", "tok2", level("0.40"), []),
      leg("C3", "tok3", level("0.45"), []),
    ];
    const found = groupSanityFindings(
      groupEdge(["C1", "C2", "C3"]),
      legs,
      estimatesOf(estimate("tok1", "0.200000")),
      EPSILON,
    );
    const finding = only(found);
    expect(finding.detail["check"]).toBe("q_gt_group_ceiling");
    expect(finding.conditionId).toBe("C1");
    expect(finding.tokenId).toBe("tok1");
    expect(finding.neighborConditionId).toBeNull();
    expect(finding.neighborPrice).toBe(scaled("0.85"));
    expect(formatScaled(finding.tolerance, 6)).toBe("0.005000");
    expect(formatScaled(finding.magnitude, 6)).toBe("0.050000");
    expect(finding.detail["members"]).toBe(3);
  });

  it("stays silent when q sits at the ceiling", () => {
    const legs = [
      leg("C1", "tok1", [], []),
      leg("C2", "tok2", level("0.40"), []),
      leg("C3", "tok3", level("0.45"), []),
    ];
    const found = groupSanityFindings(
      groupEdge(["C1", "C2", "C3"]),
      legs,
      estimatesOf(estimate("tok1", "0.150000")),
      EPSILON,
    );
    expect(found).toHaveLength(0);
  });

  it("skips a member when any other member has no executable bid", () => {
    // C3 is unpriced: the ceiling against C1 cannot be computed, so C1 is
    // skipped even though its q would violate a partial sum.
    const legs = [
      leg("C1", "tok1", [], []),
      leg("C2", "tok2", level("0.40"), []),
      leg("C3", "tok3", [], []),
    ];
    const found = groupSanityFindings(
      groupEdge(["C1", "C2", "C3"]),
      legs,
      estimatesOf(estimate("tok1", "0.990000")),
      EPSILON,
    );
    expect(found).toHaveLength(0);
  });
});

// --- sanityCheck DB lifecycle -----------------------------------------------

const ASOF = new Date("2026-08-24T12:00:00.000Z");

interface VetoRow {
  veto_id: number;
  token_id: string;
  edge_key: string;
  ended_at: Date | null;
}

interface SanityWorld {
  pool: SqlExecutor;
  calls: Array<{ text: string; params: readonly unknown[] }>;
  state: { estimateRows: Row[]; vetoes: VetoRow[] };
}

/**
 * Fake pool for one IMPLIES(A -> B) edge: B sells at ask 0.50 (fee 0), and
 * the fundamental_estimates rows are the mutable part of the world. Vetoes
 * live in a tiny in-memory table so the open/refresh/close lifecycle is real.
 */
function createSanityWorld(): SanityWorld {
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  const state: SanityWorld["state"] = { estimateRows: [], vetoes: [] };
  let nextVetoId = 1;
  const pool: SqlExecutor = {
    query<R extends Row>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      const captured = [...(params ?? [])];
      calls.push({ text, params: captured });
      const respond = (rows: Row[]): Promise<QueryResult<R>> =>
        Promise.resolve({ rows: rows as R[], rowCount: rows.length });

      if (text.includes("FROM graph_edges")) {
        return respond([
          {
            edge_id: 7,
            edge_key: "IMPLIES:A->B",
            kind: "IMPLIES",
            from_condition_id: "A",
            to_condition_id: "B",
            event_id: null,
            members_json: [],
            confidence: "0.900000",
          },
        ]);
      }
      if (text.includes("FROM polymarket_markets")) {
        const conditionId = String(captured[0]);
        return respond([
          {
            clob_token_ids:
              conditionId === "A" ? ["tokA", "tokA-no"] : ["tokB", "tokB-no"],
          },
        ]);
      }
      if (text.includes("FROM polymarket_param_versions")) {
        return respond([
          { taker_fee_bps: "0", tick_size: "0.01", neg_risk: false },
        ]);
      }
      if (text.includes("FROM polymarket_book_snapshots")) {
        const tokenId = String(captured[0]);
        return respond([
          {
            bids_json: [],
            asks_json:
              tokenId === "tokB" ? [{ price: "0.50", size: "100" }] : [],
            source_ts: ASOF,
            received_at: ASOF,
          },
        ]);
      }
      if (text.includes("FROM fundamental_estimates")) {
        return respond(state.estimateRows);
      }
      if (
        text.includes("UPDATE graph_sanity_vetoes") &&
        text.includes("SET last_seen_at")
      ) {
        const tokenId = String(captured[0]);
        const edgeKey = String(captured[1]);
        const row = state.vetoes.find(
          (veto) =>
            veto.token_id === tokenId &&
            veto.edge_key === edgeKey &&
            veto.ended_at === null,
        );
        return respond(row === undefined ? [] : [{}]);
      }
      if (text.includes("INSERT INTO graph_sanity_vetoes")) {
        state.vetoes.push({
          veto_id: nextVetoId,
          token_id: String(captured[1]),
          edge_key: String(captured[6]),
          ended_at: null,
        });
        nextVetoId += 1;
        return respond([]);
      }
      if (text.includes("SELECT veto_id")) {
        return respond(
          state.vetoes
            .filter((veto) => veto.ended_at === null)
            .map((veto) => ({
              veto_id: veto.veto_id,
              token_id: veto.token_id,
              edge_key: veto.edge_key,
            })),
        );
      }
      if (
        text.includes("UPDATE graph_sanity_vetoes") &&
        text.includes("SET ended_at")
      ) {
        const vetoId = Number(captured[0]);
        const row = state.vetoes.find((veto) => veto.veto_id === vetoId);
        if (row !== undefined) {
          row.ended_at = captured[1] as Date;
        }
        return respond([{}]);
      }
      throw new Error(`unrouted query: ${text}`);
    },
  };
  return { pool, calls, state };
}

function violatingEstimateRow(): Row {
  return {
    token_id: "tokA",
    market_id: "A",
    q: "0.550000",
    model_id: "m@1",
    status: "shadow",
    decision_ts: ASOF,
  };
}

describe("sanityCheck lifecycle", () => {
  it("opens on violation, refreshes while it holds, closes when the estimate goes stale", async () => {
    const world = createSanityWorld();
    world.state.estimateRows = [violatingEstimateRow()];

    // First cycle: no open row yet, so the UPDATE misses and an INSERT opens.
    const first = await sanityCheck(
      world.pool,
      DEFAULT_RESOLUTION_CONFIG,
      ASOF,
    );
    expect(first).toEqual({ checked: 1, active: 1, opened: 1, closed: 0 });
    const insert = world.calls.find((call) =>
      call.text.includes("INSERT INTO graph_sanity_vetoes"),
    );
    expect(insert).toBeDefined();
    expect(insert?.params[0]).toBe("A"); // condition_id
    expect(insert?.params[1]).toBe("tokA"); // token_id
    expect(insert?.params[4]).toBe("0.550000"); // q
    expect(insert?.params[7]).toBe("IMPLIES"); // kind
    expect(insert?.params[8]).toBe("B"); // neighbor_condition_id
    expect(insert?.params[9]).toBe("0.500000"); // neighbor_price = ask(B)
    expect(insert?.params[10]).toBe("0.005000"); // tolerance = epsilon, fee 0
    expect(insert?.params[11]).toBe("0.050000"); // magnitude = 0.55 - 0.50

    // Second cycle, same world: the open row is refreshed, nothing new opens.
    const second = await sanityCheck(
      world.pool,
      DEFAULT_RESOLUTION_CONFIG,
      ASOF,
    );
    expect(second).toEqual({ checked: 1, active: 1, opened: 0, closed: 0 });
    expect(world.state.vetoes).toHaveLength(1);

    // Third cycle: the estimate is gone (stale = absence), the row closes.
    world.state.estimateRows = [];
    const third = await sanityCheck(
      world.pool,
      DEFAULT_RESOLUTION_CONFIG,
      ASOF,
    );
    expect(third).toEqual({ checked: 1, active: 0, opened: 0, closed: 1 });
    expect(world.state.vetoes[0]?.ended_at).toEqual(ASOF);
  });

  it("loads only fresh MODEL estimates: source filter and both decision_ts bounds", async () => {
    const world = createSanityWorld();
    world.state.estimateRows = [violatingEstimateRow()];
    await sanityCheck(world.pool, DEFAULT_RESOLUTION_CONFIG, ASOF);

    const call = world.calls.find((entry) =>
      entry.text.includes("FROM fundamental_estimates"),
    );
    expect(call).toBeDefined();
    expect(call?.text).toContain("source = 'MODEL'");
    expect(call?.text).toContain("decision_ts >= $2");
    expect(call?.text).toContain("decision_ts <= $3");
    expect(call?.params[0]).toEqual(expect.arrayContaining(["tokA", "tokB"]));
    expect(call?.params[1]).toEqual(new Date(ASOF.getTime() - 5 * 60_000));
    expect(call?.params[2]).toEqual(ASOF);
  });
});
