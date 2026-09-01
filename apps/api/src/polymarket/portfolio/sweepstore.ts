// RFC-017 persistence: reading only, and provably.
//
// Two properties this file has to guarantee, both measured rather than assumed:
//
// STREAMING. `loadRecentDecisions` takes a LIMIT and holds every row it read.
// The window it serves (50 rows for the hourly audit) fits anywhere; the window
// a sweep needs does not. Measured 2026-09-01: 221 092 rows averaging 645 B of
// `book_json` plus 2157 B of `inputs_json` — about 620 MB of JSON against the
// api container's `mem_limit` of 384 MiB. So the sweep pulls a keyset page at a
// time, ordered by `decision_id ASC`, and the caller keeps only aggregates.
//
// READ-ONLY BY CONSTRUCTION. Not by convention, and not by reviewing the
// queries below: the pool this module is handed is wrapped so that a statement
// which is not a SELECT is refused before it reaches PostgreSQL, and each read
// runs inside its own `SET TRANSACTION READ ONLY`. Either alone would be a door
// with one lock.

import type { DatabasePool } from "../../database.js";
import type { PortfolioConfig } from "./config.js";
import { DECISION_COLUMNS, decisionFromRow } from "./gatestore.js";
import type { PersistedDecision } from "./replay.js";
import type { ShadowEstimate, Label } from "./sourcereplay.js";
import type { PortfolioPool } from "./types.js";

export class ReadOnlyViolation extends Error {
  public readonly reasonCode = "READ_ONLY_VIOLATION";

  public constructor(statement: string) {
    super(`refused a statement that is not a read: ${statement.slice(0, 120)}`);
    this.name = "ReadOnlyViolation";
  }
}

/**
 * Statements this tool is allowed to send.
 *
 * An allowlist, not a denylist of dangerous words: a denylist has to anticipate
 * every way to write a mutation, and gets that wrong exactly once. A CTE is
 * permitted because the queries below use one, and a writable CTE
 * (`WITH x AS (INSERT ...)`) is caught by the second clause.
 */
const READ_PREFIX = /^\s*(select|with)\b/i;
const WRITE_ANYWHERE =
  /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|merge|vacuum|refresh)\b/i;

/**
 * Wrap a pool so it can only read. Both locks, on every statement.
 *
 * Lock one is the allowlist above, which is a string check and therefore only as
 * good as its regex. Lock two is `SET TRANSACTION READ ONLY`, issued as the
 * first statement inside each read's own transaction, which makes the SERVER
 * refuse the write (SQLSTATE 25006) and does not depend on this file being
 * right.
 *
 * Per-statement rather than per-session on purpose: `pool.query` checks out
 * whichever connection is free, so a session-level `SET` would apply to one
 * connection of the pool and silently not to the next. A transaction is bound to
 * one client for its whole life, so the guarantee travels with the statement it
 * guards.
 */
export function readOnlyPool(pool: DatabasePool): PortfolioPool {
  return {
    async query<R extends Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ) {
      if (!READ_PREFIX.test(text) || WRITE_ANYWHERE.test(text)) {
        throw new ReadOnlyViolation(text);
      }
      return pool.transaction(async (tx) => {
        await tx.query("SET TRANSACTION READ ONLY");
        return tx.query<R>(text, params);
      });
    },
  };
}

export interface DecisionWindow {
  readonly from: Date | null;
  readonly to: Date | null;
  readonly kinds: readonly string[] | null;
  readonly batchSize: number;
}

/** What the log actually holds, printed as provenance before anything runs. */
export interface WindowSummary {
  readonly rows: number;
  readonly markets: number;
  readonly oldest: Date | null;
  readonly newest: Date | null;
  readonly minDecisionId: number | null;
  readonly maxDecisionId: number | null;
  readonly configVersions: readonly string[];
}

function windowClause(
  window: DecisionWindow,
  params: unknown[],
  extra: string,
): string {
  const clauses: string[] = [extra];
  if (window.from !== null) {
    params.push(window.from);
    clauses.push(`decision_ts >= $${String(params.length)}`);
  }
  if (window.to !== null) {
    params.push(window.to);
    clauses.push(`decision_ts <= $${String(params.length)}`);
  }
  if (window.kinds !== null && window.kinds.length > 0) {
    params.push([...window.kinds]);
    clauses.push(`decision_kind = ANY($${String(params.length)}::text[])`);
  }
  return clauses.join(" AND ");
}

