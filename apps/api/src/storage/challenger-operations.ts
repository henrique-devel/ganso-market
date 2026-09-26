import type { DeskJevView } from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import {
  disabledChallengerConfig,
  type ChallengerConfig,
} from "../models/jev-config.js";
import { createJevAdapter } from "../models/jev.js";
import { createTypeSafeTransport } from "../models/jev-typesafe.js";
import {
  JEV_VERSION,
  JEV_PROMPT_VERSION,
  JEV_PROMPT_HASH,
  jevHash,
  quote,
  type JevTransport,
} from "../models/jev-contract.js";
import { createJevStore } from "./jevstore.js";
import { createChallengerConsumer } from "./challenger-runtime.js";
import { baselineClock } from "./baseline-store.js";
import { baselineHash, type BaselineRegistration } from "./baseline-inputs.js";

export interface ChallengerBinding {
  version: "btc.jev-comparison.v1";
  source_account: string;
  source_registration_hash: string;
  source_start_at: string;
  comparison_start_at: string;
  origin: "real" | "mock";
  model: string;
  adapter_version: typeof JEV_VERSION;
  prompt_version: typeof JEV_PROMPT_VERSION;
  prompt_hash: string;
  tariff_hash: string;
  billing_bound_reference: string;
}
export const challengerIdentity = (
  config: ChallengerConfig,
  origin: "real" | "mock" = "real",
) => ({
  origin,
  model: config.tariff?.model ?? "unconfigured",
  adapter_version: JEV_VERSION,
  prompt_version: JEV_PROMPT_VERSION,
  prompt_hash: JEV_PROMPT_HASH,
  tariff_hash: config.tariff ? jevHash(config.tariff) : "",
  billing_bound_reference: config.billingBoundReference ?? "",
});
export async function challengerGateTx(
  tx: SqlExecutor,
  config: ChallengerConfig,
  origin: "real" | "mock" = "real",
  admission = false,
) {
  const now = await baselineClock(tx);
  const reasons = [...config.reasons];
  if (!config.enabled) reasons.push("switch_disabled");
  if (!config.credentialPresent || !config.key)
    reasons.push("credential_unavailable");
  const reserve = quote(
    config.tariff ?? undefined,
    config.tariff?.model ?? "",
    new Date(Date.parse(now) + 5000).toISOString(),
  );
  if (!reserve || !config.billingBoundReference)
    reasons.push("billing_bound_unavailable");
  const budget = (
    await tx.query<{
      enabled: boolean;
      month: string;
      tariff_hash: string;
      provision_reference: string;
      limit_usd6: string;
      committed_usd6: string;
      circuit_open: boolean;
    }>(
      `SELECT * FROM btc_jev_budgets WHERE origin=$1${admission ? " FOR SHARE" : ""}`,
      [origin],
    )
  ).rows[0];
  if (
    !budget ||
    !budget.enabled ||
    !config.provisionReference ||
    budget.provision_reference !== config.provisionReference
  )
    reasons.push("coverage_unavailable");
  if (budget) {
    if (budget.month !== now.slice(0, 7))
      reasons.push("coverage_month_expired");
    if (!config.tariff || budget.tariff_hash !== jevHash(config.tariff))
      reasons.push("tariff_mismatch");
    if (budget.circuit_open) reasons.push("circuit_open");
    if (
      !admission &&
      reserve &&
      BigInt(budget.committed_usd6) + BigInt(reserve) >
        BigInt(budget.limit_usd6)
    )
      reasons.push("budget_exhausted");
  }
  return { now, budget, reasons: [...new Set(reasons)] };
}
export async function challengerRegistrationTx(
  tx: SqlExecutor,
  account = "challenger",
) {
  return (
    (
      await tx.query<{
        registration: BaselineRegistration;
        binding: ChallengerBinding | null;
        enabled: boolean;
        evidence_id: string;
      }>(
        `SELECT r.registration,o.payload->'challenger' AS binding,c.enabled,r.evidence_id
    FROM btc_baseline_registrations r JOIN btc_desk_controls c USING(account_id)
    JOIN btc_ledger_accounts a USING(account_id) JOIN btc_retention_objects o ON o.object_id=r.evidence_id
    WHERE r.account_id=$1 AND a.identity->'account'->>'purpose'='challenger' AND a.identity->'account'->>'mode'='paper'`,
        [account],
      )
    ).rows[0] ?? null
  );
}
export async function challengerReadinessTx(
  tx: SqlExecutor,
  config: ChallengerConfig,
  account = "challenger",
  origin: "real" | "mock" = "real",
  admission = false,
) {
  const gate = await challengerGateTx(tx, config, origin, admission);
  const registration = await challengerRegistrationTx(tx, account);
  if (!registration?.binding) gate.reasons.push("registration_required");
  else {
    if (!registration.enabled) gate.reasons.push("entries_paused");
    if (registration.registration.start_at > gate.now)
      gate.reasons.push("prospective_start_pending");
    const binding = registration.binding;
    const identity = challengerIdentity(config, origin);
    if (
      Object.entries(identity).some(
        ([k, v]) => binding[k as keyof ChallengerBinding] !== v,
      )
    )
      gate.reasons.push("registration_identity_mismatch");
    const source = (
      await tx.query<{ registration: BaselineRegistration }>(
        "SELECT registration FROM btc_baseline_registrations WHERE account_id=$1",
        [binding.source_account],
      )
    ).rows[0];
    if (
      !source ||
      baselineHash(source.registration) !== binding.source_registration_hash
    )
      gate.reasons.push("source_registration_mismatch");
  }
  return { ...gate, registration };
}
/** Existing process/pool only. Gate changes suppress entries; the same consumer
 * continues exits and recovery. No timer or paid request is started by creation. */
