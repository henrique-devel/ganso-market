// RFC-013 tasks 1, 2, 3 and 6 joined: for one market at one instant, decide
// whether to enter, on which side, how much — and produce the opportunity panel
// that explains the answer either way.
//
// The panel is not a view built later from the decision: it is produced by the
// SAME evaluation, so a market shown as "almost entrable" and a market that was
// rejected can never disagree about why. A vetoed market always carries its
// veto reason (the migration enforces that with a CHECK).

import { div, mul, parseScaled, SCALE } from "../fundamental/fixed.js";
import type { PortfolioConfig } from "./config.js";
import {
  bookWalk,
  clearsEntryCriterion,
  computeEv,
  depthUpTo,
  money,
  type BookWalk,
  type EvBreakdown,
} from "./ev.js";
import {
  computeSize,
  slippageCappedSize,
  type SizingResult,
} from "./sizing.js";
import type {
  BookLevel,
  MarketSide,
  PortfolioStateName,
  RejectionCode,
} from "./types.js";

/** Probability strings from RFC-010 are 6-digit; scale them once, here. */
function prob(value: string): bigint | null {
  return parseScaled(value);
}

function fractionScaled(value: number): bigint {
  return BigInt(Math.round(value * Number(SCALE)));
}

export interface EvaluationInput {
  readonly now: Date;
  readonly config: PortfolioConfig;
  readonly conditionId: string;
  readonly tokenId: string;
  readonly question: string;
  readonly category: string | null;

  /** RFC-010 estimate for the AFFIRMATIVE token, and its age. */
  readonly q: string | null;
  readonly qLo: string | null;
  readonly qHi: string | null;
  readonly estimateSource: "MODEL" | "MARKET_BASELINE" | null;
  readonly estimateAgeMs: number | null;

  /** Recorded raw book for the affirmative token, and its age. */
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly bookAgeMs: number | null;

  /** RFC-012 state. Absent state fails closed. */
  readonly resolutionAction:
    "NONE" | "BUFFER" | "VETO" | "CIRCUIT_BREAKER" | null;
  readonly resolutionBuffer: string | null;
  readonly p5050: string | null;
  readonly expectedLockupS: number;
  readonly resolutionAgeMs: number | null;
  readonly rulePrecisionMultiplier: number;

  /**
   * Panel provenance (fields 9 and 10 of task 6). Pass-through: shown and
   * persisted, never an input to any arithmetic, which is why the replay
   * restores them from the persisted panel instead of duplicating them.
   */
  readonly resolutionSource: string | null;
  /** Relevant excerpt of the rule version in force. Truncated for the quota. */
  readonly ruleExcerpt: string | null;
  /** Correlated or contradictory markets, from the RFC-012 logical graph. */
  readonly correlatedMarkets: readonly string[];

  /** Venue parameters. */
  readonly takerFeeRate: string | null;
  readonly minOrderSize: string | null;
  readonly bufferDailyHurdle: number;

  /** Portfolio context. */
  readonly portfolioState: PortfolioStateName;
  readonly bankrollScaled: bigint;
  readonly capHeadroom: Readonly<Record<string, bigint>>;
  readonly correlationMultiplier: number;
  /** True while a portfolio-level circuit breaker is open for this market. */
  readonly breakerOpen: boolean;
}

export interface SideEvaluation {
  readonly side: MarketSide;
  readonly orderSide: "BUY" | "SELL";
  readonly ev: EvBreakdown;
  readonly walk: BookWalk;
  readonly clears: boolean;
}

export interface Evaluation {
  readonly entrable: boolean;
  readonly vetoed: boolean;
  readonly rejectionCode: RejectionCode | null;
  readonly vetoReason: string | null;
  /** Best side by net edge, even when it does not clear — the panel shows it. */
  readonly best: SideEvaluation | null;
  readonly sizing: SizingResult | null;
  readonly panel: PanelFields;
}

