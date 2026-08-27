// RFC-013 versioned portfolio configuration. Same pattern as the RFC-010/012
// modules: one JSON file named by one env var, frozen in-code defaults when
// unset, and a parser that fails closed on unknown keys and out-of-range
// values.
//
// Every numeric parameter of the RFC lives here, and every decision persists
// the hash of the version in force. A parameter change mints a NEW version and
// never rewrites a past decision — the RFC makes that non-negotiable, and the
// portfolio_config_versions table enforces it with an immutability trigger.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PORTFOLIO_CONFIG_FILE_ENV = "GANSO_PORTFOLIO_CONFIG_FILE";

export class PortfolioConfigError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "PortfolioConfigError";
    this.reasonCode = reasonCode;
  }
}

export interface KellyConfig {
  /**
   * Fractional Kelly multiplier. Baker & McHale: under estimate uncertainty the
   * optimal Kelly fraction shrinks, and half-Kelly approximates the optimum.
   * 0.25 is the RFC default; 0.5 is the ceiling, and only with a track record
   * that already cleared G1 — which is why maxLambda is a separate field the
   * gate reads, never a flag an operator flips.
   */
  readonly lambda: number;
  readonly maxLambda: number;
  /**
   * Extra shrinkage applied per unit of interval width (q_hi - q_lo). The wider
   * the estimate, the smaller the ceiling.
   */
  readonly uncertaintyShrinkSlope: number;
}

export interface CostConfig {
  /** Floor of the safety margin, per share, in price units. */
  readonly safetyMarginMin: number;
  /** Safety margin as a fraction of the gross edge; the max() of the two wins. */
  readonly safetyMarginEdgeFraction: number;
  /** Annual cost of capital charged over E[lockup]. */
  readonly capitalCostAnnual: number;
  /** Slippage ceiling as a fraction of the gross edge. */
  readonly slippageMaxPctEdge: number;
  /** Minimum net edge per share after every cost. */
  readonly edgeLiqMin: number;
}

export interface PriceBandConfig {
  readonly minBuy: number;
  readonly maxBuy: number;
}

export interface DepthConfig {
  /** Share of the executable depth up to the limit price the size may take. */
  readonly takePct: number;
}

/** Caps as fractions of the bankroll. Every one is consumed at TOTAL LOSS. */
export interface CapConfig {
  readonly entrada: number;
  readonly mercado: number;
  readonly grupoCorrelacionado: number;
  readonly categoria: number;
  readonly fonteResolucao: number;
  readonly catalisadorJanela: number;
  readonly capitalBloqueado: number;
}

export interface LossLimitConfig {
  readonly perdaDiariaMax: number;
  readonly perdaSemanalMax: number;
  readonly drawdownMax: number;
  /** How long a weekly-loss REDUCE_ONLY lasts, in days. */
  readonly reduceOnlyWeekDays: number;
}

export interface ExitConfig {
  /** Residual edge at the executable bid below which the position is exited. */
  readonly edgeResidualMin: number;
  /** How far q may leave the entry band before the exit triggers. */
  readonly modelMoveThreshold: number;
  /** Depth floor, in shares, below which liquidity counts as degraded. */
  readonly depthFloorShares: number;
  /** Blackout window before a known catalyst, in minutes, by category. */
  readonly catalystBlackoutMin: number;
  /**
   * Liquidity alarm: fraction of the OPEN PnL above which the estimated cost of
   * unwinding the whole book counts as an alarm. The RFC states the control
   * ("alarme quando unwind estimado > X% do PnL aberto") and leaves X to the
   * config, which is why it is a versioned parameter and not a constant.
   */
  readonly unwindAlarmPctOpenPnl: number;
}

export interface StalenessConfig {
  /** Book older than this is stale: no signal, and a staleness breaker. */
  readonly bookMaxAgeMs: number;
  /** Estimate older than this cannot support an entry. */
  readonly estimateMaxAgeMs: number;
  /** Resolution-risk state older than this cannot support an entry. */
  readonly resolutionMaxAgeMs: number;
}

export interface BreakerConfig {
  /** Mid move within jumpWindowMs with no known catalyst freezes entries. */
  readonly jumpThreshold: number;
  readonly jumpWindowMs: number;
}

