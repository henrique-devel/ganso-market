import type { ChallengerConfig } from "./models/jev-config.js";
import { readChallengerStatusTx } from "./storage/challenger-operations.js";
import { readOperationTx, HistoryCursorError } from "./storage/desk-history.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  DeskOperation,
  DeskEnvelope,
  DeskReason,
  DeskPage,
  DeskAccount,
  DeskAccountView,
  DeskPosition,
  DeskPositionPage,
  DeskOrder,
  TradingInstrumentMetadata,
} from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "./database.js";
import { currentBudgetMs } from "./budgets.js";
import type { LedgerIdentity } from "./storage/ledger-contract.js";
import type { DeskProjection } from "./storage/desk-projection.js";
import { readValuationMarketTx } from "./storage/valuationstore.js";
import { ledgerScope, type LedgerProjection } from "./trading/ledger.js";
import { valueFinancials } from "./trading/valuation.js";
import { valueMarginBasis } from "./trading/margin.js";
import type { Reservation } from "./trading/reservations.js";
import { canonicalFingerprint } from "./trading/replay.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const units = {
  money: "USD/6",
  quantity: "BTC/8",
  price: "USD_PER_BTC/6",
  cost_basis: "USD/14",
} as const;
class ReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
function invalid(): never {
  throw new ReadError(400, "TRADING_INVALID_QUERY");
}
function parameters(request: FastifyRequest, kind: string, paged = true) {
  const q = request.query as Record<string, unknown>;
  const allowed = [
    ...(kind === "accounts" ? [] : ["account_id"]),
    ...(paged ? ["limit", "cursor"] : []),
    ...(kind === "operation" ? ["order_id", "view"] : []),
    ...(kind === "orders" ? ["position_id"] : []),
  ];
  if (Object.keys(q).some((k) => !allowed.includes(k))) invalid();
  const account = kind === "accounts" ? null : q.account_id;
  if (
    kind !== "accounts" &&
    (typeof account !== "string" || !idPattern.test(account))
  )
    invalid();
  const rawLimit = q.limit ?? "50";
  if (typeof rawLimit !== "string" || !/^(?:[1-9][0-9]?|100)$/.test(rawLimit))
    invalid();
  const order = q.order_id ?? null,
    position = q.position_id ?? null;
  const view = q.view ?? "events";
  if (
    kind === "operation" &&
    (typeof order !== "string" ||
      !idPattern.test(order) ||
      !["events", "receipts"].includes(String(view)))
  )
    invalid();
  if (
    position !== null &&
    (typeof position !== "string" || !idPattern.test(position))
  )
    invalid();
  const cursorKind =
    kind === "operation"
      ? `${kind}:${String(order)}:${String(view)}`
      : position
        ? `${kind}:${String(position)}`
        : kind;
  let after = "";
  if (q.cursor !== undefined) {
    if (
      typeof q.cursor !== "string" ||
      q.cursor.length > 2048 ||
      !/^[A-Za-z0-9_-]+$/.test(q.cursor)
    )
      invalid();
    try {
      const decoded: unknown = JSON.parse(
        Buffer.from(q.cursor, "base64url").toString("utf8"),
      );
      if (
        !Array.isArray(decoded) ||
        decoded.length !== 4 ||
        decoded[0] !== "desk.v1" ||
        decoded[1] !== cursorKind ||
        decoded[2] !== account ||
        typeof decoded[3] !== "string" ||
        !idPattern.test(decoded[3])
      )
        invalid();
      after = decoded[3];
    } catch {
      invalid();
    }
  }
  if (
    kind === "operation" &&
    view === "events" &&
    after &&
    !/^[1-9][0-9]{0,17}$/.test(after)
  )
    invalid();
  return {
    account: account as string | null,
    kind: cursorKind,
    order: order as string,
    position: position as string | null,
    view: view as "events" | "receipts",
    after,
    limit: Number(rawLimit),
  };
}
function page<T>(
  items: T[],
  p: ReturnType<typeof parameters>,
  key: (item: T) => string,
) {
  const selected = items.slice(0, p.limit);
  return {
    items: selected,
    next_cursor:
      items.length > p.limit
        ? Buffer.from(
            JSON.stringify([
              "desk.v1",
              p.kind,
              p.account,
              key(selected.at(-1)!),
            ]),
          ).toString("base64url")
        : null,
  };
}
function accountDto(identity: LedgerIdentity, enabled = false): DeskAccount {
  return {
    account: identity.account,
    scope: ledgerScope(identity),
    status: enabled ? "enabled" : "disabled",
    strategy_version: identity.experiment.strategy_version,
    started_at: identity.experiment.started_at,
  };
}
async function accountTx(tx: SqlExecutor, id: string) {
  const row = (
    await tx.query<{
      identity: LedgerIdentity;
      enabled: boolean;
      projection: LedgerProjection | null;
      desk_projection: DeskProjection | null;
      last_sequence: string | null;
    }>(
      `SELECT a.identity,c.enabled,p.projection,p.desk_projection,
      (SELECT sequence::text FROM btc_ledger_events e WHERE e.account_id=a.account_id ORDER BY sequence DESC LIMIT 1) AS last_sequence
     FROM btc_ledger_accounts a LEFT JOIN btc_ledger_projections p USING(account_id) LEFT JOIN btc_desk_controls c USING(account_id) WHERE a.account_id=$1`,
      [id],
    )
  ).rows[0];
  if (!row) throw new ReadError(404, "TRADING_ACCOUNT_NOT_FOUND");
  return row;
}
async function financialTx(
  tx: SqlExecutor,
  id: string,
  envelope: DeskEnvelope,
) {
  const row = await accountTx(tx, id),
    stored = row.desk_projection;
  const empty: DeskAccountView = {
    ...envelope,
    account: accountDto(row.identity, row.enabled),
    status: "unavailable",
    reason_codes: [
      { component: "projection", code: "BTC_DESK_PROJECTION_UNAVAILABLE" },
    ],
    ledger_sequence: row.last_sequence,
    ledger_recorded_at: null,
    balances: null,
    margin: null,
    mark: null,
    book: null,
  };
  if (
    !stored ||
    stored.schema_version !== "btc.desk-projection.v1" ||
    !row.projection ||
    stored.finance.ledger.last_sequence !== row.last_sequence ||
    canonicalFingerprint(stored.finance.ledger) !==
      canonicalFingerprint(row.projection) ||
    canonicalFingerprint(row.projection.scope) !==
      canonicalFingerprint(ledgerScope(row.identity))
  )
    return { view: empty, positions: null };
  if (
    stored.recorded_at > envelope.as_of ||
    stored.occurred_at > envelope.as_of
  )
    return {
      view: {
        ...empty,
        reason_codes: [
          {
            component: "projection" as const,
            code: "BTC_DESK_PROJECTION_FUTURE",
          },
        ],
      },
      positions: null,
    };
  const market = await readValuationMarketTx(tx, envelope.as_of);
  const metadata =
    (
      await tx.query<{ payload: TradingInstrumentMetadata }>(
        `SELECT o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id)
     WHERE r.kind='metadata' AND r.received_at <= $1 ORDER BY r.received_at DESC,r.object_id LIMIT 1`,
        [envelope.as_of],
      )
    ).rows[0]?.payload ?? null;
  const finance = valueFinancials(stored.finance, {
    ...market,
    as_of: envelope.as_of,
  });
  const isolation = valueMarginBasis(
    stored.finance,
    stored.margin_basis,
    finance.maintenance.usable_for_risk
      ? finance.maintenance.mark_price!.raw
      : null,
    metadata,
    envelope.as_of,
  );
  const held = (
    await tx.query<{ margin: string; fees: string }>(
      `SELECT COALESCE(SUM((reservation->>'margin_usd_raw')::numeric),0)::text AS margin,
      COALESCE(SUM((reservation->>'fee_usd_raw')::numeric),0)::text AS fees
     FROM btc_desk_orders WHERE account_id=$1 AND reservation->>'status'='active'`,
      [id],
    )
  ).rows[0]!;
  const reasons: DeskReason[] = [];
  for (const [component, quality] of [
    ["mark", finance.maintenance.quality],
    ["book", finance.closing.quality],
  ] as const)
    if (quality !== "fresh")
      reasons.push({
        component,
        code: `BTC_${component.toUpperCase()}_${quality.toUpperCase()}`,
      });
  if (!isolation.compatible)
    reasons.push({ component: "margin", code: "BTC_MARGIN_INCOMPATIBLE" });
  if (!isolation.metadata_valid)
    reasons.push({
      component: "margin",
      code: "BTC_MARGIN_METADATA_UNAVAILABLE",
    });
  const { maintenance: mark, closing: book } = finance;
  const view: DeskAccountView = {
    ...envelope,
    account: accountDto(row.identity, row.enabled),
    status: reasons.length ? "unavailable" : "available",
    reason_codes: reasons,
    ledger_sequence: row.last_sequence,
    ledger_recorded_at: stored.recorded_at,
    balances: {
      cash_usd_raw: finance.ledger.cash_usd_raw,
      balance_usd_raw: finance.balance_usd_raw,
      realized_pnl_usd_raw: finance.realized_pnl_usd_raw,
      fees_usd_raw: finance.fees_usd_raw,
      funding_usd_raw: finance.funding_usd_raw,
      unrealized_pnl_usd_raw: mark.unrealized_pnl_usd_raw,
      equity_usd_raw: mark.equity_usd_raw,
    },
    margin: {
      mode: isolation.mode,
      leverage: isolation.leverage,
      compatible: isolation.compatible,
      metadata_valid: isolation.metadata_valid,
      free_cash_usd_raw: isolation.free_cash_usd_raw,
      open_collateral_usd_raw: isolation.open_collateral_usd_raw,
      closed_deficit_usd_raw: isolation.closed_deficit_usd_raw,
      reserved_margin_usd_raw: held.margin,
      reserved_fees_usd_raw: held.fees,
      unreserved_cash_usd_raw: (
        BigInt(isolation.free_cash_usd_raw) -
        BigInt(held.margin) -
        BigInt(held.fees)
      ).toString(),
    },
    mark: {
      quality: mark.quality,
      evidence: mark.evidence,
      source_timestamp: mark.source_timestamp,
      freshness_timestamp: mark.freshness_timestamp,
      timestamp_basis: mark.timestamp_basis,
      received_at: mark.received_at,
      mark_price_usd_raw: mark.mark_price?.raw ?? null,
      oracle_price_usd_raw: mark.oracle_price?.raw ?? null,
    },
    book: {
      quality: book.quality,
      evidence: book.evidence,
      source_timestamp: book.source_timestamp,
      received_at: book.received_at,
    },
  };
  const margins = new Map(isolation.positions.map((p) => [p.position_id, p]));
  const positions: DeskPosition[] = finance.positions.map((p) => {
    const m = margins.get(p.position_id)!;
    return {
      ...p,
      collateral_usd_raw: m.collateral_usd_raw,
      equity_usd_raw: m.equity_usd_raw,
      maintenance_usd_raw: m.maintenance_usd_raw,
      liquidatable:
        p.quantity_btc_raw === "0"
          ? false
          : !isolation.compatible ||
              m.equity_usd_raw === null ||
              m.maintenance_usd_raw === null
            ? null
            : m.liquidatable,
    };
  });
  return { view, positions };
}

