import type {
  TradingInstrumentMetadata,
  TradingMarketData,
} from "@ganso-market/contracts/trading";
import type { SqlExecutor } from "../database.js";
import type { ClosedBar } from "../trading/bars.js";
import type { FundingReceipt } from "../trading/funding.js";
import {
  projectFinancials,
  type ValuationCapture,
} from "../trading/valuation.js";
import { observeRiskTx } from "./riskstore.js";
import { readReservationsTx } from "./reservationstore.js";
import { readIsolatedMarginTx } from "./valuationstore.js";
import {
  storeRetentionObjectTx,
  pinRetentionObjectTx,
} from "./btc-retention.js";
import {
  baselineHash,
  baselineIso,
  type BaselineRecord,
  type BaselineRegistration,
  type BaselineEnvironment,
  type BaselineBars,
} from "./baseline-inputs.js";

export type RegistrationRow = {
  registration: BaselineRegistration;
  evidence_id: string;
  enabled: boolean;
};
export async function baselineRegistrationTx(tx: SqlExecutor, account: string) {
  const row = (
    await tx.query<RegistrationRow>(
      `SELECT r.registration,r.evidence_id,c.enabled
    FROM btc_baseline_registrations r JOIN btc_desk_controls c USING(account_id)
    JOIN btc_ledger_accounts a USING(account_id) WHERE r.account_id=$1
    AND a.identity->'account'->>'purpose'='baseline' AND a.identity->'account'->>'mode'='paper'
    AND c.broker='ioc' AND c.latency_ms=1000`,
      [account],
    )
  ).rows[0];
  if (!row) throw new Error("BTC_BASELINE_REGISTRATION_REQUIRED");
  return row;
}
export const baselineClock = async (tx: SqlExecutor) =>
  (
    await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
  ).rows[0]!.now.toISOString();
export function baselineRecord<T>(
  object_id: string,
  payload: T,
  recorded_at: string,
): BaselineRecord<T> {
  return {
    object_id,
    payload,
    recorded_at,
    payload_hash: baselineHash(payload),
  };
}
export async function baselineEvidenceTx<T>(
  tx: SqlExecutor,
  r: RegistrationRow,
  id: string,
  payload: T,
  at: string,
  dependencies: string[] = [],
) {
  await storeRetentionObjectTx(tx, {
    id,
    class: "decision",
    identity: r.registration.scope,
    recordedAt: new Date(at),
    payload,
    dependencies: [...new Set(dependencies)].sort(),
  });
  await pinRetentionObjectTx(
    tx,
    id,
    id,
    "baseline paper prospective decision and replay",
  );
  return baselineRecord(id, payload, at);
}
async function retained<T>(
  tx: SqlExecutor,
  id: string | null,
): Promise<BaselineRecord<T> | null> {
  if (!id) return null;
  const row = (
    await tx.query<{ payload: T; recorded_at: Date }>(
      "SELECT payload,recorded_at FROM btc_retention_objects WHERE object_id=$1",
      [id],
    )
  ).rows[0];
  return row
    ? baselineRecord(id, row.payload, row.recorded_at.toISOString())
    : null;
}
/** Actual account state under the retention/recovery/owner fence. Persist only
 * when referenced by a decision/action, not on every idle heartbeat. */
