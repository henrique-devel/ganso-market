import type { DatabasePool } from "../database.js";
import type { ChallengerConfig } from "../models/jev-config.js";
import { createProposalTransport } from "../models/jev-proposal.js";
import { generateJevProposal } from "./jev-generator.js";
import { admitJevSuccessor, retireFailedJevPairs } from "./jev-successions.js";

export const JEV_PROPOSAL_LANE_VERSION = "jev.proposal-lane.v1";
export const JEV_PROPOSAL_INTERVAL_MS = 60000;
/** One independent lane, no backlog and no lock held across provider I/O.
 * Boot never creates controls, credit, evidence or admissions. Each transaction
 * rechecks its own gate through the caller's process fence. */
export function createJevProposalLane(
  pool: Pick<DatabasePool, "transaction">,
  config: ChallengerConfig,
  onFailure: () => void,
) {
  const enabled =
    config.enabled &&
    config.credentialPresent &&
    !!config.key &&
    !!config.tariff;
  const transport = enabled
    ? createProposalTransport(config.key!, config.tariff!.model)
    : null;
  const controller = new AbortController();
  const metrics = {
    version: JEV_PROPOSAL_LANE_VERSION,
    configured: enabled,
    status: enabled ? "waiting" : "disabled",
    cycles: 0,
    failures: 0,
    last_generation: "not_started",
    last_succession: "not_started",
  };
  let task: Promise<void> | null = null;
  let lastStarted = -Infinity;
  async function run() {
    const owners = await pool.transaction(
      async (tx) =>
        (
          await tx.query<{ owner_id: string }>(
            "SELECT DISTINCT c.owner_id FROM jev_generator_controls c JOIN jev_latest_pairs p USING(owner_id) WHERE c.enabled ORDER BY c.owner_id LIMIT 3",
          )
        ).rows,
    );
    metrics.status = owners.length ? "running" : "not_admitted";
    for (const { owner_id } of owners) {
      if (controller.signal.aborted) return;
      await retireFailedJevPairs(pool, owner_id, {
        model: config.tariff!.model,
      });
      if (controller.signal.aborted) return;
      // Consume the operator's current first choice before generating an append.
      // Admission validates the prospective registry even after retirement has
      // invalidated the old registry's capacity proof.
      const succession = await admitJevSuccessor(
        pool,
        owner_id,
        config.tariff!.model,
      );
      metrics.last_succession = succession.status;
      if (controller.signal.aborted) return;
      const generation = await generateJevProposal(
        pool,
        owner_id,
        config.tariff!,
        transport!,
        {
          enabled: true,
          signal: controller.signal,
        },
      );
      metrics.last_generation = generation.status;
    }
    if (owners.length) metrics.status = "settled";
  }
  return {
    metrics,
    /** Launch without awaiting HTTP; repeated worker ticks never add work. */
    tick(now = Date.now()) {
      if (
        !enabled ||
        controller.signal.aborted ||
        task ||
        now - lastStarted < JEV_PROPOSAL_INTERVAL_MS
      )
        return;
      lastStarted = now;
      metrics.cycles++;
      metrics.status = "running";
      task = run()
        .catch(() => {
          metrics.status = "unavailable";
          metrics.failures++;
          onFailure();
        })
        .finally(() => {
          task = null;
        });
    },
    async stop() {
      controller.abort();
      await task;
      metrics.status = "stopped";
    },
  };
}
