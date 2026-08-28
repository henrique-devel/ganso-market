// RFC-007 task 11: retention job (TTL + quota; quota beats TTL; daily prune).
// Protected tables are never pruned. Before pruning book_deltas the 1-minute
// aggregates must already cover the pruned interval — otherwise skip and log,
// never silently. Every prune action is audited in polymarket_retention_log.
// A persistence failure never crashes the process: log and continue.

import type { SqlExecutor } from "../database.js";

export type RetentionQueryPool = { query: SqlExecutor["query"] };

const GB = 1024 ** 3;

// Owner decision (2026-08-25): raised from 40 GB after production measurement
// showed the recorded L2 stream is far denser than the RFC-007 estimate
// (~15.3 GB/day of book deltas over 198 tokens, not the assumed ~1 GB/day).
// The alternative was pruning the delta history down to ~0.6 day, which would
// have gutted the microstructure record the RFC-011/013 gates read. The host
// has 301 GB total with 192 GB free, so 110 GB stays well inside the disk.
// Amendment recorded in docs/rfcs/RFC-007-polymarket-data-foundation.md.
export const DEFAULT_BUDGET_BYTES = 110 * GB;
export const DEFAULT_BATCH_SIZE = 50_000;
/**
 * Smaller batches for coverage-gated tables (in practice: book_deltas).
 *
 * The cost of a DELETE there is dominated by index maintenance, not by finding
 * the rows: polymarket_book_deltas carries three indexes and one of them is
 * 39 GB. Measured in production on 2026-08-26, a 50 000-row batch on a heavy
 * token could exceed the recorder's 30 s statement_timeout under live write
 * load. Smaller batches finish, and the loop simply runs more of them.
 */
export const COVERAGE_BATCH_SIZE = 5_000;
export const QUOTA_TRIGGER_RATIO = 0.9;
export const QUOTA_TARGET_RATIO = 0.8;
/**
 * Effective-TTL reduction applied to every TTL table while the global budget
 * alarms. One flat step, not a search: it is applied once per run against the
 * DECLARED ttlDays, so the window settles at 75% of declared and does not
 * compound across runs.
 *
 * Known limitation, measured in production 2026-08-27: this lever is inert on
 * the table that holds the bytes. polymarket_book_deltas was 95 GB live over a
 * 7d22h window — 80% of the whole live footprint, and 43 GB above its own 52 GB
 * quota — yet 7d22h is still under both its 14-day TTL and the 10.5 days this
 * factor would leave it, so the reduction deleted nothing there. A reduction
 * only frees bytes where the TTL binds before the quota, which is the smaller
 * audit tables; the alarm therefore takes its bytes from everywhere except the
 * overshoot. Under real pressure the lever has to be the quota, not the TTL —
 * and the quota has to actually be enforced. Both open (docs/HANDOFF.md).
 */
export const GLOBAL_ALARM_TTL_FACTOR = 0.75;
const MAX_QUOTA_ITERATIONS = 4;
/**
 * Above this live-row count the exact OFFSET cutoff probe stops being viable
 * (measured: 42.7 s at 100 M rows, against a 30 s statement_timeout) and the
 * pruner interpolates the cutoff from the time range instead.
 */
const INTERPOLATION_MIN_ROWS = 5_000_000;
/** Hard clamp on the interpolated fraction: never "everything below newest". */
const MAX_INTERPOLATED_FRACTION = 0.9;
/**
 * How much of a column the histogram may leave out (NULLs plus most-common
 * values) before its bucket fractions stop describing the table and the cutoff
 * falls back to the linear span.
 */
const HISTOGRAM_MAX_EXCLUDED_FRAC = 0.05;
/**
 * Widest window a single coverage query may span for one token.
 *
 * The per-token check is an index-only scan, but its cost still grows with the
 * range: measured in production at 14.3 s for the heaviest token over a 2-day
 * cutoff, and past the 30 s statement_timeout once the quota prune pushed the
 * cutoff to ~3.5 days. Slicing keeps every individual query small and lets the
 * prune advance token by token, slice by slice, instead of losing the whole
 * token to one timeout.
 */
const COVERAGE_SLICE_MS = 12 * 60 * 60 * 1_000;
/** Bound on slices per token per run, so one token cannot monopolise a run. */
const MAX_COVERAGE_SLICES = 32;
const MAX_DELETE_BATCHES = 10_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface RetentionTableConfig {
  readonly table: string;
  readonly ttlDays: number | null;
  readonly quotaBytes: number;
  readonly timeColumn: string;
  readonly protected: boolean;
  /** book_deltas only: require series_1m coverage before deleting. */
  readonly requiresSeriesCoverage?: boolean;
  /** Lifecycle rows are eligible only after their ended_at is populated. */
  readonly closedRowsOnly?: boolean;
}

