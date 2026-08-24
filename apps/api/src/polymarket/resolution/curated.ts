// RFC-012 task 11(b): curated graph edges, versioned in the repo. Every
// curated edge records its author and justification — the file is refused
// without them. The same fail-closed loader pattern as every module config.

import { readFile } from "node:fs/promises";

import type { GraphEdgeKind } from "./types.js";

export const GRAPH_EDGES_FILE_ENV = "GANSO_GRAPH_EDGES_FILE";

export class GraphEdgesConfigError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "GraphEdgesConfigError";
    this.reasonCode = reasonCode;
  }
}

export interface CuratedEdge {
  readonly kind: GraphEdgeKind;
  readonly fromConditionId: string | null;
  readonly toConditionId: string | null;
  readonly members: readonly string[];
  readonly author: string;
  readonly justification: string;
  readonly confidence: string;
  readonly params: Readonly<Record<string, unknown>>;
}

const PAIR_KINDS: ReadonlySet<string> = new Set(["IMPLIES", "EQUIV", "LADDER"]);
const GROUP_KINDS: ReadonlySet<string> = new Set(["MUTEX", "NEGRISK"]);

function fail(reasonCode: string, message: string): never {
  throw new GraphEdgesConfigError(reasonCode, message);
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("GRAPH_EDGES_FIELD_INVALID", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("GRAPH_EDGES_FIELD_INVALID", `${field} must be a non-empty string`);
  }
  return value;
}

export function parseCuratedEdges(raw: unknown): CuratedEdge[] {
  const root = asObject(raw, "graph_edges");
  const allowed = new Set(["schema_version", "edges"]);
  for (const key of Object.keys(root)) {
    if (!allowed.has(key)) {
      fail("GRAPH_EDGES_FIELD_UNKNOWN", `graph_edges.${key} is not allowed`);
    }
  }
  if (root.schema_version !== 1) {
    fail("GRAPH_EDGES_SCHEMA_UNSUPPORTED", "schema_version must be 1");
  }
  if (!Array.isArray(root.edges)) {
    fail("GRAPH_EDGES_FIELD_INVALID", "graph_edges.edges must be an array");
  }
  const edges: CuratedEdge[] = [];
  root.edges.forEach((entry, index) => {
    const field = `graph_edges.edges[${index}]`;
    const object = asObject(entry, field);
    const allowedKeys = new Set([
      "kind",
      "from_condition_id",
      "to_condition_id",
      "members",
      "author",
      "justification",
      "confidence",
      "params",
    ]);
    for (const key of Object.keys(object)) {
      if (!allowedKeys.has(key)) {
        fail("GRAPH_EDGES_FIELD_UNKNOWN", `${field}.${key} is not allowed`);
      }
    }
    const kind = asNonEmptyString(object.kind, `${field}.kind`);
    if (!PAIR_KINDS.has(kind) && !GROUP_KINDS.has(kind)) {
      fail("GRAPH_EDGES_FIELD_INVALID", `${field}.kind is not a valid kind`);
    }
    const author = asNonEmptyString(object.author, `${field}.author`);
    const justification = asNonEmptyString(
      object.justification,
      `${field}.justification`,
    );
    let confidence = "1.000000";
    if (object.confidence !== undefined) {
      if (
        typeof object.confidence !== "number" ||
        !Number.isFinite(object.confidence) ||
        object.confidence <= 0 ||
        object.confidence > 1
      ) {
        fail(
          "GRAPH_EDGES_FIELD_INVALID",
          `${field}.confidence must be a number in (0, 1]`,
        );
      }
      confidence = object.confidence.toFixed(6);
    }
    const params =
      object.params === undefined
        ? {}
        : asObject(object.params, `${field}.params`);

    if (PAIR_KINDS.has(kind)) {
      const from = asNonEmptyString(
        object.from_condition_id,
        `${field}.from_condition_id`,
      );
      const to = asNonEmptyString(
        object.to_condition_id,
        `${field}.to_condition_id`,
      );
      if (from === to) {
        fail(
          "GRAPH_EDGES_FIELD_INVALID",
          `${field} relates a market to itself`,
        );
      }
      if (object.members !== undefined) {
        fail(
          "GRAPH_EDGES_FIELD_INVALID",
          `${field}.members is only for group kinds`,
        );
      }
      edges.push({
        kind: kind as GraphEdgeKind,
        fromConditionId: from,
        toConditionId: to,
        members: [],
        author,
        justification,
        confidence,
        params,
      });
      return;
    }
    if (!Array.isArray(object.members) || object.members.length < 2) {
      fail(
        "GRAPH_EDGES_FIELD_INVALID",
        `${field}.members must list at least two markets`,
      );
    }
    const members = object.members.map((member, memberIndex) =>
      asNonEmptyString(member, `${field}.members[${memberIndex}]`),
    );
    if (new Set(members).size !== members.length) {
      fail("GRAPH_EDGES_FIELD_INVALID", `${field}.members has duplicates`);
    }
    if (
      object.from_condition_id !== undefined ||
      object.to_condition_id !== undefined
    ) {
      fail(
        "GRAPH_EDGES_FIELD_INVALID",
        `${field}.from/to are only for pair kinds`,
      );
    }
    edges.push({
      kind: kind as GraphEdgeKind,
      fromConditionId: null,
      toConditionId: null,
      members: [...members].sort(),
      author,
      justification,
      confidence,
      params,
    });
  });
  return edges;
}

export interface LoadCuratedEdgesOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readTextFile?: (path: string) => Promise<string>;
}

/** Load curated edges; with no file configured the set is empty. */
export async function loadCuratedEdges(
  options: LoadCuratedEdgesOptions = {},
): Promise<CuratedEdge[]> {
  const env = options.env ?? process.env;
  const path = env[GRAPH_EDGES_FILE_ENV];
  if (path === undefined || path === "") {
    return [];
  }
  const readTextFile =
    options.readTextFile ?? ((file: string) => readFile(file, "utf8"));
  let text: string;
  try {
    text = await readTextFile(path);
  } catch {
    fail(
      "GRAPH_EDGES_FILE_UNREADABLE",
      "configured graph edges file could not be read",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("GRAPH_EDGES_FILE_INVALID_JSON", "graph edges file is not valid JSON");
  }
  return parseCuratedEdges(parsed);
}
