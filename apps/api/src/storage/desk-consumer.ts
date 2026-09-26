import { consumeBaselineAccount } from "./baseline-runtime.js";
import { createHash, randomUUID } from "node:crypto";
import type { DatabasePool, SqlExecutor } from "../database.js";
import type { LedgerIdentity } from "./ledger-contract.js";
import { ledgerScope } from "../trading/ledger.js";
import { withDeskWorker } from "./desk-worker.js";
import { riskTransaction, observeRiskTx } from "./riskstore.js";
import { readReservationsTx } from "./reservationstore.js";
import { applyIocTx } from "./brokerstore.js";
import { applyPassiveTx } from "./passivestore.js";
import { liquidateIsolatedPosition } from "./marginstore.js";
import { readIsolatedMarginTx } from "./valuationstore.js";
import { reconcileFunding, paperFundingOracleTx } from "./fundingstore.js";
import {
  fetchFinalBtcFunding,
  FUNDING_SOURCE,
} from "../venues/hyperliquid/funding.js";

import { PAPER_FUNDING_MODEL } from "../trading/funding.js";

const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
type Pool = Pick<DatabasePool, "transaction" | "readOnly">;
type Control = {
  identity: LedgerIdentity;
  broker: "ioc" | "passive";
  latency_ms: number;
};
async function control(
  tx: SqlExecutor,
  account: string,
  funding = false,
): Promise<Control> {
  const row = (
    await tx.query<Control>(
      `SELECT a.identity,c.broker,c.latency_ms
    FROM btc_desk_controls c JOIN btc_ledger_accounts a USING(account_id) WHERE c.account_id=$1`,
      [account],
    )
  ).rows[0];
  if (
    !row ||
    row.identity.account.mode !== "paper" ||
    !(
      row.identity.account.purpose === "manual" ||
      (funding &&
        ["baseline", "challenger"].includes(row.identity.account.purpose))
    )
  )
    throw new Error("BTC_DESK_MANUAL_REQUIRED");
  return row;
}
export async function consumeDeskAccount(pool: Pool, account: string) {
  const c = await pool.readOnly(1500, (tx) => control(tx, account));
  const scope = ledgerScope(c.identity);
  return withDeskWorker(pool, account, async (worker) => {
    const liquidations = await riskTransaction(
      worker,
      scope,
      async (tx) => {
        await control(tx, account);
        const capture =
          (
            await tx.query<{ object_id: string }>(
              "SELECT object_id FROM btc_market_records WHERE kind='capture' ORDER BY received_at DESC,object_id LIMIT 1",
            )
          ).rows[0]?.object_id ?? null;
        const holdings = (
          await tx.query<{ active: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM btc_desk_orders WHERE account_id=$1 AND reservation->>'status'='active')
        OR EXISTS(SELECT 1 FROM btc_ledger_projections WHERE account_id=$1 AND EXISTS
          (SELECT 1 FROM jsonb_array_elements(desk_projection->'finance'->'positions') p WHERE p->>'quantity_btc_raw' <> '0')) AS active`,
            [account],
          )
        ).rows[0]!.active;
        const liquidate: string[] = [];
        if (holdings) {
          // Admission, risk, execution, durable stops and heartbeat share one fence.
          const observed = await observeRiskTx(tx, scope);
          const { finance, market, bookFresh, checkpoint, ledger } = observed;
          const orders = await readReservationsTx(tx, account);
          const { isolation, metadata } = await readIsolatedMarginTx(
            tx,
            ledger,
            market,
          );
          for (const position of finance.positions.filter(
            (p) => p.quantity_btc_raw !== "0",
          )) {
            const q = BigInt(position.quantity_btc_raw),
              side = q > 0n ? "sell" : "buy";
            const book = market.book?.payload.payload;
            const levels =
              book?.kind === "book"
                ? side === "sell"
                  ? book.bids
                  : book.asks
                : [];
            const entry = orders.find(
              (r) =>
                r.order.position_id === position.position_id &&
                r.order.intent === "open",
            );
            const stop = entry?.order.risk_plan?.stop_price_usd_raw;
            const crossed =
              bookFresh &&
              stop &&
              levels[0] &&
              (q > 0n
                ? BigInt(levels[0].price.raw) <= BigInt(stop)
                : BigInt(levels[0].price.raw) >= BigInt(stop));
            const riskExit = checkpoint.reasons.some((r) =>
              ["daily_loss", "drawdown", "exposure_limit"].includes(r),
            );
            if (crossed || riskExit)
              await tx.query(
                `INSERT INTO btc_desk_exits(account_id,position_id,reason)
            VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
                [
                  account,
                  position.position_id,
                  crossed ? "stop_price" : "risk_limit",
                ],
              );
            if (
              isolation.positions.find(
                (p) => p.position_id === position.position_id,
              )?.liquidatable
            ) {
              liquidate.push(position.position_id);
              continue;
            }
            const exit =
              (
                await tx.query(
                  "SELECT 1 FROM btc_desk_exits WHERE account_id=$1 AND position_id=$2",
                  [account, position.position_id],
                )
              ).rowCount > 0;
            if (
              !exit ||
              !bookFresh ||
              !metadata ||
              !levels.length ||
              checkpoint.state === "HALTED"
            )
              continue;
            // Cancel the remaining entry before reducing; reductions cannot invert.
            for (const r of orders.filter(
              (r) => r.status === "active" && r.order.intent === "open",
            )) {
              const cmd = {
                action: "cancel" as const,
                operation_id: `exit-cancel:${hash(r.order.order_id)}`,
                order_id: r.order.order_id,
              };
              if (c.broker === "ioc") await applyIocTx(tx, scope, cmd);
              else await applyPassiveTx(tx, scope, cmd);
            }
            const pending = (await readReservationsTx(tx, account)).some(
              (r) =>
                r.status === "active" &&
                r.order.intent === "reduce" &&
                r.order.position_id === position.position_id,
            );
            if (pending) continue;
            const orderId = `exit:${hash([position.position_id, market.book!.object_id])}`;
            if (orders.some((r) => r.order.order_id === orderId)) continue;
            const limit = levels.at(-1)!.price.raw;
            const cap = side === "buy" ? limit : levels[0]!.price.raw;
            const fee = Number(
              (BigInt(metadata.payload.fees.taker.raw) + 99999n) / 100000n,
            );
            await applyIocTx(tx, scope, {
              action: "submit",
              operation_id: orderId,
              order: {
                schema_version: "btc.reservations.v1",
                order_id: orderId,
                position_id: position.position_id,
                source: "manual",
                intent: "reduce",
                side,
                quantity_btc_raw: (q < 0n ? -q : q).toString(),
                price_cap_usd_raw: cap,
                fee_bps: fee,
                margin_policy: "full_notional_v1",
                valid_until: new Date(
                  Date.parse(checkpoint.observed_at) + 10000,
                ).toISOString(),
              },
              intent: {
                schema_version: "btc.ioc.v1",
                decision_at: checkpoint.observed_at,
                latency_ms: c.latency_ms,
                limit_price_usd_raw: limit,
                fee_metadata_id: metadata.object_id,
              },
            });
          }
          // Execute only with a post-latency observed book. Polling an older book
          // must not terminalize an otherwise valid IOC before its first chance.
          const active = await tx.query<{
            order_id: string;
            intent: { decision_at: string; latency_ms: number };
            valid_until: string;
          }>(
            `SELECT a.order_id,a.intent,r.reservation->'order'->>'valid_until' AS valid_until
          FROM btc_ioc_intents a JOIN btc_desk_orders r USING(account_id,order_id)
          WHERE a.account_id=$1 AND r.reservation->>'status'='active'`,
            [account],
          );
          for (const r of active.rows) {
            if (
              r.valid_until > checkpoint.observed_at &&
              (!bookFresh ||
                !market.book?.payload.source_timestamp ||
                Date.parse(market.book.payload.source_timestamp) <
                  Date.parse(r.intent.decision_at) + r.intent.latency_ms)
            )
              continue;
            await applyIocTx(tx, scope, {
              action: "execute",
              operation_id: `execute:${hash(r.order_id)}`,
              order_id: r.order_id,
            });
          }
          if (
            c.broker === "passive" &&
            orders.some((r) => r.status === "active")
          )
            await applyPassiveTx(tx, scope, {
              action: "advance",
              operation_id: `advance:${randomUUID()}`,
            });
        }
        await tx.query(
          `INSERT INTO btc_desk_runtime(account_id,ready,reason,capture_id) VALUES($1,true,'operational',$2)
        ON CONFLICT(account_id) DO UPDATE SET observed_at=clock_timestamp(),ready=true,reason='operational',capture_id=EXCLUDED.capture_id`,
          [account, capture],
        );
        return liquidate;
      },
      true,
    );
    for (const position_id of liquidations)
      await liquidateIsolatedPosition(worker, scope, {
        position_id,
        operation_id: `liquidation:${randomUUID()}`,
      });
  });
}

