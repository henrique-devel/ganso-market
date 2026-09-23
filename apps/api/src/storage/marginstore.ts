import { createHash } from "node:crypto";
import {
  parseTradingAmount,
  tradingIdempotencyKey,
  type TradingScope,
} from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import {
  MARGIN_VERSION,
  MARGIN_POLICY,
  requireMargin,
  type IsolatedMargin,
} from "../trading/margin.js";
import { walkIoc, type IocFill } from "../trading/broker.js";
import { canonicalFingerprint } from "../trading/replay.js";
import { assertEvidenceJson } from "../trading/retention.js";
import {
  appendLedgerBatchTx,
  lockableLedgerAccountTx,
  readLedgerAccountTx,
} from "./ledgerstore.js";
import type { LedgerCommand } from "./ledger-contract.js";
import { applyReservationTx, readReservationsTx } from "./reservationstore.js";
import {
  readIsolatedMarginTx,
  readValuationMarketTx,
} from "./valuationstore.js";
import {
  withBtcRetentionTransaction,
  storeRetentionObjectTx,
  pinRetentionObjectTx,
} from "./btc-retention.js";

export interface MarginCommand {
  operation_id: string;
  position_id: string;
}
export interface MarginResult {
  schema_version: typeof MARGIN_VERSION;
  market_id: string;
  status:
    "unavailable" | "healthy" | "flat" | "partial" | "closed" | "unfilled";
  reason: string;
  side: "buy" | "sell" | null;
  book_key: string | null;
  fills: IocFill[];
  before: IsolatedMargin;
  after: IsolatedMargin;
  evidence_id: string;
  policy: typeof MARGIN_POLICY;
}
const hash = (v: unknown) =>
  createHash("sha256").update(canonicalFingerprint(v)).digest("hex");
const clock = async (tx: SqlExecutor) =>
  (
    await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
  ).rows[0]!.now.toISOString();
/** Library only, no financial endpoint/poller. Retention -> owner lock, same
 * transaction for cancellation, fills/fees, receipts and evidence pins.
 * Unknown book never implies flattening. Full close marker has no cash delta.
 * Deficit stays a reported liability; never manufacture a cash bailout. */