export interface GateConfig {
  /** G1: resolved markets required, and the Brier ceiling for the used signal. */
  readonly g1MinResolvedMarkets: number;
  readonly g1MaxBrier: number;
  /** G2: continuous paper days, closed positions, distinct markets/categories. */
  readonly g2MinDays: number;
  readonly g2MinClosedPositions: number;
  readonly g2MinDistinctMarkets: number;
  readonly g2MinCategories: number;
  /**
   * G2 dispersion: distinct UTC days on which positions closed.
   *
   * The RFC's "60 dias corridos" describes the CLOCK, not the evidence. A
   * hundred positions closed inside one afternoon of a 60-day run is a burst,
   * and a block bootstrap over a burst resamples one market episode.
   */
  readonly g2MinDistinctCloseDays: number;
  /**
   * G2 dispersion: independent blocks the sample must support, i.e.
   * floor(n / blockSize). At the RFC's own floor (100 positions, blocks of 10)
   * this is exactly 10 and binds nothing; it binds when the block grows or the
   * sample shrinks, which is when the interval stops meaning anything.
   */
  readonly g2MinBootstrapBlocks: number;
  /**
   * G2 dispersion: the largest share of the gross moved PnL (sum of absolute
   * values) that a SINGLE closed position may account for. One position at a
   * quarter of the whole book makes "100 closed positions" a fiction.
   */
  readonly g2MaxSinglePositionPnlShare: number;
  /** Haircut applied to the realized edge before the CI is taken. */
  readonly g2EdgeHaircut: number;
  /** Block-bootstrap resamples and block length, in closed positions. */
  readonly bootstrapResamples: number;
  readonly bootstrapBlockSize: number;
  /** Fixed seed: the RFC requires the bootstrap to be reproducible. */
  readonly bootstrapSeed: number;
  /** G4: median relative error allowed between simulated and real fees. */
  readonly g4MaxFeeMedianError: number;
  /**
   * G4: independent reconciliation samples required on EACH leg (fee and
   * slippage) before the gate reports a verdict at all. One reconciled fill is
   * not a reconciliation, and a median over one sample is that sample.
   */
  readonly g4MinReconciledFills: number;
  readonly g4MinSoakDays: number;
}

export interface CadenceConfig {
  readonly panelMs: number;
  readonly exposureMs: number;
  readonly exitMs: number;
  readonly gateMs: number;
  readonly reportMs: number;
}

export interface PortfolioConfig {
  /** Version name; pins a portfolio_config_versions row with the hash. */
  readonly version: string;
  /**
   * Simulated notional bankroll, in USD. There is no real capital anywhere in
   * this module: this number exists so the RFC's percent-of-bankroll caps have
   * a denominator. RFC-009 is what would ever attach real capital, and it stays
   * blocked until every gate passes.
   */
  readonly bankrollUsd: number;
  readonly kelly: KellyConfig;
  readonly costs: CostConfig;
  readonly priceBand: PriceBandConfig;
  readonly depth: DepthConfig;
  readonly caps: CapConfig;
  readonly lossLimits: LossLimitConfig;
  readonly exits: ExitConfig;
  readonly staleness: StalenessConfig;
  readonly breakers: BreakerConfig;
  readonly gates: GateConfig;
  readonly cadence: CadenceConfig;
}

/**
 * The RFC-013 "Parâmetros default" table, verbatim. Changing any of these is a
 * new config version, never an edit in place.
 */
