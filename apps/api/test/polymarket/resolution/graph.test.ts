import { describe, expect, it } from "vitest";

import type { QueryResult } from "../../../src/database.js";
import { DEFAULT_RESOLUTION_CONFIG } from "../../../src/polymarket/resolution/config.js";
import { parseCuratedEdges } from "../../../src/polymarket/resolution/curated.js";
import { evaluateGraph } from "../../../src/polymarket/resolution/evaluate.js";
import {
  buildGraph,
  loadActiveEdges,
} from "../../../src/polymarket/resolution/graph.js";
import type { ResolutionPool } from "../../../src/polymarket/resolution/types.js";

type Row = Record<string, unknown>;

const T0 = new Date("2026-08-24T12:00:00.000Z");
const END = new Date("2026-08-25T00:00:00.000Z");

// ---------------------------------------------------------------------------
// buildGraph: an in-memory graph_edges table behind a fake pool that routes
// on the distinctive SQL of every loader the build touches.

interface StoredEdge {
  kind: unknown;
  from: unknown;
  to: unknown;
  eventId: unknown;
  members: unknown;
  origin: unknown;
  confidence: unknown;
  author: unknown;
  justification: unknown;
  params: Record<string, unknown>;
  revoked: boolean;
}

interface EventMemberFixture {
  readonly conditionId: string;
  readonly receivedAt: Date;
  readonly negRisk: boolean | null;
}

function buildPool(
  store: Map<string, StoredEdge>,
  eventMembers: ReadonlyArray<string | EventMemberFixture> = [
    "0xhigh",
    "0xlow",
  ],
  calls: Array<{ text: string; params: readonly unknown[] }> = [],
): ResolutionPool {
  return {
    query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      calls.push({ text, params: [...params] });
      const result = ((): { rows: Row[]; rowCount: number } => {
        if (text.includes("FROM polymarket_universe_log")) {
          const rows = [
            {
              condition_id: "0xhigh",
              metadata_version_id: 1,
              param_version_id: 1,
              question: "Will Bitcoin be above $120,000 on August 25?",
              category: "crypto",
              neg_risk: false,
              clob_token_ids: ["th-yes", "th-no"],
              affirmative_token_id: "th-yes",
              in_universe: true,
            },
            {
              condition_id: "0xlow",
              metadata_version_id: 2,
              param_version_id: 2,
              question: "Will Bitcoin be above $100,000 on August 25?",
              category: "crypto",
              neg_risk: false,
              clob_token_ids: ["tl-yes", "tl-no"],
              affirmative_token_id: "tl-yes",
              in_universe: true,
            },
          ];
          return { rows, rowCount: rows.length };
        }
        if (text.includes("FROM polymarket_event_markets em")) {
          const asOf = params[0] as Date;
          const known = eventMembers.filter(
            (member) => typeof member === "string" || member.receivedAt <= asOf,
          );
          const eligible = known.every(
            (member) => typeof member === "string" || member.negRisk === true,
          );
          const members = known.map((member) =>
            typeof member === "string" ? member : member.conditionId,
          );
          if (!eligible || members.length === 0) {
            return { rows: [], rowCount: 0 };
          }
          return {
            rows: [{ event_id: "ev1", members }],
            rowCount: 1,
          };
        }
        if (text.includes("FROM polymarket_rule_versions")) {
          return {
            rows: [
              {
                version: 1,
                description: "rule text",
                end_date: END,
                valid_from: new Date("2026-08-01T00:00:00.000Z"),
              },
            ],
            rowCount: 1,
          };
        }
        if (text.startsWith("INSERT INTO graph_edges")) {
          const key = params[0] as string;
          const incoming: StoredEdge = {
            kind: params[1],
            from: params[2],
            to: params[3],
            eventId: params[4],
            members: JSON.parse(params[5] as string) as unknown,
            origin: params[6],
            confidence: params[7],
            author: params[8],
            justification: params[9],
            params: JSON.parse(params[10] as string) as Record<string, unknown>,
            revoked: false,
          };
          const existing = store.get(key);
          if (existing === undefined) {
            store.set(key, incoming);
          } else if (existing.params["source"] === "api") {
            store.set(key, existing);
          } else {
            store.set(key, incoming);
          }
          return { rows: [], rowCount: 1 };
        }
        if (
          text.includes("UPDATE graph_edges") &&
          text.includes("revoked_at = CURRENT_TIMESTAMP")
        ) {
          const keep = new Set(params[0] as string[]);
          let revoked = 0;
          for (const [key, edge] of store) {
            if (
              !edge.revoked &&
              !keep.has(key) &&
              edge.params["source"] !== "api"
            ) {
              edge.revoked = true;
              revoked += 1;
            }
          }
          return { rows: [], rowCount: revoked };
        }
        throw new Error(`build pool has no handler for: ${text.slice(0, 60)}`);
      })();
      return Promise.resolve(result as QueryResult<R>);
    },
  };
}

