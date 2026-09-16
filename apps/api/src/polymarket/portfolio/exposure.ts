// FIN-04: residual maximum loss in nano-USD, isolated by financial owner.
// Paid fees are already in realized PnL; only unpaid fee bounds consume risk.
import { div, mul, SCALE } from "../fundamental/fixed.js";
import type { CapConfig } from "./config.js";
import { capHeadroom, capUtilization } from "./state.js";
import type { ExposureDimension } from "./types.js";

export interface OpenPosition {
  readonly accountId: string;
  readonly strategyId: string;
  /** Already debited in realized PnL; informational, never charged again. */
  readonly feesPaidScaled: bigint;
  readonly realizedPnlScaled: bigint;
  /** Bound on fees not yet debited. Runtime settlement currently charges zero. */
  readonly remainingFeesScaled: bigint;
  readonly tokenId: string;
  readonly conditionId: string;
  /** Signed shares: positive is long the token, negative is short. */
  readonly sharesScaled: bigint;
  /** Gross basis: paid cost for longs, received proceeds for legacy shorts. */
  readonly costScaled: bigint;
  readonly category: string | null;
  readonly eventId: string | null;
  /**
   * RFC-018 D2: the family of resolution CLAUSE, not the adapter. Never null —
   * an unclassifiable clause gets the NAMED fallback family, because a silent
   * "unknown" is how the oversized bucket comes back under another name.
   */
  readonly clauseFamily: string;
  readonly factor: string;
  readonly catalystWindow: string;
  /** True while the market has not resolved: counts as locked capital. */
  readonly unresolved: boolean;
  /** Estimated cost of unwinding, from the exit book-walk. Null = no book. */
  readonly unwindCostScaled: bigint | null;
  /** True when this market belongs to a negRisk event. */
  readonly negRisk: boolean;
}

export interface ExposureRow {
  readonly riskVersion: "payoff-v1";
  readonly aggregation: "conservative_sum" | "proven_scenarios" | "mixed";
  readonly proofRefs: readonly string[];
  /** Informational totals for positions represented by THIS row; not all R/F. */
  readonly feesPaidScaled: bigint;
  readonly realizedPnlScaled: bigint;
  readonly dimension: ExposureDimension;
  readonly key: string;
  readonly worstCaseScaled: bigint;
  readonly capScaled: bigint;
  readonly utilizationScaled: bigint;
  readonly positionCount: number;
  readonly unwindCostScaled: bigint | null;
}

/** Which cap governs each dimension; `total` and `locked_capital` are special. */
const DIMENSION_CAP: Readonly<
  Record<Exclude<ExposureDimension, "total">, keyof CapConfig>
> = {
  market: "mercado",
  event: "grupoCorrelacionado",
  category: "categoria",
  // RFC-018 D2 changed what this dimension is KEYED on — the family of
  // resolution clause instead of the adapter — and deliberately not its name:
  // it is the same cap (`caps.fonteResolucao`, still 0.25) answering the same
  // question, with a key that groups by how a market can fail rather than by
  // which contract reports it.
  resolution_source: "fonteResolucao",
  factor: "grupoCorrelacionado",
  catalyst_window: "catalisadorJanela",
  locked_capital: "capitalBloqueado",
};

export const EXPOSURE_DIMENSION_CAP = DIMENSION_CAP;

/**
 * Trusted contract evidence, supplied only after an upstream verifier establishes
 * the COMPLETE admissible scenario set (including uncovered outcomes/voids).
 * Metadata flags are not evidence. FIN-04's runner supplies no proofs.
 * Each scenario maps every listed token to its payout in [0,1]. A partial,
 * ambiguous or malformed proof falls back to a labelled conservative sum.
 */
export interface PayoffProof {
  readonly version: "payoff-scenarios-v1";
  readonly evidenceRef: string;
  readonly complete: boolean;
  readonly scope: { readonly kind: "event" | "condition"; readonly id: string };
  readonly tokens: readonly {
    readonly tokenId: string;
    readonly conditionId: string;
  }[];
  readonly scenarios: readonly Readonly<Record<string, bigint>>[];
}

function validProof(proof: PayoffProof): boolean {
  const tokens = proof.tokens.map((token) => token.tokenId);
  return (
    proof.version === "payoff-scenarios-v1" &&
    proof.complete &&
    proof.evidenceRef.trim().length > 0 &&
    proof.scope.id.length > 0 &&
    tokens.length > 0 &&
    new Set(tokens).size === tokens.length &&
    proof.tokens.every(
      (token) =>
        token.tokenId.length > 0 &&
        token.conditionId.length > 0 &&
        (proof.scope.kind !== "condition" ||
          token.conditionId === proof.scope.id),
    ) &&
    proof.scenarios.length > 0 &&
    proof.scenarios.every(
      (scenario) =>
        Object.keys(scenario).length === tokens.length &&
        tokens.every(
          (token) =>
            typeof scenario[token] === "bigint" &&
            scenario[token]! >= 0n &&
            scenario[token]! <= SCALE,
        ),
    )
  );
}

