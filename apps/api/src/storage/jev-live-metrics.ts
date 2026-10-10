import type { JevPanelMetrics } from "@ganso-market/contracts/trading";
import type { SqlExecutor } from "../database.js";
import type { LiveSnapshot } from "../venues/hyperliquid/live-reconcile.js";
import type { LiveBalanceProof } from "./jev-live-store.js";
import type { JevPilotCheckpoint } from "./jev-pilotstore.js";
import { money, utc } from "../trading/metrics.js";

export interface LivePanelSource {
  identity_hash: string;
  snapshot: LiveSnapshot | null;
  proof: LiveBalanceProof | null;
  gap: boolean;
  opening_at: Date | null;
  pilot: JevPilotCheckpoint | null;
}
/** One immutable venue cut, selected inside the caller's READ ONLY snapshot.
 * Never call PgLiveStore's writing/locking methods from presentation. */
export async function readJevLiveSourceTx(
  tx: SqlExecutor,
  owner: string,
  account: string,
  at: string,
) {
  return (
    (
      await tx.query<LivePanelSource>(
        `
    SELECT i.identity_hash,s.payload snapshot,b.payload proof,
      (g.recorded_at IS NOT NULL AND (s.recorded_at IS NULL OR g.recorded_at>=s.recorded_at)) gap,
      (o.checkpoint->'observation'->>'observed_at')::timestamptz opening_at,p.checkpoint pilot
    FROM jev_live_identities i
    LEFT JOIN LATERAL (SELECT payload,recorded_at FROM jev_live_events WHERE identity_hash=i.identity_hash AND kind='snapshot' AND recorded_at<=$3 ORDER BY recorded_at DESC,event_key DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (SELECT payload FROM jev_live_events WHERE identity_hash=i.identity_hash AND kind='balance' AND payload->>'snapshot_id'=s.payload->>'snapshot_id' AND recorded_at<=$3 ORDER BY recorded_at DESC,event_key DESC LIMIT 1) b ON true
    LEFT JOIN LATERAL (SELECT recorded_at FROM jev_live_events WHERE identity_hash=i.identity_hash AND kind='gap' AND recorded_at<=$3 ORDER BY recorded_at DESC,event_key DESC LIMIT 1) g ON true
    LEFT JOIN LATERAL (SELECT checkpoint FROM jev_pilot_events WHERE account_id=i.account_id AND recorded_at<=$3 ORDER BY sequence LIMIT 1) o ON true
    LEFT JOIN LATERAL (SELECT checkpoint FROM jev_pilot_events WHERE account_id=i.account_id AND recorded_at<=$3 ORDER BY sequence DESC LIMIT 1) p ON true
    WHERE i.owner_id=$1 AND i.account_id=$2 AND i.environment='mainnet' LIMIT 1`,
        [owner, account, at],
      )
    ).rows[0] ?? null
  );
}
export interface LiveCashflows {
  realized: string;
  fees: string;
  funding: string;
}
export function projectJevLiveMetrics(input: {
  at: string;
  source: LivePanelSource | null;
  flows: LiveCashflows;
  attributed_jev: string | null;
}): JevPanelMetrics {
  const { source: v, flows, at } = input,
    s = v?.snapshot,
    now = utc(at);
  const reasons: string[] = [];
  if (!s) reasons.push("LIVE_SOURCE_MISSING");
  if (
    s &&
    (s.identity_hash !== v!.identity_hash ||
      !s.consistent ||
      !s.history_complete)
  )
    reasons.push("LIVE_HISTORY_GAP");
  if (v?.gap) reasons.push("LIVE_RECONCILIATION_GAP");
  if (s && !s.isolated_1x) reasons.push("LIVE_ACCOUNT_MODE_UNCONFIRMED");
  if (
    s &&
    (s.started_at > s.received_at ||
      s.venue_at > s.received_at ||
      s.received_at > now ||
      s.venue_at > now ||
      now - s.started_at > 2000 ||
      now - s.venue_at > 2000)
  )
    reasons.push("LIVE_SOURCE_STALE");
  const anchored =
    !!s &&
    !!v?.opening_at &&
    v.opening_at.getTime() <= s.venue_at &&
    !!v.proof?.opening_evidence_id;
  const balance =
    anchored &&
    v!.proof!.reconciled &&
    v!.proof!.version === "hyperliquid.live-balance.v1" &&
    s!.version === "hyperliquid.live.v1" &&
    v!.proof!.identity_hash === v!.identity_hash &&
    v!.proof!.snapshot_id === s!.snapshot_id &&
    v!.proof!.observed_trading_balance_raw === s!.trading_balance_raw &&
    v!.proof!.expected_trading_balance_raw === s!.trading_balance_raw &&
    money(s!.trading_balance_raw) ===
      250000000n +
        money(flows.realized) -
        money(flows.fees) +
        money(flows.funding) &&
    money(s!.equity_raw) ===
      money(s!.trading_balance_raw) + money(s!.open_pnl_raw);
  if (!balance) reasons.push("LIVE_BALANCE_UNRECONCILED");
  const ready = reasons.length === 0;
  const r = money(flows.realized),
    fees = money(flows.fees),
    funding = money(flows.funding),
    open = s ? money(s.open_pnl_raw) : 0n;
  const pnl = r - fees + funding + open,
    cost = input.attributed_jev;
  if (cost === null) reasons.push("LIVE_JEV_COST_UNKNOWN");
  return {
    as_of: at,
    source: "hyperliquid_live_reconciled",
    source_as_of: s ? new Date(s.venue_at).toISOString() : null,
    snapshot_id: s?.snapshot_id ?? null,
    reasons,
    capital_usd6: anchored ? "250000000" : null,
    risk_equity_usd6: ready ? s!.equity_raw : null,
    trading_balance_usd6: ready ? s!.trading_balance_raw : null,
    high_water_usd6: v?.pilot?.risk.high_water_usd_raw ?? null,
    trading: {
      realized_usd6: ready ? flows.realized : null,
      fees_usd6: ready ? flows.fees : null,
      funding_usd6: ready ? flows.funding : null,
      open_usd6: ready ? s!.open_pnl_raw : null,
      pnl_usd6: ready ? pnl.toString() : null,
      funding_complete: ready,
    },
    attributed_jev_usd6: cost,
    strategy_after_jev_usd6:
      ready && cost !== null ? (pnl - money(cost)).toString() : null,
    conservative_result_usd6:
      ready && cost !== null
        ? (
            r -
            fees +
            funding +
            (open < 0n ? open : 0n) -
            money(cost)
          ).toString()
        : null,
    quality: ready
      ? "fresh"
      : reasons.includes("LIVE_SOURCE_STALE")
        ? "stale"
        : "unavailable",
    positions: ready
      ? [{ position_id: "hyperliquid:BTC", quantity_btc_raw: s!.position_raw }]
      : [],
  };
}
/** Each principal request appears once; lifetime attribution spans every bound
 * version. Generation is charged once per linked alternative, never per binding. */