/** The 14 fields the RFC's task 6 requires, in its own order. */
export interface PanelFields {
  readonly market_probability: {
    readonly bid: string | null;
    readonly ask: string | null;
    readonly microprice: string | null;
  };
  readonly estimate: {
    readonly q: string | null;
    readonly q_lo: string | null;
    readonly q_hi: string | null;
    readonly source: string | null;
  };
  readonly suggested_side: MarketSide | null;
  readonly book: {
    readonly spread: string | null;
    readonly bids: readonly BookLevel[];
    readonly asks: readonly BookLevel[];
  };
  readonly edge: { readonly gross: string | null; readonly net: string | null };
  readonly costs: {
    readonly fee: string | null;
    readonly slippage: string | null;
    readonly capital: string | null;
    readonly resolution_buffer: string | null;
    readonly safety_margin: string | null;
  };
  readonly max_size: {
    readonly shares: string | null;
    readonly binding_constraint: string | null;
    readonly limiters: readonly { constraint: string; max_shares: string }[];
  };
  readonly resolution_risk: {
    readonly action: string | null;
    readonly buffer: string | null;
    readonly p_5050: string | null;
    readonly expected_lockup_s: number;
  };
  readonly resolution_source: string | null;
  /** Trecho relevante da regra vigente (field 9). */
  readonly rule_excerpt: string | null;
  readonly correlated_markets: readonly string[];
  readonly entry_reason: string | null;
  readonly invalidation_condition: string | null;
  /**
   * Field 12 as an EVALUABLE condition rather than prose: the level the
   * conservative estimate has to stay above for the thesis to hold. Prose in a
   * panel is not a monitored condition, and the RFC asks for one that is.
   *
   * It is a condition on the MODEL, deliberately not on the price. A condition
   * of the form "leave if the bid falls below X" would be a stop-loss wearing
   * another name, and a binary book can gap past X without ever trading it. The
   * price side of an exit is covered by the residual-edge and depth criteria,
   * which read what the book would actually pay.
   */
  readonly invalidation: {
    readonly prob_lower_below: string | null;
  };
  readonly data_freshness: {
    readonly book_age_ms: number | null;
    readonly estimate_age_ms: number | null;
    readonly resolution_age_ms: number | null;
  };
  readonly scenarios: {
    readonly likely: string | null;
    readonly best: string | null;
    /** Always total loss. There is no stop that changes this. */
    readonly worst: string;
    readonly fifty_fifty: string | null;
  };
}

function microprice(
  bids: readonly BookLevel[],
  asks: readonly BookLevel[],
): string | null {
  const bid = bids[0];
  const ask = asks[0];
  if (bid === undefined || ask === undefined) {
    return null;
  }
  const bidPrice = parseScaled(bid.price);
  const askPrice = parseScaled(ask.price);
  const bidSize = parseScaled(bid.size);
  const askSize = parseScaled(ask.size);
  if (
    bidPrice === null ||
    askPrice === null ||
    bidSize === null ||
    askSize === null ||
    bidSize + askSize <= 0n
  ) {
    return null;
  }
  // Size-weighted toward the side with less size, which is where the next
  // trade is more likely to happen. Reported only — never a decision input.
  return money(
    div(mul(bidPrice, askSize) + mul(askPrice, bidSize), bidSize + askSize),
  );
}

function spread(
  bids: readonly BookLevel[],
  asks: readonly BookLevel[],
): string | null {
  const bid = bids[0] === undefined ? null : parseScaled(bids[0].price);
  const ask = asks[0] === undefined ? null : parseScaled(asks[0].price);
  if (bid === null || ask === null) {
    return null;
  }
  return money(ask - bid);
}

/** Complementary book for the NO leg: buying NO is selling YES. */
function noSideLevels(bids: readonly BookLevel[]): BookLevel[] {
  const levels: BookLevel[] = [];
  for (const level of bids) {
    const price = parseScaled(level.price);
    if (price === null || price <= 0n || price >= SCALE) {
      continue;
    }
    levels.push({ price: money(SCALE - price), size: level.size });
  }
  return levels;
}

