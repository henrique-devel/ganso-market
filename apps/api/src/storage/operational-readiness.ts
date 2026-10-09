import type { SqlExecutor } from "../database.js";
import { contextSnapshotTime } from "../trading/valuation.js";

export function freshness(
  at: string | Date | null,
  now: number,
  limit: number,
) {
  const age = at === null ? null : now - new Date(at).getTime();
  return age === null || !Number.isFinite(age)
    ? "unavailable"
    : age < 0
      ? "future"
      : age > limit
        ? "stale"
        : "recent";
}
export type ConsumerObservation = {
  enabled: boolean | null;
  consumer_ready: boolean | null;
  consumer_at: Date | null;
  consumer_reason: string | null;
  status: string | null;
  lease_until: Date | null;
};
export function consumerReadiness(row: ConsumerObservation, now: number) {
  const reasons: string[] = [];
  if (row.enabled !== true) reasons.push("consumer_not_enabled");
  const age = freshness(row.consumer_at, now, 4999);
  if (age !== "recent") reasons.push(`consumer_${age}`);
  if (row.consumer_ready !== true) reasons.push("consumer_not_ready");
  if (row.status !== "ready") reasons.push("reconciliation_not_ready");
  if (!row.lease_until || !(new Date(row.lease_until).getTime() > now))
    reasons.push("lease_expired_or_absent");
  return { status: reasons.length ? "not_ready" : "ready", reasons };
}

/** Bounded indexed projections only. No locks, payload exports, writes or reconciliation.
 * History reuses retained capture timestamps already charged by G2-12, including missing intervals.
 * It measures data coverage, not unobserved process uptime or economic readiness. */
