// RFC-007 task 11: retention job (TTL + quota; quota beats TTL; daily prune).
// Protected tables are never pruned. Before pruning book_deltas the 1-minute
// aggregates must already cover the pruned interval — otherwise skip and log,
// never silently. Every prune action is audited in polymarket_retention_log.
// A persistence failure never crashes the process: log and continue.

import type { SqlExecutor } from "../database.js";

export type RetentionQueryPool = { query: SqlExecutor["query"] };

const GB = 1024 ** 3;

export const DEFAULT_BUDGET_BYTES = 40 * GB;
export const DEFAULT_BATCH_SIZE = 50_000;
export const QUOTA_TRIGGER_RATIO = 0.9;
export const QUOTA_TARGET_RATIO = 0.8;
/** Effective-TTL reduction per step when the global 40 GB budget alarms. */
export const GLOBAL_ALARM_TTL_FACTOR = 0.75;
const MAX_QUOTA_ITERATIONS = 4;
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
}

// RFC-007 retention table, top-to-bottom in alarm-reduction order. Tables with
// ttlDays null but a quota may still be pruned oldest-first when the quota
// trips (quota beats TTL). Protected tables are never touched.
export const RETENTION_TABLES: readonly RetentionTableConfig[] = [
  {
    table: "polymarket_book_deltas",
    ttlDays: 14,
    quotaBytes: 12 * GB,
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
  {
    table: "polymarket_book_snapshots",
    ttlDays: 90,
    quotaBytes: 4 * GB,
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
  {
    table: "polymarket_series_1m",
    ttlDays: null,
    quotaBytes: 3 * GB,
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
  // RFC-007 budget set aside for the RFC-010..013 tables.
  {
    table: "fundamental_estimates",
    ttlDays: 90,
    quotaBytes: 3 * GB,
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
  {
    table: "paper_orders",
    ttlDays: null,
    quotaBytes: 0.05 * GB,
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
  {
    table: "paper_kill_switch",
    ttlDays: null,
    quotaBytes: 0.005 * GB,
    timeColumn: "updated_at",
    protected: true,
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
  readonly totalBytes: number;
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
  readonly bytes: number;
  readonly reltuples: number;
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

  async function tableSize(table: string): Promise<TableSize | null> {
    const result = await pool.query<{
      bytes: string | number | null;
      reltuples: string | number | null;
    }>(
      `SELECT pg_total_relation_size(c.oid)::bigint AS bytes,
              c.reltuples::float8 AS reltuples
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = $1`,
      [table],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      bytes: Number(row.bytes ?? 0),
      reltuples: Math.max(Number(row.reltuples ?? 0), 0),
    };
  }

  // Batched delete (50k per statement via ctid) so a prune never holds a
  // long lock. Returns rows deleted. tokenFilter narrows book_deltas prunes
  // to tokens whose 1-minute aggregates already cover the interval.
  async function batchedDelete(
    config: RetentionTableConfig,
    cutoff: Date,
    tokenFilter: readonly string[] | null,
  ): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_DELETE_BATCHES; i += 1) {
      const filterSql = tokenFilter === null ? "" : " AND token_id = ANY($2)";
      const params: unknown[] =
        tokenFilter === null ? [cutoff] : [cutoff, [...tokenFilter]];
      const result = await pool.query(
        `DELETE FROM ${config.table}
          WHERE ctid IN (
            SELECT ctid FROM ${config.table}
             WHERE ${config.timeColumn} < $1${filterSql}
             LIMIT ${batchSize}
          )`,
        params,
      );
      total += result.rowCount;
      if (result.rowCount < batchSize) {
        break;
      }
    }
    return total;
  }

  // Precondition (RFC task 11): only prune book_deltas whose interval is
  // already materialized in polymarket_series_1m. Buckets only exist for
  // minutes that actually saw events, so coverage is checked against the
  // minutes that really contain deltas (COUNT of DISTINCT delta minutes vs.
  // how many of those minutes have a bucket) — never against every minute of
  // the min..max range, which would make sparse tokens permanently unprunable.
  // Returns the tokens allowed to be pruned; uncovered tokens are skipped and
  // logged, never silently.
  async function seriesCoveredTokens(
    cutoff: Date,
    skipped: RetentionSkip[],
  ): Promise<string[]> {
    const coverage = await pool.query<{
      token_id: string;
      delta_minutes: string | number;
      covered_minutes: string | number;
    }>(
      `SELECT d.token_id,
              COUNT(*)::bigint AS delta_minutes,
              COUNT(s.bucket_start)::bigint AS covered_minutes
         FROM (
           SELECT DISTINCT token_id,
                  date_trunc('minute', received_at) AS minute
             FROM polymarket_book_deltas
            WHERE received_at < $1
         ) d
         LEFT JOIN polymarket_series_1m s
           ON s.token_id = d.token_id AND s.bucket_start = d.minute
        GROUP BY d.token_id`,
      [cutoff],
    );
    const allowed: string[] = [];
    for (const row of coverage.rows) {
      const deltaMinutes = Number(row.delta_minutes);
      const coveredMinutes = Number(row.covered_minutes);
      if (
        Number.isFinite(deltaMinutes) &&
        Number.isFinite(coveredMinutes) &&
        deltaMinutes > 0 &&
        coveredMinutes >= deltaMinutes
      ) {
        allowed.push(row.token_id);
      } else {
        skipped.push({
          table: "polymarket_book_deltas",
          reason: "series_coverage_missing",
          tokenId: row.token_id,
        });
        log(
          "warn",
          "SERIES_COVERAGE_MISSING",
          "polymarket_retention_series_coverage_missing",
          {
            token_id: row.token_id,
            delta_minutes: deltaMinutes,
            covered_minutes: coveredMinutes,
          },
        );
      }
    }
    return allowed;
  }

  async function recordAction(action: RetentionAction): Promise<void> {
    await pool.query(
      `INSERT INTO polymarket_retention_log
         (table_name, cause, pruned_before, rows_deleted)
       VALUES ($1, $2, $3, $4)`,
      [action.table, action.cause, action.prunedBefore, action.rowsDeleted],
    );
  }

  async function pruneBefore(
    config: RetentionTableConfig,
    cutoff: Date,
    cause: "ttl" | "quota",
    report: RetentionRunReport,
  ): Promise<number> {
    let tokenFilter: readonly string[] | null = null;
    if (config.requiresSeriesCoverage === true) {
      tokenFilter = await seriesCoveredTokens(cutoff, report.skipped);
      if (tokenFilter.length === 0) {
        return 0;
      }
    }
    const rowsDeleted = await batchedDelete(config, cutoff, tokenFilter);
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
  ): Promise<Date | null> {
    const probe = async (offset: number): Promise<Date | null> => {
      const result = await pool.query<{ cutoff: Date | string }>(
        `SELECT ${config.timeColumn} AS cutoff
           FROM ${config.table}
          ORDER BY ${config.timeColumn} ASC
         OFFSET ${Math.max(offset, 0)} LIMIT 1`,
        [],
      );
      return toDate(result.rows[0]?.cutoff);
    };
    let cutoff = await probe(rowsToDelete - 1);
    if (cutoff === null) {
      const counted = await pool.query<{ live_rows: string | number }>(
        `SELECT COUNT(*)::bigint AS live_rows FROM ${config.table}`,
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
  // Progress is tracked LOGICALLY: pg_total_relation_size does not shrink
  // after DELETE (dead tuples stay until VACUUM reclaims the space), so the
  // physical size is measured exactly once per run and the stop condition is
  // estimated live bytes = initial bytes - rowsDeleted * bytesPerRow.
  // Re-measuring inside the loop would report constant size and keep
  // deleting until the table was empty. The 80% target is therefore a
  // logical target; the physical space only comes back after vacuum.
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
    if (size.bytes < trigger) {
      return;
    }
    const bytesPerRow = Math.max(size.bytes / Math.max(size.reltuples, 1), 1);
    let estimatedLiveBytes = size.bytes;
    for (let iteration = 0; iteration < maxQuotaIterations; iteration += 1) {
      if (estimatedLiveBytes < target) {
        return;
      }
      const rowsToDelete = Math.max(
        Math.ceil((estimatedLiveBytes - target) / bytesPerRow),
        1,
      );
      const cutoff = await quotaCutoff(config, rowsToDelete);
      if (cutoff === null) {
        // No usable cutoff (stats overestimated the table): abort this
        // table's quota iteration — never fall back to `now`, which would
        // delete every row. quotaCutoff already logged the abort.
        return;
      }
      const deleted = await pruneBefore(config, cutoff, "quota", report);
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
      };

      // Global budget check first: at >= 90% of 40 GB, alarm and shrink the
      // effective TTLs for this run, top-to-bottom, 25% per step.
      let totalBytes = 0;
      for (const config of tables) {
        try {
          const size = await tableSize(config.table);
          totalBytes += size?.bytes ?? 0;
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
      const globalAlarm = totalBytes >= budgetBytes * QUOTA_TRIGGER_RATIO;
      if (globalAlarm) {
        log(
          "error",
          "QUOTA_GLOBAL_ALARM",
          "polymarket_retention_global_quota_alarm",
          {
            total_bytes: totalBytes,
            budget_bytes: budgetBytes,
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

      return { ...report, globalAlarm, totalBytes };
    },
  };
}
