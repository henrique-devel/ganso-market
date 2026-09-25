import { withDeskWorker } from "./desk-worker.js";
import { createHmac } from "node:crypto";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { hashToken, timingSafeEqualHex } from "../auth/tokens.js";
import {
  assertInstrumentOrderConstraints,
  parseTradingAmount,
  type DeskCommand,
  type DeskCommandPreview,
  type DeskCommandReceipt,
} from "@ganso-market/contracts/trading";
import { ledgerScope } from "../trading/ledger.js";
import { canonicalFingerprint } from "../trading/replay.js";
import { reserve, type ReservationOrder } from "../trading/reservations.js";
import {
  grossExposure,
  plannedRisk,
  requireRiskCaps,
  requireRisk,
  RISK_POLICY,
} from "../trading/risk.js";
import { projectFinancials, valueFinancials } from "../trading/valuation.js";
import { readLedgerAccountTx } from "./ledgerstore.js";
import type { LedgerIdentity } from "./ledger-contract.js";
import {
  readIsolatedMarginTx,
  readValuationMarketTx,
} from "./valuationstore.js";
import { readReservationsTx } from "./reservationstore.js";
import { applyRiskTx, readRiskTx, riskTransaction } from "./riskstore.js";
import { applyIocTx } from "./brokerstore.js";
import { applyPassiveTx } from "./passivestore.js";

type Pool = Pick<DatabasePool, "transaction" | "readOnly">;
export class DeskCommandError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
function fail(status: number, code: string): never {
  throw new DeskCommandError(status, code);
}
const id = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(v);
const raw = (v: unknown) =>
  typeof v === "string" && /^[1-9][0-9]{0,37}$/.test(v);
const exact = (v: object, fields: string) =>
  Object.keys(v).sort().join() === fields.split(",").sort().join();
export function validateDeskCommand(
  value: unknown,
  key: unknown,
): asserts value is DeskCommand {
  const invalid = () => fail(400, "TRADING_INVALID_COMMAND");
  if (
    typeof key !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(key)
  )
    invalid();
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const c = value as DeskCommand;
  if (!id(c.account_id)) invalid();
  if (c.action === "pause") {
    if (!exact(c, "account_id,action")) invalid();
  } else if (c.action === "cancel") {
    if (!exact(c, "account_id,action,order_id") || !id(c.order_id)) invalid();
  } else if (c.action === "submit" || c.action === "close") {
    if (
      !exact(
        c,
        "account_id,action,limit_price_usd_raw,price_cap_usd_raw,valid_until," +
          (c.action === "submit"
            ? "side,quantity_btc_raw,risk_plan"
            : "position_id"),
      ) ||
      !raw(c.limit_price_usd_raw) ||
      !raw(c.price_cap_usd_raw) ||
      BigInt(c.limit_price_usd_raw) > BigInt(c.price_cap_usd_raw) ||
      typeof c.valid_until !== "string" ||
      !Number.isFinite(Date.parse(c.valid_until)) ||
      new Date(c.valid_until).toISOString() !== c.valid_until
    )
      invalid();
    if (c.action === "submit") {
      if (
        !["buy", "sell"].includes(c.side) ||
        !raw(c.quantity_btc_raw) ||
        !c.risk_plan ||
        !exact(c.risk_plan, "stop_price_usd_raw,entry_floor_usd_raw") ||
        !raw(c.risk_plan.stop_price_usd_raw) ||
        !raw(c.risk_plan.entry_floor_usd_raw)
      )
        invalid();
    } else if (!id(c.position_id)) invalid();
  } else invalid();
}
const clock = async (tx: SqlExecutor) =>
  (
    await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
  ).rows[0]!.now.toISOString();
