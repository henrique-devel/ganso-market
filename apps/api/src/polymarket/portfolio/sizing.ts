// RFC-013 task 3: fractional Kelly as a CEILING, subject to hard limiters.
//
// The final size is the min() of every limiter below. Kelly is one of them, and
// never the target. No limiter can be turned off by a flag: the RFC makes that
// a stop condition, so there is deliberately no way to pass "skip this cap"
// into this module — a limiter is either computed or it is a bug.
//
// Every cap is consumed assuming TOTAL LOSS of the position. A binary book can
// gap from a high price to near zero, so sizing against a mark-to-market or a
// "stop-protected" fraction would be sizing against something that does not
// exist. There is no stop-loss anywhere in this module.

import { div, mul, SCALE } from "../fundamental/fixed.js";
import type { BindingConstraint } from "./types.js";

export interface LimiterValue {
  readonly constraint: BindingConstraint;
  /** Maximum size this limiter allows, in shares, scaled. */
  readonly maxSizeScaled: bigint;
  /** Human-readable note for the decision log and the panel. */
  readonly note: string;
}

export interface SizingInput {
  /** Conservative probability for the chosen side, scaled. */
  readonly probLowerScaled: bigint;
  /** Executable entry price per share, scaled. */
  readonly execPriceScaled: bigint;
  /** Interval width (q_hi - q_lo), scaled: the uncertainty shrink driver. */
  readonly intervalWidthScaled: bigint;
  /** Kelly multiplier in force, scaled. */
  readonly kellyLambdaScaled: bigint;
  /** Extra shrinkage per unit of interval width, scaled. */
  readonly uncertaintyShrinkSlopeScaled: bigint;
  /** Bankroll in USD, scaled. */
  readonly bankrollScaled: bigint;
  /** Executable depth up to the limit price, in shares, scaled. */
  readonly executableDepthScaled: bigint;
  /** Fraction of that depth the size may take, scaled. */
  readonly depthTakePctScaled: bigint;
  /** Rule-precision multiplier from RFC-012, in [0, 1], scaled. */
  readonly rulePrecisionMultiplierScaled: bigint;
  /** Correlation multiplier for the market's factor, in [0, 1], scaled. */
  readonly correlationMultiplierScaled: bigint;
  /** Remaining USD headroom of each portfolio cap, scaled. */
  readonly capHeadroom: Readonly<Record<string, bigint>>;
  /** Venue minimum order size in shares, scaled. */
  readonly minOrderSizeScaled: bigint;
  /** Slippage ceiling: max size whose slippage stays inside the edge share. */
  readonly slippageCapSizeScaled: bigint;
}

export interface SizingResult {
  /** Final size in shares, scaled. The min() of every limiter. */
  readonly sizeScaled: bigint;
  /** Kelly ceiling in shares, scaled — recorded, never used as the target. */
  readonly kellyCapSharesScaled: bigint;
  readonly notionalScaled: bigint;
  readonly bindingConstraint: BindingConstraint;
  readonly limiters: readonly LimiterValue[];
}

/**
 * Fractional Kelly for a binary payoff bought at price `a`:
 *
 *   f* = lambda x (p - a) / (1 - a)
 *
 * with `p` the CONSERVATIVE probability (q_lo for YES, 1 - q_hi for NO), never
 * the mean. lambda itself shrinks with the width of the estimate interval:
 * Baker & McHale show the optimal fraction falls as estimate uncertainty rises,
 * so a wide interval must not buy the same size as a tight one.
 */
