import { withRisk } from "./riskstore.js";
import { createHash } from "node:crypto";
import {
  assertInstrumentOrderConstraints,
  parseTradingAmount,
  type TradingInstrumentMetadata,
  type TradingMarketData,
  type TradingScope,
} from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import {
  PASSIVE_VERSION,
  PASSIVE_POLICY,
  passiveQueue,
  consumePassiveTrade,
} from "../trading/passive.js";
import type { FeedQualityMachine } from "../trading/feed.js";
import type { CaptureEvidence } from "../trading/bars.js";
import { canonicalFingerprint } from "../trading/replay.js";
import {
  projectFinancials,
  valueFinancials,
  VALUATION_LIMITS,
} from "../trading/valuation.js";
import { lockableLedgerAccountTx, readLedgerAccountTx } from "./ledgerstore.js";
import { applyReservationTx, readReservationsTx } from "./reservationstore.js";
import { readValuationMarketTx } from "./valuationstore.js";
import {
  storeRetentionObjectTx,
  pinRetentionObjectTx,
} from "./btc-retention.js";
import {
  requirePassive,
  validatePassiveCommand,
  type PassiveCommand,
  type PassiveState,
  type PassiveResult,
} from "./passive-contract.js";
const hash = (v: unknown) =>
  createHash("sha256").update(canonicalFingerprint(v)).digest("hex");
const clock = async (tx: SqlExecutor) =>
  (
    await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
  ).rows[0]!.now.toISOString();
class InvalidMarket extends Error {
  readonly reasonCode: string;
  constructor(reason: string) {
    super(reason);
    this.reasonCode = `BTC_PASSIVE_${reason.toUpperCase()}`;
  }
}
type PassiveCapture = CaptureEvidence & {
  health: ReturnType<FeedQualityMachine<TradingMarketData>["status"]>;
};
type Capture = { object_id: string; payload: PassiveCapture };
type Trade = { object_id: string; payload: TradingMarketData };
/** Inert S5 paper library. Retention -> one owner lock, just like IOC. No route,
 * timer or worker. `advance` is ACCOUNT-wide so caller order cannot steal FIFO.
 * IOC and passive accounts are disjoint counterfactual scenarios: snapshot depth
 * cannot be reconciled with later public prints into one real liquidity budget.
 * Cancellation is effective at the serialized DB transition, never backdated.
 * Gap/restart/stale proofs cancel outstanding queues, requiring new acceptance.
 */
