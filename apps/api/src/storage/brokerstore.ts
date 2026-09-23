import { withRisk } from "./riskstore.js";
import { createHash } from "node:crypto";
import {
  assertInstrumentOrderConstraints,
  parseTradingAmount,
  type TradingInstrumentMetadata,
  type TradingScope,
} from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import {
  BROKER_VERSION,
  walkIoc,
  type IocIntent,
  type IocFill,
} from "../trading/broker.js";
import { canonicalFingerprint } from "../trading/replay.js";
import { projectFinancials, valueFinancials } from "../trading/valuation.js";
import type { Reservation } from "../trading/reservations.js";
import { lockableLedgerAccountTx, readLedgerAccountTx } from "./ledgerstore.js";
import { applyReservationTx, readReservationsTx } from "./reservationstore.js";
import { readValuationMarketTx } from "./valuationstore.js";
import {
  storeRetentionObjectTx,
  pinRetentionObjectTx,
} from "./btc-retention.js";
import {
  requireIoc,
  validateIocCommand,
  type IocCommand,
  type IocResult,
} from "./broker-contract.js";
const hash = (v: unknown) =>
  createHash("sha256").update(canonicalFingerprint(v)).digest("hex");
const clock = async (tx: SqlExecutor) =>
  (
    await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
  ).rows[0]!.now.toISOString();
class InvalidExecution extends Error {}
/** S4 internal paper library. No HTTP/worker consumer. Lock order is retention
 * then owner; S1/S3 only take owner and never retention. All effects share one
 * transaction, including IOC remainder, depth accounting and permanent evidence.
 * Waiting is not cached: the same execute operation may be retried after latency.
 */