type Access = {
  identity: LedgerIdentity;
  owner_account_id: string;
  session_id: string;
  enabled: boolean;
  broker: "ioc" | "passive";
  latency_ms: number;
  signing_key: string;
};
async function accessTx(
  tx: SqlExecutor,
  account: string,
  token: string,
  lock = false,
): Promise<Access> {
  const session = (
    await tx.query<{ session_id: string; owner_account_id: string }>(
      `SELECT s.session_id,s.account_id::text AS owner_account_id FROM auth_access_tokens t
     JOIN auth_sessions s USING(session_id) WHERE t.token_hash=$1 AND t.revoked_at IS NULL
     AND s.revoked_at IS NULL AND t.expires_at > clock_timestamp()`,
      [hashToken(token)],
    )
  ).rows[0];
  if (!session) fail(401, "AUTH_UNAUTHENTICATED");
  const row = (
    await tx.query<Access>(
      `SELECT a.identity,c.owner_account_id::text,c.enabled,c.broker,c.latency_ms,c.signing_key
     FROM btc_desk_controls c JOIN btc_ledger_accounts a USING(account_id)
     WHERE c.account_id=$1 AND c.owner_account_id=$2 ${lock ? "FOR SHARE OF c" : ""}`,
      [account, session.owner_account_id],
    )
  ).rows[0];
  if (!row) fail(404, "TRADING_ACCOUNT_UNAVAILABLE");
  if (
    row.identity.account.mode !== "paper" ||
    row.identity.account.purpose !== "manual"
  )
    fail(403, "TRADING_PAPER_MANUAL_REQUIRED");
  return { ...row, ...session };
}
async function requireEnabled(
  tx: SqlExecutor,
  access: Access,
  command: DeskCommand,
) {
  if (
    !access.enabled &&
    (command.action === "submit" || command.action === "close")
  )
    fail(409, "TRADING_COMMANDS_DISABLED");
  if (command.action === "submit" || command.action === "close") {
    const active = await tx.query(
      `SELECT 1 FROM btc_desk_runtime r JOIN btc_recovery_heads h USING(account_id)
      WHERE r.account_id=$1 AND r.ready AND r.observed_at > clock_timestamp()-interval '5 seconds'
      AND h.status='ready' AND h.lease_until > clock_timestamp()`,
      [command.account_id],
    );
    if (!active.rowCount) fail(409, "TRADING_CONSUMER_UNAVAILABLE");
    if (command.action === "submit") {
      const funding = await tx.query(
        `SELECT 1 FROM btc_funding_results WHERE account_id=$1
        AND period_hour=date_trunc('hour',clock_timestamp()) AND status='settled'`,
        [command.account_id],
      );
      if (!funding.rowCount) fail(409, "TRADING_FUNDING_PENDING");
    }
  }
}
type Prepared = {
  order: ReservationOrder;
  metadata_id: string;
  broker: "ioc" | "passive";
  latency_ms: number;
  decision_at: string;
  limit: string;
};
type Ticket = {
  version: "trading.commands.v1";
  command: DeskCommand;
  key: string;
  session_id: string;
  issued_at: string;
  expires_at: string;
  prepared: Prepared | null;
};
const sign = (body: string, key: string) =>
  createHmac("sha256", Buffer.from(key, "hex")).update(body).digest("hex");
