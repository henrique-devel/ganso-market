import type {
  JevScope,
  TradingInstrumentMetadata,
  TradingMarketData,
} from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "./database.js";
import type { loadJevLiveRuntime } from "./jev-live-runtime.js";
import type { ExecutionLease } from "./storage/execution-worker-lease.js";
import type {
  WorkerAccount,
  WorkerControl,
} from "./storage/jev-worker-store.js";
import type { JevManifest } from "./storage/jev-manifest.js";
import type {
  JevBatchResult,
  JevAccountDecision,
} from "./models/jev-decision-contract.js";
import { jevScope } from "./storage/jev-ledger.js";
import { jevHash } from "./storage/jev-hash.js";
import {
  readJevPromotionTx,
  jevPromotionGateTx,
} from "./storage/jev-promotion.js";
import { readJevPilotTx } from "./storage/jev-pilotstore.js";
import {
  readJevEntriesTx,
  jevEntryEventTx,
  reserveJevEntry,
} from "./storage/jev-riskstore.js";
import { jevLiveIntegrationReady } from "./storage/jev-live-capabilities.js";
import {
  jevDispatchRegistryHashTx,
  readJevDispatchCapacityTx,
} from "./storage/jev-dispatch-capacity.js";
import { quoteJevMaker } from "./storage/jev-execution-contract.js";
import { venueGridPrice } from "./trading/price-grid.js";
import {
  LIVE_COMMAND_VERSION,
  type LiveCommand,
  type LiveReceipt,
} from "./venues/hyperliquid/live-execution.js";
import type { LiveLease } from "./storage/jev-live-store.js";
import { requireLiveFreshSnapshot } from "./venues/hyperliquid/live-reconcile.js";
import { LiveError } from "./venues/hyperliquid/live-contract.js";

type Pool = Pick<DatabasePool, "transaction" | "readOnly">;
export interface JevLiveLane {
  accounts(): Promise<WorkerAccount[]>;
  protect(account: WorkerAccount, recover: boolean): Promise<void>;
  decisionTx(
    tx: SqlExecutor,
    result: JevBatchResult,
    decision: JevAccountDecision,
    control: WorkerControl,
  ): Promise<LiveCommand | null>;
  execute(command: LiveCommand): Promise<void>;
  heartbeat(): Promise<void>;
  tick(): void;
  halt(): void;
  assertActive(): void;
  stop(): Promise<void>;
  metrics: {
    cycles: number;
    failures: number;
    last_ms: number;
    last_at: number;
    running: boolean;
    decision_refusals: number;
    last_decision_reason: string | null;
    last_execution_reason: string | null;
  };
}
/** One independent live lane, no queued ticks and no provider/HTTP inside a DB
 * transaction. The process fence is rechecked by every signing-boundary gate. */