export async function baselineEnvironmentTx(
  tx: SqlExecutor,
  r: RegistrationRow,
) {
  const scope = r.registration.scope,
    observed = await observeRiskTx(tx, scope);
  const at = observed.checkpoint.observed_at;
  const { isolation, metadata } = await readIsolatedMarginTx(
    tx,
    observed.ledger,
    observed.market,
  );
  const capture = (
    await tx.query<{ object_id: string }>(
      "SELECT object_id FROM btc_market_records WHERE kind='capture' AND received_at <= $1 ORDER BY received_at DESC,object_id LIMIT 1",
      [at],
    )
  ).rows[0];
  const market = {
    book: await retained<TradingMarketData>(
      tx,
      observed.market.book?.object_id ?? null,
    ),
    context: await retained<TradingMarketData>(
      tx,
      observed.market.context?.object_id ?? null,
    ),
    capture: await retained<ValuationCapture>(tx, capture?.object_id ?? null),
  };
  const receipts = (
    await tx.query<{
      result: FundingReceipt;
      recorded_at: Date;
      evidence_id: string;
    }>(
      `SELECT f.result,o.recorded_at,f.evidence_id FROM btc_funding_results f
    JOIN btc_retention_objects o ON o.object_id=f.evidence_id WHERE f.account_id=$1 AND f.period_hour=date_trunc('hour',$2::timestamptz)
    AND o.recorded_at <= $2 ORDER BY f.sequence DESC LIMIT 32`,
      [scope.account_id, at],
    )
  ).rows;
  const funding = receipts.map((row) =>
    baselineRecord(
      `baseline-funding:${baselineHash([scope.account_id, row.evidence_id])}`,
      row.result,
      row.recorded_at.toISOString(),
    ),
  );
  const priorExit = (
    await tx.query<{ last_closed: string | null; exit_pending: boolean }>(
      `SELECT
    (SELECT MAX(payload->>'closed_bar_end_at') FROM btc_baseline_events WHERE account_id=$1 AND kind='position') AS last_closed,
    EXISTS(SELECT 1 FROM (SELECT DISTINCT ON(position_id) payload FROM btc_baseline_events WHERE account_id=$1 AND kind='position' ORDER BY position_id,sequence DESC) p
      WHERE p.payload->'position'->>'requested_at' IS NOT NULL AND p.payload->>'state' <> 'closed') AS exit_pending`,
      [scope.account_id],
    )
  ).rows[0]!;
  const reservations = await readReservationsTx(tx, scope.account_id);
  const account = baselineRecord(
    `baseline-account:${baselineHash([scope.account_id, at, observed.checkpoint, reservations])}`,
    {
      projection: projectFinancials(
        observed.ledger.projection,
        observed.ledger.events,
      ),
      risk: observed.checkpoint,
      reservations,
      funding_usable_for_risk: observed.funding.usable_for_risk,
      recovery_ready: true,
      accounting_consistent: true,
      entries_paused: !r.enabled,
      // Dataset retention HOLD is independent from the trading account's HALTED guard.
      hold: observed.checkpoint.state === "HALTED",
      exit_pending: priorExit.exit_pending,
      last_closed_bar_end_at: priorExit.last_closed,
    },
    at,
  );
  const recovery = (
    await tx.query(
      "SELECT generation::text,status,worker_id FROM btc_recovery_heads WHERE account_id=$1",
      [scope.account_id],
    )
  ).rows[0];
  account.object_id = `baseline-account:${baselineHash([scope.account_id, at, account.payload, recovery, Object.values(market).map((x) => x?.object_id ?? null), funding.map((x) => x.object_id)])}`;
  const env: BaselineEnvironment = {
    enabled: r.enabled,
    registration: r.registration,
    metadata: await retained<TradingInstrumentMetadata>(
      tx,
      metadata?.object_id ?? null,
    ),
    account,
    market,
    funding,
  };
  return {
    env,
    observed,
    isolation,
    at,
    async persist() {
      for (const [i, f] of funding.entries())
        await baselineEvidenceTx(tx, r, f.object_id, f.payload, f.recorded_at, [
          receipts[i]!.evidence_id,
        ]);
      // The complete immutable ledger and checkpoint are retained with the snapshot;
      // market/funding objects remain transitively pinned with original timestamps.
      const deps = [
        r.evidence_id,
        ...Object.values(market).flatMap((x) => (x ? [x.object_id] : [])),
        ...funding.map((f) => f.object_id),
        ...(env.metadata ? [env.metadata.object_id] : []),
      ];
      const source = await baselineEvidenceTx(
        tx,
        r,
        `${account.object_id}:source`,
        {
          events: observed.ledger.events,
          funding: observed.funding,
          checkpoint: observed.checkpoint,
          recovery,
        },
        at,
        deps,
      );
      await baselineEvidenceTx(tx, r, account.object_id, account.payload, at, [
        source.object_id,
      ]);
    },
  };
}
/** Bounded indexed bars and their retained original input timestamps. A missing
 * historical origin is unavailable (never relabel a truncated window as warmup). */
export async function baselineBarsTx(
  tx: SqlExecutor,
  interval: number,
  count: number,
  end: string,
  at: string,
): Promise<BaselineBars> {
  const rows = (
    await tx.query<{
      object_id: string;
      payload: ClosedBar;
      recorded_at: Date;
    }>(
      `SELECT b.object_id,o.payload,o.recorded_at FROM btc_market_bars b
    JOIN btc_retention_objects o USING(object_id) WHERE interval_ms=$1 AND end_at <= $2 AND o.recorded_at <= $3
    ORDER BY end_at DESC LIMIT $4`,
      [interval, end, at, count],
    )
  ).rows;
  const records = rows.map((x) =>
    baselineRecord(x.object_id, x.payload, x.recorded_at.toISOString()),
  );
  const ids = [...new Set(records.flatMap((r) => r.payload.input_ids))];
  const dependencies = ids.length
    ? (
        await tx.query<{
          object_id: string;
          payload: unknown;
          recorded_at: Date;
          received_at: Date | null;
        }>(
          `SELECT o.object_id,o.payload,o.recorded_at,r.received_at
    FROM btc_retention_objects o LEFT JOIN btc_market_records r USING(object_id) WHERE o.object_id=ANY($1::text[])`,
          [ids],
        )
      ).rows.map((x) => ({
        object_id: x.object_id,
        payload_hash: baselineHash(x.payload),
        recorded_at: x.recorded_at.toISOString(),
        received_at: (x.received_at ?? x.recorded_at).toISOString(),
      }))
    : [];
  return { records, dependencies, first_complete_start_at: null };
}
export const decisionBoundary = (at: string) =>
  baselineIso(Math.floor((Date.parse(at) - 10000) / 900000) * 900000);
