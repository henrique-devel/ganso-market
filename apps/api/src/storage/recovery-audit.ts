import { createHash } from "node:crypto";
import type { SqlExecutor } from "../database.js";
import { canonicalFingerprint } from "../trading/replay.js";
import { ledgerScope, replayLedger } from "../trading/ledger.js";
import {
  reservationHold,
  release,
  type Reservation,
  type ReservationOrder,
} from "../trading/reservations.js";
import {
  fundingDelta,
  fundingPositions,
  type FundingReceipt,
} from "../trading/funding.js";
import type { RiskCheckpoint } from "../trading/risk.js";
import {
  genesisBatch,
  materializeLedgerBatch,
  parseLedgerEvent,
  type LedgerBatch,
  type LedgerIdentity,
} from "./ledger-contract.js";
import {
  validateReservationCommand,
  type ReservationCommand,
} from "./reservation-contract.js";

const tables = [
  "btc_ledger_accounts",
  "btc_ledger_transactions",
  "btc_ledger_events",
  "btc_order_acceptances",
  "btc_reservation_events",
  "btc_ioc_intents",
  "btc_ioc_results",
  "btc_passive_events",
  "btc_passive_results",
  "btc_passive_trades",
  "btc_funding_results",
  "btc_margin_results",
  "btc_risk_events",
] as const;
const receipts = [
  "btc_ioc_results",
  "btc_passive_results",
  "btc_funding_results",
  "btc_margin_results",
] as const;
function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(`BTC_RECOVERY_${code}`);
}
const same = (a: unknown, b: unknown, code: string) =>
  check(canonicalFingerprint(a) === canonicalFingerprint(b), code);
/** Immutable history + the complete retained evidence graph. Only the mutable
 * ledger projection is excluded. Checkpoints are never accepted as balances.
 * SQL identifiers below are closed constants, not caller input. */
export async function recoverySnapshotTx(tx: SqlExecutor, id: string) {
  const hash = createHash("sha256"),
    cursors: Record<string, number> = {};
  for (const table of tables) {
    const { rows } = await tx.query<{ value: unknown }>(
      `SELECT to_jsonb(t) AS value FROM ${table} t WHERE account_id=$1 ORDER BY to_jsonb(t)::text`,
      [id],
    );
    cursors[table] = rows.length;
    hash.update(canonicalFingerprint([table, rows]));
  }
  const rootIds = new Set<string>();
  const owner = (
    await tx.query(
      "SELECT identity FROM btc_ledger_accounts WHERE account_id=$1",
      [id],
    )
  ).rows[0]!;
  for (const table of receipts) {
    const { rows } = await tx.query<{
      request: unknown;
      result: unknown;
      evidence_id: string;
      identity: unknown;
      payload: { request: unknown; result?: unknown };
      pinned: boolean;
    }>(
      `SELECT r.request,r.result,r.evidence_id,o.identity,o.payload,
       EXISTS(SELECT 1 FROM btc_retention_pins p WHERE p.object_id=r.evidence_id AND p.pin_id=r.evidence_id) AS pinned
       FROM ${table} r LEFT JOIN btc_retention_objects o ON o.object_id=r.evidence_id WHERE r.account_id=$1 ORDER BY r.operation_id`,
      [id],
    );
    for (const row of rows) {
      check(row.pinned && row.payload, "EVIDENCE_MISSING");
      same(row.payload.request, row.request, "EVIDENCE_DIVERGENCE");
      // IOC submit stores decision provenance before its accepted receipt.
      if (row.payload.result !== undefined)
        same(row.payload.result, row.result, "EVIDENCE_DIVERGENCE");
      else
        check(
          table === "btc_ioc_results" &&
            (row.request as { action: string }).action === "submit",
          "EVIDENCE_DIVERGENCE",
        );
      same(
        row.identity,
        ledgerScope(owner.identity as LedgerIdentity),
        "EVIDENCE_OWNERSHIP",
      );
      rootIds.add(row.evidence_id);
    }
  }
  const graph = (
    await tx.query<{
      object_id: string;
      payload: unknown;
      identity: unknown;
      dependencies: string[];
      actual: string[];
    }>(
      `WITH RECURSIVE graph(object_id) AS (
       SELECT unnest($1::text[]) UNION SELECT d.dependency_id FROM btc_retention_dependencies d JOIN graph g USING(object_id)
     ) SELECT g.object_id,o.payload,o.identity,o.dependencies,
       ARRAY(SELECT dependency_id FROM btc_retention_dependencies d WHERE d.object_id=g.object_id ORDER BY dependency_id) AS actual
       FROM graph g LEFT JOIN btc_retention_objects o USING(object_id) ORDER BY g.object_id`,
      [[...rootIds].sort()],
    )
  ).rows;
  for (const row of graph) {
    check(row.payload && row.dependencies, "EVIDENCE_MISSING");
    same([...row.dependencies].sort(), row.actual, "EVIDENCE_GRAPH");
  }
  hash.update(canonicalFingerprint(graph));
  cursors.evidence = graph.length;
  return { digest: hash.digest("hex"), cursors };
}
/** Validate authorities against one another before rebuilding a projection.
 * Never rewrite a ledger/reservation/risk/funding event to make replay agree. */