// RFC-007 retention table, top-to-bottom in alarm-reduction order. Tables with
// ttlDays null but a quota may still be pruned oldest-first when the quota
// trips (quota beats TTL). Protected tables are never touched.
export const RETENTION_TABLES: readonly RetentionTableConfig[] = [
  // 52 GB, not the original 12 GB: the measured stream is ~15.3 GB/day, so
  // 12 GB retained under 20 hours of book depth — less than the 14-day TTL by
  // two orders of magnitude, and not enough for any book-walk replay. At 52 GB
  // the quota (not the TTL) still binds, at ~3.4 days. The 8 GB between this
  // and the 60 GB of the 2026-08-25 amendment funds the RFC-010..013 reserve
  // expansion below (6 -> 8 GB), keeping the declared total at 89 GB against
  // the 110 GB budget.
  {
    table: "polymarket_book_deltas",
    ttlDays: 14,
    quotaBytes: 52 * GB,
    timeColumn: "received_at",
    protected: false,
    requiresSeriesCoverage: true,
  },
  {
    table: "polymarket_book_snapshots_full",
    ttlDays: 30,
    quotaBytes: 4 * GB,
    timeColumn: "received_at",
    protected: false,
  },
  // 8 GB: measured 8.2 GB in 5 days of top-10 snapshots (~1.6 GB/day), so the
  // 90-day TTL was never reachable at 4 GB either.
  {
    table: "polymarket_book_snapshots",
    ttlDays: 90,
    quotaBytes: 8 * GB,
    timeColumn: "received_at",
    protected: false,
  },
  {
    table: "polymarket_trades",
    ttlDays: 365,
    quotaBytes: 3 * GB,
    timeColumn: "received_at",
    protected: false,
  },
  // 10 GB: the 1-minute aggregates are the only long-horizon microstructure
  // record (~100 MB/day measured), and the RFC-013 G2 gate needs >= 60 days of
  // continuous paper evidence. At 3 GB the window capped at ~30 days, which
  // would have made that gate unmeasurable — an RFC-013 stop condition.
  {
    table: "polymarket_series_1m",
    ttlDays: null,
    quotaBytes: 10 * GB,
    timeColumn: "bucket_start",
    protected: false,
  },
  {
    table: "polymarket_oi_holders",
    ttlDays: null,
    quotaBytes: 1 * GB,
    timeColumn: "received_at",
    protected: false,
  },
  {
    table: "polymarket_rtds_prices",
    ttlDays: 90,
    quotaBytes: 2 * GB,
    timeColumn: "received_at",
    protected: false,
  },
  {
    table: "polymarket_rtds_1m",
    ttlDays: null,
    quotaBytes: 0.5 * GB,
    timeColumn: "bucket_start",
    protected: false,
  },
  // RFC-010 estimates: 90-day TTL on the raw rows, inside the 6 GB reserve the
  // RFC-007 budget set aside for the RFC-010..013 tables. RFC-012 decision
  // (owner, 2026-08-24): 3.0 -> 2.0 GB — at the measured ~23 MB/day the window
  // stays ~87 days, above the evidence-chain floor — freeing 1.0 GB for the
  // resolution-risk and graph tables below.
  {
    table: "fundamental_estimates",
    ttlDays: 90,
    quotaBytes: 2 * GB,
    timeColumn: "received_at",
    protected: false,
  },
  // RFC-011 feature windows: 30-day TTL inside the sub-quota the owner
  // approved on 2026-08-23 (0.6 GB of the 6 GB RFC-010..013 reserve). Quota
  // beats TTL, as everywhere: under pressure the window shrinks, the budget
  // holds.
  {
    table: "paper_feature_windows",
    ttlDays: 30,
    quotaBytes: 0.6 * GB,
    timeColumn: "window_start",
    protected: false,
  },
  // RFC-011 ledger + orders: no TTL, bounded by the approved 0.3 GB slice of
  // the reserve (the ledger is the gates' track record; quota beats TTL and
  // any prune is logged). Positions and the kill switch are current state:
  // never pruned, monitored only.
  {
    table: "paper_ledger_events",
    ttlDays: null,
    quotaBytes: 0.25 * GB,
    timeColumn: "received_at",
    protected: false,
  },
  // 0.035 GB, not 0.05: orders + positions + kill switch share the approved
  // 0.3 GB ledger slice with the events table, and the reserve sum is a
  // tested invariant.
  {
    table: "paper_orders",
    ttlDays: null,
    quotaBytes: 0.035 * GB,
    timeColumn: "created_at",
    protected: false,
  },
  {
    table: "paper_positions",
    ttlDays: null,
    quotaBytes: 0.01 * GB,
    timeColumn: "updated_at",
    protected: true,
  },
  // RFC-011 markouts and P(fill) calibration: the RFC-009 validation
  // datasets, 180-day TTL inside the approved 0.4 GB slice of the reserve.
  {
    table: "paper_markouts",
    ttlDays: 180,
    quotaBytes: 0.25 * GB,
    timeColumn: "fill_ts",
    protected: false,
  },
  {
    table: "paper_fill_samples",
    ttlDays: 180,
    quotaBytes: 0.1 * GB,
    timeColumn: "sampled_at",
    protected: false,
  },
  {
    table: "paper_fill_reports",
    ttlDays: null,
    quotaBytes: 0.05 * GB,
    timeColumn: "generated_at",
    protected: true,
  },
  {
    table: "paper_kill_switch",
    ttlDays: null,
    quotaBytes: 0.005 * GB,
    timeColumn: "updated_at",
    protected: true,
  },
  // RFC-012 resolution-risk and graph tables: the 1.0 GB freed above, split as
  // the owner approved on 2026-08-24 — scores 0.4 / graph+violations 0.3 /
  // dispute timeline 0.2 / reports 0.1. Score versions, current state, the
  // dispute timelines, curated edges and reports are audit/reproducibility
  // material: never pruned, size monitored. Series tables carry TTLs and
  // quota beats TTL, as everywhere in the module.
  {
    table: "resolution_scores",
    ttlDays: 180,
    quotaBytes: 0.35 * GB,
    timeColumn: "received_at",
    protected: false,
  },
  {
    table: "resolution_score_versions",
    ttlDays: null,
    quotaBytes: 0.02 * GB,
    timeColumn: "created_at",
    protected: true,
  },
  {
    table: "resolution_market_state",
    ttlDays: null,
    quotaBytes: 0.01 * GB,
    timeColumn: "updated_at",
    protected: true,
  },
  {
    table: "resolution_clarifications",
    ttlDays: null,
    quotaBytes: 0.02 * GB,
    timeColumn: "received_at",
    protected: true,
  },
  {
    table: "resolution_uma_timeline",
    ttlDays: null,
    quotaBytes: 0.05 * GB,
    timeColumn: "received_at",
    protected: true,
  },
  {
    table: "resolution_onchain_events",
    ttlDays: null,
    quotaBytes: 0.09 * GB,
    timeColumn: "received_at",
    protected: true,
  },
  {
    table: "resolution_onchain_cursor",
    ttlDays: null,
    quotaBytes: 0.01 * GB,
    timeColumn: "updated_at",
    protected: true,
  },
  {
    table: "resolution_adjudication_samples",
    ttlDays: 90,
    quotaBytes: 0.05 * GB,
    timeColumn: "received_at",
    protected: false,
  },
  {
    table: "graph_edges",
    ttlDays: null,
    quotaBytes: 0.05 * GB,
    timeColumn: "created_at",
    protected: true,
  },
  {
    table: "graph_violations",
    ttlDays: 180,
    quotaBytes: 0.15 * GB,
    timeColumn: "received_at",
    protected: false,
  },
  {
    table: "graph_sanity_vetoes",
    ttlDays: 180,
    quotaBytes: 0.05 * GB,
    timeColumn: "ended_at",
    protected: false,
    closedRowsOnly: true,
  },
  {
    table: "resolution_layer_divergences",
    ttlDays: 180,
    quotaBytes: 0.05 * GB,
    timeColumn: "received_at",
    protected: false,
  },
  {
    table: "resolution_reports",
    ttlDays: null,
    quotaBytes: 0.1 * GB,
    timeColumn: "generated_at",
    protected: true,
  },
  // RFC-013 portfolio engine: 2.0 GB, the expansion of the RFC-010..013 reserve
  // from 6 to 8 GB (funded by trimming polymarket_book_deltas from 60 to
  // 52 GB). The original 6 GB was already fully allocated by RFC-010 (3.7),
  // RFC-011 (1.3) and RFC-012 (1.0), so RFC-013 had literally zero room in it.
  // Split: decisions 0.9 / panel 0.54 / gates+reports 0.35 / state,
  // configuration and audit trails 0.21. The bridge's entry-provenance table
  // (0.02 GB) was funded by trimming the panel snapshots from 0.56, so the
  // RFC-013 slice stays at exactly 2.0 GB and the reserve at 8. The panel is the
  // right place to take it from: it is a live view whose newest row per token is
  // all anything reads, and its own quota already binds long before its TTL.
  //
  // The decision log is the audit trail of every entry, exit, veto and resize,
  // and it carries its own book excerpt so replay survives the raw-delta
  // window. It is the largest slice for that reason.
  {
    table: "portfolio_decisions",
    ttlDays: 180,
    quotaBytes: 0.9 * GB,
    timeColumn: "received_at",
    protected: false,
  },
  // The declared 30-day TTL is aspirational, not what happens: at the same one
  // row per market per cycle as the decision log, and a panel_json that carries
  // the same ten book levels per side plus the rule excerpt, this quota binds in
  // days. Nothing reads it deep (the API takes the newest row per token), so it
  // is a mislabel and not a hazard — measure the row in production and redeclare
  // the TTL rather than inventing quota.
  {
    table: "portfolio_panel_snapshots",
    ttlDays: 30,
    quotaBytes: 0.54 * GB,
    timeColumn: "received_at",
    protected: false,
  },
  // Gate measurements and reports are the evidence behind any future RFC-009
  // decision: never pruned, size monitored.
  {
    table: "portfolio_gate_measurements",
    ttlDays: null,
    quotaBytes: 0.25 * GB,
    timeColumn: "received_at",
    protected: true,
  },
  {
    table: "portfolio_gate_reports",
    ttlDays: null,
    quotaBytes: 0.1 * GB,
    timeColumn: "received_at",
    protected: true,
  },
  // Current state, versioned configuration and the transition/clock audit
  // trails. All small, all current-state or append-only audit: never pruned.
  {
    table: "portfolio_exposures",
    ttlDays: null,
    quotaBytes: 0.02 * GB,
    timeColumn: "computed_at",
    protected: true,
  },
  {
    table: "portfolio_state",
    ttlDays: null,
    quotaBytes: 0.005 * GB,
    timeColumn: "updated_at",
    protected: true,
  },
  {
    table: "portfolio_state_events",
    ttlDays: null,
    quotaBytes: 0.05 * GB,
    timeColumn: "at",
    protected: true,
  },
  {
    table: "portfolio_config_versions",
    ttlDays: null,
    quotaBytes: 0.02 * GB,
    timeColumn: "created_at",
    protected: true,
  },
  {
    table: "portfolio_factor_map_versions",
    ttlDays: null,
    quotaBytes: 0.02 * GB,
    timeColumn: "created_at",
    protected: true,
  },
  {
    table: "portfolio_g2_clock",
    ttlDays: null,
    quotaBytes: 0.005 * GB,
    timeColumn: "updated_at",
    protected: true,
  },
  {
    table: "portfolio_g2_clock_events",
    ttlDays: null,
    quotaBytes: 0.02 * GB,
    timeColumn: "at",
    protected: true,
  },
  // What each entry committed to believing (RFC-013 bridge). NEVER pruned, and
  // that is the whole point: the exit cycle compares a held position against
  // this row, and the decision log it was copied from is pruned by quota in
  // about three days. Pruning this table would put back the degeneration it was
  // created to remove — four of the seven exit criteria silently unable to fire
  // on any position older than the log. One row per position, not per cycle, so
  // 0.02 GB is generous.
  {
    table: "portfolio_position_entries",
    ttlDays: null,
    quotaBytes: 0.02 * GB,
    timeColumn: "created_at",
    protected: true,
  },
  // Breakers are a series with a TTL; the open ones are current state and the
  // prune only reaches rows whose window already closed.
  {
    table: "portfolio_circuit_breakers",
    ttlDays: 180,
    quotaBytes: 0.05 * GB,
    timeColumn: "ended_at",
    protected: false,
    closedRowsOnly: true,
  },
  // RFC-010 metadata: model registry, labels, gate reports, lifecycle events
  // and calibration reports are the audit trail of every promotion decision.
  // They are never pruned; their size is monitored against the global budget.
  {
    table: "fundamental_models",
    ttlDays: null,
    quotaBytes: 0.1 * GB,
    timeColumn: "created_at",
    protected: true,
  },
  {
    table: "fundamental_labels",
    ttlDays: null,
    quotaBytes: 0.5 * GB,
    timeColumn: "received_at",
    protected: true,
  },
  {
    table: "fundamental_gate_reports",
    ttlDays: null,
    quotaBytes: 0.5 * GB,
    timeColumn: "evaluated_at",
    protected: true,
  },
  {
    table: "fundamental_model_events",
    ttlDays: null,
    quotaBytes: 0.1 * GB,
    timeColumn: "at",
    protected: true,
  },
  {
    table: "fundamental_calibration_reports",
    ttlDays: null,
    quotaBytes: 0.5 * GB,
    timeColumn: "generated_at",
    protected: true,
  },
  // Metadata group: never pruned (shared 0.5 GB quota is monitored only).
  ...[
    "polymarket_markets",
    "polymarket_events",
    "polymarket_event_markets",
    "polymarket_rule_versions",
    "polymarket_param_versions",
    "polymarket_market_metadata_versions",
    "polymarket_resolution_input_changes",
    "polymarket_resolution_events",
    "polymarket_data_gaps",
    "polymarket_universe_log",
    "polymarket_macro_calendar",
    "polymarket_macro_releases",
    "polymarket_retention_log",
  ].map((table): RetentionTableConfig => ({
    table,
    ttlDays: null,
    quotaBytes: 0.5 * GB,
    timeColumn: "received_at",
    protected: true,
  })),
];

