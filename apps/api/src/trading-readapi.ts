import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
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
        decoded[1] !== kind ||
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
  return {
    account: account as string | null,
    kind,
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
function accountDto(identity: LedgerIdentity): DeskAccount {
  return {
    account: identity.account,
    scope: ledgerScope(identity),
    status: "disabled",
    strategy_version: identity.experiment.strategy_version,
    started_at: identity.experiment.started_at,
  };
}
async function accountTx(tx: SqlExecutor, id: string) {
  const row = (
    await tx.query<{
      identity: LedgerIdentity;
      projection: LedgerProjection | null;
      desk_projection: DeskProjection | null;
      last_sequence: string | null;
    }>(
      `SELECT a.identity,p.projection,p.desk_projection,
      (SELECT sequence::text FROM btc_ledger_events e WHERE e.account_id=a.account_id ORDER BY sequence DESC LIMIT 1) AS last_sequence
     FROM btc_ledger_accounts a LEFT JOIN btc_ledger_projections p USING(account_id) WHERE a.account_id=$1`,
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
    account: accountDto(row.identity),
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
    account: accountDto(row.identity),
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
    "/trading/accounts",
    { preHandler: guard },
    handler(
      "accounts",
      true,
      async (tx, p, env): Promise<DeskPage<DeskAccount>> => {
        const rows = (
          await tx.query<{ identity: LedgerIdentity }>(
            "SELECT identity FROM btc_ledger_accounts WHERE account_id > $1 ORDER BY account_id LIMIT $2",
            [p.after, p.limit + 1],
          )
        ).rows.map((r) => accountDto(r.identity));
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
    handler(
      "account",
      false,
      async (tx, p, env) => (await financialTx(tx, p.account!, env)).view,
    ),
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
       WHERE account_id=$1 AND order_id > $2 ORDER BY order_id LIMIT $3`,
            [p.account, p.after, p.limit + 1],
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
}
