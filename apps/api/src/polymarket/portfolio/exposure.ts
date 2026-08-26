// RFC-013 task 4: continuous exposure across every dimension the RFC names.
//
// Every cap is consumed at TOTAL LOSS of the position. A binary book can gap
// from a high price to near zero without trading the levels in between, so an
// exposure measured at mark-to-market is an exposure measured against a price
// that may never exist again. The notional paid is the number that matters.
//
// A negRisk group is one bet, not N: its legs are mutually exclusive by
// construction, so the group's worst case is the LARGEST leg rather than the
// sum — but the group still consumes the correlated-group cap as a unit,
// because they resolve together and inherit each other's resolution risk.

import { div, mul, SCALE } from "../fundamental/fixed.js";
import type { CapConfig } from "./config.js";
import { capHeadroom, capUtilization } from "./state.js";
import type { ExposureDimension } from "./types.js";

export interface OpenPosition {
  readonly tokenId: string;
  readonly conditionId: string;
  /** Signed shares: positive is long the token, negative is short. */
  readonly sharesScaled: bigint;
  /** Cost basis in USD, scaled. What a total loss would cost. */
  readonly costScaled: bigint;
  readonly category: string | null;
  readonly eventId: string | null;
  readonly resolutionSource: string | null;
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
  resolution_source: "fonteResolucao",
  factor: "grupoCorrelacionado",
  catalyst_window: "catalisadorJanela",
  locked_capital: "capitalBloqueado",
};

export const EXPOSURE_DIMENSION_CAP = DIMENSION_CAP;

interface Bucket {
  worstCase: bigint;
  count: number;
  unwind: bigint | null;
  /** negRisk groups take the max leg, everything else sums. */
  maxLeg: bigint;
  negRisk: boolean;
}

function emptyBucket(): Bucket {
  return { worstCase: 0n, count: 0, unwind: null, maxLeg: 0n, negRisk: false };
}

function addTo(
  map: Map<string, Bucket>,
  key: string,
  position: OpenPosition,
): void {
  const bucket = map.get(key) ?? emptyBucket();
  bucket.worstCase += position.costScaled;
  bucket.count += 1;
  if (position.costScaled > bucket.maxLeg) {
    bucket.maxLeg = position.costScaled;
  }
  if (position.negRisk) {
    bucket.negRisk = true;
  }
  if (position.unwindCostScaled !== null) {
    bucket.unwind = (bucket.unwind ?? 0n) + position.unwindCostScaled;
  }
  map.set(key, bucket);
}

/**
 * A negRisk event pays at most one leg, so holding every leg is not N times the
 * risk of holding one. The worst case for such a group is the largest leg.
 *
 * This is the ONLY place the sum is relaxed, and only for a structural reason
 * the adapter enforces on-chain (a [1, 1] report reverts). Everywhere else the
 * sum stands.
 */
function bucketWorstCase(bucket: Bucket): bigint {
  return bucket.negRisk && bucket.count > 1 ? bucket.maxLeg : bucket.worstCase;
}

export interface ExposureInput {
  readonly positions: readonly OpenPosition[];
  readonly bankrollScaled: bigint;
  readonly caps: CapConfig;
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

  let total = 0n;
  let totalUnwind: bigint | null = null;
  for (const position of input.positions) {
    total += position.costScaled;
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
      position.resolutionSource ?? "unknown",
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
      const worstCase = bucketWorstCase(bucket);
      rows.push({
        dimension,
        key,
        worstCaseScaled: worstCase,
        capScaled: mul(capFraction, input.bankrollScaled),
        utilizationScaled: capUtilization(
          capFraction,
          input.bankrollScaled,
          worstCase,
        ),
        positionCount: bucket.count,
        unwindCostScaled: bucket.unwind,
      });
    }
  }

  // The portfolio total has no cap of its own in the RFC — it is reported so
  // the panel and the alarm can see the whole book at once.
  rows.push({
    dimension: "total",
    key: "all",
    worstCaseScaled: total,
    capScaled: input.bankrollScaled,
    utilizationScaled:
      input.bankrollScaled > 0n ? div(total, input.bankrollScaled) : 0n,
    positionCount: input.positions.length,
    unwindCostScaled: totalUnwind,
  });

  return rows;
}

export interface CandidateExposure {
  readonly conditionId: string;
  readonly eventId: string | null;
  readonly category: string | null;
  readonly resolutionSource: string | null;
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
      used("resolution_source", candidate.resolutionSource ?? "unknown"),
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