export function createOperationalChallenger(
  pool: Pick<DatabasePool, "transaction" | "readOnly">,
  config: ChallengerConfig = disabledChallengerConfig(),
  log: (reason: string) => void = () => {},
  testTransport?: JevTransport,
) {
  if (testTransport && testTransport.origin !== "mock")
    throw new Error("BTC_CHALLENGER_TEST_TRANSPORT_MUST_BE_MOCK");
  const transport: JevTransport =
    testTransport ??
    (config.key && config.tariff
      ? createTypeSafeTransport(config.key, config.tariff.model)
      : {
          origin: "real",
          model: "unconfigured",
          async evaluate() {
            throw new Error("BTC_CHALLENGER_CREDENTIAL_UNAVAILABLE");
          },
        });
  const adapter = createJevAdapter({
    store: createJevStore(pool),
    transport,
    enabled: config.enabled && !!config.key,
    tariff: config.tariff ?? undefined,
  });
  const consumers = new Map<
    string,
    {
      permitted: boolean;
      consumer: ReturnType<typeof createChallengerConsumer>;
    }
  >();
  return {
    async tick(account: string) {
      // A DB/configuration error must not skip exits in the registered account.
      let row: Awaited<ReturnType<typeof challengerReadinessTx>> | null = null;
      try {
        row = await pool.readOnly(1500, (tx) =>
          challengerReadinessTx(tx, config, account, transport.origin),
        );
      } catch {
        log("BTC_CHALLENGER_GATE_UNAVAILABLE");
      }
      let state = consumers.get(account);
      if (!state) {
        const next = {
          permitted: false,
          consumer: null as unknown as ReturnType<
            typeof createChallengerConsumer
          >,
        };
        next.consumer = createChallengerConsumer(pool, {
          account,
          sourceAccount:
            row?.registration?.binding?.source_account ?? "baseline",
          adapter,
          enabled: true,
          isEnabled: () => next.permitted,
          admissionAllowedTx: async (tx) =>
            (
              await challengerReadinessTx(
                tx,
                config,
                account,
                transport.origin,
                true,
              )
            ).reasons.length === 0,
          onError: log,
        });
        state = next;
        consumers.set(account, state);
      }
      state.permitted = !!row && row.reasons.length === 0;
      await state.consumer.tick();
    },
    async drain() {
      await Promise.all([...consumers.values()].map((s) => s.consumer.drain()));
    },
    async stop() {
      await Promise.all([...consumers.values()].map((s) => s.consumer.stop()));
    },
  };
}
export async function readChallengerStatusTx(
  tx: SqlExecutor,
  config: ChallengerConfig = disabledChallengerConfig(),
): Promise<DeskJevView> {
  const { now, budget, registration, reasons } = await challengerReadinessTx(
    tx,
    config,
  );
  const costs = (
    await tx.query<{
      measured_usd6: string;
      uncertain_reserved_usd6: string;
      calls: string;
    }>(
      `SELECT COALESCE(sum((result->>'cost_usd6')::numeric) FILTER(WHERE finished_at IS NOT NULL AND result->>'cost_usd6' IS NOT NULL),0)::text AS measured_usd6,
    COALESCE(sum(reserved_usd6) FILTER(WHERE finished_at IS NULL OR result->>'cost_usd6' IS NULL),0)::text AS uncertain_reserved_usd6,
    count(*)::text AS calls FROM btc_jev_calls WHERE origin='real' AND month=$1`,
      [now.slice(0, 7)],
    )
  ).rows[0]!;
  const recent = (
    await tx.query<DeskJevView["recent"][number]>(
      `SELECT d.decision_id,d.decision->>'source_decision_id' AS source_decision_id,d.decision->>'bar_end_at' AS bar_end_at,
    d.decision->>'state' AS eligibility,d.decision->'reasons' AS eligibility_reasons,
    j.state AS request_state,j.request->>'deadline_at' AS deadline_at,
    CASE WHEN (COALESCE(c.result,j.outcome->'result')->>'attempted')::boolean THEN j.origin ELSE NULL END AS origin,
    COALESCE((COALESCE(c.result,j.outcome->'result')->>'attempted')::boolean,false) AS attempted,
    COALESCE(c.result,j.outcome->'result')->>'decision' AS decision,
    COALESCE(c.result,j.outcome->'result')->>'reason' AS reason,
    COALESCE(c.result,j.outcome->'result')->>'cost_usd6' AS cost_usd6,
    COALESCE(c.result,j.outcome->'result')->>'reserved_usd6' AS reserved_usd6,
    (COALESCE(c.result,j.outcome->'result')->>'duration_ms')::double precision AS duration_ms,
    COALESCE(c.result,j.outcome->'result')->>'response_received_at' AS response_received_at,
    COALESCE(j.outcome->'reasons','[]'::jsonb) AS admission_reasons,
    j.outcome->'admission'->'result'->>'status' AS admission_status
    FROM (SELECT * FROM btc_baseline_decisions WHERE account_id='challenger' ORDER BY bar_end_at DESC LIMIT 20) d
    LEFT JOIN btc_jev_challenger_requests j USING(decision_id)
    LEFT JOIN btc_jev_calls c ON c.origin=j.origin AND c.request_id=j.request_id ORDER BY d.bar_end_at DESC`,
    )
  ).rows;
  return {
    as_of: now,
    enabled: reasons.length === 0,
    reasons,
    credential_present: config.credentialPresent,
    configured_origin: "real",
    registration: registration?.binding
      ? {
          ...registration.binding,
          ...registration.registration,
          account_id: "challenger",
        }
      : null,
    real_api_cost: {
      month: now.slice(0, 7),
      ...costs,
      limit_usd6: budget?.limit_usd6 ?? null,
      committed_usd6: budget?.committed_usd6 ?? "0",
      circuit_open: budget?.circuit_open ?? false,
    },
    recent,
  };
}
