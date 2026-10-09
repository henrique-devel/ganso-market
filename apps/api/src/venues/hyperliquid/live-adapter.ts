import type { AbstractWallet } from "@nktkas/hyperliquid/signing";
import { PgLiveStore } from "../../storage/jev-live-store.js";
import type { DatabasePool } from "../../database.js";
import { createHyperliquidLiveBoundary, type LiveWire } from "./live-auth.js";
import type { LiveIdentity } from "./live-contract.js";
import { LiveExecution } from "./live-execution.js";
import { LiveProtectionCoordinator } from "./live-protection.js";
import { collectLiveSnapshot, recoverLiveAccount } from "./live-reconcile.js";

/** Explicit construction seam only: no env/key discovery, boot hook, registration,
 * network request or activation. The existing production pilot gate stays false.
 * JE14 owns runtime admission; GJ13.5 owns external venue trials. */
export function createLiveAdapter(input: {
  pool: Pick<DatabasePool, "transaction">;
  identity: LiveIdentity;
  history_from: number;
  executor_enabled?: boolean;
  wallet?: AbstractWallet;
  wire?: LiveWire;
  clock?: () => number;
}) {
  const clock = input.clock ?? Date.now;
  const store = new PgLiveStore(input.pool, input.identity);
  const boundary = createHyperliquidLiveBoundary({
    identity: store.identity,
    ...(input.executor_enabled !== undefined
      ? { executor_enabled: input.executor_enabled }
      : {}),
    ...(input.wallet ? { wallet: input.wallet } : {}),
    ...(input.wire ? { wire: input.wire } : {}),
    clock,
    gate: (r) => store.gate(r),
    claim: (r) => store.claimSubmission(r),
  });
  const execution = new LiveExecution(store, boundary, clock);
  const protection = new LiveProtectionCoordinator(execution, () =>
    collectLiveSnapshot(boundary, input.history_from, clock),
  );
  return {
    store,
    boundary,
    execution,
    protection,
    async reconcile() {
      const recovered = await recoverLiveAccount({
        boundary,
        execution,
        from: input.history_from,
        clock,
      });
      if (
        recovered.snapshot &&
        !recovered.pending &&
        input.identity.environment === "mainnet"
      )
        await store.observeExistingPilot(recovered.snapshot);
      return recovered;
    },
  };
}