export async function summarizeWindow(
  pool: PortfolioPool,
  window: DecisionWindow,
): Promise<WindowSummary> {
  const params: unknown[] = [];
  const where = windowClause(window, params, "TRUE");
  const result = await pool.query<Record<string, unknown>>(
    `SELECT count(*)::bigint AS rows,
            count(DISTINCT condition_id)::bigint AS markets,
            min(decision_ts) AS oldest, max(decision_ts) AS newest,
            min(decision_id)::bigint AS min_id, max(decision_id)::bigint AS max_id,
            array_agg(DISTINCT config_version) AS versions
       FROM portfolio_decisions
      WHERE ${where}`,
    params,
  );
  const row = result.rows[0] ?? {};
  const versions = row.versions;
  return {
    rows: Number(row.rows ?? 0),
    markets: Number(row.markets ?? 0),
    oldest: row.oldest instanceof Date ? row.oldest : null,
    newest: row.newest instanceof Date ? row.newest : null,
    minDecisionId:
      row.min_id === null || row.min_id === undefined
        ? null
        : Number(row.min_id),
    maxDecisionId:
      row.max_id === null || row.max_id === undefined
        ? null
        : Number(row.max_id),
    configVersions: Array.isArray(versions)
      ? versions.filter((v): v is string => typeof v === "string").sort()
      : [],
  };
}

/**
 * Walk the window one keyset page at a time.
 *
 * `decision_id > cursor ORDER BY decision_id ASC LIMIT n` rather than
 * `OFFSET`: an offset re-scans everything it skips, so a full pass over the
 * window would be quadratic, and a row inserted mid-pass would shift the
 * offsets. The primary key is the cursor, so a page is a range scan and the log
 * growing under us only means new rows arrive after the cursor.
 */
export async function streamDecisions(
  pool: PortfolioPool,
  window: DecisionWindow,
  onBatch: (batch: readonly PersistedDecision[]) => Promise<void> | void,
): Promise<number> {
  let cursor = 0;
  let total = 0;
  for (;;) {
    const params: unknown[] = [cursor];
    const where = windowClause(window, params, "decision_id > $1");
    params.push(window.batchSize);
    const result = await pool.query<Record<string, unknown>>(
      `SELECT ${DECISION_COLUMNS}
         FROM portfolio_decisions
        WHERE ${where}
        ORDER BY decision_id ASC
        LIMIT $${String(params.length)}`,
      params,
    );
    if (result.rows.length === 0) {
      return total;
    }
    const batch = result.rows.map(decisionFromRow);
    total += batch.length;
    cursor = batch[batch.length - 1]?.decisionId ?? cursor;
    await onBatch(batch);
    if (result.rows.length < window.batchSize) {
      return total;
    }
  }
}

/** The parameter sets the window names, by version. */
export async function loadConfigsForWindow(
  pool: PortfolioPool,
  versions: readonly string[],
  parse: (raw: unknown) => PortfolioConfig,
): Promise<Map<string, PortfolioConfig>> {
  const out = new Map<string, PortfolioConfig>();
  if (versions.length === 0) {
    return out;
  }
  const result = await pool.query<Record<string, unknown>>(
    `SELECT version, content_json
       FROM portfolio_config_versions
      WHERE version = ANY($1::text[])`,
    [[...new Set(versions)]],
  );
  for (const row of result.rows) {
    const content =
      typeof row.content_json === "string"
        ? (JSON.parse(row.content_json) as unknown)
        : row.content_json;
    try {
      out.set(String(row.version), parse(content));
    } catch {
      // Left out on purpose: the sweep then reports the decision as excluded
      // rather than silently comparing it against a different parameter set.
    }
  }
  return out;
}

/**
 * Shadow estimates as-of, for a page of decisions, in one round trip.
 *
 * Per-decision queries would be 19 768 of them for one pass. `DISTINCT ON` over
 * the page's (token, instant) pairs gives the newest eligible shadow row for
 * each in a single scan.
 *
 * The `<=` is the whole no-look-ahead guarantee at the SQL level, and the lower
 * bound is the engine's own `estimateMaxAgeMs`: a row older than that is one the
 * live engine would have refused as DATA_STALE, so admitting it here would be
 * measuring a decision the engine would never have made.
 */
