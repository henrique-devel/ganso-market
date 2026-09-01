// RFC-015: the operator dashboard's two read surfaces.
//
//   GET /polymarket/overview        one call in place of the ~11 the panel
//                                   used to make per cycle
//   GET /polymarket/events?after=   an append-only feed over tables that
//                                   already exist — no migration
//
// Both are SELECT-only and sit behind the RFC-002 bearer auth like every other
// read surface. Nothing here creates an order, a signal or a config version.
//
// THE CONSTRAINT THAT SHAPES THIS FILE: the API pool runs with
// `statement_timeout = 1000 ms` (config/runtime.json `connect_timeout_ms`,
// which database.ts reuses as the query timeout; every worker overrides it,
// the API does not). A single seq scan blows the whole response — that is
// exactly how GET /polymarket/decisions produced its 500 on 2026-08-31
// (RFC-015 §3). So every query below is either an index lookup, a small
// aggregate, or a catalog read, and the measured cost of each is recorded next
// to it.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { DatabasePool } from "../database.js";
import { resolveGitSha } from "./fundamental/provenance.js";
import { SIMULATION_BANNER } from "./paper/runner.js";
import {
  DEFAULT_BUDGET_BYTES,
  RETENTION_TABLES,
  measureTableSizes,
} from "./retention.js";

type Row = Record<string, unknown>;

export interface OverviewRoutesDeps {
  readonly pool: Pick<DatabasePool, "query">;
  readonly authService: {
    session(token: string): Promise<{ status: string }>;
  };
  readonly clock?: () => Date;
  /** Test seam: the running revision, normally read from the release file. */
  readonly gitSha?: () => Promise<string | null>;
}

/** Drawdown that puts the portfolio in HALTED — drawn as the bar's end. */
export const DRAWDOWN_LIMIT = 0.1;

/** Hard cap on one events page, whatever the caller asks for. */
export const EVENTS_MAX_LIMIT = 200;
export const EVENTS_DEFAULT_LIMIT = 60;

/**
 * How far back a first load (no cursor) may look, per source, in ids.
 *
 * A first load has no cursor to start from and must not scan a whole table to
 * find the tail. Every source here is append-only with a monotonic identity
 * key, so `id > max(id) - LOOKBACK` is a range scan on the primary key and
 * costs the same whether the table holds 200 thousand rows or 20 million.
 * Sources whose interesting rows are rare (ACCEPTED decisions: 262 of 234.571)
 * need the window wide enough to actually contain some.
 */
const FIRST_LOAD_LOOKBACK = 50_000;

function jsonError(
  reply: FastifyReply,
  statusCode: number,
  reasonCode: string,
): FastifyReply {
  return reply
    .code(statusCode)
    .send({ reason_code: reasonCode, correlation_id: reply.request.id });
}

