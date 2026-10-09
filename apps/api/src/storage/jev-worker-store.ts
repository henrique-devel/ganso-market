import {
  jevDispatchRegistryHashTx,
  readJevDispatchCapacityTx,
} from "./jev-dispatch-capacity.js";
import { randomUUID } from "node:crypto";
import type {
  JevScope,
  TradingInstrumentMetadata,
  TradingInstrument,
  TradingMarketData,
} from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import {
  buildJevBatch,
  type JevBatchResult,
  type JevAccountDecision,
} from "../models/jev-decision-contract.js";
import {
  buildJevContext,
  type JevAccountContext,
  type JevContextRecord,
} from "./jev-context.js";
import { loadJevAccountTx } from "./jev-store.js";
import { jevScope } from "./jev-ledger.js";
import { jevHash } from "./jev-hash.js";
import type { JevManifest } from "./jev-manifest.js";
import {
  initialJevCadence,
  advanceJevCadence,
  recordJevDecision,
  type JevCadenceState,
} from "./jev-policy.js";
import { readJevExecutionTx, applyJevExecution } from "./jev-executionstore.js";
import {
  readJevEntriesTx,
  observeJevRisk,
  reconcileJevRisk,
  jevEntryEventTx,
  reserveJevEntry,
} from "./jev-riskstore.js";
import { withBtcRetentionTransaction } from "./btc-retention.js";
import { makeJevEvidence, storeJevEvidenceTx } from "./jev-evidence.js";
import { quoteJevMaker } from "./jev-execution-contract.js";
import type { ExecutionLease } from "./execution-worker-lease.js";
import type { ClosedBar } from "../trading/bars.js";
import type { JevRiskCheckpoint } from "../trading/jev-risk.js";
type Pool = Pick<DatabasePool, "transaction" | "readOnly">;
type Control = {
  admitted: boolean;
  entries_paused: boolean;
  revision: string;
  funding_debit_rate9_raw: string | null;
  cost_evidence_id: string | null;
  capacity_evidence_id: string | null;
};
export interface WorkerAccount {
  scope: JevScope;
  manifest: JevManifest;
}
export async function jevWorkerAccountTokenTx(tx: SqlExecutor, s: JevScope) {
  const l = await loadJevAccountTx(tx, s.owner_id, s.account_id, true),
    entries = await readJevEntriesTx(tx, s.account_id),
    e = await readJevExecutionTx(tx, s.account_id);
  const control =
    (
      await tx.query<Control>(
        "SELECT admitted,entries_paused,revision::text,funding_debit_rate9_raw::text,cost_evidence_id,capacity_evidence_id FROM jev_worker_controls WHERE account_id=$1",
        [s.account_id],
      )
    ).rows[0] ?? null;
  return {
    l,
    entries,
    e,
    control,
    hash: jevHash({
      scope: s,
      sequence: l.projection.last_sequence,
      positions: l.projection.positions,
      entries,
      e: e
        ? { maker: e.maker, protection: e.protection, close: e.close }
        : null,
      control,
    }),
  };
}
export function createJevWorkerStore(
  pool: Pool,
  lease: ExecutionLease,
  model: string | null,
) {
  const metrics = { capacity_skips: 0 };
  return {
    metrics,
    async accounts(): Promise<WorkerAccount[]> {
      return pool.readOnly(1500, async (tx) => {
        const rows = (
          await tx.query<{
            identity: { instrument: TradingInstrument };
            binding: Parameters<typeof jevScope>[0];
            manifest: JevManifest;
          }>(
            `SELECT a.identity,b.binding,p.manifest FROM jev_active_pairs q JOIN jev_bindings b ON b.experiment_id IN(q.paper_experiment_id,q.stress_experiment_id) JOIN jev_accounts a USING(account_id) JOIN jev_profiles p ON p.owner_id=b.owner_id AND p.profile_id=b.profile_id AND p.profile_version=b.profile_version WHERE a.mode IN('paper','stress') ORDER BY q.slot,a.account_id LIMIT 6`,
          )
        ).rows;
        return rows.map((r) => ({
          scope: jevScope(r.binding, r.identity.instrument),
          manifest: r.manifest,
        }));
      });
    },
    async protect(a: WorkerAccount, recover = false) {
      const state = await pool.readOnly(1500, (tx) =>
        readJevExecutionTx(tx, a.scope.account_id),
      );
      if (state)
        await applyJevExecution(pool, a.scope, {
          action: recover ? "recover" : "advance",
          operation_id: `worker:${lease.generation}:${randomUUID()}`,
        });
      else
        await pool.transaction(async (tx) => {
          const t = await jevWorkerAccountTokenTx(tx, a.scope);
          // A reserve without a send receipt never left the atomic paper boundary.
          // On takeover do not replay the old decision or manufacture an ACK/fill.
          if (recover || t.control?.entries_paused)
            for (const e of t.entries)
              if (
                e.status !== "released" &&
                (recover || e.status === "cancel_requested")
              )
                await jevEntryEventTx(
                  tx,
                  e.plan,
                  "released",
                  `worker-recover:${lease.generation}:${e.order_id}`,
                );
          if (t.l.projection.positions.some((p) => p.quantity_btc_raw !== "0"))
            throw new Error("JEV_WORKER_PROTECTION_MISSING");
        });
      if (!state) {
        await pool.transaction(async (tx) => {
          const t = await jevWorkerAccountTokenTx(tx, a.scope);
          if (t.entries.some((e) => e.status !== "released")) return;
          const at = (
            await tx.query<{ now: Date }>("SELECT clock_timestamp() now")
          ).rows[0]!.now.toISOString();
          await reconcileJevRisk(
            { transaction: (run) => run(tx) },
            a.scope.owner_id,
            a.scope.account_id,
            {
              operation_id: `worker-flat:${randomUUID()}`,
              ledger_sequence: t.l.projection.last_sequence,
              observed_at: at,
              funding_through_at: at,
              evidence: {
                flat: true,
                sequence: t.l.projection.last_sequence,
                generation: lease.generation,
              },
            },
          );
        });
      }
      await observeJevRisk(pool, a.scope.owner_id, a.scope.account_id);
      if (recover)
        await pool.transaction(async (tx) => {
          const head = (
            await tx.query<{ pending_request_id: string | null }>(
              "SELECT pending_request_id FROM jev_worker_cadences WHERE account_id=$1 FOR UPDATE",
              [a.scope.account_id],
            )
          ).rows[0];
          if (head?.pending_request_id)
            await tx.query(
              "INSERT INTO jev_worker_cycles(request_id,account_id,phase,generation,data) VALUES($1,$2,'recovered',$3,$4::jsonb) ON CONFLICT DO NOTHING",
              [
                head.pending_request_id,
                a.scope.account_id,
                lease.generation,
                JSON.stringify({
                  reason: "restart_discards_pending_inference",
                }),
              ],
            );
          await tx.query(
            "UPDATE jev_worker_cadences SET generation=$2,pending_request_id=NULL,pending_cut_at=NULL WHERE account_id=$1",
            [a.scope.account_id, lease.generation],
          );
        });
    },
    async unavailable(accounts: WorkerAccount[], _error: unknown) {
      // No synthetic hold and no pause of unrelated accounts. A durable failure
      // to close admission is fatal to health; protection is still attempted for all.
      await pool.transaction(async (tx) => {
        for (const a of accounts)
          await tx.query(
            "UPDATE jev_worker_controls SET entries_paused=true WHERE account_id=$1 AND NOT entries_paused",
            [a.scope.account_id],
          );
      });
    },
    async prepare(accounts: WorkerAccount[], now: number) {
      if (!model) return null;
      return withBtcRetentionTransaction(pool, async (tx) => {
        const participants: Parameters<
            typeof buildJevBatch
          >[0]["participants"] = [],
          tokens: Record<string, string> = {};
        const request = `cycle:${randomUUID()}`;
        const registryHash = await jevDispatchRegistryHashTx(tx);
        for (const a of accounts) {
          const s = a.scope,
            t = await jevWorkerAccountTokenTx(tx, s);
          if (!t.control?.admitted) continue;
          // Select the last proven collector cutoff. Every account/risk source must
          // already exist at that cutoff; never retimestamp a source to make it fresh.
          const capture = (
            await tx.query<{
              payload: {
                at: number;
                from: number;
                restarted?: boolean;
                history_truncated?: boolean;
                health: {
                  channels: Record<
                    string,
                    { status: string; needs_revalidation: boolean }
                  >;
                };
              };
              recorded_at: Date;
              object_id: string;
            }>(
              "SELECT o.object_id,o.payload,o.recorded_at FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.kind='capture' AND r.received_at<=clock_timestamp() ORDER BY r.received_at DESC LIMIT 1",
            )
          ).rows[0];
          if (
            !capture ||
            !Number.isSafeInteger(capture.payload.at) ||
            now - capture.payload.at >=
              a.manifest.freshness.response_deadline_ms ||
            now < capture.payload.at
          )
            continue;
          const cut = new Date(capture.payload.at).toISOString();
          if (
            t.l.events.some((e) => e.recorded_at > cut || e.occurred_at > cut)
          )
            continue;
          const risk = (
            await tx.query<{ checkpoint: JevRiskCheckpoint }>(
              "SELECT checkpoint FROM jev_risk_events WHERE account_id=$1 AND (checkpoint->>'observed_at')::timestamptz<=$2 ORDER BY sequence DESC LIMIT 1",
              [s.account_id, cut],
            )
          ).rows[0]?.checkpoint;
          if (!risk || risk.ledger_sequence !== t.l.projection.last_sequence)
            continue;
          const p = t.l.projection.positions.find(
              (p) => p.quantity_btc_raw !== "0",
            ),
            protection = t.e?.protection;
          if (
            p &&
            (!protection ||
              protection.quantity_btc_raw !==
                (BigInt(p.quantity_btc_raw) < 0n
                  ? -BigInt(p.quantity_btc_raw)
                  : BigInt(p.quantity_btc_raw)
                ).toString())
          )
            continue;
          if (!p && t.control.entries_paused) continue;
          if (
            !p &&
            (!t.control.cost_evidence_id ||
              t.control.funding_debit_rate9_raw === null ||
              !(await readJevDispatchCapacityTx(
                tx,
                t.control.capacity_evidence_id,
                registryHash,
                model,
                now,
              )))
          ) {
            metrics.capacity_skips++;
            continue;
          }
          const account: JevAccountContext = {
            scope: s,
            observed_at: risk.observed_at,
            cash_usd_raw: t.l.projection.cash_usd_raw,
            equity_usd_raw: risk.equity_usd_raw,
            entries_paused: t.control.entries_paused,
            risk_blocked: risk.entries_paused,
            recovery_ready: !risk.reasons.includes("RECONCILIATION_REQUIRED"),
            position:
              p && protection
                ? {
                    position_id: p.position_id,
                    direction: protection.direction,
                    quantity_btc_raw: protection.quantity_btc_raw,
                    entry_price_raw: protection.first_fill_price_raw,
                    stop_price_raw: protection.stop_price_raw,
                    first_fill_at: protection.first_fill_at,
                  }
                : null,
          };
          const record = <T>(
            id: string,
            payload: T,
            at: string,
          ): JevContextRecord<T> => ({
            object_id: id,
            payload,
            payload_hash: jevHash(payload),
            recorded_at: at,
            received_at: at,
          });
          const originals = (
            await tx.query<{
              object_id: string;
              payload: TradingMarketData;
              recorded_at: Date;
              received_at: Date;
              kind: string;
            }>(
              `SELECT o.object_id,o.payload,o.recorded_at,r.received_at,r.kind FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.received_at<=$1 AND o.recorded_at<=$1 AND ((r.kind IN('book','context') AND r.received_at>=$1::timestamptz-interval '10 seconds') OR (r.kind='trades' AND r.source_at>=$1::timestamptz-interval '60 seconds')) ORDER BY r.received_at DESC,r.object_id LIMIT 32768`,
              [cut],
            )
          ).rows;
          const records = originals.map((r) => ({
            ...record(r.object_id, r.payload, r.recorded_at.toISOString()),
            received_at: r.received_at.toISOString(),
          }));
          const bars = (
            await tx.query<{
              object_id: string;
              payload: ClosedBar;
              recorded_at: Date;
            }>(
              "SELECT o.object_id,o.payload,o.recorded_at FROM btc_market_bars b JOIN btc_retention_objects o USING(object_id) WHERE b.interval_ms=900000 AND b.end_at<=$1 AND o.recorded_at<=$1 ORDER BY b.end_at DESC LIMIT 15",
              [cut],
            )
          ).rows.map((r) =>
            record(r.object_id, r.payload, r.recorded_at.toISOString()),
          );
          const ids = [...new Set(bars.flatMap((b) => b.payload.input_ids))];
          const deps = (
            await tx.query<{
              object_id: string;
              payload: unknown;
              recorded_at: Date;
            }>(
              "SELECT object_id,payload,recorded_at FROM btc_retention_objects WHERE object_id=ANY($1::text[]) AND recorded_at<=$2",
              [ids, cut],
            )
          ).rows.map((r) =>
            record(r.object_id, r.payload, r.recorded_at.toISOString()),
          );
          const captures = (
            await tx.query<{
              object_id: string;
              payload: typeof capture.payload & {
                session?: string;
                health: {
                  channels: Record<
                    string,
                    { status: string; needs_revalidation: boolean }
                  >;
                  gaps?: {
                    channel: string;
                    detected_at: number;
                    after_source_at: number | null;
                    resumed_at: number | null;
                  }[];
                };
              };
              recorded_at: Date;
            }>(
              "SELECT o.object_id,o.payload,o.recorded_at FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.kind='capture' AND r.received_at<=$1 AND r.received_at>=$1::timestamptz-interval '65 seconds' AND o.recorded_at<=$1 ORDER BY r.received_at ASC LIMIT 512",
              [cut],
            )
          ).rows;
          const from =
            capture.payload.at - a.manifest.context.trade_window_seconds * 1000;
          let coveredFrom = Infinity,
            coveredUntil = -Infinity,
            healthy = true,
            session: string | undefined;
          const gaps: { start_at: string; end_at: string | null }[] = [];
          for (const c of captures) {
            const v = c.payload;
            if (v.at < from) continue;
            if (coveredFrom === Infinity) {
              coveredFrom = v.from;
              coveredUntil = v.from;
              session = v.session;
            }
            if (
              v.from > coveredUntil ||
              v.at - v.from > 2000 ||
              v.session !== session ||
              v.restarted ||
              v.history_truncated
            )
              healthy = false;
            if (
              !["book", "context", "trades"].every(
                (k) =>
                  v.health.channels[k]?.status === "healthy" &&
                  !v.health.channels[k]?.needs_revalidation,
              )
            )
              healthy = false;
            for (const g of v.health.gaps ?? [])
              if (
                g.channel === "trades" &&
                (g.after_source_at ?? g.detected_at) < capture.payload.at &&
                (g.resumed_at === null || g.resumed_at > from)
              )
                healthy = false;
            coveredUntil = Math.max(coveredUntil, v.at);
          }
          if (
            !Number.isFinite(coveredFrom) ||
            coveredFrom > from ||
            coveredUntil < now - 2000
          )
            continue;
          if (!healthy)
            gaps.push({
              start_at: new Date(coveredFrom).toISOString(),
              end_at: null,
            });
          const accountRecord = record(
            `worker-account:${jevHash([s, t.hash, risk])}`,
            account,
            risk.observed_at,
          );
          const coverage = record(
            `worker-coverage:${jevHash(captures.map((c) => ({ ...c, recorded_at: c.recorded_at.toISOString() })))}`,
            {
              start_at: new Date(coveredFrom).toISOString(),
              end_at: new Date(coveredUntil).toISOString(),
              gaps,
            },
            captures.at(-1)!.recorded_at.toISOString(),
          );
          const context = buildJevContext(a.manifest, t.l.identity, {
            cut_at: cut,
            account: accountRecord,
            book:
              records.find((r) => r.payload.payload.kind === "book") ?? null,
            mark_funding:
              records.find((r) => r.payload.payload.kind === "mark_funding") ??
              null,
            trades: records.filter((r) => r.payload.payload.kind === "trade"),
            bars,
            dependencies: deps,
            coverage,
          });
          const h = (
            await tx.query<{
              state: JevCadenceState;
              pending_request_id: string | null;
              pending_cut_at: Date | null;
            }>(
              "SELECT state,pending_request_id,pending_cut_at FROM jev_worker_cadences WHERE account_id=$1 FOR UPDATE",
              [s.account_id],
            )
          ).rows[0];
          const state = h?.state ?? initialJevCadence(a.manifest, s, cut);
          const advanced = advanceJevCadence(a.manifest, state, {
            now_at: new Date(now).toISOString(),
            account: context.account,
            mark_price_raw: context.funding?.mark_price.raw ?? null,
            atr14_raw: context.indicators?.atr14.raw ?? null,
            context_fresh: context.quality.state === "observed_no_known_gap",
          });
          const due = advanced.due && !h?.pending_request_id;
          const next = due
            ? recordJevDecision(
                advanced.state,
                new Date(now).toISOString(),
                context.funding!.mark_price.raw,
              )
            : advanced.state;
          await tx.query(
            "INSERT INTO jev_worker_cadences(account_id,generation,state,pending_request_id,pending_cut_at) VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(account_id) DO UPDATE SET generation=EXCLUDED.generation,state=EXCLUDED.state,pending_request_id=EXCLUDED.pending_request_id,pending_cut_at=EXCLUDED.pending_cut_at",
            [
              s.account_id,
              lease.generation,
              JSON.stringify(next),
              due ? request : (h?.pending_request_id ?? null),
              due ? cut : (h?.pending_cut_at ?? null),
            ],
          );
          if (!due) continue;
          const all = [accountRecord, ...records, ...bars, ...deps, coverage],
            bundle = `worker-inputs:${jevHash([request, s])}`,
            contextId = `worker-context:${jevHash([request, s])}`,
            recorded = new Date(now).toISOString();
          await storeJevEvidenceTx(
            tx,
            makeJevEvidence({
              object_id: bundle,
              scope: s,
              kind: "inputs",
              recorded_at: recorded,
              payload: { records: all },
              dependencies: [],
              sources: [
                ...new Set([
                  ...originals.map((r) => r.object_id),
                  ...ids,
                  ...bars.map((r) => r.object_id),
                  ...captures.map((r) => r.object_id),
                ]),
              ],
            }),
          );
          await storeJevEvidenceTx(
            tx,
            makeJevEvidence({
              object_id: contextId,
              scope: s,
              kind: "context",
              recorded_at: recorded,
              payload: { context, input_bundle_id: bundle },
              dependencies: [bundle],
              sources: [],
            }),
          );
          participants.push({ context_id: contextId, context });
          tokens[s.account_id] = t.hash;
          await tx.query(
            "INSERT INTO jev_worker_cycles(request_id,account_id,phase,generation,data) VALUES($1,$2,'scheduled',$3,$4::jsonb)",
            [
              request,
              s.account_id,
              lease.generation,
              JSON.stringify({
                token: t.hash,
                cut_at: cut,
                cadence: next,
                collection_lag_ms: now - capture.payload.at,
              }),
            ],
          );
        }
        if (!participants.length) return null;
        // One profile/cut per request; accounts observed at different cutoffs wait.
        const cut = participants[0]!.context.cut_at;
        if (participants.some((p) => p.context.cut_at !== cut))
          throw new Error("JEV_WORKER_MIXED_CUTOFF");
        return {
          batch: buildJevBatch({
            request_id: request,
            purpose: "operation",
            proposal_id: null,
            manifest: accounts[0]!.manifest,
            model,
            cut_at: cut,
            deadline_at: new Date(
              Date.parse(cut) +
                accounts[0]!.manifest.freshness.response_deadline_ms,
            ).toISOString(),
            participants,
          }),
          tokens,
        };
      });
    },
    async failed(
      cycle: { batch: ReturnType<typeof buildJevBatch> },
      _error: unknown,
    ) {
      await pool.transaction(async (tx) => {
        for (const p of cycle.batch.participants) {
          if (
            (
              await tx.query(
                "SELECT 1 FROM jev_worker_cycles WHERE request_id=$1 AND account_id=$2 AND phase<>'scheduled'",
                [cycle.batch.request_id, p.context.scope.account_id],
              )
            ).rowCount
          )
            continue;
          await tx.query(
            "UPDATE jev_worker_controls SET entries_paused=true WHERE account_id=$1 AND NOT entries_paused",
            [p.context.scope.account_id],
          );
          await tx.query(
            "INSERT INTO jev_worker_cycles(request_id,account_id,phase,generation,data) VALUES($1,$2,'discarded',$3,$4::jsonb) ON CONFLICT DO NOTHING",
            [
              cycle.batch.request_id,
              p.context.scope.account_id,
              lease.generation,
              JSON.stringify({ reason: "inference_failed_or_stale" }),
            ],
          );
          await tx.query(
            "UPDATE jev_worker_cadences SET pending_request_id=NULL,pending_cut_at=NULL WHERE account_id=$1 AND pending_request_id=$2",
            [p.context.scope.account_id, cycle.batch.request_id],
          );
        }
      });
    },
    async complete(result: JevBatchResult, tokens: Record<string, string>) {
      const outcomes = await Promise.allSettled(
        result.decisions.map((d) =>
          withBtcRetentionTransaction(pool, async (tx) => {
            const s = d.scope,
              t = await jevWorkerAccountTokenTx(tx, s),
              head = (
                await tx.query<{
                  pending_request_id: string;
                  pending_cut_at: Date;
                  generation: string;
                }>(
                  "SELECT pending_request_id,pending_cut_at,generation::text FROM jev_worker_cadences WHERE account_id=$1 FOR UPDATE",
                  [s.account_id],
                )
              ).rows[0];
            const now = (
              await tx.query<{ now: Date }>("SELECT clock_timestamp() now")
            ).rows[0]!.now.toISOString();
            const terminal = (
              await tx.query(
                "SELECT 1 FROM jev_worker_cycles WHERE request_id=$1 AND account_id=$2 AND phase<>'scheduled'",
                [result.batch.request_id, s.account_id],
              )
            ).rowCount;
            if (terminal) return;
            const valid =
              head?.generation === lease.generation &&
              head.pending_request_id === result.batch.request_id &&
              head.pending_cut_at.toISOString() === result.batch.cut_at &&
              now <= result.batch.deadline_at &&
              now <= result.batch.expires_at &&
              t.hash === tokens[s.account_id] &&
              d.reason === "ok" &&
              result.cost_usd6 !== null;
            const phase = valid ? "completed" : "discarded";
            // Wrap library operations in the same already fenced transaction. No
            // inference or nested BEGIN; state check, reserve and send commit together.
            const store = {
              transaction: <T>(run: (tx: SqlExecutor) => Promise<T>) => run(tx),
            };
            const executionStarted = Date.now();
            if (valid) await executeDecision(store, tx, result, d, t.control!);
            if (!valid && d.reason !== "ok")
              await tx.query(
                "UPDATE jev_worker_controls SET entries_paused=true WHERE account_id=$1 AND NOT entries_paused",
                [s.account_id],
              );
            await tx.query(
              "INSERT INTO jev_worker_cycles(request_id,account_id,phase,generation,data) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING",
              [
                result.batch.request_id,
                s.account_id,
                phase,
                lease.generation,
                JSON.stringify({
                  reason: valid ? d.reason : "stale_or_failed",
                  decision: d,
                  decision_ms:
                    Date.parse(result.finished_at) -
                    Date.parse(result.started_at),
                  action_at: now,
                  execution_ms: Date.now() - executionStarted,
                }),
              ],
            );
            if (head?.pending_request_id === result.batch.request_id)
              await tx.query(
                "UPDATE jev_worker_cadences SET pending_request_id=NULL,pending_cut_at=NULL WHERE account_id=$1",
                [s.account_id],
              );
          }),
        ),
      );
      const failure = outcomes.find((o) => o.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}
async function executeDecision(
  store: Pick<Pool, "transaction">,
  tx: SqlExecutor,
  result: JevBatchResult,
  d: JevAccountDecision,
  control: Control,
) {
  const s = d.scope,
    id = `decision:${jevHash([result.batch.request_id, s])}`,
    context = result.batch.participants.find(
      (p) => p.context_id === d.context_id,
    )!.context;
  if (d.action === "hold") return;
  if (d.action === "close") {
    const book = context.book,
      position = context.account?.position;
    if (book && position)
      await applyJevExecution(store, s, {
        action: "close",
        operation_id: id,
        limit_price_raw:
          position.direction === "long" ? book.best_bid.raw : book.best_ask.raw,
      });
    return;
  }
  if (
    d.action !== "open" ||
    control.entries_paused ||
    !control.admitted ||
    control.funding_debit_rate9_raw === null ||
    !control.cost_evidence_id ||
    !context.indicators ||
    !context.book ||
    !d.direction
  )
    return;
  const admissionNow = (
    await tx.query<{ now: Date }>("SELECT clock_timestamp() now")
  ).rows[0]!.now.getTime();
  if (
    !(await readJevDispatchCapacityTx(
      tx,
      control.capacity_evidence_id,
      await jevDispatchRegistryHashTx(tx),
      result.batch.model,
      admissionNow,
    ))
  )
    return;
  const metadata = (
    await tx.query<{ payload: TradingInstrumentMetadata }>(
      "SELECT o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.kind='metadata' AND r.received_at<=$1 ORDER BY r.received_at DESC LIMIT 1",
      [result.batch.cut_at],
    )
  ).rows[0]?.payload;
  if (!metadata) return;
  const input = {
    scope: s,
    order_id: id,
    decision_id: id,
    decision_at: result.batch.cut_at,
    entry_price_raw: quoteJevMaker(
      d.direction.choice === "long" ? "buy" : "sell",
      context.book.best_bid.raw,
      context.book.best_ask.raw,
      metadata,
    ),
    direction: d.direction.choice,
    atr14_raw: context.indicators.atr14.raw,
    atr_captured_at: context.indicators.last_closed_bar_end_at,
    maker_fee_rate9_raw: metadata.fees.maker.raw,
    exit_fee_rate9_raw: metadata.fees.taker.raw,
    funding_debit_rate9_raw: control.funding_debit_rate9_raw,
    cost_evidence_id: control.cost_evidence_id,
  };
  const reservation = await reserveJevEntry(
    store,
    result.batch.manifest,
    metadata,
    input,
  );
  if (reservation.status === "reserved")
    await applyJevExecution(store, s, {
      action: "submit",
      operation_id: id,
      order_id: id,
      plan_hash: jevHash(reservation.plan),
    });
}