export const DEFAULT_PORTFOLIO_CONFIG: PortfolioConfig = Object.freeze({
  version: "1.2.0",
  bankrollUsd: 1_000,
  kelly: Object.freeze({
    lambda: 0.25,
    maxLambda: 0.5,
    uncertaintyShrinkSlope: 1,
  }),
  costs: Object.freeze({
    safetyMarginMin: 0.01,
    safetyMarginEdgeFraction: 0.25,
    capitalCostAnnual: 0.12,
    slippageMaxPctEdge: 0.25,
    edgeLiqMin: 0.02,
  }),
  priceBand: Object.freeze({ minBuy: 0.1, maxBuy: 0.95 }),
  depth: Object.freeze({ takePct: 0.15 }),
  caps: Object.freeze({
    entrada: 0.02,
    mercado: 0.05,
    grupoCorrelacionado: 0.2,
    categoria: 0.35,
    fonteResolucao: 0.25,
    catalisadorJanela: 0.25,
    capitalBloqueado: 0.6,
  }),
  lossLimits: Object.freeze({
    perdaDiariaMax: 0.03,
    perdaSemanalMax: 0.06,
    drawdownMax: 0.1,
    reduceOnlyWeekDays: 7,
  }),
  exits: Object.freeze({
    edgeResidualMin: 0.01,
    modelMoveThreshold: 0.05,
    depthFloorShares: 50,
    catalystBlackoutMin: 30,
    unwindAlarmPctOpenPnl: 0.25,
  }),
  staleness: Object.freeze({
    bookMaxAgeMs: 30_000,
    estimateMaxAgeMs: 300_000,
    resolutionMaxAgeMs: 3_600_000,
  }),
  breakers: Object.freeze({ jumpThreshold: 0.15, jumpWindowMs: 300_000 }),
  gates: Object.freeze({
    g1MinResolvedMarkets: 100,
    g1MaxBrier: 0.2,
    g2MinDays: 60,
    g2MinClosedPositions: 100,
    g2MinDistinctMarkets: 30,
    g2MinCategories: 2,
    g2MinDistinctCloseDays: 20,
    g2MinBootstrapBlocks: 10,
    g2MaxSinglePositionPnlShare: 0.25,
    g2EdgeHaircut: 0.5,
    bootstrapResamples: 2_000,
    bootstrapBlockSize: 10,
    bootstrapSeed: 20_260_825,
    g4MaxFeeMedianError: 0.05,
    g4MinReconciledFills: 100,
    g4MinSoakDays: 30,
  }),
  cadence: Object.freeze({
    panelMs: 60_000,
    exposureMs: 60_000,
    exitMs: 30_000,
    gateMs: 3_600_000,
    reportMs: 7 * 24 * 3_600_000,
  }),
});

