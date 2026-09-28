import { ledgerScope, replayLedger } from "../trading/ledger.js";
import { projectFinancials } from "../trading/valuation.js";
import { canonicalFingerprint } from "../trading/replay.js";
import { drawdown, utc } from "../trading/metrics.js";
import {
  replayDataset,
  replayHash,
  requireReplay,
  REPLAY_PAGED_LIMITS,
  REPLAY_PAGED_VERSION,
  type ReplayDataset,
} from "./replay-dataset.js";

export const PAGE_LIMITS = Object.freeze({
  rows: 256,
  bytes: 1024 * 1024,
  pages: 2048,
});
const streams = [
  "ledger",
  "reservations",
  "decisions",
  "jev",
  "roots",
  "evidence",
  "retained_refs",
  "observations",
] as const;
type Stream = (typeof streams)[number];
type Header = Omit<
  ReplayDataset,
  | "ledger"
  | "reservations"
  | "decisions"
  | "jev"
  | "roots"
  | "evidence"
  | "retained_refs"
  | "equity_history"
>;
export interface ReplayPage {
  snapshot_id: string;
  index: number;
  stream: Stream;
  offset: number;
  rows: unknown[];
}
export interface ReplayManifest {
  dataset_id: string;
  manifest: {
    schema_version: "btc.replay-manifest.v1";
    snapshot_id: string;
    header: Header;
    counts: Record<Stream, number>;
    pages: {
      id: string;
      stream: Stream;
      offset: number;
      rows: number;
      bytes: number;
    }[];
    bytes: number;
  };
}
export const pageId = (p: ReplayPage) => `btc-replay-page:${replayHash(p)}`;
export function sealReplayPages(d: ReplayDataset) {
  requireReplay(
    d.schema_version === REPLAY_PAGED_VERSION && d.window,
    "PAGED_VERSION",
  );
  const {
    ledger,
    reservations,
    decisions,
    jev,
    roots,
    evidence,
    retained_refs = [],
    equity_history,
    ...header
  } = d;
  const snapshot_id = replayHash(header);
  const data = {
    ledger,
    reservations,
    decisions,
    jev,
    roots,
    evidence,
    retained_refs,
    observations: equity_history!.observation_ids,
  };
  const pages: ReplayPage[] = [];
  for (const stream of streams) {
    let offset = 0;
    while (offset < data[stream].length) {
      const page: ReplayPage = {
        snapshot_id,
        index: pages.length,
        stream,
        offset,
        rows: [],
      };
      let bytes = 512;
      while (
        offset + page.rows.length < data[stream].length &&
        page.rows.length < PAGE_LIMITS.rows
      ) {
        const row = data[stream][offset + page.rows.length]!;
        const size = Buffer.byteLength(canonicalFingerprint(row)) + 1;
        requireReplay(size + 512 <= PAGE_LIMITS.bytes, "PAGE_ROW_BYTES");
        if (bytes + size > PAGE_LIMITS.bytes) break;
        page.rows.push(row);
        bytes += size;
      }
      offset += page.rows.length;
      pages.push(page);
      requireReplay(pages.length <= PAGE_LIMITS.pages, "PAGE_COUNT");
    }
  }
  const descriptors = pages.map((p) => ({
    id: pageId(p),
    stream: p.stream,
    offset: p.offset,
    rows: p.rows.length,
    bytes: Buffer.byteLength(canonicalFingerprint(p)),
  }));
  const manifest: ReplayManifest["manifest"] = {
    schema_version: "btc.replay-manifest.v1",
    snapshot_id,
    header,
    counts: Object.fromEntries(
      streams.map((k) => [k, data[k].length]),
    ) as Record<Stream, number>,
    pages: descriptors,
    bytes: descriptors.reduce((n, p) => n + p.bytes, 0),
  };
  requireReplay(
    manifest.bytes <= REPLAY_PAGED_LIMITS.bytes &&
      Buffer.byteLength(canonicalFingerprint(manifest)) <= PAGE_LIMITS.bytes,
    "PAGED_BYTE_LIMIT",
  );
  return {
    artifact: {
      dataset_id: `btc-replay-window:${replayHash(manifest)}`,
      manifest,
    },
    pages,
  };
}
export function validateManifest(a: ReplayManifest) {
  const m = a.manifest;
  requireReplay(
    a.dataset_id === `btc-replay-window:${replayHash(m)}` &&
      m.schema_version === "btc.replay-manifest.v1" &&
      m.header.schema_version === REPLAY_PAGED_VERSION &&
      m.snapshot_id === replayHash(m.header) &&
      m.pages.length <= PAGE_LIMITS.pages &&
      m.bytes <= REPLAY_PAGED_LIMITS.bytes &&
      Buffer.byteLength(canonicalFingerprint(m)) <= PAGE_LIMITS.bytes,
    "MANIFEST",
  );
  const w = m.header.window;
  requireReplay(
    w &&
      utc(w.start_at) >= utc(m.header.identity.experiment.started_at) &&
      utc(w.end_at) > utc(w.start_at) &&
      utc(w.end_at) <= utc(m.header.cut.captured_at) &&
      utc(w.end_at) - utc(w.start_at) <= 30 * 86400000 &&
      utc(w.start_at) % 900000 === 0 &&
      utc(w.end_at) % 900000 === 0,
    "WINDOW",
  );
  const counts = Object.fromEntries(streams.map((s) => [s, 0])) as Record<
    Stream,
    number
  >;
  let lastStream = 0,
    bytes = 0;
  const ids = new Set<string>();
  for (const p of m.pages) {
    const stream = streams.indexOf(p.stream);
    requireReplay(
      stream >= lastStream &&
        p.offset === counts[p.stream] &&
        Number.isSafeInteger(p.rows) &&
        p.rows > 0 &&
        p.rows <= PAGE_LIMITS.rows &&
        Number.isSafeInteger(p.bytes) &&
        p.bytes > 0 &&
        p.bytes <= PAGE_LIMITS.bytes &&
        !ids.has(p.id),
      "PAGE_MANIFEST",
    );
    lastStream = stream;
    counts[p.stream] += p.rows;
    bytes += p.bytes;
    ids.add(p.id);
  }
  requireReplay(
    bytes === m.bytes &&
      replayHash(counts) === replayHash(m.counts) &&
      streams.every(
        (s) =>
          counts[s] <=
          (s === "decisions" || s === "jev"
            ? REPLAY_PAGED_LIMITS.decisions
            : REPLAY_PAGED_LIMITS.rows),
      ),
    "PAGE_TOTALS",
  );
}
/** Only a complete, ordered set yields a report. Repeated/missing/mixed pages fail.
 * The caller reads one bounded page at a time. Assembly is capped at 64 MiB. */
