import type { DatabasePool } from "../database.js";
import { loadChallengerConfig, type ChallengerConfig } from "./jev-config.js";
import {
  createJevDecisionStore,
  readJevDecision,
  readJevCosts,
} from "../storage/jev-decision-store.js";
import { createJevBatchTransport } from "./jev-decision-typesafe.js";
import { createJevDecisionAdapter } from "./jev-decision.js";
import { type JevBatch } from "./jev-decision-contract.js";
/** Protected configuration + durable budget + explicit future admission are
 * independent gates. Reading a key or constructing this backend never admits it.
 * The caller supplies authenticated ownership for audit reads; no public route or scheduler. */
export async function loadJevDecisionBackend(
  pool: Pick<DatabasePool, "transaction">,
  options: { admitted?: boolean; configuration?: ChallengerConfig } = {},
) {
  const config = options.configuration ?? (await loadChallengerConfig());
  const store = createJevDecisionStore(pool);
  const enabled =
    options.admitted === true &&
    config.enabled &&
    config.credentialPresent &&
    config.key !== null &&
    config.tariff !== null;
  const adapter = enabled
    ? createJevDecisionAdapter({
        store,
        enabled: true,
        tariff: config.tariff!,
        transport: createJevBatchTransport(config.key!, config.tariff!.model),
      })
    : null;
  return {
    status: Object.freeze({
      enabled,
      origin: "real",
      model: config.tariff?.model ?? null,
      credential_present: config.credentialPresent,
      reasons: enabled
        ? []
        : [
            ...config.reasons,
            ...(options.admitted ? [] : ["admission_pending"]),
          ],
    }),
    async evaluate(batch: JevBatch, cancellation?: AbortSignal) {
      if (adapter) return adapter.evaluate(batch, cancellation);
      const result = await store.reserve(
        batch,
        "real",
        config.tariff,
        "disabled",
      );
      if ("token" in result) throw new Error("JEV_DISABLED_RESERVATION");
      return result;
    },
    read: (owner: string, requestId: string) =>
      readJevDecision(pool, owner, "real", requestId),
    costs: (month: string) => readJevCosts(pool, "real", month),
  };
}