export async function readSourceReadinessTx(tx: SqlExecutor, now: Date) {
  const rows = (
    await tx.query<{
      kind: "book" | "context";
      source_at: Date | null;
      received_at: Date | null;
      source_id: string | null;
      parser: string | null;
      snapshot: unknown;
      quality: string | null;
      gap_epoch: number | null;
    }>(`SELECT k.kind,r.source_at,r.received_at,o.payload->>'source_id' AS source_id,
    o.payload->>'parser_version' AS parser,o.payload->'payload'->'snapshot' AS snapshot,
    o.payload->>'quality' AS quality,(o.payload->>'gap_epoch')::int AS gap_epoch
    FROM (VALUES ('book'),('context')) k(kind) LEFT JOIN LATERAL
    (SELECT object_id,source_at,received_at FROM btc_market_records WHERE kind=k.kind
     ORDER BY received_at DESC,object_id LIMIT 1) r ON true
    LEFT JOIN btc_retention_objects o USING(object_id)`)
  ).rows;
  const capture = (
    await tx.query<{
      at: Date;
      restarted: boolean;
      history_truncated: boolean;
      socket: { alive?: boolean; connected?: boolean } | null;
      channels: Record<
        string,
        { status?: string; needs_revalidation?: boolean; gap_epoch?: number }
      > | null;
    }>(`SELECT r.received_at AS at,(o.payload->>'restarted')::boolean AS restarted,
    (o.payload->>'history_truncated')::boolean AS history_truncated,
    o.payload->'health'->'socket' AS socket,o.payload->'health'->'channels' AS channels
    FROM btc_market_records r JOIN btc_retention_objects o USING(object_id)
    WHERE r.kind='capture' ORDER BY r.received_at DESC,r.object_id LIMIT 1`)
  ).rows[0];
  const channels = rows.map((row) => {
    const limit = row.kind === "book" ? 2000 : 5000;
    const snapshotAt =
      row.kind === "context" &&
      row.source_id === "hyperliquid:mainnet:info" &&
      row.parser === "hyperliquid.context-snapshot.v1" &&
      row.received_at
        ? contextSnapshotTime(
            row.snapshot,
            new Date(row.received_at).toISOString(),
          )
        : null;
    const at = snapshotAt ?? row.source_at;
    const reasons: string[] = [];
    for (const [name, timestamp] of [
      ["source", at],
      ["received", row.received_at],
      ["capture", capture?.at ?? null],
    ] as const) {
      const state = freshness(timestamp, now.getTime(), limit);
      if (state !== "recent") reasons.push(`${name}_${state}`);
    }
    const h = capture?.channels?.[row.kind];
    if (
      !capture?.socket?.alive ||
      !capture.socket.connected ||
      h?.status !== "healthy" ||
      h.needs_revalidation !== false ||
      h.gap_epoch !== row.gap_epoch
    )
      reasons.push("feed_gap_or_unavailable");
    if (
      capture &&
      row.received_at &&
      new Date(capture.at).getTime() < new Date(row.received_at).getTime()
    )
      reasons.push("capture_precedes_event");
    if (!snapshotAt && row.quality !== "fresh")
      reasons.push("source_quality_unproven");
    return {
      channel: row.kind,
      status: reasons.length ? "not_ready" : "fresh",
      reasons,
      freshness_at: at,
      received_at: row.received_at,
      limit_ms: limit,
      timestamp_basis: snapshotAt
        ? "http_response_date"
        : row.source_at
          ? "venue_event"
          : "unknown",
    };
  });
  return { channels, capture };
}
export async function readOperationalReadiness(tx: SqlExecutor, now: Date) {
  const { channels, capture } = await readSourceReadinessTx(tx, now);
  const end = new Date(Math.floor(now.getTime() / 900000) * 900000);
  const start = new Date(end.getTime() - 7 * 86400000);
  // Two index seeks per quarter-hour; never scan all captures or TOAST payloads.
  // This measures interval edges. Gaps wholly inside a quarter-hour remain unmeasured.
  const windows = (
    await tx.query<{
      slot: number;
      first_at: Date | null;
      last_at: Date | null;
    }>(
      `
    SELECT slot,f.received_at AS first_at,l.received_at AS last_at
    FROM generate_series(0,671) slot
    LEFT JOIN LATERAL (SELECT received_at FROM btc_market_records
      WHERE kind='capture' AND received_at >= $1::timestamptz+slot*interval '15 minutes'
        AND received_at < $1::timestamptz+(slot+1)*interval '15 minutes'
      ORDER BY received_at,object_id LIMIT 1) f ON true
    LEFT JOIN LATERAL (SELECT received_at FROM btc_market_records
      WHERE kind='capture' AND received_at >= $1::timestamptz+slot*interval '15 minutes'
        AND received_at < $1::timestamptz+(slot+1)*interval '15 minutes'
      ORDER BY received_at DESC,object_id LIMIT 1) l ON true
    ORDER BY slot`,
      [start],
    )
  ).rows;
  const bySlot = new Map(windows.map((w) => [w.slot, w]));
  const intervals = Array.from({ length: 672 }, (_, i) => {
    const at = start.getTime() + i * 900000,
      window = bySlot.get(i);
    const missing = !window?.first_at || !window.last_at;
    const incomplete =
      !missing &&
      (new Date(window.first_at!).getTime() - at > 60000 ||
        at + 900000 - new Date(window.last_at!).getTime() > 60000);
    return {
      start_at: new Date(at).toISOString(),
      status: missing
        ? "unavailable"
        : incomplete
          ? "incomplete"
          : "observed_edges",
    };
  });
  const cpu = process.cpuUsage();
  return {
    schema_version: "btc.operational-readiness.v1",
    status:
      channels.length === 2 && channels.every((c) => c.status === "fresh")
        ? "sources_recent"
        : "not_ready",
    channels,
    collector: {
      status: "unavailable",
      observed_at: capture?.at ?? null,
      capture_status: freshness(capture?.at ?? null, now.getTime(), 60000),
      restarted_at_last_capture: capture?.restarted ?? null,
      history_truncated_at_last_capture: capture?.history_truncated ?? null,
    },
    resources: {
      scope: "api_process_only",
      observed_at: now.toISOString(),
      rss_bytes: process.memoryUsage().rss,
      cpu_user_us: cpu.user,
      cpu_system_us: cpu.system,
      uptime_seconds: process.uptime(),
      host_cpu: null,
      host_ram: null,
      host_disk: null,
      container_restarts: null,
    },
    history: {
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      interval_ms: 900000,
      scope:
        "retained_capture_cadence_not_channel_continuity_or_process_uptime",
      sampling: "interval_edges_15m_internal_gaps_unmeasured",
      edge_tolerance_ms: 60000,
      retention: "existing_G2_12_charged_evidence_no_new_copy",
      observed: intervals.filter((i) => i.status === "observed_edges").length,
      incomplete: intervals.filter((i) => i.status === "incomplete").length,
      unavailable: intervals.filter((i) => i.status === "unavailable").length,
      intervals,
    },
  };
}
