// RFC-007 read-only API over the Polymarket data foundation. Every endpoint
// is a SELECT (no trading, wallet, or order path); all endpoints sit behind
// the RFC-002 bearer-token auth. Prices/sizes/fees stay canonical decimal
// strings end to end; timestamps are returned as ISO 8601.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { DatabasePool } from "../database.js";
import { DEFAULT_BUDGET_BYTES } from "./retention.js";
import type { PriceLevel } from "./types.js";

// ---------------------------------------------------------------------------
// Contracts with the replay module (./replay.js, built separately). bookAt's
// signature is fixed by RFC-007; deltasPage's shape is the assumed contract
// documented in the integration notes. Both are injectable for tests and the
// real module is loaded lazily so this file builds before replay.ts lands.
// ---------------------------------------------------------------------------

export interface BookAtResult {
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
  readonly anchorReceivedAt: Date;
  readonly deltasApplied: number;
}

export type BookAtFn = (
  pool: DatabasePool,
  tokenId: string,
  at: Date,
  depth: number,
) => Promise<BookAtResult | null>;

export interface DeltasPageQuery {
  /** Inclusive lower bound on received_at (null: unbounded). */
  readonly from: Date | null;
  /** EXCLUSIVE upper bound on received_at (null: now). */
  readonly to: Date | null;
  readonly afterId: string | null;
  readonly limit: number;
}

export interface DeltaRow {
  readonly deltaId: string;
  readonly side: string;
  readonly price: string;
  readonly size: string;
  readonly sourceTs: Date | null;
  readonly receivedAt: Date | null;
}

export interface DeltasPageResult {
  readonly deltas: readonly DeltaRow[];
  readonly nextAfterId: string | null;
}

export type DeltasPageFn = (
  pool: DatabasePool,
  tokenId: string,
  query: DeltasPageQuery,
) => Promise<DeltasPageResult>;

// Real shapes exported by ./replay.js (positional args; ISO-string timestamps).
interface ReplayModule {
  readonly bookAt: (
    pool: { query: DatabasePool["query"] },
    tokenId: string,
    at: Date,
    depth?: number,
  ) => Promise<{
    readonly bids: readonly PriceLevel[];
    readonly asks: readonly PriceLevel[];
    readonly anchorReceivedAt: string;
    readonly deltasApplied: number;
  } | null>;
  readonly deltasPage: (
    pool: { query: DatabasePool["query"] },
    tokenId: string,
    from: Date,
    to: Date,
    afterId?: number,
    limit?: number,
  ) => Promise<{
    readonly deltas: ReadonlyArray<{
      readonly deltaId: number;
      readonly side: string;
      readonly price: string;
      readonly size: string;
      readonly sourceTs: string | null;
      readonly receivedAt: string;
    }>;
    readonly nextAfterId: number | null;
  }>;
}

let cachedReplayModule: ReplayModule | null = null;

