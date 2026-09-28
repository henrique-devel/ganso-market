import { ledgerScope, replayLedger } from "../trading/ledger.js";
import {
  projectFinancials,
  valueFinancials,
  type MarketEvidence,
  type ValuationCapture,
} from "../trading/valuation.js";
import { drawdown, utc } from "../trading/metrics.js";
import {
  replayHash,
  requireReplay,
  REPLAY_LIMITS,
  type ReplayDataset,
} from "./replay-dataset.js";

const CADENCE = 300000;
interface Observation {
  schema_version: string;
  scope: unknown;
  slot: string;
  observed_at: string;
  financial_start_at: string;
  ledger: { last_sequence: string; hash: string };
  reservations: { last_sequence: string; hash: string; held_usd_raw: string };
  capital_usd_raw: string;
  external_flows_usd_raw: string;
  realized_pnl_usd_raw: string;
  fees_usd_raw: string;
  funding_usd_raw: string;
  balance_usd_raw: string;
  equity_usd_raw: string | null;
  unrealized_pnl_usd_raw: string | null;
  mark: { evidence: string | null };
  capture_evidence_id: string | null;
}
/** Pure, bounded verification of the versioned snapshot extension. Never resolves
 * references over SQL/network and never backfills absent historical marks. */
export function replayEquityHistory(d: ReplayDataset) {
  const history = d.equity_history;
  if (!history) return null;
  requireReplay(
    history.schema_version === "btc.replay-equity.v1" &&
      Array.isArray(history.observation_ids) &&
      history.observation_ids.length <= REPLAY_LIMITS.rows &&
      new Set(history.observation_ids).size === history.observation_ids.length,
    "EQUITY_VERSION_OR_LIMIT",
  );
  const objects = new Map(d.evidence.map((o) => [o.object_id, o]));
  const from = utc(d.identity.experiment.started_at),
    to = utc(d.cut.captured_at);
  const firstSlot = Math.floor(from / CADENCE) * CADENCE;
  const finalSlot = Math.floor(to / CADENCE) * CADENCE;
  const expected = Math.floor((finalSlot - firstSlot) / CADENCE) + 1;
  let previous = -1,
    previousLedger = 0,
    previousReservations = 0,
    prefixWork = 0;
  const points: {
    at: string;
    equity_usd_raw: string | null;
    adjusted_equity_usd_raw: string | null;
    unrealized_pnl_usd_raw: string | null;
    evidence_id: string;
  }[] = [];
  let lastMarket: Parameters<typeof valueFinancials>[1] | null = null;
  for (const id of history.observation_ids) {
    const object = objects.get(id);
    requireReplay(object && d.roots.includes(id), "EQUITY_EVIDENCE");
    const p = object.payload as Observation;
    requireReplay(
      p.schema_version === "btc.equity-observation.v1" &&
        replayHash(p.scope) === replayHash(ledgerScope(d.identity)) &&
        p.financial_start_at === d.identity.experiment.started_at,
      "EQUITY_IDENTITY",
    );
    const at = utc(p.observed_at),
      slot = utc(p.slot);
    requireReplay(
      at >= from &&
        at <= to &&
        object.recorded_at === p.observed_at &&
        slot === Math.floor(at / CADENCE) * CADENCE &&
        slot > previous,
      "EQUITY_TIME",
    );
    previous = slot;
    const prefix = (value: string, length: number) => {
      requireReplay(
        /^(0|[1-9][0-9]{0,4})$/.test(value) && Number(value) <= length,
        "EQUITY_PREFIX",
      );
      return Number(value);
    };
    const n = prefix(p.ledger.last_sequence, d.ledger.length),
      m = prefix(p.reservations.last_sequence, d.reservations.length);
    requireReplay(
      n >= previousLedger &&
        m >= previousReservations &&
        (!d.ledger[n] ||
          d.ledger[n]?.transaction_id !== d.ledger[n - 1]?.transaction_id),
      "EQUITY_PREFIX_BOUNDARY",
    );
    prefixWork += n + m;
    requireReplay(n > 0 && prefixWork <= 262144, "EQUITY_WORK_LIMIT");
    previousLedger = n;
    previousReservations = m;
    const events = d.ledger.slice(0, n),
      reservations = d.reservations.slice(0, m);
    requireReplay(
      events.every(
        (e) => utc(e.recorded_at) <= at && utc(e.occurred_at) <= at,
      ) &&
        reservations.every((r) => utc(r.recorded_at) <= at) &&
        replayHash(events) === p.ledger.hash &&
        replayHash(
          reservations.map((r) => ({
            sequence: r.sequence,
            reservation: r.reservation,
          })),
        ) === p.reservations.hash,
      "EQUITY_PREFIX_HASH",
    );
    const transactions = new Set(events.map((e) => e.transaction_id));
    requireReplay(
      d.reservations.every(
        (r, i) =>
          r.ledger_transaction_id === null ||
          transactions.has(r.ledger_transaction_id) === i < m,
      ),
      "EQUITY_ATOMIC_PREFIX",
    );
    const evidence = <T>(key: string | null): T | null => {
      if (key === null) return null;
      const e = objects.get(key);
      requireReplay(
        e && object.dependencies.includes(key) && utc(e.recorded_at) <= at,
        "EQUITY_MARK_EVIDENCE",
      );
      return e.payload as T;
    };
    const context = evidence<MarketEvidence["payload"]>(p.mark.evidence);
    const market = {
      as_of: p.observed_at,
      book: null,
      context: context
        ? { object_id: p.mark.evidence!, payload: context }
        : null,
      capture: evidence<ValuationCapture>(p.capture_evidence_id),
    };
    const financials = projectFinancials(
      replayLedger(d.identity, events),
      events,
    );
    const v = valueFinancials(financials, market);
    let capital = 0n,
      flows = 0n,
      held = 0n;
    for (const e of events)
      if (e.payload.event_type === "cash") {
        if (e.payload.reason === "initial_allocation")
          capital += BigInt(e.payload.delta.raw);
        else flows += BigInt(e.payload.delta.raw);
      }
    const active = new Map(
      reservations.map((r) => [r.reservation.order.order_id, r.reservation]),
    );
    for (const r of active.values())
      if (r.status === "active")
        held += BigInt(r.margin_usd_raw) + BigInt(r.fee_usd_raw);
    requireReplay(
      capital.toString() === p.capital_usd_raw &&
        flows.toString() === p.external_flows_usd_raw &&
        held.toString() === p.reservations.held_usd_raw,
      "EQUITY_CASH_OR_HOLD",
    );
    for (const key of [
      "balance_usd_raw",
      "realized_pnl_usd_raw",
      "fees_usd_raw",
      "funding_usd_raw",
    ] as const)
      requireReplay(v[key] === p[key], "EQUITY_VALUE");
    requireReplay(
      v.maintenance.equity_usd_raw === p.equity_usd_raw &&
        v.maintenance.unrealized_pnl_usd_raw === p.unrealized_pnl_usd_raw,
      "EQUITY_VALUE",
    );
    points.push({
      at: p.observed_at,
      equity_usd_raw: p.equity_usd_raw,
      adjusted_equity_usd_raw:
        p.equity_usd_raw === null
          ? null
          : (BigInt(p.equity_usd_raw) - flows).toString(),
      unrealized_pnl_usd_raw: p.unrealized_pnl_usd_raw,
      evidence_id: id,
    });
    lastMarket = market;
  }
  const missing = Math.max(0, expected - points.length);
  const invalid = points.filter((p) => p.equity_usd_raw === null).length;
  const incomplete = missing > 0 || invalid > 0;
  const genesis = d.ledger[0]?.payload;
  requireReplay(
    genesis?.event_type === "cash" && genesis.reason === "initial_allocation",
    "EQUITY_GENESIS",
  );
  const observed = drawdown([
    genesis.delta.raw,
    ...points.flatMap((p) =>
      p.adjusted_equity_usd_raw === null ? [] : [p.adjusted_equity_usd_raw],
    ),
  ]);
  const full = projectFinancials(replayLedger(d.identity, d.ledger), d.ledger);
  // Revalue at the final cut, never carry forward a stale sample's PnL. The
  // existing valuation contract independently checks mark and capture freshness.
  const terminal = valueFinancials(
    full,
    lastMarket
      ? { ...lastMarket, as_of: d.cut.captured_at }
      : { as_of: d.cut.captured_at, book: null, context: null, capture: null },
  );
  return {
    schema_version: "btc.metrics-equity.v1",
    basis: "persisted_five_minute_observations_no_interpolation",
    points,
    status: incomplete ? "incomplete_equity_history" : "observed_cadence_only",
    coverage: {
      cadence_ms: CADENCE,
      expected_slots: expected,
      observed_slots: points.length,
      missing_slots: missing,
      unavailable_slots: invalid,
    },
    drawdown: {
      ...(incomplete ? drawdown([null]) : observed),
      status: incomplete ? "incomplete_equity_history" : observed.status,
      observed_max_usd_raw: observed.max_usd_raw,
      observed_max_ppm: observed.max_ppm,
      basis: "external_flows_removed_observed_samples",
      intrabar_extreme: null,
    },
    terminal: {
      equity_usd_raw: terminal.maintenance.equity_usd_raw,
      unrealized_pnl_usd_raw: terminal.maintenance.unrealized_pnl_usd_raw,
      mark_quality: terminal.maintenance.quality,
    },
  };
}
