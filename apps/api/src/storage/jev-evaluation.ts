import {
  requireJev,
  type JevLedgerEvent,
  type JevScope,
} from "@ganso-market/contracts/trading";
import { jevTime } from "./jev-context.js";
import { jevHash } from "./jev-hash.js";
import { replayJevLedger, type JevLedgerIdentity } from "./jev-ledger.js";
import type { CaptureEvidence } from "../trading/bars.js";

export const JEV_EVALUATION_POLICY = Object.freeze({
  version: "jev.evaluation.v1",
  coverage_version: "jev.duration-coverage.v1",
  coverage_ppm: 990000,
  minimum_episodes: 60,
  day_ms: 86400000,
  rolling_days: 90,
  preview_days: 30,
  margin_usd6: "12500000",
  capital_usd6: "250000000",
  book_fresh_ms: 2000,
  context_fresh_ms: 5000,
  endpoint_policy:
    "original_event_time_reconciled_knowledge_no_interpolation_or_reset",
});
export type Interval = [number, number];
export function mergeIntervals(
  ranges: readonly Interval[],
  start: number,
  end: number,
): Interval[] {
  const sorted = ranges
    .map(([a, b]): Interval => [Math.max(a, start), Math.min(b, end)])
    .filter(([a, b]) => a < b)
    .sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const r of sorted) {
    const p = out.at(-1);
    if (p && r[0] <= p[1]) p[1] = Math.max(p[1], r[1]);
    else out.push([...r]);
  }
  return out;
}
export function intervalDuration(ranges: readonly Interval[]) {
  return ranges.reduce((n, [a, b]) => n + b - a, 0);
}
export interface CoverageCapture {
  object_id: string;
  recorded_at: string;
  received_at: string;
  payload: Omit<CaptureEvidence, "health"> & {
    health: {
      socket: { alive?: boolean; connected: boolean };
      channels: Partial<
        Record<
          "book" | "context" | "trades",
          {
            status: string;
            needs_revalidation?: boolean;
            last_source_at?: number | null;
            last_received_at?: number | null;
            source_quality?: string;
          }
        >
      >;
      gaps: CaptureEvidence["health"]["gaps"];
    };
  };
}
/** Elapsed calendar milliseconds are the denominator, including downtime. A
 * received capture never supplies coverage before its original source clocks. */
export function jevDurationCoverage(
  window: { start_at: string; end_at: string },
  records: readonly CoverageCapture[],
) {
  const start = jevTime(window.start_at),
    end = jevTime(window.end_at);
  requireJev(start < end && records.length <= 512, "COVERAGE_WINDOW");
  const ranges: Interval[] = [],
    gaps: Interval[] = [],
    sources: string[] = [];
  const channelRanges: Record<"book" | "context", Interval[]> = {
    book: [],
    context: [],
  };
  const seen = new Map<string, string>();
  for (const r of records) {
    const old = seen.get(r.object_id),
      hash = jevHash(r);
    requireJev(!old || old === hash, "COVERAGE_SOURCE_COLLISION");
    if (old) continue;
    seen.set(r.object_id, hash);
    const c = r.payload;
    requireJev(
      Number.isSafeInteger(c.from) &&
        Number.isSafeInteger(c.at) &&
        c.from <= c.at,
      "COVERAGE_CAPTURE",
    );
    if (
      jevTime(r.recorded_at) > end ||
      jevTime(r.received_at) > end ||
      c.at > end
    )
      continue;
    sources.push(r.object_id);
    for (const g of c.health.gaps) {
      const a = g.after_source_at ?? g.detected_at,
        b = g.resumed_at ?? end;
      if (a < b) gaps.push([a, b]);
    }
    if (
      c.restarted ||
      c.history_truncated ||
      c.at - c.from > 2000 ||
      !c.health.socket.alive
    )
      continue;
    const a = Math.max(start, c.from),
      b = Math.min(end, c.at);
    if (
      !["book", "context", "trades"].every((k) => {
        const h = c.health.channels[k as "book" | "context" | "trades"];
        return h?.status === "healthy" && h.needs_revalidation === false;
      })
    )
      continue;
    if (a < b) ranges.push([a, b]);
    for (const k of ["book", "context"] as const) {
      const h = c.health.channels[k]!;
      const source = h.last_source_at,
        received = h.last_received_at;
      if (
        source == null ||
        received == null ||
        !Number.isSafeInteger(source) ||
        !Number.isSafeInteger(received) ||
        h.source_quality !== "fresh" ||
        source > c.at ||
        received > c.at
      )
        continue;
      const limit = k === "book" ? 2000 : 5000;
      // Freshness of an earlier observed source carries into the next proven
      // healthy capture interval, until its original clocks expire. A newly
      // received source cannot retroactively cover the beginning of its slot.
      channelRanges[k].push([
        Math.max(source, received),
        Math.min(source + limit, received + limit),
      ]);
    }
  }
  let valid = mergeIntervals(ranges, start, end);
  for (const k of ["book", "context"] as const) {
    const fresh = mergeIntervals(channelRanges[k], start, end);
    valid = mergeIntervals(
      valid.flatMap(([a, b]) =>
        fresh.map(([x, y]): Interval => [Math.max(a, x), Math.min(b, y)]),
      ),
      start,
      end,
    );
  }
  for (const [a, b] of mergeIntervals(gaps, start, end))
    valid = valid.flatMap(([x, y]): Interval[] =>
      y <= a || x >= b
        ? [[x, y]]
        : [
            ...(x < a ? [[x, a] as Interval] : []),
            ...(y > b ? [[b, y] as Interval] : []),
          ],
    );
  const covered = intervalDuration(valid),
    duration = end - start;
  const missing: Interval[] = [];
  let cursor = start;
  for (const [a, b] of valid) {
    if (cursor < a) missing.push([cursor, a]);
    cursor = b;
  }
  if (cursor < end) missing.push([cursor, end]);
  return {
    schema_version: JEV_EVALUATION_POLICY.coverage_version,
    window,
    denominator_ms: duration,
    covered_ms: covered,
    coverage_ppm: Math.floor((covered * 1000000) / duration),
    valid_intervals: valid,
    gaps: missing,
    sources: sources.sort(),
    basis:
      "original_event_and_receive_time_all_required_channels_elapsed_duration",
  };
}
/** Replay full history before filtering completed episodes. Partial exits and
 * a UTC/window boundary cannot create a closure or split an open position. */
