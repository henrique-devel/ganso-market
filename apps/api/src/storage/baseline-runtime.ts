import { createLedgerAccount } from "./ledgerstore.js";
import type { LedgerIdentity } from "./ledger-contract.js";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { riskTransaction, observeRiskTx } from "./riskstore.js";
import { withDeskWorker } from "./desk-worker.js";
import { readReservationsTx } from "./reservationstore.js";
import { applyIocTx } from "./brokerstore.js";
import { liquidateIsolatedPosition } from "./marginstore.js";
import { RiskRefusal } from "../trading/risk.js";
import {
  baselineHash,
  baselineIso,
  validateBaselineRegistration,
  type BaselineBars,
} from "./baseline-inputs.js";
import {
  decideBaseline,
  revalidateBaseline,
  type BaselineDecision,
} from "./baseline-policy.js";
import {
  baselinePosition,
  manageBaselineExit,
  revalidateBaselineExit,
  type BaselineExitMemory,
} from "./baseline-exits.js";
import {
  baselineClock,
  baselineRegistrationTx,
  baselineEnvironmentTx,
  baselineBarsTx,
  baselineEvidenceTx,
  decisionBoundary,
  contextBoundary,
  nextBaselineBarTx,
  baselineBarsUnchangedTx,
  type RegistrationRow,
} from "./baseline-store.js";
import {
  validateIocCommand,
  type IocCommand,
  type IocResult,
} from "./broker-contract.js";