function emptyPanel(input: EvaluationInput): PanelFields {
  return {
    market_probability: {
      bid: input.bids[0]?.price ?? null,
      ask: input.asks[0]?.price ?? null,
      microprice: microprice(input.bids, input.asks),
    },
    estimate: {
      q: input.q,
      q_lo: input.qLo,
      q_hi: input.qHi,
      source: input.estimateSource,
    },
    suggested_side: null,
    book: {
      spread: spread(input.bids, input.asks),
      bids: input.bids.slice(0, 10),
      asks: input.asks.slice(0, 10),
    },
    edge: { gross: null, net: null },
    costs: {
      fee: null,
      slippage: null,
      capital: null,
      resolution_buffer: input.resolutionBuffer,
      safety_margin: null,
    },
    max_size: { shares: null, binding_constraint: null, limiters: [] },
    resolution_risk: {
      action: input.resolutionAction,
      buffer: input.resolutionBuffer,
      p_5050: input.p5050,
      expected_lockup_s: input.expectedLockupS,
    },
    resolution_source: input.resolutionSource,
    rule_excerpt: input.ruleExcerpt,
    correlated_markets: input.correlatedMarkets,
    entry_reason: null,
    invalidation_condition: null,
    invalidation: { prob_lower_below: null },
    data_freshness: {
      book_age_ms: input.bookAgeMs,
      estimate_age_ms: input.estimateAgeMs,
      resolution_age_ms: input.resolutionAgeMs,
    },
    scenarios: {
      likely: null,
      best: null,
      worst: "perda total da posição",
      fifty_fifty: input.p5050,
    },
  };
}

function reject(
  input: EvaluationInput,
  code: RejectionCode,
  reason: string,
  vetoed: boolean,
): Evaluation {
  return {
    entrable: false,
    vetoed,
    rejectionCode: code,
    vetoReason: vetoed ? reason : null,
    best: null,
    sizing: null,
    panel: { ...emptyPanel(input), entry_reason: reason },
  };
}

/**
 * Evaluate one market at one instant.
 *
 * The order of the gates matters: the cheap, categorical refusals (state,
 * staleness, veto) run before any arithmetic, so a vetoed market never produces
 * a tempting-looking edge that someone could be tempted to act on.
 */
