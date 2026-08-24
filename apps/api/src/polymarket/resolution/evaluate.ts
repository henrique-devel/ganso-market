// RFC-012 tasks 12-13: graph evaluation against EXECUTABLE prices. Every
// check walks the recorded book's bid/ask depth — never a midpoint — and a
// violation only opens after k consecutive evaluations beyond the cost band.
// The band is taker fees on every leg plus the configured ε; the effective
// spread of the RFC's tol formula is not added again because the legs are
// priced at executable bid/ask, which already pays it (adding it twice would
// be a tighter band, never a looser one — loosening is the forbidden move).
// Magnitudes are net of fees; sizes come from the walk, never theoretical.

import {
  SCALE,
  divRound,
  formatScaled,
  mul,
  parseScaled,
} from "../fundamental/fixed.js";
import { bookAsOf, paramsAsOf } from "./store.js";
import { loadActiveEdges, type ActiveEdge } from "./graph.js";
import type { ResolutionConfig } from "./config.js";
import type { ResolutionPool } from "./types.js";

export interface ScaledLevel {
  readonly price: bigint;
  readonly size: bigint;
}

export function toScaledLevels(
  levels: ReadonlyArray<{ price: string; size: string }>,
): ScaledLevel[] {
  const scaled: ScaledLevel[] = [];
  for (const level of levels) {
    const price = parseScaled(level.price);
    const size = parseScaled(level.size);
    if (price === null || size === null || price <= 0n || size <= 0n) {
      continue;
    }
    scaled.push({ price, size });
  }
  return scaled;
}

/** Per-share taker fee at price p: rate x p x (1 - p). */
function takerFee(rateScaled: bigint, priceScaled: bigint): bigint {
  return mul(rateScaled, mul(priceScaled, SCALE - priceScaled));
}

export interface ArbWalk {
  /** Net margin of the FIRST share, after fees (per share, $ at scale 9). */
  readonly unitNet: bigint;
  /** Shares executable with per-share net margin above ε. */
  readonly execSize: bigint;
  /** Capital deployed on the buy legs for that size. */
  readonly execNotional: bigint;
}

/**
 * Pair arbitrage walk: sell the implying market at its bids, buy the implied
 * one at its asks. Two-pointer over the level steps; stops at the first share
 * whose net margin falls to ε or below, or at the cap.
 */
export function pairArbWalk(
  sellBids: readonly ScaledLevel[],
  buyAsks: readonly ScaledLevel[],
  sellFeeRate: bigint,
  buyFeeRate: bigint,
  epsilon: bigint,
  capShares: bigint,
): ArbWalk {
  let i = 0;
  let j = 0;
  let remA = sellBids[0]?.size ?? 0n;
  let remB = buyAsks[0]?.size ?? 0n;
  let execSize = 0n;
  let execNotional = 0n;
  let unitNet = 0n;
  let first = true;
  while (i < sellBids.length && j < buyAsks.length && execSize < capShares) {
    const bid = sellBids[i];
    const ask = buyAsks[j];
    if (bid === undefined || ask === undefined) {
      break;
    }
    const net =
      bid.price -
      ask.price -
      takerFee(sellFeeRate, bid.price) -
      takerFee(buyFeeRate, ask.price);
    if (first) {
      unitNet = net;
      first = false;
    }
    if (net <= epsilon) {
      break;
    }
    const take = min3(remA, remB, capShares - execSize);
    execSize += take;
    execNotional += mul(take, ask.price);
    remA -= take;
    remB -= take;
    if (remA === 0n) {
      i += 1;
      remA = sellBids[i]?.size ?? 0n;
    }
    if (remB === 0n) {
      j += 1;
      remB = buyAsks[j]?.size ?? 0n;
    }
  }
  return { unitNet, execSize, execNotional };
}

function min3(a: bigint, b: bigint, c: bigint): bigint {
  const ab = a < b ? a : b;
  return ab < c ? ab : c;
}

/**
 * Group walk over one side of every member book. `sell` walks bids and nets
 * Σ bids - 1 - fees (selling the full YES set, worth exactly $1 at
 * resolution); `buy` walks asks and nets 1 - Σ asks - fees.
 */
