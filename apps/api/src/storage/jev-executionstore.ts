import {
  assertJevOwnership,
  jevEventKey,
  parseTradingAmount,
  type JevScope,
  type TradingInstrumentMetadata,
  type TradingMarketData,
} from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { consumePassiveTrade, passiveQueue } from "../trading/passive.js";
import { walkIoc } from "../trading/broker.js";
import { projectFinancials, valueFinancials } from "../trading/valuation.js";
import type { CaptureEvidence } from "../trading/bars.js";
import type { FeedQualityMachine } from "../trading/feed.js";
type MarketHealth = ReturnType<FeedQualityMachine<TradingMarketData>["status"]>;
type ExecutionCapture = Omit<CaptureEvidence, "health"> & {
  health: MarketHealth;
};
import { withBtcRetentionTransaction } from "./btc-retention.js";
import { loadJevAccountTx, appendJevLedgerTx } from "./jev-store.js";
import { jevScope, type JevLedgerCommand } from "./jev-ledger.js";
import {
  readJevEntriesTx,
  jevEntryEventTx,
  observeJevRiskTx,
  jevRiskClock,
} from "./jev-riskstore.js";
import { readValuationMarketTx } from "./valuationstore.js";
import { jevHash } from "./jev-hash.js";
import { jevTime } from "./jev-context.js";
import { validateJevManifest, type JevManifest } from "./jev-manifest.js";
import {
  initialJevProtection,
  updateJevPartialProtection,
  jevMandatoryExit,
} from "./jev-protection.js";
import {
  JEV_EXECUTION_VERSION,
  requireExecution as check,
  validateExecutionCommand,
  executionTime,
  quoteJevMaker,
  makerTerminal,
  type JevExecutionCommand,
  type JevExecutionState,
  type JevExecutionResult,
  type JevExecutionFill,
} from "./jev-execution-contract.js";
type Store = Pick<DatabasePool, "transaction">;
type Market = Awaited<ReturnType<typeof readValuationMarketTx>>;
type Ledger = Awaited<ReturnType<typeof loadJevAccountTx>>;
const empty = (now: string): JevExecutionState => ({
  schema_version: JEV_EXECUTION_VERSION,
  observed_at: now,
  maker: null,
  metadata: null,
  protection: null,
  close: null,
  reason: "idle",
});
const abs = (n: bigint) => (n < 0n ? -n : n);
const latency = (m: JevManifest, s: JevScope) =>
  s.mode === "stress"
    ? m.execution.stress_latency_ms
    : m.execution.paper_latency_ms;
const active = (s: JevExecutionState) => s.maker && !makerTerminal(s.maker);
function finance(ledger: Ledger, market: Market, at: string) {
  return valueFinancials(
    projectFinancials(
      {
        ...ledger.projection,
        scope: {
          ...jevScope(
            ledger.identity.bindings[0]!.binding,
            ledger.identity.instrument,
          ),
          mode: "paper",
        },
      },
      ledger.events.map((e) => {
        const p = e.payload;
        switch (p.event_type) {
          case "cash":
          case "fill":
          case "fee":
          case "funding":
          case "liquidation":
            return { sequence: e.sequence, payload: p };
          default:
            throw new Error("JEV_EXECUTION_FINANCIAL_EVENT");
        }
      }),
    ),
    { as_of: at, ...market },
  );
}
function capture(market: Market): ExecutionCapture | null {
  const c = market.capture as ExecutionCapture | null;
  return c &&
    typeof c.session === "string" &&
    Number.isSafeInteger(c.from) &&
    c.from <= c.at &&
    !c.restarted &&
    !c.history_truncated &&
    c.health.channels.trades.status === "healthy" &&
    !c.health.channels.trades.needs_revalidation
    ? c
    : null;
}
async function metadataTx(tx: SqlExecutor, s: JevScope, now: string) {
  const row = (
    await tx.query<{ object_id: string; payload: TradingInstrumentMetadata }>(
      `SELECT r.object_id,o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.kind='metadata' AND r.received_at <= $1 ORDER BY r.received_at DESC,r.object_id LIMIT 1`,
      [now],
    )
  ).rows[0];
  check(
    row &&
      row.payload.schema_version === "trading.instrument-metadata.v1" &&
      row.payload.instrument.instrument_id === s.instrument_id &&
      row.payload.instrument.instrument_version === s.instrument_version &&
      row.payload.instrument.origin.received_at <= now &&
      row.payload.fees.basis === "public_base_tier_no_discounts",
    "METADATA_UNKNOWN",
  );
  for (const fee of [row!.payload.fees.maker, row!.payload.fees.taker]) {
    parseTradingAmount("RATE", fee);
    check(BigInt(fee.raw) >= 0n && BigInt(fee.raw) <= 1000000000n, "FEE_RATE");
  }
  return row!;
}
export async function readJevExecutionTx(
  tx: SqlExecutor,
  id: string,
): Promise<JevExecutionState | null> {
  return (
    (
      await tx.query<{ state: JevExecutionState }>(
        "SELECT state FROM jev_execution_events WHERE account_id=$1 ORDER BY sequence DESC LIMIT 1",
        [id],
      )
    ).rows[0]?.state ?? null
  );
}
/** Library only: JE07 supplies scheduling/leases and JE12 admits accounts.
 * Global retention lock precedes the single financial account lock. Every maker,
 * IOC, fee, reservation release, claim and protection commits atomically. No
 * route/boot hook/signer/admission is installed by this delivery. */
