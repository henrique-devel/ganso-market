import { createHash } from "node:crypto";
import { canonicalFingerprint } from "../trading/replay.js";

export const JEV_VERSION = "btc.jev-adapter.v1" as const;
export const JEV_PROMPT_VERSION = "btc.jev-trend-filter.v1" as const;
export type JevOrigin = "real" | "mock";
export type JevDecision = "allow" | "veto" | "abstain";
export const JEV_QUESTION = Object.freeze({
  type: "choice",
  instructions:
    "Is the observed setup compatible with continuation in the candidate direction? Use only the supplied state. Abstain if ambiguous. You only filter this candidate; you cannot change direction, size, leverage, risk or exits.",
  criteria: Object.freeze({
    allow:
      "The supplied setup supports continuation in the candidate direction.",
    veto: "The supplied setup contradicts continuation in the candidate direction.",
    abstain: "Insufficient or ambiguous evidence to judge continuation.",
  }),
});
/** Read-only observations, never an order or a mutable baseline policy. Prices
 * are USD_PER_BTC6. Callers remain responsible for freshness and eligibility. */
export interface JevInput {
  candidate_hash: string;
  direction: "long" | "short";
  close_usd6: string;
  fast_mean_usd6: string;
  slow_mean_usd6: string;
  atr_usd6: string;
}
export interface JevRequest {
  request_id: string;
  input: JevInput;
  deadline_at: string;
}
export interface JevTariff {
  version: string;
  model: string;
  valid_until: string;
  /** USD6 per million input tokens, output free; no implicit public-price default. */
  input_usd6_per_million: string;
  output_usd6_per_million: "0";
  /** Explicit attestation that the provider's total billable input per attempt
   * cannot exceed this bound, including failed requests and hidden overhead. */
  max_billable_input_tokens: number;
}
export interface JevAnswer {
  decision: JevDecision;
  confidence: number;
  probabilities: Record<JevDecision, number>;
}
export type JevReason =
  | "ok"
  | "disabled"
  | "invalid_input"
  | "cost_unknown"
  | "budget_unavailable"
  | "budget_exhausted"
  | "circuit_open"
  | "duplicate"
  | "idempotency_conflict"
  | "timeout"
  | "cancelled"
  | "provider_error"
  | "malformed_response"
  | "recovered_uncertain"
  | "storage_error";
/** Exact successful HTTP body; parsing happens in the adapter so replay retains
 * whitespace, original numbers and malformed JSON. No headers or credentials. */
export class JevWireResponse {
  constructor(public readonly body: string) {}
}
export interface JevResult {
  input: JevInput | null;
  original_response: string | null;
  response_hash: string | null;
  response_received_at: string | null;
  version: typeof JEV_VERSION;
  prompt_version: typeof JEV_PROMPT_VERSION;
  prompt_hash: string;
  request_id: string;
  input_hash: string;
  model: string | null;
  origin: JevOrigin;
  decision: JevDecision;
  reason: JevReason;
  attempted: boolean;
  started_at: string;
  deadline_at: string;
  duration_ms: number;
  reserved_usd6: string;
  /** Null means unknown, NOT free. The full reservation remains consumed. */
  cost_usd6: string | null;
  tariff_version: string | null;
  tariff: JevTariff | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  answer: JevAnswer | null;
}
export interface JevTransport {
  readonly origin: JevOrigin;
  readonly model: string;
  /** Exactly one attempt. No internal retries, SDK defaults or hedged requests. */
  evaluate(input: JevInput, signal: AbortSignal): Promise<unknown>;
}
export const jevHash = (v: unknown) =>
  `sha256:${createHash("sha256").update(canonicalFingerprint(v)).digest("hex")}`;
export const JEV_PROMPT_HASH = jevHash(JEV_QUESTION);
export const uint = (v: unknown): v is string =>
  typeof v === "string" && /^(0|[1-9][0-9]{0,17})$/.test(v);
