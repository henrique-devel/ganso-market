import { createHash } from "node:crypto";
import type { DatabasePool } from "../database.js";
import { ledgerScope } from "../trading/ledger.js";
import { canonicalFingerprint } from "../trading/replay.js";
import {
  valueFinancials,
  type ValuationCapture,
  type MarketEvidence,
} from "../trading/valuation.js";
import { lockableLedgerAccountTx } from "./ledgerstore.js";
import { parseLedgerEvent, type LedgerIdentity } from "./ledger-contract.js";
import { replayFinancials } from "./valuationstore.js";
import {
  pinRetentionObjectTx,
  storeRetentionObjectTx,
} from "./btc-retention.js";
import type { Reservation } from "../trading/reservations.js";

const equityHash = (value: unknown) =>
  createHash("sha256").update(canonicalFingerprint(value)).digest("hex");

type Pool = Pick<DatabasePool, "transaction" | "readOnly">;
export const EQUITY_VERSION = "btc.equity-observation.v1";
export const EQUITY_LIMITS = Object.freeze({
  cadenceMs: 300000,
  accounts: 2,
  ledgerEvents: 4096,
  reservationEvents: 4096,
  chargedBytes: 12288,
});

/** New observation only. DB snapshot plus immutable sequence/hash is the knowledge
 * boundary; wall time alone cannot prove commit visibility. Never backfill. */
