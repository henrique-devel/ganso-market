import { createHash } from "node:crypto";
import { baselineTime } from "./baseline-inputs.js";
import { canonicalFingerprint } from "../trading/replay.js";
import { assertEvidenceJson } from "../trading/retention.js";
import { type BaselineDecision } from "./baseline-policy.js";
import {
  parseLedgerEvent,
  validateLedgerIdentity,
  type LedgerEvent,
  type LedgerIdentity,
} from "./ledger-contract.js";
import {
  validateReservationCommand,
  type ReservationCommand,
} from "./reservation-contract.js";
import {
  LEDGER_VERSION,
  ledgerScope,
  replayLedger,
} from "../trading/ledger.js";
import {
  reservationHold,
  release,
  RESERVATION_VERSION,
  type Reservation,
} from "../trading/reservations.js";
import { projectFinancials, VALUATION_VERSION } from "../trading/valuation.js";
import type { StorageIdentity } from "../trading/retention.js";

export const REPLAY_VERSION = "btc.replay.captured.v1";
export const REPLAY_LIMITS = Object.freeze({
  rows: 4096,
  decisions: 256,
  objects: 16384,
  bytes: 16 * 1024 * 1024,
  depth: 32,
});
export const REPLAY_CONTRACTS = Object.freeze({
  ledger: LEDGER_VERSION,
  reservations: RESERVATION_VERSION,
  valuation: VALUATION_VERSION,
  replay: REPLAY_VERSION,
});
export interface ReplayEvidence {
  object_id: string;
  class: string;
  identity: StorageIdentity;
  recorded_at: string;
  payload: unknown;
  dependencies: string[];
  payload_hash: string;
}
export interface ReplayReservation {
  sequence: string;
  recorded_at: string;
  request: ReservationCommand;
  reservation: Reservation;
  ledger_transaction_id: string | null;
}
export interface ReplayDataset {
  schema_version: typeof REPLAY_VERSION;
  /** Export implementation; experiment code SHA remains in its captured registration. */
  code_sha: string;
  contracts: typeof REPLAY_CONTRACTS;
  cut: {
    captured_at: string;
    ledger_sequence: string;
    reservation_sequence: string;
    semantics: "locked_account_snapshot";
  };
  identity: LedgerIdentity;
  ledger: LedgerEvent[];
  reservations: ReplayReservation[];
  decisions: { evidence_id: string; decision: BaselineDecision }[];
  jev: {
    decision_id: string;
    evidence_id: string;
    state: string;
    origin: string;
    model: string;
    request_id: string;
    request: unknown;
    outcome: unknown;
  }[];
  roots: string[];
  evidence: ReplayEvidence[];
}
export interface ReplayArtifact {
  dataset_id: string;
  dataset: ReplayDataset;
}
export function requireReplay(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(`BTC_REPLAY_${code}`);
}
/** Captured JSON may contain fractional nonfinancial model probabilities.
 * Amounts remain validated decimal strings by the existing ledger contracts. */
export function replayHash(value: unknown): string {
  assertEvidenceJson(value);
  return createHash("sha256")
    .update(canonicalFingerprint(value), "utf8")
    .digest("hex");
}
export function sealReplayDataset(dataset: ReplayDataset): ReplayArtifact {
  assertEvidenceJson(dataset);
  requireReplay(
    Buffer.byteLength(canonicalFingerprint(dataset)) <= REPLAY_LIMITS.bytes,
    "BYTE_LIMIT",
  );
  return { dataset_id: `btc-replay:${replayHash(dataset)}`, dataset };
}
const same = (a: unknown, b: unknown) => replayHash(a) === replayHash(b);
/** Captured-event replay, not a counterfactual strategy/backtest. No I/O, clock,
 * model call, admission or broker. Reservations never become cash expenses. */