export interface RetentionAction {
  readonly table: string;
  readonly cause: "ttl" | "quota";
  readonly prunedBefore: Date;
  readonly rowsDeleted: number;
}

export interface RetentionSkip {
  readonly table: string;
  readonly reason: string;
  readonly tokenId?: string;
}

export interface RetentionRunReport {
  readonly actions: RetentionAction[];
  readonly skipped: RetentionSkip[];
  readonly globalAlarm: boolean;
  /** Physical bytes across the retention tables; never shrinks on DELETE. */
  readonly totalBytes: number;
  /** Retained bytes across the retention tables: what a prune can move. */
  readonly totalLiveBytes: number;
}

export interface RetentionJobDeps {
  readonly pool: RetentionQueryPool;
  readonly clock: () => Date;
  readonly budgetBytes?: number;
  readonly tables?: readonly RetentionTableConfig[];
  readonly batchSize?: number;
  readonly maxQuotaIterations?: number;
}

export interface RetentionJob {
  runOnce(): Promise<RetentionRunReport>;
}

function log(
  level: "info" | "warn" | "error",
  reasonCode: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: "polymarket-recorder",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      message,
      ...extra,
    })}\n`,
  );
}

interface TableSize {
  /** Physical bytes on disk (pg_total_relation_size): never shrinks on DELETE. */
  readonly bytes: number;
  /** Live bytes: physical discounted by the dead-tuple fraction. */
  readonly liveBytes: number;
  readonly reltuples: number;
  /** Best available live row count (pg_stat, falling back to reltuples). */
  readonly liveRows: number;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function createRetentionJob(deps: RetentionJobDeps): RetentionJob {
  const pool = deps.pool;
  const budgetBytes = deps.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  const tables = deps.tables ?? RETENTION_TABLES;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxQuotaIterations = deps.maxQuotaIterations ?? MAX_QUOTA_ITERATIONS;

  // Two different sizes, because they answer two different questions.
  //
  // `bytes` is physical (pg_total_relation_size) and answers "how much disk is
  // this costing right now" — the global budget alarm. It does NOT shrink on
  // DELETE: dead tuples keep their pages until VACUUM returns them to the free
  // space map, and even then the file does not give space back to the OS.
  //
  // `liveBytes` discounts that bloat by the dead-tuple fraction and answers
  // "how much data is actually retained" — the per-table quota. Using the
  // physical size for the quota is a data-destroying bug: a table pruned from
  // 76 GB to 48 GB of live rows still measures 76 GB, so the next run would
  // delete another 28 GB of LIVE rows, and the run after that another 28 GB,
  // until the table was empty. n_live_tup/n_dead_tup come from the stats
  // collector and move immediately on DELETE, unlike pg_class.reltuples which
  // only refreshes on VACUUM/ANALYZE.
  async function tableSize(table: string): Promise<TableSize | null> {
    const result = await pool.query<{
      bytes: string | number | null;
      reltuples: string | number | null;
      live_tup: string | number | null;
      dead_tup: string | number | null;
    }>(
      `SELECT pg_total_relation_size(c.oid)::bigint AS bytes,
              c.reltuples::float8 AS reltuples,
              s.n_live_tup::bigint AS live_tup,
              s.n_dead_tup::bigint AS dead_tup
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = $1`,
      [table],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    const bytes = Number(row.bytes ?? 0);
    const reltuples = Math.max(Number(row.reltuples ?? 0), 0);
    const liveTup = Math.max(Number(row.live_tup ?? 0), 0);
    const deadTup = Math.max(Number(row.dead_tup ?? 0), 0);
    const totalTup = liveTup + deadTup;
    // No stats row (or a table the collector has never seen): fall back to the
    // physical size, i.e. exactly the pre-fix behaviour.
    const liveBytes =
      Number.isFinite(totalTup) && totalTup > 0
        ? (bytes * liveTup) / totalTup
        : bytes;
    const liveRows = liveTup > 0 ? liveTup : reltuples;
    return { bytes, liveBytes, reltuples, liveRows };
  }

  // Batched delete (50k per statement via ctid) so a prune never holds a
  // long lock. Returns rows deleted. `tokenId`, when given, scopes the delete
  // to one token so it rides the (token_id, received_at) index instead of
  // filtering a global time range.
  async function batchedDelete(
    config: RetentionTableConfig,
    cutoff: Date,
    tokenId: string | null,
  ): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_DELETE_BATCHES; i += 1) {
      const closedFilter =
        config.closedRowsOnly === true ? " AND ended_at IS NOT NULL" : "";
      const filterSql = tokenId === null ? "" : " AND token_id = $2";
      const params: unknown[] = tokenId === null ? [cutoff] : [cutoff, tokenId];
      const limit =
        config.requiresSeriesCoverage === true
          ? Math.min(batchSize, COVERAGE_BATCH_SIZE)
          : batchSize;
      const result = await pool.query(
        `DELETE FROM ${config.table}
          WHERE ctid IN (
            SELECT ctid FROM ${config.table}
             WHERE ${config.timeColumn} < $1${closedFilter}${filterSql}
             LIMIT ${limit}
          )`,
        params,
      );
      total += result.rowCount;
      if (result.rowCount < limit) {
        break;
      }
    }
    return total;
  }

  // Precondition (RFC-007 task 11): never delete a book delta whose 1-minute
  // aggregate does not exist yet. The first implementation asked that question
  // with ONE query — DISTINCT (token_id, minute) over every row below the
  // cutoff, grouped by token. Measured in production on 2026-08-25 that plan is
  // a full scan of 262 million rows: it blew through the recorder's 30 s
  // statement_timeout and threw, so the quota step aborted on EVERY run and
  // polymarket_book_deltas never got pruned at all (RETENTION_STEP_FAILED,
  // error swallowed per table). That is why the table reached 90 GB against a
  // 12 GB quota.
  //
  // The question is now asked per token, which turns the same check into an
  // index-only scan on (token_id, received_at): 14 s for the single heaviest
  // token (4.9 M rows) and milliseconds for most, all inside the timeout.
  //
  // It also stops being all-or-nothing. The old check skipped a token entirely
  // when ANY minute lacked a bucket, and a recorder restart leaves exactly that
  // — one unaggregated minute. One hole therefore froze a token's deltas
  // forever, and every restart added more frozen tokens until the quota could
  // never be met. Now a hole only truncates the prune: the token is pruned up
  // to its first uncovered minute, which preserves the guarantee exactly (no
  // delta is deleted without its aggregate) while still making progress.
  async function coverageCutoffForToken(
    tokenId: string,
    cutoff: Date,
  ): Promise<Date | null> {
    const result = await pool.query<{ first_uncovered: Date | string | null }>(
      `SELECT min(m.minute) AS first_uncovered
         FROM (
           SELECT DISTINCT date_trunc('minute', d.received_at) AS minute
             FROM polymarket_book_deltas d
            WHERE d.token_id = $1 AND d.received_at < $2
         ) m
         LEFT JOIN polymarket_series_1m s
           ON s.token_id = $1 AND s.bucket_start = m.minute
        WHERE s.bucket_start IS NULL`,
      [tokenId, cutoff],
    );
    const firstUncovered = toDate(result.rows[0]?.first_uncovered ?? null);
    if (firstUncovered === null) {
      return cutoff;
    }
    // A hole at or before the token's oldest retained minute leaves nothing
    // prunable for this token on this pass.
    return firstUncovered;
  }

  /** Oldest retained delta for one token; index-backed, so effectively free. */
  async function oldestDeltaForToken(tokenId: string): Promise<Date | null> {
    const result = await pool.query<{ oldest: Date | string | null }>(
      `SELECT min(received_at) AS oldest
         FROM polymarket_book_deltas
        WHERE token_id = $1`,
      [tokenId],
    );
    return toDate(result.rows[0]?.oldest ?? null);
  }

  /**
   * Tokens the delta pruner may consider. Read from polymarket_markets, which
   * retention never prunes and which recorded every market the registry ever
   * saw — verified in production to cover 100% of the tokens that have 1m
   * aggregates, in 0.5 s. Asking polymarket_book_deltas itself would mean the
   * 111 s full scan this rewrite exists to avoid.
   */
  async function registryTokenIds(): Promise<string[]> {
    const result = await pool.query<{ token_id: string }>(
      `SELECT DISTINCT jsonb_array_elements_text(clob_token_ids) AS token_id
         FROM polymarket_markets`,
      [],
    );
    return result.rows
      .map((row) => row.token_id)
      .filter((tokenId): tokenId is string => typeof tokenId === "string");
  }

  async function recordAction(action: RetentionAction): Promise<void> {
    await pool.query(
      `INSERT INTO polymarket_retention_log
         (table_name, cause, pruned_before, rows_deleted)
       VALUES ($1, $2, $3, $4)`,
      [action.table, action.cause, action.prunedBefore, action.rowsDeleted],
    );
  }

  /**
   * Coverage-gated prune: one token at a time, each with its OWN cutoff (the
   * requested one, or its first uncovered minute). A token whose aggregates
   * have a hole is pruned only up to that hole, and the hole is reported —
   * never silently, and never as a reason to stall the whole table.
   */
  async function pruneCovered(
    config: RetentionTableConfig,
    cutoff: Date,
    report: RetentionRunReport,
  ): Promise<number> {
    const tokenIds = await registryTokenIds();
    let total = 0;
    for (const tokenId of tokenIds) {
      total += await pruneCoveredToken(config, tokenId, cutoff, report);
    }
    return total;
  }

  /**
   * Prune one token up to `cutoff`, in bounded time slices.
   *
   * Slicing exists because the coverage query's cost grows with the range it
   * spans, and one token exceeding the statement timeout used to cost that
   * token its entire prune. Each slice asks a small question, deletes what it
   * cleared, and advances — so a token that cannot be checked in one shot is
   * still pruned in pieces.
   */
  async function pruneCoveredToken(
    config: RetentionTableConfig,
    tokenId: string,
    cutoff: Date,
    report: RetentionRunReport,
  ): Promise<number> {
    let oldest: Date | null;
    try {
      oldest = await oldestDeltaForToken(tokenId);
    } catch {
      oldest = null;
    }
    if (oldest === null || oldest.getTime() >= cutoff.getTime()) {
      return 0;
    }

    let total = 0;
    let sliceStart = oldest.getTime();
    for (let slice = 0; slice < MAX_COVERAGE_SLICES; slice += 1) {
      if (sliceStart >= cutoff.getTime()) {
        return total;
      }
      const sliceEnd = new Date(
        Math.min(sliceStart + COVERAGE_SLICE_MS, cutoff.getTime()),
      );
      let sliceCutoff: Date | null;
      try {
        sliceCutoff = await coverageCutoffForToken(tokenId, sliceEnd);
      } catch (error: unknown) {
        // One token's failure must not abort the table, and one slice's
        // failure must not abort the token: a single bad query used to cost
        // every token, then every slice.
        report.skipped.push({
          table: config.table,
          reason: "coverage_query_failed",
          tokenId,
        });
        log(
          "error",
          "RETENTION_STEP_FAILED",
          "polymarket_retention_coverage_failed",
          {
            table: config.table,
            token_id: tokenId,
            slice_end: sliceEnd.toISOString(),
            error_name: error instanceof Error ? error.name : "UnknownError",
          },
        );
        return total;
      }
      if (sliceCutoff === null || sliceCutoff.getTime() <= 0) {
        return total;
      }
      try {
        total += await batchedDelete(config, sliceCutoff, tokenId);
      } catch (error: unknown) {
        // The DELETE has to be inside the per-slice guard too. Measured in
        // production on 2026-08-26: a batch on a heavy token exceeded the 30 s
        // statement_timeout (three indexes to maintain, one of them 39 GB,
        // under live write load), the exception escaped past the coverage
        // guard, and the WHOLE table's quota step aborted — losing the prune
        // for all 1142 tokens, every run.
        report.skipped.push({
          table: config.table,
          reason: "delete_failed",
          tokenId,
        });
        log(
          "error",
          "RETENTION_STEP_FAILED",
          "polymarket_retention_delete_failed",
          {
            table: config.table,
            token_id: tokenId,
            cutoff: sliceCutoff.toISOString(),
            error_name: error instanceof Error ? error.name : "UnknownError",
          },
        );
        return total;
      }
      if (sliceCutoff.getTime() < sliceEnd.getTime()) {
        // A hole inside this slice: pruning stops here for this token, and the
        // hole is reported rather than silently stalling the table.
        report.skipped.push({
          table: config.table,
          reason: "series_coverage_missing",
          tokenId,
        });
        log(
          "warn",
          "SERIES_COVERAGE_MISSING",
          "polymarket_retention_series_coverage_missing",
          {
            token_id: tokenId,
            first_uncovered: sliceCutoff.toISOString(),
            requested_cutoff: cutoff.toISOString(),
          },
        );
        return total;
      }
      sliceStart = sliceEnd.getTime();
    }
    return total;
  }

  async function pruneBefore(
    config: RetentionTableConfig,
    cutoff: Date,
    cause: "ttl" | "quota",
    report: RetentionRunReport,
  ): Promise<number> {
    const rowsDeleted =
      config.requiresSeriesCoverage === true
        ? await pruneCovered(config, cutoff, report)
        : await batchedDelete(config, cutoff, null);
    if (rowsDeleted > 0) {
      const action: RetentionAction = {
        table: config.table,
        cause,
        prunedBefore: cutoff,
        rowsDeleted,
      };
      report.actions.push(action);
      await recordAction(action);
      log("info", "RETENTION_PRUNE", "polymarket_retention_prune", {
        table: config.table,
        cause,
        rows_deleted: rowsDeleted,
        pruned_before: cutoff.toISOString(),
      });
    }
    return rowsDeleted;
  }

  /**
   * Cutoff read off the equi-depth histogram Postgres already keeps for the
   * column (pg_stats.histogram_bounds). Preferred over the linear estimate
   * below, because it is the same question asked correctly: the bounds map a
   * row-fraction to a timestamp whatever the arrival rate did over the window.
   *
   * That distinction was worth ~2x in production. Measured 2026-08-27,
   * polymarket_book_deltas ran from 0.5 M rows/day to 27 M rows/day inside one
   * 8-day window as the recorded universe grew, so the linear estimate asked
   * for 56% of the rows and picked a timestamp that held 23% of them. The table
   * sat at 95 GB against a 52 GB quota because every pass under-deleted by that
   * factor.
   *
   * `floor` is the cutoff this run already pruned to: those buckets are gone,
   * so the walk starts there and can only move forward.
   *
   * Not used for closedRowsOnly tables — the histogram covers every row, not
   * just the eligible ones. Those tables are small enough for the exact probe.
   */
  async function histogramCutoff(
    config: RetentionTableConfig,
    rowsToDelete: number,
    liveRows: number,
    floor: Date | null,
  ): Promise<Date | null> {
    const result = await pool.query<{
      bounds: unknown;
      null_frac: string | number | null;
      mcv_frac: string | number | null;
    }>(
      `SELECT histogram_bounds::text::timestamptz[] AS bounds,
              null_frac,
              COALESCE(
                (SELECT sum(f) FROM unnest(most_common_freqs) AS f), 0
              ) AS mcv_frac
         FROM pg_stats
        WHERE schemaname = current_schema()
          AND tablename = $1
          AND attname = $2`,
      [config.table, config.timeColumn],
    );
    const row = result.rows[0];
    const raw = row?.bounds;
    if (!Array.isArray(raw) || liveRows <= 0) {
      return null;
    }
    // The histogram describes only the rows that are neither NULL nor a most
    // common value, so its bucket fractions map to the whole table only while
    // those two are negligible. They are, for a sub-second timestamp column
    // that is NOT NULL — but that is a property of the data, not a guarantee,
    // so check it instead of assuming it and fall back to the linear span.
    const excluded =
      Math.max(Number(row?.null_frac ?? 0), 0) +
      Math.max(Number(row?.mcv_frac ?? 0), 0);
    if (!Number.isFinite(excluded) || excluded > HISTOGRAM_MAX_EXCLUDED_FRAC) {
      log(
        "warn",
        "RETENTION_HISTOGRAM_UNUSABLE",
        "polymarket_retention_histogram_unusable",
        {
          table: config.table,
          column: config.timeColumn,
          excluded_frac: excluded,
        },
      );
      return null;
    }
    const bounds: Date[] = [];
    for (const value of raw) {
      const parsed = toDate(value);
      if (parsed !== null) {
        bounds.push(parsed);
      }
    }
    if (bounds.length < 2) {
      return null;
    }
    const buckets = bounds.length - 1;
    // Buckets already consumed by this run's earlier passes.
    let startIndex = 0;
    if (floor !== null) {
      // >= , not >: a floor that IS a bound means the buckets below it are
      // gone and this one is where the walk resumes. Using > skips it and
      // costs the pass a whole bucket of headroom against the clamp.
      const resumeAt = bounds.findIndex(
        (bound) => bound.getTime() >= floor.getTime(),
      );
      startIndex = resumeAt === -1 ? buckets : resumeAt;
    }
    const rowsPerBucket = Math.max(liveRows / buckets, 1);
    const steps = Math.max(Math.ceil(rowsToDelete / rowsPerBucket), 1);
    // Same guarantee MAX_INTERPOLATED_FRACTION gives the linear path: a single
    // pass can never collapse to "delete everything below the newest row".
    const maxIndex = Math.max(
      Math.floor(buckets * MAX_INTERPOLATED_FRACTION),
      1,
    );
    const index = Math.min(startIndex + steps, maxIndex);
    if (index <= startIndex) {
      // Already at the clamp: this pass has taken everything it may.
      return null;
    }
    const cutoff = bounds[index];
    if (cutoff === undefined) {
      return null;
    }
    log(
      "info",
      "RETENTION_CUTOFF_HISTOGRAM",
      "polymarket_retention_cutoff_histogram",
      {
        table: config.table,
        rows_to_delete: rowsToDelete,
        buckets,
        start_index: startIndex,
        index,
        cutoff: cutoff.toISOString(),
      },
    );
    return cutoff;
  }

  /**
   * Linear fallback for when the histogram is unavailable (no ANALYZE yet, or a
   * closedRowsOnly table). Assumes a roughly uniform arrival rate, which is
   * exactly the assumption histogramCutoff exists to stop relying on — keep it
   * as a fallback, not as the default path. The fraction is capped well below 1
   * so the estimate can never collapse to "delete everything below the newest
   * row" — the failure mode the exact probe's COUNT fallback exists to prevent,
   * kept here as a hard clamp instead.
   */
  async function interpolatedCutoff(
    config: RetentionTableConfig,
    rowsToDelete: number,
    liveRows: number,
    eligibleWhere: string,
    floor: Date | null,
  ): Promise<Date | null> {
    const bounds = await pool.query<{
      oldest: Date | string | null;
      newest: Date | string | null;
    }>(
      `SELECT min(${config.timeColumn}) AS oldest,
              max(${config.timeColumn}) AS newest
         FROM ${config.table}${eligibleWhere}`,
      [],
    );
    const oldest = toDate(bounds.rows[0]?.oldest ?? null);
    const newest = toDate(bounds.rows[0]?.newest ?? null);
    if (oldest === null || newest === null) {
      log(
        "warn",
        "RETENTION_CUTOFF_UNAVAILABLE",
        "polymarket_retention_cutoff_unavailable",
        { table: config.table, rows_to_delete: rowsToDelete },
      );
      return null;
    }
    // Anchor at what this run already pruned to, never at min(). min() is held
    // wherever the oldest UNDELETABLE row sits, and that row need not be
    // representative of anything: measured 2026-08-27, 82 of 681 delta tokens
    // were frozen by a series_1m coverage hole, holding 0.5% of the rows but
    // pinning min() four days behind the real mass. Every estimate anchored
    // there is flattened by the empty span in front of it, and — because the
    // anchor never moves — the loop's later passes re-derive a cutoff EARLIER
    // than the one they just pruned to. Anchoring on the floor removes both.
    const anchorMs =
      floor === null
        ? oldest.getTime()
        : Math.max(oldest.getTime(), floor.getTime());
    const spanMs = newest.getTime() - anchorMs;
    if (spanMs <= 0 || liveRows <= 0) {
      return null;
    }
    const rawFraction = rowsToDelete / liveRows;
    const fraction = Math.min(
      Math.max(rawFraction, 0),
      MAX_INTERPOLATED_FRACTION,
    );
    const cutoff = new Date(anchorMs + Math.floor(spanMs * fraction));
    log(
      "info",
      "RETENTION_CUTOFF_INTERPOLATED",
      "polymarket_retention_cutoff_interpolated",
      {
        table: config.table,
        rows_to_delete: rowsToDelete,
        live_rows: liveRows,
        fraction,
        anchored_at: new Date(anchorMs).toISOString(),
        cutoff: cutoff.toISOString(),
      },
    );
    return cutoff;
  }

  // Find the time cutoff that removes the oldest `rowsToDelete` rows. The
  // OFFSET probe can come back empty when pg_class.reltuples overestimates
  // the live row count (typical right after a TTL prune, before autovacuum
  // refreshes stats). Falling back to `now` there would wipe the ENTIRE
  // table, so instead: clamp by the real COUNT(*) — only paid when the probe
  // fails, never as the default path — and if a cutoff still cannot be
  // established, abort this table's quota iteration (logged, never silent).
  async function quotaCutoff(
    config: RetentionTableConfig,
    rowsToDelete: number,
    liveRows: number,
    floor: Date | null,
  ): Promise<Date | null> {
    const eligibleWhere =
      config.closedRowsOnly === true ? " WHERE ended_at IS NOT NULL" : "";
    // The exact OFFSET probe is unusable on a large table: measured in
    // production on polymarket_book_deltas at 42.7 s for OFFSET 100 000 000,
    // against the recorder's 30 s statement_timeout. It threw, the quota step
    // aborted, and the table kept growing. Above the threshold, estimate the
    // cutoff instead: first from the column's equi-depth histogram, which is a
    // catalog read and survives a non-uniform arrival rate, and only then from
    // the linear span if no histogram exists yet.
    if (liveRows > INTERPOLATION_MIN_ROWS) {
      if (eligibleWhere === "") {
        const fromHistogram = await histogramCutoff(
          config,
          rowsToDelete,
          liveRows,
          floor,
        );
        if (fromHistogram !== null) {
          return fromHistogram;
        }
      }
      return interpolatedCutoff(
        config,
        rowsToDelete,
        liveRows,
        eligibleWhere,
        floor,
      );
    }
    const probe = async (offset: number): Promise<Date | null> => {
      const result = await pool.query<{ cutoff: Date | string }>(
        `SELECT ${config.timeColumn} AS cutoff
           FROM ${config.table}
          ${eligibleWhere}
          ORDER BY ${config.timeColumn} ASC
         OFFSET ${Math.max(offset, 0)} LIMIT 1`,
        [],
      );
      return toDate(result.rows[0]?.cutoff);
    };
    let cutoff = await probe(rowsToDelete - 1);
    if (cutoff === null) {
      const counted = await pool.query<{ live_rows: string | number }>(
        `SELECT COUNT(*)::bigint AS live_rows FROM ${config.table}${eligibleWhere}`,
        [],
      );
      const liveRows = Number(counted.rows[0]?.live_rows ?? 0);
      if (liveRows > 0 && liveRows < rowsToDelete) {
        cutoff = await probe(liveRows - 1);
      }
    }
    if (cutoff === null) {
      log(
        "warn",
        "RETENTION_CUTOFF_UNAVAILABLE",
        "polymarket_retention_cutoff_unavailable",
        { table: config.table, rows_to_delete: rowsToDelete },
      );
    }
    return cutoff;
  }

  // Quota pruning: estimate bytes/row from pg_class stats, translate the
  // overshoot into a time cutoff (oldest rows first), delete, and iterate
  // until the table is back under the 80% target.
  //
  // Progress is tracked LOGICALLY: neither the physical size nor the stats
  // counters settle inside a single run, so the size is measured exactly once
  // and the stop condition is estimated live bytes = initial live bytes -
  // rowsDeleted * bytesPerRow. Re-measuring inside the loop would report a
  // near-constant size and keep deleting until the table was empty. The 80%
  // target is therefore a logical target; the physical file only shrinks on a
  // rewrite, and until then the freed pages are reused by new inserts.
  async function pruneQuota(
    config: RetentionTableConfig,
    report: RetentionRunReport,
  ): Promise<void> {
    const size = await tableSize(config.table);
    if (size === null) {
      return;
    }
    const trigger = config.quotaBytes * QUOTA_TRIGGER_RATIO;
    const target = config.quotaBytes * QUOTA_TARGET_RATIO;
    // Quota is measured against LIVE bytes, never physical: see tableSize.
    if (size.liveBytes < trigger) {
      if (size.bytes >= trigger) {
        // Retained data is inside the quota but the file is not: bloat that
        // new inserts will reuse. Surfaced so the disk footprint is never
        // silently different from the retained window.
        log("info", "RETENTION_BLOAT", "polymarket_retention_bloat", {
          table: config.table,
          physical_bytes: size.bytes,
          live_bytes: Math.round(size.liveBytes),
          quota_bytes: config.quotaBytes,
        });
      }
      return;
    }
    const bytesPerRow = Math.max(
      size.liveBytes / Math.max(size.liveRows, 1),
      1,
    );
    let estimatedLiveBytes = size.liveBytes;
    // Cutoff this run has already pruned to. Every later pass must advance
    // beyond it — see the no-progress guard below.
    let floor: Date | null = null;
    for (let iteration = 0; iteration < maxQuotaIterations; iteration += 1) {
      if (estimatedLiveBytes < target) {
        return;
      }
      const rowsToDelete = Math.max(
        Math.ceil((estimatedLiveBytes - target) / bytesPerRow),
        1,
      );
      const cutoff = await quotaCutoff(
        config,
        rowsToDelete,
        size.liveRows,
        floor,
      );
      if (cutoff === null) {
        // No usable cutoff (stats overestimated the table): abort this
        // table's quota iteration — never fall back to `now`, which would
        // delete every row. quotaCutoff already logged the abort.
        return;
      }
      // Forward-only, and the reason is the bug this guard replaces.
      //
      // A pass that deletes less than planned leaves a LARGER shortfall, but
      // the old loop answered it with a SMALLER rowsToDelete (the shortfall is
      // measured against the target, and something was deleted), hence a
      // smaller fraction, hence a cutoff EARLIER than the one it had just
      // pruned to. That deletes nothing and trips the unmet branch below, so
      // the whole maxQuotaIterations budget was worth exactly one pass whenever
      // the first estimate fell short — which, on a skewed arrival rate, was
      // every run. Measured 2026-08-27: one action per run in
      // polymarket_retention_log, never four, with the table at ~2x its quota.
      //
      // The estimators now take the floor into account, so reaching this guard
      // means they genuinely have nothing left to offer. Stop rather than spin.
      if (floor !== null && cutoff.getTime() <= floor.getTime()) {
        log(
          "warn",
          "RETENTION_QUOTA_NO_PROGRESS",
          "polymarket_retention_quota_no_progress",
          {
            table: config.table,
            cutoff: cutoff.toISOString(),
            floor: floor.toISOString(),
          },
        );
        return;
      }
      const deleted = await pruneBefore(config, cutoff, "quota", report);
      floor = cutoff;
      if (deleted === 0) {
        // Blocked (e.g. missing aggregates) or already empty: stop iterating
        // so the job never spins; the skip was logged above.
        log(
          "warn",
          "RETENTION_QUOTA_UNMET",
          "polymarket_retention_quota_unmet",
          {
            table: config.table,
            bytes: size.bytes,
            live_bytes: Math.round(size.liveBytes),
            quota_bytes: config.quotaBytes,
          },
        );
        return;
      }
      estimatedLiveBytes -= deleted * bytesPerRow;
    }
  }

  return {
    async runOnce(): Promise<RetentionRunReport> {
      const now = deps.clock();
      const report: RetentionRunReport = {
        actions: [],
        skipped: [],
        globalAlarm: false,
        totalBytes: 0,
        totalLiveBytes: 0,
      };

      // Global budget check first: at >= 90% of the budget, alarm and shrink
      // the effective TTLs for this run.
      //
      // Measured on LIVE bytes, for the same reason the per-table quota is
      // (see tableSize). The alarm's only lever is deleting rows, and deleting
      // rows moves live bytes; physical bytes never come back on DELETE, since
      // the pages stay in the file until a rewrite, which nothing here runs. An
      // alarm armed on the physical total can therefore be raised by bloat it
      // cannot clear, and it answers with deletes that destroy retained data
      // without moving the number they are aimed at.
      //
      // Measured in production 2026-08-27: 114 GiB physical, 110 GiB live, so
      // only ~4 GiB of the footprint was bloat and the alarm was NOT a false
      // one — retained data really was over the 99 GiB trigger, because
      // polymarket_book_deltas sat at 95 GB against its 52 GB quota. Switching
      // the metric does not silence the alarm here; it makes the alarm mean
      // what it says, and routes the bloat case to its own signal below.
      // Note that the declared quotas sum to 95 GiB, under the trigger (a
      // tested invariant) — so a live total above it always means a quota is
      // not being enforced, or a protected table has overrun.
      let totalBytes = 0;
      let totalLiveBytes = 0;
      for (const config of tables) {
        try {
          const size = await tableSize(config.table);
          totalBytes += size?.bytes ?? 0;
          totalLiveBytes += size?.liveBytes ?? 0;
        } catch (error: unknown) {
          log(
            "error",
            "RETENTION_STEP_FAILED",
            "polymarket_retention_size_failed",
            {
              table: config.table,
              error_name: error instanceof Error ? error.name : "UnknownError",
            },
          );
        }
      }
      const globalTrigger = budgetBytes * QUOTA_TRIGGER_RATIO;
      const globalAlarm = totalLiveBytes >= globalTrigger;
      if (globalAlarm) {
        log(
          "error",
          "QUOTA_GLOBAL_ALARM",
          "polymarket_retention_global_quota_alarm",
          {
            total_bytes: totalBytes,
            live_bytes: Math.round(totalLiveBytes),
            budget_bytes: budgetBytes,
          },
        );
      } else if (totalBytes >= globalTrigger) {
        // Retained data is inside the budget but the files are not: bloat that
        // new inserts will reuse. Deliberately NOT an alarm and deliberately
        // without a TTL reduction — no DELETE can shrink a file, so pruning
        // here would only destroy retained data while the number it is aimed at
        // stayed put. The remedy is VACUUM FULL / pg_repack on the bloated
        // tables, which takes an exclusive lock and is the owner's call, not a
        // daily job's. Same distinction as RETENTION_BLOAT, one level up.
        log(
          "warn",
          "RETENTION_GLOBAL_BLOAT",
          "polymarket_retention_global_bloat",
          {
            physical_bytes: totalBytes,
            live_bytes: Math.round(totalLiveBytes),
            budget_bytes: budgetBytes,
            bloat_bytes: Math.round(totalBytes - totalLiveBytes),
          },
        );
      }

      for (const config of tables) {
        if (config.protected) {
          continue;
        }
        // (a) TTL prune.
        if (config.ttlDays !== null) {
          const effectiveTtlDays = globalAlarm
            ? config.ttlDays * GLOBAL_ALARM_TTL_FACTOR
            : config.ttlDays;
          if (globalAlarm) {
            log(
              "warn",
              "QUOTA_GLOBAL_TTL_REDUCED",
              "polymarket_retention_effective_ttl_reduced",
              { table: config.table, effective_ttl_days: effectiveTtlDays },
            );
          }
          const cutoff = new Date(now.getTime() - effectiveTtlDays * DAY_MS);
          try {
            await pruneBefore(config, cutoff, "ttl", report);
          } catch (error: unknown) {
            log(
              "error",
              "RETENTION_STEP_FAILED",
              "polymarket_retention_ttl_failed",
              {
                table: config.table,
                error_name:
                  error instanceof Error ? error.name : "UnknownError",
              },
            );
          }
        }
        // (b) Quota prune (quota beats TTL — applies to no-TTL tables too).
        try {
          await pruneQuota(config, report);
        } catch (error: unknown) {
          log(
            "error",
            "RETENTION_STEP_FAILED",
            "polymarket_retention_quota_failed",
            {
              table: config.table,
              error_name: error instanceof Error ? error.name : "UnknownError",
            },
          );
        }
      }

      return { ...report, globalAlarm, totalBytes, totalLiveBytes };
    },
  };
}
