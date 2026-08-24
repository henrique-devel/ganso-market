// RFC-012 task 14: the sanity veto over the fundamental model. When a fresh
// MODEL estimate q contradicts a graph constraint against the NEIGHBOURS'
// executable prices beyond the cost band, the model-dependent signal is
// blocked (the intent gate refuses it) and the market baseline stands. The
// veto is logged with the edges involved; absence of a fresh estimate is an
// absence — nothing to veto, the row closes.

import { SCALE, formatScaled, mul, parseScaled } from "../fundamental/fixed.js";
import { loadActiveEdges, type ActiveEdge } from "./graph.js";
import { loadMarketLeg, type MarketLeg } from "./evaluate.js";
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
export function pairSanityFindings(
  edge: ActiveEdge,
  from: MarketLeg,
  to: MarketLeg,
  estimates: ReadonlyMap<string, FreshModelEstimate>,
  epsilon: bigint,
): VetoFinding[] {
  const findings: VetoFinding[] = [];
  const fromEstimate = estimates.get(from.tokenId);
  const toEstimate = estimates.get(to.tokenId);

  const askTo = touch(to.books.asks);
  const bidFrom = touch(from.books.bids);
  const askFrom = touch(from.books.asks);
  const bidTo = touch(to.books.bids);

  const push = (
    leg: MarketLeg,
    estimate: FreshModelEstimate,
    neighbor: MarketLeg,
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
  if (fromEstimate !== undefined && askTo !== null) {
    const q = parseScaled(fromEstimate.q);
    if (q !== null) {
      const tolerance = epsilon + takerFee(to.feeRate, askTo);
      if (q > askTo + tolerance) {
        push(from, fromEstimate, to, askTo, tolerance, q - askTo, "q_gt_ask");
      }
    }
  }
  // q(to) must not sit below what the implying market already sells for.
  if (toEstimate !== undefined && bidFrom !== null) {
    const q = parseScaled(toEstimate.q);
    if (q !== null) {
      const tolerance = epsilon + takerFee(from.feeRate, bidFrom);
      if (q < bidFrom - tolerance) {
        push(to, toEstimate, from, bidFrom, tolerance, bidFrom - q, "q_lt_bid");
      }
    }
  }
  if (edge.kind === "EQUIV") {
    // Equivalence binds both ways: run the mirrored checks too.
    if (toEstimate !== undefined && askFrom !== null) {
      const q = parseScaled(toEstimate.q);
      if (q !== null) {
        const tolerance = epsilon + takerFee(from.feeRate, askFrom);
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
    if (fromEstimate !== undefined && bidTo !== null) {
      const q = parseScaled(fromEstimate.q);
      if (q !== null) {
        const tolerance = epsilon + takerFee(to.feeRate, bidTo);
        if (q < bidTo - tolerance) {
          push(from, fromEstimate, to, bidTo, tolerance, bidTo - q, "q_lt_bid");
        }
      }
    }
  }
  return findings;
}

/**
 * Group constraint: within a negRisk/mutex group, q_i cannot exceed 1 minus
 * what the OTHER outcomes already command as executable bids.
 */
export function groupSanityFindings(
  edge: ActiveEdge,
  legs: readonly MarketLeg[],
  estimates: ReadonlyMap<string, FreshModelEstimate>,
  epsilon: bigint,
): VetoFinding[] {
  const findings: VetoFinding[] = [];
  for (const leg of legs) {
    const estimate = estimates.get(leg.tokenId);
    if (estimate === undefined) {
      continue;
    }
    const q = parseScaled(estimate.q);
    if (q === null) {
      continue;
    }
    let othersBids = 0n;
    let fees = 0n;
    let priced = true;
    for (const other of legs) {
      if (other.conditionId === leg.conditionId) {
        continue;
      }
      const bid = touch(other.books.bids);
      if (bid === null) {
        priced = false;
        break;
      }
      othersBids += bid;
      fees += takerFee(other.feeRate, bid);
    }
    if (!priced) {
      continue;
    }
    const ceiling = SCALE - othersBids;
    const tolerance = epsilon + fees;
    if (q > ceiling + tolerance) {
      findings.push({
        conditionId: leg.conditionId,
        tokenId: leg.tokenId,
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
        },
      });
    }
  }
  return findings;
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
  const legs = new Map<string, MarketLeg>();
  for (const conditionId of involved) {
    const leg = await loadMarketLeg(pool, conditionId, asOf, config);
    if (leg !== null) {
      legs.set(conditionId, leg);
    }
  }
  const estimatesList = await freshModelEstimates(
    pool,
    [...legs.values()].map((leg) => leg.tokenId),
    asOf,
  );
  const estimates = new Map(
    estimatesList.map((estimate) => [estimate.tokenId, estimate]),
  );

  const epsilon = parseScaled(config.graph.epsilon.toFixed(9)) ?? 0n;
  const findings: VetoFinding[] = [];
  for (const edge of edges) {
    summary.checked += 1;
    if (edge.kind === "MUTEX" || edge.kind === "NEGRISK") {
      const memberLegs = edge.members
        .map((member) => legs.get(member))
        .filter((leg): leg is MarketLeg => leg !== undefined);
      if (memberLegs.length === edge.members.length && memberLegs.length >= 2) {
        findings.push(
          ...groupSanityFindings(edge, memberLegs, estimates, epsilon),
        );
      }
      continue;
    }
    const from = legs.get(edge.fromConditionId ?? "");
    const to = legs.get(edge.toConditionId ?? "");
    if (from !== undefined && to !== undefined) {
      findings.push(...pairSanityFindings(edge, from, to, estimates, epsilon));
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
  summary.active = activeKeys.size;

  // Close every open veto not re-confirmed this cycle: either the estimate
  // returned inside the band, or it went stale (absence = nothing to veto).
  const open = await pool.query<Record<string, unknown>>(
    `SELECT veto_id, token_id, edge_key
       FROM graph_sanity_vetoes
      WHERE ended_at IS NULL`,
  );
  for (const row of open.rows) {
    const key = `${String(row.token_id)}::${String(row.edge_key)}`;
    if (!activeKeys.has(key)) {
      await pool.query(
        `UPDATE graph_sanity_vetoes SET ended_at = $2 WHERE veto_id = $1`,
        [row.veto_id, asOf],
      );
      summary.closed += 1;
    }
  }
  return summary;
}
