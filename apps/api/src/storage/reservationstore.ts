import {
  parseTradingAmount,
  tradingIdempotencyKey,
  type TradingScope,
} from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { canonicalFingerprint } from "../trading/replay.js";
import {
  consume,
  release,
  reserve,
  requireOpeningCapacity,
  requireReservation,
  type Reservation,
} from "../trading/reservations.js";
import { projectFinancials, valueFinancials } from "../trading/valuation.js";
import {
  appendLedgerBatchTx,
  lockableLedgerAccountTx,
  readLedgerAccountTx,
} from "./ledgerstore.js";
import { readValuationMarketTx } from "./valuationstore.js";
import {
  validateReservationCommand,
  type ReservationCommand,
} from "./reservation-contract.js";
import type { LedgerBatch, LedgerCommand } from "./ledger-contract.js";

export async function readReservationsTx(
  tx: SqlExecutor,
  accountId: string,
): Promise<Reservation[]> {
  return (
    await tx.query(
      `SELECT DISTINCT ON (order_id) reservation FROM btc_reservation_events
    WHERE account_id=$1 ORDER BY order_id,sequence DESC`,
      [accountId],
    )
  ).rows.map((r) => r.reservation as Reservation);
}
/** S3 internal paper library, deliberately no HTTP/worker consumer or enable
 * switch. Every writer takes exactly ONE owner row lock before reading orders,
 * ledger or reservation events. No order->owner inversion, nested transaction,
 * cross-account capital or clock-only release. Retry returns the original result.
 * Full risk/execution authorization remains gated on S8/S10. */
export async function applyReservation(
  pool: Pick<DatabasePool, "transaction">,
  scopeInput: TradingScope,
  input: ReservationCommand,
) {
  return pool.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    return applyReservationTx(tx, scopeInput, input);
  });
}
/** Internal composition seam. Same connection and owner lock; broker may guard
 * market freshness immediately before the ledger write. Never a nested transaction. */
