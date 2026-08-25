// RFC-012 shared types. Analytics only: scores, vetoes, EV buffers and
// consistency signals over data the RFC-007 recorder already captured.

import type { SqlExecutor } from "../../database.js";

/** Score-to-action mapping output (task 9). */
export type ResolutionAction = "NONE" | "BUFFER" | "VETO" | "CIRCUIT_BREAKER";

export const RESOLUTION_ACTIONS: readonly ResolutionAction[] = [
  "NONE",
  "BUFFER",
  "VETO",
  "CIRCUIT_BREAKER",
];

/** Severity order used for the market-vs-group effective action. */
export const ACTION_SEVERITY: Readonly<Record<ResolutionAction, number>> = {
  NONE: 0,
  BUFFER: 1,
  VETO: 2,
  CIRCUIT_BREAKER: 3,
};

export function worstAction(
  a: ResolutionAction,
  b: ResolutionAction,
): ResolutionAction {
  return ACTION_SEVERITY[a] >= ACTION_SEVERITY[b] ? a : b;
}

/** Hard flags that force VETO regardless of the composed score. */
export type ResolutionHardFlag =
  "SUBJECTIVE_SOURCE" | "TITLE_RULE_MISMATCH" | "MATERIAL_CLARIFICATION_24H";

/** Which dispute prior produced the score (task 4: always reported). */
export type PriorKind = "external" | "measured";

/** Graph edge kinds (task 11). */
export type GraphEdgeKind =
  "MUTEX" | "IMPLIES" | "EQUIV" | "LADDER" | "NEGRISK";

export const GRAPH_EDGE_KINDS: readonly GraphEdgeKind[] = [
  "MUTEX",
  "IMPLIES",
  "EQUIV",
  "LADDER",
  "NEGRISK",
];

export type GraphEdgeOrigin = "structural" | "curated";

/** UMA request timeline states (task 1). */
export type UmaTimelineState =
  | "proposed"
  | "disputed"
  | "reset"
  | "dvm"
  | "settled"
  | "flagged"
  | "paused"
  | "unpaused";

/** Trinary-plus outcome of a settled UMA request. */
export type UmaResult = "P1" | "P2" | "P3" | "P4";

/** What caused a score recomputation. */
export type ScoreTrigger =
  "rule_change" | "status_change" | "sweep" | "boot" | "backtest";

/** Minimal query-pool shape every helper in this module accepts. */
export type ResolutionPool = { query: SqlExecutor["query"] };