const envelope = (c: DeskCommand, key: string, at: string) => ({
  schema_version: "trading.commands.v1" as const,
  simulation: "SIMULAÇÃO" as const,
  mode: "paper" as const,
  account_id: c.account_id,
  idempotency_key: key,
  as_of: at,
});
/** Advisory READ ONLY quote: no reservations, recovery, risk observation or ledger writes. */
export async function previewDeskCommand(
  pool: Pool,
  token: string,
  command: DeskCommand,
  key: string,
): Promise<DeskCommandPreview> {
  validateDeskCommand(command, key);
  return pool.readOnly(1500, async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const access = await accessTx(tx, command.account_id, token);
    const prior = (
      await tx.query<{ request: DeskCommand }>(
        "SELECT request FROM btc_desk_commands WHERE account_id=$1 AND idempotency_key=$2",
        [command.account_id, key],
      )
    ).rows[0];
    if (
      prior &&
      canonicalFingerprint(prior.request) !== canonicalFingerprint(command)
    )
      fail(409, "TRADING_IDEMPOTENCY_CONFLICT");
    if (!prior) await requireEnabled(tx, access, command);
    const now = await clock(tx),
      expires = new Date(Date.parse(now) + 60000).toISOString();
    let prepared: Prepared | null = null,
      estimate: DeskCommandPreview["estimate"] = null;
    if (!prior && (command.action === "submit" || command.action === "close")) {
      if (
        command.valid_until <= now ||
        Date.parse(command.valid_until) > Date.parse(now) + 86400000
      )
        fail(400, "TRADING_INVALID_VALIDITY");
      const scope = ledgerScope(access.identity),
        ledger = await readLedgerAccountTx(tx, scope);
      const market = { ...(await readValuationMarketTx(tx, now)), as_of: now };
      const finance = valueFinancials(
        projectFinancials(ledger.projection, ledger.events),
        market,
      );
      const { metadata } = await readIsolatedMarginTx(tx, ledger, market);
      if (!metadata) fail(409, "BTC_MARGIN_METADATA_UNAVAILABLE");
      const rate =
        metadata.payload.fees[access.broker === "ioc" ? "taker" : "maker"];
      if (
        rate.unit !== "RATE" ||
        rate.decimals !== 9 ||
        !/^(0|[1-9][0-9]{0,8})$/.test(rate.raw)
      )
        fail(409, "BTC_RISK_FEE_METADATA_UNAVAILABLE");
      // Reserve the greater of maker/taker for conservative risk and fee envelopes.
      const taker = metadata.payload.fees.taker;
      if (
        taker.unit !== "RATE" ||
        taker.decimals !== 9 ||
        !/^(0|[1-9][0-9]{0,8})$/.test(taker.raw)
      )
        fail(409, "BTC_RISK_FEE_METADATA_UNAVAILABLE");
      const fee = Number(
        ((BigInt(rate.raw) > BigInt(taker.raw)
          ? BigInt(rate.raw)
          : BigInt(taker.raw)) +
          99999n) /
          100000n,
      );
      const orderId = `desk:${hashToken(canonicalFingerprint([command.account_id, key]))}`;
      let quantity: string, side: "buy" | "sell", position: string;
      if (command.action === "close") {
        const current = finance.positions.find(
          (p) => p.position_id === command.position_id,
        );
        if (!current || current.quantity_btc_raw === "0")
          fail(409, "TRADING_POSITION_NOT_OPEN");
        const q = BigInt(current.quantity_btc_raw);
        quantity = (q < 0n ? -q : q).toString();
        side = q < 0n ? "buy" : "sell";
        position = command.position_id;
      } else {
        quantity = command.quantity_btc_raw;
        side = command.side;
        position = orderId;
      }
      const order: ReservationOrder = {
        schema_version: "btc.reservations.v1",
        order_id: orderId,
        position_id: position,
        source: "manual",
        intent: command.action === "close" ? "reduce" : "open",
        side,
        quantity_btc_raw: quantity,
        price_cap_usd_raw: command.price_cap_usd_raw,
        fee_bps: fee,
        margin_policy: "full_notional_v1",
        valid_until: command.valid_until,
        ...(command.action === "submit"
          ? { risk_plan: command.risk_plan }
          : {}),
      };
      try {
        assertInstrumentOrderConstraints(
          metadata.payload,
          parseTradingAmount("USD_PER_BTC", {
            raw: command.limit_price_usd_raw,
            unit: "USD_PER_BTC",
            decimals: 6,
          }),
          parseTradingAmount("BTC", {
            raw: quantity,
            unit: "BTC",
            decimals: 8,
          }),
        );
      } catch {
        fail(400, "TRADING_ORDER_CONSTRAINTS");
      }
      const pending = await readReservationsTx(tx, command.account_id),
        hold = reserve(order, finance, pending);
      if (command.action === "submit")
        requireRiskCaps(
          finance.maintenance.equity_usd_raw!,
          grossExposure(
            finance.positions,
            finance.maintenance.mark_price!.raw,
            [...pending, hold],
          ),
          plannedRisk(order, fee),
        );
      const checkpoint = await readRiskTx(tx, command.account_id);
      prepared = {
        order,
        metadata_id: metadata.object_id,
        broker: access.broker,
        latency_ms: access.latency_ms,
        decision_at: now,
        limit: command.limit_price_usd_raw,
      };
      estimate = {
        quantity_btc_raw: quantity,
        side,
        reserved_margin_usd_raw: hold.margin_usd_raw,
        reserved_fees_usd_raw: hold.fee_usd_raw,
        maximum_notional_usd_raw: (
          (BigInt(quantity) * BigInt(order.price_cap_usd_raw) + 99999999n) /
          100000000n
        ).toString(),
        fee_basis: "public_base_tier_no_discounts",
        broker: access.broker,
        risk_state: checkpoint?.state ?? null,
        mark_quality: finance.maintenance.quality,
        book_quality: finance.closing.quality,
      };
    }
    const ticket: Ticket = {
      version: "trading.commands.v1",
      command,
      key,
      session_id: access.session_id,
      issued_at: now,
      expires_at: expires,
      prepared,
    };
    const body = Buffer.from(JSON.stringify(ticket)).toString("base64url");
    return {
      ...envelope(command, key, now),
      intent: `${body}.${sign(body, access.signing_key)}`,
      expires_at: expires,
      guarantees_fill: false,
      revalidation_required: true,
      replay: !!prior,
      estimate,
    };
  });
}
/** One recovery/risk/retention transaction contains both financial effects and receipt.
 * The stable real pool is the worker identity; no request-specific pool or nested BEGIN. */