export async function readJevLiveCostTx(
  tx: SqlExecutor,
  owner: string,
  account: string,
  at: string,
  profile?: { id: string; version: string; start: string; end: string },
) {
  const rows = await tx.query<{ known: string; unknown: number }>(
    `
    WITH costs AS (
      SELECT r.request_id,s.cost_usd6,
        EXISTS(SELECT 1 FROM jev_decision_participants p WHERE p.origin=r.origin AND p.request_id=r.request_id AND p.owner_id=$1 AND p.account_id=$2
          AND ($4::text IS NULL OR (p.profile_id=$4 AND p.profile_version=$5 AND r.started_at>=$6::timestamptz AND r.started_at<$7::timestamptz))) linked,false unresolved
      FROM jev_decision_requests r LEFT JOIN jev_decision_results s USING(origin,request_id) WHERE r.origin='real' AND r.started_at<$3
      AND EXISTS(SELECT 1 FROM jev_decision_participants p WHERE p.origin=r.origin AND p.request_id=r.request_id AND p.owner_id=$1)
      UNION ALL
      SELECT r.request_id,s.cost_usd6,
        EXISTS(SELECT 1 FROM jev_bindings b WHERE b.owner_id=$1 AND b.account_id=$2 AND b.profile_id=p.profile_id AND b.profile_version=p.profile_version
          AND ($4::text IS NULL OR (b.profile_id=$4 AND b.profile_version=$5))) linked,r.proposal_id IS NULL unresolved
      FROM jev_proposal_requests r LEFT JOIN jev_proposals p USING(owner_id,proposal_id) LEFT JOIN jev_proposal_results s USING(origin,request_id)
      WHERE r.origin='real' AND r.owner_id=$1 AND r.started_at<$3)
    SELECT COALESCE(sum(cost_usd6) FILTER(WHERE linked),0)::text known,
      count(*) FILTER(WHERE (linked AND cost_usd6 IS NULL) OR unresolved)::int unknown FROM costs`,
    [
      owner,
      account,
      at,
      profile?.id ?? null,
      profile?.version ?? null,
      profile?.start ?? null,
      profile?.end ?? null,
    ],
  );
  const value = rows.rows[0]!;
  return value.unknown ? null : value.known;
}
export async function readJevLiveFlowsTx(
  tx: SqlExecutor,
  identity: string,
  start: number | null,
  end: number,
  at: string,
): Promise<LiveCashflows> {
  return (
    await tx.query<LiveCashflows>(
      `
    SELECT COALESCE(sum((payload->>'realized_pnl_raw')::numeric) FILTER(WHERE kind='fill'),0)::text realized,
      COALESCE(sum((payload->>'fee_raw')::numeric) FILTER(WHERE kind='fill'),0)::text fees,
      COALESCE(sum((payload->>'amount_raw')::numeric) FILTER(WHERE kind='funding'),0)::text funding
    FROM jev_live_events WHERE identity_hash=$1 AND kind IN('fill','funding') AND recorded_at<=$4
      AND (payload->>'time')::bigint>=$2 AND (payload->>'time')::bigint<=$3`,
      [identity, start, end, at],
    )
  ).rows[0]!;
}
export async function readJevLiveMetricsTx(
  tx: SqlExecutor,
  owner: string,
  account: string,
  at: string,
) {
  const source = await readJevLiveSourceTx(tx, owner, account, at);
  const flows = source
    ? await readJevLiveFlowsTx(
        tx,
        source.identity_hash,
        source.opening_at?.getTime() ?? null,
        source.snapshot?.venue_at ?? 0,
        at,
      )
    : { realized: "0", fees: "0", funding: "0" };
  const metrics = projectJevLiveMetrics({
    at,
    source,
    flows,
    attributed_jev: await readJevLiveCostTx(tx, owner, account, at),
  });
  return { metrics, source };
}
