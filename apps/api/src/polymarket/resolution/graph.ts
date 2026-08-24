// RFC-012 task 11: graph construction. Structural edges come from the Gamma
// registry (negRisk event groups) and from ladder inference over titles;
// curated edges come from the versioned repo file (source 'file') and from
// the authenticated API (source 'api'). The build is a reconciliation: edges
// it no longer derives are revoked, never deleted — the history stays.

import { createHash } from "node:crypto";

import { inferLadders } from "./ladder.js";
import { loadScoreableMarkets, ruleAsOf } from "./store.js";
import type { CuratedEdge } from "./curated.js";
import type { GraphEdgeKind, ResolutionPool } from "./types.js";

export interface EdgeUpsert {
  readonly edgeKey: string;
  readonly kind: GraphEdgeKind;
  readonly fromConditionId: string | null;
  readonly toConditionId: string | null;
  readonly eventId: string | null;
  readonly members: readonly string[];
  readonly origin: "structural" | "curated";
  readonly confidence: string;
  readonly author: string | null;
  readonly justification: string | null;
  readonly params: Readonly<Record<string, unknown>>;
}

function membersKey(members: readonly string[]): string {
  return createHash("sha256")
    .update(members.join("|"))
    .digest("hex")
    .slice(0, 16);
}

export function edgeKeyOf(edge: {
  kind: GraphEdgeKind;
  fromConditionId: string | null;
  toConditionId: string | null;
  eventId: string | null;
  members: readonly string[];
}): string {
  if (edge.eventId !== null) {
    return `${edge.kind}:event:${edge.eventId}`;
  }
  if (edge.fromConditionId !== null && edge.toConditionId !== null) {
    return `${edge.kind}:${edge.fromConditionId}->${edge.toConditionId}`;
  }
  return `${edge.kind}:set:${membersKey(edge.members)}`;
}

async function upsertEdge(
  pool: ResolutionPool,
  edge: EdgeUpsert,
): Promise<void> {
  await pool.query(
    `INSERT INTO graph_edges
       (edge_key, kind, from_condition_id, to_condition_id, event_id,
        members_json, origin, confidence, author, justification, params_json)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (edge_key) DO UPDATE SET
       members_json = EXCLUDED.members_json,
       confidence = EXCLUDED.confidence,
       author = EXCLUDED.author,
       justification = EXCLUDED.justification,
       params_json = EXCLUDED.params_json,
       revoked_at = NULL,
       updated_at = CURRENT_TIMESTAMP`,
    [
      edge.edgeKey,
      edge.kind,
      edge.fromConditionId,
      edge.toConditionId,
      edge.eventId,
      JSON.stringify(edge.members),
      edge.origin,
      edge.confidence,
      edge.author,
      edge.justification,
      JSON.stringify(edge.params),
    ],
  );
}

export interface GraphBuildSummary {
  readonly nodes: number;
  readonly structural: number;
  readonly curated: number;
  readonly revoked: number;
}

/**
 * Rebuild the graph as of `asOf`. Nodes are the current universe's markets.
 * In augmented negRisk groups only named outcomes participate — placeholders
 * never reach the registry, so membership is intersected with the node set.
 */