/** One free public history request per cycle (>=30s). Explicit paper model;
 * no future context, inferred price timestamp or silent exact-oracle fallback. */
export async function fundDeskAccount(
  pool: Pool,
  account: string,
  fetchFunding = fetchFinalBtcFunding,
) {
  const c = await pool.readOnly(1500, (tx) => control(tx, account, true));
  if (c.identity.experiment.started_at > new Date().toISOString()) return;
  const hour = await pool.readOnly(1500, async (tx) => {
    const row = (
      await tx.query<{ hour: Date }>(
        `SELECT h AS hour FROM generate_series(
      COALESCE((SELECT date_trunc('hour',MIN((event->>'occurred_at')::timestamptz)) FROM btc_ledger_events WHERE account_id=$1 AND event_type='fill'),date_trunc('hour',clock_timestamp())),
      date_trunc('hour',clock_timestamp()),interval '1 hour') h
      WHERE NOT EXISTS(SELECT 1 FROM btc_funding_results WHERE account_id=$1 AND result->>'period_hour'=to_char(h AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND result->>'status' IN ('settled','conflict'))
      ORDER BY h LIMIT 1`,
        [account],
      )
    ).rows[0];
    return row?.hour.toISOString();
  });
  if (!hour) return;
  const response = await fetchFunding(hour);
  if (response.rows.length > 1) throw new Error("BTC_DESK_FUNDING_AMBIGUOUS");
  const row = response.rows[0] ?? null;
  const oracle = row
    ? await pool.readOnly(
        1500,
        async (tx) =>
          (
            await paperFundingOracleTx(
              tx,
              ledgerScope(c.identity),
              new Date(row.time).toISOString(),
            )
          )?.object_id ?? null,
      )
    : null;
  // Stable content identity avoids unbounded pending receipts when evidence is unchanged.
  const operation_id = `funding:${hash([PAPER_FUNDING_MODEL, hour, row, oracle])}`;
  const prior = await pool.readOnly(1500, (tx) =>
    tx.query(
      "SELECT 1 FROM btc_funding_results WHERE account_id=$1 AND operation_id=$2",
      [account, operation_id],
    ),
  );
  if (prior.rowCount) return;
  await withDeskWorker(pool, account, (worker) =>
    reconcileFunding(worker, ledgerScope(c.identity), {
      operation_id,
      model_version: PAPER_FUNDING_MODEL,
      period_hour: hour,
      oracle_object_id: oracle,
      observation: row
        ? {
            source: FUNDING_SOURCE,
            received_at: response.received_at,
            row,
          }
        : null,
    }),
  );
}

