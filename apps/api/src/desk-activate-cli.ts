import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Sha256Hex, UtcRfc3339Timestamp } from "@ganso-market/contracts";
import type { TradingInstrumentMetadata } from "@ganso-market/contracts/trading";
import { loadConfig, requireStatementBudgets } from "./config.js";
import { createDatabasePool, type DatabasePool } from "./database.js";
import { createLedgerAccount } from "./storage/ledgerstore.js";
import type { LedgerIdentity } from "./storage/ledger-contract.js";

/** Explicit operator-only activation. Atomic owner binding + idempotent $1000
 * genesis; repeated invocation never reallocates or resets risk/history. */
export async function activateManualDesk(
  pool: Pick<DatabasePool, "transaction">,
  username: string,
  broker: "ioc" | "passive",
) {
  return pool.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(6041063)");
    const owner = (
      await tx.query<{ account_id: string }>(
        "SELECT account_id::text FROM auth_accounts WHERE username=$1",
        [username],
      )
    ).rows[0];
    if (!owner) throw new Error("BTC_DESK_OWNER_REQUIRED");
    const prior = (
      await tx.query<{ identity: LedgerIdentity }>(
        "SELECT identity FROM btc_ledger_accounts WHERE account_id='manual'",
      )
    ).rows[0];
    const meta = (
      await tx.query<{ payload: TradingInstrumentMetadata }>(
        `SELECT o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id) WHERE kind='metadata' ORDER BY received_at DESC,object_id LIMIT 1`,
      )
    ).rows[0];
    if (!meta) throw new Error("BTC_DESK_METADATA_REQUIRED");
    const started = (
      await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0]!.now.toISOString() as UtcRfc3339Timestamp;
    const identity: LedgerIdentity = prior?.identity ?? {
      account: {
        schema_version: "trading.v1",
        account_id: "manual",
        experiment_id: "manual:paper:v1",
        mode: "paper",
        purpose: "manual",
        settlement_currency: "USD",
      },
      experiment: {
        schema_version: "trading.v1",
        experiment_id: "manual:paper:v1",
        mode: "paper",
        strategy_version: "manual.v1",
        started_at: started,
        manifest_hash: createHash("sha256")
          .update("manual.paper.v1:1000USD:risk.v1")
          .digest("hex") as Sha256Hex,
      },
      instrument: meta.payload.instrument,
    };
    if (
      identity.account.purpose !== "manual" ||
      identity.account.mode !== "paper" ||
      identity.experiment.strategy_version !== "manual.v1"
    )
      throw new Error("BTC_DESK_IDENTITY_CONFLICT");
    const genesis = await createLedgerAccount(
      { transaction: (run) => run(tx) },
      identity,
    );
    await tx.query(
      `INSERT INTO btc_desk_controls(account_id,owner_account_id,enabled,broker,latency_ms,signing_key)
      VALUES('manual',$1,true,$2,250,$3) ON CONFLICT DO NOTHING`,
      [owner.account_id, broker, randomBytes(32).toString("hex")],
    );
    const binding = (
      await tx.query<{
        owner_account_id: string;
        broker: string;
        enabled: boolean;
      }>(
        "SELECT owner_account_id::text,broker,enabled FROM btc_desk_controls WHERE account_id='manual'",
      )
    ).rows[0]!;
    if (
      binding.owner_account_id !== owner.account_id ||
      binding.broker !== broker ||
      !binding.enabled
    )
      throw new Error("BTC_DESK_ACTIVATION_CONFLICT");
    return {
      account_id: "manual",
      mode: "paper",
      simulation: "SIMULAÇÃO",
      broker,
      genesis: genesis.status,
    };
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [username, broker] = process.argv.slice(2);
  if (!username || !["ioc", "passive"].includes(broker ?? ""))
    throw new Error("usage: desk-activate-cli OWNER ioc|passive");
  const config = await loadConfig();
  const pool = createDatabasePool(config, {
    max: 1,
    queryTimeoutMs: requireStatementBudgets(config).ceilingMs,
  });
  try {
    console.log(
      JSON.stringify(
        await activateManualDesk(pool, username, broker as "ioc" | "passive"),
      ),
    );
  } finally {
    await pool.end();
  }
}
