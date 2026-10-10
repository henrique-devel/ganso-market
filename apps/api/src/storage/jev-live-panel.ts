import type {
  JevPanelAccount,
  JevPanelLiveState,
  JevLiveHistoryCursor,
} from "@ganso-market/contracts/trading";
import type { SqlExecutor } from "../database.js";
import {
  readJevLiveMetricsTx,
  readJevLiveFlowsTx,
  readJevLiveCostTx,
} from "./jev-live-metrics.js";
import type {
  LiveFill,
  LiveFunding,
} from "../venues/hyperliquid/live-reconcile.js";
import type { LiveProtectionRecord } from "../venues/hyperliquid/live-protection.js";

export function parseLiveHistoryCursor(
  value: unknown,
): JevLiveHistoryCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(value))
    throw new Error("JEV_PANEL_INVALID_QUERY");
  const c = JSON.parse(
    Buffer.from(value, "base64url").toString("utf8"),
  ) as JevLiveHistoryCursor;
  if (
    Object.keys(c).sort().join(",") !== "experiment_id,started_at" ||
    typeof c.started_at !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.started_at) ||
    !Number.isFinite(Date.parse(c.started_at)) ||
    new Date(c.started_at).toISOString() !== c.started_at ||
    typeof c.experiment_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/.test(c.experiment_id)
  )
    throw new Error("JEV_PANEL_INVALID_QUERY");
  return c;
}
/** Bounded, sanitized read model from the live journal; no raw signed actions,
 * credentials, wallets or external transport are exposed/called by GET. */