export function groupArbWalk(
  memberLevels: ReadonlyArray<readonly ScaledLevel[]>,
  feeRates: readonly bigint[],
  side: "sell" | "buy",
  epsilon: bigint,
  capShares: bigint,
): ArbWalk {
  const cursor = memberLevels.map(() => 0);
  const remaining = memberLevels.map((levels) => levels[0]?.size ?? 0n);
  let execSize = 0n;
  let execNotional = 0n;
  let unitNet = 0n;
  let first = true;
  while (execSize < capShares) {
    let sum = 0n;
    let fees = 0n;
    let take = capShares - execSize;
    let exhausted = false;
    for (let m = 0; m < memberLevels.length; m += 1) {
      const levels = memberLevels[m];
      const index = cursor[m] ?? 0;
      const level = levels?.[index];
      const rate = feeRates[m];
      if (level === undefined || rate === undefined) {
        exhausted = true;
        break;
      }
      sum += level.price;
      fees += takerFee(rate, level.price);
      const rem = remaining[m] ?? 0n;
      if (rem < take) {
        take = rem;
      }
    }
    if (exhausted || take <= 0n) {
      break;
    }
    const net = side === "sell" ? sum - SCALE - fees : SCALE - sum - fees;
    if (first) {
      unitNet = net;
      first = false;
    }
    if (net <= epsilon) {
      break;
    }
    execSize += take;
    if (side === "buy") {
      execNotional += mul(take, sum);
    } else {
      execNotional += mul(take, SCALE);
    }
    for (let m = 0; m < memberLevels.length; m += 1) {
      const rem = (remaining[m] ?? 0n) - take;
      if (rem <= 0n) {
        cursor[m] = (cursor[m] ?? 0) + 1;
        remaining[m] = memberLevels[m]?.[cursor[m] ?? 0]?.size ?? 0n;
      } else {
        remaining[m] = rem;
      }
    }
  }
  return { unitNet, execSize, execNotional };
}

export interface EdgeBooks {
  readonly bids: readonly ScaledLevel[];
  readonly asks: readonly ScaledLevel[];
}

export type EdgeVerdict =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "inside" }
  | {
      readonly kind: "beyond";
      readonly unitNet: bigint;
      readonly execSize: bigint;
      readonly execNotional: bigint;
      readonly tolerance: bigint;
      readonly details: Readonly<Record<string, unknown>>;
    };

export interface MarketLeg {
  readonly conditionId: string;
  readonly tokenId: string;
  readonly books: EdgeBooks;
  readonly feeRate: bigint;
}

/** Evaluate one edge against the loaded legs (pure given the legs). */
export function evaluateEdge(
  edge: ActiveEdge,
  legs: ReadonlyMap<string, MarketLeg>,
  epsilon: bigint,
  capShares: bigint,
  fullMembership: boolean,
): EdgeVerdict {
  if (
    edge.kind === "IMPLIES" ||
    edge.kind === "LADDER" ||
    edge.kind === "EQUIV"
  ) {
    const from = legs.get(edge.fromConditionId ?? "");
    const to = legs.get(edge.toConditionId ?? "");
    if (from === undefined || to === undefined) {
      return { kind: "skipped", reason: "missing_leg" };
    }
    const directions: Array<{
      sell: MarketLeg;
      buy: MarketLeg;
      label: string;
    }> = [{ sell: from, buy: to, label: "from_over_to" }];
    if (edge.kind === "EQUIV") {
      directions.push({ sell: to, buy: from, label: "to_over_from" });
    }
    let best: EdgeVerdict = { kind: "inside" };
    for (const direction of directions) {
      const walk = pairArbWalk(
        direction.sell.books.bids,
        direction.buy.books.asks,
        direction.sell.feeRate,
        direction.buy.feeRate,
        epsilon,
        capShares,
      );
      if (walk.execSize > 0n) {
        const verdict: EdgeVerdict = {
          kind: "beyond",
          unitNet: walk.unitNet,
          execSize: walk.execSize,
          execNotional: walk.execNotional,
          tolerance: epsilon,
          details: {
            direction: direction.label,
            sell_condition_id: direction.sell.conditionId,
            buy_condition_id: direction.buy.conditionId,
          },
        };
        if (best.kind !== "beyond" || verdict.unitNet > best.unitNet) {
          best = verdict;
        }
      }
    }
    return best;
  }

  // Group kinds (MUTEX / NEGRISK).
  const memberLegs: MarketLeg[] = [];
  for (const member of edge.members) {
    const leg = legs.get(member);
    if (leg === undefined) {
      return { kind: "skipped", reason: "missing_member_book" };
    }
    memberLegs.push(leg);
  }
  if (memberLegs.length < 2) {
    return { kind: "skipped", reason: "group_too_small" };
  }
  const feeRates = memberLegs.map((leg) => leg.feeRate);
  const sell = groupArbWalk(
    memberLegs.map((leg) => leg.books.bids),
    feeRates,
    "sell",
    epsilon,
    capShares,
  );
  if (sell.execSize > 0n) {
    return {
      kind: "beyond",
      unitNet: sell.unitNet,
      execSize: sell.execSize,
      execNotional: sell.execNotional,
      tolerance: epsilon,
      details: { test: "sum_bids_gt_1", members: edge.members.length },
    };
  }
  // The buy-all test (Σ asks < 1) is only meaningful when every member of
  // the group is priced: a subset can legitimately sum below 1.
  if (fullMembership) {
    const buy = groupArbWalk(
      memberLegs.map((leg) => leg.books.asks),
      feeRates,
      "buy",
      epsilon,
      capShares,
    );
    if (buy.execSize > 0n) {
      return {
        kind: "beyond",
        unitNet: buy.unitNet,
        execSize: buy.execSize,
        execNotional: buy.execNotional,
        tolerance: epsilon,
        details: { test: "sum_asks_lt_1", members: edge.members.length },
      };
    }
  }
  return { kind: "inside" };
}