export function kellyFraction(input: {
  readonly probLowerScaled: bigint;
  readonly execPriceScaled: bigint;
  readonly intervalWidthScaled: bigint;
  readonly kellyLambdaScaled: bigint;
  readonly uncertaintyShrinkSlopeScaled: bigint;
}): { fractionScaled: bigint; shrunkLambdaScaled: bigint } {
  const denominator = SCALE - input.execPriceScaled;
  if (denominator <= 0n) {
    return { fractionScaled: 0n, shrunkLambdaScaled: 0n };
  }
  const numerator = input.probLowerScaled - input.execPriceScaled;
  if (numerator <= 0n) {
    return { fractionScaled: 0n, shrunkLambdaScaled: input.kellyLambdaScaled };
  }
  // Shrink factor 1 / (1 + slope x width): 1 at zero width, falling smoothly as
  // the interval widens. Never negative, never above the configured lambda.
  const widthPenalty = mul(
    input.uncertaintyShrinkSlopeScaled,
    input.intervalWidthScaled,
  );
  const shrunkLambdaScaled = div(input.kellyLambdaScaled, SCALE + widthPenalty);
  const fractionScaled = mul(shrunkLambdaScaled, div(numerator, denominator));
  return { fractionScaled, shrunkLambdaScaled };
}

function sharesFromUsd(usdScaled: bigint, priceScaled: bigint): bigint {
  if (priceScaled <= 0n) {
    return 0n;
  }
  return div(usdScaled, priceScaled);
}

/**
 * Compute every limiter and return their min(), naming the one that bound.
 *
 * The limiters, in the order the RFC lists them:
 *  - the fractional Kelly ceiling;
 *  - depth_take_pct of the executable depth up to the limit price (book-walk on
 *    the recorded book, never a mid);
 *  - a reduction for estimate uncertainty (folded into the Kelly lambda above,
 *    and reported separately so it can be seen to have bound);
 *  - a reduction for correlation, at the FACTOR level;
 *  - the RFC-012 rule-precision multiplier (<= 1);
 *  - the remaining headroom of EVERY portfolio cap, assuming total loss;
 *  - the size whose slippage stays inside slippage_max_pct_edge.
 */
export function computeSize(input: SizingInput): SizingResult {
  const limiters: LimiterValue[] = [];

  const kelly = kellyFraction(input);
  const kellyUsdScaled = mul(input.bankrollScaled, kelly.fractionScaled);
  const kellyCapSharesScaled = sharesFromUsd(
    kellyUsdScaled,
    input.execPriceScaled,
  );
  limiters.push({
    constraint: "KELLY_CAP",
    maxSizeScaled: kellyCapSharesScaled,
    note: "fractional Kelly ceiling on the lower bound",
  });

  limiters.push({
    constraint: "DEPTH_TAKE_PCT",
    maxSizeScaled: mul(input.executableDepthScaled, input.depthTakePctScaled),
    note: "share of executable book-walk depth up to the limit price",
  });

  // Reported as its own limiter so a decision log can show uncertainty was what
  // bound the size, even though the shrink is applied inside lambda.
  const unshrunkKelly = kellyFraction({
    ...input,
    intervalWidthScaled: 0n,
  });
  limiters.push({
    constraint: "UNCERTAINTY_SHRINK",
    maxSizeScaled: sharesFromUsd(
      mul(input.bankrollScaled, unshrunkKelly.fractionScaled),
      input.execPriceScaled,
    ),
    note: "Kelly ceiling before the estimate-width shrink",
  });

  limiters.push({
    constraint: "CORRELATION_FACTOR",
    maxSizeScaled: mul(kellyCapSharesScaled, input.correlationMultiplierScaled),
    note: "factor-level correlation reduction",
  });

  limiters.push({
    constraint: "RULE_PRECISION",
    maxSizeScaled: mul(
      kellyCapSharesScaled,
      input.rulePrecisionMultiplierScaled,
    ),
    note: "RFC-012 rule-precision multiplier",
  });

  const capConstraints: readonly [string, BindingConstraint][] = [
    ["entrada", "CAP_ENTRADA"],
    ["mercado", "CAP_MERCADO"],
    ["grupoCorrelacionado", "CAP_GRUPO_CORRELACIONADO"],
    ["categoria", "CAP_CATEGORIA"],
    ["fonteResolucao", "CAP_FONTE_RESOLUCAO"],
    ["catalisadorJanela", "CAP_CATALISADOR_JANELA"],
    ["capitalBloqueado", "CAP_CAPITAL_BLOQUEADO"],
  ];
  for (const [key, constraint] of capConstraints) {
    const headroom = input.capHeadroom[key] ?? 0n;
    limiters.push({
      constraint,
      maxSizeScaled: sharesFromUsd(
        headroom > 0n ? headroom : 0n,
        input.execPriceScaled,
      ),
      note: "remaining cap headroom at total loss",
    });
  }

  limiters.push({
    constraint: "SLIPPAGE_MAX_PCT_EDGE",
    maxSizeScaled: input.slippageCapSizeScaled,
    note: "largest size whose slippage stays inside the edge share",
  });

  let bindingConstraint: BindingConstraint =
    limiters[0]?.constraint ?? "NOT_SIZED";
  let sizeScaled = limiters[0]?.maxSizeScaled ?? 0n;
  for (const limiter of limiters) {
    if (limiter.maxSizeScaled < sizeScaled) {
      sizeScaled = limiter.maxSizeScaled;
      bindingConstraint = limiter.constraint;
    }
  }
  if (sizeScaled < 0n) {
    sizeScaled = 0n;
  }

  // The venue minimum is not a cap to be maxed against — it is a floor below
  // which the order cannot exist at all. A size under it is no size.
  if (sizeScaled < input.minOrderSizeScaled) {
    return {
      sizeScaled: 0n,
      kellyCapSharesScaled,
      notionalScaled: 0n,
      bindingConstraint:
        sizeScaled <= 0n ? bindingConstraint : "MIN_ORDER_SIZE",
      limiters,
    };
  }

  return {
    sizeScaled,
    kellyCapSharesScaled,
    notionalScaled: mul(sizeScaled, input.execPriceScaled),
    bindingConstraint,
    limiters,
  };
}