export async function readJevLiveAccountTx(
  tx: SqlExecutor,
  owner: string,
  account: string,
  at: string,
  cursor?: JevLiveHistoryCursor,
) {
  const { metrics, source } = await readJevLiveMetricsTx(
      tx,
      owner,
      account,
      at,
    ),
    s = source?.snapshot,
    identity = source?.identity_hash ?? null,
    now = Date.parse(at),
    ready = metrics.quality === "fresh";
  const rows = async <T extends import("pg").QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [identity, at],
  ) => (await tx.query<T>(sql, params)).rows;
  const fills = (
    await rows<{ payload: LiveFill }>(
      `SELECT payload FROM jev_live_events WHERE identity_hash=$1 AND kind='fill' AND recorded_at<=$2 AND (payload->>'time')::bigint<=$3 ORDER BY (payload->>'time')::bigint DESC,event_key DESC LIMIT 20`,
      [identity, at, s?.venue_at ?? 0],
    )
  ).map(({ payload: f }) => ({
    execution_id: f.key,
    order_id: String(f.oid),
    position_id: "hyperliquid:BTC",
    side: f.side,
    occurred_at: new Date(f.time).toISOString(),
    kind: f.maker ? ("maker" as const) : ("IOC" as const),
    quantity_btc_raw: f.quantity_raw,
    price_usd_raw: f.price_raw,
    fee_usd_raw: f.fee_raw,
  }));
  const receipts = await rows<JevPanelLiveState["receipts"][number]>(
    `
    SELECT r.operation_id,r.reservation->>'kind' kind,COALESCE(e.payload->>'state','no_receipt') state,
      CASE WHEN e.payload IS NOT NULL THEN to_char(to_timestamp((e.payload->>'observed_at')::numeric/1000) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END observed_at,e.payload->>'oid' order_id,
      r.reservation->'request'->'plan'->>'quantity_btc_raw' planned_btc_raw,
      (SELECT COALESCE(sum((f.payload->>'quantity_raw')::numeric),0)::text FROM jev_live_events f WHERE f.identity_hash=r.identity_hash AND f.kind='fill' AND f.recorded_at<=$2 AND (f.payload->>'time')::bigint<=$3 AND (f.payload->>'cloid'=r.reservation->>'cloid' OR (e.payload->>'oid' IS NOT NULL AND f.payload->>'oid'=e.payload->>'oid'))) filled_btc_raw,
      r.reservation->'scope'->>'profile_id' profile_id,r.reservation->'scope'->>'profile_version' profile_version,r.reservation->'scope'->>'experiment_id' experiment_id
    FROM jev_live_requests r LEFT JOIN LATERAL (SELECT payload FROM jev_live_events WHERE identity_hash=r.identity_hash AND kind='receipt' AND payload->>'operation_id'=r.operation_id AND recorded_at<=$2 ORDER BY recorded_at DESC,event_key DESC LIMIT 1) e ON true
    WHERE r.identity_hash=$1 AND r.recorded_at<=$2 ORDER BY r.recorded_at DESC,r.operation_id DESC LIMIT 20`,
    [identity, at, s?.venue_at ?? 0],
  );
  const p = (
    await rows<{ payload: LiveProtectionRecord }>(
      `SELECT payload FROM jev_live_events WHERE identity_hash=$1 AND kind='protection' AND recorded_at<=$2 ORDER BY recorded_at DESC,event_key DESC LIMIT 1`,
    )
  )[0]?.payload;
  const q = s ? BigInt(s.position_raw) : null,
    abs = q === null ? null : (q < 0n ? -q : q).toString();
  const confirmed =
    ready &&
    p?.state === "confirmed" &&
    p.protection?.quantity_btc_raw === abs &&
    now - p.observed_at <= 2000 &&
    p.observed_at <= now &&
    s!.orders.some(
      (o) =>
        o.cloid === p.native_cloid &&
        o.position_stop &&
        o.reduce_only &&
        o.side === (q! > 0n ? "sell" : "buy") &&
        BigInt(o.quantity_raw) >= BigInt(abs!) &&
        o.trigger_price_raw === p.protection!.stop_price_raw,
    );
  const runtime = (
    await rows<{
      observed_at: Date;
      current: boolean;
      state: { connected: boolean; entries_ready: boolean; reasons: string[] };
    }>(`
    SELECT r.observed_at,(r.observed_at<=$2 AND r.observed_at>$2::timestamptz-interval '3 seconds' AND h.lease_until>$2) current,r.state
    FROM jev_live_runtime r LEFT JOIN execution_worker_head h USING(generation) WHERE r.identity_hash=$1`)
  )[0];
  const funding = (
    await rows<{ payload: LiveFunding }>(
      `SELECT payload FROM jev_live_events WHERE identity_hash=$1 AND kind='funding' AND recorded_at<=$2 AND (payload->>'time')::bigint<=$3 ORDER BY (payload->>'time')::bigint DESC,event_key DESC LIMIT 20`,
      [identity, at, s?.venue_at ?? 0],
    )
  ).map(({ payload: f }) => ({
    key: f.key,
    occurred_at: new Date(f.time).toISOString(),
    amount_usd6: f.amount_raw,
  }));
  const bindings = await rows<{
    experiment_id: string;
    profile_id: string;
    profile_version: string;
    start_at: Date;
    end_at: Date | null;
  }>(
    `
    WITH periods AS (SELECT b.experiment_id,b.profile_id,b.profile_version,(b.binding->>'started_at')::timestamptz start_at,
      LEAST(c.closed_at,LEAD((b.binding->>'started_at')::timestamptz) OVER(ORDER BY (b.binding->>'started_at')::timestamptz,b.experiment_id)) end_at
      FROM jev_bindings b LEFT JOIN jev_evidence_closures c USING(experiment_id) WHERE b.owner_id=$1 AND b.account_id=$2 AND (b.binding->>'started_at')::timestamptz<=$3)
    SELECT * FROM periods WHERE ($4::timestamptz IS NULL OR (start_at,experiment_id)<($4::timestamptz,$5::text)) ORDER BY start_at DESC,experiment_id DESC LIMIT 21`,
    [
      owner,
      account,
      at,
      cursor?.started_at ?? null,
      cursor?.experiment_id ?? null,
    ],
  );
  const history: JevPanelLiveState["history"] = [];
  for (const b of bindings.slice(0, 20)) {
    const start = Math.max(
        b.start_at.getTime(),
        source?.opening_at?.getTime() ?? Infinity,
      ),
      end = Math.min(
        b.end_at ? b.end_at.getTime() - 1 : Infinity,
        s?.venue_at ?? 0,
      );
    const flows = identity
      ? await readJevLiveFlowsTx(
          tx,
          identity,
          Number.isFinite(start) ? start : null,
          end,
          at,
        )
      : { realized: "0", fees: "0", funding: "0" };
    const cost = await readJevLiveCostTx(tx, owner, account, at, {
      id: b.profile_id,
      version: b.profile_version,
      start: b.start_at.toISOString(),
      end: b.end_at?.toISOString() ?? at,
    });
    history.push({
      ...b,
      start_at: b.start_at.toISOString(),
      end_at: b.end_at?.toISOString() ?? null,
      realized_usd6: ready ? flows.realized : null,
      fees_usd6: ready ? flows.fees : null,
      funding_usd6: ready ? flows.funding : null,
      attributed_jev_usd6: cost,
      realized_after_jev_usd6:
        ready && cost !== null
          ? (
              BigInt(flows.realized) -
              BigInt(flows.fees) +
              BigInt(flows.funding) -
              BigInt(cost)
            ).toString()
          : null,
    });
  }
  const last = bindings[19];
  const live_state: JevPanelLiveState = {
    version: "jev.live-account-panel.v1",
    source_as_of: metrics.source_as_of ?? null,
    position_btc_raw: ready ? s!.position_raw : null,
    orders: (s?.orders ?? []).slice(0, 20).map((o) => ({
      order_id: String(o.oid),
      side: o.side,
      quantity_btc_raw: o.quantity_raw,
      limit_price_usd6: o.limit_price_raw,
      reduce_only: o.reduce_only,
      position_stop: o.position_stop,
    })),
    orders_truncated: (s?.orders.length ?? 0) > 20,
    receipts,
    protection: {
      state: !ready
        ? "unavailable"
        : q === 0n
          ? "flat"
          : confirmed
            ? "confirmed"
            : "pending",
      observed_at: p ? new Date(p.observed_at).toISOString() : null,
      quantity_btc_raw:
        ready && q === 0n ? null : (p?.protection?.quantity_btc_raw ?? null),
      stop_price_usd6:
        ready && q === 0n ? null : (p?.protection?.stop_price_raw ?? null),
      maximum_exit_at:
        ready && q === 0n ? null : (p?.protection?.maximum_exit_at ?? null),
    },
    funding,
    runtime: runtime
      ? {
          observed_at: runtime.observed_at.toISOString(),
          current: runtime.current,
          connected: runtime.state.connected,
          entries_ready: runtime.current && runtime.state.entries_ready,
          reasons: runtime.state.reasons,
        }
      : null,
    history,
    history_next_cursor:
      bindings.length > 20 && last
        ? Buffer.from(
            JSON.stringify({
              started_at: last.start_at.toISOString(),
              experiment_id: last.experiment_id,
            }),
          ).toString("base64url")
        : null,
  };
  const risk: JevPanelAccount["risk"] = source?.pilot
    ? {
        ...source.pilot.risk,
        equity_usd_raw: ready ? metrics.risk_equity_usd6 : null,
        observed_at: source.pilot.observation.observed_at,
        reasons: [
          ...source.pilot.risk.reasons,
          ...(!ready ? (metrics.reasons ?? []) : []),
        ],
      }
    : null;
  return { metrics, live_state, fills, risk };
}
