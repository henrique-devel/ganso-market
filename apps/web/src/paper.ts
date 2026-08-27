// The one RFC-011 control the panel publishes: rearming the paper broker's kill
// switch.
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL. Rearming lets the SIMULATOR accept orders
// again; no real order, wallet or credential exists anywhere in this project.
//
// There is no read call here on purpose. The switch's state already rides on
// GET /api/polymarket/resolution-risk/pipeline, which the dashboard already
// fetches and renders — a second endpoint for the same fact would be a second
// thing to keep in agreement with it.
//
// There is no engage call either. The switch has automatic triggers (recorder
// staleness, daily loss), so stopping does not need a human; a manual halt stays
// an action taken from inside the server, and the perimeter does not publish it.

import { authorizedPost } from "./resolution";
import type { ResolutionFetcher, ResolutionPostResult } from "./resolution";

export interface RearmOutcome {
  /** The switch's state AFTER the rearm, as the server reports it. */
  readonly engaged: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deliberately NOT permissive about `engaged`: only an explicit boolean is
 * accepted. A malformed payload must not read as "the broker is running", which
 * is the reading that would make an operator stop looking while the broker is in
 * fact still halted.
 */
export function parseRearmOutcome(body: unknown): RearmOutcome | null {
  if (!isRecord(body) || typeof body.engaged !== "boolean") {
    return null;
  }
  return { engaged: body.engaged };
}

export function rearmKillSwitch(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionPostResult<RearmOutcome>> {
  return authorizedPost(
    "/api/polymarket/paper/kill-switch/rearm",
    accessToken,
    parseRearmOutcome,
    fetcher,
    signal,
  );
}