export async function shadowEstimatesAsOf(
  pool: PortfolioPool,
  pairs: readonly { readonly tokenId: string; readonly at: Date }[],
  maxAgeMs: number,
): Promise<Map<string, ShadowEstimate>> {
  const out = new Map<string, ShadowEstimate>();
  if (pairs.length === 0) {
    return out;
  }
  const tokens = pairs.map((pair) => pair.tokenId);
  const instants = pairs.map((pair) => pair.at);
  const result = await pool.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (w.token_id, w.at)
            w.token_id, w.at, e.q, e.q_lo, e.q_hi, e.model_id, e.decision_ts
       FROM unnest($1::text[], $2::timestamptz[]) AS w(token_id, at)
       JOIN fundamental_estimates e
         ON e.token_id = w.token_id
        AND e.status = 'shadow'
        AND e.source = 'MODEL'
        AND e.decision_ts <= w.at
        AND e.decision_ts >= w.at - ($3::bigint * interval '1 millisecond')
      ORDER BY w.token_id, w.at, e.decision_ts DESC, e.estimate_id DESC`,
    [tokens, instants, Math.max(0, Math.round(maxAgeMs))],
  );
  for (const row of result.rows) {
    const at = row.at instanceof Date ? row.at : null;
    const decisionTs = row.decision_ts instanceof Date ? row.decision_ts : null;
    if (at === null || decisionTs === null) {
      continue;
    }
    out.set(`${String(row.token_id)}@${at.toISOString()}`, {
      q: String(row.q),
      qLo: String(row.q_lo),
      qHi: String(row.q_hi),
      modelId: String(row.model_id ?? ""),
      decisionTs,
    });
  }
  return out;
}

/** The key `shadowEstimatesAsOf` files each row under. */
export function shadowKey(tokenId: string, at: Date): string {
  return `${tokenId}@${at.toISOString()}`;
}

/** Final labels for a set of tokens. */
export async function labelsFor(
  pool: PortfolioPool,
  tokenIds: readonly string[],
): Promise<Map<string, Label>> {
  const out = new Map<string, Label>();
  if (tokenIds.length === 0) {
    return out;
  }
  const result = await pool.query<Record<string, unknown>>(
    `SELECT token_id, label, is_final
       FROM fundamental_labels
      WHERE token_id = ANY($1::text[])`,
    [[...new Set(tokenIds)]],
  );
  for (const row of result.rows) {
    out.set(String(row.token_id), {
      tokenId: String(row.token_id),
      label: String(row.label),
      isFinal: row.is_final === true,
    });
  }
  return out;
}

/**
 * Whether ANY fundamental model was promoted, ever.
 *
 * Mode B needs this to tell a legitimate MODEL-sourced decision from the leak:
 * with no model ever promoted, `estimate_source = 'MODEL'` can only have come
 * from a shadow row that `estimateAsOf` returned by accident.
 */
export async function anyModelPromoted(pool: PortfolioPool): Promise<boolean> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT count(*)::bigint AS n
       FROM fundamental_models
      WHERE status = 'active' OR promoted_at IS NOT NULL`,
  );
  return Number(result.rows[0]?.n ?? 0) > 0;
}

/** The shadow rows available in the window, for the provenance block. */
export async function shadowCoverage(
  pool: PortfolioPool,
  from: Date | null,
  to: Date | null,
): Promise<{
  readonly rows: number;
  readonly tokens: number;
  readonly oldest: Date | null;
  readonly newest: Date | null;
  readonly modelIds: readonly string[];
}> {
  const params: unknown[] = [];
  const clauses: string[] = ["status = 'shadow'", "source = 'MODEL'"];
  if (from !== null) {
    params.push(from);
    clauses.push(`decision_ts >= $${String(params.length)}`);
  }
  if (to !== null) {
    params.push(to);
    clauses.push(`decision_ts <= $${String(params.length)}`);
  }
  const result = await pool.query<Record<string, unknown>>(
    `SELECT count(*)::bigint AS rows, count(DISTINCT token_id)::bigint AS tokens,
            min(decision_ts) AS oldest, max(decision_ts) AS newest,
            array_agg(DISTINCT model_id) AS models
       FROM fundamental_estimates
      WHERE ${clauses.join(" AND ")}`,
    params,
  );
  const row = result.rows[0] ?? {};
  const models = row.models;
  return {
    rows: Number(row.rows ?? 0),
    tokens: Number(row.tokens ?? 0),
    oldest: row.oldest instanceof Date ? row.oldest : null,
    newest: row.newest instanceof Date ? row.newest : null,
    modelIds: Array.isArray(models)
      ? models.filter((m): m is string => typeof m === "string").sort()
      : [],
  };
}
