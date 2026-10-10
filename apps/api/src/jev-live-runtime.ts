import type { AbstractWallet } from "@nktkas/hyperliquid/signing";
import { getWalletAddress } from "@nktkas/hyperliquid/signing";
import type { DatabasePool } from "./database.js";
import type { ExecutionLease } from "./storage/execution-worker-lease.js";
import {
  loadJevLiveConfig,
  loadJevLiveSigner,
  type JevLiveConfig,
} from "./models/jev-live-config.js";
import {
  JEV_LIVE_CAPABILITIES,
  jevLiveIntegrationReady,
} from "./storage/jev-live-capabilities.js";
import { createLiveAdapter } from "./venues/hyperliquid/live-adapter.js";
import {
  validateLiveIdentity,
  LiveError,
  type LiveIdentity,
} from "./venues/hyperliquid/live-contract.js";
import type { LiveWire } from "./venues/hyperliquid/live-auth.js";

type Pool = Pick<DatabasePool, "transaction" | "readOnly">;
export async function loadJevLiveRuntime(input: {
  pool: Pool;
  lease: ExecutionLease;
  sha: string;
  configuration?: () => Promise<JevLiveConfig | null>;
  signer?: () => Promise<AbstractWallet>;
  wire?: LiveWire;
}) {
  const status = {
    version: "jev.live-runtime.v1",
    adapter_available: true,
    connected: false,
    signer_loaded: false,
    entries_ready: false,
    capabilities: JEV_LIVE_CAPABILITIES,
    reasons: ["configuration_missing"],
  };
  try {
    const c = await (input.configuration ?? loadJevLiveConfig)();
    if (!c) return { status, adapter: null };
    const row = await input.pool.transaction(
      async (tx) =>
        (
          await tx.query<{
            identity: LiveIdentity;
            activated: boolean;
            history_from: Date | null;
          }>(
            `SELECT i.identity,EXISTS(SELECT 1 FROM jev_live_activations a WHERE a.identity_hash=i.identity_hash AND a.owner_id=i.owner_id) activated,
        (SELECT min((request->'observation'->>'observed_at')::timestamptz) FROM jev_pilot_events WHERE account_id=i.account_id) history_from
        FROM jev_live_identities i JOIN jev_accounts a USING(account_id)
        WHERE i.identity_hash=$1 AND i.environment=$2 AND a.owner_id=i.owner_id AND a.mode='live'`,
            [c.identity_hash, c.environment],
          )
        ).rows[0],
    );
    if (
      !row ||
      validateLiveIdentity(row.identity) !== c.identity_hash ||
      row.identity.environment !== c.environment ||
      !row.activated ||
      !row.history_from
    )
      throw new Error("JEV_LIVE_IDENTITY_OR_ACTIVATION_MISSING");
    const wallet = await (input.signer ?? loadJevLiveSigner)();
    if ((await getWalletAddress(wallet)) !== row.identity.signer_address)
      throw new Error("JEV_LIVE_SIGNER_IDENTITY");
    const adapter = createLiveAdapter({
      pool: input.pool,
      identity: row.identity,
      history_from: row.history_from.getTime(),
      executor_enabled: true,
      observe_pilot: true,
      entries_ready: () => status.entries_ready,
      wallet,
      ...(input.wire ? { wire: input.wire } : {}),
    });
    await adapter.store.claim(input.lease.worker_id);
    status.connected = true;
    status.signer_loaded = true;
    status.reasons = jevLiveIntegrationReady()
      ? ["recovery_pending"]
      : ["live_integration_pending"];
    return { status, adapter };
  } catch (error) {
    // A valid activated pilot must not boot permanently disconnected merely
    // because its retiring live lease outlives the process lease briefly.
    // Docker restarts this fenced process after ownership becomes available.
    if (error instanceof LiveError && error.code === "OWNERSHIP_BUSY")
      throw new Error("JEV_LIVE_RUNTIME_OWNERSHIP_BUSY");
    status.reasons = [
      error instanceof Error && /^JEV_LIVE_[A-Z_]+$/.test(error.message)
        ? error.message
        : "JEV_LIVE_CONFIGURATION_UNAVAILABLE",
    ];
    return { status, adapter: null };
  }
}
