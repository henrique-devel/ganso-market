// RFC-041 DATA-02: the legacy retention schedule is catalog monitoring only.
// Protection and unknown evidence closure always prevail over quota/TTL.

import type { SqlExecutor } from "../database.js";
import { errorFields } from "../errors.js";
import {
  getRetentionProtection,
  RETENTION_POLICY_VERSION,
} from "./retention-policy.js";

export type RetentionQueryPool = { query: SqlExecutor["query"] };

const GB = 1024 ** 3;

// Existing declared baseline, not a new capacity recommendation (RFC-041).
export const DEFAULT_BUDGET_BYTES = 110 * GB;
export const QUOTA_TRIGGER_RATIO = 0.9;
// Legacy public constants retained for compatibility, with no deletion/TTL effect.
export const DEFAULT_BATCH_SIZE = 50_000;
export const COVERAGE_BATCH_SIZE = 5_000;
export const QUOTA_DELETE_BYTE_BUDGET = 32 * 1024 * 1024;
export const QUOTA_TARGET_RATIO = 0.8;
export const GLOBAL_ALARM_TTL_FACTOR = 0.75;

const HEAP_TUPLE_OVERHEAD = 28;
const INDEX_TUPLE_OVERHEAD = 16;
const BTREE_LEAF_FILL = 0.9;
const TOAST_CHUNK_BYTES = 2048;

export interface RetentionTableConfig {
  readonly table: string;
  readonly ttlDays: number | null;
  readonly quotaBytes: number;
  readonly timeColumn: string;
  readonly protected: boolean;
  /** Historical coverage declaration; raw L2 also requires a dataset horizon/pin. */
  readonly requiresSeriesCoverage?: boolean;
  /** Historical lifecycle declaration; the monitoring job holds every row. */
  readonly closedRowsOnly?: boolean;
}

const RETENTION_DECLARATIONS: readonly Omit<
  RetentionTableConfig,
  "protected"