function logOverviewError(reasonCode: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      service: "api",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      error_name: error instanceof Error ? error.name : "UnknownError",
    })}\n`,
  );
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}

function num(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function int(value: unknown): number {
  return Math.round(num(value) ?? 0);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return str(value);
}

// ---------------------------------------------------------------------------
// The event feed
// ---------------------------------------------------------------------------

/**
 * One append-only source of the feed.
 *
 * `idColumn` must be monotonic and unique within the source — every source
 * below uses a `GENERATED ALWAYS AS IDENTITY` primary key, so "greater than the
 * last id I saw" can neither skip nor repeat a row. That is the whole reason
 * the cursor is per-source instead of a single global instant: two sources
 * writing in the same millisecond would make a timestamp cursor drop one of
 * them, and the drop would be silent.
 */
interface EventSource {
  readonly key: string;
  readonly kind: string;
  readonly table: string;
  readonly idColumn: string;
  readonly sql: string;
  readonly severity: (row: Row) => "info" | "warn" | "alert";
  readonly summary: (row: Row) => string;
}

/**
 * Keyset page for one source: rows strictly after `id`, oldest first, capped.
 *
 * `$1` is the cursor (null on a first load), `$2` the limit. When the cursor is
 * null the query falls back to the id lookback window described above.
 */
function source(
  spec: Omit<EventSource, "sql">,
  tsColumn: string,
  columns: string,
  where = "TRUE",
): EventSource {
  return {
    ...spec,
    sql: `SELECT ${spec.idColumn} AS event_id, ${tsColumn} AS occurred_at, ${columns}
            FROM ${spec.table}
           WHERE ${where}
             AND ${spec.idColumn} > COALESCE(
                   $1::bigint,
                   (SELECT COALESCE(MAX(${spec.idColumn}), 0) - ${String(FIRST_LOAD_LOOKBACK)}
                      FROM ${spec.table}))
           ORDER BY ${spec.idColumn} ASC
           LIMIT $2::int`,
  };
}

const EVENT_SOURCES: readonly EventSource[] = [
  source(
    {
      key: "estado",
      kind: "PORTFOLIO_STATE",
      table: "portfolio_state_events",
      idColumn: "state_event_id",
      severity: (row) => (row["to_state"] === "NORMAL" ? "info" : "alert"),
      summary: (row) =>
        `${str(row["from_state"]) ?? "?"} \u2192 ${str(row["to_state"]) ?? "?"}`,
    },
    "at",
    "from_state, to_state, reason, trigger_source",
  ),
  source(
    {
      key: "decisao",
      kind: "DECISION",
      table: "portfolio_decisions",
      idColumn: "decision_id",
      severity: () => "info",
      summary: (row) =>
        `${str(row["decision_kind"]) ?? "?"} ${str(row["market_side"]) ?? "?"}` +
        ` \u00b7 ${str(row["size_shares"]) ?? "?"} cotas`,
    },
    "decision_ts",
    "decision_kind, condition_id, token_id, market_side, size_shares," +
      " edge_net, outcome, binding_constraint",
    // ACCEPTED only. 234.549 of 234.571 decisions are ENTRY/REJECTED — a feed
    // carrying them would be a firehose of "nothing happened" and would bury
    // the 262 rows where something did.
    "outcome = 'ACCEPTED'",
  ),
  source(
    {
      key: "ordem",
      kind: "PAPER_LEDGER",
      table: "paper_ledger_events",
      idColumn: "event_id",
      severity: (row) =>
        row["event_type"] === "kill_switch_engaged"
          ? "alert"
          : row["event_type"] === "fill_denied_degradation" ||
              row["event_type"] === "order_rejected"
            ? "warn"
            : "info",
      summary: (row) => str(row["event_type"]) ?? "?",
    },
    "event_ts",
    "event_type, order_id, token_id, condition_id",
    // Everything except `mark`, which is 6.205 of the 6.236 rows and is the
    // position marker running on a timer — not something that happened.
    "event_type <> 'mark'",
  ),
  source(
    {
      key: "disjuntor",
      kind: "CIRCUIT_BREAKER",
      table: "portfolio_circuit_breakers",
      idColumn: "breaker_id",
      severity: (row) => (row["ended_at"] === null ? "warn" : "info"),
      summary: (row) =>
        `${str(row["kind"]) ?? "?"}${
          row["ended_at"] === null ? " (aberto)" : " (fechado)"
        }`,
    },
    "started_at",
    "kind, scope, condition_id, token_id, ended_at",
  ),
  source(
    {
      key: "violacao",
      kind: "GRAPH_VIOLATION",
      table: "graph_violations",
      idColumn: "violation_id",
      severity: (row) => (row["ended_at"] === null ? "alert" : "info"),
      summary: (row) =>
        `${str(row["kind"]) ?? "?"} ${str(row["edge_key"]) ?? ""}`,
    },
    "started_at",
    "kind, edge_key, magnitude_bps, suppressed, ended_at",
  ),
  source(
    {
      key: "divergencia",
      kind: "LAYER_DIVERGENCE",
      table: "resolution_layer_divergences",
      idColumn: "divergence_id",
      severity: (row) => (row["position_held"] === true ? "alert" : "warn"),
      summary: (row) => str(row["direction"]) ?? "?",
    },
    "started_at",
    "condition_id, direction, position_held, ended_at",
  ),
  source(
    {
      key: "veto",
      kind: "SANITY_VETO",
      table: "graph_sanity_vetoes",
      idColumn: "veto_id",
      severity: (row) => (row["ended_at"] === null ? "warn" : "info"),
      summary: (row) =>
        `${str(row["kind"]) ?? "?"} ${str(row["edge_key"]) ?? ""}`,
    },
    "started_at",
    "condition_id, token_id, kind, edge_key, magnitude, ended_at",
  ),
  source(
    {
      key: "g2",
      kind: "G2_CLOCK",
      table: "portfolio_g2_clock_events",
      idColumn: "clock_event_id",
      severity: () => "warn",
      summary: (row) =>
        `${str(row["category"]) ?? "?"}: ${str(row["reason"]) ?? "?"}`,
    },
    "at",
    "category, previous_start, new_start, reason",
  ),
];

const SOURCE_KEYS = new Set(EVENT_SOURCES.map((source) => source.key));

export interface FeedEvent {
  readonly source: string;
  readonly kind: string;
  readonly event_id: number;
  readonly occurred_at: string | null;
  readonly severity: "info" | "warn" | "alert";
  readonly summary: string;
  readonly detail: Row;
}

/**
 * Parse `fonte:id,fonte:id,…`.
 *
 * Unknown source names and unparseable ids are DROPPED, not rejected: a cursor
 * survives a deploy that adds or removes a source, and the worst case is that
 * the new source replays its lookback window once. Rejecting would strand a
 * client on a cursor it cannot advance past.
 */
export function parseEventCursor(raw: string | null): Map<string, number> {
  const cursor = new Map<string, number>();
  if (raw === null || raw === "") {
    return cursor;
  }
  for (const part of raw.split(",")) {
    const [key, value] = part.split(":");
    if (key === undefined || value === undefined || !SOURCE_KEYS.has(key)) {
      continue;
    }
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      cursor.set(key, parsed);
    }
  }
  return cursor;
}

export function formatEventCursor(cursor: ReadonlyMap<string, number>): string {
  return EVENT_SOURCES.flatMap((source) => {
    const id = cursor.get(source.key);
    return id === undefined ? [] : [`${source.key}:${String(id)}`];
  }).join(",");
}

// ---------------------------------------------------------------------------

export function registerOverviewRoutes(
  app: FastifyInstance,
  deps: OverviewRoutesDeps,
): void {
  const pool = deps.pool;
  const clock = deps.clock ?? (() => new Date());
  const gitSha = deps.gitSha ?? (() => resolveGitSha());

  async function guard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = bearerToken(request);
    if (token === null) {
      await jsonError(reply, 401, "MISSING_BEARER_TOKEN");
      return;
    }
    const session = await deps.authService.session(token);
    if (session.status !== "ok") {
      await jsonError(reply, 401, "INVALID_SESSION");
    }
  }

  // -------------------------------------------------------------------------
  // GET /polymarket/overview
  // -------------------------------------------------------------------------
  app.get(
    "/polymarket/overview",
    { preHandler: guard },
    async (_request, reply) => {
      try {
        const now = clock();
        const [
          state,
          breakers,
          killSwitch,
          gates,
          collection,
          model,
          resolution,
          paper,
          sizes,
          sha,
        ] = await Promise.all([
          // Single row by primary key.
          pool.query<Row>(
            `SELECT state, reason, bankroll_usd, high_water_mark_usd,
                    equity_usd, drawdown, realized_pnl_day_usd,
                    realized_pnl_week_usd, day_bucket, week_start,
                    reduce_only_until, halted_at, manual_halt, config_version,
                    updated_at
               FROM portfolio_state WHERE portfolio_id = 1`,
          ),
          pool.query<Row>(
            `SELECT COUNT(*)::int AS abertos,
                    COUNT(*) FILTER (
                      WHERE started_at > $1::timestamptz - INTERVAL '1 hour'
                    )::int AS ultima_hora,
                    MAX(started_at) AS mais_recente
               FROM portfolio_circuit_breakers
              WHERE ended_at IS NULL`,
            [now],
          ),
          pool.query<Row>(
            `SELECT engaged, reason, engaged_at, rearmed_at,
                    jsonb_array_length(COALESCE(frozen_markets_json, '[]'::jsonb))
                      AS frozen_count
               FROM paper_kill_switch WHERE kill_switch_id = 1`,
          ),
          // DISTINCT ON over 984 rows.
          pool.query<Row>(
            `SELECT DISTINCT ON (gate)
                    gate, status, reason_code, measured_at
               FROM portfolio_gate_measurements
              ORDER BY gate, measured_at DESC`,
          ),
          // Measured 2026-09-01: 1.8 ms / 27 ms / 74 ms respectively.
          pool.query<Row>(
            `SELECT
               (SELECT MAX(received_at) FROM polymarket_book_deltas
                 WHERE received_at > $1::timestamptz - INTERVAL '10 minutes')
                 AS ultimo_delta,
               (SELECT COUNT(*)::int FROM polymarket_data_gaps
                 WHERE gap_end IS NULL) AS gaps_abertos,
               (SELECT COUNT(*)::int FROM polymarket_data_gaps
                 WHERE gap_start > $1::timestamptz - INTERVAL '24 hours')
                 AS gaps_24h,
               (SELECT COUNT(*)::int FROM (
                  SELECT DISTINCT ON (condition_id) action
                    FROM polymarket_universe_log
                   ORDER BY condition_id, at DESC) u
                 WHERE u.action = 'enter') AS universo`,
            [now],
          ),
          pool.query<Row>(
            `SELECT
               (SELECT COUNT(*)::int FROM fundamental_estimates
                 WHERE decision_ts > $1::timestamptz - INTERVAL '1 hour')
                 AS estimativas_1h,
               (SELECT MAX(decision_ts) FROM fundamental_estimates)
                 AS ultima_estimativa,
               (SELECT COUNT(*)::int FROM fundamental_models
                 WHERE status = 'active') AS modelos_ativos,
               (SELECT COUNT(*)::int FROM fundamental_models
                 WHERE status = 'shadow') AS modelos_shadow`,
            [now],
          ),
          pool.query<Row>(
            `SELECT
               (SELECT COUNT(*)::int FROM resolution_market_state) AS mercados,
               (SELECT COUNT(*)::int FROM resolution_market_state
                 WHERE effective_action IN ('VETO', 'CIRCUIT_BREAKER'))
                 AS bloqueados,
               (SELECT COUNT(*)::int FROM resolution_market_state
                 WHERE effective_action = 'BUFFER') AS com_buffer,
               (SELECT COUNT(*)::int FROM graph_violations
                 WHERE ended_at IS NULL AND NOT suppressed) AS violacoes,
               (SELECT COUNT(*)::int FROM resolution_layer_divergences
                 WHERE ended_at IS NULL) AS divergencias`,
          ),
          pool.query<Row>(
            `SELECT
               (SELECT COUNT(*)::int FROM paper_orders
                 WHERE status = 'open') AS ordens_abertas,
               (SELECT COUNT(*)::int FROM paper_positions
                 WHERE shares::numeric <> 0) AS posicoes,
               (SELECT COUNT(*)::int FROM paper_ledger_events
                 WHERE event_type = 'fill'
                   AND occurred_at > $1::timestamptz - INTERVAL '24 hours')
                 AS fills_24h`,
            [now],
          ),
          // 74 tables in one catalog read: 16 ms measured.
          measureTableSizes(
            pool,
            RETENTION_TABLES.map((config) => config.table),
          ),
          gitSha(),
        ]);

        const stateRow = state.rows[0] ?? null;
        const gateRows = gates.rows;
        const blocked =
          gateRows.length === 0 ||
          gateRows.some((row) => row["status"] !== "PASS");

        let liveBytes = 0;
        let physicalBytes = 0;
        for (const config of RETENTION_TABLES) {
          const size = sizes.get(config.table);
          liveBytes += size?.liveBytes ?? 0;
          physicalBytes += size?.bytes ?? 0;
        }

        const lastDelta = iso(collection.rows[0]?.["ultimo_delta"]);
        return await reply.send({
          simulation: SIMULATION_BANNER,
          generated_at: now.toISOString(),
          // The panel compares this against the sha its bundle was built from
          // and tells the operator to reload when they differ. On 2026-08-31 a
          // stale bundle made the rearm button look broken for an hour.
          release_sha: sha,
          portfolio: stateRow,
          circuit_breakers: {
            open: int(breakers.rows[0]?.["abertos"]),
            opened_last_hour: int(breakers.rows[0]?.["ultima_hora"]),
            most_recent_at: iso(breakers.rows[0]?.["mais_recente"]),
          },
          kill_switch: killSwitch.rows[0] ?? null,
          rfc_009_status: blocked ? "BLOCKED" : "READY_FOR_OWNER_REVIEW",
          gates: gateRows,
          collection: {
            last_book_delta_at: lastDelta,
            last_book_delta_age_ms:
              lastDelta === null
                ? null
                : now.getTime() - new Date(lastDelta).getTime(),
            open_gaps: int(collection.rows[0]?.["gaps_abertos"]),
            gaps_24h: int(collection.rows[0]?.["gaps_24h"]),
            universe_members: int(collection.rows[0]?.["universo"]),
          },
          model: {
            estimates_last_hour: int(model.rows[0]?.["estimativas_1h"]),
            last_estimate_at: iso(model.rows[0]?.["ultima_estimativa"]),
            active_models: int(model.rows[0]?.["modelos_ativos"]),
            shadow_models: int(model.rows[0]?.["modelos_shadow"]),
          },
          resolution: {
            markets: int(resolution.rows[0]?.["mercados"]),
            blocked: int(resolution.rows[0]?.["bloqueados"]),
            buffered: int(resolution.rows[0]?.["com_buffer"]),
            open_violations: int(resolution.rows[0]?.["violacoes"]),
            open_divergences: int(resolution.rows[0]?.["divergencias"]),
          },
          paper: {
            open_orders: int(paper.rows[0]?.["ordens_abertas"]),
            positions: int(paper.rows[0]?.["posicoes"]),
            fills_24h: int(paper.rows[0]?.["fills_24h"]),
          },
          storage: {
            basis: "bytes vivos da lista de retenção",
            budget_bytes: DEFAULT_BUDGET_BYTES,
            live_bytes: Math.round(liveBytes),
            physical_bytes: physicalBytes,
            bloat_bytes: Math.max(Math.round(physicalBytes - liveBytes), 0),
            budget_used_pct:
              Math.round((liveBytes / DEFAULT_BUDGET_BYTES) * 10_000) / 100,
          },
          limits: { drawdown_limit: DRAWDOWN_LIMIT },
        });
      } catch (error) {
        logOverviewError("OVERVIEW_API_FAILED", error);
        return jsonError(reply, 500, "OVERVIEW_API_FAILED");
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /polymarket/events?after=<cursor>&limit=<n>
  // -------------------------------------------------------------------------
  app.get(
    "/polymarket/events",
    { preHandler: guard },
    async (request, reply) => {
      try {
        const query = (request.query ?? {}) as Record<string, unknown>;
        const rawLimit = num(query["limit"]);
        const limit =
          rawLimit === null
            ? EVENTS_DEFAULT_LIMIT
            : Math.min(Math.max(Math.trunc(rawLimit), 1), EVENTS_MAX_LIMIT);
        const cursor = parseEventCursor(str(query["after"]));

        // Per source, so one slow or empty source never delays the others and a
        // source added later cannot shift another source's cursor.
        const perSource = await Promise.all(
          EVENT_SOURCES.map(async (feedSource) => {
            const after = cursor.get(feedSource.key) ?? null;
            const [rows, head] = await Promise.all([
              pool.query<Row>(feedSource.sql, [after, limit]),
              // A source that returns nothing still needs a floor, or the next
              // poll would replay its whole lookback window every 5 seconds.
              // MAX over an identity primary key is an index lookup.
              after === null
                ? pool.query<Row>(
                    `SELECT COALESCE(MAX(${feedSource.idColumn}), 0) AS head
                     FROM ${feedSource.table}`,
                  )
                : Promise.resolve({ rows: [] as Row[], rowCount: 0 }),
            ]);
            return {
              feedSource,
              rows: rows.rows,
              head: head.rows.length === 0 ? null : int(head.rows[0]?.["head"]),
            };
          }),
        );

        const events: FeedEvent[] = [];
        const nextCursor = new Map<string, number>(cursor);
        for (const { feedSource, rows, head } of perSource) {
          for (const row of rows) {
            const { event_id: _id, occurred_at: _at, ...detail } = row;
            events.push({
              source: feedSource.key,
              kind: feedSource.kind,
              event_id: int(row["event_id"]),
              occurred_at: iso(row["occurred_at"]),
              severity: feedSource.severity(row),
              summary: feedSource.summary(row),
              detail,
            });
          }
          // On a first load the floor is the newest id the source HAS, not the
          // newest one this page returned: the page caps at `limit` and the rows
          // it dropped are OLDER, so resuming from the last returned id would
          // hand them back forever. With a cursor there is no truncation to hide
          // from — the page moves forward and the last returned id is the floor.
          const lastReturned = rows.at(-1);
          if (head !== null) {
            nextCursor.set(feedSource.key, head);
          } else if (lastReturned !== undefined) {
            nextCursor.set(feedSource.key, int(lastReturned["event_id"]));
          }
        }

        // Newest first for display; the cursor is what guarantees completeness,
        // so the display order is free to be the useful one.
        events.sort((left, right) =>
          (right.occurred_at ?? "").localeCompare(left.occurred_at ?? ""),
        );

        return await reply.send({
          simulation: SIMULATION_BANNER,
          generated_at: clock().toISOString(),
          events: events.slice(0, limit),
          page: {
            limit,
            cursor: str(query["after"]),
            next_cursor: formatEventCursor(nextCursor),
          },
        });
      } catch (error) {
        logOverviewError("EVENTS_API_FAILED", error);
        return jsonError(reply, 500, "EVENTS_API_FAILED");
      }
    },
  );
}
