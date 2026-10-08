import {
  parseJevContract,
  requireJev,
  type JevScope,
} from "@ganso-market/contracts/trading";
import { type buildJevContext, jevTime } from "../storage/jev-context.js";
import { jevHash } from "../storage/jev-hash.js";
import {
  type JevManifest,
  validateJevManifest,
} from "../storage/jev-manifest.js";
import { type JevTariff, keys, record } from "./jev-contract.js";

export const JEV_DECISION_VERSION = "jev.principal-decision.v1" as const;
export const JEV_QUESTIONS_VERSION = "jev.principal-questions.v1" as const;
export const JEV_LIMITS = Object.freeze({
  request_bytes: 65536,
  response_bytes: 32768,
  participants: 3,
  concurrent_requests: 3,
});
export type JevContext = ReturnType<typeof buildJevContext>;
export type JevPurpose = "operation" | "generation_validation";
export type JevDirection = "long" | "short";
export type JevIntent = "open" | "hold" | "close";
export interface JevParticipant {
  context_id: string;
  context: JevContext;
}
export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface JevBatch {
  schema_version: typeof JEV_DECISION_VERSION;
  questions_version: typeof JEV_QUESTIONS_VERSION;
  request_id: string;
  purpose: JevPurpose;
  proposal_id: string | null;
  manifest: JevManifest;
  model: string;
  cut_at: string;
  deadline_at: string;
  expires_at: string;
  participants: JevParticipant[];
  questions: Record<string, JevChoiceQuestion>;
}
export type JevFailure =
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
  | "rate_limited"
  | "oversized_response"
  | "binding_error"
  | "malformed_response"
  | "incompatible_position"
  | "recovered_uncertain"
  | "storage_error"
  | "capacity_refused"
  | "concurrency_limit";
export interface JevChoice<T extends string> {
  choice: T;
  confidence: number;
  probabilities: Record<T, number>;
}
export interface JevAccountDecision {
  scope: JevScope;
  context_id: string;
  direction: JevChoice<JevDirection> | null;
  intent: JevChoice<JevIntent> | null;
  action: JevIntent | null;
  reason: "ok" | JevFailure;
  /** Whole request attributed to each participant; never sum as platform bill. */
  attributed_cost_usd6: string | null;
}
export interface JevBatchResult {
  schema_version: typeof JEV_DECISION_VERSION;
  origin: "real" | "mock";
  batch: JevBatch;
  batch_hash: string;
  reason: "ok" | "partial_error" | JevFailure;
  attempted: boolean;
  started_at: string;
  finished_at: string;
  response_received_at: string | null;
  http_status: number | null;
  original_response: string | null;
  response_hash: string | null;
  tariff: JevTariff | null;
  reserved_usd6: string;
  cost_usd6: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  decisions: JevAccountDecision[];
}
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(v);
export const pinnedJevModel = (v: unknown): v is string =>
  typeof v === "string" && /^jev-[0-9]+\.[0-9]+\.[0-9]+$/.test(v);