describe("buildGraph", () => {
  const curated = parseCuratedEdges({
    schema_version: 1,
    edges: [
      {
        kind: "IMPLIES",
        from_condition_id: "0xc1",
        to_condition_id: "0xc2",
        author: "henrique",
        justification: "curated pair",
        confidence: 0.9,
      },
    ],
  });

  it("derives the NEGRISK group, the LADDER edge and the curated edge", async () => {
    const store = new Map<string, StoredEdge>();
    const summary = await buildGraph(buildPool(store), curated, T0);
    expect(summary).toEqual({
      nodes: 2,
      structural: 2,
      curated: 1,
      revoked: 0,
    });

    const negrisk = store.get("NEGRISK:event:ev1");
    expect(negrisk).toMatchObject({
      kind: "NEGRISK",
      eventId: "ev1",
      members: ["0xhigh", "0xlow"],
      origin: "structural",
      confidence: "1.000000",
    });

    const ladder = store.get("LADDER:0xhigh->0xlow");
    expect(ladder).toMatchObject({
      kind: "LADDER",
      from: "0xhigh",
      to: "0xlow",
      origin: "structural",
      confidence: "0.800000",
    });
    expect(ladder?.params).toMatchObject({
      family: "threshold",
      source: "structural",
    });

    const file = store.get("IMPLIES:0xc1->0xc2");
    expect(file).toMatchObject({
      kind: "IMPLIES",
      from: "0xc1",
      to: "0xc2",
      origin: "curated",
      author: "henrique",
      confidence: "0.900000",
    });
    expect(file?.params).toMatchObject({ source: "file" });
    expect(store.size).toBe(3);
  });

  it("rebuilding the same world revokes nothing (idempotent keys)", async () => {
    const store = new Map<string, StoredEdge>();
    const pool = buildPool(store);
    await buildGraph(pool, curated, T0);
    const again = await buildGraph(pool, curated, T0);
    expect(again.revoked).toBe(0);
    expect(store.size).toBe(3);
    expect([...store.values()].every((edge) => !edge.revoked)).toBe(true);
  });

  it("keeps the full recorded group membership beyond the live universe", async () => {
    const store = new Map<string, StoredEdge>();
    await buildGraph(
      buildPool(store, ["0xhigh", "0xlow", "0xexited"]),
      curated,
      T0,
    );

    expect(store.get("NEGRISK:event:ev1")?.members).toEqual([
      "0xexited",
      "0xhigh",
      "0xlow",
    ]);
  });

  it("builds structural membership only from facts available as of the cycle", async () => {
    const store = new Map<string, StoredEdge>();
    const calls: Array<{ text: string; params: readonly unknown[] }> = [];
    await buildGraph(
      buildPool(
        store,
        [
          {
            conditionId: "0xhigh",
            receivedAt: new Date(T0.getTime() - 1_000),
            negRisk: true,
          },
          {
            conditionId: "0xlow",
            receivedAt: new Date(T0.getTime() - 1_000),
            negRisk: true,
          },
          {
            conditionId: "0xfuture",
            receivedAt: new Date(T0.getTime() + 1_000),
            negRisk: true,
          },
        ],
        calls,
      ),
      curated,
      T0,
    );

    expect(store.get("NEGRISK:event:ev1")?.members).toEqual([
      "0xhigh",
      "0xlow",
    ]);
    const groupQuery = calls.find((call) =>
      call.text.includes("FROM polymarket_event_markets em"),
    );
    expect(groupQuery?.params).toEqual([T0]);
    expect(groupQuery?.text).toContain("em.received_at <= $1");
    expect(groupQuery?.text).toContain("FROM polymarket_param_versions pv");
    expect(groupQuery?.text).toContain("pv.valid_from <= $1");
    expect(groupQuery?.text).toContain("bool_and(neg_risk_as_of IS TRUE)");
    expect(groupQuery?.text).not.toContain("e.neg_risk");
  });

  it("omits a structural group without versioned negRisk evidence for every member", async () => {
    const store = new Map<string, StoredEdge>();
    await buildGraph(
      buildPool(store, [
        {
          conditionId: "0xhigh",
          receivedAt: new Date(T0.getTime() - 1_000),
          negRisk: true,
        },
        {
          conditionId: "0xlow",
          receivedAt: new Date(T0.getTime() - 1_000),
          negRisk: null,
        },
      ]),
      curated,
      T0,
    );

    expect(store.has("NEGRISK:event:ev1")).toBe(false);
  });

  it("uses current file curation on collision and demotes it when removed", async () => {
    const store = new Map<string, StoredEdge>();
    const colliding = parseCuratedEdges({
      schema_version: 1,
      edges: [
        {
          kind: "LADDER",
          from_condition_id: "0xhigh",
          to_condition_id: "0xlow",
          author: "operator",
          justification: "manually reviewed threshold relationship",
          confidence: 0.95,
          params: { source: "review" },
        },
      ],
    });
    const pool = buildPool(store);

    await buildGraph(pool, colliding, T0);
    expect(store.get("LADDER:0xhigh->0xlow")).toMatchObject({
      origin: "curated",
      confidence: "0.950000",
      author: "operator",
      justification: "manually reviewed threshold relationship",
      params: { source: "file" },
    });

    await buildGraph(pool, [], T0);
    expect(store.get("LADDER:0xhigh->0xlow")).toMatchObject({
      origin: "structural",
      confidence: "0.800000",
      author: null,
      justification: null,
      params: { source: "structural" },
      revoked: false,
    });
  });

  it("leaves an API-curated collision under API ownership", async () => {
    const store = new Map<string, StoredEdge>([
      [
        "LADDER:0xhigh->0xlow",
        {
          kind: "LADDER",
          from: "0xhigh",
          to: "0xlow",
          eventId: null,
          members: [],
          origin: "curated",
          confidence: "0.990000",
          author: "api-operator",
          justification: "explicit API override",
          params: { source: "api" },
          revoked: false,
        },
      ],
    ]);

    const summary = await buildGraph(buildPool(store), [], T0);

    expect(store.get("LADDER:0xhigh->0xlow")).toMatchObject({
      origin: "curated",
      confidence: "0.990000",
      author: "api-operator",
      params: { source: "api" },
      revoked: false,
    });
    expect(summary.structural).toBe(2);
  });

  it("counts a structural/file collision once in the reconciled summary", async () => {
    const store = new Map<string, StoredEdge>();
    const colliding = parseCuratedEdges({
      schema_version: 1,
      edges: [
        {
          kind: "LADDER",
          from_condition_id: "0xhigh",
          to_condition_id: "0xlow",
          author: "operator",
          justification: "current curated override",
          confidence: 0.95,
        },
      ],
    });

    const summary = await buildGraph(buildPool(store), colliding, T0);

    expect(summary).toMatchObject({ structural: 1, curated: 1 });
    expect(store.size).toBe(2);
  });
});