export const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
export const keys = (v: Record<string, unknown>, expected: string[]) =>
  Object.keys(v).sort().join(",") === expected.sort().join(",");
export const iso = (v: string) =>
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function validInput(input: JevInput): boolean {
  const r = record(input);
  return (
    !!r &&
    keys(r, [
      "candidate_hash",
      "direction",
      "close_usd6",
      "fast_mean_usd6",
      "slow_mean_usd6",
      "atr_usd6",
    ]) &&
    typeof input.candidate_hash === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(input.candidate_hash) &&
    ["long", "short"].includes(input.direction) &&
    [
      input.close_usd6,
      input.fast_mean_usd6,
      input.slow_mean_usd6,
      input.atr_usd6,
    ].every((v) => uint(v) && BigInt(v) > 0n)
  );
}
export function quote(
  tariff: JevTariff | undefined,
  model: string,
  deadline: string,
): string | null {
  if (
    !tariff ||
    tariff.model !== model ||
    tariff.output_usd6_per_million !== "0" ||
    !/^jev-\d+\.\d+\.\d+$/.test(model) ||
    !/^[a-zA-Z0-9:._-]{1,100}$/.test(tariff.version) ||
    !iso(tariff.valid_until) ||
    Date.parse(tariff.valid_until) < Date.parse(deadline) ||
    !uint(tariff.input_usd6_per_million) ||
    BigInt(tariff.input_usd6_per_million) <= 0n ||
    !Number.isSafeInteger(tariff.max_billable_input_tokens) ||
    tariff.max_billable_input_tokens < 65_536 ||
    tariff.max_billable_input_tokens > 1_000_000
  )
    return null;
  return (
    (BigInt(tariff.input_usd6_per_million) *
      BigInt(tariff.max_billable_input_tokens) +
      999_999n) /
    1_000_000n
  ).toString();
}
/** Validate billing independently: malformed judgments can still be billed. */
export function usageCost(raw: unknown, tariff: JevTariff) {
  const r = record(raw),
    u = record(r?.usage);
  if (
    r?.model !== tariff.model ||
    !u ||
    !keys(u, ["input_tokens", "output_tokens"]) ||
    !Number.isSafeInteger(u.input_tokens) ||
    !Number.isSafeInteger(u.output_tokens) ||
    (u.input_tokens as number) < 0 ||
    (u.input_tokens as number) > tariff.max_billable_input_tokens ||
    (u.output_tokens as number) < 0
  )
    return null;
  const usage = {
    input_tokens: u.input_tokens as number,
    output_tokens: u.output_tokens as number,
  };
  return {
    usage,
    cost: (
      (BigInt(usage.input_tokens) * BigInt(tariff.input_usd6_per_million) +
        999_999n) /
      1_000_000n
    ).toString(),
  };
}
export function validateAnswer(raw: unknown, model: string): JevAnswer | null {
  const r = record(raw),
    a = record(r?.answers),
    f = record(a?.filter),
    p = record(f?.probabilities);
  const options: JevDecision[] = ["allow", "veto", "abstain"];
  const probability = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  if (
    !r ||
    !keys(r, ["model", "answers", "usage"]) ||
    r.model !== model ||
    !a ||
    !keys(a, ["filter"]) ||
    !f ||
    !keys(f, ["type", "choice", "confidence", "probabilities"]) ||
    f.type !== "choice" ||
    !options.includes(f.choice as JevDecision) ||
    !probability(f.confidence) ||
    !p ||
    !keys(p, options) ||
    !options.every((k) => probability(p[k])) ||
    Math.abs(options.reduce((n, k) => n + (p[k] as number), 0) - 1) >
      0.000001 ||
    options.some((k) => (p[k] as number) > (p[f.choice as string] as number))
  )
    return null;
  return {
    decision: f.choice as JevDecision,
    confidence: f.confidence,
    probabilities: p as Record<JevDecision, number>,
  };
}
