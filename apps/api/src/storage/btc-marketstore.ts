import { createHash } from "node:crypto";
import type {
  TradingInstrumentMetadata,
  TradingMarketData,
} from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { canonicalFingerprint } from "../trading/replay.js";
import {
  assertEvidenceJson,
  type StorageIdentity,
} from "../trading/retention.js";
import { FEED_LIMITS } from "../trading/feed.js";
import {
  BAR_BUILD_VERSION,
  BAR_LIMITS,
  barStart,
  buildClosedBar,
  barWarmup,
  tradeGapRange,
  type BarInterval,
  type ClosedBar,
  type CaptureEvidence,
  type MarketHealth,
} from "../trading/bars.js";
import {
  withBtcRetentionTransaction,
  storeRetentionObjectTx,
  pinRetentionObjectTx,
} from "./btc-retention.js";

type Store = Pick<DatabasePool, "transaction">;
const instrument = "hyperliquid:mainnet:BTC";
const source = "hyperliquid:mainnet:ws";
const intervals: BarInterval[] = [900_000, 3_600_000];
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalFingerprint(value)).digest("hex");
const objectId = (kind: string, key: unknown) =>
  `btc-market:${kind}:${digest(key)}`;
function timestamp(value: string) {
  const time = Date.parse(value);
  if (
    !Number.isSafeInteger(time) ||
    time < 0 ||
    new Date(time).toISOString() !== value
  )
    throw new Error("BTC_MARKET_INVALID_TIME");
  return time;
}
function identity(version: string): StorageIdentity {
  return {
    mode: "paper",
    instrument_id: instrument,
    instrument_version: version,
  };
}
async function record(
  tx: SqlExecutor,
  id: string,
  kind: string,
  sourceAt: string | null,
  receivedAt: string,
) {
  await tx.query(
    `INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [id, kind, sourceAt, receivedAt],
  );
}
async function evidence(tx: SqlExecutor, id: string) {
  return (
    await tx.query(
      "SELECT payload, identity, recorded_at FROM btc_retention_objects WHERE object_id=$1",
      [id],
    )
  ).rows[0];
}
/** Preserve the first closed OHLC. A late input/gap publishes an immutable quality
 * revision and switches the indexed projection. Earlier pinned/as-of versions survive. */
async function invalidate(
  tx: SqlExecutor,
  rows: { object_id: string; payload: ClosedBar }[],
  reason: string,
  inputId: string,
  at: string,
) {
  for (const row of rows) {
    if (row.payload.quality.state === "incomplete") continue;
    const id = objectId("bar-revision", [row.object_id, reason, inputId]);
    const payload: ClosedBar = {
      ...row.payload,
      quality: {
        state: "incomplete",
        reasons: [reason],
        continuity: "unproven",
      },
      input_ids: [row.object_id, inputId].sort(),
    };
    await storeRetentionObjectTx(tx, {
      id,
      class: "bar",
      identity: identity(payload.instrument_version),
      recordedAt: new Date(at),
      payload,
      dependencies: payload.input_ids,
    });
    await tx.query(
      "UPDATE btc_market_bars SET object_id=$1 WHERE object_id=$2",
      [id, row.object_id],
    );
  }
}
function validateEvent(
  event: TradingMarketData,
  version: string,
  capturedAt: number,
) {
  assertEvidenceJson(event);
  if (
    Buffer.byteLength(JSON.stringify(event)) > 262_144 ||
    event.schema_version !== "trading.market-data.v1" ||
    event.instrument_id !== instrument ||
    event.instrument_version !== version ||
    event.source_id !== source ||
    event.parser_version !== "hyperliquid.feed.v1" ||
    !event.key ||
    event.key.length > 256 ||
    digest(event.payload) !== event.payload_hash ||
    !["fresh", "stale", "unknown"].includes(event.quality) ||
    event.continuity !== "unproven" ||
    !Number.isSafeInteger(event.gap_epoch) ||
    event.gap_epoch < 0 ||
    !["none", "current_state_only", "delivery_resumed_only"].includes(
      event.revalidation,
    )
  )
    throw new Error("BTC_MARKET_INVALID_EVENT");
  const expectedKind = {
    book: "book",
    trades: "trade",
    context: "mark_funding",
  }[event.channel];
  if (
    !expectedKind ||
    event.payload.kind !== expectedKind ||
    timestamp(event.received_at) > capturedAt ||
    (event.source_timestamp === null) !== (event.channel === "context")
  )
    throw new Error("BTC_MARKET_INVALID_EVENT");
  if (
    event.source_timestamp !== null &&
    timestamp(event.source_timestamp) >
      capturedAt + FEED_LIMITS.futureToleranceMs
  )
    throw new Error("BTC_MARKET_INVALID_EVENT");
}
export interface BtcMarketBatch {
  sessionId: string;
  capturedAt: string;
  metadata: TradingInstrumentMetadata;
  events: readonly TradingMarketData[];
  /** Capture after drain, including when the drain is empty. Never omit gaps. */
  health: MarketHealth;
}
/** Inert by default, and not wired into a worker in G2-04.3. The G2-04.4 caller
 * must stop admission/mark a gap on ANY rejection; never drain-and-drop on quota.
 * Batch, evidence, projection, cursor and retention charge use ONE connection. */
export async function captureBtcMarketBatch(
  pool: Store,
  batch: BtcMarketBatch,
  enabled = false,
) {
  if (!enabled)
    return { status: "disabled" as const, stored: 0, duplicates: 0 };
  assertEvidenceJson(batch);
  const at = timestamp(batch.capturedAt),
    version = batch.metadata.instrument.instrument_version;
  if (
    !batch.sessionId ||
    batch.sessionId.length > 128 ||
    batch.events.length > FEED_LIMITS.queue ||
    Buffer.byteLength(JSON.stringify(batch)) > 2_097_152 ||
    batch.metadata.instrument.instrument_id !== instrument ||
    !version ||
    batch.health.gaps.length > FEED_LIMITS.gaps ||
    !Number.isSafeInteger(batch.health.counters.gaps)
  )
    throw new Error("BTC_MARKET_INVALID_BATCH");
  for (const event of batch.events) validateEvent(event, version, at);
  for (const gap of batch.health.gaps) {
    if (
      !Number.isSafeInteger(gap.detected_at) ||
      gap.detected_at > at ||
      (gap.resumed_at !== null &&
        (!Number.isSafeInteger(gap.resumed_at) || gap.resumed_at > at)) ||
      (gap.after_source_at !== null &&
        !Number.isSafeInteger(gap.after_source_at))
    )
      throw new Error("BTC_MARKET_INVALID_GAP");
  }
  const metadataId = objectId("metadata", batch.metadata);
  const captureId = objectId("capture", [batch.sessionId, batch.capturedAt]);
  const inputHash = digest(batch);
  return withBtcRetentionTransaction(pool, async (tx) => {
    const priorCapture = await evidence(tx, captureId);
    if (priorCapture) {
      if (priorCapture.payload.input_hash !== inputHash)
        throw new Error("BTC_MARKET_CAPTURE_CONFLICT");
      return {
        status: "duplicate" as const,
        stored: 0,
        duplicates: batch.events.length,
      };
    }
    const head = (
      await tx.query("SELECT * FROM btc_market_head WHERE singleton")
    ).rows[0];
    if (head && new Date(head.last_capture_at).getTime() >= at)
      throw new Error("BTC_MARKET_CAPTURE_ORDER");
    const from = head ? new Date(head.last_capture_at).getTime() : at;
    await storeRetentionObjectTx(tx, {
      id: metadataId,
      class: "raw",
      identity: identity(version),
      recordedAt: new Date(batch.metadata.instrument.origin.received_at),
      payload: batch.metadata,
      dependencies: [],
    });
    await record(
      tx,
      metadataId,
      "metadata",
      null,
      batch.metadata.instrument.origin.received_at,
    );
    const previous = head
      ? await evidence(
          tx,
          objectId("capture", [
            head.session_id,
            new Date(head.last_capture_at).toISOString(),
          ]),
        )
      : undefined;
    const previousGaps =
      head?.session_id === batch.sessionId
        ? (previous?.payload.health.counters.gaps ?? 0)
        : 0;
    const unseenGaps = batch.health.gaps.filter(
      (gap) => gap.epoch > previousGaps,
    ).length;
    const capture: CaptureEvidence & { input_hash: string } = {
      id: captureId,
      from,
      at,
      session: batch.sessionId,
      health: batch.health,
      input_hash: inputHash,
      restarted: !head || head.session_id !== batch.sessionId,
      history_truncated: batch.health.counters.gaps - previousGaps > unseenGaps,
    };
    await storeRetentionObjectTx(tx, {
      id: captureId,
      class: "log",
      identity: identity(version),
      recordedAt: new Date(at),
      payload: capture,
      dependencies: [metadataId],
    });
    await record(
      tx,
      captureId,
      "capture",
      new Date(from).toISOString(),
      batch.capturedAt,
    );
    let stored = 0,
      duplicates = 0;
    for (const event of batch.events) {
      // Same venue trade replayed after a process/metadata restart remains one input.
      const id = objectId("event", [event.source_id, event.channel, event.key]);
      const prior = await evidence(tx, id);
      if (prior) {
        if (
          prior.payload.payload_hash !== event.payload_hash ||
          prior.payload.source_timestamp !== event.source_timestamp ||
          prior.payload.parser_version !== event.parser_version
        )
          throw new Error("BTC_MARKET_EVENT_CONFLICT");
        duplicates++;
        continue;
      }
      await storeRetentionObjectTx(tx, {
        id,
        class: "raw",
        identity: identity(version),
        recordedAt: new Date(event.received_at),
        payload: event,
        dependencies: [metadataId],
      });
      await record(
        tx,
        id,
        event.channel,
        event.source_timestamp,
        event.received_at,
      );
      stored++;
      if (event.channel === "trades") {
        const rows = (
          await tx.query<{ object_id: string; payload: ClosedBar }>(
            `SELECT b.object_id,o.payload FROM btc_market_bars b JOIN btc_retention_objects o USING(object_id)
          WHERE (b.interval_ms=900000 AND b.start_at=$1) OR (b.interval_ms=3600000 AND b.start_at=$2)`,
            intervals.map(
              (interval) =>
                new Date(
                  barStart(timestamp(event.source_timestamp!), interval),
                ),
            ),
          )
        ).rows;
        await invalidate(tx, rows, "late_input", id, batch.capturedAt);
      }
    }
    // Revisions also cover gaps learned only after a bar was published. Truncated
    // gap history/restart/silent capture intervals conservatively invalidate coverage.
    const ranges = batch.health.gaps
      .filter((gap) => gap.channel === "trades")
      .map((gap) => tradeGapRange(gap, at));
    if (
      capture.history_truncated ||
      !head ||
      head.session_id !== batch.sessionId ||
      at - from > BAR_LIMITS.captureSilenceMs
    )
      ranges.push({ from, to: at });
    for (const range of ranges) {
      const rows = (
        await tx.query<{ object_id: string; payload: ClosedBar }>(
          `SELECT b.object_id,o.payload FROM btc_market_bars b JOIN btc_retention_objects o USING(object_id)
        WHERE b.start_at < $1 AND b.end_at > $2 AND o.payload->'quality'->>'state'='observed_no_known_gap' ORDER BY b.start_at LIMIT 9`,
          [new Date(range.to), new Date(range.from)],
        )
      ).rows;
      if (rows.length > BAR_LIMITS.closeBatch)
        throw new Error("BTC_MARKET_REPAIR_LIMIT");
      await invalidate(tx, rows, "late_gap", captureId, batch.capturedAt);
    }
    await tx.query(
      `INSERT INTO btc_market_head(singleton,session_id,metadata_id,last_capture_at,next_15m,next_1h) VALUES(true,$1,$2,$3,$4,$5)
      ON CONFLICT(singleton) DO UPDATE SET session_id=excluded.session_id, metadata_id=excluded.metadata_id,last_capture_at=excluded.last_capture_at`,
      [
        batch.sessionId,
        metadataId,
        batch.capturedAt,
        ...intervals.map((interval) => new Date(barStart(at, interval))),
      ],
    );
    return { status: "stored" as const, stored, duplicates };
  });
}
/** Raw is scanned only once per closed UTC interval, under the bounded builder,
 * never for a UI refresh. A failed close leaves the cursor unchanged. */
export async function closeBtcMarketBars(
  pool: Store,
  asOf: string,
  enabled = false,
) {
  if (!enabled) return { status: "disabled" as const, closed: 0 };
  const now = timestamp(asOf);
  return withBtcRetentionTransaction(pool, async (tx) => {
    const head = (
      await tx.query("SELECT * FROM btc_market_head WHERE singleton")
    ).rows[0];
    if (!head) return { status: "empty" as const, closed: 0 };
    const metadata = await evidence(tx, head.metadata_id);
    if (!metadata) throw new Error("BTC_MARKET_METADATA_EXPIRED");
    const version = metadata.identity.instrument_version;
    const watermark = Math.min(now, new Date(head.last_capture_at).getTime());
    let closed = 0;
    for (const interval of intervals) {
      const column = interval === 900_000 ? "next_15m" : "next_1h";
      let start = new Date(head[column]).getTime();
      // Four per interval prevents a long outage from monopolizing a transaction.
      for (
        let count = 0;
        count < BAR_LIMITS.closeBatch / 2 &&
        start + interval + BAR_LIMITS.latenessMs <= watermark;
        count++, start += interval
      ) {
        const end = start + interval;
        const trades = (
          await tx.query<{ object_id: string; payload: TradingMarketData }>(
            `SELECT r.object_id,o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id)
          WHERE r.kind='trades' AND r.source_at >= $1 AND r.source_at < $2 AND r.received_at <= $4 ORDER BY r.source_at,r.object_id LIMIT $3`,
            [new Date(start), new Date(end), BAR_LIMITS.trades + 1, asOf],
          )
        ).rows;
        const captures = (
          await tx.query<{ payload: CaptureEvidence }>(
            `SELECT o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id)
          WHERE r.kind='capture' AND r.received_at >= $1 AND r.source_at <= $2 AND r.received_at <= $4 ORDER BY r.received_at,r.object_id LIMIT $3`,
            [
              new Date(start),
              new Date(end + BAR_LIMITS.latenessMs),
              BAR_LIMITS.captures + 1,
              asOf,
            ],
          )
        ).rows;
        const payload = buildClosedBar({
          start,
          interval,
          asOf: now,
          instrumentVersion: version,
          metadataId: head.metadata_id,
          trades: trades.map((row) => ({
            id: row.object_id,
            event: row.payload,
          })),
          captures: captures.map((row) => row.payload),
        });
        const id = objectId("bar", [BAR_BUILD_VERSION, interval, start]);
        await storeRetentionObjectTx(tx, {
          id,
          class: "bar",
          identity: identity(version),
          recordedAt: new Date(end),
          payload,
          dependencies: payload.input_ids,
        });
        await tx.query(
          "INSERT INTO btc_market_bars(interval_ms,start_at,end_at,object_id) VALUES($1,$2,$3,$4)",
          [interval, new Date(start), new Date(end), id],
        );
        closed++;
      }
      await tx.query(
        `UPDATE btc_market_head SET ${column}=$1 WHERE singleton`,
        [new Date(start)],
      );
    }
    return { status: "closed" as const, closed };
  });
}
/** Permanent pins are only for inputs actually referenced by a decision/replay.
 * Ordinary bars use retention dependency edges until expiry; pinning every bar
 * forever would defeat the bounded raw policy. Pin returned revision IDs, not times. */
export async function pinBtcMarketInputs(
  pool: Store,
  referenceId: string,
  objectIds: readonly string[],
  reason: string,
) {
  if (
    !referenceId ||
    referenceId.length > 128 ||
    !objectIds.length ||
    objectIds.length > BAR_LIMITS.readBars ||
    objectIds.some((id) => !id.startsWith("btc-market:"))
  )
    throw new Error("BTC_MARKET_INVALID_PIN");
  return withBtcRetentionTransaction(pool, async (tx) => {
    for (const id of new Set(objectIds))
      await pinRetentionObjectTx(
        tx,
        objectId("pin", [referenceId, id]),
        id,
        reason,
      );
  });
}
export async function readBtcMarketView(
  pool: Pick<DatabasePool, "readOnly">,
  options: {
    interval: BarInterval;
    limit: number;
    requiredBars: number;
    asOf: string;
  },
) {
  const at = timestamp(options.asOf);
  barStart(at, options.interval);
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > BAR_LIMITS.readBars
  )
    throw new Error("BTC_MARKET_READ_LIMIT");
  return pool.readOnly(1500, async (tx) => {
    const rows = (
      await tx.query<{ object_id: string; payload: ClosedBar }>(
        `SELECT b.object_id,o.payload FROM btc_market_bars b JOIN btc_retention_objects o USING(object_id)
      WHERE b.interval_ms=$1 AND b.end_at <= $2 AND o.recorded_at <= $2 ORDER BY b.start_at DESC LIMIT $3`,
        [options.interval, options.asOf, options.limit],
      )
    ).rows;
    const metadata =
      (
        await tx.query(
          `SELECT r.object_id,o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id)
      WHERE r.kind='metadata' AND r.received_at <= $1 ORDER BY r.received_at DESC,r.object_id LIMIT 1`,
          [options.asOf],
        )
      ).rows[0] ?? null;
    const latest = [];
    for (const channel of ["book", "trades", "context"]) {
      const row = (
        await tx.query<{ object_id: string; payload: TradingMarketData }>(
          `SELECT r.object_id,o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id)
        WHERE r.kind=$1 AND r.received_at <= $2 ORDER BY ${channel === "context" ? "r.received_at DESC" : "r.source_at DESC"},r.object_id LIMIT 1`,
          [channel, options.asOf],
        )
      ).rows[0];
      if (row)
        latest.push({
          ...row,
          payload: {
            ...row.payload,
            quality:
              row.payload.source_timestamp === null
                ? ("unknown" as const)
                : at - Date.parse(row.payload.source_timestamp) >
                    FEED_LIMITS.sourceAgeMs
                  ? ("stale" as const)
                  : row.payload.quality,
          },
        });
    }
    const warmup = barWarmup(
      rows.map((row) => row.payload),
      options.requiredBars,
      at,
      options.interval,
    );
    if (
      !metadata ||
      rows[0]?.payload.instrument_version !==
        metadata.payload.instrument.instrument_version
    ) {
      warmup.ready = false;
      warmup.reason = "metadata_changed_or_missing";
    }
    return {
      metadata,
      bars: rows,
      latest,
      warmup,
      build_version: BAR_BUILD_VERSION,
    };
  });
}