export async function sampleEquityAccount(
  pool: Pick<DatabasePool, "transaction">,
  accountId: string,
) {
  return pool.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await tx.query("SET LOCAL statement_timeout='1500ms'");
    await tx.query("SET LOCAL lock_timeout='250ms'");
    // Same order as retention writers, bounded lock; retry next scheduled cut on conflict.
    await tx.query("SELECT pg_advisory_xact_lock(741044,4)");
    const admission = (
      await tx.query(
        `SELECT a.identity, clock_timestamp() AS now FROM btc_equity_admissions s JOIN btc_ledger_accounts a USING(account_id) WHERE (SELECT count(*) FROM btc_equity_admissions WHERE start_at<=clock_timestamp() AND end_at>clock_timestamp())<=2 AND s.account_id=$1 AND s.start_at<=clock_timestamp() AND s.end_at>clock_timestamp()`,
        [accountId],
      )
    ).rows[0];
    if (!admission) return { status: "not_admitted" as const };
    const at = (admission.now as Date).toISOString();
    const slot = new Date(
      Math.floor(Date.parse(at) / 300000) * 300000,
    ).toISOString();
    const prior = (
      await tx.query(
        "SELECT evidence_id FROM btc_equity_observations WHERE account_id=$1 AND slot=$2",
        [accountId, slot],
      )
    ).rows[0];
    if (prior)
      return {
        status: "duplicate" as const,
        evidence_id: String(prior.evidence_id),
      };
    const capacity = (
      await tx.query(
        "SELECT total_bytes::text FROM btc_retention_policy WHERE dataset_id='btc-paper-v1'",
      )
    ).rows[0];
    if (
      !capacity ||
      BigInt(String(capacity.total_bytes)) + 12288n > 6n * 1024n ** 3n
    )
      throw new Error("BTC_EQUITY_CAPACITY");
    const identity = admission.identity as LedgerIdentity;
    const scope = ledgerScope(identity);
    await lockableLedgerAccountTx(tx, scope);
    const rows = (
      await tx.query(
        "SELECT event FROM btc_ledger_events WHERE account_id=$1 ORDER BY sequence LIMIT 4097",
        [accountId],
      )
    ).rows;
    const reservations = (
      await tx.query(
        "SELECT sequence::text,recorded_at,reservation FROM btc_reservation_events WHERE account_id=$1 ORDER BY sequence LIMIT 4097",
        [accountId],
      )
    ).rows;
    if (rows.length > 4096 || reservations.length > 4096)
      throw new Error("BTC_EQUITY_HISTORY_BOUND");
    const events = rows.map((r) => parseLedgerEvent(r.event));
    if (
      events.some((e) => e.recorded_at > at || e.occurred_at > at) ||
      reservations.some((r) => (r.recorded_at as Date).toISOString() > at)
    )
      throw new Error("BTC_EQUITY_FUTURE_LEDGER");
    const context =
      (
        await tx.query<{
          object_id: string;
          payload: MarketEvidence["payload"];
        }>(
          `SELECT r.object_id,o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.kind='context' AND r.received_at<=$1 AND o.recorded_at<=$1 ORDER BY r.received_at DESC,r.object_id LIMIT 1`,
          [at],
        )
      ).rows[0] ?? null;
    const capture =
      (
        await tx.query<{ object_id: string; payload: ValuationCapture }>(
          `SELECT r.object_id,o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.kind='capture' AND r.received_at<=$1 AND o.recorded_at<=$1 ORDER BY r.received_at DESC,r.object_id LIMIT 1`,
          [at],
        )
      ).rows[0] ?? null;
    const value = valueFinancials(replayFinancials(identity, events), {
      as_of: at,
      context,
      book: null,
      capture: capture?.payload ?? null,
    });
    const active = new Map<string, Reservation>();
    for (const row of reservations) {
      const r = row.reservation as Reservation;
      active.set(r.order.order_id, r);
    }
    let held = 0n,
      capital = 0n,
      transfers = 0n;
    for (const r of active.values())
      if (r.status === "active")
        held += BigInt(r.margin_usd_raw) + BigInt(r.fee_usd_raw);
    for (const e of events)
      if (e.payload.event_type === "cash") {
        if (e.payload.reason === "initial_allocation")
          capital += BigInt(e.payload.delta.raw);
        else transfers += BigInt(e.payload.delta.raw);
      }
    const period = (
      await tx.query(
        `SELECT evidence_id,period->>'purpose' AS purpose,start_at,end_at FROM btc_baseline_periods WHERE account_id=$1 AND start_at<=$2 AND end_at>$2 ORDER BY start_at DESC LIMIT 1`,
        [accountId, at],
      )
    ).rows[0];
    const original = (
      await tx.query(
        `SELECT evidence_id,registration->>'start_at' AS start_at FROM btc_baseline_registrations WHERE account_id=$1`,
        [accountId],
      )
    ).rows[0];
    const dependencies = [
      context?.object_id,
      capture?.object_id,
      period?.evidence_id,
      original?.evidence_id,
    ].filter((x): x is string => typeof x === "string");
    const payload = {
      schema_version: EQUITY_VERSION,
      scope,
      slot,
      observed_at: at,
      knowledge_basis: "repeatable_read_visible_sequences_not_wall_time_alone",
      financial_start_at: identity.experiment.started_at,
      period: period
        ? {
            evidence_id: period.evidence_id,
            purpose: period.purpose,
            start_at: (period.start_at as Date).toISOString(),
            end_at: (period.end_at as Date).toISOString(),
          }
        : {
            evidence_id: original?.evidence_id ?? null,
            purpose: "original_unspecified",
            start_at: original?.start_at ?? identity.experiment.started_at,
          },
      ledger: {
        last_sequence: value.ledger.last_sequence,
        hash: equityHash(events),
      },
      reservations: {
        last_sequence: reservations.at(-1)?.sequence ?? "0",
        hash: equityHash(
          reservations.map((r) => ({
            sequence: r.sequence,
            reservation: r.reservation,
          })),
        ),
        held_usd_raw: held.toString(),
      },
      capital_usd_raw: capital.toString(),
      external_flows_usd_raw: transfers.toString(),
      realized_pnl_usd_raw: value.realized_pnl_usd_raw,
      fees_usd_raw: value.fees_usd_raw,
      funding_usd_raw: value.funding_usd_raw,
      balance_usd_raw: value.balance_usd_raw,
      unrealized_pnl_usd_raw: value.maintenance.unrealized_pnl_usd_raw,
      equity_usd_raw: value.maintenance.equity_usd_raw,
      mark: {
        quality: value.maintenance.quality,
        evidence: value.maintenance.evidence,
        mark_price: value.maintenance.mark_price,
        source_timestamp: value.maintenance.source_timestamp,
        received_at: value.maintenance.received_at,
        freshness_timestamp: value.maintenance.freshness_timestamp,
        timestamp_basis: value.maintenance.timestamp_basis,
      },
      capture_evidence_id: capture?.object_id ?? null,
      status:
        value.maintenance.equity_usd_raw === null ? "unavailable" : "available",
      funding_basis:
        "paper_ledger_known_at_snapshot_not_complete_venue_funding",
      units: "USD6_BTC8",
      risk_authorization: false,
    };
    const evidenceId = `equity:${accountId}:${slot}`;
    const stored = await storeRetentionObjectTx(tx, {
      id: evidenceId,
      class: "financial",
      identity: scope,
      recordedAt: new Date(at),
      payload,
      dependencies: [...new Set(dependencies)],
    });
    if (BigInt(stored.chargedBytes) > 12288n)
      throw new Error("BTC_EQUITY_BYTE_BOUND");
    await pinRetentionObjectTx(
      tx,
      evidenceId,
      evidenceId,
      "equity observation temporal evidence",
    );
    await tx.query(
      "INSERT INTO btc_equity_observations(account_id,slot,observed_at,evidence_id) VALUES($1,$2,$3,$4)",
      [accountId, slot, at, evidenceId],
    );
    return {
      status: "stored" as const,
      evidence_id: evidenceId,
      charged_bytes: stored.chargedBytes,
    };
  });
}