export function jevEpisodes(
  identity: JevLedgerIdentity,
  events: readonly JevLedgerEvent[],
  scope: JevScope,
  window: { start_at: string; end_at: string },
  knowledge_at: string = window.end_at,
) {
  requireJev(
    jevTime(knowledge_at) >= jevTime(window.end_at),
    "EPISODE_KNOWLEDGE",
  );
  replayJevLedger(identity, events);
  const start = jevTime(window.start_at),
    end = jevTime(window.end_at);
  requireJev(start < end, "EPISODE_WINDOW");
  const open = new Map<
    string,
    {
      quantity: bigint;
      opened_at: string;
      opening_sequence: string;
      scope_hash: string;
      last_at: string;
    }
  >();
  const closed: {
    position_id: string;
    opening_sequence: string;
    closed_sequence: string;
    opened_at: string;
    closed_at: string;
    received_at: string;
  }[] = [];
  for (const e of [...events].sort((a, b) =>
    Number(BigInt(a.sequence) - BigInt(b.sequence)),
  )) {
    if (e.occurred_at > window.end_at || e.recorded_at > knowledge_at) continue;
    const p = e.payload;
    if (p.event_type !== "fill") continue;
    const s = {
      schema_version: e.schema_version,
      owner_id: e.owner_id,
      account_id: e.account_id,
      mode: e.mode,
      profile_id: e.profile_id,
      profile_version: e.profile_version,
      experiment_id: e.experiment_id,
      instrument_id: e.instrument_id,
      instrument_version: e.instrument_version,
    };
    const old = open.get(p.position_id),
      delta = BigInt(p.quantity.raw) * (p.side === "buy" ? 1n : -1n),
      before = old?.quantity ?? 0n,
      after = before + delta;
    requireJev(
      !old || (old.scope_hash === jevHash(s) && old.last_at <= e.occurred_at),
      "EPISODE_IDENTITY_OR_CLOCK",
    );
    requireJev(
      before === 0n || after === 0n || before > 0n === after > 0n,
      "EPISODE_REVERSAL",
    );
    if (before === 0n)
      open.set(p.position_id, {
        quantity: after,
        opened_at: e.occurred_at,
        opening_sequence: e.sequence,
        scope_hash: jevHash(s),
        last_at: e.occurred_at,
      });
    else if (after === 0n) {
      open.delete(p.position_id);
      if (
        jevHash(s) === jevHash(scope) &&
        e.occurred_at > window.start_at &&
        e.occurred_at <= window.end_at
      )
        closed.push({
          position_id: p.position_id,
          opening_sequence: old!.opening_sequence,
          closed_sequence: e.sequence,
          opened_at: old!.opened_at,
          closed_at: e.occurred_at,
          received_at: e.recorded_at,
        });
    } else
      open.set(p.position_id, {
        ...old!,
        quantity: after,
        last_at: e.occurred_at,
      });
  }
  return {
    schema_version: "jev.episodes.v1",
    window,
    closed_count: closed.length,
    episodes: closed,
    open_count: [...open.values()].filter(
      (p) => p.scope_hash === jevHash(scope),
    ).length,
  };
}
export interface EvaluationAccount {
  scope: JevScope;
  manifest_hash: string;
  started_at: string;
  episodes: number;
  denominator_ms: number;
  covered_ms: number;
  costs_complete: boolean;
  reconciled: boolean;
  irrecoverable_financial_gap: boolean;
  proven_risk_failure: boolean;
  conservative_usd6: string | null;
  benchmark_usd6: string | null;
}
export type EvaluationState =
  "validating" | "eligible" | "inconclusive" | "failed";