export function replayDataset(artifact: ReplayArtifact) {
  const d = artifact.dataset;
  requireReplay(
    sealReplayDataset(d).dataset_id === artifact.dataset_id,
    "HASH",
  );
  requireReplay(
    d.schema_version === REPLAY_VERSION && same(d.contracts, REPLAY_CONTRACTS),
    "CONTRACT_VERSION",
  );
  requireReplay(
    /^[a-f0-9]{40}$/.test(d.code_sha) &&
      d.cut.semantics === "locked_account_snapshot",
    "MANIFEST",
  );
  const cut = baselineTime(d.cut.captured_at);
  validateLedgerIdentity(d.identity);
  requireReplay(
    d.ledger.length <= REPLAY_LIMITS.rows &&
      d.reservations.length <= REPLAY_LIMITS.rows &&
      d.decisions.length <= REPLAY_LIMITS.decisions &&
      d.jev.length <= REPLAY_LIMITS.decisions &&
      d.evidence.length <= REPLAY_LIMITS.objects,
    "ROW_LIMIT",
  );
  const objects = new Map(d.evidence.map((o) => [o.object_id, o]));
  requireReplay(
    objects.size === d.evidence.length &&
      new Set(d.roots).size === d.roots.length,
    "DUPLICATE_OBJECT",
  );
  for (const o of d.evidence) {
    requireReplay(
      o.payload_hash === replayHash(o.payload) &&
        baselineTime(o.recorded_at) <= cut,
      "EVIDENCE_HASH_OR_TIME",
    );
    requireReplay(
      o.identity.mode === "paper" &&
        o.identity.instrument_id === d.identity.instrument.instrument_id &&
        o.identity.instrument_version ===
          d.identity.instrument.instrument_version,
      "EVIDENCE_INSTRUMENT",
    );
    requireReplay(
      o.dependencies.every((id) => objects.has(id)),
      "DEPENDENCY_MISSING",
    );
  }
  requireReplay(
    d.roots.every((id) => objects.has(id)),
    "ROOT_MISSING",
  );
  // Detect cycles, excessive depth and extraneous objects. Exact closure is part of identity.
  const reached = new Set<string>();
  const visit = (id: string, path: Set<string>) => {
    requireReplay(
      !path.has(id) && path.size <= REPLAY_LIMITS.depth,
      "DEPENDENCY_CYCLE_OR_DEPTH",
    );
    if (reached.has(id)) return;
    const next = new Set(path).add(id);
    for (const dep of objects.get(id)!.dependencies) visit(dep, next);
    reached.add(id);
  };
  for (const id of d.roots) visit(id, new Set());
  requireReplay(reached.size === objects.size, "EXTRANEOUS_EVIDENCE");
  const events = d.ledger.map(parseLedgerEvent);
  for (const [i, e] of events.entries()) {
    requireReplay(
      e.sequence === String(i + 1) &&
        baselineTime(e.recorded_at) <= cut &&
        baselineTime(e.occurred_at) <= cut,
      "LEDGER_ORDER_OR_CUT",
    );
    if (i)
      requireReplay(
        e.recorded_at >= events[i - 1]!.recorded_at,
        "LEDGER_ARRIVAL",
      );
  }
  const projection = replayLedger(d.identity, events);
  requireReplay(
    projection.last_sequence === d.cut.ledger_sequence &&
      String(d.reservations.length) === d.cut.reservation_sequence,
    "HIGH_WATER",
  );
  const financials = projectFinancials(projection, events);
  const pending = new Map<string, Reservation>();
  const operationIds = new Set<string>();
  for (const [i, r] of d.reservations.entries()) {
    const q = r.request;
    validateReservationCommand(q);
    requireReplay(
      r.sequence === String(i + 1) &&
        baselineTime(r.recorded_at) <= cut &&
        !operationIds.has(q.operation_id),
      "RESERVATION_ORDER_OR_CUT",
    );
    if (i)
      requireReplay(
        r.recorded_at >= d.reservations[i - 1]!.recorded_at,
        "RESERVATION_ARRIVAL",
      );
    operationIds.add(q.operation_id);
    let expected: Reservation;
    if (q.action === "reserve") {
      requireReplay(
        !pending.has(q.order.order_id) && r.ledger_transaction_id === null,
        "RESERVATION_DUPLICATE",
      );
      expected = reservationHold(q.order, BigInt(q.order.quantity_btc_raw));
    } else {
      const before = pending.get(q.order_id);
      requireReplay(before?.status === "active", "RESERVATION_HISTORY");
      if (q.action === "release") {
        requireReplay(r.ledger_transaction_id === null, "RELEASE_TRANSACTION");
        expected = release(before, q.reason);
      } else {
        const quantity = BigInt(q.quantity_btc_raw),
          remaining = BigInt(before.remaining_btc_raw);
        requireReplay(
          quantity <= remaining &&
            BigInt(q.price_usd_raw) <= BigInt(before.order.price_cap_usd_raw),
          "CONSUMPTION",
        );
        const batch = events.filter(
          (e) => e.transaction_id === r.ledger_transaction_id,
        );
        const fill = batch.find(
          (e) => e.payload.event_type === "fill",
        )?.payload;
        const fee = batch.find((e) => e.payload.event_type === "fee")?.payload;
        requireReplay(
          batch.length === 2 &&
            fill?.event_type === "fill" &&
            fee?.event_type === "fee" &&
            fill.order_id === q.order_id &&
            fill.position_id === before.order.position_id &&
            fill.side === before.order.side &&
            fill.quantity.raw === q.quantity_btc_raw &&
            fill.price.raw === q.price_usd_raw &&
            fee.execution_id === fill.execution_id &&
            BigInt(fee.delta.raw) === -BigInt(q.fee_usd_raw) &&
            batch.every((e) => e.recorded_at === r.recorded_at),
          "CONSUMPTION_LEDGER",
        );
        expected = reservationHold(before.order, remaining - quantity);
      }
    }
    requireReplay(same(expected, r.reservation), "RESERVATION_PROJECTION");
    pending.set(expected.order.order_id, expected);
  }
  const decisions = [...d.decisions].sort(
    (a, b) =>
      a.decision.decision_at.localeCompare(b.decision.decision_at) ||
      a.decision.decision_id.localeCompare(b.decision.decision_id),
  );
  requireReplay(
    new Set(decisions.map((x) => x.decision.decision_id)).size ===
      decisions.length,
    "DUPLICATE_DECISION",
  );
  const fidelity: {
    decision_id: string;
    state: string;
    reasons: string[];
    missing_inputs: string[];
    jev: string;
  }[] = [];
  for (const { decision: decision, evidence_id } of decisions) {
    const o = objects.get(evidence_id);
    requireReplay(
      o &&
        d.roots.includes(evidence_id) &&
        same(o.payload, decision) &&
        same(decision.registration.scope, ledgerScope(d.identity)) &&
        baselineTime(decision.decision_at) <= cut,
      "DECISION_EVIDENCE",
    );
    const missing: string[] = [];
    for (const ref of decision.input_refs) {
      const input = objects.get(ref.object_id);
      if (!input) {
        missing.push(ref.object_id);
        continue;
      }
      requireReplay(
        input.payload_hash === ref.payload_hash &&
          input.recorded_at === ref.recorded_at &&
          input.recorded_at <= decision.decision_at,
        "DECISION_AS_OF",
      );
      const payload = input.payload as { received_at?: string };
      requireReplay(
        !payload.received_at ||
          baselineTime(payload.received_at) <=
            baselineTime(decision.decision_at),
        "DECISION_LOOKAHEAD",
      );
    }
    const jev = d.jev.find((j) => j.decision_id === decision.decision_id);
    fidelity.push({
      decision_id: decision.decision_id,
      state: decision.state,
      reasons: decision.reasons,
      missing_inputs: missing,
      jev: !jev
        ? "not_captured"
        : jev.state !== "final"
          ? "response_missing"
          : `captured_${jev.origin}`,
    });
  }
  requireReplay(
    new Set(d.jev.map((j) => j.decision_id)).size === d.jev.length &&
      d.jev.every(
        (j) =>
          decisions.some((x) => x.decision.decision_id === j.decision_id) &&
          objects.has(j.evidence_id) &&
          ["real", "mock"].includes(j.origin) &&
          ["prepared", "dispatching", "final"].includes(j.state) &&
          (j.state === "final") === (j.outcome !== null),
      ),
    "JEV_CAPTURE",
  );
  const reservations = [...pending.values()].sort((a, b) =>
    a.order.order_id.localeCompare(b.order.order_id),
  );
  return {
    dataset_id: artifact.dataset_id,
    schema_version: REPLAY_VERSION,
    cut: d.cut,
    financials,
    reservations,
    decisions: decisions.map((x) => x.decision),
    jev: d.jev,
    fidelity,
    limits: [
      "captured_decisions_not_policy_reexecution",
      "recorded_fills_only_no_counterfactual_execution",
      "funding_paper_approximation_preserved",
      "economic_time_does_not_reorder_arrival",
      "no_cross_stream_causal_order_inferred",
      "no_mark_equity_without_as_of_market",
    ],
    active_reserved_usd_raw: reservations
      .filter((r) => r.status === "active")
      .reduce(
        (n, r) => n + BigInt(r.margin_usd_raw) + BigInt(r.fee_usd_raw),
        0n,
      )
      .toString(),
    late_funding_event_ids: events
      .filter(
        (e) =>
          e.payload.event_type === "funding" && e.recorded_at > e.occurred_at,
      )
      .map((e) => e.event_id),
  };
}
/** Call before comparing results. Different cuts/owners/inputs never compare implicitly. */
export function requireSameReplayDataset(a: ReplayArtifact, b: ReplayArtifact) {
  replayDataset(a);
  replayDataset(b);
  requireReplay(a.dataset_id === b.dataset_id, "INCOMPATIBLE_DATASETS");
}
