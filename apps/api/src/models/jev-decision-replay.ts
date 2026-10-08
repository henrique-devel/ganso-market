import { requireJev } from "@ganso-market/contracts/trading";
import { jevHash } from "../storage/jev-hash.js";
import { parseJevResponseJson } from "./jev-response-json.js";
import { record, usageCost } from "./jev-contract.js";
import {
  interpretJevBatch,
  refusedDecisions,
  validateJevBatch,
  type JevBatchResult,
  type JevFailure,
} from "./jev-decision-contract.js";
/** Derive from the captured body only. Billing is independent of judgment validity. */
export function deriveJevResult(input: JevBatchResult): JevBatchResult {
  const r = structuredClone(input);
  let raw: unknown = null;
  let ambiguous = false,
    billingAmbiguous = false;
  if (r.original_response !== null) {
    r.response_hash = jevHash(r.original_response);
    try {
      const parsed = parseJevResponseJson(r.original_response);
      raw = parsed.value;
      const answers = record(record(raw)?.answers);
      if (answers)
        for (const key of parsed.invalidQuestions) answers[key] = null;
      ambiguous = parsed.ambiguous;
      billingAmbiguous = parsed.billingAmbiguous;
    } catch {
      /* Captured malformed body is preserved. */
    }
  }
  const billed =
    r.tariff && r.original_response !== null && !billingAmbiguous
      ? usageCost(raw, r.tariff)
      : null;
  if (r.attempted) {
    r.usage = billed?.usage ?? null;
    r.cost_usd6 = billed?.cost ?? null;
  }
  if (!r.attempted) {
    r.cost_usd6 = "0";
    r.usage = null;
  }
  const timely =
    r.response_received_at !== null &&
    Date.parse(r.response_received_at) < Date.parse(r.batch.deadline_at) &&
    Date.parse(r.finished_at) < Date.parse(r.batch.deadline_at);
  if (
    r.original_response !== null &&
    r.http_status === 200 &&
    timely &&
    [
      "ok",
      "partial_error",
      "binding_error",
      "malformed_response",
      "cost_unknown",
    ].includes(r.reason)
  ) {
    if (!billed) {
      r.reason = "cost_unknown";
      r.decisions = refusedDecisions(r.batch, "cost_unknown", null);
    } else {
      r.decisions = ambiguous
        ? refusedDecisions(r.batch, "binding_error", billed.cost)
        : interpretJevBatch(r.batch, raw, billed.cost);
      r.reason = r.decisions.every((d) => d.reason === "ok")
        ? "ok"
        : r.decisions.every((d) => d.reason === "binding_error")
          ? "binding_error"
          : "partial_error";
    }
  } else {
    if (r.attempted && !timely && r.original_response !== null)
      r.reason = "timeout";
    r.decisions = refusedDecisions(
      r.batch,
      r.reason as JevFailure,
      r.cost_usd6,
    );
  }
  return r;
}
export function replayJevDecision(result: JevBatchResult): JevBatchResult {
  validateJevBatch(result.batch);
  requireJev(
    result.schema_version === result.batch.schema_version &&
      ["real", "mock"].includes(result.origin),
    "REPLAY_VERSION",
  );
  requireJev(result.batch_hash === jevHash(result.batch), "REPLAY_BATCH_HASH");
  requireJev(
    result.response_hash ===
      (result.original_response === null
        ? null
        : jevHash(result.original_response)),
    "REPLAY_RESPONSE_HASH",
  );
  const replay = deriveJevResult(result);
  requireJev(jevHash(replay) === jevHash(result), "REPLAY_RESULT_COLLISION");
  return replay;
}
