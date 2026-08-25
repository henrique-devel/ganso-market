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
  // The file is reconciled on every build, so a removed file-curated edge may
  // fall back to its structural derivation. API-curated rows are different:
  // only the authenticated API may change or reactivate them.
  await pool.query(
    `INSERT INTO graph_edges
       (edge_key, kind, from_condition_id, to_condition_id, event_id,
        members_json, origin, confidence, author, justification, params_json)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (edge_key) DO UPDATE SET
       members_json = CASE
         WHEN graph_edges.params_json->>'source' = 'api'
           THEN graph_edges.members_json
         ELSE EXCLUDED.members_json
       END,
       origin = CASE
         WHEN graph_edges.params_json->>'source' = 'api'
           THEN graph_edges.origin
         ELSE EXCLUDED.origin
       END,
       confidence = CASE
         WHEN graph_edges.params_json->>'source' = 'api'
           THEN graph_edges.confidence
         ELSE EXCLUDED.confidence
       END,
       author = CASE
         WHEN graph_edges.params_json->>'source' = 'api'
           THEN graph_edges.author
         ELSE EXCLUDED.author
       END,
       justification = CASE
         WHEN graph_edges.params_json->>'source' = 'api'
           THEN graph_edges.justification
         ELSE EXCLUDED.justification
       END,
       params_json = CASE
         WHEN graph_edges.params_json->>'source' = 'api'
           THEN graph_edges.params_json
         ELSE EXCLUDED.params_json
       END,
       revoked_at = CASE
         WHEN graph_edges.params_json->>'source' = 'api'
           THEN graph_edges.revoked_at
         ELSE NULL
       END,
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
 * Rebuild the graph as of `asOf`. Nodes are the current universe's markets;
 * a structural group's edge retains every named member recorded for its event
 * so completeness-sensitive constraints never mistake a subset for the whole.
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
    `WITH membership AS (
       SELECT em.event_id, em.condition_id,
              (SELECT pv.neg_risk
                 FROM polymarket_param_versions pv
                WHERE pv.condition_id = em.condition_id
                  AND pv.valid_from <= $1
                  AND (pv.valid_to IS NULL OR pv.valid_to > $1)
                ORDER BY pv.version DESC
                LIMIT 1) AS neg_risk_as_of
         FROM polymarket_event_markets em
        WHERE em.received_at <= $1
     )
     SELECT event_id,
            jsonb_agg(condition_id ORDER BY condition_id) AS members
       FROM membership
      GROUP BY event_id
     HAVING bool_and(neg_risk_as_of IS TRUE)`,
    [asOf],
  );
  for (const row of groups.rows) {
    const eventId = typeof row.event_id === "string" ? row.event_id : null;
    if (eventId === null || !Array.isArray(row.members)) {
      continue;
    }
    // Membership is the full set known at asOf (placeholders never reach the
    // registry), not just the current universe. The event row is mutable and
    // cannot support an as-of claim, so structural eligibility comes from the
    // versioned neg_risk parameter of every member. Missing evidence omits the
    // group instead of inventing history. At least one live node must matter.
    const members = (row.members as unknown[])
      .filter((item): item is string => typeof item === "string")
      .sort();
    if (
      members.length < 2 ||
      !members.some((conditionId) => nodeIds.has(conditionId))
    ) {
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

  // Structural inference is appended first and file curation second. Keeping
  // the last row per stable key makes curation win only while it is present in
  // the current file, and avoids exposing an intermediate demotion.
  const reconciled = [
    ...new Map(desired.map((edge) => [edge.edgeKey, edge])).values(),
  ];
  for (const edge of reconciled) {
    await upsertEdge(pool, edge);
  }

  // Revoke edges this build no longer derives. API-curated edges
  // (params_json.source = 'api') are the operator's: only the API touches them.
  const keys = reconciled.map((edge) => edge.edgeKey);
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
    structural: reconciled.filter((edge) => edge.origin === "structural")
      .length,
    curated: reconciled.filter((edge) => edge.origin === "curated").length,
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