export async function applyJevExecution(
  pool: Store,
  scope: JevScope,
  input: JevExecutionCommand,
): Promise<JevExecutionResult> {
  validateExecutionCommand(input);
  const s = structuredClone(scope),
    request = structuredClone(input);
  check(s.mode !== "live", "LIVE_NOT_ADMITTED");
  return withBtcRetentionTransaction(pool, async (tx) => {
    let ledger = await loadJevAccountTx(tx, s.owner_id, s.account_id, true);
    const pair = ledger.identity.bindings.find(
      (b) => b.binding.experiment_id === s.experiment_id,
    );
    check(pair, "BINDING");
    assertJevOwnership(
      s,
      pair!.binding,
      ledger.identity.account,
      pair!.profile,
      jevScope(pair!.binding, ledger.identity.instrument),
    );
    const saved = (
      await tx.query<{
        request: JevExecutionCommand;
        result: JevExecutionResult;
      }>(
        "SELECT request,result FROM jev_execution_events WHERE account_id=$1 AND operation_id=$2",
        [s.account_id, request.operation_id],
      )
    ).rows[0];
    if (saved) {
      check(
        jevHash(saved.result.state.maker?.plan.input.scope) === jevHash(s),
        "RECEIPT_OWNER",
      );
      check(
        jevHash(saved.request) === jevHash(request),
        "IDEMPOTENCY_COLLISION",
      );
      return saved.result;
    }
    const m = (
      await tx.query<{ manifest: JevManifest }>(
        "SELECT manifest FROM jev_profiles WHERE owner_id=$1 AND profile_id=$2 AND profile_version=$3",
        [s.owner_id, s.profile_id, s.profile_version],
      )
    ).rows[0]!.manifest;
    check(validateJevManifest(m) === pair!.profile.manifest_hash, "MANIFEST");
    const now = await jevRiskClock(tx),
      market = await readValuationMarketTx(tx, now);
    const state = structuredClone(
      (await readJevExecutionTx(tx, s.account_id)) ?? empty(now),
    );
    check(jevTime(now) >= jevTime(state.observed_at), "CLOCK");
    if (state.maker)
      check(
        jevHash(state.maker.plan.input.scope) === jevHash(s),
        "STATE_OWNER",
      );
    state.observed_at = now;
    const meta =
      request.action === "submit"
        ? await metadataTx(tx, s, now)
        : {
            object_id: "persisted-execution-metadata",
            payload: state.metadata,
          };
    check(meta.payload, "NO_EXECUTION_METADATA");
    const executionMeta = meta.payload!;
    const fills: JevExecutionFill[] = [],
      evidence: unknown[] = [{ metadata: meta, market }];
    const entries = await readJevEntriesTx(tx, s.account_id);
    const cancel = (at: string) => {
      const maker = state.maker;
      if (maker && !makerTerminal(maker)) {
        const deadline = executionTime(at, latency(m, s));
        maker.cancel_at =
          maker.cancel_at === null || deadline < maker.cancel_at
            ? deadline
            : maker.cancel_at;
        maker.status = "cancel_pending";
      }
    };
    const release = async () => {
      const maker = state.maker;
      if (
        maker &&
        entries.find((e) => e.order_id === maker.plan.input.order_id)
          ?.status !== "released"
      )
        await jevEntryEventTx(
          tx,
          maker.plan,
          "released",
          `execution-release:${request.operation_id}`,
        );
    };
    const close = (causes: string[], limit: string) => {
      cancel(now);
      if (!state.close || !state.close.pending)
        state.close = {
          requested_at: now,
          arrival_at: executionTime(now, latency(m, s)),
          limit_price_raw: limit,
          causes,
          pending: true,
        };
      else
        state.close.causes = [...new Set([...state.close.causes, ...causes])];
    };
    if (request.action === "submit") {
      const e = entries.find((e) => e.order_id === request.order_id);
      check(
        e &&
          e.status === "reserved" &&
          e.plan_hash === request.plan_hash &&
          jevHash(e.plan) === request.plan_hash,
        "RESERVATION",
      );
      check(
        !active(state) &&
          (!state.protection || state.protection.quantity_btc_raw === "0") &&
          (!state.close || !state.close.pending) &&
          ledger.projection.positions.every((p) => p.quantity_btc_raw === "0"),
        "NO_PYRAMID_OR_REVERSE",
      );
      const p = e!.plan,
        side = p.input.direction === "long" ? "buy" : "sell";
      check(
        p.input.scope.account_id === s.account_id &&
          jevHash(p.input.scope) === jevHash(s) &&
          p.manifest_hash === pair!.profile.manifest_hash &&
          now >= p.input.decision_at &&
          jevTime(now) - jevTime(p.input.decision_at) <=
            m.freshness.decision_ttl_ms,
        "DECISION_STALE_OR_OWNER",
      );
      const observed = await observeJevRiskTx(tx, s.owner_id, s.account_id);
      check(!observed.checkpoint.entries_paused, "RISK_PAUSED");
      const book = market.book?.payload.payload;
      check(
        observed.finance.closing.quality === "fresh" &&
          book?.kind === "book" &&
          capture(market),
        "QUOTE_UNAVAILABLE",
      );
      if (book?.kind !== "book") throw new Error("JEV_EXECUTION_BOOK");
      check(
        quoteJevMaker(
          side,
          book.bids[0]!.price.raw,
          book.asks[0]!.price.raw,
          executionMeta,
        ) === p.input.entry_price_raw &&
          BigInt(p.input.maker_fee_rate9_raw!) >=
            BigInt(executionMeta.fees.maker.raw) &&
          BigInt(p.input.exit_fee_rate9_raw!) >=
            BigInt(executionMeta.fees.taker.raw),
        "PLAN_PRICE_OR_COST_CHANGED",
      );
      await tx.query(
        "INSERT INTO jev_execution_orders(account_id,order_id,decision_id,plan_hash) VALUES($1,$2,$3,$4)",
        [
          s.account_id,
          p.input.order_id,
          p.input.decision_id,
          request.plan_hash,
        ],
      );
      state.maker = {
        plan: p,
        plan_hash: request.plan_hash,
        sent_at: now,
        arrival_at: executionTime(now, latency(m, s)),
        ack_at: null,
        expires_at: null,
        cancel_at: null,
        status: "sent",
        filled_btc_raw: "0",
        queue: null,
        session: null,
        book_epoch: null,
        trade_epoch: null,
        coverage_at: null,
        latest_trade_at: null,
      };
      state.metadata = executionMeta;
      state.protection = null;
      state.close = null;
      state.reason = "sent_before_arrival";
    } else {
      if (request.action === "recover") {
        cancel(now);
        state.reason = "restart_priority_invalidated";
      }
      if (request.action === "cancel") cancel(now);
      if (request.action === "close") {
        check(
          state.protection && BigInt(state.protection.quantity_btc_raw) > 0n,
          "NO_POSITION",
        );
        close(["JEV_OR_OPERATOR_CLOSE"], request.limit_price_raw);
      }
      if (state.maker && !makerTerminal(state.maker)) {
        const maker = state.maker,
          entry = entries.find((e) => e.order_id === maker.plan.input.order_id);
        if (entry?.status === "cancel_requested") cancel(now);
        if (maker.expires_at && now >= maker.expires_at)
          cancel(maker.expires_at);
        const f = finance(ledger, market, now),
          c = capture(market),
          book = market.book?.payload;
        // Delayed ACK uses a fresh book with a source time at/after arrival.
        if (
          !maker.ack_at &&
          now >= maker.arrival_at &&
          maker.status === "sent"
        ) {
          if (
            f.closing.quality !== "fresh" ||
            !c ||
            !book?.source_timestamp ||
            book.source_timestamp > book.received_at ||
            book.received_at > now ||
            book.source_timestamp < maker.arrival_at ||
            book.payload.kind !== "book"
          ) {
            cancel(now);
            state.reason = "arrival_book_unknown";
          } else {
            try {
              maker.queue = passiveQueue({
                side: maker.plan.input.direction === "long" ? "buy" : "sell",
                limit: maker.plan.input.entry_price_raw,
                ...book.payload,
              });
              maker.ack_at = now;
              maker.expires_at = executionTime(
                now,
                m.execution.maker_wait_after_ack_ms,
              );
              maker.status = "resting";
              maker.session = c.session;
              maker.book_epoch = c.health.channels.book.gap_epoch;
              maker.trade_epoch = c.health.channels.trades.gap_epoch;
              maker.coverage_at = c.at;
              state.reason = "acknowledged";
            } catch (error) {
              maker.status = "rejected";
              state.reason =
                error instanceof Error ? error.message : "post_only_rejected";
              await release();
            }
          }
        }
        if (maker.ack_at && maker.queue && !makerTerminal(maker)) {
          const captures = (
            await tx.query<{ payload: ExecutionCapture }>(
              `SELECT o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.kind='capture' AND r.received_at >= $1 AND r.received_at <= $2 ORDER BY r.received_at,r.object_id LIMIT 257`,
              [new Date(maker.coverage_at!), now],
            )
          ).rows.map((r) => r.payload);
          let covered = maker.coverage_at!;
          const valid = (x: ExecutionCapture) =>
            Number.isSafeInteger(x.from) &&
            x.from <= x.at &&
            x.at - x.from <= 10000 &&
            typeof x.session === "string" &&
            x.session === maker.session &&
            !x.restarted &&
            !x.history_truncated &&
            x.health.socket.connected &&
            x.health.socket.alive &&
            ["book", "trades"].every((k) => {
              const ch = x.health.channels[k as "book" | "trades"];
              return (
                ch.status === "healthy" &&
                !ch.needs_revalidation &&
                ch.gap_epoch ===
                  (k === "book" ? maker.book_epoch : maker.trade_epoch)
              );
            });
          let complete =
            captures.length > 0 &&
            captures.length <= 256 &&
            c !== null &&
            f.closing.quality === "fresh" &&
            valid(c);
          for (const x of captures) {
            if (!valid(x) || x.from > covered) complete = false;
            covered = Math.max(covered, x.at);
          }
          complete &&= covered === c?.at;
          evidence.push({ captures });
          if (!complete || request.action === "recover") {
            cancel(now);
            state.reason = "queue_continuity_lost";
            maker.queue = null;
          } else {
            const until =
              maker.cancel_at && maker.cancel_at < now ? maker.cancel_at : now;
            const trades = (
              await tx.query<{ object_id: string; payload: TradingMarketData }>(
                `SELECT r.object_id,o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.kind='trades' AND r.source_at > $1 AND r.source_at < $2 AND r.received_at <= $3 ORDER BY r.source_at,r.object_id LIMIT 65`,
                [maker.ack_at, executionTime(until, 1), now],
              )
            ).rows;
            // Never discard an overflow and claim reconciliation.
            check(trades.length <= 64, "TRADE_WINDOW_OVERFLOW");
            for (const t of trades) {
              const e = t.payload,
                p = e.payload;
              check(p.kind === "trade", "TRADE_KIND");
              if (p.kind !== "trade") continue;
              const key = `trade:${jevHash([e.instrument_id, e.source_timestamp, p.venue_trade_id])}`;
              if (
                (
                  await tx.query(
                    "SELECT 1 FROM jev_liquidity_claims WHERE account_id=$1 AND liquidity_key=$2",
                    [s.account_id, key],
                  )
                ).rowCount
              )
                continue;
              if (
                e.source_id !== "hyperliquid:mainnet:ws" ||
                e.parser_version !== "hyperliquid.feed.v1" ||
                e.instrument_id !== s.instrument_id ||
                e.instrument_version !== s.instrument_version ||
                e.quality !== "fresh" ||
                e.gap_epoch !== maker.trade_epoch ||
                !e.source_timestamp ||
                e.source_timestamp > e.received_at ||
                e.received_at <= maker.ack_at ||
                e.received_at > now ||
                e.source_timestamp <= maker.ack_at ||
                e.source_timestamp > until
              )
                continue;
              parseTradingAmount("BTC", p.quantity);
              parseTradingAmount("USD_PER_BTC", p.price);
              check(
                BigInt(p.quantity.raw) > 0n &&
                  BigInt(p.price.raw) > 0n &&
                  ["buy", "sell"].includes(p.side),
                "TRADE_AMOUNTS",
              );
              if (
                maker.latest_trade_at &&
                e.source_timestamp < maker.latest_trade_at
              ) {
                // A late print cannot be inserted behind fills already committed
                // using later priority evidence. Cancel instead of replaying it.
                cancel(now);
                maker.queue = null;
                state.reason = "late_trade_priority_unknown";
                break;
              }
              const consumed = consumePassiveTrade({
                queue: maker.queue!,
                side: maker.plan.input.direction === "long" ? "buy" : "sell",
                limit: maker.plan.input.entry_price_raw,
                remaining: (
                  BigInt(maker.plan.quantity_btc_raw) -
                  BigInt(maker.filled_btc_raw)
                ).toString(),
                step: executionMeta.instrument.quantity_step.raw,
                feeRate: (
                  BigInt(executionMeta.fees.maker.raw) *
                  (s.mode === "stress" ? 2n : 1n)
                ).toString(),
                trade: {
                  side: p.side,
                  price: p.price.raw,
                  available: p.quantity.raw,
                },
              });
              maker.queue = consumed.queue;
              await tx.query(
                "INSERT INTO jev_liquidity_claims(account_id,liquidity_key,operation_id,quantity_raw,capacity_raw,original) VALUES($1,$2,$3,$4,$4,$5::jsonb)",
                [
                  s.account_id,
                  key,
                  request.operation_id,
                  p.quantity.raw,
                  JSON.stringify(t),
                ],
              );
              evidence.push(t);
              // Even queue burn invalidates older IOC depth; it cannot consume
              // the displayed volume that this very print already removed.
              maker.latest_trade_at = e.source_timestamp;
              if (consumed.quantity !== "0") {
                maker.filled_btc_raw = (
                  BigInt(maker.filled_btc_raw) + BigInt(consumed.quantity)
                ).toString();
                const f: JevExecutionFill = {
                  kind: "maker",
                  liquidity_key: key,
                  execution_id: `jev-fill:${jevHash([s.account_id, maker.plan.input.order_id, key])}`,
                  order_id: maker.plan.input.order_id,
                  position_id: maker.plan.input.order_id,
                  side: maker.plan.input.direction === "long" ? "buy" : "sell",
                  occurred_at: e.source_timestamp,
                  quantity_btc_raw: consumed.quantity,
                  price_usd_raw: maker.plan.input.entry_price_raw,
                  fee_usd_raw: consumed.fee,
                };
                fills.push(f);
                state.protection = state.protection
                  ? updateJevPartialProtection(
                      state.protection,
                      {
                        scope: s,
                        position_id: f.position_id,
                        occurred_at: f.occurred_at,
                        quantity_btc_raw: f.quantity_btc_raw,
                      },
                      executionMeta,
                    )
                  : initialJevProtection(
                      m,
                      {
                        scope: s,
                        position_id: f.position_id,
                        direction: maker.plan.input.direction,
                        first_fill_at: f.occurred_at,
                        first_fill_price_raw: f.price_usd_raw,
                        quantity_btc_raw: f.quantity_btc_raw,
                        atr14_raw: maker.plan.input.atr14_raw,
                        atr_captured_at: maker.plan.input.atr_captured_at,
                        decision_at: maker.plan.input.decision_at,
                      },
                      executionMeta,
                    );
              }
            }
            maker.coverage_at = c!.at;
            if (maker.filled_btc_raw === maker.plan.quantity_btc_raw) {
              maker.status = "filled";
              await release();
            }
          }
        }
        if (
          !makerTerminal(maker) &&
          maker.cancel_at &&
          now >= maker.cancel_at
        ) {
          maker.status = "cancelled";
          state.reason = "cancel_reconciled";
          await release();
        }
      }
      // Risk observes committed/tentative fills under this same account lock.
      // Keep the ledger and protection in sync before taking any reduction.
      await appendFills(
        tx,
        ledger,
        s,
        request.operation_id,
        "maker",
        fills.filter((f) => f.kind === "maker"),
      );
      ledger = await loadJevAccountTx(tx, s.owner_id, s.account_id);
      await reconcileExecutionTx(tx, s, ledger, now, request.operation_id);
      const risk = await observeJevRiskTx(tx, s.owner_id, s.account_id),
        value = finance(ledger, market, now);
      if (risk.checkpoint.cancel_entries) cancel(now);
      if (state.protection && BigInt(state.protection.quantity_btc_raw) > 0n) {
        const exit = jevMandatoryExit(m, state.protection, {
          now_at: now,
          mark_price_raw: value.maintenance.mark_price?.raw ?? null,
          mark_at: value.maintenance.freshness_timestamp,
          protection_confirmed: true,
          risk_blocked: risk.checkpoint.request_close,
        });
        if (exit.request_close)
          close(exit.reasons, state.maker!.plan.worst_exit_price_raw);
      }
      if (
        state.close?.pending &&
        now >= state.close.arrival_at &&
        state.protection
      ) {
        const book = market.book?.payload,
          p = state.protection;
        const side = p.direction === "long" ? "sell" : "buy";
        if (
          value.closing.quality === "fresh" &&
          book?.payload.kind === "book" &&
          book.source_timestamp &&
          book.source_timestamp <= book.received_at &&
          book.received_at <= now &&
          book.source_timestamp >= state.close.arrival_at &&
          (!state.maker?.latest_trade_at ||
            book.source_timestamp > state.maker.latest_trade_at)
        ) {
          const levels = side === "buy" ? book.payload.asks : book.payload.bids;
          const key = `book:${jevHash([book.instrument_id, book.source_timestamp, book.gap_epoch, capture(market)?.session, side])}`;
          const used = (
            await tx.query<{
              price_usd_raw: string;
              quantity_btc_raw: string;
            }>(
              "SELECT original->>'price_usd_raw' AS price_usd_raw,quantity_raw::text AS quantity_btc_raw FROM jev_liquidity_claims WHERE account_id=$1 AND liquidity_key LIKE $2",
              [s.account_id, key + ":%"],
            )
          ).rows;
          const current =
            ledger.projection.positions.find(
              (x) => x.position_id === p.position_id,
            )?.quantity_btc_raw ?? "0";
          check(
            abs(BigInt(current)).toString() === p.quantity_btc_raw &&
              (BigInt(current) === 0n ||
                BigInt(current) > 0n === (p.direction === "long")),
            "POSITION_RECONCILIATION",
          );
          const walked = walkIoc({
            side,
            quantity: p.quantity_btc_raw,
            limit: state.close.limit_price_raw,
            priceCap: "99999999999999999999999999999999999999",
            step: executionMeta.instrument.quantity_step.raw,
            feeRate: (
              BigInt(executionMeta.fees.taker.raw) *
              (s.mode === "stress" ? 2n : 1n)
            ).toString(),
            levels,
            consumed: used,
          });
          for (const [i, f] of walked.entries()) {
            const claim = key + ":" + f.price_usd_raw;
            const result: JevExecutionFill = {
              ...f,
              kind: "IOC",
              liquidity_key: claim,
              execution_id: `jev-fill:${jevHash([s.account_id, request.operation_id, i])}`,
              order_id: `jev-exit:${jevHash([s.account_id, request.operation_id])}`,
              position_id: p.position_id,
              side,
              occurred_at: now,
            };
            await tx.query(
              "INSERT INTO jev_liquidity_claims(account_id,liquidity_key,operation_id,quantity_raw,capacity_raw,original) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
              [
                s.account_id,
                claim,
                request.operation_id,
                f.quantity_btc_raw,
                levels.find((l) => l.price.raw === f.price_usd_raw)!.quantity
                  .raw,
                JSON.stringify({ ...result, book }),
              ],
            );
            p.quantity_btc_raw = (
              BigInt(p.quantity_btc_raw) - BigInt(f.quantity_btc_raw)
            ).toString();
            fills.push(result);
          }
          state.reason = walked.length
            ? "reduce_only_executed"
            : "residual_liquidity_pending";
          await appendFills(
            tx,
            ledger,
            s,
            request.operation_id,
            "IOC",
            fills.filter((f) => f.kind === "IOC"),
          );
          ledger = await loadJevAccountTx(tx, s.owner_id, s.account_id);
          await reconcileExecutionTx(
            tx,
            s,
            ledger,
            now,
            request.operation_id + ":IOC",
          );
          await observeJevRiskTx(tx, s.owner_id, s.account_id);
        } else state.reason = "exit_book_unknown_or_before_arrival";
        // Each IOC remainder is cancelled. The close obligation persists and
        // a fresh attempt waits its own latency, never closes at last price.
        if (state.protection.quantity_btc_raw === "0" && !active(state))
          state.close.pending = false;
        else state.close.arrival_at = executionTime(now, latency(m, s));
      }
    }
    ledger = await loadJevAccountTx(tx, s.owner_id, s.account_id);
    const actual = ledger.projection.positions.filter(
      (p) => p.quantity_btc_raw !== "0",
    );
    check(
      actual.length <= 1 &&
        (!actual.length
          ? !state.protection || state.protection.quantity_btc_raw === "0"
          : state.protection &&
            actual[0]!.position_id === state.protection.position_id &&
            abs(BigInt(actual[0]!.quantity_btc_raw)).toString() ===
              state.protection.quantity_btc_raw),
      "UNPROTECTED_LEDGER",
    );
    const result: JevExecutionResult = {
      fidelity: "low_observed_queue_not_venue_priority",
      state,
      fills,
      reconciled_flat: actual.length === 0 && !active(state),
    };
    // Slow SQL cannot give an old quote a fresh execution timestamp. Roll back
    // every tentative effect if market freshness was lost before commit.
    const commitAt = await jevRiskClock(tx);
    if (
      fills.length ||
      request.action === "submit" ||
      state.maker?.ack_at === now
    )
      check(
        finance(ledger, market, commitAt).closing.quality === "fresh",
        "MARKET_CHANGED_BEFORE_COMMIT",
      );
    await tx.query(
      `INSERT INTO jev_execution_events(account_id,owner_id,mode,profile_id,profile_version,experiment_id,sequence,operation_id,request,state,result,evidence)
    SELECT $1,$2,$3,$4,$5,$6,COALESCE(MAX(sequence),0)+1,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb FROM jev_execution_events WHERE account_id=$1`,
      [
        s.account_id,
        s.owner_id,
        s.mode,
        s.profile_id,
        s.profile_version,
        s.experiment_id,
        request.operation_id,
        JSON.stringify(request),
        JSON.stringify(state),
        JSON.stringify(result),
        JSON.stringify(evidence),
      ],
    );
    return result;
  });
}
async function appendFills(
  tx: SqlExecutor,
  ledger: Ledger,
  s: JevScope,
  operation: string,
  kind: string,
  fills: JevExecutionFill[],
) {
  if (!fills.length) return;
  const events: JevLedgerCommand[] = [];
  for (const f of fills) {
    const command = (
      suffix: string,
      payload: JevLedgerCommand["payload"],
    ): JevLedgerCommand => ({
      ...s,
      event_id: `${f.execution_id}:${suffix}`,
      idempotency_key: jevEventKey(s, `${f.execution_id}:${suffix}`),
      cause_id: f.order_id,
      occurred_at: f.occurred_at as JevLedgerCommand["occurred_at"],
      payload,
    });
    events.push(
      command("fill", {
        event_type: "fill",
        execution_id: f.execution_id,
        order_id: f.order_id,
        position_id: f.position_id,
        side: f.side,
        quantity: parseTradingAmount("BTC", {
          unit: "BTC",
          decimals: 8,
          raw: f.quantity_btc_raw,
        }),
        price: parseTradingAmount("USD_PER_BTC", {
          unit: "USD_PER_BTC",
          decimals: 6,
          raw: f.price_usd_raw,
        }),
      }),
    );
    if (f.fee_usd_raw !== "0")
      events.push(
        command("fee", {
          event_type: "fee",
          execution_id: f.execution_id,
          delta: parseTradingAmount("USD", {
            unit: "USD",
            decimals: 6,
            raw: `-${f.fee_usd_raw}`,
          }),
        }),
      );
  }
  await appendJevLedgerTx(tx, ledger.identity, ledger.events, {
    transaction_id: `jev-execution:${jevHash([s.account_id, operation, kind])}`,
    events,
  });
}

