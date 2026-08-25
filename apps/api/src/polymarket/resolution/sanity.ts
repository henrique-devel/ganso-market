// RFC-012 task 14: the sanity veto over the fundamental model. When a fresh
// MODEL estimate q contradicts a graph constraint against the NEIGHBOURS'
// executable prices beyond the cost band, the model-dependent signal is
// blocked (the intent gate refuses it) and the market baseline stands. The
// veto is logged with the edges involved; absence of a fresh estimate is an
// absence — nothing to veto, the row closes.

import { SCALE, formatScaled, mul, parseScaled } from "../fundamental/fixed.js";
import { loadActiveEdges, type ActiveEdge } from "./graph.js";
import {
  loadMarketLeg,
  loadMarketRef,
  type MarketLeg,
  type MarketRef,
} from "./evaluate.js";
import { freshModelEstimates, type FreshModelEstimate } from "./store.js";
import type { ResolutionConfig } from "./config.js";
import type { ResolutionPool } from "./types.js";

interface VetoFinding {
  readonly conditionId: string;
  readonly tokenId: string;
  readonly estimate: FreshModelEstimate;
  readonly edge: ActiveEdge;
  readonly neighborConditionId: string | null;
  readonly neighborPrice: bigint;
  readonly tolerance: bigint;
  readonly magnitude: bigint;
  readonly detail: Readonly<Record<string, unknown>>;
}

type SanityCheckName = "q_gt_ask" | "q_lt_bid" | "q_gt_group_ceiling";

interface SanityNode extends MarketRef {
  readonly pricing: MarketLeg | null;
}

interface SanityEvaluation {
  readonly findings: readonly VetoFinding[];
  readonly evaluatedChecks: ReadonlySet<string>;
}

function checkKey(
  tokenId: string,
  edgeKey: string,
  check: SanityCheckName,
): string {
  return `${tokenId}::${edgeKey}::${check}`;
}

function takerFee(rateScaled: bigint, priceScaled: bigint): bigint {
  return mul(rateScaled, mul(priceScaled, SCALE - priceScaled));
}

function touch(
  levels: ReadonlyArray<{ price: bigint; size: bigint }>,
): bigint | null {
  return levels[0]?.price ?? null;
}

/**
 * Evaluate one pair edge (IMPLIES/LADDER: P(from) <= P(to); EQUIV: equality
 * within the band) against fresh estimates. Pure given the legs.
 */
