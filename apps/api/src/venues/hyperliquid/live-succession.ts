import type { DatabasePool } from "../../database.js";
import type { TradingInstrumentMetadata } from "@ganso-market/contracts/trading";
import {
  advanceJevPromotion,
  readJevPromotionTx,
} from "../../storage/jev-promotion.js";
import { withBtcRetentionTransaction } from "../../storage/btc-retention.js";
import { loadJevAccountTx } from "../../storage/jev-store.js";
import {
  readJevEntriesTx,
  jevEntryEventTx,
} from "../../storage/jev-riskstore.js";
import { jevScope } from "../../storage/jev-ledger.js";
import { jevHash } from "../../storage/jev-hash.js";
import type { LiveLease, PgLiveStore } from "../../storage/jev-live-store.js";
import type { LiveSnapshot } from "./live-reconcile.js";
import { LiveExecution, LIVE_COMMAND_VERSION } from "./live-execution.js";

/** Deliberately constructed with the existing authenticated adapter. It never
 * discovers a wallet, activates a pilot or treats an exit ACK as a fill. */
export class LiveSuccessionCoordinator {
  constructor(
    readonly store: PgLiveStore,
    readonly execution: Pick<LiveExecution, "execute">,
    readonly reconcileAccount: () => Promise<{
      snapshot: LiveSnapshot | null;
      pending: boolean;
    }>,
  ) {}
  async reconcile(input: {
    metadata: TradingInstrumentMetadata;
    metadata_at: number;
    close_limit_price_raw: string;
    lease: LiveLease;
  }) {
    const store = this.store,
      owner = store.identity.owner_id,
      pool = store.pool;
    const state = await advanceJevPromotion(pool, owner);
    if (state.status !== "draining" || !state.promotion) return state;
    const promotion = state.promotion;
    const scope = await pool.transaction(async (tx) => {
      const l = await loadJevAccountTx(tx, owner, store.identity.account_id);
      const b = l.identity.bindings.find(
        (b) => b.binding.experiment_id === promotion.experiment_id,
      )!;
      return jevScope(b.binding, l.identity.instrument);
    });
    // Cancel parents, preserving native position protection. Failed cancellation
    // must not prevent the independent reduce-only exit.
    const errors: string[] = [];
    for (const r of await store.operations())
      if (
        r.kind === "entry" &&
        r.scope.experiment_id === promotion.experiment_id
      ) {
        try {
          await this.execution.execute(
            {
              version: LIVE_COMMAND_VERSION,
              kind: "cancel",
              scope,
              operation_id: `cancel:${jevHash(r.operation_id)}`,
              target_operation_id: r.operation_id,
              target_cloid: r.cloid,
              metadata: input.metadata,
              metadata_at: input.metadata_at,
            },
            input.lease,
          );
        } catch {
          errors.push("cancellation_pending");
        }
      }
    const recovered = await this.reconcileAccount();
    if (recovered.snapshot && recovered.snapshot.position_raw !== "0") {
      try {
        await this.execution.execute(
          {
            version: LIVE_COMMAND_VERSION,
            kind: "close",
            scope,
            operation_id: `succession-close:${jevHash([promotion.sequence, recovered.snapshot.snapshot_id])}`,
            metadata: input.metadata,
            metadata_at: input.metadata_at,
            snapshot: recovered.snapshot,
            limit_price_raw: input.close_limit_price_raw,
            cause: "profile_failed",
          },
          input.lease,
        );
      } catch {
        errors.push("reduction_pending");
      }
      return { status: "draining", errors };
    }
    if (!recovered.snapshot || recovered.pending)
      return { status: "draining", errors };
    await settleJevLiveReservations(pool, store, recovered.snapshot);
    return advanceJevPromotion(pool, owner);
  }
}
/** Reconcile financial reservations only from a stored flat, complete snapshot
 * plus a terminal receipt preceding it. Unsent cancellation latches cannot race
 * signing because both writers lock the same financial account. */
async function settleJevLiveReservations(
  pool: Pick<DatabasePool, "transaction">,
  store: PgLiveStore,
  s: LiveSnapshot,
) {
  return withBtcRetentionTransaction(pool, async (tx) => {
    await loadJevAccountTx(
      tx,
      store.identity.owner_id,
      store.identity.account_id,
      true,
    );
    const p = await readJevPromotionTx(tx, store.identity.account_id);
    if (
      p?.state !== "draining" ||
      !s.flat ||
      s.position_raw !== "0" ||
      s.orders.length ||
      !s.history_complete ||
      !s.consistent
    )
      return;
    const stored = (
      await tx.query<{ payload: LiveSnapshot }>(
        "SELECT payload FROM jev_live_events WHERE identity_hash=$1 AND event_key=$2",
        [store.identityHash, `snapshot:${s.snapshot_id}`],
      )
    ).rows[0];
    if (!stored || jevHash(stored.payload) !== jevHash(s)) return;
    const now = (
      await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0]!.now.getTime();
    if (s.received_at > now || now - s.started_at > 2000) return;
    const balance = (
      await tx.query<{ payload: { reconciled: boolean } }>(
        "SELECT payload FROM jev_live_events WHERE identity_hash=$1 AND kind='balance' AND payload->>'snapshot_id'=$2 ORDER BY recorded_at DESC LIMIT 1",
        [store.identityHash, s.snapshot_id],
      )
    ).rows[0]?.payload;
    if (!balance?.reconciled) return;
    const requests = await storeRequestsTx(tx, store.identityHash);
    for (const e of await readJevEntriesTx(tx, store.identity.account_id)) {
      if (e.status === "released") continue;
      const sent = requests.find(
        (r) =>
          r.reservation.kind === "entry" &&
          r.reservation.request.kind === "entry" &&
          r.reservation.request.plan.input.order_id === e.order_id,
      );
      if (sent) {
        const terminal = (
          await tx.query<{ payload: { state: string; observed_at: number } }>(
            "SELECT payload FROM jev_live_events WHERE identity_hash=$1 AND kind='receipt' AND payload->>'operation_id'=$2 ORDER BY recorded_at DESC,event_key DESC LIMIT 1",
            [store.identityHash, sent.reservation.operation_id],
          )
        ).rows[0]?.payload;
        if (
          !terminal ||
          !["filled", "cancelled", "rejected"].includes(terminal.state) ||
          terminal.observed_at > s.venue_at
        )
          continue;
      }
      if (e.status === "cancel_requested")
        await jevEntryEventTx(
          tx,
          e.plan,
          "released",
          `succession-release:${jevHash([e.order_id, s.snapshot_id])}`,
        );
    }
  });
}
async function storeRequestsTx(
  tx: import("../../database.js").SqlExecutor,
  identity: string,
) {
  return (
    await tx.query<{
      reservation: import("./live-contract.js").LiveReservation & {
        request: import("./live-execution.js").LiveCommand;
      };
    }>("SELECT reservation FROM jev_live_requests WHERE identity_hash=$1", [
      identity,
    ])
  ).rows;
}