/** Floor signed payouts, so a fractional nano-dollar never understates loss. */
function payoutFloor(shares: bigint, payout: bigint): bigint {
  const product = shares * payout;
  return product / SCALE - (product < 0n && product % SCALE !== 0n ? 1n : 0n);
}

function lossAt(position: OpenPosition, payout: bigint): bigint {
  const signedBasis =
    position.sharesScaled < 0n ? -position.costScaled : position.costScaled;
  return (
    signedBasis +
    position.remainingFeesScaled -
    payoutFloor(position.sharesScaled, payout)
  );
}

function riskOf(
  positions: readonly OpenPosition[],
  proofs: readonly PayoffProof[],
) {
  let worstCaseScaled = 0n;
  let conservative = false;
  const groups = new Map<
    string,
    { proof: PayoffProof; positions: OpenPosition[] }
  >();
  const proofRefs = new Set<string>();
  for (const position of positions) {
    const matches = proofs.filter(
      (proof) =>
        (proof.scope.kind === "condition"
          ? position.conditionId
          : position.eventId) === proof.scope.id &&
        proof.tokens.some(
          (token) =>
            token.tokenId === position.tokenId &&
            token.conditionId === position.conditionId,
        ),
    );
    if (matches.length !== 1) {
      conservative = true;
      const loss = lossAt(position, position.sharesScaled < 0n ? SCALE : 0n);
      worstCaseScaled += loss > 0n ? loss : 0n;
      continue;
    }
    const proof = matches[0]!;
    const key = JSON.stringify([
      position.accountId,
      position.strategyId,
      proofs.indexOf(proof),
    ]);
    const group = groups.get(key) ?? { proof, positions: [] };
    group.positions.push(position);
    groups.set(key, group);
  }
  for (const { proof, positions: group } of groups.values()) {
    let worst = 0n;
    for (const scenario of proof.scenarios) {
      const loss = group.reduce(
        (sum, position) => sum + lossAt(position, scenario[position.tokenId]!),
        0n,
      );
      if (loss > worst) worst = loss;
    }
    worstCaseScaled += worst;
    proofRefs.add(proof.evidenceRef);
  }
  const aggregation: ExposureRow["aggregation"] =
    groups.size === 0
      ? "conservative_sum"
      : conservative
        ? "mixed"
        : "proven_scenarios";
  return {
    worstCaseScaled,
    aggregation,
    proofRefs: [...proofRefs],
    riskVersion: "payoff-v1" as const,
    feesPaidScaled: positions.reduce((sum, p) => sum + p.feesPaidScaled, 0n),
    realizedPnlScaled: positions.reduce(
      (sum, p) => sum + p.realizedPnlScaled,
      0n,
    ),
  };
}

interface Bucket {
  positions: OpenPosition[];
  unwind: bigint | null;
}

function addTo(
  map: Map<string, Bucket>,
  key: string,
  position: OpenPosition,
): void {
  const bucket = map.get(key) ?? { positions: [], unwind: null };
  bucket.positions.push(position);
  if (position.unwindCostScaled !== null) {
    bucket.unwind = (bucket.unwind ?? 0n) + position.unwindCostScaled;
  }
  map.set(key, bucket);
}

export interface ExposureInput {
  readonly positions: readonly OpenPosition[];
  readonly bankrollScaled: bigint;
  readonly caps: CapConfig;
  readonly payoffProofs?: readonly PayoffProof[];
}

function capFractionScaled(fraction: number): bigint {
  return BigInt(Math.round(fraction * Number(SCALE)));
}

/** Compute every exposure row from the open positions. */
export function computeExposures(input: ExposureInput): ExposureRow[] {
  type CappedDimension = keyof typeof DIMENSION_CAP;
  const byDimension = new Map<CappedDimension, Map<string, Bucket>>();
  for (const dimension of Object.keys(DIMENSION_CAP) as CappedDimension[]) {
    byDimension.set(dimension, new Map<string, Bucket>());
  }

  const proofs = (input.payoffProofs ?? []).filter(validProof);
  for (const p of input.positions) {
    if (
      !p.tokenId ||
      !p.conditionId ||
      !p.accountId ||
      !p.strategyId ||
      p.costScaled < 0n ||
      p.remainingFeesScaled < 0n ||
      p.feesPaidScaled < 0n ||
      (p.sharesScaled === 0n && p.costScaled !== 0n)
    )
      throw new Error("FIN04_INVALID_POSITION");
  }
  const totalRisk = riskOf(input.positions, proofs);
  let totalUnwind: bigint | null = null;
  for (const position of input.positions) {
    if (position.unwindCostScaled !== null) {
      totalUnwind = (totalUnwind ?? 0n) + position.unwindCostScaled;
    }
    addTo(byDimension.get("market")!, position.conditionId, position);
    addTo(
      byDimension.get("event")!,
      position.eventId ?? `market:${position.conditionId}`,
      position,
    );
    addTo(
      byDimension.get("category")!,
      position.category ?? "unknown",
      position,
    );
    addTo(
      byDimension.get("resolution_source")!,
      position.clauseFamily,
      position,
    );
    addTo(byDimension.get("factor")!, position.factor, position);
    addTo(
      byDimension.get("catalyst_window")!,
      position.catalystWindow,
      position,
    );
    if (position.unresolved) {
      addTo(byDimension.get("locked_capital")!, "all", position);
    }
  }

  const rows: ExposureRow[] = [];
  for (const [dimension, buckets] of byDimension) {
    const capKey = DIMENSION_CAP[dimension];
    const capFraction = capFractionScaled(input.caps[capKey]);
    for (const [key, bucket] of buckets) {
      const risk = riskOf(bucket.positions, proofs);
      const worstCase = risk.worstCaseScaled;
      rows.push({
        dimension,
        key,
        ...risk,
        capScaled: mul(capFraction, input.bankrollScaled),
        utilizationScaled: capUtilization(
          capFraction,
          input.bankrollScaled,
          worstCase,
        ),
        positionCount: bucket.positions.length,
        unwindCostScaled: bucket.unwind,
      });
    }
  }

  // The portfolio total has no cap of its own in the RFC — it is reported so
  // the panel and the alarm can see the whole book at once.
  rows.push({
    dimension: "total",
    key: "all",
    ...totalRisk,
    capScaled: input.bankrollScaled,
    utilizationScaled:
      input.bankrollScaled > 0n
        ? div(totalRisk.worstCaseScaled, input.bankrollScaled)
        : 0n,
    positionCount: input.positions.length,
    unwindCostScaled: totalUnwind,
  });

  return rows;
}