/** Existing API loop, at most two sequential accounts. Empty admission table is
 * the default. Missing slots remain missing across restart and capacity failures. */
export async function sampleAdmittedEquity(pool: Pool) {
  const accounts = await pool.readOnly(
    1500,
    async (tx) =>
      (
        await tx.query<{ account_id: string }>(
          "SELECT account_id FROM btc_equity_admissions WHERE start_at<=clock_timestamp() AND end_at>clock_timestamp() ORDER BY account_id LIMIT 3",
        )
      ).rows,
  );
  if (accounts.length > 2) throw new Error("BTC_EQUITY_ACCOUNT_BOUND");
  for (const a of accounts) await sampleEquityAccount(pool, a.account_id);
}

/** Bounded verifier for a persisted cut, never a historical capture API. The
 * immutable prefix is authoritative even if a later commit carries an earlier
 * economic or application recorded timestamp. Market evidence stays pinned. */
export async function verifyEquityObservation(
  pool: Pick<DatabasePool, "transaction">,
  accountId: string,
  slot: string,
) {
  return pool.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await tx.query("SET LOCAL statement_timeout='1500ms'");
    const row = (
      await tx.query(
        `SELECT o.payload FROM btc_equity_observations e JOIN btc_retention_objects o ON o.object_id=e.evidence_id WHERE e.account_id=$1 AND e.slot=$2`,
        [accountId, slot],
      )
    ).rows[0];
    if (!row) return null;
    const p = row.payload as {
      schema_version: string;
      observed_at: string;
      scope: ReturnType<typeof ledgerScope>;
      ledger: { last_sequence: string; hash: string };
      reservations: { last_sequence: string; hash: string };
      mark: { evidence: string | null };
      capture_evidence_id: string | null;
      equity_usd_raw: string | null;
      unrealized_pnl_usd_raw: string | null;
      balance_usd_raw: string;
      realized_pnl_usd_raw: string;
      fees_usd_raw: string;
      funding_usd_raw: string;
    };
    if (p.schema_version !== EQUITY_VERSION || p.scope.account_id !== accountId)
      throw new Error("BTC_EQUITY_CONTRACT");
    const identity = await lockableLedgerAccountTx(tx, p.scope);
    const events = (
      await tx.query(
        "SELECT event FROM btc_ledger_events WHERE account_id=$1 AND sequence<=$2 ORDER BY sequence LIMIT 4097",
        [accountId, p.ledger.last_sequence],
      )
    ).rows.map((r) => parseLedgerEvent(r.event));
    const reservations = (
      await tx.query(
        "SELECT sequence::text,reservation FROM btc_reservation_events WHERE account_id=$1 AND sequence<=$2 ORDER BY sequence LIMIT 4097",
        [accountId, p.reservations.last_sequence],
      )
    ).rows;
    if (
      events.length > 4096 ||
      reservations.length > 4096 ||
      equityHash(events) !== p.ledger.hash ||
      equityHash(reservations) !== p.reservations.hash
    )
      throw new Error("BTC_EQUITY_PREFIX_MISMATCH");
    const evidence = async <T>(id: string | null): Promise<T | null> => {
      if (!id) return null;
      const row = (
        await tx.query(
          "SELECT payload FROM btc_retention_objects WHERE object_id=$1",
          [id],
        )
      ).rows[0];
      if (!row) throw new Error("BTC_EQUITY_EVIDENCE_MISSING");
      return row.payload as T;
    };
    const context = await evidence<MarketEvidence["payload"]>(p.mark.evidence);
    const value = valueFinancials(replayFinancials(identity, events), {
      as_of: p.observed_at,
      book: null,
      context: context
        ? { object_id: p.mark.evidence!, payload: context }
        : null,
      capture: await evidence<ValuationCapture>(p.capture_evidence_id),
    });
    for (const k of [
      "balance_usd_raw",
      "realized_pnl_usd_raw",
      "fees_usd_raw",
      "funding_usd_raw",
    ] as const)
      if (value[k] !== p[k]) throw new Error("BTC_EQUITY_REPLAY_MISMATCH");
    if (
      value.maintenance.equity_usd_raw !== p.equity_usd_raw ||
      value.maintenance.unrealized_pnl_usd_raw !== p.unrealized_pnl_usd_raw
    )
      throw new Error("BTC_EQUITY_REPLAY_MISMATCH");
    return row.payload;
  });
}