export async function acceptDeskCommand(
  pool: Pool,
  token: string,
  action: DeskCommand["action"],
  intent: unknown,
  key: string,
): Promise<DeskCommandReceipt> {
  if (
    typeof intent !== "string" ||
    intent.length > 16384 ||
    !/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/.test(intent)
  )
    fail(400, "TRADING_INVALID_INTENT");
  const [body, signature] = intent.split(".") as [string, string];
  let ticket: Ticket;
  try {
    ticket = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Ticket;
  } catch {
    return fail(400, "TRADING_INVALID_INTENT");
  }
  validateDeskCommand(ticket?.command, key);
  if (
    ticket.version !== "trading.commands.v1" ||
    ticket.key !== key ||
    ticket.command.action !== action
  )
    fail(400, "TRADING_INTENT_MISMATCH");
  const command = ticket.command;
  const initial = await pool.readOnly(1500, (tx) =>
    accessTx(tx, command.account_id, token),
  );
  const verify = (a: Access) => {
    if (
      a.session_id !== ticket.session_id ||
      !timingSafeEqualHex(signature, sign(body, a.signing_key))
    )
      fail(403, "TRADING_INTENT_SIGNATURE");
  };
  verify(initial);
  const scope = ledgerScope(initial.identity);
  const execute = (worker: Pick<DatabasePool, "transaction">) =>
    riskTransaction(
      worker,
      scope,
      async (tx) => {
        const access = await accessTx(tx, command.account_id, token, true);
        verify(access);
        const prior = (
          await tx.query<{ request: DeskCommand; result: DeskCommandReceipt }>(
            "SELECT request,result FROM btc_desk_commands WHERE account_id=$1 AND idempotency_key=$2",
            [command.account_id, key],
          )
        ).rows[0];
        if (prior) {
          if (
            canonicalFingerprint(prior.request) !==
            canonicalFingerprint(command)
          )
            fail(409, "TRADING_IDEMPOTENCY_CONFLICT");
          return prior.result;
        }
        await requireEnabled(tx, access, command);
        const now = await clock(tx);
        if (ticket.issued_at > now || ticket.expires_at <= now)
          fail(409, "TRADING_PREVIEW_EXPIRED");
        const op = `desk:${hashToken(canonicalFingerprint([command.account_id, key]))}`;
        let execution: unknown,
          status: DeskCommandReceipt["status"],
          orderId: string | null = null,
          positionId: string | null = null;
        if (command.action === "pause") {
          execution = await applyRiskTx(tx, scope, {
            action: "reduce_only",
            operation_id: op,
            reason: "authenticated owner paused entries",
          });
          status = "entries_paused";
        } else if (command.action === "cancel") {
          const current = (
            await readReservationsTx(tx, command.account_id)
          ).find((r) => r.order.order_id === command.order_id);
          if (!current) fail(404, "TRADING_ORDER_NOT_FOUND");
          orderId = command.order_id;
          positionId = current.order.position_id;
          const cancel = {
            action: "cancel" as const,
            operation_id: op,
            order_id: orderId,
          };
          execution =
            access.broker === "ioc"
              ? await applyIocTx(tx, scope, cancel)
              : await applyPassiveTx(tx, scope, cancel);
          status =
            current.status === "active" ? "cancelled" : "already_terminal";
        } else {
          const p = ticket.prepared;
          if (
            !p ||
            p.broker !== access.broker ||
            p.latency_ms !== access.latency_ms
          )
            fail(409, "TRADING_POLICY_CHANGED");
          // Prices and source timestamps are re-read at acceptance, including exits.
          const ledger = await readLedgerAccountTx(tx, scope);
          const market = {
            ...(await readValuationMarketTx(tx, now)),
            as_of: now,
          };
          const finance = valueFinancials(
            projectFinancials(ledger.projection, ledger.events),
            market,
          );
          const book = finance.closing;
          requireRisk(
            book.quality === "fresh" &&
              [book.source_timestamp, book.received_at].every(
                (at) =>
                  at !== null &&
                  Date.parse(now) >= Date.parse(at) &&
                  Date.parse(now) - Date.parse(at) <= RISK_POLICY.book_age_ms,
              ),
            "BOOK_UNAVAILABLE",
          );
          const latest = await readIsolatedMarginTx(tx, ledger, market);
          if (latest.metadata?.object_id !== p.metadata_id)
            fail(409, "TRADING_PREVIEW_OUTDATED");
          if (command.action === "close") {
            const current = finance.positions.find(
              (v) => v.position_id === p.order.position_id,
            );
            const signed =
              BigInt(p.order.quantity_btc_raw) *
              (p.order.side === "sell" ? 1n : -1n);
            if (!current || BigInt(current.quantity_btc_raw) !== signed)
              fail(409, "TRADING_POSITION_CHANGED");
          }
          orderId = p.order.order_id;
          positionId = p.order.position_id;
          execution =
            access.broker === "ioc"
              ? await applyIocTx(tx, scope, {
                  action: "submit",
                  operation_id: op,
                  order: p.order,
                  intent: {
                    schema_version: "btc.ioc.v1",
                    decision_at: p.decision_at,
                    latency_ms: p.latency_ms,
                    limit_price_usd_raw: p.limit,
                    fee_metadata_id: p.metadata_id,
                  },
                })
              : await applyPassiveTx(tx, scope, {
                  action: "submit",
                  operation_id: op,
                  order: p.order,
                  intent: {
                    schema_version: "btc.passive.v1",
                    limit_price_usd_raw: p.limit,
                    fee_metadata_id: p.metadata_id,
                  },
                });
          status = "accepted";
        }
        const result: DeskCommandReceipt = {
          ...envelope(command, key, now),
          action,
          status,
          order_id: orderId,
          position_id: positionId,
          execution,
        };
        await tx.query(
          "INSERT INTO btc_desk_commands(account_id,idempotency_key,session_id,request,result) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)",
          [
            command.account_id,
            key,
            access.session_id,
            JSON.stringify(command),
            JSON.stringify(result),
          ],
        );
        return result;
      },
      true,
    );
  return withDeskWorker(pool, command.account_id, execute);
}