export function createJevLiveLane(
  runtime: Awaited<ReturnType<typeof loadJevLiveRuntime>>,
  pool: Pool,
  owner: ExecutionLease,
  sha: string,
): JevLiveLane {
  const adapter = runtime.adapter,
    status = runtime.status;
  const metrics = {
    cycles: 0,
    failures: 0,
    last_ms: 0,
    last_at: 0,
    running: false,
    decision_refusals: 0,
    last_decision_reason: null as string | null,
    last_execution_reason: null as string | null,
  };
  let task: Promise<void> | null = null,
    stopped = false,
    last = -Infinity;
  let liveLease: LiveLease | null = null,
    metadata: TradingInstrumentMetadata | null = null;
  let recovered = false;
  let retired = false;
  const pendingCommands = new Set<string>();
  const scopeAccounts = async (): Promise<WorkerAccount[]> => {
    if (!adapter) return [];
    return pool.readOnly(1500, async (tx) => {
      const rows = (
        await tx.query<{
          binding: Parameters<typeof jevScope>[0];
          instrument: Parameters<typeof jevScope>[1];
          manifest: JevManifest;
        }>(
          `SELECT b.binding,a.identity->'instrument' instrument,p.manifest FROM jev_live_promotions q
        JOIN jev_bindings b USING(experiment_id) JOIN jev_accounts a ON a.account_id=q.account_id
        JOIN jev_profiles p ON p.owner_id=b.owner_id AND p.profile_id=b.profile_id AND p.profile_version=b.profile_version
        WHERE q.account_id=$1 AND q.sequence=(SELECT max(sequence) FROM jev_live_promotions WHERE account_id=$1)
        AND q.state IN('active','draining') LIMIT 1`,
          [adapter.store.identity.account_id],
        )
      ).rows;
      return rows.map((r) => ({
        scope: jevScope(r.binding, r.instrument),
        manifest: r.manifest,
      }));
    });
  };
  async function publish() {
    if (!adapter) return;
    await pool.transaction((tx) =>
      tx.query(
        `INSERT INTO jev_live_runtime(identity_hash,generation,code_sha,state) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(identity_hash) DO UPDATE SET generation=EXCLUDED.generation,code_sha=EXCLUDED.code_sha,state=EXCLUDED.state`,
        [
          adapter.store.identityHash,
          owner.generation,
          sha,
          JSON.stringify({ ...status, metrics }),
        ],
      ),
    );
  }
  async function renew() {
    if (!adapter) throw new Error("JEV_LIVE_RUNTIME_UNAVAILABLE");
    // An expired generation must retire; never silently reacquire during a send.
    if (liveLease && liveLease.lease_until <= Date.now())
      throw new Error("JEV_LIVE_LEASE_EXPIRED");
    const next = await adapter.store.claim(owner.worker_id);
    if (liveLease && next.generation !== liveLease.generation)
      throw new Error("JEV_LIVE_LEASE_CHANGED");
    liveLease = next;
    return next;
  }
  async function cycle() {
    if (!adapter || stopped) return;
    const lease = await renew();
    const [observed, meta, accounts] = await Promise.all([
      adapter.reconcileAccount(),
      adapter.boundary.metadata(),
      scopeAccounts(),
    ]);
    metadata = meta.metadata;
    await adapter.store.append("metadata", `metadata:${jevHash(meta)}`, meta);
    const s = observed.snapshot,
      a = accounts[0];
    if (!s || !a) {
      status.reasons = ["recovery_pending"];
      await publish();
      return;
    }
    requireLiveFreshSnapshot(adapter.store.identity, s, Date.now());
    // A validated command waiting for this lane owns its financial reserve.
    // At a proven flat cut no protective action is needed: yield to its send
    // without refreshing admission or waiting on provider inference.
    if (pendingCommands.size && s.flat && !observed.pending) return;
    const intervention = await adapter.store.operatorControl();
    const pilot = await pool.transaction((tx) =>
      readJevPilotTx(tx, a.scope.account_id),
    );
    const market = await pool.readOnly(
      1500,
      async (tx) =>
        (
          await tx.query<{ payload: TradingMarketData }>(
            "SELECT o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.kind='context' AND r.received_at<=clock_timestamp() ORDER BY r.received_at DESC LIMIT 1",
          )
        ).rows[0]?.payload,
    );
    const mark = market?.payload.kind === "mark_funding" ? market : null;
    const markFresh =
      mark?.quality === "fresh" &&
      mark.source_timestamp !== null &&
      Date.parse(mark.source_timestamp) <= Date.now() &&
      Date.now() - Date.parse(mark.source_timestamp) <=
        a.manifest.freshness.mark_funding_ms &&
      Date.now() - Date.parse(mark.received_at) <=
        a.manifest.freshness.mark_funding_ms &&
      Date.parse(mark.received_at) <= Date.now();
    const markPrice =
      markFresh && mark?.payload.kind === "mark_funding"
        ? mark.payload.mark_price.raw
        : null;
    const requests = await adapter.store.operations(),
      receipts = await adapter.store.events<LiveReceipt>("receipt");
    // A decision can commit while these reads are in progress. Recheck before
    // entering the slower protection/succession path for an already flat pilot.
    if (pendingCommands.size && s.flat && !observed.pending) return;
    const entry = requests
      .filter(
        (r) =>
          r.kind === "entry" && r.scope.experiment_id === a.scope.experiment_id,
      )
      .at(-1);
    const closing =
      !!entry &&
      s.position_raw !== "0" &&
      requests.some(
        (r) =>
          r.kind === "close" &&
          r.scope.experiment_id === entry.scope.experiment_id &&
          r.nonce > entry.nonce &&
          (r.request as Extract<LiveCommand, { kind: "close" }>).cause ===
            "jev_close",
      );
    const riskBlocked =
      observed.pending ||
      !pilot ||
      pilot.checkpoint.risk.request_close ||
      pilot.checkpoint.global_blocked ||
      closing;
    let protectedPosition = s.position_raw === "0";
    if (entry) {
      const protectedState = await adapter.protection.reconcile({
        entry,
        snapshot: s,
        manifest: a.manifest,
        metadata,
        metadata_at: Date.parse(metadata.instrument.origin.received_at),
        lease,
        mark_price_raw: markPrice,
        mark_at: markFresh && mark ? Date.parse(mark.received_at) : null,
        risk_blocked: riskBlocked,
      });
      protectedPosition =
        s.position_raw === "0" ||
        protectedState.state === "confirmed" ||
        protectedState.state === "flat";
      // Every active maker is bounded by its first ACK, even after a restart.
      const terminal = receipts
        .filter((r) => r.operation_id === entry.operation_id)
        .at(-1);
      if (
        !terminal ||
        !["filled", "cancelled", "rejected"].includes(terminal.state)
      ) {
        if (riskBlocked || !protectedPosition || intervention.paused) {
          if (
            s.orders.some(
              (o) =>
                o.cloid === entry.cloid ||
                (terminal?.oid !== null && o.oid === terminal?.oid),
            )
          )
            await adapter.execution.cancelEntry(entry, lease, metadata);
          else await adapter.execution.recover(entry);
        } else
          await adapter.execution.cancelExpired(
            entry,
            receipts,
            lease,
            metadata,
            Date.parse(metadata.instrument.origin.received_at),
          );
      }
    } else if (s.position_raw !== "0") {
      // Unknown attribution is never adopted as a new strategy position.
      status.reasons = ["position_attribution_unknown"];
      await closeResidual(
        a.scope,
        "position_attribution_unknown",
        s,
        metadata,
        lease,
        markPrice,
      );
    }
    if (riskBlocked && entry && s.position_raw !== "0")
      await closeResidual(
        entry.scope,
        "risk_blocked",
        s,
        metadata,
        lease,
        markPrice,
      );
    if (intervention.paused) {
      for (const parent of requests.filter((r) => r.kind === "entry")) {
        const receipt = receipts
          .filter((r) => r.operation_id === parent.operation_id)
          .at(-1);
        if (
          s.orders.some(
            (o) =>
              o.cloid === parent.cloid ||
              (receipt?.oid !== null && o.oid === receipt?.oid),
          )
        )
          await adapter.execution.cancelEntry(parent, lease, metadata);
      }
      // Cancellation may race a late fill or stop. Requery before choosing a
      // residual; ACK and the pre-cancel snapshot never establish a close size.
      const after = await adapter.reconcileAccount();
      if (after.snapshot) {
        if (intervention.close && after.snapshot.position_raw !== "0")
          await closeResidual(
            a.scope,
            "operator_emergency",
            after.snapshot,
            metadata,
            lease,
            markPrice,
          );
        await settle(
          after.snapshot,
          await adapter.store.operations(),
          await adapter.store.events<LiveReceipt>("receipt"),
        );
        if (after.snapshot.position_raw === "0" && !after.pending) {
          for (const stop of (await adapter.store.operations()).filter(
            (r) =>
              r.kind === "stop" &&
              after.snapshot!.orders.some((o) => o.cloid === r.cloid),
          )) {
            // The store rechecks zero position, terminal receipts and financial
            // reserves both at reservation and immediately before signing.
            try {
              await adapter.execution.cancelOrder(stop, lease, metadata);
            } catch (e) {
              if (!(e instanceof LiveError)) throw e;
            }
          }
        }
      }
      await observeIntervention(lease, protectedPosition);
    }
    await settle(s, requests, receipts);
    if (pendingCommands.size && s.flat && !observed.pending) return;
    const limit = closeLimit(s.position_raw, markPrice, metadata, entry);
    if (limit)
      await adapter.succession.reconcile({
        metadata,
        metadata_at: Date.parse(metadata.instrument.origin.received_at),
        close_limit_price_raw: limit,
        lease,
      });
    else
      await pool.transaction((tx) =>
        readJevPromotionTx(tx, a.scope.account_id),
      );
    const current = await adapter.store.latest();
    const operational = await pool.transaction(async (tx) => ({
      gate: await jevPromotionGateTx(tx, a.scope.owner_id),
      admitted:
        (
          await tx.query(
            "SELECT 1 FROM jev_worker_controls WHERE account_id=$1 AND admitted AND NOT entries_paused",
            [a.scope.account_id],
          )
        ).rowCount > 0,
    }));
    status.entries_ready =
      !stopped &&
      jevLiveIntegrationReady() &&
      !current.pending &&
      protectedPosition &&
      operational.gate.ready &&
      operational.admitted;
    status.reasons = [
      ...(!jevLiveIntegrationReady() ? ["live_integration_pending"] : []),
      ...(current.pending ? ["reconciliation_pending"] : []),
      ...(!protectedPosition ? ["protection_pending"] : []),
      ...operational.gate.reasons,
      ...(!operational.admitted ? ["account_not_admitted_or_paused"] : []),
    ];
    await publish();
    recovered = true;
  }
  async function observeIntervention(
    lease: LiveLease,
    protectedPosition: boolean,
  ) {
    if (!adapter) return;
    const control = await adapter.store.operatorControl();
    if (!control.command) return;
    const current = await adapter.store.latest(),
      s = current.snapshot;
    if (!s) return;
    const requests = await adapter.store.operations(),
      receipts = await adapter.store.events<LiveReceipt>("receipt");
    const unresolved = requests.some((r) => {
      const last = receipts
        .filter((e) => e.operation_id === r.operation_id)
        .at(-1);
      return (
        !last ||
        !["filled", "cancelled", "rejected", "triggered"].includes(last.state)
      );
    });
    const reserves = await pool.transaction((tx) =>
      readJevEntriesTx(tx, adapter.store.identity.account_id),
    );
    const makerPending =
      s.orders.some((o) => !o.reduce_only) ||
      (reserves.some((e) => e.status !== "released") && s.position_raw === "0");
    const flat =
      s.flat &&
      !current.pending &&
      !unresolved &&
      reserves.every((e) => e.status === "released") &&
      s.venue_at >= control.command.recorded_at.getTime();
    const status = current.pending
      ? "unavailable"
      : flat
        ? "reconciled_flat"
        : makerPending
          ? "cancelling"
          : control.close
            ? "reducing"
            : protectedPosition &&
                s.position_raw !== "0" &&
                s.orders.some(
                  (o) =>
                    o.reduce_only &&
                    o.position_stop &&
                    o.side === (BigInt(s.position_raw) > 0n ? "sell" : "buy") &&
                    BigInt(o.quantity_raw) >=
                      (BigInt(s.position_raw) < 0n
                        ? -BigInt(s.position_raw)
                        : BigInt(s.position_raw)) &&
                    requests.some(
                      (r) => r.kind === "stop" && r.cloid === o.cloid,
                    ),
                )
              ? "protected"
              : "pending_reconciliation";
    await adapter.store.recordIntervention({
      command_key: control.command.idempotency_key,
      status,
      snapshot_id: s.snapshot_id,
      position_raw: s.position_raw,
      reasons: current.pending ? ["RECONCILIATION_REQUIRED"] : [],
      lease,
    });
  }
  function closeLimit(
    position: string,
    mark: string | null,
    m: TradingInstrumentMetadata,
    entry?: import("./venues/hyperliquid/live-contract.js").LiveReservation,
  ) {
    if (position === "0") return "1"; // Not sent while flat; succession still advances.
    const plan = entry?.request as
      Extract<LiveCommand, { kind: "entry" }> | undefined;
    const price = mark
      ? (BigInt(mark) * (BigInt(position) > 0n ? 9n : 11n)) / 10n
      : plan?.plan.worst_exit_price_raw
        ? BigInt(plan.plan.worst_exit_price_raw)
        : null;
    if (price === null) return null;
    return (
      venueGridPrice(
        price,
        1n,
        BigInt(position) > 0n ? "down" : "up",
        m,
      )?.toString() ?? null
    );
  }
  async function closeResidual(
    scope: JevScope,
    cause: string,
    s: import("./venues/hyperliquid/live-reconcile.js").LiveSnapshot,
    m: TradingInstrumentMetadata,
    lease: LiveLease,
    markPrice: string | null,
  ) {
    if (!adapter) return;
    const entry = (await adapter.store.operations())
      .filter(
        (r) =>
          r.kind === "entry" && r.scope.experiment_id === scope.experiment_id,
      )
      .at(-1);
    const limit = closeLimit(s.position_raw, markPrice, m, entry);
    if (!limit) return;
    await adapter.execution.executeResidual(
      {
        version: LIVE_COMMAND_VERSION,
        kind: "close",
        scope,
        operation_id: `runtime-close:${jevHash([scope, s.snapshot_id, cause])}`,
        metadata: m,
        metadata_at: Date.parse(m.instrument.origin.received_at),
        snapshot: s,
        limit_price_raw: limit,
        cause,
      },
      lease,
    );
  }
  async function settle(
    s: import("./venues/hyperliquid/live-reconcile.js").LiveSnapshot,
    requests: import("./venues/hyperliquid/live-contract.js").LiveReservation[],
    receipts: LiveReceipt[],
  ) {
    if (
      !adapter ||
      s.position_raw !== "0" ||
      !s.consistent ||
      !s.history_complete ||
      s.orders.some((o) => !o.reduce_only || !o.position_stop) ||
      (await adapter.store.latest()).pending
    )
      return;
    await pool.transaction(async (tx) => {
      await tx.query(
        "SELECT 1 FROM jev_accounts WHERE account_id=$1 FOR UPDATE",
        [adapter.store.identity.account_id],
      );
      // Reconciliation also holds this account lock. A newer cut may contain a
      // late fill; never release reserves from the earlier zero observation.
      const latest = (
        await tx.query<{ snapshot_id: string }>(
          "SELECT payload->>'snapshot_id' AS snapshot_id FROM jev_live_events WHERE identity_hash=$1 AND kind='snapshot' ORDER BY recorded_at DESC,event_key DESC LIMIT 1",
          [adapter.store.identityHash],
        )
      ).rows[0];
      if (latest?.snapshot_id !== s.snapshot_id) return;
      requireLiveFreshSnapshot(adapter.store.identity, s, Date.now());
      for (const e of await readJevEntriesTx(
        tx,
        adapter.store.identity.account_id,
      )) {
        if (e.status === "released") continue;
        if (pendingCommands.has(e.order_id)) continue;
        const sent = requests.find(
          (r) =>
            r.kind === "entry" &&
            (r.request as Extract<LiveCommand, { kind: "entry" }>).plan.input
              .order_id === e.order_id,
        );
        const terminal = sent
          ? receipts.filter((r) => r.operation_id === sent.operation_id).at(-1)
          : null;
        if (
          sent &&
          (!terminal ||
            !["filled", "cancelled", "rejected"].includes(terminal.state) ||
            terminal.observed_at > s.venue_at)
        )
          continue;
        // A reserve with no venue intent is abandoned on restart/expiry, never replayed.
        if (
          !sent &&
          Date.now() - Date.parse(e.plan.input.decision_at) <= 2000 &&
          !stopped
        )
          continue;
        await jevEntryEventTx(
          tx,
          e.plan,
          "released",
          `runtime-release:${jevHash([e.order_id, s.snapshot_id])}`,
        );
      }
    });
  }
  return {
    metrics,
    // The runtime projection is this process's fenced heartbeat, not a venue
    // timestamp. Reservation/signing still recheck the original financial
    // sources, protection, controls, qualification and integration gates.
    heartbeat: publish,
    assertActive() {
      if (retired) throw new Error("JEV_LIVE_RUNTIME_RETIRED");
    },
    halt() {
      stopped = true;
      status.entries_ready = false;
    },
    accounts: async () => (recovered ? scopeAccounts() : []),
    async protect(a, recover) {
      if (!adapter) throw new Error("JEV_LIVE_RUNTIME_UNAVAILABLE");
      // The independent lane owns venue protection. A transient stale read must
      // close its expiring runtime admission, not manufacture an operator pause
      // through the paper scheduler's unavailable-account fallback.
      if (recover)
        await pool.transaction(async (tx) => {
          const h = (
            await tx.query<{ pending_request_id: string | null }>(
              "SELECT pending_request_id FROM jev_worker_cadences WHERE account_id=$1 FOR UPDATE",
              [a.scope.account_id],
            )
          ).rows[0];
          if (h?.pending_request_id)
            await tx.query(
              "INSERT INTO jev_worker_cycles(request_id,account_id,phase,generation,data) VALUES($1,$2,'recovered',$3,$4::jsonb) ON CONFLICT DO NOTHING",
              [
                h.pending_request_id,
                a.scope.account_id,
                owner.generation,
                JSON.stringify({
                  reason: "restart_discards_pending_inference",
                }),
              ],
            );
          await tx.query(
            "UPDATE jev_worker_cadences SET generation=$2,pending_request_id=NULL,pending_cut_at=NULL WHERE account_id=$1",
            [a.scope.account_id, owner.generation],
          );
        });
    },
    async decisionTx(tx, result, d, control) {
      const refuse = (reason: string) => {
        metrics.decision_refusals++;
        metrics.last_decision_reason = reason;
        return null;
      };
      if (!adapter || stopped || !metadata || !liveLease || !recovered)
        return refuse("live_runtime_unavailable");
      const context = result.batch.participants.find(
        (p) => p.context_id === d.context_id,
      )!.context;
      if (d.action === "hold") return null;
      const snapshot = await adapterSnapshotTx(tx, adapter.store.identityHash);
      if (!snapshot) return refuse("live_snapshot_missing");
      requireLiveFreshSnapshot(adapter.store.identity, snapshot, Date.now());
      const base = {
        version: LIVE_COMMAND_VERSION,
        scope: d.scope,
        operation_id: `decision:${jevHash([result.batch.request_id, d.scope])}`,
        metadata,
        metadata_at: Date.parse(metadata.instrument.origin.received_at),
      };
      const book = (
        await tx.query<{ payload: TradingMarketData }>(
          "SELECT o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE r.kind='book' AND r.received_at<=$1 AND o.recorded_at<=$1 ORDER BY r.received_at DESC LIMIT 1",
          [result.batch.cut_at],
        )
      ).rows[0]?.payload;
      if (
        !book ||
        book.payload.kind !== "book" ||
        !context.book ||
        book.payload.bids[0]?.price.raw !== context.book.best_bid.raw ||
        book.payload.asks[0]?.price.raw !== context.book.best_ask.raw
      )
        return refuse("live_book_cut_mismatch");
      if (d.action === "close")
        return snapshot.position_raw !== "0" && context.book
          ? {
              ...base,
              kind: "close",
              snapshot,
              limit_price_raw:
                BigInt(snapshot.position_raw) > 0n
                  ? context.book.best_bid.raw
                  : context.book.best_ask.raw,
              cause: "jev_close",
            }
          : null;
      if (
        d.action !== "open" ||
        !status.entries_ready ||
        control.entries_paused ||
        !control.admitted ||
        !context.indicators ||
        !context.book ||
        !d.direction ||
        control.funding_debit_rate9_raw === null ||
        !control.cost_evidence_id
      )
        return refuse(
          !status.entries_ready
            ? "live_entries_not_ready"
            : control.entries_paused || !control.admitted
              ? "live_control_not_admitted"
              : "live_entry_context_or_cost_missing",
        );
      const now = Date.now();
      if (
        !(await readJevDispatchCapacityTx(
          tx,
          control.capacity_evidence_id,
          await jevDispatchRegistryHashTx(tx),
          result.batch.model,
          now,
        ))
      )
        return refuse("live_dispatch_capacity_missing");
      const input = {
        scope: d.scope,
        order_id: base.operation_id,
        decision_id: base.operation_id,
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
      const reserved = await reserveJevEntry(
        { transaction: (run) => run(tx) },
        result.batch.manifest,
        metadata,
        input,
      );
      if (reserved.status === "reserved") metrics.last_decision_reason = "ok";
      return reserved.status === "reserved"
        ? {
            ...base,
            kind: "entry",
            plan: reserved.plan,
            manifest: result.batch.manifest,
            snapshot,
            book: {
              bid_raw: context.book.best_bid.raw,
              ask_raw: context.book.best_ask.raw,
              received_at: Date.parse(book.received_at),
            },
          }
        : refuse(
            "reason" in reserved
              ? [
                  reserved.reason,
                  ...("admission_reasons" in reserved &&
                  Array.isArray(reserved.admission_reasons)
                    ? reserved.admission_reasons
                    : []),
                ].join(":")
              : "live_reservation_not_sendable",
          );
    },
    async execute(command) {
      // Reconciliation must not classify this process's in-flight first send as
      // a lost request. Share the bounded venue lane, outside every SQL lock;
      // provider inference remains entirely independent and ticks never queue.
      pendingCommands.add(command.operation_id);
      try {
        while (task) await task;
        if (!adapter || stopped || !liveLease) return;
        const lease = liveLease;
        const sending = Promise.resolve().then(async () => {
          if (command.kind === "close")
            await adapter.execution.executeResidual(command, lease);
          else await adapter.execution.execute(command, lease);
        });
        task = sending;
        try {
          await sending;
          metrics.last_execution_reason = "ok";
        } catch (error) {
          metrics.last_execution_reason =
            error instanceof LiveError
              ? error.code
              : "live_execution_unavailable";
          throw error;
        } finally {
          if (task === sending) task = null;
        }
      } finally {
        pendingCommands.delete(command.operation_id);
      }
    },
    tick() {
      if (!adapter || stopped || task || Date.now() - last < 1000) return;
      last = Date.now();
      metrics.running = true;
      task = cycle()
        .catch(async (error) => {
          metrics.failures++;
          if (
            error instanceof Error &&
            ["JEV_LIVE_LEASE_EXPIRED", "JEV_LIVE_LEASE_CHANGED"].includes(
              error.message,
            )
          )
            retired = true;
          status.entries_ready = false;
          recovered = false;
          status.reasons = [
            ...(!jevLiveIntegrationReady() ? ["live_integration_pending"] : []),
            "JEV_LIVE_RECOVERY_UNAVAILABLE",
          ];
          // A lost process fence also prevents publishing. Retire this live lane;
          // the main heartbeat then terminates the process without an unhandled task.
          try {
            await publish();
          } catch {
            stopped = true;
          }
        })
        .finally(() => {
          metrics.cycles++;
          metrics.last_ms = Date.now() - last;
          metrics.last_at = Date.now();
          metrics.running = false;
          task = null;
        });
    },
    async stop() {
      stopped = true;
      status.entries_ready = false;
      await task;
      await publish();
      await adapter?.store.release(owner.worker_id);
    },
  };
}
async function adapterSnapshotTx(tx: SqlExecutor, identity: string) {
  return (
    (
      await tx.query<{
        payload: import("./venues/hyperliquid/live-reconcile.js").LiveSnapshot;
      }>(
        "SELECT payload FROM jev_live_events WHERE identity_hash=$1 AND kind='snapshot' ORDER BY recorded_at DESC,event_key DESC LIMIT 1",
        [identity],
      )
    ).rows[0]?.payload ?? null
  );
}