describe("loadActiveEdges", () => {
  it("filters by confidence and parses members", async () => {
    const pool: ResolutionPool = {
      query<R extends Row>(): Promise<QueryResult<R>> {
        const rows: Row[] = [
          {
            edge_id: 1,
            edge_key: "IMPLIES:0xa->0xb",
            kind: "IMPLIES",
            from_condition_id: "0xa",
            to_condition_id: "0xb",
            event_id: null,
            members_json: [],
            confidence: "0.800000",
          },
          {
            edge_id: 2,
            edge_key: "NEGRISK:event:ev1",
            kind: "NEGRISK",
            from_condition_id: null,
            to_condition_id: null,
            event_id: "ev1",
            members_json: ["0xm1", "0xm2"],
            confidence: "0.300000",
          },
        ];
        return Promise.resolve({
          rows,
          rowCount: rows.length,
        } as QueryResult<R>);
      },
    };
    const edges = await loadActiveEdges(pool, 0.5);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      edgeId: 1,
      edgeKey: "IMPLIES:0xa->0xb",
      fromConditionId: "0xa",
      toConditionId: "0xb",
      members: [],
    });
  });
});

// ---------------------------------------------------------------------------
// evaluateGraph: the k-persistence lifecycle over one IMPLIES edge, with an
// in-memory graph_violations table.