/**
 * Largest size whose book-walk slippage stays within `slippage_max_pct_edge` of
 * the gross edge. Solved by walking the book rather than by inverting a formula:
 * the book is a step function, so the honest answer is the deepest level whose
 * cumulative VWAP still satisfies the constraint.
 */
export function slippageCappedSize(input: {
  readonly levels: readonly {
    readonly priceScaled: bigint;
    readonly sizeScaled: bigint;
  }[];
  readonly grossEdgeScaled: bigint;
  readonly maxPctEdgeScaled: bigint;
}): bigint {
  if (input.grossEdgeScaled <= 0n) {
    return 0n;
  }
  const allowance = mul(input.maxPctEdgeScaled, input.grossEdgeScaled);
  let notional = 0n;
  let taken = 0n;
  let best = 0n;
  let allowed = 0n;
  for (const level of input.levels) {
    if (level.priceScaled <= 0n || level.sizeScaled <= 0n) {
      break;
    }
    if (best === 0n) {
      best = level.priceScaled;
    }
    const candidateTaken = taken + level.sizeScaled;
    const candidateNotional =
      notional + mul(level.priceScaled, level.sizeScaled);
    const vwap = div(candidateNotional, candidateTaken);
    if (vwap - best > allowance) {
      // This level breaks the constraint; find how much of it still fits.
      // vwap(x) - best <= allowance  =>  notional + p*x <= (best + allowance) * (taken + x)
      const ceiling = best + allowance;
      const numerator = mul(ceiling, taken) - notional;
      const denominator = level.priceScaled - ceiling;
      if (denominator > 0n && numerator > 0n) {
        allowed = taken + div(numerator, denominator);
      } else {
        allowed = taken;
      }
      return allowed > 0n ? allowed : 0n;
    }
    taken = candidateTaken;
    notional = candidateNotional;
    allowed = taken;
  }
  return allowed;
}