/** Paper execution has no external financial ACK. Reconcile only the ledger
 * changes produced here, retaining the existing funding boundary attestation.
 * A missing funding proof cannot be manufactured by a fill or an HTTP price. */
async function reconcileExecutionTx(
  tx: SqlExecutor,
  s: JevScope,
  ledger: Ledger,
  now: string,
  operation: string,
) {
  const previous = (
    await tx.query<{
      ledger_sequence: string;
      funding_through_at: Date;
      request: unknown;
    }>(
      "SELECT ledger_sequence::text,funding_through_at,request FROM jev_risk_reconciliations WHERE account_id=$1 ORDER BY recorded_at DESC,operation_id DESC LIMIT 1",
      [s.account_id],
    )
  ).rows[0];
  if (
    !previous ||
    previous.funding_through_at.getTime() <
      Math.floor(jevTime(now) / 3600000) * 3600000
  )
    return;
  const from = BigInt(previous.ledger_sequence);
  if (
    ledger.events.some(
      (e) =>
        BigInt(e.sequence) > from &&
        !e.transaction_id.startsWith("jev-execution:"),
    )
  )
    return;
  const request = {
    operation_id: `execution:${jevHash(operation)}`,
    ledger_sequence: ledger.projection.last_sequence,
    observed_at: now,
    funding_through_at: previous.funding_through_at.toISOString(),
    evidence: {
      execution_operation: operation,
      previous_sequence: previous.ledger_sequence,
      funding_boundary: previous.funding_through_at.toISOString(),
    },
  };
  await tx.query(
    "INSERT INTO jev_risk_reconciliations(account_id,operation_id,ledger_sequence,observed_at,funding_through_at,request) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
    [
      s.account_id,
      request.operation_id,
      request.ledger_sequence,
      now,
      request.funding_through_at,
      JSON.stringify(request),
    ],
  );
}