export interface CandidateExposure {
  readonly conditionId: string;
  readonly eventId: string | null;
  readonly category: string | null;
  /** RFC-018 D2: the family of resolution clause. Never null. */
  readonly clauseFamily: string;
  readonly factor: string;
  readonly catalystWindow: string;
}

/**
 * Remaining USD headroom of every cap a candidate entry would consume.
 *
 * A missing bucket means "nothing used yet", which is full headroom — but a
 * missing CAP is never treated as unlimited: every dimension in DIMENSION_CAP
 * is always present in the result, so the sizing min() cannot skip one by
 * accident.
 */
export function capHeadroomFor(
  rows: readonly ExposureRow[],
  candidate: CandidateExposure,
  bankrollScaled: bigint,
  caps: CapConfig,
): Record<string, bigint> {
  const used = (dimension: ExposureDimension, key: string): bigint =>
    rows.find((row) => row.dimension === dimension && row.key === key)
      ?.worstCaseScaled ?? 0n;

  const headroom: Record<string, bigint> = {
    // The per-entry cap is measured against the bankroll alone: it bounds one
    // entry, not the accumulated book.
    entrada: mul(capFractionScaled(caps.entrada), bankrollScaled),
    mercado: capHeadroom(
      capFractionScaled(caps.mercado),
      bankrollScaled,
      used("market", candidate.conditionId),
    ),
    categoria: capHeadroom(
      capFractionScaled(caps.categoria),
      bankrollScaled,
      used("category", candidate.category ?? "unknown"),
    ),
    fonteResolucao: capHeadroom(
      capFractionScaled(caps.fonteResolucao),
      bankrollScaled,
      used("resolution_source", candidate.clauseFamily),
    ),
    catalisadorJanela: capHeadroom(
      capFractionScaled(caps.catalisadorJanela),
      bankrollScaled,
      used("catalyst_window", candidate.catalystWindow),
    ),
    capitalBloqueado: capHeadroom(
      capFractionScaled(caps.capitalBloqueado),
      bankrollScaled,
      used("locked_capital", "all"),
    ),
  };

  // The correlated-group cap is the TIGHTER of the negRisk event and the
  // economic factor. They are different groupings of the same idea — "this is
  // one bet" — and a candidate that is inside one but outside the other is
  // outside.
  const eventKey = candidate.eventId ?? `market:${candidate.conditionId}`;
  const eventHeadroom = capHeadroom(
    capFractionScaled(caps.grupoCorrelacionado),
    bankrollScaled,
    used("event", eventKey),
  );
  const factorHeadroom = capHeadroom(
    capFractionScaled(caps.grupoCorrelacionado),
    bankrollScaled,
    used("factor", candidate.factor),
  );
  headroom.grupoCorrelacionado =
    eventHeadroom < factorHeadroom ? eventHeadroom : factorHeadroom;

  return headroom;
}

/**
 * Aggregate unwind cost against the open PnL, for the liquidity alarm: when
 * getting out would cost more than X% of what the book is up, the book is not
 * as liquid as its marks suggest.
 */
export function unwindAlarm(
  rows: readonly ExposureRow[],
  openPnlScaled: bigint,
  thresholdScaled: bigint,
): { triggered: boolean; ratioScaled: bigint | null } {
  const totalRow = rows.find((row) => row.dimension === "total");
  const unwind = totalRow?.unwindCostScaled ?? null;
  if (unwind === null || openPnlScaled <= 0n) {
    return { triggered: false, ratioScaled: null };
  }
  const ratio = div(unwind, openPnlScaled);
  return { triggered: ratio > thresholdScaled, ratioScaled: ratio };
}