export async function applyIoc(
  pool: Pick<DatabasePool, "transaction">,
  scopeInput: TradingScope,
  input: IocCommand,
): Promise<IocResult> {
  validateIocCommand(input);
  const request: IocCommand = JSON.parse(JSON.stringify(input)),
    scope = { ...scopeInput };
  return withRisk(
    pool,
    scope,
    true,
  )(async (tx) => {
    const identity = await lockableLedgerAccountTx(tx, scope, true);
    const prior = (
      await tx.query(
        "SELECT request,result FROM btc_ioc_results WHERE account_id=$1 AND operation_id=$2",
        [scope.account_id, request.operation_id],
      )
    ).rows[0];
    if (prior) {
      requireIoc(
        canonicalFingerprint(prior.request) === canonicalFingerprint(request),
        "IDEMPOTENCY_COLLISION",
      );
      return prior.result as IocResult;
    }
    const orderId =
      request.action === "submit" ? request.order.order_id : request.order_id;
    let now = await clock(tx),
      reservation: Reservation;
    const evidenceId = `btc-ioc:${hash([scope, request.operation_id])}`;
    const dependencies = new Set<string>();
    let intent: IocIntent;
    if (request.action === "submit") {
      requireIoc(
        !(
          await tx.query(
            "SELECT 1 FROM btc_passive_events WHERE account_id=$1 LIMIT 1",
            [scope.account_id],
          )
        ).rowCount,
        "SEPARATE_PASSIVE_SCENARIO_REQUIRED",
      );
      intent = request.intent;
      requireIoc(
        intent.decision_at <= now &&
          Date.parse(intent.decision_at) + intent.latency_ms <
            Date.parse(request.order.valid_until),
        "TIME",
      );
      requireIoc(
        BigInt(intent.limit_price_usd_raw) %
          BigInt(identity.instrument.tick_size.raw) ===
          0n &&
          BigInt(intent.limit_price_usd_raw) <=
            BigInt(request.order.price_cap_usd_raw),
        "LIMIT",
      );
      const meta = (
        await tx.query(
          "SELECT payload FROM btc_retention_objects WHERE object_id=$1",
          [intent.fee_metadata_id],
        )
      ).rows[0]?.payload as TradingInstrumentMetadata | undefined;
      requireIoc(
        !!meta &&
          meta.schema_version === "trading.instrument-metadata.v1" &&
          meta.instrument.instrument_id === scope.instrument_id &&
          meta.instrument.instrument_version === scope.instrument_version &&
          meta.instrument.origin.received_at <= intent.decision_at &&
          meta.fees.basis === "public_base_tier_no_discounts" &&
          meta.fees.taker.unit === "RATE" &&
          meta.fees.taker.decimals === 9 &&
          /^(0|[1-9][0-9]{0,8})$/.test(meta.fees.taker.raw) &&
          BigInt(meta.fees.taker.raw) <=
            BigInt(request.order.fee_bps) * 100_000n,
        "FEE_METADATA_UNAVAILABLE",
      );
      assertInstrumentOrderConstraints(
        meta,
        parseTradingAmount("USD_PER_BTC", {
          raw: intent.limit_price_usd_raw,
          unit: "USD_PER_BTC",
          decimals: 6,
        }),
        parseTradingAmount("BTC", {
          raw: request.order.quantity_btc_raw,
          unit: "BTC",
          decimals: 8,
        }),
      );
      reservation = (
        await applyReservationTx(tx, scope, {
          action: "reserve",
          operation_id: `ioc:${request.operation_id}:reserve`,
          order: request.order,
        })
      ).reservation;
      dependencies.add(intent.fee_metadata_id);
      await storeRetentionObjectTx(tx, {
        id: evidenceId,
        class: "decision",
        identity: scope,
        recordedAt: new Date(now),
        payload: { request, market_id: `counterfactual:${scope.account_id}` },
        dependencies: [...dependencies],
      });
      await pinRetentionObjectTx(
        tx,
        evidenceId,
        evidenceId,
        "paper IOC decision and fee provenance",
      );
      await tx.query(
        "INSERT INTO btc_ioc_intents(account_id,order_id,intent,evidence_id) VALUES($1,$2,$3::jsonb,$4)",
        [scope.account_id, orderId, JSON.stringify(intent), evidenceId],
      );
    } else {
      const accepted = (
        await tx.query(
          "SELECT intent,evidence_id FROM btc_ioc_intents WHERE account_id=$1 AND order_id=$2",
          [scope.account_id, orderId],
        )
      ).rows[0];
      requireIoc(!!accepted, "ORDER_NOT_FOUND");
      intent = accepted.intent as IocIntent;
      dependencies.add(accepted.evidence_id);
      reservation = (await readReservationsTx(tx, scope.account_id)).find(
        (r) => r.order.order_id === orderId,
      )!;
    }
    let result: IocResult = {
      schema_version: BROKER_VERSION,
      market_id: `counterfactual:${scope.account_id}`,
      status: "accepted",
      reason: "reserved",
      reservation,
      fills: [],
      book_key: null,
      side: reservation.order.side,
      fee_basis: "public_base_tier_no_discounts",
      account_effective_fee: null,
      evidence_id: evidenceId,
    };
    if (request.action !== "submit") {
      if (reservation.status !== "active") {
        // A different retry/cancel reports effective order state. Do not repeat
        // fills in a second receipt or charge its depth a second time.
        result = {
          ...result,
          status: reservation.status,
          reason: "already_terminal",
        };
      } else if (
        request.action === "execute" &&
        reservation.order.valid_until > now &&
        Date.parse(now) < Date.parse(intent.decision_at) + intent.latency_ms
      ) {
        return {
          ...result,
          status: "waiting",
          reason: "latency",
          evidence_id: null,
        };
      } else {
        let reason =
          request.action === "cancel" ? "requested" : "ioc_remainder";
        let fills: IocFill[] = [];
        if (
          request.action === "execute" &&
          reservation.order.valid_until > now
        ) {
          // Everything attempted after this point can be discarded if expiry,
          // staleness or a gap is observed during processing, even after writes.
          await tx.query("SAVEPOINT ioc_execution");
          const selected = await readValuationMarketTx(tx, now);
          const book = selected.book;
          const meta = (
            await tx.query(
              "SELECT payload FROM btc_retention_objects WHERE object_id=$1",
              [intent.fee_metadata_id],
            )
          ).rows[0]?.payload as TradingInstrumentMetadata;
          const guard = async () => {
            now = await clock(tx);
            if (reservation.order.valid_until <= now)
              throw new InvalidExecution("expired");
            const current = await readValuationMarketTx(tx, now);
            const ledger = await readLedgerAccountTx(tx, scope);
            const value = valueFinancials(
              projectFinancials(ledger.projection, ledger.events),
              { ...current, book, as_of: now },
            );
            if (value.closing.quality !== "fresh")
              throw new InvalidExecution(`book_${value.closing.quality}`);
            if (
              reservation.order.intent === "open" &&
              !value.maintenance.usable_for_risk
            )
              throw new InvalidExecution("finance_unavailable");
            if (
              !book?.payload.source_timestamp ||
              Date.parse(book.payload.source_timestamp) <
                Date.parse(intent.decision_at) + intent.latency_ms ||
              book.payload.received_at < intent.decision_at
            )
              throw new InvalidExecution("book_before_eligible_time");
            if (current.capture) {
              const capture = (
                await tx.query(
                  "SELECT object_id FROM btc_market_records WHERE kind='capture' AND received_at <= $1 ORDER BY received_at DESC,object_id LIMIT 1",
                  [now],
                )
              ).rows[0];
              if (capture) dependencies.add(capture.object_id);
            }
            if (current.context) dependencies.add(current.context.object_id);
          };
          try {
            await guard();
            requireIoc(!!book && book.payload.payload.kind === "book", "BOOK");
            dependencies.add(book.object_id);
            // Object IDs may differ for identical observed depth. Economic book
            // identity omits receipt IDs, metadata versions and account scenario.
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
            ).rows.flatMap((r) => {
              const priorResult = r.result as IocResult;
              return priorResult.side === reservation.order.side
                ? priorResult.fills
                : [];
            });
            fills = walkIoc({
              side: reservation.order.side,
              quantity: reservation.remaining_btc_raw,
              limit: intent.limit_price_usd_raw,
              priceCap: reservation.order.price_cap_usd_raw,
              step: identity.instrument.quantity_step.raw,
              feeRate: meta.fees.taker.raw,
              levels:
                reservation.order.side === "buy"
                  ? book.payload.payload.asks
                  : book.payload.payload.bids,
              consumed: used,
            });
            for (const [index, fill] of fills.entries())
              reservation = (
                await applyReservationTx(
                  tx,
                  scope,
                  {
                    action: "consume",
                    operation_id: `ioc:${request.operation_id}:${index}`,
                    order_id: orderId,
                    ...fill,
                  },
                  guard,
                )
              ).reservation;
            await guard();
            await tx.query("RELEASE SAVEPOINT ioc_execution");
          } catch (error) {
            // S3 also samples the DB clock after the preceding broker guard.
            // Crossing expiry in that interval must terminalize, not strand a hold.
            if (
              !(error instanceof InvalidExecution) &&
              !(
                error instanceof Error &&
                error.message === "BTC_RESERVATION_EXPIRED"
              )
            )
              throw error;
            await tx.query("ROLLBACK TO SAVEPOINT ioc_execution");
            reservation = (await readReservationsTx(tx, scope.account_id)).find(
              (r) => r.order.order_id === orderId,
            )!;
            fills = [];
            result.book_key = null;
            reason = error.message;
          }
        }
        now = await clock(tx);
        if (reservation.status === "active")
          reservation = (
            await applyReservationTx(tx, scope, {
              action: "release",
              operation_id: `ioc:${request.operation_id}:release`,
              order_id: orderId,
              reason:
                reservation.order.valid_until <= now ? "expired" : "cancelled",
            })
          ).reservation;
        result = {
          ...result,
          reservation,
          status: reservation.status as IocResult["status"],
          reason: reservation.status === "expired" ? "expired" : reason,
          fills,
        };
      }
      await storeRetentionObjectTx(tx, {
        id: evidenceId,
        class: "financial",
        identity: scope,
        recordedAt: new Date(now),
        payload: { request, result },
        dependencies: [...dependencies],
      });
      await pinRetentionObjectTx(
        tx,
        evidenceId,
        evidenceId,
        "paper IOC execution and market evidence",
      );
    }
    await tx.query(
      "INSERT INTO btc_ioc_results(account_id,operation_id,order_id,request,result,evidence_id) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)",
      [
        scope.account_id,
        request.operation_id,
        orderId,
        JSON.stringify(request),
        JSON.stringify(result),
        evidenceId,
      ],
    );
    return result;
  });
}