export async function liquidateIsolatedPosition(
  pool: Pick<DatabasePool, "transaction">,
  scopeInput: TradingScope,
  input: MarginCommand,
): Promise<MarginResult> {
  assertEvidenceJson(input);
  requireMargin(
    Object.keys(input).sort().join() === "operation_id,position_id" &&
      [input.operation_id, input.position_id].every(
        (s) =>
          typeof s === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(s),
      ),
    "COMMAND",
  );
  const request = { ...input },
    scope = { ...scopeInput };
  return withBtcRetentionTransaction(pool, async (tx) => {
    const identity = await lockableLedgerAccountTx(tx, scope, true);
    const previous = (
      await tx.query(
        "SELECT request,result FROM btc_margin_results WHERE account_id=$1 AND operation_id=$2",
        [scope.account_id, request.operation_id],
      )
    ).rows[0];
    if (previous) {
      requireMargin(
        canonicalFingerprint(previous.request) ===
          canonicalFingerprint(request),
        "IDEMPOTENCY_COLLISION",
      );
      return previous.result as MarginResult;
    }
    let now = await clock(tx);
    const ledger = await readLedgerAccountTx(tx, scope);
    requireMargin(
      !ledger.events.some((e) => e.occurred_at > now || e.recorded_at > now),
      "FUTURE_LEDGER",
    );
    const market = { as_of: now, ...(await readValuationMarketTx(tx, now)) };
    const snapshot = await readIsolatedMarginTx(tx, ledger, market);
    const position = snapshot.isolation.positions.find(
      (p) => p.position_id === request.position_id,
    );
    requireMargin(position, "POSITION_NOT_FOUND");
    const evidenceId = `btc-margin:${hash([scope, request.operation_id])}`;
    const deps = new Set<string>();
    if (snapshot.metadata) deps.add(snapshot.metadata.object_id);
    if (market.context) deps.add(market.context.object_id);
    if (market.book) deps.add(market.book.object_id);
    const captures = await tx.query(
      "SELECT object_id FROM btc_market_records WHERE kind='capture' AND received_at <= $1 ORDER BY received_at DESC,object_id LIMIT 1",
      [now],
    );
    if (captures.rows[0]) deps.add(captures.rows[0].object_id);
    const result: MarginResult = {
      schema_version: MARGIN_VERSION,
      market_id: `counterfactual:${scope.account_id}`,
      status: "unavailable",
      reason: "metadata_mark_or_history_unavailable",
      side: null,
      book_key: null,
      fills: [],
      before: snapshot.isolation,
      after: snapshot.isolation,
      evidence_id: evidenceId,
      policy: MARGIN_POLICY,
    };
    if (position.quantity_btc_raw === "0") {
      result.status = "flat";
      result.reason = "already_flat";
    } else if (
      snapshot.isolation.compatible &&
      snapshot.isolation.metadata_valid &&
      snapshot.finance.maintenance.usable_for_risk
    ) {
      if (!position.liquidatable) {
        result.status = "healthy";
        result.reason = "above_maintenance";
      } else {
        // Revoke every accepted order of this position before risk execution.
        // Other position budgets/orders are not touched, even in the same account.
        for (const reservation of await readReservationsTx(
          tx,
          scope.account_id,
        )) {
          if (
            reservation.status === "active" &&
            reservation.order.position_id === request.position_id
          )
            await applyReservationTx(tx, scope, {
              action: "release",
              operation_id: `margin:${hash([request.operation_id, reservation.order.order_id])}`,
              order_id: reservation.order.order_id,
              reason: "cancelled",
            });
        }
        result.status = "unfilled";
        result.reason = "book_unavailable";
        const book = market.book;
        const mark = market.context!.payload;
        const afterTrigger =
          !!book?.payload.source_timestamp &&
          !!mark.source_timestamp &&
          book.payload.source_timestamp >= mark.source_timestamp &&
          book.payload.received_at >= mark.received_at;
        if (snapshot.finance.closing.quality === "fresh" && !afterTrigger)
          result.reason = "book_before_trigger";
        if (
          afterTrigger &&
          snapshot.finance.closing.quality === "fresh" &&
          book?.payload.payload.kind === "book"
        ) {
          result.side = BigInt(position.quantity_btc_raw) > 0n ? "sell" : "buy";
          // Exactly the IOC economic identity, including duplicate observations.
          result.book_key = hash([
            scope.instrument_id,
            book.payload.source_timestamp,
            book.payload.payload,
          ]);
          const used = (
            await tx.query(
              `SELECT result FROM btc_ioc_results WHERE account_id=$1 AND result->>'book_key'=$2
             UNION ALL SELECT result FROM btc_margin_results WHERE account_id=$1 AND result->>'book_key'=$2`,
              [scope.account_id, result.book_key],
            )
          ).rows.flatMap((r) =>
            r.result.side === result.side ? (r.result.fills as IocFill[]) : [],
          );
          const levels =
            result.side === "buy"
              ? book.payload.payload.asks
              : book.payload.payload.bids;
          const cap = levels
            .reduce(
              (n, l) => (BigInt(l.price.raw) > n ? BigInt(l.price.raw) : n),
              1n,
            )
            .toString();
          const quantity = (
            BigInt(position.quantity_btc_raw) < 0n
              ? -BigInt(position.quantity_btc_raw)
              : BigInt(position.quantity_btc_raw)
          ).toString();
          result.fills = walkIoc({
            side: result.side,
            quantity,
            limit: result.side === "buy" ? cap : "1",
            priceCap: cap,
            step: identity.instrument.quantity_step.raw,
            feeRate: snapshot.metadata!.payload.fees.taker.raw,
            levels,
            consumed: used,
          });
          const filled = result.fills.reduce(
            (n, f) => n + BigInt(f.quantity_btc_raw),
            0n,
          );
          const events: LedgerCommand[] = [];
          const txId = `margin:${hash([scope, request.operation_id])}`;
          for (const [i, fill] of result.fills.entries()) {
            const exec = `${txId}:${i}`;
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
              cause_id: evidenceId,
              occurred_at: now as LedgerCommand["occurred_at"],
              payload,
            });
            events.push(
              event("fill", {
                event_type: "fill",
                execution_id: exec,
                order_id: txId,
                position_id: request.position_id,
                side: result.side,
                quantity: parseTradingAmount("BTC", {
                  unit: "BTC",
                  decimals: 8,
                  raw: fill.quantity_btc_raw,
                }),
                price: parseTradingAmount("USD_PER_BTC", {
                  unit: "USD_PER_BTC",
                  decimals: 6,
                  raw: fill.price_usd_raw,
                }),
              }),
              event("fee", {
                event_type: "fee",
                execution_id: exec,
                delta: parseTradingAmount("USD", {
                  unit: "USD",
                  decimals: 6,
                  raw: (-BigInt(fill.fee_usd_raw)).toString(),
                }),
              }),
            );
            if (i === result.fills.length - 1 && filled === BigInt(quantity))
              events.push(
                event("liquidation", {
                  event_type: "liquidation",
                  position_id: request.position_id,
                  execution_id: exec,
                }),
              );
          }
          if (events.length)
            await appendLedgerBatchTx(
              tx,
              identity,
              { transaction_id: txId, events },
              now,
              true,
            );
          result.status =
            filled === 0n
              ? "unfilled"
              : filled === BigInt(quantity)
                ? "closed"
                : "partial";
          result.reason =
            filled === 0n ? "observed_depth_exhausted" : "observed_book_only";
          // A clock/quality change during SQL rolls back ALL financial effects.
          now = await clock(tx);
          const currentMarket = {
            ...(await readValuationMarketTx(tx, now)),
            book,
            context: market.context,
            as_of: now,
          };
          const current = await readIsolatedMarginTx(
            tx,
            await readLedgerAccountTx(tx, scope),
            currentMarket,
          );
          requireMargin(
            current.finance.closing.quality === "fresh" &&
              current.finance.maintenance.usable_for_risk &&
              current.isolation.metadata_valid &&
              current.metadata?.object_id === snapshot.metadata?.object_id,
            "EVIDENCE_CHANGED_OR_STALE",
          );
          result.after = current.isolation;
        }
      }
    }
    await storeRetentionObjectTx(tx, {
      id: evidenceId,
      class: "financial",
      identity: scope,
      recordedAt: new Date(now),
      payload: { request, result },
      dependencies: [...deps],
    });
    await pinRetentionObjectTx(
      tx,
      evidenceId,
      evidenceId,
      "paper isolated margin decision, execution and deficit",
    );
    await tx.query(
      "INSERT INTO btc_margin_results(account_id,operation_id,position_id,request,result,evidence_id) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)",
      [
        scope.account_id,
        request.operation_id,
        request.position_id,
        JSON.stringify(request),
        JSON.stringify(result),
        evidenceId,
      ],
    );
    return result;
  });
}