/** Same owner session as the existing UI; only explicit GET routes are registered. */
export function registerTradingReadRoutes(
  app: FastifyInstance,
  deps: {
    pool: Pick<DatabasePool, "readOnly">;
    authService: { session(token: string): Promise<{ status: string }> };
    clock: () => Date;
    challengerConfig?: ChallengerConfig;
  },
) {
  const error = (reply: FastifyReply, status: number, code: string) =>
    reply
      .code(status)
      .send({ reason_code: code, correlation_id: reply.request.id });
  async function guard(request: FastifyRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    const token = /^Bearer (.+)$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (!token || (await deps.authService.session(token)).status !== "ok")
      return error(reply, 401, "AUTH_UNAUTHENTICATED");
  }
  function handler(
    kind: string,
    paged: boolean,
    run: (
      tx: SqlExecutor,
      p: ReturnType<typeof parameters>,
      env: DeskEnvelope,
    ) => Promise<unknown>,
  ) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const p = parameters(request, kind, paged);
        return await deps.pool.readOnly(
          currentBudgetMs() ?? 1500,
          async (tx) => {
            await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
            const env: DeskEnvelope = {
              schema_version: "trading.desk.v1",
              simulation: "SIMULAÇÃO",
              mode: "paper",
              as_of: deps.clock().toISOString(),
              units,
            };
            return run(tx, p, env);
          },
        );
      } catch (e) {
        if (e instanceof HistoryCursorError)
          return error(reply, 400, "TRADING_INVALID_QUERY");
        if (e instanceof ReadError) return error(reply, e.status, e.code);
        request.log.error(
          { reason_code: "TRADING_READ_UNAVAILABLE" },
          "trading_read_failed",
        );
        return error(reply, 503, "TRADING_READ_UNAVAILABLE");
      }
    };
  }
  app.get(
    "/trading/jev",
    { preHandler: guard },
    handler("accounts", false, (tx) =>
      readChallengerStatusTx(tx, deps.challengerConfig),
    ),
  );
  app.get(
    "/trading/accounts",
    { preHandler: guard },
    handler(
      "accounts",
      true,
      async (tx, p, env): Promise<DeskPage<DeskAccount>> => {
        const rows = (
          await tx.query<{ identity: LedgerIdentity; enabled: boolean }>(
            "SELECT a.identity,c.enabled FROM btc_ledger_accounts a LEFT JOIN btc_desk_controls c USING(account_id) WHERE account_id > $1 ORDER BY account_id LIMIT $2",
            [p.after, p.limit + 1],
          )
        ).rows.map((r) => accountDto(r.identity, r.enabled));
        return {
          ...env,
          scope: null,
          status: "available",
          reason_codes: [],
          ...page(rows, p, (item) => item.account.account_id),
        };
      },
    ),
  );
  app.get(
    "/trading/account",
    { preHandler: guard },
    handler("account", false, async (tx, p, env) => {
      const { view } = await financialTx(tx, p.account!, env);
      const c = (
        await tx.query<{
          broker: "ioc" | "passive";
          enabled: boolean;
          ready: boolean;
          observed_at: Date | null;
          reason: string | null;
          checkpoint: { state: string; reasons: string[] } | null;
        }>(
          `SELECT c.broker,c.enabled,(r.ready AND r.observed_at > clock_timestamp()-interval '5 seconds' AND h.status='ready' AND h.lease_until > clock_timestamp()) AS ready,
          r.observed_at,r.reason,k.checkpoint FROM btc_desk_controls c LEFT JOIN btc_desk_runtime r USING(account_id)
          LEFT JOIN btc_recovery_heads h USING(account_id)
          LEFT JOIN LATERAL(SELECT checkpoint FROM btc_risk_events WHERE account_id=c.account_id ORDER BY sequence DESC LIMIT 1) k ON true WHERE c.account_id=$1`,
          [p.account],
        )
      ).rows[0];
      const market = await readValuationMarketTx(tx, env.as_of);
      const b = market.book?.payload.payload;
      const funding =
        (
          await tx.query<{
            status: "pending" | "settled" | "conflict";
            reason: string;
            period_hour: string;
            model_version: string | null;
          }>(
            `SELECT status,result->>'reason' AS reason,result->>'period_hour' AS period_hour,result->>'model_version' AS model_version
        FROM btc_funding_results WHERE account_id=$1 AND period_hour=date_trunc('hour',$2::timestamptz)
        AND status <> 'duplicate' ORDER BY sequence DESC LIMIT 1`,
            [p.account, env.as_of],
          )
        ).rows[0] ?? null;
      let baseline: DeskAccountView["baseline"] = null;
      if (["baseline", "challenger"].includes(view.account.account.purpose)) {
        const registration = (
          await tx.query<{
            registration: NonNullable<DeskAccountView["baseline"]>;
          }>(
            "SELECT registration FROM btc_baseline_registrations WHERE account_id=$1",
            [p.account],
          )
        ).rows[0]?.registration;
        if (registration) {
          const decisions = (
            await tx.query<
              NonNullable<DeskAccountView["baseline"]>["decisions"][number]
            >(
              `SELECT
            d.decision_id,d.decision->>'bar_end_at' AS bar_end_at,d.decision->>'decision_at' AS decision_at,
            d.decision->>'state' AS state,d.decision->'reasons' AS reasons,d.decision->'candidate' AS candidate,
            d.decision->'command'->'order'->>'order_id' AS order_id,d.evidence_id,
            a.outcome AS admission,e.outcome AS execution
            FROM (SELECT * FROM btc_baseline_decisions WHERE account_id=$1 ORDER BY bar_end_at DESC LIMIT 20) d
            LEFT JOIN LATERAL(SELECT jsonb_build_object('reasons',payload->'reasons','status',payload->'result'->>'status','reason',payload->'result'->>'reason') AS outcome
              FROM btc_baseline_events WHERE account_id=d.account_id AND event_key='admit:'||(d.decision->'command'->'order'->>'order_id')) a ON true
            LEFT JOIN LATERAL(SELECT jsonb_build_object('reasons',COALESCE(payload->'validation'->'reasons','[]'::jsonb)||COALESCE(payload->'reasons','[]'::jsonb),'status',payload->'result'->>'status','reason',payload->'result'->>'reason') AS outcome
              FROM btc_baseline_events WHERE account_id=d.account_id AND event_key='execute:'||(d.decision->'command'->'order'->>'order_id')) e ON true
            ORDER BY d.bar_end_at DESC`,
              [p.account],
            )
          ).rows;
          const exits = (
            await tx.query<
              NonNullable<DeskAccountView["baseline"]>["exits"][number]
            >(
              `SELECT position_id,payload->>'state' AS state,
            payload->'position'->>'deadline' AS deadline,payload->'position'->>'requested_at' AS requested_at,payload->'position'->'reasons' AS reasons
            FROM (SELECT DISTINCT ON(position_id) position_id,payload,sequence FROM btc_baseline_events WHERE account_id=$1 AND kind='position' ORDER BY position_id,sequence DESC) e
            ORDER BY (payload->>'state'='closed'),sequence DESC LIMIT 20`,
              [p.account],
            )
          ).rows;
          const {
            start_at,
            registered_at,
            policy_version,
            manifest_fingerprint,
            code_sha,
          } = registration;
          baseline = {
            start_at,
            registered_at,
            policy_version,
            manifest_fingerprint,
            code_sha,
            decisions,
            exits,
          };
        }
      }
      return {
        ...view,
        funding,
        baseline,
        ticket: {
          broker: c?.broker ?? null,
          enabled: c?.enabled ?? false,
          consumer_ready: c?.ready ?? false,
          consumer_at: c?.observed_at?.toISOString() ?? null,
          consumer_reason: c?.reason ?? "not_activated",
          risk_state: c?.checkpoint?.state ?? null,
          risk_reasons: c?.checkpoint?.reasons ?? [],
          bid_price_usd_raw:
            b?.kind === "book" ? (b.bids[0]?.price.raw ?? null) : null,
          ask_price_usd_raw:
            b?.kind === "book" ? (b.asks[0]?.price.raw ?? null) : null,
          quantity_step_btc_raw: (await accountTx(tx, p.account!)).identity
            .instrument.quantity_step.raw,
        },
      };
    }),
  );
  app.get(
    "/trading/positions",
    { preHandler: guard },
    handler(
      "positions",
      true,
      async (tx, p, env): Promise<DeskPositionPage> => {
        const { view, positions } = await financialTx(tx, p.account!, env);
        return {
          ...env,
          scope: view.account.scope,
          status: view.status,
          reason_codes: view.reason_codes,
          ledger_sequence: view.ledger_sequence,
          ledger_recorded_at: view.ledger_recorded_at,
          mark: view.mark,
          book: view.book,
          ...page(
            (positions ?? []).filter((item) => item.position_id > p.after),
            p,
            (item) => item.position_id,
          ),
        };
      },
    ),
  );
  app.get(
    "/trading/orders",
    { preHandler: guard },
    handler(
      "orders",
      true,
      async (tx, p, env): Promise<DeskPage<DeskOrder>> => {
        const owner = await accountTx(tx, p.account!);
        const rows = (
          await tx.query<{
            reservation: Reservation;
            filled_btc_raw: string;
            sequence: string;
            recorded_at: Date;
          }>(
            `SELECT reservation,filled_btc_raw::text,sequence::text,recorded_at FROM btc_desk_orders
       WHERE account_id=$1 AND order_id > $2 ${p.position ? "AND reservation->'order'->>'position_id'=$4" : ""} ORDER BY order_id LIMIT $3`,
            p.position
              ? [p.account, p.after, p.limit + 1, p.position]
              : [p.account, p.after, p.limit + 1],
          )
        ).rows.map(
          ({
            reservation: r,
            filled_btc_raw,
            sequence,
            recorded_at,
          }): DeskOrder => ({
            order_id: r.order.order_id,
            position_id: r.order.position_id,
            source: r.order.source,
            intent: r.order.intent,
            side: r.order.side,
            quantity_btc_raw: r.order.quantity_btc_raw,
            filled_btc_raw,
            remaining_btc_raw: r.remaining_btc_raw,
            price_cap_usd_raw: r.order.price_cap_usd_raw,
            valid_until: r.order.valid_until,
            status: r.status,
            reserved_margin_usd_raw: r.margin_usd_raw,
            reserved_fees_usd_raw: r.fee_usd_raw,
            sequence,
            recorded_at: recorded_at.toISOString(),
          }),
        );
        return {
          ...env,
          scope: ledgerScope(owner.identity),
          status: "available",
          reason_codes: [],
          ...page(rows, p, (item) => item.order_id),
        };
      },
    ),
  );
  app.get(
    "/trading/operation",
    { preHandler: guard },
    handler("operation", true, async (tx, p, env): Promise<DeskOperation> => {
      const owner = await accountTx(tx, p.account!);
      // Passive receipts use sequence cursors; IOC receipts use operation ids.
      const result = await readOperationTx(
        tx,
        p.account!,
        p.order,
        p.view,
        p.after,
        p.limit,
      );
      if (!result) throw new ReadError(404, "TRADING_ORDER_NOT_FOUND");
      const { after, ...detail } = result;
      return {
        ...env,
        ...detail,
        scope: ledgerScope(owner.identity),
        view: p.view,
        next_cursor: after
          ? Buffer.from(
              JSON.stringify(["desk.v1", p.kind, p.account, after]),
            ).toString("base64url")
          : null,
      };
    }),
  );
}