export async function applyReservationTx(
  tx: SqlExecutor,
  scopeInput: TradingScope,
  input: ReservationCommand,
  beforeFill?: () => Promise<void>,
) {
  validateReservationCommand(input);
  const request: ReservationCommand = JSON.parse(JSON.stringify(input)),
    scope = { ...scopeInput };
  const identity = await lockableLedgerAccountTx(tx, scope, true);
  const previous = (
    await tx.query(
      "SELECT request,reservation FROM btc_reservation_events WHERE account_id=$1 AND operation_id=$2",
      [scope.account_id, request.operation_id],
    )
  ).rows[0];
  if (previous) {
    requireReservation(
      canonicalFingerprint(previous.request) === canonicalFingerprint(request),
      "IDEMPOTENCY_COLLISION",
    );
    return {
      status: "duplicate" as const,
      reservation: previous.reservation as Reservation,
    };
  }
  const now = (
    await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
  ).rows[0]!.now.toISOString();
  const ledger = await readLedgerAccountTx(tx, scope);
  requireReservation(
    !ledger.events.some((e) => e.recorded_at > now || e.occurred_at > now),
    "FUTURE_LEDGER",
  );
  const market = { as_of: now, ...(await readValuationMarketTx(tx, now)) };
  const finance = valueFinancials(
    projectFinancials(ledger.projection, ledger.events),
    market,
  );
  const pending = await readReservationsTx(tx, scope.account_id);
  const orderId =
    request.action === "reserve" ? request.order.order_id : request.order_id;
  let result: Reservation,
    batch: LedgerBatch | null = null;
  if (request.action === "reserve") {
    requireReservation(
      !pending.some((r) => r.order.order_id === orderId),
      "ORDER_EXISTS",
    );
    requireReservation(request.order.valid_until > now, "EXPIRED");
    requireReservation(
      BigInt(request.order.quantity_btc_raw) %
        BigInt(identity.instrument.quantity_step.raw) ===
        0n &&
        BigInt(request.order.price_cap_usd_raw) %
          BigInt(identity.instrument.tick_size.raw) ===
          0n,
      "INEXACT_ORDER",
    );
    result = reserve(request.order, finance, pending);
    await tx.query(
      "INSERT INTO btc_order_acceptances(account_id,order_id,request,accepted_at) VALUES($1,$2,$3::jsonb,$4)",
      [scope.account_id, orderId, JSON.stringify(request.order), now],
    );
  } else {
    const active = pending.find((r) => r.order.order_id === orderId);
    requireReservation(!!active, "ORDER_NOT_FOUND");
    if (request.action === "release") {
      requireReservation(
        request.reason !== "expired" || active.order.valid_until <= now,
        "NOT_EXPIRED",
      );
      result = release(active, request.reason);
    } else {
      const managedIoc = await tx.query(
        "SELECT 1 FROM btc_ioc_intents WHERE account_id=$1 AND order_id=$2",
        [scope.account_id, orderId],
      );
      requireReservation(
        !managedIoc.rowCount || !!beforeFill,
        "IOC_BROKER_REQUIRED",
      );
      requireReservation(active.order.valid_until > now, "EXPIRED");
      result = consume(
        active,
        request.quantity_btc_raw,
        request.price_usd_raw,
        request.fee_usd_raw,
        finance,
      );
      const exec = `reservation:${request.operation_id}`;
      const event = (
        suffix: string,
        payload: LedgerCommand["payload"],
      ): LedgerCommand => ({
        schema_version: "trading.v1",
        ...scope,
        event_id: `${exec}:${suffix}`,
        idempotency_key: tradingIdempotencyKey(
          scope,
          "ledger",
          `${exec}:${suffix}`,
        ),
        cause_id: orderId,
        occurred_at: now as LedgerCommand["occurred_at"],
        payload,
      });
      batch = {
        transaction_id: exec,
        events: [
          event("fill", {
            event_type: "fill",
            execution_id: exec,
            order_id: orderId,
            position_id: active.order.position_id,
            side: active.order.side,
            quantity: parseTradingAmount("BTC", {
              unit: "BTC",
              decimals: 8,
              raw: request.quantity_btc_raw,
            }),
            price: parseTradingAmount("USD_PER_BTC", {
              unit: "USD_PER_BTC",
              decimals: 6,
              raw: request.price_usd_raw,
            }),
          }),
          event("fee", {
            event_type: "fee",
            execution_id: exec,
            delta: parseTradingAmount("USD", {
              unit: "USD",
              decimals: 6,
              raw:
                request.fee_usd_raw === "0" ? "0" : `-${request.fee_usd_raw}`,
            }),
          }),
        ],
      };
      await beforeFill?.();
      const appended = await appendLedgerBatchTx(
        tx,
        identity,
        batch,
        now,
        true,
      );
      requireReservation(appended.status === "appended", "LEDGER_COLLISION");
      if (active.order.intent === "open") {
        const after = await readLedgerAccountTx(tx, scope);
        requireOpeningCapacity(
          valueFinancials(
            projectFinancials(after.projection, after.events),
            market,
          ),
          pending.map((r) => (r.order.order_id === orderId ? result : r)),
        );
      }
    }
  }
  // Reservation journal and actual fill/fee commit together. Latest event is
  // the reservation projection: immutable history needs no mutable cache.
  await tx.query(
    `INSERT INTO btc_reservation_events(account_id,sequence,operation_id,order_id,action,request,reservation,ledger_transaction_id,recorded_at)
      SELECT $1,COALESCE(MAX(sequence),0)+1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8 FROM btc_reservation_events WHERE account_id=$1`,
    [
      scope.account_id,
      request.operation_id,
      orderId,
      request.action,
      JSON.stringify(request),
      JSON.stringify(result),
      batch?.transaction_id ?? null,
      now,
    ],
  );
  return { status: "applied" as const, reservation: result };
}