>[] = [
  {
    table: "polymarket_book_deltas",
    ttlDays: 14,
    quotaBytes: 52 * GB,
    timeColumn: "received_at",
    requiresSeriesCoverage: true,
  },
  {
    table: "polymarket_book_snapshots_full",
    ttlDays: 30,
    quotaBytes: 4 * GB,
    timeColumn: "received_at",
  },
  {
    table: "polymarket_book_snapshots",
    ttlDays: 90,
    quotaBytes: 8 * GB,
    timeColumn: "received_at",
  },
  {
    table: "polymarket_trades",
    ttlDays: 365,
    quotaBytes: 3 * GB,
    timeColumn: "received_at",
  },
  {
    table: "polymarket_series_1m",
    ttlDays: null,
    quotaBytes: 10 * GB,
    timeColumn: "bucket_start",
  },
  {
    table: "polymarket_oi_holders",
    ttlDays: null,
    quotaBytes: 1 * GB,
    timeColumn: "received_at",
  },
  {
    table: "polymarket_rtds_prices",
    ttlDays: 90,
    quotaBytes: 2 * GB,
    timeColumn: "received_at",
  },
  {
    table: "polymarket_rtds_1m",
    ttlDays: null,
    quotaBytes: 0.5 * GB,
    timeColumn: "bucket_start",
  },
  {
    table: "fundamental_estimates",
    ttlDays: 90,
    quotaBytes: 2 * GB,
    timeColumn: "received_at",
  },
  {
    table: "paper_feature_windows",
    ttlDays: 30,
    quotaBytes: 0.6 * GB,
    timeColumn: "window_start",
  },
  {
    table: "paper_ledger_events",
    ttlDays: null,
    quotaBytes: 0.25 * GB,
    timeColumn: "received_at",
  },
  {
    table: "paper_orders",
    ttlDays: null,
    quotaBytes: 0.035 * GB,
    timeColumn: "created_at",
  },
  {
    table: "paper_positions",
    ttlDays: null,
    quotaBytes: 0.01 * GB,
    timeColumn: "updated_at",
  },
  {
    table: "paper_markouts",
    ttlDays: 180,
    quotaBytes: 0.25 * GB,
    timeColumn: "fill_ts",
  },
  {
    table: "paper_fill_samples",
    ttlDays: 180,
    quotaBytes: 0.1 * GB,
    timeColumn: "sampled_at",
  },
  {
    table: "paper_fill_reports",
    ttlDays: null,
    quotaBytes: 0.05 * GB,
    timeColumn: "generated_at",
  },
  {
    table: "paper_kill_switch",
    ttlDays: null,
    quotaBytes: 0.005 * GB,
    timeColumn: "updated_at",
  },
  {
    table: "resolution_scores",
    ttlDays: 180,
    quotaBytes: 0.35 * GB,
    timeColumn: "received_at",
  },
  {
    table: "resolution_score_versions",
    ttlDays: null,
    quotaBytes: 0.02 * GB,
    timeColumn: "created_at",
  },
  {
    table: "resolution_market_state",
    ttlDays: null,
    quotaBytes: 0.01 * GB,
    timeColumn: "updated_at",
  },
  {
    table: "resolution_clarifications",
    ttlDays: null,
    quotaBytes: 0.02 * GB,
    timeColumn: "received_at",
  },
  {
    table: "resolution_uma_timeline",
    ttlDays: null,
    quotaBytes: 0.05 * GB,
    timeColumn: "received_at",
  },
  {
    table: "resolution_onchain_events",
    ttlDays: null,
    quotaBytes: 0.09 * GB,
    timeColumn: "received_at",
  },
  {
    table: "resolution_onchain_cursor",
    ttlDays: null,
    quotaBytes: 0.01 * GB,
    timeColumn: "updated_at",
  },
  {
    table: "resolution_adjudication_samples",
    ttlDays: 90,
    quotaBytes: 0.05 * GB,
    timeColumn: "received_at",
  },
  {
    table: "graph_edges",
    ttlDays: null,
    quotaBytes: 0.05 * GB,
    timeColumn: "created_at",
  },
  {
    table: "graph_violations",
    ttlDays: 180,
    quotaBytes: 0.15 * GB,
    timeColumn: "received_at",
  },
  {
    table: "graph_sanity_vetoes",
    ttlDays: 180,
    quotaBytes: 0.05 * GB,
    timeColumn: "ended_at",
    closedRowsOnly: true,
  },
  {
    table: "resolution_layer_divergences",
    ttlDays: 180,
    quotaBytes: 0.05 * GB,
    timeColumn: "received_at",
  },
  {
    table: "resolution_reports",
    ttlDays: null,
    quotaBytes: 0.1 * GB,
    timeColumn: "generated_at",
  },
  {
    table: "portfolio_decisions",
    ttlDays: 90,
    quotaBytes: 0.9 * GB,
    timeColumn: "received_at",
  },
  {
    table: "portfolio_panel_snapshots",
    ttlDays: 2,
    quotaBytes: 0.53 * GB,
    timeColumn: "received_at",
  },
  {
    table: "portfolio_gate_measurements",
    ttlDays: null,
    quotaBytes: 0.25 * GB,
    timeColumn: "received_at",
  },
  {
    table: "portfolio_gate_reports",
    ttlDays: null,
    quotaBytes: 0.1 * GB,
    timeColumn: "received_at",
  },
  {
    table: "portfolio_exposures",
    ttlDays: null,
    quotaBytes: 0.02 * GB,
    timeColumn: "computed_at",
  },
  {
    table: "portfolio_state",
    ttlDays: null,
    quotaBytes: 0.005 * GB,
    timeColumn: "updated_at",
  },
  {
    table: "portfolio_state_events",
    ttlDays: null,
    quotaBytes: 0.05 * GB,
    timeColumn: "at",
  },
  {
    table: "portfolio_config_versions",
    ttlDays: null,
    quotaBytes: 0.02 * GB,
    timeColumn: "created_at",
  },
  {
    table: "portfolio_factor_map_versions",
    ttlDays: null,
    quotaBytes: 0.02 * GB,
    timeColumn: "created_at",
  },
  {
    table: "portfolio_g2_clock",
    ttlDays: null,
    quotaBytes: 0.005 * GB,
    timeColumn: "updated_at",
  },
  {
    table: "portfolio_g2_clock_events",
    ttlDays: null,
    quotaBytes: 0.02 * GB,
    timeColumn: "at",
  },
  {
    table: "portfolio_decision_hourly",
    ttlDays: 90,
    quotaBytes: 0.005 * GB,
    timeColumn: "hour_start",
  },
  {
    table: "portfolio_cycle_summary",
    ttlDays: 90,
    quotaBytes: 0.005 * GB,
    timeColumn: "cycle_at",
  },
  {
    table: "portfolio_position_entries",
    ttlDays: null,
    quotaBytes: 0.02 * GB,
    timeColumn: "created_at",
  },
  {
    table: "portfolio_circuit_breakers",
    ttlDays: 180,
    quotaBytes: 0.05 * GB,
    timeColumn: "ended_at",
    closedRowsOnly: true,
  },
  {
    table: "fundamental_models",
    ttlDays: null,
    quotaBytes: 0.1 * GB,
    timeColumn: "created_at",
  },
  {
    table: "fundamental_labels",
    ttlDays: null,
    quotaBytes: 0.5 * GB,
    timeColumn: "received_at",
  },
  {
    table: "fundamental_gate_reports",
    ttlDays: null,
    quotaBytes: 0.5 * GB,
    timeColumn: "evaluated_at",
  },
  {
    table: "fundamental_model_events",
    ttlDays: null,
    quotaBytes: 0.1 * GB,
    timeColumn: "at",
  },
  {
    table: "fundamental_calibration_reports",
    ttlDays: null,
    quotaBytes: 0.5 * GB,
    timeColumn: "generated_at",
  },
  {
    table: "strategy_decisions",
    ttlDays: 180,
    quotaBytes: 1 * GB,
    timeColumn: "received_at",
  },
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
  ].map((table): Omit<RetentionTableConfig, "protected"> => ({
    table,
    ttlDays: null,
    quotaBytes: 0.5 * GB,
    timeColumn: "received_at",
  })),
];