function fail(reasonCode: string, message: string): never {
  throw new PortfolioConfigError(reasonCode, message);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("PORTFOLIO_CONFIG_INVALID", `${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  raw: Record<string, unknown>,
  known: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) {
      fail(
        "PORTFOLIO_CONFIG_UNKNOWN_KEY",
        `${where}.${key} is not a known key`,
      );
    }
  }
}

interface NumberBounds {
  readonly min: number;
  readonly max: number;
}

function num(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  bounds: NumberBounds,
  where: string,
): number {
  const value = raw[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("PORTFOLIO_CONFIG_INVALID", `${where}.${key} must be a finite number`);
  }
  if (value < bounds.min || value > bounds.max) {
    fail(
      "PORTFOLIO_CONFIG_OUT_OF_RANGE",
      `${where}.${key} must be within [${String(bounds.min)}, ${String(bounds.max)}]`,
    );
  }
  return value;
}

const FRACTION: NumberBounds = { min: 0, max: 1 };
const POSITIVE: NumberBounds = { min: 0, max: Number.MAX_SAFE_INTEGER };

export function parsePortfolioConfig(raw: unknown): PortfolioConfig {
  const defaults = DEFAULT_PORTFOLIO_CONFIG;
  const top = record(raw, "portfolio");
  rejectUnknownKeys(
    top,
    [
      "version",
      "bankrollUsd",
      "kelly",
      "costs",
      "priceBand",
      "depth",
      "caps",
      "lossLimits",
      "exits",
      "staleness",
      "breakers",
      "gates",
      "cadence",
    ],
    "portfolio",
  );

  const version = top.version ?? defaults.version;
  if (
    typeof version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)
  ) {
    fail("PORTFOLIO_CONFIG_INVALID", "portfolio.version must be semver-like");
  }

  const kellyRaw = record(top.kelly ?? {}, "portfolio.kelly");
  rejectUnknownKeys(
    kellyRaw,
    ["lambda", "maxLambda", "uncertaintyShrinkSlope"],
    "portfolio.kelly",
  );
  const kelly: KellyConfig = {
    lambda: num(kellyRaw, "lambda", defaults.kelly.lambda, FRACTION, "kelly"),
    maxLambda: num(
      kellyRaw,
      "maxLambda",
      defaults.kelly.maxLambda,
      FRACTION,
      "kelly",
    ),
    uncertaintyShrinkSlope: num(
      kellyRaw,
      "uncertaintyShrinkSlope",
      defaults.kelly.uncertaintyShrinkSlope,
      { min: 0, max: 10 },
      "kelly",
    ),
  };
  if (kelly.lambda > kelly.maxLambda) {
    fail(
      "PORTFOLIO_CONFIG_OUT_OF_RANGE",
      "portfolio.kelly.lambda cannot exceed maxLambda",
    );
  }

  const costsRaw = record(top.costs ?? {}, "portfolio.costs");
  rejectUnknownKeys(
    costsRaw,
    [
      "safetyMarginMin",
      "safetyMarginEdgeFraction",
      "capitalCostAnnual",
      "slippageMaxPctEdge",
      "edgeLiqMin",
    ],
    "portfolio.costs",
  );
  const costs: CostConfig = {
    safetyMarginMin: num(
      costsRaw,
      "safetyMarginMin",
      defaults.costs.safetyMarginMin,
      FRACTION,
      "costs",
    ),
    safetyMarginEdgeFraction: num(
      costsRaw,
      "safetyMarginEdgeFraction",
      defaults.costs.safetyMarginEdgeFraction,
      FRACTION,
      "costs",
    ),
    capitalCostAnnual: num(
      costsRaw,
      "capitalCostAnnual",
      defaults.costs.capitalCostAnnual,
      { min: 0, max: 5 },
      "costs",
    ),
    slippageMaxPctEdge: num(
      costsRaw,
      "slippageMaxPctEdge",
      defaults.costs.slippageMaxPctEdge,
      FRACTION,
      "costs",
    ),
    edgeLiqMin: num(
      costsRaw,
      "edgeLiqMin",
      defaults.costs.edgeLiqMin,
      FRACTION,
      "costs",
    ),
  };

  const bandRaw = record(top.priceBand ?? {}, "portfolio.priceBand");
  rejectUnknownKeys(bandRaw, ["minBuy", "maxBuy"], "portfolio.priceBand");
  const priceBand: PriceBandConfig = {
    minBuy: num(
      bandRaw,
      "minBuy",
      defaults.priceBand.minBuy,
      FRACTION,
      "priceBand",
    ),
    maxBuy: num(
      bandRaw,
      "maxBuy",
      defaults.priceBand.maxBuy,
      FRACTION,
      "priceBand",
    ),
  };
  if (priceBand.minBuy >= priceBand.maxBuy) {
    fail(
      "PORTFOLIO_CONFIG_OUT_OF_RANGE",
      "portfolio.priceBand.minBuy must be below maxBuy",
    );
  }

  const depthRaw = record(top.depth ?? {}, "portfolio.depth");
  rejectUnknownKeys(depthRaw, ["takePct"], "portfolio.depth");
  const depth: DepthConfig = {
    takePct: num(
      depthRaw,
      "takePct",
      defaults.depth.takePct,
      FRACTION,
      "depth",
    ),
  };

  const capsRaw = record(top.caps ?? {}, "portfolio.caps");
  const capKeys = [
    "entrada",
    "mercado",
    "grupoCorrelacionado",
    "categoria",
    "fonteResolucao",
    "catalisadorJanela",
    "capitalBloqueado",
  ] as const;
  rejectUnknownKeys(capsRaw, capKeys, "portfolio.caps");
  const caps = Object.fromEntries(
    capKeys.map((key) => [
      key,
      num(capsRaw, key, defaults.caps[key], FRACTION, "caps"),
    ]),
  ) as unknown as CapConfig;
  // A per-entry cap above the per-market cap would make the market cap
  // unreachable; the RFC's ordering (entrada <= mercado <= grupo) is a real
  // invariant, not decoration.
  if (caps.entrada > caps.mercado || caps.mercado > caps.grupoCorrelacionado) {
    fail(
      "PORTFOLIO_CONFIG_OUT_OF_RANGE",
      "portfolio.caps must satisfy entrada <= mercado <= grupoCorrelacionado",
    );
  }

  const lossRaw = record(top.lossLimits ?? {}, "portfolio.lossLimits");
  rejectUnknownKeys(
    lossRaw,
    ["perdaDiariaMax", "perdaSemanalMax", "drawdownMax", "reduceOnlyWeekDays"],
    "portfolio.lossLimits",
  );
  const lossLimits: LossLimitConfig = {
    perdaDiariaMax: num(
      lossRaw,
      "perdaDiariaMax",
      defaults.lossLimits.perdaDiariaMax,
      FRACTION,
      "lossLimits",
    ),
    perdaSemanalMax: num(
      lossRaw,
      "perdaSemanalMax",
      defaults.lossLimits.perdaSemanalMax,
      FRACTION,
      "lossLimits",
    ),
    drawdownMax: num(
      lossRaw,
      "drawdownMax",
      defaults.lossLimits.drawdownMax,
      FRACTION,
      "lossLimits",
    ),
    reduceOnlyWeekDays: num(
      lossRaw,
      "reduceOnlyWeekDays",
      defaults.lossLimits.reduceOnlyWeekDays,
      { min: 1, max: 30 },
      "lossLimits",
    ),
  };
  if (lossLimits.perdaDiariaMax > lossLimits.perdaSemanalMax) {
    fail(
      "PORTFOLIO_CONFIG_OUT_OF_RANGE",
      "portfolio.lossLimits.perdaDiariaMax cannot exceed perdaSemanalMax",
    );
  }

  const exitsRaw = record(top.exits ?? {}, "portfolio.exits");
  rejectUnknownKeys(
    exitsRaw,
    [
      "edgeResidualMin",
      "modelMoveThreshold",
      "depthFloorShares",
      "catalystBlackoutMin",
      "unwindAlarmPctOpenPnl",
    ],
    "portfolio.exits",
  );
  const exits: ExitConfig = {
    edgeResidualMin: num(
      exitsRaw,
      "edgeResidualMin",
      defaults.exits.edgeResidualMin,
      FRACTION,
      "exits",
    ),
    modelMoveThreshold: num(
      exitsRaw,
      "modelMoveThreshold",
      defaults.exits.modelMoveThreshold,
      FRACTION,
      "exits",
    ),
    depthFloorShares: num(
      exitsRaw,
      "depthFloorShares",
      defaults.exits.depthFloorShares,
      POSITIVE,
      "exits",
    ),
    catalystBlackoutMin: num(
      exitsRaw,
      "catalystBlackoutMin",
      defaults.exits.catalystBlackoutMin,
      { min: 0, max: 1_440 },
      "exits",
    ),
    unwindAlarmPctOpenPnl: num(
      exitsRaw,
      "unwindAlarmPctOpenPnl",
      defaults.exits.unwindAlarmPctOpenPnl,
      POSITIVE,
      "exits",
    ),
  };

  const staleRaw = record(top.staleness ?? {}, "portfolio.staleness");
  rejectUnknownKeys(
    staleRaw,
    ["bookMaxAgeMs", "estimateMaxAgeMs", "resolutionMaxAgeMs"],
    "portfolio.staleness",
  );
  const staleness: StalenessConfig = {
    bookMaxAgeMs: num(
      staleRaw,
      "bookMaxAgeMs",
      defaults.staleness.bookMaxAgeMs,
      POSITIVE,
      "staleness",
    ),
    estimateMaxAgeMs: num(
      staleRaw,
      "estimateMaxAgeMs",
      defaults.staleness.estimateMaxAgeMs,
      POSITIVE,
      "staleness",
    ),
    resolutionMaxAgeMs: num(
      staleRaw,
      "resolutionMaxAgeMs",
      defaults.staleness.resolutionMaxAgeMs,
      POSITIVE,
      "staleness",
    ),
  };

  const breakerRaw = record(top.breakers ?? {}, "portfolio.breakers");
  rejectUnknownKeys(
    breakerRaw,
    ["jumpThreshold", "jumpWindowMs"],
    "portfolio.breakers",
  );
  const breakers: BreakerConfig = {
    jumpThreshold: num(
      breakerRaw,
      "jumpThreshold",
      defaults.breakers.jumpThreshold,
      FRACTION,
      "breakers",
    ),
    jumpWindowMs: num(
      breakerRaw,
      "jumpWindowMs",
      defaults.breakers.jumpWindowMs,
      POSITIVE,
      "breakers",
    ),
  };

  const gatesRaw = record(top.gates ?? {}, "portfolio.gates");
  const gateKeys = [
    "g1MinResolvedMarkets",
    "g1MaxBrier",
    "g2MinDays",
    "g2MinClosedPositions",
    "g2MinDistinctMarkets",
    "g2MinCategories",
    "g2MinDistinctCloseDays",
    "g2MinBootstrapBlocks",
    "g2MaxSinglePositionPnlShare",
    "g2EdgeHaircut",
    "bootstrapResamples",
    "bootstrapBlockSize",
    "bootstrapSeed",
    "g4MaxFeeMedianError",
    "g4MinReconciledFills",
    "g4MinSoakDays",
  ] as const;
  rejectUnknownKeys(gatesRaw, gateKeys, "portfolio.gates");
  const gates: GateConfig = {
    g1MinResolvedMarkets: num(
      gatesRaw,
      "g1MinResolvedMarkets",
      defaults.gates.g1MinResolvedMarkets,
      POSITIVE,
      "gates",
    ),
    g1MaxBrier: num(
      gatesRaw,
      "g1MaxBrier",
      defaults.gates.g1MaxBrier,
      FRACTION,
      "gates",
    ),
    g2MinDays: num(
      gatesRaw,
      "g2MinDays",
      defaults.gates.g2MinDays,
      POSITIVE,
      "gates",
    ),
    g2MinClosedPositions: num(
      gatesRaw,
      "g2MinClosedPositions",
      defaults.gates.g2MinClosedPositions,
      POSITIVE,
      "gates",
    ),
    g2MinDistinctMarkets: num(
      gatesRaw,
      "g2MinDistinctMarkets",
      defaults.gates.g2MinDistinctMarkets,
      POSITIVE,
      "gates",
    ),
    g2MinCategories: num(
      gatesRaw,
      "g2MinCategories",
      defaults.gates.g2MinCategories,
      POSITIVE,
      "gates",
    ),
    g2MinDistinctCloseDays: num(
      gatesRaw,
      "g2MinDistinctCloseDays",
      defaults.gates.g2MinDistinctCloseDays,
      POSITIVE,
      "gates",
    ),
    g2MinBootstrapBlocks: num(
      gatesRaw,
      "g2MinBootstrapBlocks",
      defaults.gates.g2MinBootstrapBlocks,
      POSITIVE,
      "gates",
    ),
    g2MaxSinglePositionPnlShare: num(
      gatesRaw,
      "g2MaxSinglePositionPnlShare",
      defaults.gates.g2MaxSinglePositionPnlShare,
      FRACTION,
      "gates",
    ),
    g2EdgeHaircut: num(
      gatesRaw,
      "g2EdgeHaircut",
      defaults.gates.g2EdgeHaircut,
      FRACTION,
      "gates",
    ),
    bootstrapResamples: num(
      gatesRaw,
      "bootstrapResamples",
      defaults.gates.bootstrapResamples,
      { min: 200, max: 100_000 },
      "gates",
    ),
    bootstrapBlockSize: num(
      gatesRaw,
      "bootstrapBlockSize",
      defaults.gates.bootstrapBlockSize,
      { min: 1, max: 1_000 },
      "gates",
    ),
    bootstrapSeed: num(
      gatesRaw,
      "bootstrapSeed",
      defaults.gates.bootstrapSeed,
      POSITIVE,
      "gates",
    ),
    g4MaxFeeMedianError: num(
      gatesRaw,
      "g4MaxFeeMedianError",
      defaults.gates.g4MaxFeeMedianError,
      FRACTION,
      "gates",
    ),
    g4MinReconciledFills: num(
      gatesRaw,
      "g4MinReconciledFills",
      defaults.gates.g4MinReconciledFills,
      POSITIVE,
      "gates",
    ),
    g4MinSoakDays: num(
      gatesRaw,
      "g4MinSoakDays",
      defaults.gates.g4MinSoakDays,
      POSITIVE,
      "gates",
    ),
  };
  // The gate is the thing that unlocks real money. Loosening it below the RFC's
  // own numbers is a stop condition, so the parser refuses rather than trusting
  // whoever edited the file.
  if (
    gates.g1MinResolvedMarkets < defaults.gates.g1MinResolvedMarkets ||
    gates.g1MaxBrier > defaults.gates.g1MaxBrier ||
    gates.g2MinDays < defaults.gates.g2MinDays ||
    gates.g2MinClosedPositions < defaults.gates.g2MinClosedPositions ||
    gates.g2MinDistinctMarkets < defaults.gates.g2MinDistinctMarkets ||
    gates.g2MinCategories < defaults.gates.g2MinCategories ||
    gates.g2MinDistinctCloseDays < defaults.gates.g2MinDistinctCloseDays ||
    gates.g2MinBootstrapBlocks < defaults.gates.g2MinBootstrapBlocks ||
    gates.g2MaxSinglePositionPnlShare >
      defaults.gates.g2MaxSinglePositionPnlShare ||
    gates.g2EdgeHaircut < defaults.gates.g2EdgeHaircut ||
    gates.g4MaxFeeMedianError > defaults.gates.g4MaxFeeMedianError ||
    gates.g4MinReconciledFills < defaults.gates.g4MinReconciledFills ||
    gates.g4MinSoakDays < defaults.gates.g4MinSoakDays
  ) {
    fail(
      "PORTFOLIO_CONFIG_GATE_LOOSENED",
      "portfolio.gates cannot be loosened below the RFC-013 thresholds",
    );
  }

  const cadenceRaw = record(top.cadence ?? {}, "portfolio.cadence");
  const cadenceKeys = [
    "panelMs",
    "exposureMs",
    "exitMs",
    "gateMs",
    "reportMs",
  ] as const;
  rejectUnknownKeys(cadenceRaw, cadenceKeys, "portfolio.cadence");
  const cadence = Object.fromEntries(
    cadenceKeys.map((key) => [
      key,
      num(
        cadenceRaw,
        key,
        defaults.cadence[key],
        { min: 1_000, max: 30 * 24 * 3_600_000 },
        "cadence",
      ),
    ]),
  ) as unknown as CadenceConfig;

  const bankrollUsd = num(
    top,
    "bankrollUsd",
    defaults.bankrollUsd,
    { min: 1, max: 1_000_000_000 },
    "portfolio",
  );

  return Object.freeze({
    version,
    bankrollUsd,
    kelly: Object.freeze(kelly),
    costs: Object.freeze(costs),
    priceBand: Object.freeze(priceBand),
    depth: Object.freeze(depth),
    caps: Object.freeze(caps),
    lossLimits: Object.freeze(lossLimits),
    exits: Object.freeze(exits),
    staleness: Object.freeze(staleness),
    breakers: Object.freeze(breakers),
    gates: Object.freeze(gates),
    cadence: Object.freeze(cadence),
  });
}

export interface LoadPortfolioConfigOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readTextFile?: (path: string) => Promise<string>;
}

/** Load the module config; with no file configured the defaults are used. */
export async function loadPortfolioConfig(
  options: LoadPortfolioConfigOptions = {},
): Promise<PortfolioConfig> {
  const env = options.env ?? process.env;
  const path = env[PORTFOLIO_CONFIG_FILE_ENV];
  if (path === undefined || path === "") {
    return DEFAULT_PORTFOLIO_CONFIG;
  }
  const readTextFile =
    options.readTextFile ?? ((file: string) => readFile(file, "utf8"));
  let text: string;
  try {
    text = await readTextFile(path);
  } catch {
    throw new PortfolioConfigError(
      "PORTFOLIO_CONFIG_FILE_UNREADABLE",
      "configured portfolio config file could not be read",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new PortfolioConfigError(
      "PORTFOLIO_CONFIG_FILE_INVALID_JSON",
      "portfolio config file is not valid JSON",
    );
  }
  return parsePortfolioConfig(parsed);
}

/** Recursively sort object keys so the hash is independent of key order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Hash of everything that changes what a DECISION means. Cadences are excluded
 * on purpose: they change when the engine runs, never what it decides, so a
 * cadence tweak must not invalidate the reproducibility of past decisions.
 */
export function portfolioConfigHash(config: PortfolioConfig): string {
  const material = canonicalize({
    version: config.version,
    bankroll_usd: config.bankrollUsd,
    kelly: config.kelly,
    costs: config.costs,
    price_band: config.priceBand,
    depth: config.depth,
    caps: config.caps,
    loss_limits: config.lossLimits,
    exits: config.exits,
    staleness: config.staleness,
    breakers: config.breakers,
    gates: config.gates,
  });
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