export async function applyPassive(
  pool: Pick<DatabasePool, "transaction">,
  scopeInput: TradingScope,
  input: PassiveCommand,
): Promise<PassiveResult> {
  validatePassiveCommand(input);
  const request: PassiveCommand = JSON.parse(JSON.stringify(input)),
    scope = { ...scopeInput };
  return withRisk(
    pool,
    scope,
    true,
  )((tx) => applyPassiveTx(tx, scope, request));
}
/** Same transaction/owner lock as the desk command receipt; never a new pool. */
export async function applyPassiveTx(
  tx: SqlExecutor,
  scopeInput: TradingScope,
  input: PassiveCommand,
): Promise<PassiveResult> {
  validatePassiveCommand(input);
  const request: PassiveCommand = JSON.parse(JSON.stringify(input)),
    scope = { ...scopeInput };
  const identity = await lockableLedgerAccountTx(tx, scope, true);
  const prior = (
    await tx.query(
      "SELECT request,result FROM btc_passive_results WHERE account_id=$1 AND operation_id=$2",
      [scope.account_id, request.operation_id],
    )
  ).rows[0];
  if (prior) {
    requirePassive(
      canonicalFingerprint(prior.request) === canonicalFingerprint(request),
      "IDEMPOTENCY_COLLISION",
    );
    return prior.result as PassiveResult;
  }
  const evidenceId = `btc-passive:${hash([scope, request.operation_id])}`,
    deps = new Set<string>(),
    rows = (
      await tx.query<{ state: PassiveState; evidence_id: string }>(
        `SELECT DISTINCT ON (order_id) state,evidence_id FROM btc_passive_events WHERE account_id=$1 ORDER BY order_id,sequence DESC`,
        [scope.account_id],
      )
    ).rows,
    reservations = await readReservationsTx(tx, scope.account_id);
  for (const row of rows)
    row.state.reservation = reservations.find(
      (r) => r.order.order_id === row.state.reservation.order.order_id,
    )!;
  let sequence = BigInt(
      (
        await tx.query(
          "SELECT COALESCE(MAX(sequence),0)::text n FROM btc_passive_events WHERE account_id=$1",
          [scope.account_id],
        )
      ).rows[0]!.n,
    ),
    now = await clock(tx);
  const result: PassiveResult = {
    schema_version: PASSIVE_VERSION,
    policy: PASSIVE_POLICY,
    fidelity: "low_observed_queue_not_venue_priority",
    market_id: `counterfactual:${scope.account_id}`,
    reason: "accepted",
    orders: [],
    fills: [],
    fee_basis: "public_base_tier_no_discounts",
    account_effective_fee: null,
    evidence_id: evidenceId,
  };
  const claims: Trade[] = [];
  const release = async (s: PassiveState) => {
    if (s.reservation.status !== "active") return;
    now = await clock(tx);
    s.reservation = (
      await applyReservationTx(tx, scope, {
        action: "release",
        operation_id: `passive:${hash([request.operation_id, s.reservation.order.order_id, "release"])}`,
        order_id: s.reservation.order.order_id,
        reason:
          s.reservation.order.valid_until <= now ? "expired" : "cancelled",
      })
    ).reservation;
  };
  const selected = async () => {
    now = await clock(tx);
    const m = await readValuationMarketTx(tx, now),
      capture = (
        await tx.query<Capture>(
          `SELECT r.object_id,o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.kind='capture' AND r.received_at <= $1 ORDER BY r.received_at DESC,r.object_id LIMIT 1`,
          [now],
        )
      ).rows[0];
    if (
      !capture?.payload.session ||
      !Number.isSafeInteger(capture.payload.health.counters.gaps)
    )
      throw new InvalidMarket("capture_unavailable");
    const ledger = await readLedgerAccountTx(tx, scope),
      value = valueFinancials(
        projectFinancials(ledger.projection, ledger.events),
        { ...m, as_of: now },
      ),
      h = capture.payload.health.channels.trades;
    if (value.closing.quality !== "fresh")
      throw new InvalidMarket(`book_${value.closing.quality}`);
    if (
      !h ||
      h.status !== "healthy" ||
      h.needs_revalidation ||
      h.source_quality !== "fresh" ||
      capture.payload.history_truncated
    )
      throw new InvalidMarket("trade_feed_unavailable");
    deps.add(capture.object_id);
    if (m.book) deps.add(m.book.object_id);
    if (m.context) deps.add(m.context.object_id);
    return { ...m, capture: capture.payload, value };
  };
  if (request.action === "cancel" || request.action === "replace") {
    const old = rows.find(
      (r) => r.state.reservation.order.order_id === request.order_id,
    );
    requirePassive(!!old, "ORDER_NOT_FOUND");
    deps.add(old.evidence_id);
    if (request.action === "replace")
      requirePassive(old.state.reservation.status === "active", "ORDER_CLOSED");
    result.reason =
      old.state.reservation.status === "active"
        ? request.action
        : "already_terminal";
    await release(old.state);
    result.orders.push(old.state);
  }
  if (request.action === "submit" || request.action === "replace") {
    requirePassive(
      !(
        await tx.query(
          "SELECT 1 FROM btc_ioc_intents WHERE account_id=$1 LIMIT 1",
          [scope.account_id],
        )
      ).rowCount,
      "SEPARATE_IOC_SCENARIO_REQUIRED",
    );
    const m = await selected(),
      i = request.intent,
      meta = (
        await tx.query(
          "SELECT payload FROM btc_retention_objects WHERE object_id=$1",
          [i.fee_metadata_id],
        )
      ).rows[0]?.payload as TradingInstrumentMetadata | undefined;
    requirePassive(
      !!meta &&
        meta.schema_version === "trading.instrument-metadata.v1" &&
        meta.instrument.instrument_id === scope.instrument_id &&
        meta.instrument.instrument_version === scope.instrument_version &&
        meta.instrument.origin.received_at <= now &&
        meta.fees.basis === "public_base_tier_no_discounts" &&
        meta.fees.maker.unit === "RATE" &&
        meta.fees.maker.decimals === 9 &&
        /^(0|[1-9][0-9]{0,8})$/.test(meta.fees.maker.raw) &&
        BigInt(meta.fees.maker.raw) <= BigInt(request.order.fee_bps) * 100_000n,
      "FEE_METADATA_UNAVAILABLE",
    );
    requirePassive(
      BigInt(i.limit_price_usd_raw) <= BigInt(request.order.price_cap_usd_raw),
      "PRICE_CAP",
    );
    assertInstrumentOrderConstraints(
      meta,
      parseTradingAmount("USD_PER_BTC", {
        unit: "USD_PER_BTC",
        decimals: 6,
        raw: i.limit_price_usd_raw,
      }),
      parseTradingAmount("BTC", {
        unit: "BTC",
        decimals: 8,
        raw: request.order.quantity_btc_raw,
      }),
    );
    requirePassive(m.book?.payload.payload.kind === "book", "BOOK");
    const queue = passiveQueue({
      side: request.order.side,
      limit: i.limit_price_usd_raw,
      ...m.book.payload.payload,
    });
    const reservation = (
      await applyReservationTx(tx, scope, {
        action: "reserve",
        operation_id: `passive:${hash([request.operation_id, "reserve"])}`,
        order: request.order,
      })
    ).reservation;
    // Recheck after reservation work; acceptance excludes every event at or
    // before this final DB clock, including inputs racing the original submit.
    await selected();
    requirePassive(request.order.valid_until > now, "EXPIRED");
    deps.add(i.fee_metadata_id);
    result.orders.push({
      reservation,
      intent: i,
      queue,
      accepted_at: now,
      priority: (sequence + BigInt(result.orders.length) + 1n).toString(),
      fee_rate: meta.fees.maker.raw,
      session: m.capture.session,
      gaps: m.capture.health.counters.gaps,
      book_epoch: m.capture.health.channels.book.gap_epoch,
      trade_epoch: m.capture.health.channels.trades.gap_epoch,
      capture_at: m.capture.at,
    });
  }
  if (request.action === "advance") {
    result.reason = "processed";
    let states = rows
      .filter((r) => r.state.reservation.status === "active")
      .sort((a, b) =>
        BigInt(a.state.priority) < BigInt(b.state.priority) ? -1 : 1,
      )
      .map((r) => {
        deps.add(r.evidence_id);
        return r.state;
      });
    for (const s of states)
      if (s.reservation.order.valid_until <= now) await release(s);
    const terminal = states.filter((s) => s.reservation.status !== "active");
    states = states.filter((s) => s.reservation.status === "active");
    const initial: PassiveState[] = JSON.parse(JSON.stringify(states));
    if (states.length) {
      await tx.query("SAVEPOINT passive_execution");
      try {
        const m = await selected();
        const earliest = Math.min(...states.map((s) => s.capture_at));
        const captures = (
          await tx.query<Capture>(
            `SELECT r.object_id,o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.kind='capture' AND r.received_at >= $1 AND r.received_at <= $2 ORDER BY r.received_at,r.object_id LIMIT 129`,
            [new Date(earliest), now],
          )
        ).rows;
        if (captures.length > 128 || !captures.length)
          throw new InvalidMarket("capture_window_unavailable");
        for (const c of captures) deps.add(c.object_id);
        const guard = async () => {
          const current = await selected();
          for (const s of states) {
            if (s.reservation.order.valid_until <= now)
              throw new InvalidMarket("expired_during_processing");
            if (
              s.reservation.order.intent === "open" &&
              !current.value.maintenance.usable_for_risk
            )
              throw new InvalidMarket("finance_unavailable");
            const check = (c: PassiveCapture) =>
              c.session === s.session &&
              c.health.counters.gaps === s.gaps &&
              c.health.channels.book.gap_epoch === s.book_epoch &&
              c.health.channels.trades.gap_epoch === s.trade_epoch &&
              !c.history_truncated &&
              c.at - c.from <= VALUATION_LIMITS.sourceAgeMs;
            let covered = s.capture_at;
            for (const c of captures.filter(
              (c) => c.payload.at > s.capture_at,
            )) {
              if (c.payload.from > covered)
                throw new InvalidMarket("capture_history_missing");
              covered = c.payload.at;
            }
            if (covered !== current.capture.at)
              throw new InvalidMarket("capture_history_missing");
            if (
              !check(current.capture) ||
              captures.some(
                (c) => c.payload.at >= s.capture_at && !check(c.payload),
              )
            )
              throw new InvalidMarket("queue_gap_or_restart");
          }
        };
        await guard();
        const since = states.map((s) => s.accepted_at).sort()[0]!;
        const trades = (
          await tx.query<Trade>(
            `SELECT r.object_id,o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id)
            WHERE r.kind='trades' AND r.source_at > $1 AND r.received_at <= $2
            AND NOT EXISTS (SELECT 1 FROM btc_passive_trades t WHERE t.account_id=$3 AND t.instrument_id=o.payload->>'instrument_id' AND t.source_at=r.source_at AND t.venue_trade_id=o.payload->'payload'->>'venue_trade_id')
            ORDER BY r.source_at,r.object_id LIMIT 257`,
            [since, now, scope.account_id],
          )
        ).rows;
        if (trades.length > 256)
          throw new InvalidMarket("trade_window_overflow");
        const seen = new Set<string>();
        for (const row of trades) {
          const e = row.payload,
            p = e.payload;
          if (p.kind !== "trade") throw new InvalidMarket("invalid_trade");
          const key = canonicalFingerprint([
            e.instrument_id,
            e.source_timestamp,
            p.venue_trade_id,
          ]);
          if (seen.has(key)) continue;
          seen.add(key);
          deps.add(row.object_id);
          claims.push(row);
          if (
            e.schema_version !== "trading.market-data.v1" ||
            e.instrument_id !== scope.instrument_id ||
            e.instrument_version !== scope.instrument_version ||
            e.channel !== "trades" ||
            e.source_id !== "hyperliquid:mainnet:ws" ||
            e.parser_version !== "hyperliquid.feed.v1" ||
            e.quality !== "fresh" ||
            e.gap_epoch !== m.capture.health.channels.trades.gap_epoch ||
            !e.source_timestamp ||
            e.received_at > now ||
            e.source_timestamp > e.received_at ||
            e.received_at > new Date(m.capture.at).toISOString() ||
            Date.parse(now) - Date.parse(e.source_timestamp) >
              VALUATION_LIMITS.sourceAgeMs
          )
            continue;
          parseTradingAmount("USD_PER_BTC", p.price);
          parseTradingAmount("BTC", p.quantity);
          if (
            !["buy", "sell"].includes(p.side) ||
            !p.venue_trade_id ||
            BigInt(p.quantity.raw) <= 0n ||
            BigInt(p.price.raw) <= 0n
          )
            throw new InvalidMarket("invalid_trade");
          let available: string = p.quantity.raw;
          for (const s of states) {
            if (
              s.reservation.status !== "active" ||
              e.source_timestamp <= s.accepted_at ||
              e.received_at <= s.accepted_at
            )
              continue;
            const consumed = consumePassiveTrade({
              queue: s.queue,
              side: s.reservation.order.side,
              limit: s.intent.limit_price_usd_raw,
              remaining: s.reservation.remaining_btc_raw,
              step: identity.instrument.quantity_step.raw,
              feeRate: s.fee_rate,
              trade: { side: p.side, price: p.price.raw, available },
            });
            s.queue = consumed.queue;
            available = consumed.available;
            if (consumed.quantity !== "0") {
              const fill = {
                order_id: s.reservation.order.order_id,
                trade_id: row.object_id,
                price_usd_raw: s.intent.limit_price_usd_raw,
                quantity_btc_raw: consumed.quantity,
                fee_usd_raw: consumed.fee,
              };
              s.reservation = (
                await applyReservationTx(
                  tx,
                  scope,
                  {
                    action: "consume",
                    operation_id: `passive:${hash([request.operation_id, fill.order_id, fill.trade_id])}`,
                    order_id: fill.order_id,
                    price_usd_raw: fill.price_usd_raw,
                    quantity_btc_raw: fill.quantity_btc_raw,
                    fee_usd_raw: fill.fee_usd_raw,
                  },
                  guard,
                )
              ).reservation;
              result.fills.push(fill);
            }
          }
        }
        await guard();
        for (const s of states) s.capture_at = m.capture.at;
        await tx.query("RELEASE SAVEPOINT passive_execution");
      } catch (error) {
        if (
          !(error instanceof InvalidMarket) &&
          !(
            error instanceof Error &&
            error.message === "BTC_RESERVATION_EXPIRED"
          )
        )
          throw error;
        await tx.query("ROLLBACK TO SAVEPOINT passive_execution");
        states = initial;
        result.fills = [];
        claims.length = 0;
        result.reason = error.message;
        // No stale queue is resurrected on recovery. Expiry/market degradation
        // during SQL rolls back every tentative fill and releases each hold.
        for (const s of states) await release(s);
      }
    }
    result.orders = [...terminal, ...states];
  }
  now = await clock(tx);
  await storeRetentionObjectTx(tx, {
    id: evidenceId,
    class: request.action === "submit" ? "decision" : "financial",
    identity: scope,
    recordedAt: new Date(now),
    payload: { request, result },
    dependencies: [...deps],
  });
  await pinRetentionObjectTx(
    tx,
    evidenceId,
    evidenceId,
    "paper passive queue, fills and fee provenance",
  );
  await tx.query(
    "INSERT INTO btc_passive_results(account_id,operation_id,request,result,evidence_id) VALUES($1,$2,$3::jsonb,$4::jsonb,$5)",
    [
      scope.account_id,
      request.operation_id,
      JSON.stringify(request),
      JSON.stringify(result),
      evidenceId,
    ],
  );
  for (const s of result.orders)
    await tx.query(
      "INSERT INTO btc_passive_events(account_id,sequence,operation_id,order_id,state,evidence_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
      [
        scope.account_id,
        (++sequence).toString(),
        request.operation_id,
        s.reservation.order.order_id,
        JSON.stringify(s),
        evidenceId,
      ],
    );
  for (const t of claims) {
    if (t.payload.payload.kind !== "trade")
      throw new Error("BTC_PASSIVE_TRADE");
    await tx.query(
      "INSERT INTO btc_passive_trades(account_id,instrument_id,source_at,venue_trade_id,observation_id,operation_id,evidence_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        scope.account_id,
        t.payload.instrument_id,
        t.payload.source_timestamp,
        t.payload.payload.venue_trade_id,
        t.object_id,
        request.operation_id,
        evidenceId,
      ],
    );
  }
  return result;
}