async function loadReplayModule(): Promise<ReplayModule> {
  if (cachedReplayModule === null) {
    // Non-literal specifier on purpose: the replay module is developed in
    // parallel and this file must compile and test before it exists.
    const specifier = "./replay.js";
    cachedReplayModule = (await import(specifier)) as ReplayModule;
  }
  return cachedReplayModule;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface AuthSessionService {
  session(token: string): Promise<{ readonly status: string }>;
}

export interface PolymarketReadRoutesDeps {
  readonly pool: DatabasePool;
  readonly authService: AuthSessionService;
  /** Injected clock (defaults to the system clock). */
  readonly clock?: () => Date;
  /** Test seam: replaces ./replay.js bookAt. */
  readonly bookAtFn?: BookAtFn;
  /** Test seam: replaces ./replay.js deltasPage. */
  readonly deltasPageFn?: DeltasPageFn;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// RFC-007 budget, amended by the owner on 2026-08-25 (40 -> 110 GB). Imported
// so the reported budget and the pruning quota are the same number.
const STORAGE_BUDGET_BYTES = DEFAULT_BUDGET_BYTES;
const MARKETS_LIMIT = 500;
const SERIES_LIMIT = 10_000;
const RESOLUTION_EVENTS_LIMIT = 1_000;
const UNIVERSE_LIMIT = 5_000;
const TRADES_DEFAULT_LIMIT = 1_000;
const TRADES_MAX_LIMIT = 5_000;
const DELTAS_DEFAULT_LIMIT = 1_000;
const DELTAS_MAX_LIMIT = 5_000;

function jsonError(
  reply: FastifyReply,
  statusCode: number,
  reasonCode: string,
): FastifyReply {
  return reply
    .code(statusCode)
    .send({ reason_code: reasonCode, correlation_id: reply.request.id });
}

function logReadApiError(reasonCode: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      service: "polymarket-recorder",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      error_name: error instanceof Error ? error.name : "UnknownError",
      message: "polymarket_read_api_failed",
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

function queryParams(request: FastifyRequest): Record<string, unknown> {
  const query: unknown = request.query;
  return typeof query === "object" && query !== null
    ? (query as Record<string, unknown>)
    : {};
}

function stringParam(
  source: Record<string, unknown>,
  name: string,
): string | null {
  const value = source[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ISO 8601 date or date-time; anything else is rejected with 400.
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/;

function parseIsoTimestamp(value: string): Date | null {
  if (!ISO_TIMESTAMP_PATTERN.test(value)) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false };

/** Optional ISO timestamp query param: absent -> null, invalid -> not ok. */
function parseOptionalAt(
  source: Record<string, unknown>,
  name: string,
): Parsed<Date | null> {
  const raw = stringParam(source, name);
  if (raw === null) {
    return source[name] === undefined
      ? { ok: true, value: null }
      : { ok: false };
  }
  const parsed = parseIsoTimestamp(raw);
  return parsed === null ? { ok: false } : { ok: true, value: parsed };
}

/** Optional positive-integer query param, clamped into [min, max]. */
function parseClampedInt(
  source: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
  fallback: number,
): Parsed<number> {
  const raw = source[name];
  if (raw === undefined) {
    return { ok: true, value: fallback };
  }
  if (typeof raw !== "string" || !/^\d{1,10}$/.test(raw)) {
    return { ok: false };
  }
  return { ok: true, value: Math.min(max, Math.max(min, Number(raw))) };
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Row serializers (defensive: unexpected payloads become nulls, never throws
// that would surface as an unhandled 500).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function serializeMarket(row: Row): Row {
  return {
    condition_id: row["condition_id"] ?? null,
    question: row["question"] ?? null,
    slug: row["slug"] ?? null,
    category: row["category"] ?? null,
    neg_risk: row["neg_risk"] ?? null,
    clob_token_ids: row["clob_token_ids"] ?? null,
    rules: row["rules"] ?? null,
    rules_version: row["rules_version"] ?? null,
    tick_size: row["tick_size"] ?? null,
    min_order_size: row["min_order_size"] ?? null,
    fee_type: row["fee_type"] ?? null,
    end_date_iso: row["end_date_iso"] ?? null,
    active: row["active"] ?? null,
    closed: row["closed"] ?? null,
    source_ts: toIso(row["source_ts"]),
    received_at: toIso(row["received_at"]),
    updated_at: toIso(row["updated_at"]),
  };
}

function serializeRuleVersion(row: Row): Row {
  return {
    version: row["version"] ?? null,
    content_hash: row["content_hash"] ?? null,
    description: row["description"] ?? null,
    resolution_source: row["resolution_source"] ?? null,
    resolved_by: row["resolved_by"] ?? null,
    end_date: toIso(row["end_date"]),
    uma_end_date: toIso(row["uma_end_date"]),
    uma_bond: row["uma_bond"] ?? null,
    uma_reward: row["uma_reward"] ?? null,
    custom_liveness: row["custom_liveness"] ?? null,
    automatically_resolved: row["automatically_resolved"] ?? null,
    valid_from: toIso(row["valid_from"]),
    valid_to: toIso(row["valid_to"]),
    source_ts: toIso(row["source_ts"]),
    received_at: toIso(row["received_at"]),
  };
}

function serializeParamVersion(row: Row): Row {
  return {
    version: row["version"] ?? null,
    content_hash: row["content_hash"] ?? null,
    fee_base_bps: row["fee_base_bps"] ?? null,
    maker_fee_bps: row["maker_fee_bps"] ?? null,
    taker_fee_bps: row["taker_fee_bps"] ?? null,
    fee_curve_json: row["fee_curve_json"] ?? null,
    tick_size: row["tick_size"] ?? null,
    min_order_size: row["min_order_size"] ?? null,
    neg_risk: row["neg_risk"] ?? null,
    valid_from: toIso(row["valid_from"]),
    valid_to: toIso(row["valid_to"]),
    source_ts: toIso(row["source_ts"]),
    received_at: toIso(row["received_at"]),
  };
}

function serializeTrade(row: Row): Row {
  return {
    trade_id: row["trade_id"] ?? null,
    token_id: row["token_id"] ?? null,
    condition_id: row["condition_id"] ?? null,
    price: row["price"] ?? null,
    size: row["size"] ?? null,
    side: row["side"] ?? null,
    fee_rate_bps: row["fee_rate_bps"] ?? null,
    transaction_hash: row["transaction_hash"] ?? null,
    provenance: row["provenance"] ?? null,
    external_id: row["external_id"] ?? null,
    trade_ts: toIso(row["trade_ts"]),
    received_at: toIso(row["received_at"]),
  };
}

function serializeResolutionEvent(row: Row): Row {
  return {
    resolution_event_id: row["resolution_event_id"] ?? null,
    condition_id: row["condition_id"] ?? null,
    event_type: row["event_type"] ?? null,
    payload_json: row["payload_json"] ?? null,
    source_ts: toIso(row["source_ts"]),
    received_at: toIso(row["received_at"]),
  };
}

// ---------------------------------------------------------------------------
// Shared SQL fragments
// ---------------------------------------------------------------------------

const RULE_VERSION_COLUMNS =
  "version, content_hash, description, resolution_source, resolved_by, " +
  "end_date, uma_end_date, uma_bond, uma_reward, custom_liveness, " +
  "automatically_resolved, valid_from, valid_to, source_ts, received_at";

const PARAM_VERSION_COLUMNS =
  "version, content_hash, fee_base_bps, maker_fee_bps, taker_fee_bps, " +
  "fee_curve_json, tick_size, min_order_size, neg_risk, " +
  "valid_from, valid_to, source_ts, received_at";

const MARKET_COLUMNS =
  "condition_id, question, slug, category, neg_risk, clob_token_ids, rules, " +
  "rules_version, tick_size, min_order_size, fee_type, end_date_iso, active, " +
  "closed, source_ts, received_at, updated_at";

// Latest enter/exit per condition_id up to a point in time; membership is
// "latest action is enter".
const UNIVERSE_MEMBERS_SQL = `SELECT condition_id, reason, at
   FROM (
     SELECT DISTINCT ON (condition_id) condition_id, action, reason, at
       FROM polymarket_universe_log
      WHERE at <= $1 AND action IN ('enter', 'exit')
      ORDER BY condition_id, at DESC, universe_log_id DESC
   ) latest
  WHERE action = 'enter'
  ORDER BY condition_id
  LIMIT ${UNIVERSE_LIMIT}`;

async function ruleVersionAt(
  pool: DatabasePool,
  conditionId: string,
  at: Date,
): Promise<Row | null> {
  const result = await pool.query<Row>(
    `SELECT ${RULE_VERSION_COLUMNS}
       FROM polymarket_rule_versions
      WHERE condition_id = $1
        AND valid_from <= $2
        AND (valid_to IS NULL OR valid_to > $2)
      ORDER BY version DESC
      LIMIT 1`,
    [conditionId, at],
  );
  return result.rows[0] ?? null;
}

async function paramVersionAt(
  pool: DatabasePool,
  conditionId: string,
  at: Date,
): Promise<Row | null> {
  const result = await pool.query<Row>(
    `SELECT ${PARAM_VERSION_COLUMNS}
       FROM polymarket_param_versions
      WHERE condition_id = $1
        AND valid_from <= $2
        AND (valid_to IS NULL OR valid_to > $2)
      ORDER BY version DESC
      LIMIT 1`,
    [conditionId, at],
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

type RouteHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;

export function registerPolymarketReadRoutes(
  app: FastifyInstance,
  deps: PolymarketReadRoutesDeps,
): void {
  const { pool, authService } = deps;
  const clock = deps.clock ?? ((): Date => new Date());

  const bookAtFn: BookAtFn =
    deps.bookAtFn ??
    (async (poolArg, tokenId, at, depth) => {
      const replay = await loadReplayModule();
      const book = await replay.bookAt(poolArg, tokenId, at, depth);
      if (book === null) {
        return null;
      }
      return {
        bids: book.bids,
        asks: book.asks,
        anchorReceivedAt: new Date(book.anchorReceivedAt),
        deltasApplied: book.deltasApplied,
      };
    });
  const deltasPageFn: DeltasPageFn =
    deps.deltasPageFn ??
    (async (poolArg, tokenId, query) => {
      const replay = await loadReplayModule();
      const page = await replay.deltasPage(
        poolArg,
        tokenId,
        query.from ?? new Date(0),
        query.to ?? clock(),
        query.afterId === null ? undefined : Number(query.afterId),
        query.limit,
      );
      return {
        deltas: page.deltas.map((delta) => ({
          deltaId: String(delta.deltaId),
          side: delta.side,
          price: delta.price,
          size: delta.size,
          sourceTs: delta.sourceTs === null ? null : new Date(delta.sourceTs),
          receivedAt: new Date(delta.receivedAt),
        })),
        nextAfterId:
          page.nextAfterId === null ? null : String(page.nextAfterId),
      };
    });

  // Local auth guard: Bearer token validated against the RFC-002 auth
  // service. Anything but an explicit "ok" is a 401.
  async function guard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const token = bearerToken(request);
      if (token === null) {
        await jsonError(reply, 401, "AUTH_UNAUTHENTICATED");
        return;
      }
      const result = await authService.session(token);
      if (result.status !== "ok") {
        await jsonError(reply, 401, "AUTH_UNAUTHENTICATED");
      }
    } catch (error) {
      logReadApiError("READ_API_FAILED", error);
      await jsonError(reply, 500, "READ_API_FAILED");
    }
  }

  // A database or payload failure must never surface as an unhandled 500:
  // catch, log a structured line, answer with a stable reason code.
  function wrap(handler: RouteHandler): RouteHandler {
    return async (request, reply) => {
      try {
        return await handler(request, reply);
      } catch (error) {
        logReadApiError("READ_API_FAILED", error);
        return jsonError(reply, 500, "READ_API_FAILED");
      }
    };
  }

  function pathParam(request: FastifyRequest, name: string): string {
    const params: unknown = request.params;
    const value =
      typeof params === "object" && params !== null
        ? (params as Record<string, unknown>)[name]
        : undefined;
    return typeof value === "string" ? value : "";
  }

  // GET /polymarket/markets?category=&status=&in_universe=
  app.get(
    "/polymarket/markets",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const query = queryParams(request);
      const category = stringParam(query, "category");
      const status = stringParam(query, "status");
      if (status !== null && status !== "active" && status !== "closed") {
        return jsonError(reply, 400, "INVALID_STATUS");
      }
      const inUniverseRaw = stringParam(query, "in_universe");
      if (
        inUniverseRaw !== null &&
        inUniverseRaw !== "true" &&
        inUniverseRaw !== "false"
      ) {
        return jsonError(reply, 400, "INVALID_IN_UNIVERSE");
      }

      const conditions: string[] = [];
      const params: unknown[] = [];
      if (category !== null) {
        params.push(category);
        conditions.push(`category = $${params.length}`);
      }
      if (status === "active") {
        conditions.push("active IS TRUE AND closed IS NOT TRUE");
      } else if (status === "closed") {
        conditions.push("closed IS TRUE");
      }
      if (inUniverseRaw !== null) {
        params.push(clock());
        const membership = `condition_id IN (
          SELECT condition_id FROM (
            SELECT DISTINCT ON (condition_id) condition_id, action
              FROM polymarket_universe_log
             WHERE at <= $${params.length} AND action IN ('enter', 'exit')
             ORDER BY condition_id, at DESC, universe_log_id DESC
          ) latest WHERE action = 'enter')`;
        conditions.push(
          inUniverseRaw === "true" ? membership : `NOT (${membership})`,
        );
      }
      const where =
        conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
      const result = await pool.query<Row>(
        `SELECT ${MARKET_COLUMNS} FROM polymarket_markets${where}
         ORDER BY condition_id LIMIT ${MARKETS_LIMIT}`,
        params,
      );
      return reply
        .code(200)
        .send({ markets: result.rows.map(serializeMarket) });
    }),
  );

  // GET /polymarket/markets/:conditionId — current row + rule/param versions
  // effective now.
  app.get(
    "/polymarket/markets/:conditionId",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const conditionId = pathParam(request, "conditionId");
      const now = clock();
      const marketResult = await pool.query<Row>(
        `SELECT ${MARKET_COLUMNS} FROM polymarket_markets WHERE condition_id = $1`,
        [conditionId],
      );
      const market = marketResult.rows[0];
      if (market === undefined) {
        return jsonError(reply, 404, "MARKET_NOT_FOUND");
      }
      const [rule, params] = await Promise.all([
        ruleVersionAt(pool, conditionId, now),
        paramVersionAt(pool, conditionId, now),
      ]);
      return reply.code(200).send({
        market: serializeMarket(market),
        rule_version: rule === null ? null : serializeRuleVersion(rule),
        param_version: params === null ? null : serializeParamVersion(params),
      });
    }),
  );

  // GET /polymarket/markets/:conditionId/rules?at=ISO
  app.get(
    "/polymarket/markets/:conditionId/rules",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const conditionId = pathParam(request, "conditionId");
      const at = parseOptionalAt(queryParams(request), "at");
      if (!at.ok) {
        return jsonError(reply, 400, "INVALID_TIMESTAMP");
      }
      const effectiveAt = at.value ?? clock();
      const rule = await ruleVersionAt(pool, conditionId, effectiveAt);
      if (rule === null) {
        return jsonError(reply, 404, "RULE_VERSION_NOT_FOUND");
      }
      return reply.code(200).send({
        condition_id: conditionId,
        at: effectiveAt.toISOString(),
        rule_version: serializeRuleVersion(rule),
      });
    }),
  );

  // GET /polymarket/markets/:conditionId/params?at=ISO
  app.get(
    "/polymarket/markets/:conditionId/params",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const conditionId = pathParam(request, "conditionId");
      const at = parseOptionalAt(queryParams(request), "at");
      if (!at.ok) {
        return jsonError(reply, 400, "INVALID_TIMESTAMP");
      }
      const effectiveAt = at.value ?? clock();
      const version = await paramVersionAt(pool, conditionId, effectiveAt);
      if (version === null) {
        return jsonError(reply, 404, "PARAM_VERSION_NOT_FOUND");
      }
      return reply.code(200).send({
        condition_id: conditionId,
        at: effectiveAt.toISOString(),
        param_version: serializeParamVersion(version),
      });
    }),
  );

  // GET /polymarket/books/:tokenId?at=ISO&depth=N — deterministic replay.
  app.get(
    "/polymarket/books/:tokenId",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const tokenId = pathParam(request, "tokenId");
      const query = queryParams(request);
      const at = parseOptionalAt(query, "at");
      if (!at.ok) {
        return jsonError(reply, 400, "INVALID_TIMESTAMP");
      }
      const depth = parseClampedInt(query, "depth", 1, 100, 10);
      if (!depth.ok) {
        return jsonError(reply, 400, "INVALID_DEPTH");
      }
      const effectiveAt = at.value ?? clock();
      const book = await bookAtFn(pool, tokenId, effectiveAt, depth.value);
      if (book === null) {
        return jsonError(reply, 404, "BOOK_NOT_FOUND");
      }
      return reply.code(200).send({
        token_id: tokenId,
        at: effectiveAt.toISOString(),
        depth: depth.value,
        bids: book.bids,
        asks: book.asks,
        anchor_received_at: toIso(book.anchorReceivedAt),
        deltas_applied: book.deltasApplied,
      });
    }),
  );

  // GET /polymarket/books/:tokenId/deltas?from=&to=&after_id=&limit=
  app.get(
    "/polymarket/books/:tokenId/deltas",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const tokenId = pathParam(request, "tokenId");
      const query = queryParams(request);
      const from = parseOptionalAt(query, "from");
      const to = parseOptionalAt(query, "to");
      if (!from.ok || !to.ok) {
        return jsonError(reply, 400, "INVALID_TIMESTAMP");
      }
      const afterIdRaw = query["after_id"];
      let afterId: string | null = null;
      if (afterIdRaw !== undefined) {
        // delta_id is a Postgres BIGINT: 19 digits can still exceed its max
        // (2^63 - 1), which would surface as a driver/DB error (500). Reject
        // out-of-range cursors as a client error instead.
        if (
          typeof afterIdRaw !== "string" ||
          !/^\d{1,19}$/.test(afterIdRaw) ||
          BigInt(afterIdRaw) > 2n ** 63n - 1n
        ) {
          return jsonError(reply, 400, "INVALID_AFTER_ID");
        }
        afterId = afterIdRaw;
      }
      const limit = parseClampedInt(
        query,
        "limit",
        1,
        DELTAS_MAX_LIMIT,
        DELTAS_DEFAULT_LIMIT,
      );
      if (!limit.ok) {
        return jsonError(reply, 400, "INVALID_LIMIT");
      }
      const page = await deltasPageFn(pool, tokenId, {
        from: from.value,
        to: to.value,
        afterId,
        limit: limit.value,
      });
      return reply.code(200).send({
        token_id: tokenId,
        deltas: page.deltas.map((delta) => ({
          delta_id: delta.deltaId,
          side: delta.side,
          price: delta.price,
          size: delta.size,
          source_ts: toIso(delta.sourceTs),
          received_at: toIso(delta.receivedAt),
        })),
        next_after_id: page.nextAfterId,
      });
    }),
  );

  // GET /polymarket/trades?token_id=&from=&to=&limit=
  app.get(
    "/polymarket/trades",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const query = queryParams(request);
      const from = parseOptionalAt(query, "from");
      const to = parseOptionalAt(query, "to");
      if (!from.ok || !to.ok) {
        return jsonError(reply, 400, "INVALID_TIMESTAMP");
      }
      const limit = parseClampedInt(
        query,
        "limit",
        1,
        TRADES_MAX_LIMIT,
        TRADES_DEFAULT_LIMIT,
      );
      if (!limit.ok) {
        return jsonError(reply, 400, "INVALID_LIMIT");
      }
      const tokenId = stringParam(query, "token_id");
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (tokenId !== null) {
        params.push(tokenId);
        conditions.push(`token_id = $${params.length}`);
      }
      if (from.value !== null) {
        params.push(from.value);
        conditions.push(`COALESCE(trade_ts, received_at) >= $${params.length}`);
      }
      if (to.value !== null) {
        params.push(to.value);
        conditions.push(`COALESCE(trade_ts, received_at) < $${params.length}`);
      }
      const where =
        conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
      const result = await pool.query<Row>(
        `SELECT trade_id, token_id, condition_id, price, size, side,
                fee_rate_bps, transaction_hash, provenance, external_id,
                trade_ts, received_at
           FROM polymarket_trades${where}
          ORDER BY COALESCE(trade_ts, received_at), trade_id
          LIMIT ${limit.value}`,
        params,
      );
      return reply.code(200).send({
        trades: result.rows.map(serializeTrade),
        limit: limit.value,
      });
    }),
  );

  // GET /polymarket/series/:tokenId?metric=spread|depth|oi|holders&from=&to=
  // spread/depth read polymarket_series_1m by token_id. oi/holders read
  // polymarket_oi_holders and accept EITHER a token_id or a condition_id in
  // the path segment (samples are keyed by condition; token ids are resolved
  // through polymarket_markets.clob_token_ids).
  app.get(
    "/polymarket/series/:tokenId",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const tokenId = pathParam(request, "tokenId");
      const query = queryParams(request);
      const metric = stringParam(query, "metric");
      if (
        metric !== "spread" &&
        metric !== "depth" &&
        metric !== "oi" &&
        metric !== "holders"
      ) {
        return jsonError(reply, 400, "INVALID_METRIC");
      }
      const from = parseOptionalAt(query, "from");
      const to = parseOptionalAt(query, "to");
      if (!from.ok || !to.ok) {
        return jsonError(reply, 400, "INVALID_TIMESTAMP");
      }

      if (metric === "spread" || metric === "depth") {
        const columns =
          metric === "spread"
            ? "bucket_start, best_bid, best_ask, spread, mid_close"
            : "bucket_start, bid_depth_top1, bid_depth_top5, bid_depth_top10, " +
              "ask_depth_top1, ask_depth_top5, ask_depth_top10";
        const conditions = ["token_id = $1"];
        const params: unknown[] = [tokenId];
        if (from.value !== null) {
          params.push(from.value);
          conditions.push(`bucket_start >= $${params.length}`);
        }
        if (to.value !== null) {
          params.push(to.value);
          conditions.push(`bucket_start < $${params.length}`);
        }
        const result = await pool.query<Row>(
          `SELECT ${columns} FROM polymarket_series_1m
            WHERE ${conditions.join(" AND ")}
            ORDER BY bucket_start LIMIT ${SERIES_LIMIT}`,
          params,
        );
        return reply.code(200).send({
          token_id: tokenId,
          metric,
          points: result.rows.map((row) => ({
            ...row,
            bucket_start: toIso(row["bucket_start"]),
          })),
        });
      }

      const columns =
        metric === "oi"
          ? "condition_id, token_id, open_interest, live_volume, source_ts, received_at"
          : "condition_id, token_id, holders_count, top1_share, top5_share, " +
            "holders_json, source_ts, received_at";
      const conditions = [
        `(token_id = $1 OR condition_id = $1 OR condition_id IN (
           SELECT condition_id FROM polymarket_markets
            WHERE clob_token_ids @> $2::jsonb))`,
      ];
      const params: unknown[] = [tokenId, JSON.stringify([tokenId])];
      if (from.value !== null) {
        params.push(from.value);
        conditions.push(`received_at >= $${params.length}`);
      }
      if (to.value !== null) {
        params.push(to.value);
        conditions.push(`received_at < $${params.length}`);
      }
      const result = await pool.query<Row>(
        `SELECT ${columns} FROM polymarket_oi_holders
          WHERE ${conditions.join(" AND ")}
          ORDER BY received_at LIMIT ${SERIES_LIMIT}`,
        params,
      );
      return reply.code(200).send({
        token_id: tokenId,
        metric,
        points: result.rows.map((row) => ({
          ...row,
          source_ts: toIso(row["source_ts"]),
          received_at: toIso(row["received_at"]),
        })),
      });
    }),
  );

  // GET /polymarket/resolution-events?condition_id=
  app.get(
    "/polymarket/resolution-events",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const conditionId = stringParam(queryParams(request), "condition_id");
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (conditionId !== null) {
        params.push(conditionId);
        conditions.push(`condition_id = $${params.length}`);
      }
      const where =
        conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
      const result = await pool.query<Row>(
        `SELECT resolution_event_id, condition_id, event_type, payload_json,
                source_ts, received_at
           FROM polymarket_resolution_events${where}
          ORDER BY received_at, resolution_event_id
          LIMIT ${RESOLUTION_EVENTS_LIMIT}`,
        params,
      );
      return reply
        .code(200)
        .send({ events: result.rows.map(serializeResolutionEvent) });
    }),
  );

  // GET /polymarket/data-quality — gaps (24h), ingest lag (1h), storage vs
  // the 40 GB module budget.
  app.get(
    "/polymarket/data-quality",
    { preHandler: guard },
    wrap(async (_request, reply) => {
      const now = clock();
      const [gaps, lag, sizes] = await Promise.all([
        pool.query<Row>(
          `SELECT source,
                  COUNT(*)::bigint AS gap_count,
                  COALESCE(SUM(EXTRACT(EPOCH FROM
                    (COALESCE(gap_end, $1::timestamptz) - gap_start))), 0)
                    AS total_gap_seconds
             FROM polymarket_data_gaps
            WHERE gap_start >= $1::timestamptz - INTERVAL '24 hours'
            GROUP BY source
            ORDER BY source`,
          [now],
        ),
        pool.query<Row>(
          `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ingest_lag_ms)
                    AS p50,
                  percentile_cont(0.99) WITHIN GROUP (ORDER BY ingest_lag_ms)
                    AS p99
             FROM polymarket_book_deltas
            WHERE received_at >= $1::timestamptz - INTERVAL '1 hour'
              AND ingest_lag_ms IS NOT NULL`,
          [now],
        ),
        pool.query<Row>(
          `SELECT c.relname AS table_name,
                  pg_total_relation_size(c.oid)::bigint AS bytes
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema()
              AND c.relkind = 'r'
              AND c.relname LIKE 'polymarket\\_%'
            ORDER BY c.relname`,
          [],
        ),
      ]);

      const tables = sizes.rows.map((row) => ({
        table_name:
          typeof row["table_name"] === "string" ? row["table_name"] : null,
        bytes: toFiniteNumber(row["bytes"]) ?? 0,
      }));
      const totalBytes = tables.reduce((sum, table) => sum + table.bytes, 0);
      const lagRow = lag.rows[0] ?? {};
      return reply.code(200).send({
        generated_at: now.toISOString(),
        gaps_24h: gaps.rows.map((row) => ({
          source: row["source"] ?? null,
          count: toFiniteNumber(row["gap_count"]) ?? 0,
          total_duration_ms: Math.round(
            (toFiniteNumber(row["total_gap_seconds"]) ?? 0) * 1000,
          ),
        })),
        ingest_lag_ms_last_hour: {
          p50: toFiniteNumber(lagRow["p50"]),
          p99: toFiniteNumber(lagRow["p99"]),
        },
        storage: {
          budget_bytes: STORAGE_BUDGET_BYTES,
          total_bytes: totalBytes,
          budget_used_pct:
            Math.round((totalBytes / STORAGE_BUDGET_BYTES) * 100 * 100) / 100,
          tables,
        },
      });
    }),
  );

  // GET /polymarket/universe?at=ISO — membership reconstructed from the
  // enter/exit log with the reason recorded at entry.
  app.get(
    "/polymarket/universe",
    { preHandler: guard },
    wrap(async (request, reply) => {
      const at = parseOptionalAt(queryParams(request), "at");
      if (!at.ok) {
        return jsonError(reply, 400, "INVALID_TIMESTAMP");
      }
      const effectiveAt = at.value ?? clock();
      const result = await pool.query<Row>(UNIVERSE_MEMBERS_SQL, [effectiveAt]);
      return reply.code(200).send({
        at: effectiveAt.toISOString(),
        members: result.rows.map((row) => ({
          condition_id: row["condition_id"] ?? null,
          reason: row["reason"] ?? null,
          entered_at: toIso(row["at"]),
        })),
      });
    }),
  );
}