function evaluatePairSanity(
  edge: ActiveEdge,
  from: SanityNode,
  to: SanityNode,
  estimates: ReadonlyMap<string, FreshModelEstimate>,
  epsilon: bigint,
): SanityEvaluation {
  const findings: VetoFinding[] = [];
  const evaluatedChecks = new Set<string>();
  const fromEstimate = estimates.get(from.tokenId);
  const toEstimate = estimates.get(to.tokenId);

  const askTo = touch(to.pricing?.books.asks ?? []);
  const bidFrom = touch(from.pricing?.books.bids ?? []);
  const askFrom = touch(from.pricing?.books.asks ?? []);
  const bidTo = touch(to.pricing?.books.bids ?? []);

  const push = (
    leg: SanityNode,
    estimate: FreshModelEstimate,
    neighbor: SanityNode,
    neighborPrice: bigint,
    tolerance: bigint,
    magnitude: bigint,
    check: string,
  ): void => {
    findings.push({
      conditionId: leg.conditionId,
      tokenId: leg.tokenId,
      estimate,
      edge,
      neighborConditionId: neighbor.conditionId,
      neighborPrice,
      tolerance,
      magnitude,
      detail: { check, q: estimate.q, status: estimate.status },
    });
  };

  // q(from) must not exceed what the implied market can be bought for.
  if (fromEstimate !== undefined && askTo !== null && to.pricing !== null) {
    const q = parseScaled(fromEstimate.q);
    if (q !== null) {
      evaluatedChecks.add(checkKey(from.tokenId, edge.edgeKey, "q_gt_ask"));
      const tolerance = epsilon + takerFee(to.pricing.feeRate, askTo);
      if (q > askTo + tolerance) {
        push(from, fromEstimate, to, askTo, tolerance, q - askTo, "q_gt_ask");
      }
    }
  }
  // q(to) must not sit below what the implying market already sells for.
  if (toEstimate !== undefined && bidFrom !== null && from.pricing !== null) {
    const q = parseScaled(toEstimate.q);
    if (q !== null) {
      evaluatedChecks.add(checkKey(to.tokenId, edge.edgeKey, "q_lt_bid"));
      const tolerance = epsilon + takerFee(from.pricing.feeRate, bidFrom);
      if (q < bidFrom - tolerance) {
        push(to, toEstimate, from, bidFrom, tolerance, bidFrom - q, "q_lt_bid");
      }
    }
  }
  if (edge.kind === "EQUIV") {
    // Equivalence binds both ways: run the mirrored checks too.
    if (toEstimate !== undefined && askFrom !== null && from.pricing !== null) {
      const q = parseScaled(toEstimate.q);
      if (q !== null) {
        evaluatedChecks.add(checkKey(to.tokenId, edge.edgeKey, "q_gt_ask"));
        const tolerance = epsilon + takerFee(from.pricing.feeRate, askFrom);
        if (q > askFrom + tolerance) {
          push(
            to,
            toEstimate,
            from,
            askFrom,
            tolerance,
            q - askFrom,
            "q_gt_ask",
          );
        }
      }
    }
    if (fromEstimate !== undefined && bidTo !== null && to.pricing !== null) {
      const q = parseScaled(fromEstimate.q);
      if (q !== null) {
        evaluatedChecks.add(checkKey(from.tokenId, edge.edgeKey, "q_lt_bid"));
        const tolerance = epsilon + takerFee(to.pricing.feeRate, bidTo);
        if (q < bidTo - tolerance) {
          push(from, fromEstimate, to, bidTo, tolerance, bidTo - q, "q_lt_bid");
        }
      }
    }
  }
  return { findings, evaluatedChecks };
}

export function pairSanityFindings(
  edge: ActiveEdge,
  from: MarketLeg,
  to: MarketLeg,
  estimates: ReadonlyMap<string, FreshModelEstimate>,
  epsilon: bigint,
): VetoFinding[] {
  return [
    ...evaluatePairSanity(
      edge,
      { ...from, pricing: from },
      { ...to, pricing: to },
      estimates,
      epsilon,
    ).findings,
  ];
}

/**
 * Group constraint: within a negRisk/mutex group, q_i cannot exceed 1 minus
 * what the OTHER outcomes already command as executable bids.
 */
function evaluateGroupSanity(
  edge: ActiveEdge,
  nodes: readonly SanityNode[],
  estimates: ReadonlyMap<string, FreshModelEstimate>,
  epsilon: bigint,
): SanityEvaluation {
  const findings: VetoFinding[] = [];
  const evaluatedChecks = new Set<string>();
  const byCondition = new Map(nodes.map((node) => [node.conditionId, node]));
  for (const node of nodes) {
    const estimate = estimates.get(node.tokenId);
    if (estimate === undefined) {
      continue;
    }
    const q = parseScaled(estimate.q);
    if (q === null) {
      continue;
    }
    let othersBids = 0n;
    let fees = 0n;
    let pricedOthers = 0;
    let allOthersPriced = true;
    for (const member of edge.members) {
      if (member === node.conditionId) {
        continue;
      }
      const other = byCondition.get(member);
      const bid = touch(other?.pricing?.books.bids ?? []);
      if (bid === null || other?.pricing === null || other === undefined) {
        allOthersPriced = false;
        continue;
      }
      othersBids += bid;
      fees += takerFee(other.pricing.feeRate, bid);
      pricedOthers += 1;
    }
    if (allOthersPriced) {
      evaluatedChecks.add(
        checkKey(node.tokenId, edge.edgeKey, "q_gt_group_ceiling"),
      );
    }
    const ceiling = SCALE - othersBids;
    const tolerance = epsilon + fees;
    if (pricedOthers > 0 && q > ceiling + tolerance) {
      findings.push({
        conditionId: node.conditionId,
        tokenId: node.tokenId,
        estimate,
        edge,
        neighborConditionId: null,
        neighborPrice: othersBids,
        tolerance,
        magnitude: q - ceiling,
        detail: {
          check: "q_gt_group_ceiling",
          q: estimate.q,
          status: estimate.status,
          members: edge.members.length,
          other_members_priced: pricedOthers,
        },
      });
    }
  }
  return { findings, evaluatedChecks };
}

