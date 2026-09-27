import { createHash, randomUUID } from "node:crypto";

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

/** Consumer stages describe bounded operations, never SQL or data supplied to them. */
export type DeskStage =
  | "select_accounts"
  | "manual_cycle"
  | "baseline_cycle"
  | "challenger_cycle"
  | "challenger_gate"
  | "baseline_registration"
  | "baseline_clock"
  | "baseline_projection"
  | "baseline_prepare"
  | "baseline_risk_transaction"
  | "baseline_liquidation"
  | "persist_failure"
  | "funding";
export type DeskPurpose = "manual" | "baseline" | "challenger" | null;
export const DESK_DIAGNOSTICS_VERSION = "btc.desk-diagnostics.v1";

// Exact codes only: a message that happens to start with BTC_ is not trusted.
const deskReasons = new Set([
  "BTC_DESK_ACCOUNT_LIMIT",
  "BTC_DESK_MANUAL_REQUIRED",
  "BTC_DESK_FUNDING_AMBIGUOUS",
  "BTC_BASELINE_REGISTRATION_REQUIRED",
  "BTC_BASELINE_REGISTRATION_CHANGED",
  "BTC_BASELINE_REGISTRATION",
  "BTC_BASELINE_SCOPE",
  "BTC_BASELINE_TIME",
  "BTC_BASELINE_INPUT_COLLISION",
  "BTC_BASELINE_BAR_EVIDENCE",
  "BTC_BASELINE_ACCOUNT_EVIDENCE",
  "BTC_BASELINE_EXIT_MEMORY",
  "BTC_BASELINE_EXIT_PROVENANCE",
  "BTC_BASELINE_ORDER_PROVENANCE",
  "BTC_BASELINE_POSITION_CHANGED",
  "BTC_BASELINE_POSITION_DIRECTION",
  "BTC_LEDGER_PROJECTION_MISMATCH",
  "BTC_MARGIN_METADATA_UNAVAILABLE",
  "BTC_RECOVERY_FENCED",
  "BTC_RECOVERY_INVALID_HISTORY",
  "BTC_RECOVERY_OWNED",
  "BTC_RISK_FEE_METADATA_UNAVAILABLE",
]);
export function deskFailureReason(error: unknown, fallback: string): string {
  return error instanceof Error && deskReasons.has(error.message)
    ? error.message
    : fallback;
}

const sqlStates = new Set([
  "57014",
  "55P03",
  "53300",
  "53100",
  "53200",
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "23502",
  "23503",
  "23505",
  "23514",
  "22003",
  "22007",
  "22P02",
  "25P02",
  "25006",
  "40001",
  "40P01",
  "42P01",
  "42703",
  "42883",
  "42501",
  "42601",
  "54000",
  "P0001",
]);
function deskError(error: unknown) {
  let current = error;
  let error_type = "unknown";
  let error_code: string | null = null;
  let sqlstate: string | null = null;
  let timeout = false;
  // Bounded cause traversal also handles cyclic causes. Never serialize the error.
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object";
    depth++
  ) {
    const e = current as Record<string, unknown>;
    if (depth === 0 && typeof e.name === "string") {
      if (errorNames.has(e.name)) error_type = e.name;
      else if (
        e.name === "error" &&
        typeof e.code === "string" &&
        sqlStates.has(e.code)
      )
        error_type = "PostgresError";
    }
    if (typeof e.code === "string") {
      if (sqlStates.has(e.code)) sqlstate ??= e.code;
      else if (errorCodes.has(e.code)) error_code ??= e.code;
    }
    // pg's client-side timeouts carry no code. Match exact known messages only;
    // the message itself is never emitted, nor are approximate/private variants.
    timeout ||=
      e.name === "TimeoutError" ||
      e.message === "Query read timeout" ||
      e.message === "Connection terminated due to connection timeout" ||
      e.message === "timeout exceeded when trying to connect";
    current = e.cause;
  }
  const cause =
    sqlstate === "55P03"
      ? "lock_unavailable"
      : sqlstate === "57014"
        ? "query_canceled"
        : sqlstate
          ? "database_error"
          : timeout ||
              error_code?.includes("TIMEOUT") ||
              error_code === "ETIMEDOUT"
            ? "timeout"
            : error_code
              ? "system_error"
              : deskFailureReason(error, "")
                ? "domain_refusal"
                : "unknown";
  return { error_type, error_code, sqlstate, cause };
}

/** One log per account/stage per window; at most eight per 30s for this process.
 * Suppression affects only logs, never runtime persistence or consumer scheduling. */
export function createDeskRuntimeDiagnostics(
  log: (reason: string, fields: DeskFailureFields) => void,
  clock: () => number = () => performance.now(),
) {
  let windowStart = clock();
  const emitted = new Set<string>();
  let suppressed = 0;
  return {
    start(
      stage: DeskStage,
      account: string | null = null,
      purpose: DeskPurpose = null,
      correlation_id = randomUUID(),
    ) {
      const started = clock();
      let stageStarted = started;
      const account_ref =
        account === null
          ? null
          : createHash("sha256").update(account).digest("hex");
      return {
        correlation_id,
        stage(next: DeskStage) {
          stage = next;
          stageStarted = clock();
        },
        fail(error: unknown, fallback: string) {
          const now = clock();
          const fields: DeskFailureFields = {
            diagnostic_version: DESK_DIAGNOSTICS_VERSION,
            component: "desk_consumer",
            account_ref,
            account_purpose: purpose,
            stage,
            duration_ms: Math.max(0, Math.round(now - stageStarted)),
            operation_duration_ms: Math.max(0, Math.round(now - started)),
            correlation_id,
            ...deskError(error),
            suppressed_since_last_log: suppressed,
          };
          const reason = deskFailureReason(error, fallback);
          if (now - windowStart >= 30000) {
            windowStart = now;
            emitted.clear();
          }
          const key = `${account_ref}:${stage}`;
          if (emitted.size >= 8 || emitted.has(key)) {
            suppressed++;
            return reason;
          }
          emitted.add(key);
          suppressed = 0;
          log(reason, fields);
          return reason;
        },
      };
    },
  };
}
export interface DeskFailureFields {
  diagnostic_version: typeof DESK_DIAGNOSTICS_VERSION;
  component: "desk_consumer";
  account_ref: string | null;
  account_purpose: DeskPurpose;
  stage: DeskStage;
  duration_ms: number;
  operation_duration_ms: number;
  correlation_id: string;
  error_type: string;
  error_code: string | null;
  sqlstate: string | null;
  cause: string;
  suppressed_since_last_log: number;
}
