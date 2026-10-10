import type { JevScope } from "@ganso-market/contracts/trading";
import type { SqlExecutor } from "../database.js";
import type { LiveSnapshot } from "../venues/hyperliquid/live-reconcile.js";
import type { LiveProtectionRecord } from "../venues/hyperliquid/live-protection.js";
import { readJevPilotTx } from "./jev-pilotstore.js";
import { readJevPromotionTx } from "./jev-promotion.js";
import { jevHash } from "./jev-hash.js";

/** Live context comes from venue journals and lifetime pilot risk, never the
 * deliberately unfunded paper ledger. Repeated identical reads don't obsolete
 * inference, but a fill, fee, funding, risk latch or binding change does. */
export async function jevLiveDecisionStateTx(
  tx: SqlExecutor,
  scope: JevScope,
  cut: string | null = null,
) {
  const pilot = cut
    ? (
        await tx.query<NonNullable<Awaited<ReturnType<typeof readJevPilotTx>>>>(
          "SELECT sequence::text,checkpoint FROM jev_pilot_events WHERE account_id=$1 AND recorded_at<=$2 AND (checkpoint->'observation'->>'received_at')::timestamptz<=$2 ORDER BY jev_pilot_events.sequence DESC LIMIT 1",
          [scope.account_id, cut],
        )
      ).rows[0]
    : await readJevPilotTx(tx, scope.account_id);
  const row = (
    await tx.query<{
      identity_hash: string;
      payload: LiveSnapshot;
      recorded_at: Date;
    }>(
      `SELECT i.identity_hash,e.payload,e.recorded_at FROM jev_live_identities i JOIN LATERAL
    (SELECT payload,recorded_at FROM jev_live_events WHERE identity_hash=i.identity_hash AND kind='snapshot'
    AND ($3::timestamptz IS NULL OR (payload->>'snapshot_id'=$4 AND recorded_at<=$3::timestamptz AND (payload->>'received_at')::bigint<=extract(epoch FROM $3::timestamptz)*1000)) ORDER BY recorded_at DESC,event_key DESC LIMIT 1) e ON true
    WHERE i.account_id=$1 AND i.owner_id=$2 AND i.environment='mainnet'`,
      [
        scope.account_id,
        scope.owner_id,
        cut,
        pilot?.checkpoint.observation.evidence_id ?? null,
      ],
    )
  ).rows[0];
  const promotion = cut
    ? (
        await tx.query<
          NonNullable<Awaited<ReturnType<typeof readJevPromotionTx>>>
        >(
          "SELECT sequence::text,state,profile_id,profile_version,experiment_id FROM jev_live_promotions WHERE account_id=$1 AND recorded_at<=$2 ORDER BY jev_live_promotions.sequence DESC LIMIT 1",
          [scope.account_id, cut],
        )
      ).rows[0]
    : await readJevPromotionTx(tx, scope.account_id);
  if (!row || !pilot || promotion?.experiment_id !== scope.experiment_id)
    return null;
  const balance = (
    await tx.query<{ payload: { reconciled: boolean } }>(
      "SELECT payload FROM jev_live_events WHERE identity_hash=$1 AND kind='balance' AND payload->>'snapshot_id'=$2 AND ($3::timestamptz IS NULL OR recorded_at<=$3::timestamptz) ORDER BY recorded_at DESC LIMIT 1",
      [row.identity_hash, row.payload.snapshot_id, cut],
    )
  ).rows[0];
  const gap = (
    await tx.query<{ recorded_at: Date }>(
      "SELECT recorded_at FROM jev_live_events WHERE identity_hash=$1 AND kind='gap' AND ($2::timestamptz IS NULL OR recorded_at<=$2::timestamptz) ORDER BY recorded_at DESC LIMIT 1",
      [row.identity_hash, cut],
    )
  ).rows[0];
  const protection =
    (
      await tx.query<{ payload: LiveProtectionRecord }>(
        "SELECT payload FROM jev_live_events WHERE identity_hash=$1 AND kind='protection' AND payload->'protection'->'scope'->>'experiment_id'=$2 AND ($3::timestamptz IS NULL OR recorded_at<=$3::timestamptz) ORDER BY recorded_at DESC,event_key DESC LIMIT 1",
        [row.identity_hash, scope.experiment_id, cut],
      )
    ).rows[0]?.payload ?? null;
  const snapshot = row.payload,
    risk = pilot.checkpoint.risk;
  const ready =
    snapshot.consistent &&
    snapshot.history_complete &&
    snapshot.isolated_1x &&
    balance?.payload.reconciled === true &&
    (!gap || gap.recorded_at < row.recorded_at) &&
    pilot.checkpoint.observation.evidence_id === snapshot.snapshot_id &&
    (snapshot.position_raw === "0" || protection?.state === "confirmed");
  const hash = jevHash({
    scope,
    promotion,
    position: snapshot.position_raw,
    cash: snapshot.trading_balance_raw,
    equity: snapshot.equity_raw,
    orders: snapshot.orders,
    fills: snapshot.fills,
    funding: snapshot.funding,
    protection: protection?.protection ?? null,
    ready,
    global_blocked: pilot.checkpoint.global_blocked,
    risk: {
      paused: risk.entries_paused,
      hwm: risk.high_water_usd_raw,
      day: risk.day,
      daily: risk.daily_anchor_usd_raw,
    },
  });
  return {
    snapshot,
    risk,
    protection: protection?.protection ?? null,
    ready,
    hash,
    promotion,
  };
}