export function groupSanityFindings(
  edge: ActiveEdge,
  legs: readonly MarketLeg[],
  estimates: ReadonlyMap<string, FreshModelEstimate>,
  epsilon: bigint,
): VetoFinding[] {
  return [
    ...evaluateGroupSanity(
      edge,
      legs.map((leg) => ({ ...leg, pricing: leg })),
      estimates,
      epsilon,
    ).findings,
  ];
}

export interface SanitySummary {
  readonly checked: number;
  readonly active: number;
  readonly opened: number;
  readonly closed: number;
}

/** One sanity cycle: open/refresh vetoes for current findings, close the rest. */
export async function sanityCheck(
  pool: ResolutionPool,
  config: ResolutionConfig,
  asOf: Date,
): Promise<SanitySummary> {
  const edges = await loadActiveEdges(pool, config.graph.minConfidence);
  const summary = { checked: 0, active: 0, opened: 0, closed: 0 };
  const open = await pool.query<Record<string, unknown>>(
    `SELECT veto_id, token_id, edge_key, details_json
       FROM graph_sanity_vetoes
      WHERE ended_at IS NULL`,
  );

  const involved = new Set<string>();
  for (const edge of edges) {
    if (edge.fromConditionId !== null) {
      involved.add(edge.fromConditionId);
    }
    if (edge.toConditionId !== null) {
      involved.add(edge.toConditionId);
    }
    for (const member of edge.members) {
      involved.add(member);
    }
  }
  const refs = new Map<string, MarketRef>();
  const legs = new Map<string, MarketLeg>();
  for (const conditionId of involved) {
    const ref = await loadMarketRef(pool, conditionId, asOf);
    if (ref !== null) {
      refs.set(conditionId, ref);
    }
    const leg = await loadMarketLeg(pool, conditionId, asOf, config);
    if (leg !== null) {
      legs.set(conditionId, leg);
    }
  }
  const estimateTokenIds = new Set(
    [...refs.values()].map((ref) => ref.tokenId),
  );
  for (const row of open.rows) {
    if (typeof row.token_id === "string") {
      estimateTokenIds.add(row.token_id);
    }
  }
  const estimatesList = await freshModelEstimates(
    pool,
    [...estimateTokenIds],
    asOf,
  );
  const estimates = new Map(
    estimatesList.map((estimate) => [estimate.tokenId, estimate]),
  );

  const epsilon = parseScaled(config.graph.epsilon.toFixed(9)) ?? 0n;
  const findings: VetoFinding[] = [];
  // Closure evidence is directional and token-specific. A usable bid for one
  // model or direction says nothing about another check on the same edge.
  const evaluatedChecks = new Set<string>();
  for (const edge of edges) {
    summary.checked += 1;
    if (edge.kind === "MUTEX" || edge.kind === "NEGRISK") {
      const memberNodes = edge.members
        .map((member) => refs.get(member))
        .filter((ref): ref is MarketRef => ref !== undefined)
        .map((ref) => ({ ...ref, pricing: legs.get(ref.conditionId) ?? null }));
      const evaluated = evaluateGroupSanity(
        edge,
        memberNodes,
        estimates,
        epsilon,
      );
      findings.push(...evaluated.findings);
      for (const key of evaluated.evaluatedChecks) {
        evaluatedChecks.add(key);
      }
      continue;
    }
    const fromRef = refs.get(edge.fromConditionId ?? "");
    const toRef = refs.get(edge.toConditionId ?? "");
    if (fromRef !== undefined && toRef !== undefined) {
      const evaluated = evaluatePairSanity(
        edge,
        { ...fromRef, pricing: legs.get(fromRef.conditionId) ?? null },
        { ...toRef, pricing: legs.get(toRef.conditionId) ?? null },
        estimates,
        epsilon,
      );
      findings.push(...evaluated.findings);
      for (const key of evaluated.evaluatedChecks) {
        evaluatedChecks.add(key);
      }
    }
  }

  const activeKeys = new Set<string>();
  for (const finding of findings) {
    const key = `${finding.tokenId}::${finding.edge.edgeKey}`;
    activeKeys.add(key);
    const refreshed = await pool.query(
      `UPDATE graph_sanity_vetoes
          SET last_seen_at = $3,
              q = $4,
              neighbor_price = $5,
              tolerance = $6,
              magnitude = $7,
              details_json = details_json || $8::jsonb
        WHERE token_id = $1 AND edge_key = $2 AND ended_at IS NULL`,
      [
        finding.tokenId,
        finding.edge.edgeKey,
        asOf,
        finding.estimate.q,
        formatScaled(finding.neighborPrice, 6),
        formatScaled(finding.tolerance, 6),
        formatScaled(finding.magnitude, 6),
        JSON.stringify(finding.detail),
      ],
    );
    if (refreshed.rowCount === 0) {
      await pool.query(
        `INSERT INTO graph_sanity_vetoes
           (condition_id, token_id, model_id, estimate_status, q, edge_id,
            edge_key, kind, neighbor_condition_id, neighbor_price, tolerance,
            magnitude, started_at, last_seen_at, details_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14::jsonb)`,
        [
          finding.conditionId,
          finding.tokenId,
          finding.estimate.modelId,
          finding.estimate.status,
          finding.estimate.q,
          finding.edge.edgeId,
          finding.edge.edgeKey,
          finding.edge.kind,
          finding.neighborConditionId,
          formatScaled(finding.neighborPrice, 6),
          formatScaled(finding.tolerance, 6),
          formatScaled(finding.magnitude, 6),
          asOf,
          JSON.stringify(finding.detail),
        ],
      );
      summary.opened += 1;
    }
  }
  // Close an open veto only on EVIDENCE: the edge was re-evaluated inside
  // the band, or the estimate is gone/stale (absence = no model signal left
  // to veto). An unpriceable edge with a still-fresh estimate keeps the veto
  // open — no fresh neighbour prices is not proof the contradiction ended.
  for (const row of open.rows) {
    const tokenId = String(row.token_id);
    const edgeKey = String(row.edge_key);
    const key = `${tokenId}::${edgeKey}`;
    if (activeKeys.has(key)) {
      continue;
    }
    const estimateGone = !estimates.has(tokenId);
    const edgeGone = !edges.some((edge) => edge.edgeKey === edgeKey);
    const check = detailCheck(row.details_json);
    const wasEvaluated =
      check !== null && evaluatedChecks.has(checkKey(tokenId, edgeKey, check));
    if (!estimateGone && !edgeGone && !wasEvaluated) {
      continue;
    }
    await pool.query(
      `UPDATE graph_sanity_vetoes SET ended_at = $2 WHERE veto_id = $1`,
      [row.veto_id, asOf],
    );
    summary.closed += 1;
  }
  summary.active = Math.max(
    0,
    open.rows.length + summary.opened - summary.closed,
  );
  return summary;
}

function detailCheck(value: unknown): SanityCheckName | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const check = (parsed as Record<string, unknown>)["check"];
  return check === "q_gt_ask" ||
    check === "q_lt_bid" ||
    check === "q_gt_group_ceiling"
    ? check
    : null;
}