export function evaluateMarket(input: EvaluationInput): Evaluation {
  const { config } = input;

  // 1. Portfolio state. REDUCE_ONLY and HALTED admit no new risk, ever.
  if (input.portfolioState === "HALTED") {
    return reject(input, "PORTFOLIO_HALTED", "portfólio em HALTED", false);
  }
  if (input.portfolioState === "REDUCE_ONLY") {
    return reject(
      input,
      "PORTFOLIO_REDUCE_ONLY",
      "portfólio em REDUCE_ONLY",
      false,
    );
  }
  if (input.breakerOpen) {
    return reject(
      input,
      "PORTFOLIO_CIRCUIT_BREAKER",
      "circuit breaker de portfólio aberto",
      false,
    );
  }

  // 2. RFC-012. Missing state fails CLOSED: the risk layer is exactly what an
  //    entry has to pass through, so its absence is not permission.
  if (input.resolutionAction === null) {
    return reject(
      input,
      "RESOLUTION_STATE_MISSING",
      "sem estado de risco de resolução",
      true,
    );
  }
  if (input.resolutionAction === "CIRCUIT_BREAKER") {
    return reject(
      input,
      "RESOLUTION_CIRCUIT_BREAKER",
      "RFC-012: circuit breaker (disputa ou salto sem catalisador)",
      true,
    );
  }
  if (input.resolutionAction === "VETO") {
    return reject(input, "RESOLUTION_VETO", "RFC-012: veto de resolução", true);
  }

  // 3. Freshness. A stale book is not a book.
  if (
    input.bookAgeMs === null ||
    input.bookAgeMs > config.staleness.bookMaxAgeMs
  ) {
    return reject(
      input,
      "BOOK_STALE",
      "livro fora do TTL de atualidade",
      false,
    );
  }
  if (
    input.estimateAgeMs === null ||
    input.estimateAgeMs > config.staleness.estimateMaxAgeMs
  ) {
    return reject(input, "DATA_STALE", "estimativa fora do TTL", false);
  }
  if (
    input.resolutionAgeMs === null ||
    input.resolutionAgeMs > config.staleness.resolutionMaxAgeMs
  ) {
    return reject(
      input,
      "DATA_STALE",
      "estado de resolução fora do TTL",
      false,
    );
  }

  // 4. Estimate.
  const qScaled = input.q === null ? null : prob(input.q);
  const qLoScaled = input.qLo === null ? null : prob(input.qLo);
  const qHiScaled = input.qHi === null ? null : prob(input.qHi);
  if (qScaled === null || qLoScaled === null || qHiScaled === null) {
    return reject(
      input,
      "ESTIMATE_MISSING",
      "sem estimativa utilizável",
      false,
    );
  }

  if (input.asks.length === 0 && input.bids.length === 0) {
    return reject(input, "NO_BOOK", "sem livro gravado", false);
  }

  // 5. Both legs, at a probe size of one share: the edge per share does not
  //    depend on the size, and the size is chosen afterwards from the limiters.
  const probeSize = SCALE;
  const noLevels = noSideLevels(input.bids);
  const legs: {
    side: MarketSide;
    orderSide: "BUY" | "SELL";
    levels: readonly BookLevel[];
  }[] = [
    { side: "YES", orderSide: "BUY", levels: input.asks },
    { side: "NO", orderSide: "SELL", levels: noLevels },
  ];

  const resolutionBufferScaled =
    input.resolutionBuffer === null ? 0n : (prob(input.resolutionBuffer) ?? 0n);

  let best: SideEvaluation | null = null;
  for (const leg of legs) {
    const walk = bookWalk(leg.levels, probeSize);
    if (walk === null) {
      continue;
    }
    const ev = computeEv({
      side: leg.side,
      qScaled,
      qLoScaled,
      qHiScaled,
      walk,
      takerFeeRateScaled:
        input.takerFeeRate === null ? null : prob(input.takerFeeRate),
      // The default intent is a passive post-only quote, which pays no fee.
      maker: true,
      expectedLockupS: input.expectedLockupS,
      capitalAnnualRateScaled: fractionScaled(config.costs.capitalCostAnnual),
      bufferDailyHurdleScaled: fractionScaled(input.bufferDailyHurdle),
      resolutionBufferScaled,
      safetyMarginMinScaled: fractionScaled(config.costs.safetyMarginMin),
      safetyMarginEdgeFractionScaled: fractionScaled(
        config.costs.safetyMarginEdgeFraction,
      ),
    });
    const candidate: SideEvaluation = {
      side: leg.side,
      orderSide: leg.orderSide,
      ev,
      walk,
      clears: clearsEntryCriterion(ev),
    };
    if (best === null || candidate.ev.edgeNetScaled > best.ev.edgeNetScaled) {
      best = candidate;
    }
  }

  if (best === null) {
    return reject(input, "NO_BOOK", "livro não caminhável", false);
  }

  const panelBase = emptyPanel(input);
  const withEdge: PanelFields = {
    ...panelBase,
    suggested_side: best.side,
    edge: {
      gross: money(best.ev.edgeGrossScaled),
      net: money(best.ev.edgeNetScaled),
    },
    costs: {
      fee: money(best.ev.feeScaled),
      slippage: money(best.ev.slippageScaled),
      capital: money(best.ev.capitalCostScaled),
      resolution_buffer: money(best.ev.resolutionBufferScaled),
      safety_margin: money(best.ev.safetyMarginScaled),
    },
    scenarios: {
      likely: money(best.ev.probLowerScaled),
      best: "1.000000",
      worst: "perda total da posição",
      fifty_fifty: input.p5050,
    },
  };

  // 6. Price band. Outside it the RFC does not trade, whatever the edge says:
  //    below $0.10 the structural anti-longshot bias dominates, above $0.95 the
  //    "edge" is mostly the cost of capital.
  const price = best.ev.execPriceScaled;
  if (
    price < fractionScaled(config.priceBand.minBuy) ||
    price > fractionScaled(config.priceBand.maxBuy)
  ) {
    return {
      entrable: false,
      vetoed: false,
      rejectionCode: "PRICE_OUT_OF_BAND",
      vetoReason: null,
      best,
      sizing: null,
      panel: { ...withEdge, entry_reason: "preço fora da banda permitida" },
    };
  }

  // 7. The entry criterion, on the LOWER bound.
  if (!best.clears) {
    return {
      entrable: false,
      vetoed: false,
      rejectionCode: "LOWER_BOUND_BELOW_COSTS",
      vetoReason: null,
      best,
      sizing: null,
      panel: {
        ...withEdge,
        entry_reason:
          "limite inferior não supera preço + custos + margem de segurança",
      },
    };
  }
  if (best.ev.edgeNetScaled < fractionScaled(config.costs.edgeLiqMin)) {
    return {
      entrable: false,
      vetoed: false,
      rejectionCode: "EDGE_BELOW_MIN",
      vetoReason: null,
      best,
      sizing: null,
      panel: { ...withEdge, entry_reason: "edge líquido abaixo do mínimo" },
    };
  }

  // 8. Size it.
  const legLevels = best.side === "YES" ? input.asks : noLevels;
  const scaledLevels = legLevels
    .map((level) => ({
      priceScaled: parseScaled(level.price) ?? 0n,
      sizeScaled: parseScaled(level.size) ?? 0n,
    }))
    .filter((level) => level.priceScaled > 0n && level.sizeScaled > 0n);

  const limitPrice = best.ev.execPriceScaled + best.ev.edgeNetScaled;
  const sizing = computeSize({
    probLowerScaled: best.ev.probLowerScaled,
    execPriceScaled: best.ev.execPriceScaled,
    intervalWidthScaled: qHiScaled - qLoScaled,
    kellyLambdaScaled: fractionScaled(config.kelly.lambda),
    uncertaintyShrinkSlopeScaled: fractionScaled(
      config.kelly.uncertaintyShrinkSlope,
    ),
    bankrollScaled: input.bankrollScaled,
    executableDepthScaled: depthUpTo(legLevels, limitPrice, "ask"),
    depthTakePctScaled: fractionScaled(config.depth.takePct),
    rulePrecisionMultiplierScaled: fractionScaled(
      input.rulePrecisionMultiplier,
    ),
    correlationMultiplierScaled: fractionScaled(input.correlationMultiplier),
    capHeadroom: input.capHeadroom,
    minOrderSizeScaled:
      input.minOrderSize === null
        ? 0n
        : (parseScaled(input.minOrderSize) ?? 0n),
    slippageCapSizeScaled: slippageCappedSize({
      levels: scaledLevels,
      grossEdgeScaled: best.ev.edgeGrossScaled,
      maxPctEdgeScaled: fractionScaled(config.costs.slippageMaxPctEdge),
    }),
  });

  const sizedPanel: PanelFields = {
    ...withEdge,
    max_size: {
      shares: money(sizing.sizeScaled),
      binding_constraint: sizing.bindingConstraint,
      limiters: sizing.limiters.map((limiter) => ({
        constraint: limiter.constraint,
        max_shares: money(limiter.maxSizeScaled),
      })),
    },
    entry_reason:
      `limite inferior ${money(best.ev.probLowerScaled)} supera preço executável ` +
      `${money(best.ev.execPriceScaled)} mais custos ${money(best.ev.costsTotalScaled)} ` +
      `e margem ${money(best.ev.safetyMarginScaled)}`,
    invalidation_condition:
      `limite inferior cair abaixo de ` +
      `${money(best.ev.execPriceScaled + best.ev.costsTotalScaled)} ` +
      `(preço executável mais custos): a razão para manter deixa de existir`,
    invalidation: {
      prob_lower_below: money(
        best.ev.execPriceScaled + best.ev.costsTotalScaled,
      ),
    },
  };

  if (sizing.sizeScaled <= 0n) {
    return {
      entrable: false,
      vetoed: false,
      rejectionCode:
        sizing.bindingConstraint === "MIN_ORDER_SIZE"
          ? "SIZE_BELOW_MIN_ORDER"
          : "CAP_EXHAUSTED",
      vetoReason: null,
      best,
      sizing,
      panel: sizedPanel,
    };
  }

  return {
    entrable: true,
    vetoed: false,
    rejectionCode: null,
    vetoReason: null,
    best,
    sizing,
    panel: sizedPanel,
  };
}