type Pool = Pick<DatabasePool, "transaction" | "readOnly">;
type ExitPlan = ReturnType<typeof manageBaselineExit>;
async function event(
  tx: SqlExecutor,
  r: RegistrationRow,
  kind: "admission" | "execution" | "position" | "exit_plan",
  key: string,
  position: string | null,
  payload: unknown,
  at: string,
  dependencies: string[],
) {
  const id = `baseline-event:${baselineHash([r.registration.scope.account_id, key])}`;
  await baselineEvidenceTx(tx, r, id, payload, at, [
    r.evidence_id,
    ...dependencies,
  ]);
  await tx.query(
    `INSERT INTO btc_baseline_events(account_id,event_key,position_id,kind,payload,evidence_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
    [
      r.registration.scope.account_id,
      key,
      position,
      kind,
      JSON.stringify(payload),
      id,
    ],
  );
}
/** Refused commands are permanent outcomes of the original signal. Roll back
 * only their speculative effects; persist effective risk pauses/cancellations. */
async function attempt(
  tx: SqlExecutor,
  r: RegistrationRow,
  command: IocCommand,
): Promise<{ result: IocResult | null; reasons: string[] }> {
  validateIocCommand(command);
  await tx.query("SAVEPOINT baseline_broker");
  try {
    const result = await applyIocTx(tx, r.registration.scope, command);
    await tx.query("RELEASE SAVEPOINT baseline_broker");
    return { result, reasons: [] as string[] };
  } catch (e) {
    if (
      !(e instanceof RiskRefusal) &&
      !(
        e instanceof Error &&
        /^BTC_(RESERVATION|IOC|MARGIN)_[A-Z_]+$/.test(e.message)
      )
    )
      throw e;
    await tx.query("ROLLBACK TO SAVEPOINT baseline_broker");
    await observeRiskTx(tx, r.registration.scope);
    return { result: null, reasons: [(e as Error).message] };
  }
}
async function executeActive(tx: SqlExecutor, r: RegistrationRow) {
  const account = r.registration.scope.account_id;
  for (const reservation of (await readReservationsTx(tx, account)).filter(
    (x) => x.status === "active",
  )) {
    const id = reservation.order.order_id;
    const s = await baselineEnvironmentTx(tx, r);
    let validation;
    let dependency: string;
    if (reservation.order.intent === "open") {
      const row = (
        await tx.query<{ decision: BaselineDecision; evidence_id: string }>(
          "SELECT decision,evidence_id FROM btc_baseline_decisions WHERE account_id=$1 AND decision->'command'->'order'->>'order_id'=$2",
          [account, id],
        )
      ).rows[0];
      if (!row) throw new Error("BTC_BASELINE_ORDER_PROVENANCE");
      validation = revalidateBaseline(row.decision, s.env, s.at, "execute");
      dependency = row.evidence_id;
    } else {
      const row = (
        await tx.query<{ payload: ExitPlan; evidence_id: string }>(
          "SELECT payload,evidence_id FROM btc_baseline_events WHERE account_id=$1 AND kind='exit_plan' AND event_key=$2",
          [account, `plan:${id}`],
        )
      ).rows[0];
      if (!row) throw new Error("BTC_BASELINE_EXIT_PROVENANCE");
      validation = revalidateBaselineExit(
        row.payload,
        {
          ...s.env,
          liquidatable: s.isolation.positions.some(
            (p) =>
              p.position_id === reservation.order.position_id && p.liquidatable,
          ),
        },
        s.at,
      );
      dependency = row.evidence_id;
    }
    if (validation.state === "waiting") continue;
    await s.persist();
    const execution = await attempt(tx, r, {
      action: validation.state === "ready" ? "execute" : "cancel",
      operation_id: `bexec:${baselineHash(id)}`,
      order_id: id,
    });
    // A wall-clock crossing may require waiting; never consume that operation.
    if (execution.result?.status === "waiting") continue;
    if (!execution.result) {
      // A refused execution is terminal for this IOC, including a reduction
      // halted during its last broker guard. Do not leave a hold whose durable
      // outcome has already consumed its execution key.
      execution.result = await applyIocTx(tx, r.registration.scope, {
        action: "cancel",
        operation_id: `brefused:${baselineHash(id)}`,
        order_id: id,
      });
    }
    await event(
      tx,
      r,
      "execution",
      `execute:${id}`,
      reservation.order.position_id,
      { validation, ...execution },
      s.at,
      [
        dependency,
        s.env.account.object_id,
        ...validation.input_refs.map((x) => x.object_id),
        ...(execution.result?.evidence_id
          ? [execution.result.evidence_id]
          : []),
      ],
    );
  }
}
async function managePositions(
  tx: SqlExecutor,
  r: RegistrationRow,
  context: { bar_end_at: string; hours: BaselineBars } | null,
) {
  const account = r.registration.scope.account_id,
    s = await baselineEnvironmentTx(tx, r);
  const records = (
    await tx.query<{ decision: BaselineDecision; evidence_id: string }>(
      `SELECT decision,evidence_id FROM btc_baseline_decisions WHERE account_id=$1
    AND decision->'command' IS NOT NULL AND decision->'command' <> 'null'::jsonb
    AND EXISTS(SELECT 1 FROM btc_ledger_events e WHERE e.account_id=$1 AND e.event_type='fill'
      AND e.event->'payload'->>'order_id'=decision->'command'->'order'->>'order_id')`,
      [account],
    )
  ).rows;
  const liquidate: string[] = [];
  let persisted = false;
  for (const d of records) {
    const positionId = d.decision.command!.order.position_id;
    const prior = (
      await tx.query<{
        payload: { position: BaselineExitMemory; state: string };
      }>(
        "SELECT payload FROM btc_baseline_events WHERE account_id=$1 AND position_id=$2 AND kind='position' ORDER BY sequence DESC LIMIT 1",
        [account, positionId],
      )
    ).rows[0]?.payload;
    if (prior?.state === "closed") continue;
    const position = baselinePosition(
      d.decision,
      s.observed.ledger.events,
      s.at,
      prior?.position ?? null,
    );
    const attempts = (
      await tx.query<{ payload: ExitPlan; status: string }>(
        `SELECT e.payload,o.reservation->>'status' AS status FROM btc_baseline_events e
      LEFT JOIN btc_desk_orders o ON o.account_id=e.account_id AND o.order_id=e.payload->'command'->'order'->>'order_id'
      WHERE e.account_id=$1 AND e.position_id=$2 AND e.kind='exit_plan' ORDER BY e.sequence`,
        [account, positionId],
      )
    ).rows;
    const t = decisionBoundary(s.at);
    const plan = manageBaselineExit({
      ...s.env,
      now: s.at,
      position,
      liquidatable: s.isolation.positions.some(
        (p) => p.position_id === positionId && p.liquidatable,
      ),
      ...(context && context.bar_end_at === t
        ? {
            decision_context: context,
          }
        : {}),
      attempts: attempts.map((x) => ({
        order_id: x.payload.command!.order.order_id,
        book_key: x.payload.book_key!,
        source_at: (x.payload as ExitPlan & { source_at: string }).source_at,
        status: x.status === "active" ? "active" : "terminal",
      })),
    });
    const memory = {
      position: plan.position,
      state: plan.state,
      ...(plan.state === "closed"
        ? {
            closed_bar_end_at: baselineIso(
              Math.floor(Date.parse(s.at) / 900000) * 900000,
            ),
          }
        : {}),
    };
    if (
      !prior ||
      baselineHash(memory) !== baselineHash(prior) ||
      plan.command
    ) {
      if (!persisted) {
        await s.persist();
        persisted = true;
      }
      if (!prior || baselineHash(memory) !== baselineHash(prior))
        await event(
          tx,
          r,
          "position",
          `position:${baselineHash([positionId, memory, s.at])}`,
          positionId,
          memory,
          s.at,
          [
            d.evidence_id,
            s.env.account.object_id,
            ...plan.input_refs.map((x) => x.object_id),
          ],
        );
    }
    for (const orderId of plan.cancel_order_ids)
      await attempt(tx, r, {
        action: "cancel",
        operation_id: `bcancel:${baselineHash(orderId)}`,
        order_id: orderId,
      });
    if (plan.state === "liquidation_required") liquidate.push(positionId);
    if (plan.command) {
      // Admission and plan commit together. A refused attempt also consumes this
      // economic book; retry requires a strictly newer observed book.
      await event(
        tx,
        r,
        "exit_plan",
        `plan:${plan.command.order.order_id}`,
        positionId,
        { ...plan, source_at: s.env.market.book!.payload.source_timestamp },
        s.at,
        [
          d.evidence_id,
          s.env.account.object_id,
          ...plan.input_refs.map((x) => x.object_id),
        ],
      );
      const result = await attempt(tx, r, plan.command);
      await event(
        tx,
        r,
        "admission",
        `admit:${plan.command.order.order_id}`,
        positionId,
        result,
        s.at,
        [
          s.env.account.object_id,
          ...(result.result?.evidence_id ? [result.result.evidence_id] : []),
        ],
      );
    }
  }
  return liquidate;
}
/** One closed-bar decision per durable versioned key. Current window first,
 * then one missed window per tick; never backfill orders or delay exits for gaps. */
export async function consumeBaselineAccount(pool: Pool, account: string) {
  const r = await pool.readOnly(1500, (tx) =>
    baselineRegistrationTx(tx, account),
  );
  validateBaselineRegistration(r.registration);
  const now = await pool.readOnly(1500, baselineClock);
  if (now < r.registration.start_at) return;
  const pending = await pool.readOnly(
    1500,
    async (tx) =>
      (
        await tx.query<{ identity: LedgerIdentity }>(
          `SELECT a.identity FROM btc_ledger_accounts a
    WHERE a.account_id=$1 AND NOT EXISTS(SELECT 1 FROM btc_ledger_projections p WHERE p.account_id=a.account_id)`,
          [account],
        )
      ).rows[0],
  );
  if (pending) await createLedgerAccount(pool, pending.identity);
  // Decode/hash bulky immutable market history without excluding the collector.
  // Account/risk/admission remain inside the fence after exact head revalidation.
  const prepared = await pool.readOnly(1500, async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const at = await baselineClock(tx),
      bar = await nextBaselineBarTx(tx, r, at);
    if (!bar) return null;
    return {
      bar,
      latest: decisionBoundary(at),
      hours: await baselineBarsTx(tx, 3600000, 12, contextBoundary(at), at),
      quarters: await baselineBarsTx(tx, 900000, 15, bar, at),
    };
  });
  return withDeskWorker(pool, account, async (worker) => {
    const liquidate = await riskTransaction(
      worker,
      r.registration.scope,
      async (tx) => {
        const current = await baselineRegistrationTx(tx, account),
          at = await baselineClock(tx),
          latest = decisionBoundary(at);
        const next = await nextBaselineBarTx(tx, current, at);
        const usable =
          prepared &&
          next === prepared.bar &&
          latest === prepared.latest &&
          (await baselineBarsUnchangedTx(
            tx,
            prepared.hours,
            3600000,
            12,
            contextBoundary(at),
            at,
          )) &&
          (await baselineBarsUnchangedTx(
            tx,
            prepared.quarters,
            900000,
            15,
            next,
            at,
          ));
        await executeActive(tx, current);
        const hasPosition =
          (
            await tx.query(
              `SELECT 1 FROM btc_ledger_projections WHERE account_id=$1 AND EXISTS
        (SELECT 1 FROM jsonb_array_elements(projection->'positions') p WHERE p->>'quantity_btc_raw'<>'0')
        UNION ALL SELECT 1 FROM (SELECT DISTINCT ON(position_id) payload FROM btc_baseline_events WHERE account_id=$1 AND kind='position' ORDER BY position_id,sequence DESC) p WHERE p.payload->>'state'<>'closed' LIMIT 1`,
              [account],
            )
          ).rowCount > 0;
        const liquids = hasPosition
          ? await managePositions(
              tx,
              current,
              usable && Date.parse(at) < Date.parse(latest) + 60000
                ? { bar_end_at: latest, hours: prepared.hours }
                : null,
            )
          : [];
        if (usable) {
          const s = await baselineEnvironmentTx(tx, current),
            bar = prepared.bar;
          const { hours, quarters } = prepared;
          const decision = decideBaseline({
            ...s.env,
            decision_at: s.at,
            bar_end_at: bar,
            hours,
            quarters,
          });
          await s.persist();
          const evidence = await baselineEvidenceTx(
            tx,
            current,
            `baseline-decision:${decision.decision_id}`,
            decision,
            s.at,
            [
              current.evidence_id,
              // Account and bars already retain their immutable evidence graph.
              // Keep every hashed input in the decision, but do not duplicate
              // thousands of transitive edges under the shared collector lock.
              s.env.account.object_id,
              ...hours.records.map((x) => x.object_id),
              ...quarters.records.map((x) => x.object_id),
            ],
          );
          await tx.query(
            "INSERT INTO btc_baseline_decisions(account_id,bar_end_at,decision_id,decision,evidence_id) VALUES($1,$2,$3,$4::jsonb,$5)",
            [
              account,
              bar,
              decision.decision_id,
              JSON.stringify(decision),
              evidence.object_id,
            ],
          );
          if (decision.command) {
            const fresh = await baselineEnvironmentTx(tx, current),
              validation = revalidateBaseline(
                decision,
                fresh.env,
                fresh.at,
                "admit",
              );
            await fresh.persist();
            const result =
              validation.state === "ready"
                ? await attempt(tx, current, decision.command)
                : { result: null, reasons: validation.reasons };
            await event(
              tx,
              current,
              "admission",
              `admit:${decision.command.order.order_id}`,
              decision.command.order.position_id,
              { validation, ...result },
              fresh.at,
              [
                evidence.object_id,
                fresh.env.account.object_id,
                ...validation.input_refs.map((x) => x.object_id),
                ...(result.result?.evidence_id
                  ? [result.result.evidence_id]
                  : []),
              ],
            );
          }
        }
        await tx.query(
          `INSERT INTO btc_desk_runtime(account_id,ready,reason) VALUES($1,true,'baseline_operational') ON CONFLICT(account_id)
        DO UPDATE SET observed_at=clock_timestamp(),ready=true,reason='baseline_operational'`,
          [account],
        );
        return liquids;
      },
      true,
    );
    for (const position_id of liquidate)
      await liquidateIsolatedPosition(worker, r.registration.scope, {
        position_id,
        operation_id: `bliq:${baselineHash([position_id, now])}`,
      });
  });
}