export function evaluateJevProfile(input: {
  as_of: string;
  window: { start_at: string; end_at: string };
  phase: "initial" | "preview30" | "rolling90";
  accounts: readonly EvaluationAccount[];
  engine_qualified: boolean;
  previous_failed: boolean;
}) {
  const { accounts, window, phase } = input;
  const start = jevTime(window.start_at),
    end = jevTime(window.end_at);
  requireJev(
    end === jevTime(input.as_of) && start < end && accounts.length === 2,
    "EVALUATION_CUT",
  );
  requireJev(
    new Set(accounts.map((a) => a.scope.mode)).size === 2 &&
      accounts.some((a) => a.scope.mode === "paper") &&
      accounts.some((a) => a.scope.mode === "stress"),
    "EVALUATION_PAIR",
  );
  const p = accounts[0]!;
  requireJev(
    accounts.every(
      (a) =>
        a.scope.owner_id === p.scope.owner_id &&
        a.scope.profile_id === p.scope.profile_id &&
        a.scope.profile_version === p.scope.profile_version &&
        a.manifest_hash === p.manifest_hash &&
        a.started_at === p.started_at &&
        jevTime(a.started_at) <= start,
    ),
    "EVALUATION_VERSION",
  );
  const age = end - jevTime(p.started_at),
    full = phase === "rolling90",
    mature = full
      ? age >= 90 * 86400000 && end - start === 90 * 86400000
      : phase === "preview30"
        ? age >= 30 * 86400000
        : true;
  const details = accounts.map((a) => {
    requireJev(
      Number.isSafeInteger(a.episodes) &&
        a.episodes >= 0 &&
        Number.isSafeInteger(a.denominator_ms) &&
        a.denominator_ms === end - start &&
        Number.isSafeInteger(a.covered_ms) &&
        a.covered_ms >= 0 &&
        a.covered_ms <= a.denominator_ms,
      "EVALUATION_COVERAGE",
    );
    const reasons: string[] = [];
    if (a.episodes < 60) reasons.push("insufficient_episodes");
    if (BigInt(a.covered_ms) * 100n < BigInt(a.denominator_ms) * 99n)
      reasons.push("coverage_below_99_percent");
    if (!a.costs_complete) reasons.push("costs_incomplete");
    if (!a.reconciled) reasons.push("reconciliation_incomplete");
    if (a.irrecoverable_financial_gap)
      reasons.push("irrecoverable_financial_gap");
    if (a.conservative_usd6 === null)
      reasons.push("economic_result_unavailable");
    if (full && a.benchmark_usd6 === null)
      reasons.push("benchmark_unavailable");
    const best =
      a.benchmark_usd6 === null
        ? null
        : BigInt(a.benchmark_usd6) > 0n
          ? BigInt(a.benchmark_usd6)
          : 0n;
    const passed =
      !reasons.length &&
      a.conservative_usd6 !== null &&
      (full
        ? BigInt(a.conservative_usd6) >= best! + 12500000n
        : BigInt(a.conservative_usd6) > 0n);
    return {
      account_id: a.scope.account_id,
      mode: a.scope.mode,
      episodes: a.episodes,
      coverage_ppm: Math.floor((a.covered_ms * 1000000) / a.denominator_ms),
      reasons,
      criterion_passed: passed,
      best_benchmark_usd6: best?.toString() ?? null,
      conservative_usd6: a.conservative_usd6,
      proven_risk_failure: a.proven_risk_failure,
    };
  });
  const proven =
    input.previous_failed ||
    accounts.some((a) => a.proven_risk_failure) ||
    (mature &&
      phase !== "preview30" &&
      details.some((a) => !a.reasons.length && !a.criterion_passed));
  const state: EvaluationState = proven
    ? "failed"
    : phase === "preview30" || !mature
      ? "validating"
      : !input.engine_qualified
        ? "validating"
        : details.some((a) => a.reasons.length)
          ? "inconclusive"
          : "eligible";
  return {
    schema_version: JEV_EVALUATION_POLICY.version,
    policy: JEV_EVALUATION_POLICY,
    owner_id: p.scope.owner_id,
    profile_id: p.scope.profile_id,
    profile_version: p.scope.profile_version,
    manifest_hash: p.manifest_hash,
    as_of: input.as_of,
    window,
    phase,
    state,
    accounts: details,
    engine_qualified: input.engine_qualified,
    previous_failed: input.previous_failed,
    operational_admission: false,
    retrospective_tuning_allowed: false,
    healthy_profile_replacement_allowed: false,
  };
}
export type JevEvaluation = ReturnType<typeof evaluateJevProfile>;
/** One closed UTC cut per day. A restart skips unavailable days; it cannot
 * synthesize their evidence or reset a 90-day trajectory. */
export function jevEvaluationWindow(started_at: string, now_at: string) {
  const started = jevTime(started_at),
    end = Math.floor(jevTime(now_at) / 86400000) * 86400000,
    age = end - started;
  if (age <= 0) return null;
  const phase = age >= 90 * 86400000 ? "rolling90" : "initial";
  return {
    phase,
    window: {
      start_at: new Date(
        phase === "rolling90" ? end - 90 * 86400000 : started,
      ).toISOString(),
      end_at: new Date(end).toISOString(),
    },
  } as const;
}