export interface EvaluateSummary {
  readonly checked: number;
  readonly beyond: number;
  readonly opened: number;
  readonly closed: number;
  readonly skipped: number;
  readonly suppressed: number;
}

function fmt(value: bigint): string {
  return formatScaled(value, 6);
}

/**
 * One evaluation cycle: load edges, price the legs from recorded books,
 * apply the k-persistence violation lifecycle. `streaks` is the caller's
 * consecutive-beyond counter per edge_key; a skip or an inside reading
 * resets it, so a violation always means k consecutive priced breaches.
 */
export async function evaluateGraph(
  pool: ResolutionPool,
  config: ResolutionConfig,
  streaks: Map<string, number>,
  asOf: Date,
): Promise<EvaluateSummary> {
  const edges = await loadActiveEdges(pool, config.graph.minConfidence);
  const summary = {
    checked: 0,
    beyond: 0,
    opened: 0,
    closed: 0,
    skipped: 0,
    suppressed: 0,
  };
  if (edges.length === 0) {
    return summary;
  }

  // Suppression set (task 15): nodes under VETO/CIRCUIT_BREAKER are
  // read-only — their "violations" reflect adjudication risk, not mispricing.
  const states = await pool.query<Record<string, unknown>>(
    `SELECT condition_id, effective_action FROM resolution_market_state`,
  );
  const suppressedMarkets = new Set<string>();
  for (const row of states.rows) {
    if (
      row.effective_action === "VETO" ||
      row.effective_action === "CIRCUIT_BREAKER"
    ) {
      suppressedMarkets.add(String(row.condition_id));
    }
  }

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
  const epsilon = parseScaled(config.graph.epsilon.toFixed(9)) ?? 0n;
  const capShares = parseScaled(config.graph.walkSizeCapShares) ?? 0n;
  for (const conditionId of involved) {
    const leg = await loadMarketLeg(pool, conditionId, asOf, config);
    if (leg !== null) {
      legs.set(conditionId, leg);
    }
  }

  for (const edge of edges) {
    summary.checked += 1;
    const verdict = evaluateEdge(
      edge,
      legs,
      epsilon,
      capShares,
      // Full membership means every recorded member had a fresh book; the
      // recorded set itself may lag Gamma, which details_json declares.
      edge.members.every((member) => legs.has(member)),
    );
    if (verdict.kind === "skipped") {
      summary.skipped += 1;
      streaks.set(edge.edgeKey, 0);
      continue;
    }
    if (verdict.kind === "inside") {
      streaks.set(edge.edgeKey, 0);
      summary.closed += await closeViolation(pool, edge.edgeKey, asOf);
      continue;
    }
    summary.beyond += 1;
    const streak = (streaks.get(edge.edgeKey) ?? 0) + 1;
    streaks.set(edge.edgeKey, streak);
    if (streak < config.graph.persistenceK) {
      continue;
    }
    const involvedMarkets = [
      edge.fromConditionId,
      edge.toConditionId,
      ...edge.members,
    ].filter((id): id is string => id !== null);
    const suppressed = involvedMarkets.some((id) => suppressedMarkets.has(id));
    if (suppressed) {
      summary.suppressed += 1;
    }
    summary.opened += await openOrRefreshViolation(
      pool,
      edge,
      verdict,
      suppressed,
      streak,
      asOf,
    );
  }
  return summary;
}