// The declared budgets/TTLs remain monitoring baselines. DATA-02 holds the
// economic/gate chains and raw evidence until horizons and pins are established.
export const RETENTION_TABLES: readonly RetentionTableConfig[] =
  RETENTION_DECLARATIONS.map((config) => ({
    ...config,
    protected: getRetentionProtection(config.table).protected,
  }));

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
  /**
   * RFC-020 D4.4: how many steps of this run logged RETENTION_STEP_FAILED.
   * The run used to report success no matter what failed inside it, so a boot
   * that lost the race with postgres — 100 RETENTION_STEP_FAILED on
   * 2026-09-02 — looked exactly like a clean run to the caller, and the next
   * attempt was 24 h away. A caller cannot reschedule what it cannot see.
   */
  readonly failedSteps: number;
  /** Physical bytes across the retention tables; never shrinks on DELETE. */
  readonly totalBytes: number;
  /** Estimated live bytes; not a measurement of reclaimable storage. */
  readonly totalLiveBytes: number;
}

export interface RetentionJobDeps {
  readonly pool: RetentionQueryPool;
  readonly clock: () => Date;
  readonly budgetBytes?: number;
  readonly tables?: readonly RetentionTableConfig[];
  /** Legacy compatibility only: this job cannot delete rows. */
  readonly batchSize?: number;
  /** Legacy compatibility only: this job cannot delete rows. */
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

export interface TableSize {
  /** Physical bytes on disk (pg_total_relation_size): never shrinks on DELETE. */
  readonly bytes: number;
  /** Estimated live footprint from catalog statistics (see measureTableSizes). */
  readonly liveBytes: number;
  readonly reltuples: number;
  /** Best available live row count (pg_stat, falling back to reltuples). */
  readonly liveRows: number;
}

/**
 * Catalog read behind every size measurement in this module.
 *
 * One statement for the whole list, not one per table: the read API renders
 * the same numbers on every dashboard poll, and 37 round trips would not fit
 * the API pool's 1s statement_timeout. Measured in production 2026-09-01:
 * all 74 tables in 16 ms.
 */
const TABLE_SIZE_SQL = `SELECT c.relname AS table_name,
              pg_total_relation_size(c.oid)::bigint AS bytes,
              c.reltuples::float8 AS reltuples,
              s.n_live_tup::bigint AS live_tup,
              s.n_dead_tup::bigint AS dead_tup,
              ts.n_live_tup::bigint AS toast_live_tup,
              w.heap_width,
              ix.index_count,
              ix.index_key_width
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
         LEFT JOIN pg_stat_all_tables ts ON ts.relid = c.reltoastrelid
         LEFT JOIN LATERAL (
           SELECT sum(st.avg_width)::float8 AS heap_width
             FROM pg_stats st
            WHERE st.schemaname = n.nspname AND st.tablename = c.relname
         ) w ON true
         LEFT JOIN LATERAL (
           SELECT count(DISTINCT i.indexrelid)::float8 AS index_count,
                  COALESCE(sum(st.avg_width), 0)::float8 AS index_key_width
             FROM pg_index i
             CROSS JOIN LATERAL unnest(i.indkey::int2[]) AS k(attnum)
             LEFT JOIN pg_attribute a
               ON a.attrelid = c.oid AND a.attnum = k.attnum
             LEFT JOIN pg_stats st
               ON st.schemaname = n.nspname
              AND st.tablename = c.relname
              AND st.attname = a.attname
            WHERE i.indrelid = c.oid AND i.indisvalid
         ) ix ON true
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND c.relname = ANY($1::text[])`;

/**
 * Physical bytes and estimated live footprint, in one catalog read shared by
 * the quota alarm and the read API's `budget_used_pct` (RFC-015 §9).
 *
 * With column statistics, the estimate uses:
 *   liveRows x (heap width + tuple overhead)
 * + liveRows x (index keys + entry overhead) / assumed leaf fill
 * + live TOAST chunks x assumed chunk size.
 *
 * Statistics may lag writes/deletes. Missing width statistics fall back to the
 * physical size discounted by the live-tuple fraction; with no usable tuple
 * statistics, the estimate falls back to physical bytes. These are monitoring
 * estimates, not exact counts or a prediction of space a rewrite can reclaim.
 * Physical minus estimated live bytes does not prove recoverable storage.
 * Absent catalog tables remain absent from the map for callers to handle.
 */
export async function measureTableSizes(
  pool: { query: SqlExecutor["query"] },
  tables: readonly string[],
): Promise<Map<string, TableSize>> {
  const sizes = new Map<string, TableSize>();
  if (tables.length === 0) {
    return sizes;
  }
  const result = await pool.query<{
    table_name: string;
    bytes: string | number | null;
    reltuples: string | number | null;
    live_tup: string | number | null;
    dead_tup: string | number | null;
    toast_live_tup: string | number | null;
    heap_width: string | number | null;
    index_count: string | number | null;
    index_key_width: string | number | null;
  }>(TABLE_SIZE_SQL, [[...tables]]);
  for (const row of result.rows) {
    const bytes = Number(row.bytes ?? 0);
    const reltuples = Math.max(Number(row.reltuples ?? 0), 0);
    const liveTup = Math.max(Number(row.live_tup ?? 0), 0);
    const deadTup = Math.max(Number(row.dead_tup ?? 0), 0);
    const totalTup = liveTup + deadTup;
    const liveRows = liveTup > 0 ? liveTup : reltuples;
    const heapWidth = Number(row.heap_width ?? 0);
    let liveBytes: number;
    if (Number.isFinite(heapWidth) && heapWidth > 0) {
      const indexCount = Math.max(Number(row.index_count ?? 0), 0);
      const indexKeyWidth = Math.max(Number(row.index_key_width ?? 0), 0);
      const toastLiveTup = Math.max(Number(row.toast_live_tup ?? 0), 0);
      const perRow =
        heapWidth +
        HEAP_TUPLE_OVERHEAD +
        (indexKeyWidth + indexCount * INDEX_TUPLE_OVERHEAD) / BTREE_LEAF_FILL;
      liveBytes = liveRows * perRow + toastLiveTup * TOAST_CHUNK_BYTES;
    } else if (Number.isFinite(totalTup) && totalTup > 0) {
      liveBytes = (bytes * liveTup) / totalTup;
    } else {
      liveBytes = bytes;
    }
    sizes.set(row.table_name, { bytes, liveBytes, reltuples, liveRows });
  }
  return sizes;
}

/**
 * The old scheduler has no execution authorization, manifest, or coordinated
 * pin transaction. It therefore only measures catalogs and reports holds.
 * Even a future dry-run candidate or a caller's `protected: false` cannot turn
 * this job back into a pruner. No application rows are read or changed here.
 */
export function createRetentionJob(deps: RetentionJobDeps): RetentionJob {
  const budgetBytes = deps.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  const tables = [
    ...new Map(
      (deps.tables ?? RETENTION_TABLES).map((config) => [config.table, config]),
    ).values(),
  ];

  return {
    async runOnce(): Promise<RetentionRunReport> {
      // Keep failure accounting local to this run, including overlapping runs.
      let failedSteps = 0;
      let totalBytes = 0;
      let totalLiveBytes = 0;
      let sizes = new Map<string, TableSize>();
      let measured = false;
      const skipped: RetentionSkip[] = [];
      try {
        sizes = await measureTableSizes(
          deps.pool,
          tables.map((config) => config.table),
        );
        measured = true;
      } catch (error: unknown) {
        failedSteps += 1;
        log(
          "error",
          "RETENTION_STEP_FAILED",
          "polymarket_retention_size_failed",
          {
            ...errorFields(error),
            detail: error instanceof Error ? error.message : undefined,
            table_count: tables.length,
          },
        );
      }

      for (const config of tables) {
        const protection = getRetentionProtection(config.table);
        const reason = protection.protected
          ? protection.reason
          : "legacy_job_monitor_only";
        skipped.push({ table: config.table, reason });
        const size = sizes.get(config.table);
        if (measured && size === undefined) {
          failedSteps += 1;
          log(
            "error",
            "RETENTION_STEP_FAILED",
            "polymarket_retention_table_missing",
            {
              table: config.table,
            },
          );
        }
        totalBytes += size?.bytes ?? 0;
        totalLiveBytes += size?.liveBytes ?? 0;
        const quotaAlarm =
          size !== undefined &&
          size.liveBytes >= config.quotaBytes * QUOTA_TRIGGER_RATIO;
        log(
          quotaAlarm ? "warn" : "info",
          "RETENTION_PROTECTED",
          "polymarket_retention_protected",
          {
            table: config.table,
            reason,
            policy_version: RETENTION_POLICY_VERSION,
            quota_alarm: quotaAlarm,
            capacity_action: quotaAlarm ? "review_required" : null,
            quota_bytes: config.quotaBytes,
            declared_ttl_days: config.ttlDays,
            effective_ttl_days: null,
            live_bytes_estimate:
              size === undefined ? null : Math.round(size.liveBytes),
            physical_bytes: size?.bytes ?? null,
            mutation_enabled: false,
          },
        );
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
            capacity_action: "review_required",
            policy_version: RETENTION_POLICY_VERSION,
            mutation_enabled: false,
          },
        );
      }
      if (totalBytes > totalLiveBytes) {
        log(
          "info",
          "RETENTION_STORAGE_ESTIMATE_GAP",
          "polymarket_retention_storage_estimate_gap",
          {
            physical_bytes: totalBytes,
            live_bytes_estimate: Math.round(totalLiveBytes),
            difference_bytes: Math.round(totalBytes - totalLiveBytes),
            recoverable_bytes: null,
          },
        );
      }
      return {
        actions: [],
        skipped,
        globalAlarm,
        failedSteps,
        totalBytes,
        totalLiveBytes,
      };
    },
  };
}
