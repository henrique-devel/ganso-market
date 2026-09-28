/** Public read recovery only. Never wrap persistence or exchange writes. */
export const RECOVERY_LIMITS = Object.freeze({
  version: "hyperliquid-read-recovery.v1",
  windowMs: 300_000,
  maxRetries: 6,
  maxBackoffMs: 30_000,
  maxRetryAfterMs: 300_000,
});

export class SnapshotTransportError extends Error {
  constructor(
    readonly kind: "network" | "http_unavailable" | "rate_limited",
    readonly retryAfterMs = 0,
  ) {
    super("BTC_CONTEXT_RESPONSE_TRANSIENT");
  }
}

export function httpRetryAfter(
  value: string | null,
  status: number,
  now: number,
): number {
  const seconds =
    value !== null && /^\d+$/.test(value) ? Number(value) * 1000 : NaN;
  const date = value === null ? NaN : Date.parse(value);
  return Math.max(
    status === 429 ? 60_000 : 0,
    !Number.isNaN(seconds)
      ? seconds
      : Number.isFinite(date)
        ? Math.max(0, date - now)
        : 0,
  );
}

// Only failures identified by the HTTP transport are classified here. An
// arbitrary TypeError, SQL error or unknown COMMIT result is never retryable.
export function snapshotNetworkError(error: unknown): unknown {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return error instanceof TypeError &&
    typeof code === "string" &&
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code)
    ? new SnapshotTransportError("network")
    : error;
}

export function createReadRecovery(now: () => number, random = Math.random) {
  let attempts: number[] = [];
  let consecutive = 0;
  let total = 0;
  let exhausted = false;
  const prune = () => {
    attempts = attempts.filter((at) => now() - at < RECOVERY_LIMITS.windowMs);
  };
  return {
    success: () => {
      consecutive = 0;
    },
    fail(baseMs: number, retryAfterMs = 0): number | null {
      prune();
      consecutive++;
      if (
        exhausted ||
        consecutive > RECOVERY_LIMITS.maxRetries ||
        attempts.length >= RECOVERY_LIMITS.maxRetries ||
        retryAfterMs > RECOVERY_LIMITS.maxRetryAfterMs
      ) {
        exhausted = true;
        return null;
      }
      attempts.push(now());
      total++;
      const ceiling = Math.min(
        RECOVERY_LIMITS.maxBackoffMs,
        baseMs * 2 ** Math.min(consecutive - 1, 16),
      );
      // Equal jitter with the nominal cadence as a floor; never catch up.
      return Math.max(
        baseMs,
        retryAfterMs,
        Math.floor(ceiling * (0.5 + random() / 2)),
      );
    },
    status: () => {
      prune();
      return {
        total_retries: total,
        retries_in_window: attempts.length,
        consecutive_failures: consecutive,
        exhausted,
        limits: RECOVERY_LIMITS,
      };
    },
  };
}