export async function loadMarketLeg(
  pool: ResolutionPool,
  conditionId: string,
  asOf: Date,
  config: ResolutionConfig,
): Promise<MarketLeg | null> {
  const market = await pool.query<Record<string, unknown>>(
    `SELECT clob_token_ids FROM polymarket_markets WHERE condition_id = $1`,
    [conditionId],
  );
  const tokens = market.rows[0]?.clob_token_ids;
  const tokenList = Array.isArray(tokens)
    ? (tokens as unknown[]).filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  // Node = the market's affirmative outcome: Gamma's clobTokenIds are
  // parallel to outcomes, and outcome 0 is the Yes/Up side in every recorded
  // binary market.
  const tokenId = tokenList[0];
  if (tokenId === undefined) {
    return null;
  }
  const params = await paramsAsOf(pool, conditionId, asOf);
  const feeRateBps =
    params?.takerFeeBps === null || params?.takerFeeBps === undefined
      ? null
      : parseScaled(params.takerFeeBps);
  if (feeRateBps === null || feeRateBps < 0n) {
    // Unknown fee = unpriceable costs = skip (fail closed), never zero.
    return null;
  }
  const feeRate = divRound(feeRateBps, 10_000n);
  const book = await bookAsOf(pool, tokenId, asOf);
  if (book === null) {
    return null;
  }
  const reference = book.sourceTs ?? book.receivedAt;
  if (asOf.getTime() - reference.getTime() > config.graph.maxBookAgeMs) {
    return null;
  }
  return {
    conditionId,
    tokenId,
    books: {
      bids: toScaledLevels(book.bids),
      asks: toScaledLevels(book.asks),
    },
    feeRate,
  };
}

async function closeViolation(
  pool: ResolutionPool,
  edgeKey: string,
  asOf: Date,
): Promise<number> {
  const result = await pool.query(
    `UPDATE graph_violations
        SET ended_at = $2,
            details_json = details_json ||
              jsonb_build_object('half_life_s',
                GREATEST(EXTRACT(EPOCH FROM ($2 - started_at)), 0)::bigint)
      WHERE edge_key = $1 AND ended_at IS NULL`,
    [edgeKey, asOf],
  );
  return result.rowCount;
}

async function openOrRefreshViolation(
  pool: ResolutionPool,
  edge: ActiveEdge,
  verdict: Extract<EdgeVerdict, { kind: "beyond" }>,
  suppressed: boolean,
  streak: number,
  asOf: Date,
): Promise<number> {
  const magnitudeNet = fmt(verdict.unitNet);
  const magnitudeBps = fmt(mul(verdict.unitNet, 10_000n * SCALE));
  const execSize = fmt(verdict.execSize);
  const execNotional = fmt(verdict.execNotional);
  const tolerance = fmt(verdict.tolerance);
  const updated = await pool.query(
    `UPDATE graph_violations
        SET last_seen_at = $2,
            snapshots_count = snapshots_count + 1,
            magnitude_net = $3,
            magnitude_bps = $4,
            executable_size = $5,
            executable_notional_usd = $6,
            suppressed = $7,
            signal_emitted = signal_emitted OR NOT $7,
            details_json = details_json || $8::jsonb
      WHERE edge_key = $1 AND ended_at IS NULL`,
    [
      edge.edgeKey,
      asOf,
      magnitudeNet,
      magnitudeBps,
      execSize,
      execNotional,
      suppressed,
      JSON.stringify(verdict.details),
    ],
  );
  if (updated.rowCount > 0) {
    return 0;
  }
  await pool.query(
    `INSERT INTO graph_violations
       (edge_id, edge_key, kind, started_at, last_seen_at, snapshots_count,
        magnitude_net, magnitude_bps, executable_size,
        executable_notional_usd, tolerance, suppressed, signal_emitted,
        details_json)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
    [
      edge.edgeId,
      edge.edgeKey,
      edge.kind,
      asOf,
      streak,
      magnitudeNet,
      magnitudeBps,
      execSize,
      execNotional,
      tolerance,
      suppressed,
      !suppressed,
      JSON.stringify(verdict.details),
    ],
  );
  return 1;
}