export async function replayPages(
  a: ReplayManifest,
  input: AsyncIterable<ReplayPage>,
) {
  validateManifest(a);
  const data = Object.fromEntries(
    streams.map((s) => [s, [] as unknown[]]),
  ) as Record<Stream, unknown[]>;
  let index = 0;
  for await (const p of input) {
    const ref = a.manifest.pages[index];
    requireReplay(
      ref &&
        p.index === index &&
        p.snapshot_id === a.manifest.snapshot_id &&
        p.stream === ref.stream &&
        p.offset === ref.offset &&
        p.rows.length === ref.rows &&
        Buffer.byteLength(canonicalFingerprint(p)) === ref.bytes &&
        pageId(p) === ref.id,
      "PAGE_SEQUENCE_OR_HASH",
    );
    data[p.stream].push(...p.rows);
    index++;
  }
  requireReplay(index === a.manifest.pages.length, "PAGE_MISSING");
  const { observations, ...arrays } = data;
  const d = {
    ...a.manifest.header,
    ...arrays,
    equity_history: {
      schema_version: "btc.replay-equity.v1",
      observation_ids: observations,
    },
  } as ReplayDataset;
  const result = replayDataset({
    dataset_id: `btc-replay:${replayHash(d)}`,
    dataset: d,
  });
  const w = d.window!;
  const points = result.equity_history!.points.filter(
    (p) => p.at >= w.start_at && p.at <= w.end_at,
  );
  const expected = (utc(w.end_at) - utc(w.start_at)) / 300000 + 1;
  const complete =
    points.length === expected &&
    points[0]?.at === w.start_at &&
    points.at(-1)?.at === w.end_at &&
    points.every((p) => p.adjusted_equity_usd_raw !== null);
  const dd = drawdown(
    points.flatMap((p) =>
      p.adjusted_equity_usd_raw === null ? [] : [p.adjusted_equity_usd_raw],
    ),
  );
  const boundary = (at: string) => {
    const events = d.ledger.filter((e) => e.recorded_at <= at);
    const last = events.at(-1),
      next = d.ledger[events.length];
    requireReplay(
      !last || !next || last.transaction_id !== next.transaction_id,
      "WINDOW_ATOMIC_PREFIX",
    );
    const held = new Map(
      d.reservations
        .filter((r) => r.recorded_at <= at)
        .map((r) => [r.reservation.order.order_id, r.reservation]),
    );
    return {
      financials: events.length
        ? projectFinancials(replayLedger(d.identity, events), events)
        : null,
      active_reserved_usd_raw: [...held.values()]
        .filter((r) => r.status === "active")
        .reduce(
          (sum, r) => sum + BigInt(r.margin_usd_raw) + BigInt(r.fee_usd_raw),
          0n,
        )
        .toString(),
      equity_usd_raw: points.find((p) => p.at === at)?.equity_usd_raw ?? null,
    };
  };
  const opening = boundary(w.start_at),
    closing = boundary(w.end_at);
  const incidences = d.ledger.filter(
    (e) => e.recorded_at > w.start_at && e.recorded_at <= w.end_at,
  );
  const flows = incidences.reduce(
    (n, e) =>
      n + (e.payload.event_type === "cash" ? BigInt(e.payload.delta.raw) : 0n),
    0n,
  );

  return {
    ...result,
    dataset_id: a.dataset_id,
    window: {
      ...w,
      scope: ledgerScope(d.identity),
      opening,
      closing,
      external_flows_usd_raw: flows.toString(),
      net_pnl_usd_raw:
        opening.equity_usd_raw === null || closing.equity_usd_raw === null
          ? null
          : (
              BigInt(closing.equity_usd_raw) -
              BigInt(opening.equity_usd_raw) -
              flows
            ).toString(),
      ledger_incidence_event_ids: incidences.map((e) => e.event_id),
      prior_obligation_event_ids: incidences
        .filter((e) => e.occurred_at <= w.start_at)
        .map((e) => e.event_id),
      late_funding_event_ids: incidences
        .filter(
          (e) =>
            e.payload.event_type === "funding" && e.occurred_at < e.recorded_at,
        )
        .map((e) => e.event_id),
      expected_fifteen_minute_windows:
        (utc(w.end_at) - utc(w.start_at)) / 900000,
      observed_equity_slots: points.length,
      expected_equity_slots: expected,
      complete,
      drawdown: {
        ...(complete ? dd : drawdown([null])),
        observed_max_usd_raw: dd.max_usd_raw,
        observed_max_ppm: dd.max_ppm,
        intrabar_extreme: null,
      },
      independent_observations: null,
      points,
      limitations: [
        "financials_cover_genesis_to_snapshot_not_only_window",
        "window_count_is_not_independent_sample_size",
        "missing_marks_are_unknown",
        "reference_dependencies_remain_in_pinned_source",
      ],
    },
  };
}
