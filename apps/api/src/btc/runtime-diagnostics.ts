/** Bounded diagnostic fields only: never publish messages, stacks, URLs or payloads. */
export type CollectorStage =
  | "capacity"
  | "metadata"
  | "book_snapshot"
  | "context_snapshot"
  | "capture"
  | "close_bars"
  | "publish";

const errorNames = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "TimeoutError",
  "AbortError",
  "HyperliquidMetadataError",
]);
const errorCodes = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ENOSPC",
  "EACCES",
  "EIO",
  "57014",
  "55P03",
  "53300",
  "53100",
  "53200",
  "57P01",
  "08006",
  "23505",
]);
export function collectorFailure(stage: CollectorStage, error: unknown) {
  const field = (value: unknown, key: string): unknown =>
    value !== null && typeof value === "object" && key in value
      ? (value as Record<string, unknown>)[key]
      : null;
  const name = field(error, "name");
  const directCode = field(error, "code");
  const causeCode = field(field(error, "cause"), "code");
  const code =
    [directCode, causeCode].find(
      (value): value is string =>
        typeof value === "string" && errorCodes.has(value),
    ) ?? null;
  return {
    stage,
    error_type:
      typeof name === "string" && errorNames.has(name) ? name : "unknown",
    error_code: code,
  };
}

export function createCollectorRuntimeDiagnostics() {
  let failure: ReturnType<typeof collectorFailure> | null = null;
  return {
    failure: () => failure,
    async run<T>(stage: CollectorStage, work: () => Promise<T>): Promise<T> {
      try {
        return await work();
      } catch (error) {
        // Concurrent HTTP operations must not replace the first observed failure.
        failure ??= collectorFailure(stage, error);
        throw error; // Preserve terminal refusal, including capacity/metadata codes.
      }
    },
  };
}
