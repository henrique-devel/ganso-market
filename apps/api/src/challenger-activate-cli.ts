import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { UtcRfc3339Timestamp } from "@ganso-market/contracts";
import { loadConfig, requireStatementBudgets } from "./config.js";
import { createDatabasePool, type DatabasePool } from "./database.js";
import {
  loadChallengerConfig,
  type ChallengerConfig,
} from "./models/jev-config.js";
import { ledgerScope } from "./trading/ledger.js";
import type { LedgerIdentity } from "./storage/ledger-contract.js";
import { withBtcRetentionTransaction } from "./storage/btc-retention.js";
import { validateBaselineManifest } from "./storage/baseline-manifest.js";
import {
  baselineHash,
  baselineIso,
  validateBaselineRegistration,
  type BaselineRegistration,
} from "./storage/baseline-inputs.js";
import { baselineClock, baselineEvidenceTx } from "./storage/baseline-store.js";
import {
  challengerGateTx,
  challengerIdentity,
  challengerRegistrationTx,
  type ChallengerBinding,
} from "./storage/challenger-operations.js";

/** Explicit prospective registration only. Never called by boot or a migration.
 * This does NOT provision credit, reset a circuit/pause, call Jev or rearm risk.
 * The CLI always uses real; the mock argument is for disposable SQL tests only. */
export async function activateChallenger(
  pool: Pick<DatabasePool, "transaction">,
  username: string,
  codeSha: string,
  manifestSource: string,
  contract: string,
  config: ChallengerConfig,
  origin: "real" | "mock" = "real",
) {
  validateBaselineManifest(manifestSource, contract);
  if (!/^[a-f0-9]{40}$/.test(codeSha))
    throw new Error("BTC_CHALLENGER_CODE_SHA");
  return withBtcRetentionTransaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(6041083)");
    const owner = (
      await tx.query<{ account_id: string }>(
        "SELECT account_id::text FROM auth_accounts WHERE username=$1",
        [username],
      )
    ).rows[0];
    if (!owner) throw new Error("BTC_CHALLENGER_OWNER_REQUIRED");
    const source = (
      await tx.query<{
        registration: BaselineRegistration;
        identity: LedgerIdentity;
        owner: string;
        evidence_id: string;
        payload: { metadata_id: string };
      }>(
        `SELECT r.registration,a.identity,c.owner_account_id::text AS owner,r.evidence_id,o.payload FROM btc_baseline_registrations r
      JOIN btc_ledger_accounts a USING(account_id) JOIN btc_desk_controls c USING(account_id)
      JOIN btc_retention_objects o ON o.object_id=r.evidence_id WHERE r.account_id='baseline'
      AND a.identity->'account'->>'purpose'='baseline' AND a.identity->'account'->>'mode'='paper'`,
      )
    ).rows[0];
    if (!source || source.owner !== owner.account_id)
      throw new Error("BTC_CHALLENGER_SOURCE_OWNER_REQUIRED");
    validateBaselineRegistration(source.registration);
    const prior = await challengerRegistrationTx(tx);
    if (prior) {
      const sameOwner = (
        await tx.query(
          "SELECT 1 FROM btc_desk_controls WHERE account_id='challenger' AND owner_account_id=$1",
          [owner.account_id],
        )
      ).rowCount;
      if (!sameOwner) throw new Error("BTC_CHALLENGER_OWNER_CONFLICT");
      if (!prior.binding || prior.binding.origin !== origin)
        throw new Error("BTC_CHALLENGER_REGISTRATION_CONFLICT");
      return {
        status: "duplicate",
        registration: prior.registration,
        binding: prior.binding,
      };
    }
    if (
      (
        await tx.query(
          "SELECT 1 FROM btc_ledger_accounts WHERE account_id='challenger' OR identity->'account'->>'purpose'='challenger' LIMIT 1",
        )
      ).rowCount
    )
      throw new Error("BTC_CHALLENGER_EXISTING_ACCOUNT");
    const gate = await challengerGateTx(tx, config, origin);
    if (gate.reasons.length)
      return { status: "disabled", reasons: gate.reasons };
    const registered_at = await baselineClock(tx),
      start_at = baselineIso(
        (Math.floor(Date.parse(registered_at) / 900000) + 1) * 900000,
      );
    const experiment_id = `challenger:paper:${baselineHash([start_at, codeSha, source.registration]).slice(0, 32)}`;
    const identity: LedgerIdentity = structuredClone(source.identity);
    Object.assign(identity.account, {
      account_id: "challenger",
      purpose: "challenger",
      experiment_id,
    });
    Object.assign(identity.experiment, {
      experiment_id,
      started_at: start_at as UtcRfc3339Timestamp,
    });
    const registration: BaselineRegistration = {
      ...source.registration,
      scope: ledgerScope(identity),
      code_sha: codeSha,
      registered_at,
      start_at,
    };
    validateBaselineRegistration(registration);
    const binding: ChallengerBinding = {
      version: "btc.jev-comparison.v1",
      source_account: "baseline",
      source_registration_hash: baselineHash(source.registration),
      source_start_at: source.registration.start_at,
      comparison_start_at: start_at,
      ...challengerIdentity(config, origin),
    };
    await tx.query(
      `INSERT INTO btc_ledger_accounts(account_id,experiment_id,instrument_id,instrument_version,identity) VALUES('challenger',$1,$2,$3,$4::jsonb)`,
      [
        experiment_id,
        registration.scope.instrument_id,
        registration.scope.instrument_version,
        JSON.stringify(identity),
      ],
    );
    await tx.query(
      `INSERT INTO btc_desk_controls(account_id,owner_account_id,enabled,broker,latency_ms,signing_key) VALUES('challenger',$1,true,'ioc',1000,$2)`,
      [owner.account_id, randomBytes(32).toString("hex")],
    );
    const evidence_id = `challenger-registration:${baselineHash([registration, binding])}`;
    await baselineEvidenceTx(
      tx,
      { registration, evidence_id, enabled: true },
      evidence_id,
      {
        registration,
        challenger: binding,
        owner_account_id: owner.account_id,
        metadata_id: source.payload.metadata_id,
        source_evidence_id: source.evidence_id,
        contract,
      },
      registered_at,
      [source.evidence_id, source.payload.metadata_id],
    );
    await tx.query(
      "INSERT INTO btc_baseline_registrations(account_id,registration,evidence_id) VALUES('challenger',$1::jsonb,$2)",
      [JSON.stringify(registration), evidence_id],
    );
    return { status: "registered", registration, binding };
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const username = process.argv[2];
  if (!username)
    throw new Error(
      "usage: challenger-activate-cli OWNER < {manifest,contract}",
    );
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    manifest: string;
    contract: string;
  };
  const config = await loadConfig(),
    jev = await loadChallengerConfig();
  const pool = createDatabasePool(config, {
    max: 1,
    queryTimeoutMs: requireStatementBudgets(config).ceilingMs,
  });
  try {
    console.log(
      JSON.stringify(
        await activateChallenger(
          pool,
          username,
          (await readFile("/etc/ganso/release-sha", "utf8")).trim(),
          input.manifest,
          input.contract,
          jev,
        ),
      ),
    );
  } finally {
    await pool.end();
  }
}