export async function buildGraph(
  pool: ResolutionPool,
  curated: readonly CuratedEdge[],
  asOf: Date,
): Promise<GraphBuildSummary> {
  const markets = await loadScoreableMarkets(pool, asOf);
  const nodes = markets.filter((market) => market.inUniverse);
  const nodeIds = new Set(nodes.map((market) => market.conditionId));

  const desired: EdgeUpsert[] = [];

  // Structural NEGRISK groups: the Gamma event is the group.
  const groups = await pool.query<Record<string, unknown>>(
    `SELECT e.event_id,
            jsonb_agg(em.condition_id ORDER BY em.condition_id) AS members
       FROM polymarket_events e
       JOIN polymarket_event_markets em ON em.event_id = e.event_id
      WHERE e.neg_risk = TRUE
      GROUP BY e.event_id`,
  );
  for (const row of groups.rows) {
    const eventId = typeof row.event_id === "string" ? row.event_id : null;
    if (eventId === null || !Array.isArray(row.members)) {
      continue;
    }
    const members = (row.members as unknown[])
      .filter((item): item is string => typeof item === "string")
      .filter((conditionId) => nodeIds.has(conditionId))
      .sort();
    if (members.length < 2) {
      continue;
    }
    desired.push({
      edgeKey: edgeKeyOf({
        kind: "NEGRISK",
        fromConditionId: null,
        toConditionId: null,
        eventId,
        members,
      }),
      kind: "NEGRISK",
      fromConditionId: null,
      toConditionId: null,
      eventId,
      members,
      origin: "structural",
      confidence: "1.000000",
      author: null,
      justification: null,
      params: { source: "structural" },
    });
  }

  // Structural LADDER implications from titles + versioned end dates.
  const ladderInputs = [];
  for (const market of nodes) {
    const rule = await ruleAsOf(pool, market.conditionId, asOf);
    ladderInputs.push({
      conditionId: market.conditionId,
      question: market.question,
      endDate: rule?.endDate ?? null,
    });
  }
  for (const inferred of inferLadders(ladderInputs)) {
    desired.push({
      edgeKey: edgeKeyOf({
        kind: inferred.kind,
        fromConditionId: inferred.fromConditionId,
        toConditionId: inferred.toConditionId,
        eventId: null,
        members: [],
      }),
      kind: inferred.kind,
      fromConditionId: inferred.fromConditionId,
      toConditionId: inferred.toConditionId,
      eventId: null,
      members: [],
      origin: "structural",
      confidence: inferred.confidence,
      author: null,
      justification: null,
      params: { ...inferred.params, source: "structural" },
    });
  }

  // Curated edges from the versioned file.
  for (const edge of curated) {
    desired.push({
      edgeKey: edgeKeyOf({
        kind: edge.kind,
        fromConditionId: edge.fromConditionId,
        toConditionId: edge.toConditionId,
        eventId: null,
        members: edge.members,
      }),
      kind: edge.kind,
      fromConditionId: edge.fromConditionId,
      toConditionId: edge.toConditionId,
      eventId: null,
      members: edge.members,
      origin: "curated",
      confidence: edge.confidence,
      author: edge.author,
      justification: edge.justification,
      params: { ...edge.params, source: "file" },
    });
  }

  for (const edge of desired) {
    await upsertEdge(pool, edge);
  }

  // Revoke edges this build no longer derives. API-curated edges
  // (params_json.source = 'api') are the operator's: only the API touches them.
  const keys = desired.map((edge) => edge.edgeKey);
  const revoked = await pool.query(
    `UPDATE graph_edges
        SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE revoked_at IS NULL
        AND COALESCE(params_json->>'source', 'structural') <> 'api'
        AND NOT (edge_key = ANY($1))`,
    [keys],
  );

  return {
    nodes: nodes.length,
    structural: desired.filter((edge) => edge.origin === "structural").length,
    curated: desired.filter((edge) => edge.origin === "curated").length,
    revoked: revoked.rowCount,
  };
}

export interface ActiveEdge {
  readonly edgeId: number;
  readonly edgeKey: string;
  readonly kind: GraphEdgeKind;
  readonly fromConditionId: string | null;
  readonly toConditionId: string | null;
  readonly eventId: string | null;
  readonly members: readonly string[];
  readonly confidence: string;
}

export async function loadActiveEdges(
  pool: ResolutionPool,
  minConfidence: number,
): Promise<ActiveEdge[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT edge_id, edge_key, kind, from_condition_id, to_condition_id,
            event_id, members_json, confidence
       FROM graph_edges
      WHERE revoked_at IS NULL`,
  );
  const edges: ActiveEdge[] = [];
  for (const row of result.rows) {
    const confidence =
      typeof row.confidence === "string" ? Number(row.confidence) : NaN;
    if (!Number.isFinite(confidence) || confidence < minConfidence) {
      continue;
    }
    const members = Array.isArray(row.members_json)
      ? (row.members_json as unknown[]).filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    edges.push({
      edgeId: Number(row.edge_id),
      edgeKey: String(row.edge_key),
      kind: row.kind as GraphEdgeKind,
      fromConditionId:
        typeof row.from_condition_id === "string"
          ? row.from_condition_id
          : null,
      toConditionId:
        typeof row.to_condition_id === "string" ? row.to_condition_id : null,
      eventId: typeof row.event_id === "string" ? row.event_id : null,
      members,
      confidence: String(row.confidence),
    });
  }
  return edges;
}