function questionsFor(
  batch: Pick<JevBatch, "participants" | "manifest" | "model" | "cut_at">,
) {
  const questions: Record<string, JevChoiceQuestion> = {};
  batch.participants.forEach(({ context }, index) => {
    const s = context.scope;
    const binding = `Use only state.accounts[${index}] for owner=${s.owner_id}, account=${s.account_id}, mode=${s.mode}, experiment=${s.experiment_id}, profile=${s.profile_id}/${s.profile_version}, position=${context.account?.position?.position_id ?? "flat"}, cut=${batch.cut_at}, manifest=${context.manifest_hash}, model=${batch.model}, questions=${JEV_QUESTIONS_VERSION}. Economic horizon ${batch.manifest.horizon_minutes} minutes. ${batch.manifest.decision.instruction} Code owns size, risk, price and protection. Never borrow another account's position.`;
    questions[`a${index}_direction`] = {
      type: "choice",
      instructions: `${binding} Select the appropriate BTC direction. For holding or closing, use this account's current position direction. On a flat hold direction is diagnostic only.`,
      criteria: { long: "Long BTC direction.", short: "Short BTC direction." },
    };
    questions[`a${index}_intent`] = {
      type: "choice",
      instructions: `${binding} Select the intention for this account's observed position. No pyramiding or reversal.`,
      criteria: {
        open: "Open a new position only when this account is flat.",
        hold: "Keep the current position, or stay flat when no entry is warranted.",
        close: "Close this account's existing position.",
      },
    };
  });
  return questions;
}
export function buildJevBatch(
  input: Omit<
    JevBatch,
    "schema_version" | "questions_version" | "questions" | "expires_at"
  >,
): JevBatch {
  const b = structuredClone(input);
  const batch: JevBatch = {
    ...b,
    schema_version: JEV_DECISION_VERSION,
    questions_version: JEV_QUESTIONS_VERSION,
    expires_at: new Date(
      jevTime(b.cut_at) + b.manifest.freshness.decision_ttl_ms,
    ).toISOString(),
    questions: questionsFor(b),
  };
  validateJevBatch(batch);
  return batch;
}
export function validateJevBatch(batch: JevBatch): void {
  requireJev(
    keys(batch as unknown as Record<string, unknown>, [
      "schema_version",
      "questions_version",
      "request_id",
      "purpose",
      "proposal_id",
      "manifest",
      "model",
      "cut_at",
      "deadline_at",
      "expires_at",
      "participants",
      "questions",
    ]),
    "BATCH_SHAPE",
  );
  const hash = validateJevManifest(batch.manifest),
    at = jevTime(batch.cut_at);
  requireJev(
    batch.schema_version === JEV_DECISION_VERSION &&
      batch.questions_version === JEV_QUESTIONS_VERSION &&
      id(batch.request_id) &&
      pinnedJevModel(batch.model),
    "BATCH_VERSION",
  );
  requireJev(
    ["operation", "generation_validation"].includes(batch.purpose) &&
      (batch.proposal_id === null || id(batch.proposal_id)) &&
      (batch.purpose !== "operation" || batch.proposal_id === null),
    "BATCH_PURPOSE",
  );
  requireJev(
    jevTime(batch.deadline_at) > at &&
      jevTime(batch.deadline_at) <=
        at + batch.manifest.freshness.response_deadline_ms &&
      jevTime(batch.expires_at) ===
        at + batch.manifest.freshness.decision_ttl_ms,
    "BATCH_DEADLINE",
  );
  requireJev(
    Array.isArray(batch.participants) &&
      batch.participants.length > 0 &&
      batch.participants.length <= JEV_LIMITS.participants,
    "BATCH_PARTICIPANTS",
  );
  const first = batch.participants[0]!.context,
    accounts = new Set<string>(),
    contexts = new Set<string>();
  const values = (c: JevContext) => ({
    book: c.book,
    flow: c.flow,
    funding: c.funding,
    indicators: c.indicators,
    market_refs: c.input_refs.filter(
      (r) => r.payload_hash !== jevHash(c.account),
    ),
  });
  for (const p of batch.participants) {
    const c = p.context,
      s = c.scope;
    parseJevContract("binding", {
      schema_version: s.schema_version,
      owner_id: s.owner_id,
      account_id: s.account_id,
      mode: s.mode,
      profile_id: s.profile_id,
      profile_version: s.profile_version,
      experiment_id: s.experiment_id,
      started_at: batch.cut_at,
    });
    requireJev(
      typeof p.context_id === "string" &&
        p.context_id.length > 0 &&
        p.context_id.length <= 512 &&
        !contexts.has(p.context_id) &&
        !accounts.has(s.account_id),
      "BATCH_BINDING",
    );
    contexts.add(p.context_id);
    accounts.add(s.account_id);
    requireJev(
      c.schema_version === "btc.jev-context.v1" &&
        c.manifest_hash === hash &&
        c.cut_at === batch.cut_at &&
        c.quality.state === "observed_no_known_gap" &&
        c.quality.reasons.length === 0 &&
        c.account &&
        jevHash(c.account.scope) === jevHash(s) &&
        c.account.equity_usd_raw !== null &&
        at - jevTime(c.account.observed_at) >= 0 &&
        at - jevTime(c.account.observed_at) <=
          batch.manifest.freshness.account_ms,
      "BATCH_CONTEXT",
    );
    requireJev(
      s.owner_id === first.scope.owner_id &&
        s.profile_id === first.scope.profile_id &&
        s.profile_version === first.scope.profile_version &&
        s.instrument_id === "hyperliquid:mainnet:BTC" &&
        s.instrument_version === first.scope.instrument_version &&
        jevHash(values(c)) === jevHash(values(first)),
      "BATCH_PROFILE",
    );
  }
  requireJev(
    jevHash(batch.questions) === jevHash(questionsFor(batch)),
    "BATCH_QUESTIONS_BINDING",
  );
  requireJev(
    Buffer.byteLength(JSON.stringify(jevBatchPayload(batch))) <=
      JEV_LIMITS.request_bytes,
    "BATCH_BYTES",
  );
}
export function jevBatchPayload(batch: JevBatch) {
  return {
    model: batch.model,
    state: {
      cut_at: batch.cut_at,
      manifest_hash: batch.participants[0]!.context.manifest_hash,
      horizon_minutes: batch.manifest.horizon_minutes,
      accounts: batch.participants.map((p) => p.context),
    },
    questions: batch.questions,
  };
}
export function refusedDecisions(
  batch: JevBatch,
  reason: JevFailure,
  cost: string | null,
): JevAccountDecision[] {
  return batch.participants.map((p) => ({
    scope: p.context.scope,
    context_id: p.context_id,
    direction: null,
    intent: null,
    action: null,
    reason,
    attributed_cost_usd6: batch.purpose === "operation" ? cost : null,
  }));
}
function choice<T extends string>(
  raw: unknown,
  options: T[],
): JevChoice<T> | null {
  const r = record(raw),
    p = record(r?.probabilities);
  const probability = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  if (
    !r ||
    !keys(r, ["type", "choice", "confidence", "probabilities"]) ||
    r.type !== "choice" ||
    !options.includes(r.choice as T) ||
    !probability(r.confidence) ||
    !p ||
    !keys(p, [...options]) ||
    !options.every((k) => probability(p[k])) ||
    Math.abs(options.reduce((n, k) => n + (p[k] as number), 0) - 1) >
      0.000001 ||
    options.some((k) => (p[k] as number) > (p[r.choice as string] as number))
  )
    return null;
  return {
    choice: r.choice as T,
    confidence: r.confidence,
    probabilities: p as Record<T, number>,
  };
}
export function interpretJevBatch(
  batch: JevBatch,
  raw: unknown,
  cost: string,
): JevAccountDecision[] {
  validateJevBatch(batch);
  const r = record(raw),
    answers = record(r?.answers),
    expected = Object.keys(batch.questions);
  if (
    !r ||
    !keys(r, ["model", "answers", "usage"]) ||
    r.model !== batch.model ||
    !answers ||
    Object.keys(answers).some((k) => !expected.includes(k))
  )
    return refusedDecisions(batch, "binding_error", cost);
  return batch.participants.map((p, i) => {
    const direction = choice(answers[`a${i}_direction`], ["long", "short"]),
      intent = choice(answers[`a${i}_intent`], ["open", "hold", "close"]);
    const position = p.context.account!.position;
    let reason: JevAccountDecision["reason"] = "ok";
    if (!direction || !intent) reason = "malformed_response";
    else if (
      (intent.choice === "open" && position) ||
      (intent.choice === "close" && !position) ||
      (position &&
        intent.choice !== "open" &&
        direction.choice !== position.direction)
    )
      reason = "incompatible_position";
    return {
      scope: p.context.scope,
      context_id: p.context_id,
      direction,
      intent,
      action: reason === "ok" ? intent!.choice : null,
      reason,
      attributed_cost_usd6: batch.purpose === "operation" ? cost : null,
    };
  });
}
/** A persisted result is audit evidence, not permission to execute a stale or changed position. */
export function usableJevDecision(
  result: JevBatchResult,
  scope: JevScope,
  account: JevContext["account"],
  at: string,
) {
  const d = result.decisions.find((x) => jevHash(x.scope) === jevHash(scope));
  const p = result.batch.participants.find(
    (x) => jevHash(x.context.scope) === jevHash(scope),
  );
  if (
    result.batch.purpose !== "operation" ||
    !d ||
    !p ||
    d.reason !== "ok" ||
    result.cost_usd6 === null ||
    result.origin !== "real" ||
    !result.response_received_at ||
    jevTime(at) < jevTime(result.response_received_at) ||
    jevTime(at) >= jevTime(result.batch.expires_at) ||
    jevTime(result.finished_at) >= jevTime(result.batch.deadline_at) ||
    !account ||
    jevHash(account) !== jevHash(p.context.account)
  )
    return null;
  if (
    d.action === "open" &&
    (account.entries_paused || account.risk_blocked || !account.recovery_ready)
  )
    return null;
  return d;
}
