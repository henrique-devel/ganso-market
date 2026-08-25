// RFC-012 task 9, owner decision 4 (2026-08-24): two circuit-breaker layers
// run side by side. This module's state is the authoritative one the paper
// broker consults; the RFC-011 dispute trigger (frozen_markets in the kill
// switch) stays as independent redundancy. Every disagreement — in either
// direction — is recorded as a stateful divergence event and exposed as a
// metric. Divergence is decision information for the operator, never noise
// to reconcile away.

import type { ResolutionPool } from "./types.js";

export interface DivergenceSummary {
  readonly rfc012Only: number;
  readonly rfc011Only: number;
  readonly opened: number;
  readonly closed: number;
}

interface DivergenceFinding {
  readonly conditionId: string;
  readonly direction: "rfc012_only" | "rfc011_only";
  readonly rfc012Action: string;
  readonly rfc011Frozen: boolean;
  readonly positionHeld: boolean;
}

function openShares(shares: unknown): boolean {
  return (
    typeof shares === "string" &&
    shares !== "0" &&
    !shares.startsWith("0.000000")
  );
}

export async function divergenceCheck(
  pool: ResolutionPool,
  asOf: Date,
): Promise<DivergenceSummary> {
  const cbRows = await pool.query<Record<string, unknown>>(
    `SELECT condition_id, effective_action
       FROM resolution_market_state
      WHERE effective_action = 'CIRCUIT_BREAKER'`,
  );
  const rfc012 = new Map<string, string>();
  for (const row of cbRows.rows) {
    rfc012.set(String(row.condition_id), String(row.effective_action));
  }

  const killSwitch = await pool.query<Record<string, unknown>>(
    `SELECT frozen_markets_json FROM paper_kill_switch WHERE kill_switch_id = 1`,
  );
  const frozenRaw = killSwitch.rows[0]?.frozen_markets_json;
  const rfc011 = new Set<string>(
    Array.isArray(frozenRaw)
      ? (frozenRaw as unknown[]).filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );

  const positions = await pool.query<Record<string, unknown>>(
    `SELECT condition_id, shares FROM paper_positions WHERE condition_id IS NOT NULL`,
  );
  const held = new Set<string>();
  for (const row of positions.rows) {
    if (openShares(row.shares)) {
      held.add(String(row.condition_id));
    }
  }

  const findings: DivergenceFinding[] = [];
  for (const [conditionId, action] of rfc012) {
    if (!rfc011.has(conditionId)) {
      findings.push({
        conditionId,
        direction: "rfc012_only",
        rfc012Action: action,
        rfc011Frozen: false,
        positionHeld: held.has(conditionId),
      });
    }
  }
  for (const conditionId of rfc011) {
    if (!rfc012.has(conditionId)) {
      findings.push({
        conditionId,
        direction: "rfc011_only",
        rfc012Action: "NONE",
        rfc011Frozen: true,
        positionHeld: held.has(conditionId),
      });
    }
  }

  let opened = 0;
  const activeKeys = new Set<string>();
  for (const finding of findings) {
    const key = `${finding.conditionId}::${finding.direction}`;
    activeKeys.add(key);
    const refreshed = await pool.query(
      `UPDATE resolution_layer_divergences
          SET last_seen_at = $3,
              rfc012_action = $4,
              position_held = $5
        WHERE condition_id = $1 AND direction = $2 AND ended_at IS NULL`,
      [
        finding.conditionId,
        finding.direction,
        asOf,
        finding.rfc012Action,
        finding.positionHeld,
      ],
    );
    if (refreshed.rowCount === 0) {
      await pool.query(
        `INSERT INTO resolution_layer_divergences
           (condition_id, direction, rfc012_action, rfc011_frozen,
            position_held, started_at, last_seen_at, details_json)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7::jsonb)`,
        [
          finding.conditionId,
          finding.direction,
          finding.rfc012Action,
          finding.rfc011Frozen,
          finding.positionHeld,
          asOf,
          JSON.stringify({
            note:
              finding.direction === "rfc011_only"
                ? "kill switch congelou sem CB da RFC-012"
                : "CB da RFC-012 sem congelamento da RFC-011",
          }),
        ],
      );
      opened += 1;
    }
  }

  let closed = 0;
  const open = await pool.query<Record<string, unknown>>(
    `SELECT divergence_id, condition_id, direction
       FROM resolution_layer_divergences
      WHERE ended_at IS NULL`,
  );
  for (const row of open.rows) {
    const key = `${String(row.condition_id)}::${String(row.direction)}`;
    if (!activeKeys.has(key)) {
      await pool.query(
        `UPDATE resolution_layer_divergences SET ended_at = $2 WHERE divergence_id = $1`,
        [row.divergence_id, asOf],
      );
      closed += 1;
    }
  }

  return {
    rfc012Only: findings.filter((f) => f.direction === "rfc012_only").length,
    rfc011Only: findings.filter((f) => f.direction === "rfc011_only").length,
    opened,
    closed,
  };
}
