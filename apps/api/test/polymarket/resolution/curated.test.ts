import { describe, expect, it } from "vitest";

import {
  GRAPH_EDGES_FILE_ENV,
  GraphEdgesConfigError,
  loadCuratedEdges,
  parseCuratedEdges,
} from "../../../src/polymarket/resolution/curated.js";

// ---------------------------------------------------------------------------
// RFC-012 task 11(b): curated edges are versioned, attributed and fail-closed.
// Anything the parser is not certain about is refused, never defaulted.

const SHIPPED = new URL(
  "../../../../../config/graph-edges.json",
  import.meta.url,
).pathname;

function pairEdge(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema_version: 1,
    edges: [
      {
        kind: "IMPLIES",
        from_condition_id: "0xa",
        to_condition_id: "0xb",
        author: "henrique",
        justification: "a resolving YES forces b to resolve YES",
        ...overrides,
      },
    ],
  };
}

describe("parseCuratedEdges", () => {
  it("parses a valid pair edge with the default confidence", () => {
    const edges = parseCuratedEdges(pairEdge());
    expect(edges).toEqual([
      {
        kind: "IMPLIES",
        fromConditionId: "0xa",
        toConditionId: "0xb",
        members: [],
        author: "henrique",
        justification: "a resolving YES forces b to resolve YES",
        confidence: "1.000000",
        params: {},
      },
    ]);
  });

  it("formats an explicit confidence to six digits", () => {
    const edges = parseCuratedEdges(pairEdge({ confidence: 0.9 }));
    expect(edges[0]?.confidence).toBe("0.900000");
  });

  it("parses a group edge and sorts its members", () => {
    const edges = parseCuratedEdges({
      schema_version: 1,
      edges: [
        {
          kind: "MUTEX",
          members: ["0xb", "0xa"],
          author: "henrique",
          justification: "at most one candidate wins",
        },
      ],
    });
    expect(edges[0]).toMatchObject({
      kind: "MUTEX",
      fromConditionId: null,
      toConditionId: null,
      members: ["0xa", "0xb"],
      confidence: "1.000000",
    });
  });

  it("fails closed on a missing author", () => {
    expect(() =>
      parseCuratedEdges(pairEdge({ author: undefined })),
    ).toThrowError(GraphEdgesConfigError);
  });

  it("fails closed on a missing justification", () => {
    expect(() =>
      parseCuratedEdges(pairEdge({ justification: undefined })),
    ).toThrowError(GraphEdgesConfigError);
  });

  it("fails closed on an unknown key", () => {
    expect(() => parseCuratedEdges(pairEdge({ nope: 1 }))).toThrowError(
      /nope is not allowed/,
    );
    expect(() =>
      parseCuratedEdges({ schema_version: 1, edges: [], extra: true }),
    ).toThrowError(/extra is not allowed/);
  });

  it("fails closed on an invalid kind", () => {
    expect(() => parseCuratedEdges(pairEdge({ kind: "CAUSES" }))).toThrowError(
      /kind is not a valid kind/,
    );
  });

  it("fails closed on a pair edge carrying members", () => {
    expect(() =>
      parseCuratedEdges(pairEdge({ members: ["0xc", "0xd"] })),
    ).toThrowError(/members is only for group kinds/);
  });

  it("fails closed on a group edge carrying from/to", () => {
    expect(() =>
      parseCuratedEdges({
        schema_version: 1,
        edges: [
          {
            kind: "MUTEX",
            members: ["0xa", "0xb"],
            from_condition_id: "0xa",
            author: "henrique",
            justification: "j",
          },
        ],
      }),
    ).toThrowError(/from\/to are only for pair kinds/);
  });

  it("fails closed on duplicate members", () => {
    expect(() =>
      parseCuratedEdges({
        schema_version: 1,
        edges: [
          {
            kind: "MUTEX",
            members: ["0xa", "0xa"],
            author: "henrique",
            justification: "j",
          },
        ],
      }),
    ).toThrowError(/members has duplicates/);
  });

  it("fails closed on a single-member group", () => {
    expect(() =>
      parseCuratedEdges({
        schema_version: 1,
        edges: [
          {
            kind: "NEGRISK",
            members: ["0xa"],
            author: "henrique",
            justification: "j",
          },
        ],
      }),
    ).toThrowError(/must list at least two markets/);
  });

  it("fails closed on out-of-range confidence", () => {
    expect(() => parseCuratedEdges(pairEdge({ confidence: 0 }))).toThrowError(
      GraphEdgesConfigError,
    );
    expect(() => parseCuratedEdges(pairEdge({ confidence: 1.5 }))).toThrowError(
      GraphEdgesConfigError,
    );
  });

  it("fails closed on an unsupported schema version", () => {
    expect(() =>
      parseCuratedEdges({ schema_version: 2, edges: [] }),
    ).toThrowError(/schema_version must be 1/);
  });

  it("fails closed on a self-implication", () => {
    expect(() =>
      parseCuratedEdges(pairEdge({ to_condition_id: "0xa" })),
    ).toThrowError(/relates a market to itself/);
  });
});

describe("loadCuratedEdges", () => {
  it("returns no edges when the env var is unset", async () => {
    await expect(loadCuratedEdges({ env: {} })).resolves.toEqual([]);
  });

  it("fails closed on an unreadable file", async () => {
    await expect(
      loadCuratedEdges({
        env: { [GRAPH_EDGES_FILE_ENV]: "/nope/graph-edges.json" },
        readTextFile: () => Promise.reject(new Error("ENOENT")),
      }),
    ).rejects.toMatchObject({ reasonCode: "GRAPH_EDGES_FILE_UNREADABLE" });
  });

  it("fails closed on invalid JSON", async () => {
    await expect(
      loadCuratedEdges({
        env: { [GRAPH_EDGES_FILE_ENV]: "/some/graph-edges.json" },
        readTextFile: () => Promise.resolve("{ not json"),
      }),
    ).rejects.toMatchObject({ reasonCode: "GRAPH_EDGES_FILE_INVALID_JSON" });
  });

  it("the shipped repo file parses to an empty edge set", async () => {
    await expect(
      loadCuratedEdges({ env: { [GRAPH_EDGES_FILE_ENV]: SHIPPED } }),
    ).resolves.toEqual([]);
  });
});