interface ViolationRow {
  edgeKey: string;
  snapshots: number;
  suppressed: boolean;
  signalEmitted: boolean;
  ended: boolean;
}

interface EvalWorld {
  edges: Row[];
  states: Row[];
  books: Map<
    string,
    { bids: unknown; asks: unknown; receivedAt: Date; sourceTs?: Date | null }
  >;
  violations: ViolationRow[];
  closes: number;
}

const TOKENS: Record<string, string[]> = {
  "0xa": ["a-yes", "a-no"],
  "0xb": ["b-yes", "b-no"],
  "0xm1": ["m1-yes", "m1-no"],
  "0xm2": ["m2-yes", "m2-no"],
  "0xm3": ["m3-yes", "m3-no"],
};

const EDGE_KEY = "IMPLIES:0xa->0xb";

function emptyEvalWorld(): EvalWorld {
  return {
    edges: [
      {
        edge_id: 1,
        edge_key: EDGE_KEY,
        kind: "IMPLIES",
        from_condition_id: "0xa",
        to_condition_id: "0xb",
        event_id: null,
        members_json: [],
        confidence: "0.800000",
      },
    ],
    states: [],
    books: new Map(),
    violations: [],
    closes: 0,
  };
}

function setBeyond(world: EvalWorld, receivedAt: Date = T0): void {
  world.books.set("a-yes", {
    bids: [{ price: "0.60", size: "10" }],
    asks: [],
    receivedAt,
  });
  world.books.set("b-yes", {
    bids: [],
    asks: [{ price: "0.50", size: "10" }],
    receivedAt,
  });
}

function setInside(world: EvalWorld): void {
  world.books.set("a-yes", {
    bids: [{ price: "0.50", size: "10" }],
    asks: [],
    receivedAt: T0,
  });
  world.books.set("b-yes", {
    bids: [],
    asks: [{ price: "0.505", size: "10" }],
    receivedAt: T0,
  });
}

