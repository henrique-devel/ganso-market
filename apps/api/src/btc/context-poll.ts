import type { TradingMarketObservation } from "@ganso-market/contracts/trading";
import { collectorFailure } from "./runtime-diagnostics.js";

export const CONTEXT_POLL_LIMITS = Object.freeze({
  intervalMs: 2000,
  maxTimeouts: 3, // Session budget; a successful response does not replenish it.
  maxBackoffMs: 4000,
});

/** One attempt per due capture cycle, no retry timer, queue or cached result. */
export function createContextPoll(deps: {
  now: () => number;
  signal: AbortSignal;
  fetch: () => Promise<TradingMarketObservation>;
  unavailable: () => void;
}) {
  let nextAttemptAt = 0;
  let inFlight = false;
  let timeouts = 0;
  let consecutiveTimeouts = 0;
  let exhausted = false;
  let lastTimeout:
    (ReturnType<typeof collectorFailure> & { at: string }) | null = null;
  return {
    status: () => ({
      timeouts,
      consecutive_timeouts: consecutiveTimeouts,
      exhausted,
      in_flight: inFlight,
      next_attempt_at: new Date(nextAttemptAt).toISOString(),
      last_timeout: lastTimeout,
      limits: CONTEXT_POLL_LIMITS,
    }),
    async poll(): Promise<TradingMarketObservation | null> {
      if (deps.signal.aborted) return null;
      if (exhausted) throw new Error("BTC_CONTEXT_TIMEOUTS_EXHAUSTED");
      if (inFlight || deps.now() < nextAttemptAt) return null;
      inFlight = true;
      try {
        const event = await deps.fetch();
        if (deps.signal.aborted) return null;
        consecutiveTimeouts = 0;
        return event;
      } catch (error) {
        if (deps.signal.aborted && error === deps.signal.reason) return null;
        // Narrow transport deadline only. HTTP refusal, abort, parser, metadata,
        // provenance, SQL and unknown errors retain their terminal semantics.
        if (!(error instanceof DOMException) || error.name !== "TimeoutError")
          throw error;
        timeouts++;
        consecutiveTimeouts++;
        lastTimeout = {
          ...collectorFailure("context_snapshot", error),
          at: new Date(deps.now()).toISOString(),
        };
        deps.unavailable();
        if (timeouts > CONTEXT_POLL_LIMITS.maxTimeouts) {
          exhausted = true;
          throw error; // Keep the terminal diagnostic's original type/stage.
        }
        return null;
      } finally {
        inFlight = false;
        // Count failed requests too; never retry immediately or catch up.
        nextAttemptAt =
          deps.now() +
          Math.min(
            CONTEXT_POLL_LIMITS.intervalMs *
              2 ** Math.max(0, consecutiveTimeouts - 1),
            CONTEXT_POLL_LIMITS.maxBackoffMs,
          );
      }
    },
  };
}
