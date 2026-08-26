// RFC-013 shared types. Paper simulation only: this module decides whether to
// enter, how much, when to exit and when the whole system stops. It never signs,
// authenticates or places a real order — portfolio/scope.test.ts enforces that.

import type { SqlExecutor } from "../../database.js";

/** Minimal query surface, so tests can inject a fake pool. */
export type PortfolioPool = { query: SqlExecutor["query"] };

export const SIMULATION_BANNER = "SIMULAÇÃO — SEM EXECUÇÃO REAL";

/** The economic leg a decision is about. */
export type MarketSide = "YES" | "NO";

export type OrderSide = "BUY" | "SELL";

export type DecisionKind = "ENTRY" | "EXIT" | "VETO" | "RESIZE";

export type DecisionOutcome = "ACCEPTED" | "REJECTED";

export type PortfolioStateName = "NORMAL" | "REDUCE_ONLY" | "HALTED";

/**
 * Every limiter that can bind the position size. The final size is the min() of
 * all of them and the decision log always records which one bound it. Kelly is
 * a CEILING in this list, never a target, and no entry here can be disabled by
 * a flag — the RFC makes that a stop condition.
 */
export type BindingConstraint =
  | "KELLY_CAP"
  | "DEPTH_TAKE_PCT"
  | "UNCERTAINTY_SHRINK"
  | "CORRELATION_FACTOR"
  | "RULE_PRECISION"
  | "CAP_ENTRADA"
  | "CAP_MERCADO"
  | "CAP_GRUPO_CORRELACIONADO"
  | "CAP_CATEGORIA"
  | "CAP_FONTE_RESOLUCAO"
  | "CAP_CATALISADOR_JANELA"
  | "CAP_CAPITAL_BLOQUEADO"
  | "SLIPPAGE_MAX_PCT_EDGE"
  | "MIN_ORDER_SIZE"
  | "NOT_SIZED";

export const BINDING_CONSTRAINTS: readonly BindingConstraint[] = [
  "KELLY_CAP",
  "DEPTH_TAKE_PCT",
  "UNCERTAINTY_SHRINK",
  "CORRELATION_FACTOR",
  "RULE_PRECISION",
  "CAP_ENTRADA",
  "CAP_MERCADO",
  "CAP_GRUPO_CORRELACIONADO",
  "CAP_CATEGORIA",
  "CAP_FONTE_RESOLUCAO",
  "CAP_CATALISADOR_JANELA",
  "CAP_CAPITAL_BLOQUEADO",
  "SLIPPAGE_MAX_PCT_EDGE",
  "MIN_ORDER_SIZE",
  "NOT_SIZED",
];

/** Exposure dimensions kept continuously (task 4). */
export type ExposureDimension =
  | "market"
  | "event"
  | "category"
  | "resolution_source"
  | "factor"
  | "catalyst_window"
  | "locked_capital"
  | "total";

export const EXPOSURE_DIMENSIONS: readonly ExposureDimension[] = [
  "market",
  "event",
  "category",
  "resolution_source",
  "factor",
  "catalyst_window",
  "locked_capital",
  "total",
];

/** Portfolio-level circuit breakers (task 4, item v). */
export type BreakerKind =
  | "UMA_PROPOSED_OR_DISPUTED"
  | "PRICE_JUMP_NO_CATALYST"
  | "RULE_CLARIFICATION"
  | "PARAM_CHANGE"
  | "DATA_STALENESS";

export const BREAKER_KINDS: readonly BreakerKind[] = [
  "UMA_PROPOSED_OR_DISPUTED",
  "PRICE_JUMP_NO_CATALYST",
  "RULE_CLARIFICATION",
  "PARAM_CHANGE",
  "DATA_STALENESS",
];

/** The seven exit criteria of the owner's plan (task 5). None is a stop-loss. */
export type ExitReason =
  | "EDGE_CAPTURED_AT_BID"
  | "MODEL_MOVED"
  | "THESIS_INVALIDATED"
  | "LIQUIDITY_OR_RULE_DEGRADED"
  | "CATALYST_BLACKOUT"
  | "LOCKUP_NOT_WORTH_EDGE"
  | "PORTFOLIO_LIMIT";

export const EXIT_REASONS: readonly ExitReason[] = [
  "EDGE_CAPTURED_AT_BID",
  "MODEL_MOVED",
  "THESIS_INVALIDATED",
  "LIQUIDITY_OR_RULE_DEGRADED",
  "CATALYST_BLACKOUT",
  "LOCKUP_NOT_WORTH_EDGE",
  "PORTFOLIO_LIMIT",
];

/** Stable rejection codes. Every REJECTED decision carries exactly one. */
export type RejectionCode =
  | "LOWER_BOUND_BELOW_COSTS"
  | "PRICE_OUT_OF_BAND"
  | "EDGE_BELOW_MIN"
  | "RESOLUTION_VETO"
  | "RESOLUTION_CIRCUIT_BREAKER"
  | "RESOLUTION_STATE_MISSING"
  | "BOOK_STALE"
  | "NO_BOOK"
  | "DATA_STALE"
  | "PORTFOLIO_REDUCE_ONLY"
  | "PORTFOLIO_HALTED"
  | "CAP_EXHAUSTED"
  | "SIZE_BELOW_MIN_ORDER"
  | "SLIPPAGE_ABOVE_MAX"
  | "ESTIMATE_MISSING"
  | "PORTFOLIO_CIRCUIT_BREAKER";

/** Gate identifiers of the RFC-009 unlock criteria (task 9). */
export type GateId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6";

export const GATE_IDS: readonly GateId[] = ["G1", "G2", "G3", "G4", "G5", "G6"];

export type GateStatus = "PASS" | "FAIL" | "INSUFFICIENT_DATA";

/**
 * Reason codes a failing gate records. NO_EVIDENCE_OF_ALPHA is the RFC's own
 * name for the G2 outcome; the rest name the gate that blocked.
 */
export type GateReasonCode =
  | "NO_EVIDENCE_OF_ALPHA"
  | "G1_CALIBRATION_NOT_MET"
  | "G2_INSUFFICIENT_PAPER"
  | "G3_RISK_BREACH"
  | "G4_RECONCILIATION_OFF"
  | "G5_REGIME_STALE"
  | "G6_NOT_REVIEWED";

/** A price level of the recorded raw book. Decimal strings, never floats. */
export interface BookLevel {
  readonly price: string;
  readonly size: string;
}

/** The book excerpt a decision is made against, persisted with the decision. */
export interface DecisionBook {
  readonly tokenId: string;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly tickSize: string;
  readonly recordedAt: string;
}
