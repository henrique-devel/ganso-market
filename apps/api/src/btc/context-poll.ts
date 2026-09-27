import type { TradingMarketObservation } from "@ganso-market/contracts/trading";
import { collectorFailure } from "./runtime-diagnostics.js";
import {
  createReadRecovery,
  SnapshotTransportError,
} from "../venues/hyperliquid/recovery.js";

export const CONTEXT_POLL_LIMITS = Object.freeze({
  intervalMs: 2000,
  deadlineMs: 1500,
});

/** One attempt per due capture cycle, no retry timer, queue or cached result. */
export function createContextPoll<T = TradingMarketObservation>(deps: {
  now: () => number;
  signal: AbortSignal;
  fetch: () => Promise<T>;
  unavailable: () => void;
  intervalMs?: number;
  startToStart?: boolean;
  stage?: "book_snapshot" | "context_snapshot" | "metadata";
  deadlineMs?: number;
  random?: () => number;
  // Shared by public HTTP channels. 429 applies to the IP, not just one poll.
  cooldown?: { until: number };
}) {
  const interval = deps.intervalMs ?? CONTEXT_POLL_LIMITS.intervalMs;
  const recovery = createReadRecovery(deps.now, deps.random);
  let nextAttemptAt = 0;
  let inFlight = false;
  let timeouts = 0;
  let consecutiveTimeouts = 0;
  let exhausted = false;
  let terminal: unknown;
  let terminalSet = false;
  let lastFailure: { kind: string; at: string } | null = null;
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
      limits: {
        intervalMs: interval,
        deadlineMs: deps.deadlineMs ?? CONTEXT_POLL_LIMITS.deadlineMs,
      },
      recovery: recovery.status(),
      last_failure: lastFailure,
      cooldown_until: new Date(deps.cooldown?.until ?? 0).toISOString(),
    }),
    async poll(): Promise<T | null> {
      if (deps.signal.aborted) return null;
      if (exhausted) throw new Error("BTC_PUBLIC_READ_RETRIES_EXHAUSTED");
      if (terminalSet) throw terminal;
      if (
        inFlight ||
        deps.now() < Math.max(nextAttemptAt, deps.cooldown?.until ?? 0)
      )
        return null;
      inFlight = true;
      const started = deps.now();
      let delay = interval;
      let retrying = false;
      try {
        const event = await deps.fetch();
        if (deps.signal.aborted) return null;
        if (
          deps.now() - started >
          (deps.deadlineMs ?? CONTEXT_POLL_LIMITS.deadlineMs)
        )
          throw new DOMException("Snapshot deadline exceeded", "TimeoutError");
        consecutiveTimeouts = 0;
        recovery.success();
        return event;
      } catch (error) {
        if (deps.signal.aborted) return null;
        const timeout =
          error instanceof DOMException && error.name === "TimeoutError";
        if (!timeout && !(error instanceof SnapshotTransportError)) {
          terminal = error;
          terminalSet = true;
          throw error;
        }
        const at = new Date(deps.now()).toISOString();
        if (timeout) {
          timeouts++;
          consecutiveTimeouts++;
          lastTimeout = {
            ...collectorFailure(deps.stage ?? "context_snapshot", error),
            at,
          };
        } else consecutiveTimeouts = 0;
        lastFailure = {
          kind: timeout ? "timeout" : (error as SnapshotTransportError).kind,
          at,
        };
        deps.unavailable();
        const retryAfter =
          error instanceof SnapshotTransportError ? error.retryAfterMs : 0;
        const backoff = recovery.fail(interval, retryAfter);
        if (backoff === null) {
          exhausted = true;
          throw error; // Keep the terminal diagnostic's original type/stage.
        }
        if (deps.cooldown && retryAfter > 0)
          deps.cooldown.until = Math.max(
            deps.cooldown.until,
            deps.now() + retryAfter,
          );
        delay = backoff;
        retrying = true;
        return null;
      } finally {
        inFlight = false;
        // Count failed requests too; never retry immediately or catch up.
        nextAttemptAt =
          (deps.startToStart && !retrying ? started : deps.now()) + delay;
      }
    },
  };
}
