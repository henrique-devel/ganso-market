// RFC-012 task 17: the vetoes get teeth NOW (RFC-013 does not exist yet).
// The paper broker consults this gate before accepting anything:
//   - CIRCUIT_BREAKER (market or event group) refuses intents AND manual
//     orders — raising exposure during a dispute is forbidden, no override;
//   - VETO refuses intents outright; a manual order passes only with the
//     explicit override_veto flag, and the override is audited in the ledger;
//   - an active sanity veto (task 14) blocks the model-dependent intent —
//     the fallback is the RFC-010 market baseline, never the model.
// This layer is the AUTHORITATIVE one (owner decision 4); the RFC-011
// frozen-markets trigger stays live underneath as independent redundancy.

import { evaluateBufferAtPrice } from "./score.js";
import type { ResolutionAction, ResolutionPool } from "./types.js";

export interface ResolutionGateInput {
  readonly conditionId: string;
  /** Token of the intent, for the sanity-veto lookup. */
  readonly tokenId?: string | null;
  readonly source: "manual" | "intent";
  readonly overrideVeto?: boolean;
}

export interface ResolutionGateResult {
  readonly allowed: boolean;
  /** Stable refusal code when not allowed. */
  readonly reason: string | null;
  readonly action: ResolutionAction | null;
  readonly score: string | null;
  readonly scoreVersion: string | null;
  readonly justification: string | null;
  /** Price-independent buffer per share; price tail added at decision time. */
  readonly resolutionBuffer: string | null;
  readonly p5050: string | null;
  readonly sanityVetoActive: boolean;
  /** True when a manual VETO entry proceeded via override_veto. */
  readonly overrideApplied: boolean;
}

function allow(
  partial: Partial<ResolutionGateResult> = {},
): ResolutionGateResult {
  return {
    allowed: true,
    reason: null,
    action: null,
    score: null,
    scoreVersion: null,
    justification: null,
    resolutionBuffer: null,
    p5050: null,
    sanityVetoActive: false,
    overrideApplied: false,
    ...partial,
  };
}

export type ResolutionGateFn = (
  input: ResolutionGateInput,
) => Promise<ResolutionGateResult>;

export async function resolutionGate(
  pool: ResolutionPool,
  input: ResolutionGateInput,
): Promise<ResolutionGateResult> {
  const state = await pool.query<Record<string, unknown>>(
    `SELECT score, score_version, action, effective_action, resolution_buffer,
            p_5050, justification
       FROM resolution_market_state
      WHERE condition_id = $1`,
    [input.conditionId],
  );
  const row = state.rows[0];

  let sanityVetoActive = false;
  if (input.tokenId !== undefined && input.tokenId !== null) {
    const veto = await pool.query<Record<string, unknown>>(
      `SELECT veto_id FROM graph_sanity_vetoes
        WHERE token_id = $1 AND ended_at IS NULL
        LIMIT 1`,
      [input.tokenId],
    );
    sanityVetoActive = veto.rows.length > 0;
  }

  if (row === undefined) {
    // No current state. A manual order proceeds (there is no veto to
    // override); a model-driven intent does NOT — the risk layer this RFC
    // adds is exactly what an intent must pass through, so its absence
    // fails closed.
    if (input.source === "intent") {
      return {
        ...allow(),
        allowed: false,
        reason: "RESOLUTION_STATE_MISSING",
        sanityVetoActive,
      };
    }
    return allow({ sanityVetoActive });
  }

  const effective = row.effective_action as ResolutionAction;
  const base: Omit<ResolutionGateResult, "allowed" | "reason"> = {
    action: effective,
    score: typeof row.score === "string" ? row.score : null,
    scoreVersion:
      typeof row.score_version === "string" ? row.score_version : null,
    justification:
      typeof row.justification === "string" ? row.justification : null,
    resolutionBuffer:
      typeof row.resolution_buffer === "string" ? row.resolution_buffer : null,
    p5050: typeof row.p_5050 === "string" ? row.p_5050 : null,
    sanityVetoActive,
    overrideApplied: false,
  };

  if (effective === "CIRCUIT_BREAKER") {
    return { ...base, allowed: false, reason: "RESOLUTION_CIRCUIT_BREAKER" };
  }
  if (effective === "VETO") {
    if (input.source === "intent") {
      return { ...base, allowed: false, reason: "RESOLUTION_VETO" };
    }
    if (input.overrideVeto === true) {
      return { ...base, allowed: true, reason: null, overrideApplied: true };
    }
    return { ...base, allowed: false, reason: "RESOLUTION_VETO" };
  }
  if (input.source === "intent" && sanityVetoActive) {
    return { ...base, allowed: false, reason: "SANITY_VETO_ACTIVE" };
  }
  return { ...base, allowed: true, reason: null };
}

/**
 * The full buffer the caller subtracts from EV at a concrete entry price
 * (EV = q - ask - costs - resolution_buffer, RFC-013's formula).
 */
export function gateBufferAtPrice(
  gate: ResolutionGateResult,
  price: string,
): string | null {
  if (gate.resolutionBuffer === null) {
    return null;
  }
  const base = Number(gate.resolutionBuffer);
  const p5050 = gate.p5050 === null ? 0 : Number(gate.p5050);
  const parsedPrice = Number(price);
  if (
    !Number.isFinite(base) ||
    !Number.isFinite(p5050) ||
    !Number.isFinite(parsedPrice)
  ) {
    return null;
  }
  const full = evaluateBufferAtPrice(base, p5050, parsedPrice);
  return (Math.round(full * 1e6) / 1e6).toFixed(6);
}