export async function auditRecoveryTx(
  tx: SqlExecutor,
  identity: LedgerIdentity,
) {
  const id = identity.account.account_id;
  const history = (
    await tx.query(
      "SELECT event FROM btc_ledger_events WHERE account_id=$1 ORDER BY sequence",
      [id],
    )
  ).rows.map((r) => parseLedgerEvent(r.event));
  const projection = replayLedger(identity, history);
  const batches = (
    await tx.query<{ request: LedgerBatch }>(
      "SELECT request FROM btc_ledger_transactions WHERE account_id=$1 ORDER BY transaction_id",
      [id],
    )
  ).rows;
  check(batches.length > 0, "LEDGER_MISSING");
  for (const { request } of batches) {
    const events = history.filter(
      (e) => e.transaction_id === request.transaction_id,
    );
    check(events.length, "TRANSACTION_MISSING_EVENTS");
    same(
      events,
      materializeLedgerBatch(
        request,
        (BigInt(events[0]!.sequence) - 1n).toString(),
        events[0]!.recorded_at,
      ),
      "TRANSACTION_DIVERGENCE",
    );
  }
  same(
    batches.find((r) => r.request.transaction_id === "genesis")?.request,
    genesisBatch(identity),
    "GENESIS_DIVERGENCE",
  );
  const accepted = (
    await tx.query<{ request: ReservationOrder }>(
      "SELECT request FROM btc_order_acceptances WHERE account_id=$1",
      [id],
    )
  ).rows;
  const reservations = (
    await tx.query<{
      sequence: string;
      request: ReservationCommand;
      reservation: Reservation;
      ledger_transaction_id: string | null;
    }>(
      "SELECT sequence::text,request,reservation,ledger_transaction_id FROM btc_reservation_events WHERE account_id=$1 ORDER BY sequence",
      [id],
    )
  ).rows;
  const state = new Map<string, Reservation>();
  for (const [index, row] of reservations.entries()) {
    check(row.sequence === String(index + 1), "RESERVATION_SEQUENCE");
    const r = row.request;
    validateReservationCommand(r);
    const orderId = r.action === "reserve" ? r.order.order_id : r.order_id;
    let next: Reservation;
    if (r.action === "reserve") {
      check(
        !state.has(orderId) && row.ledger_transaction_id === null,
        "RESERVATION_DUPLICATE",
      );
      same(
        accepted.find((a) => a.request.order_id === orderId)?.request,
        r.order,
        "ACCEPTANCE_DIVERGENCE",
      );
      next = reservationHold(r.order, BigInt(r.order.quantity_btc_raw));
    } else {
      const prior = state.get(orderId);
      check(prior?.status === "active", "RESERVATION_TRANSITION");
      if (r.action === "release") {
        check(row.ledger_transaction_id === null, "RESERVATION_RELEASE");
        next = release(prior, r.reason);
      } else {
        const remaining =
          BigInt(prior.remaining_btc_raw) - BigInt(r.quantity_btc_raw);
        check(
          remaining >= 0n &&
            row.ledger_transaction_id === `reservation:${r.operation_id}`,
          "RESERVATION_CONSUMPTION",
        );
        const events = history.filter(
          (e) => e.transaction_id === row.ledger_transaction_id,
        );
        const fill = events[0]?.payload,
          fee = events[1]?.payload;
        check(
          events.length === 2 &&
            fill?.event_type === "fill" &&
            fee?.event_type === "fee",
          "FILL_MISSING",
        );
        check(
          fill.order_id === orderId &&
            fill.position_id === prior.order.position_id &&
            fill.side === prior.order.side &&
            fill.quantity.raw === r.quantity_btc_raw &&
            fill.price.raw === r.price_usd_raw &&
            BigInt(fee.delta.raw) === -BigInt(r.fee_usd_raw) &&
            fill.execution_id === fee.execution_id,
          "FILL_DIVERGENCE",
        );
        next = reservationHold(prior.order, remaining);
      }
    }
    same(next, row.reservation, "RESERVATION_DIVERGENCE");
    state.set(orderId, next);
  }
  check(state.size === accepted.length, "RESERVATION_MISSING");
  for (const e of history) {
    if (
      e.payload.event_type === "fill" &&
      e.transaction_id.startsWith("reservation:")
    )
      check(
        reservations.some((r) => r.ledger_transaction_id === e.transaction_id),
        "RESERVATION_MISSING",
      );
  }
  const funding = (
    await tx.query<{ result: FundingReceipt }>(
      "SELECT result FROM btc_funding_results WHERE account_id=$1 ORDER BY sequence",
      [id],
    )
  ).rows.map((r) => r.result);
  const fundingEvents = history.filter(
    (e) => e.payload.event_type === "funding",
  );
  const matched = new Set<string>();
  for (const r of funding.filter((r) => r.status === "settled")) {
    check(r.cutoff, "FUNDING_CUTOFF");
    const positions = fundingPositions(history, r.cutoff);
    check(!positions.ambiguous.length, "FUNDING_AMBIGUOUS");
    same(
      positions.positions,
      r.positions.map(({ position_id, quantity_btc_raw }) => ({
        position_id,
        quantity_btc_raw,
      })),
      "FUNDING_POSITION",
    );
    for (const p of r.positions) {
      const candidates = fundingEvents.filter(
        (e) =>
          e.payload.event_type === "funding" &&
          e.payload.position_id === p.position_id &&
          e.payload.period_end === r.cutoff,
      );
      check(candidates.length === 1 && r.oracle_usd_raw, "FUNDING_EVENT");
      const e = candidates[0]!,
        payload = e.payload;
      check(payload.event_type === "funding", "FUNDING_EVENT");
      check(
        payload.delta.raw === p.delta_usd_raw &&
          payload.delta.raw ===
            fundingDelta(
              p.quantity_btc_raw,
              r.oracle_usd_raw,
              payload.rate.raw,
            ),
        "FUNDING_DELTA",
      );
      matched.add(e.event_id);
    }
  }
  check(matched.size === fundingEvents.length, "FUNDING_UNPROVEN");
  const risks = (
    await tx.query<{
      sequence: string;
      checkpoint: RiskCheckpoint;
      request: { action: string };
    }>(
      "SELECT sequence::text,checkpoint,request FROM btc_risk_events WHERE account_id=$1 ORDER BY sequence",
      [id],
    )
  ).rows;
  for (const [i, row] of risks.entries()) {
    const c = row.checkpoint,
      previous = risks[i - 1]?.checkpoint;
    check(
      row.sequence === String(i + 1) &&
        c.version === "btc.risk.v1" &&
        ["NORMAL", "REDUCE_ONLY", "HALTED"].includes(c.state) &&
        BigInt(c.ledger_sequence) <= BigInt(projection.last_sequence) &&
        BigInt(c.high_water_usd_raw) > 0n,
      "RISK_CHECKPOINT",
    );
    check(
      !previous ||
        c.state !== "NORMAL" ||
        previous.state === "NORMAL" ||
        row.request.action === "rearm",
      "RISK_REARM",
    );
  }
  // Missing observations cannot be synthesized from today's mark. S8 will also
  // refuse history_unobserved, but recovery never certifies this history ready.
  check(
    risks.length || history.every((e) => e.payload.event_type === "cash"),
    "RISK_HISTORY_MISSING",
  );
  return projection;
}
