import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Sha256Hex, UtcRfc3339Timestamp } from "@ganso-market/contracts";
import type { TradingInstrumentMetadata } from "@ganso-market/contracts/trading";
import { loadConfig, requireStatementBudgets } from "./config.js";
import { createDatabasePool, type DatabasePool } from "./database.js";
import { ledgerScope } from "./trading/ledger.js";
import type { LedgerIdentity } from "./storage/ledger-contract.js";
import { withBtcRetentionTransaction } from "./storage/btc-retention.js";
import {
  validateBaselineManifest,
  BASELINE_FINGERPRINT,
} from "./storage/baseline-manifest.js";
import {
  baselineHash,
  baselineIso,
  validateBaselineRegistration,
  type BaselineRegistration,
} from "./storage/baseline-inputs.js";
import { baselineClock, baselineEvidenceTx } from "./storage/baseline-store.js";

/** Explicit activation, never called by startup/migration. No reset or replacement
 * of a prior registration, owner, pause, genesis or prospective start. */
export async function activateBaseline(
  pool: Pick<DatabasePool, "transaction">,
  username: string,
  codeSha: string,
  manifestSource: string,
  contract: string,
) {
  const manifest = validateBaselineManifest(manifestSource, contract);
  if (!/^[a-f0-9]{40}$/.test(codeSha)) throw new Error("BTC_BASELINE_CODE_SHA");
  return withBtcRetentionTransaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(6041073)");
    const owner = (
      await tx.query<{ account_id: string }>(
        "SELECT account_id::text FROM auth_accounts WHERE username=$1",
        [username],
      )
    ).rows[0];
    if (!owner) throw new Error("BTC_BASELINE_OWNER_REQUIRED");
    const prior = (
      await tx.query<{
        registration: BaselineRegistration;
        owner: string;
      }>(`SELECT r.registration,c.owner_account_id::text AS owner FROM btc_baseline_registrations r
      JOIN btc_desk_controls c USING(account_id) WHERE r.account_id='baseline'`)
    ).rows[0];
    if (prior) {
      if (prior.owner !== owner.account_id)
        throw new Error("BTC_BASELINE_OWNER_CONFLICT");
      validateBaselineRegistration(prior.registration);
      return { status: "duplicate", registration: prior.registration };
    }
    if (
      (
        await tx.query(
          "SELECT 1 FROM btc_ledger_accounts WHERE account_id='baseline' OR identity->'account'->>'purpose'='baseline' LIMIT 1",
        )
      ).rowCount
    )
      throw new Error("BTC_BASELINE_EXISTING_ACCOUNT");
    const registered_at = await baselineClock(tx),
      start_at = baselineIso(
        (Math.floor(Date.parse(registered_at) / 900000) + 1) * 900000,
      );
    const meta = (
      await tx.query<{ object_id: string; payload: TradingInstrumentMetadata }>(
        `SELECT r.object_id,o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id)
      WHERE kind='metadata' AND r.received_at <= $1 AND o.recorded_at <= $1 ORDER BY r.received_at DESC,r.object_id LIMIT 1`,
        [registered_at],
      )
    ).rows[0];
    if (
      !meta ||
      meta.payload.fees.taker.raw !== "450000" ||
      meta.payload.fees.taker.decimals !== 9 ||
      meta.payload.provenance.reference_version !==
        "hyperliquid-mainnet-btc.2026-09-23.1"
    )
      throw new Error("BTC_BASELINE_METADATA_REQUIRED");
    const experiment_id = `baseline:paper:${baselineHash([start_at, codeSha]).slice(0, 32)}`;
    const identity: LedgerIdentity = {
      account: {
        schema_version: "trading.v1",
        account_id: "baseline",
        experiment_id,
        mode: "paper",
        purpose: "baseline",
        settlement_currency: "USD",
      },
      experiment: {
        schema_version: "trading.v1",
        experiment_id,
        mode: "paper",
        strategy_version: "btc.baseline.trend.v1",
        started_at: start_at as UtcRfc3339Timestamp,
        manifest_hash: manifest.manifest_hash as Sha256Hex,
      },
      instrument: meta.payload.instrument,
    };
    const registration: BaselineRegistration = {
      scope: ledgerScope(identity),
      policy_version: "btc.baseline.trend.v1",
      manifest_fingerprint: BASELINE_FINGERPRINT,
      code_sha: codeSha,
      metadata_hash: baselineHash(meta.payload),
      registered_at,
      start_at,
    };
    validateBaselineRegistration(registration);
    // Register before start; the consumer materializes genesis at/after start.
    // A future economic event cannot be recorded early by the ledger contract.
    await tx.query(
      `INSERT INTO btc_ledger_accounts(account_id,experiment_id,instrument_id,instrument_version,identity)
      VALUES($1,$2,$3,$4,$5::jsonb)`,
      [
        "baseline",
        experiment_id,
        registration.scope.instrument_id,
        registration.scope.instrument_version,
        JSON.stringify(identity),
      ],
    );
    await tx.query(
      `INSERT INTO btc_desk_controls(account_id,owner_account_id,enabled,broker,latency_ms,signing_key) VALUES('baseline',$1,true,'ioc',1000,$2)`,
      [owner.account_id, randomBytes(32).toString("hex")],
    );
    const evidence_id = `baseline-registration:${baselineHash(registration)}`;
    await baselineEvidenceTx(
      tx,
      { registration, evidence_id, enabled: true },
      evidence_id,
      {
        registration,
        owner_account_id: owner.account_id,
        metadata_id: meta.object_id,
        manifest: JSON.parse(manifest.canonical_json),
        contract,
      },
      registered_at,
      [meta.object_id],
    );
    await tx.query(
      "INSERT INTO btc_baseline_registrations(account_id,registration,evidence_id) VALUES('baseline',$1::jsonb,$2)",
      [JSON.stringify(registration), evidence_id],
    );
    return { status: "activated", registration };
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const username = process.argv[2];
  if (!username)
    throw new Error("usage: baseline-activate-cli OWNER < {manifest,contract}");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    manifest: string;
    contract: string;
  };
  const sha = (await readFile("/etc/ganso/release-sha", "utf8")).trim();
  const config = await loadConfig(),
    pool = createDatabasePool(config, {
      max: 1,
      queryTimeoutMs: requireStatementBudgets(config).ceilingMs,
    });
  try {
    console.log(
      JSON.stringify(
        await activateBaseline(
          pool,
          username,
          sha,
          input.manifest,
          input.contract,
        ),
      ),
    );
  } finally {
    await pool.end();
  }
}