function evalPool(world: EvalWorld): ResolutionPool {
  return {
    query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      const result = ((): { rows: Row[]; rowCount: number } => {
        if (text.includes("FROM graph_edges")) {
          return {
            rows: world.edges,
            rowCount: world.edges.length,
          };
        }
        if (text.includes("FROM resolution_market_state")) {
          return { rows: world.states, rowCount: world.states.length };
        }
        if (text.includes("FROM polymarket_market_metadata_versions")) {
          const tokens = TOKENS[params[0] as string];
          return {
            rows:
              tokens === undefined
                ? []
                : [
                    {
                      metadata_version_id: "1",
                      clob_token_ids: tokens,
                      affirmative_token_id: tokens[0],
                    },
                  ],
            rowCount: tokens === undefined ? 0 : 1,
          };
        }
        if (text.includes("FROM polymarket_param_versions")) {
          return {
            rows: [{ taker_fee_bps: "0", tick_size: "0.01", neg_risk: false }],
            rowCount: 1,
          };
        }
        if (text.includes("FROM polymarket_book_snapshots")) {
          const book = world.books.get(params[0] as string);
          if (book === undefined) {
            return { rows: [], rowCount: 0 };
          }
          return {
            rows: [
              {
                bids_json: book.bids,
                asks_json: book.asks,
                source_ts: book.sourceTs ?? null,
                received_at: book.receivedAt,
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes("snapshots_count = snapshots_count + 1")) {
          const open = world.violations.find(
            (violation) =>
              violation.edgeKey === (params[0] as string) && !violation.ended,
          );
          if (open === undefined) {
            return { rows: [], rowCount: 0 };
          }
          open.snapshots += 1;
          const suppressed = params[6] === true;
          open.suppressed = suppressed;
          open.signalEmitted = open.signalEmitted || !suppressed;
          return { rows: [], rowCount: 1 };
        }
        if (text.startsWith("INSERT INTO graph_violations")) {
          world.violations.push({
            edgeKey: params[1] as string,
            snapshots: params[4] as number,
            suppressed: params[10] as boolean,
            signalEmitted: params[11] as boolean,
            ended: false,
          });
          return { rows: [], rowCount: 1 };
        }
        if (
          text.includes("UPDATE graph_violations") &&
          text.includes("edge_key = ANY($1::text[])")
        ) {
          const active = new Set(params[0] as string[]);
          let closed = 0;
          for (const violation of world.violations) {
            if (!active.has(violation.edgeKey) && !violation.ended) {
              violation.ended = true;
              closed += 1;
            }
          }
          return { rows: [], rowCount: closed };
        }
        if (
          text.includes("UPDATE graph_violations") &&
          text.includes("SET ended_at = $2")
        ) {
          world.closes += 1;
          let closed = 0;
          for (const violation of world.violations) {
            if (
              violation.edgeKey === (params[0] as string) &&
              !violation.ended
            ) {
              violation.ended = true;
              closed += 1;
            }
          }
          return { rows: [], rowCount: closed };
        }
        throw new Error(`eval pool has no handler for: ${text.slice(0, 60)}`);
      })();
      return Promise.resolve(result as QueryResult<R>);
    },
  };
}

describe("evaluateGraph k-persistence", () => {
  const config = DEFAULT_RESOLUTION_CONFIG; // persistence_k = 3

  it("opens after exactly k consecutive breaches, refreshes, closes, and needs k again", async () => {
    const world = emptyEvalWorld();
    const pool = evalPool(world);
    const streaks = new Map<string, number>();
    setBeyond(world);

    const first = await evaluateGraph(pool, config, streaks, T0);
    expect(first).toMatchObject({ checked: 1, beyond: 1, opened: 0 });
    expect(world.violations).toHaveLength(0);

    const second = await evaluateGraph(pool, config, streaks, T0);
    expect(second.opened).toBe(0);
    expect(world.violations).toHaveLength(0);

    const third = await evaluateGraph(pool, config, streaks, T0);
    expect(third.opened).toBe(1);
    expect(world.violations).toHaveLength(1);
    expect(world.violations[0]).toEqual({
      edgeKey: EDGE_KEY,
      snapshots: 3,
      suppressed: false,
      signalEmitted: true,
      ended: false,
    });

    // A fourth breach refreshes the open row, never inserts a second one.
    const fourth = await evaluateGraph(pool, config, streaks, T0);
    expect(fourth.opened).toBe(0);
    expect(world.violations).toHaveLength(1);
    expect(world.violations[0]?.snapshots).toBe(4);

    // Back inside the band: the violation closes and the streak resets.
    setInside(world);
    const fifth = await evaluateGraph(pool, config, streaks, T0);
    expect(fifth.closed).toBe(1);
    expect(world.closes).toBeGreaterThan(0);
    expect(world.violations[0]?.ended).toBe(true);
    expect(streaks.get(EDGE_KEY)).toBe(0);

    // Reopening demands k fresh consecutive breaches.
    setBeyond(world);
    await evaluateGraph(pool, config, streaks, T0);
    await evaluateGraph(pool, config, streaks, T0);
    expect(world.violations).toHaveLength(1);
    const reopened = await evaluateGraph(pool, config, streaks, T0);
    expect(reopened.opened).toBe(1);
    expect(world.violations).toHaveLength(2);
    expect(world.violations[1]).toMatchObject({
      snapshots: 3,
      suppressed: false,
      signalEmitted: true,
    });
  });

  it("a VETOed market opens suppressed, with no signal", async () => {
    const world = emptyEvalWorld();
    world.states = [{ condition_id: "0xa", effective_action: "VETO" }];
    const pool = evalPool(world);
    const streaks = new Map<string, number>();
    setBeyond(world);

    await evaluateGraph(pool, config, streaks, T0);
    await evaluateGraph(pool, config, streaks, T0);
    const third = await evaluateGraph(pool, config, streaks, T0);
    expect(third).toMatchObject({ opened: 1, suppressed: 1 });
    expect(world.violations[0]).toMatchObject({
      suppressed: true,
      signalEmitted: false,
    });
  });

  it("a stale book skips the edge and resets the streak", async () => {
    const world = emptyEvalWorld();
    const pool = evalPool(world);
    const streaks = new Map<string, number>();

    setBeyond(world);
    const first = await evaluateGraph(pool, config, streaks, T0);
    expect(first.beyond).toBe(1);
    expect(streaks.get(EDGE_KEY)).toBe(1);

    // Books 10 minutes older than asOf (maxBookAgeMs default 90s): skipped.
    setBeyond(world, new Date(T0.getTime() - 600_000));
    const second = await evaluateGraph(pool, config, streaks, T0);
    expect(second).toMatchObject({ skipped: 1, beyond: 0 });
    expect(streaks.get(EDGE_KEY)).toBe(0);

    setBeyond(world);
    const third = await evaluateGraph(pool, config, streaks, T0);
    expect(third).toMatchObject({ beyond: 1, opened: 0 });
    expect(streaks.get(EDGE_KEY)).toBe(1);
    expect(world.violations).toHaveLength(0);
  });

  it("rejects a future source timestamp instead of treating it as fresh", async () => {
    const world = emptyEvalWorld();
    const pool = evalPool(world);
    const streaks = new Map<string, number>();
    setBeyond(world);
    const future = new Date(T0.getTime() + 1);
    const a = world.books.get("a-yes");
    if (a !== undefined) {
      a.sourceTs = future;
    }

    const summary = await evaluateGraph(pool, config, streaks, T0);

    expect(summary).toMatchObject({ checked: 1, skipped: 1, beyond: 0 });
    expect(streaks.get(EDGE_KEY)).toBe(0);
  });

  it("closes an open violation and clears its streak when the edge disappears", async () => {
    const world = emptyEvalWorld();
    const pool = evalPool(world);
    const streaks = new Map<string, number>();
    setBeyond(world);
    await evaluateGraph(pool, config, streaks, T0);
    await evaluateGraph(pool, config, streaks, T0);
    await evaluateGraph(pool, config, streaks, T0);
    expect(world.violations[0]?.ended).toBe(false);

    world.edges = [];
    const summary = await evaluateGraph(pool, config, streaks, T0);

    expect(summary).toMatchObject({ checked: 0, closed: 1 });
    expect(world.violations[0]?.ended).toBe(true);
    expect(streaks.has(EDGE_KEY)).toBe(false);
  });

  it("does not close an open group violation when a stale member makes the subset inconclusive", async () => {
    const world = emptyEvalWorld();
    const groupKey = "NEGRISK:event:ev1";
    world.edges = [
      {
        edge_id: 2,
        edge_key: groupKey,
        kind: "NEGRISK",
        from_condition_id: null,
        to_condition_id: null,
        event_id: "ev1",
        members_json: ["0xm1", "0xm2", "0xm3"],
        confidence: "1.000000",
      },
    ];
    world.books.set("m1-yes", {
      bids: [{ price: "0.40", size: "10" }],
      asks: [{ price: "0.45", size: "10" }],
      receivedAt: T0,
    });
    world.books.set("m2-yes", {
      bids: [{ price: "0.35", size: "10" }],
      asks: [{ price: "0.40", size: "10" }],
      receivedAt: T0,
    });
    world.books.set("m3-yes", {
      bids: [{ price: "0.30", size: "10" }],
      asks: [{ price: "0.35", size: "10" }],
      receivedAt: T0,
    });
    const pool = evalPool(world);
    const streaks = new Map<string, number>();

    await evaluateGraph(pool, config, streaks, T0);
    await evaluateGraph(pool, config, streaks, T0);
    const opened = await evaluateGraph(pool, config, streaks, T0);
    expect(opened.opened).toBe(1);
    expect(world.violations[0]?.ended).toBe(false);

    world.books.delete("m3-yes");
    const inconclusive = await evaluateGraph(pool, config, streaks, T0);
    expect(inconclusive).toMatchObject({ skipped: 1, closed: 0 });
    expect(world.violations[0]?.ended).toBe(false);
    expect(streaks.get(groupKey)).toBe(0);
  });
});