/** Bounded sequential loops, existing API pool only; no live adapter; baseline requires its separate explicit registration. */
export function startDeskConsumer(pool: Pool, log: (reason: string) => void) {
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let funding: Promise<void> | null = null;
  const lastFunding = new Map<string, number>();
  let running: Promise<void> = Promise.resolve();
  const tick = async () => {
    try {
      const accounts = await pool.readOnly(
        1500,
        async (tx) =>
          (
            await tx.query<{ account_id: string; purpose: string }>(
              "SELECT c.account_id,a.identity->'account'->>'purpose' AS purpose FROM btc_desk_controls c JOIN btc_ledger_accounts a USING(account_id) WHERE a.identity->'account'->>'purpose' IN ('manual','baseline') AND (a.identity->'experiment'->>'started_at')::timestamptz <= clock_timestamp() ORDER BY c.account_id LIMIT 3",
            )
          ).rows,
      );
      if (
        accounts.length > 2 ||
        new Set(accounts.map((a) => a.purpose)).size !== accounts.length
      )
        throw new Error("BTC_DESK_ACCOUNT_LIMIT");
      for (const { account_id, purpose } of accounts) {
        try {
          if (purpose === "baseline")
            await consumeBaselineAccount(pool, account_id);
          else await consumeDeskAccount(pool, account_id);
        } catch (e) {
          const reason =
            e instanceof Error && /^BTC_[A-Z0-9_]+$/.test(e.message)
              ? e.message
              : "BTC_DESK_CONSUMER_FAILED";
          await pool.transaction((tx) =>
            tx.query(
              `INSERT INTO btc_desk_runtime(account_id,ready,reason) VALUES($1,false,$2)
            ON CONFLICT(account_id) DO UPDATE SET observed_at=clock_timestamp(),ready=false,reason=EXCLUDED.reason`,
              [account_id, reason],
            ),
          );
          log(reason);
        }
        if (
          !funding &&
          Date.now() - (lastFunding.get(account_id) ?? 0) >= 30000
        ) {
          lastFunding.set(account_id, Date.now());
          funding = fundDeskAccount(pool, account_id)
            .catch(() => log("BTC_DESK_FUNDING_UNAVAILABLE"))
            .finally(() => {
              funding = null;
            });
        }
      }
    } catch {
      log("BTC_DESK_CONSUMER_UNAVAILABLE");
    }
    if (!stopped)
      timer = setTimeout(() => {
        running = tick();
      }, 1000);
  };
  running = tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
    await funding;
  };
}
