import { createJevProposalLane } from "./storage/jev-proposal-lane.js";
import { createJevEngineMonitor } from "./storage/jev-readiness.js";
import { createJevFundingLane } from "./storage/jev-funding-store.js";
import { readFile, writeFile, rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  loadConfig,
  requireStatementBudgets,
  type ApiConfig,
} from "./config.js";
import { createDatabasePool, type DatabasePool } from "./database.js";
import {
  claimExecutionWorker,
  executionFencedPool,
  releaseExecutionWorker,
} from "./storage/execution-worker-lease.js";
import { startDeskConsumer } from "./storage/desk-consumer.js";
import { drainDeskCommands } from "./storage/desk-commandstore.js";
import { createJevWorkerStore } from "./storage/jev-worker-store.js";
import {
  createJevScheduler,
  JEV_SCHEDULER_VERSION,
  JEV_DISPATCH_LIMITS,
} from "./storage/jev-scheduler.js";
import { loadChallengerConfig } from "./models/jev-config.js";
import { loadJevDecisionBackend } from "./models/jev-decision-runtime.js";
import { JEV_EVALUATION_POLICY } from "./storage/jev-evaluation.js";
import { runJevContinuousEvaluation } from "./storage/jev-evaluationstore.js";
import { loadJevLiveRuntime } from "./jev-live-runtime.js";
import { createJevLiveLane } from "./jev-live-lane.js";
export const EXECUTION_HEALTH_PATH = "/tmp/ganso-execution-health.json";
export function inspectExecutionHealth(
  state: { service: string; pid: number; timestamp: string; ready: boolean },
  now = Date.now(),
) {
  const timestamp = Date.parse(state.timestamp);
  if (
    state.service !== "execution-worker" ||
    !state.ready ||
    !Number.isFinite(timestamp) ||
    now < timestamp ||
    now - timestamp > 5000 ||
    !Number.isSafeInteger(state.pid) ||
    state.pid <= 0
  )
    throw new Error("EXECUTION_WORKER_NOT_READY");
  process.kill(state.pid, 0);
}
async function publish(state: unknown) {
  await writeFile(`${EXECUTION_HEALTH_PATH}.tmp`, JSON.stringify(state), {
    mode: 0o600,
  });
  await rename(`${EXECUTION_HEALTH_PATH}.tmp`, EXECUTION_HEALTH_PATH);
}
const log = (reason_code: string) =>
  process.stderr.write(
    `${JSON.stringify({ service: "execution-worker", level: "warn", timestamp: new Date().toISOString(), reason_code })}\n`,
  );
export async function runExecutionWorker(
  options: {
    configuration?: ApiConfig;
    pool?: DatabasePool;
    sha?: string;
    backend?: Pick<
      Awaited<ReturnType<typeof loadJevDecisionBackend>>,
      "status" | "evaluate"
    >;
    signal?: AbortSignal;
    publish?: (state: unknown) => Promise<void>;
    live?: Pick<
      Parameters<typeof loadJevLiveRuntime>[0],
      "configuration" | "signer" | "wire"
    >;
  } = {},
) {
  const publishHealth = options.publish ?? publish;
  if (process.argv.includes("--health")) {
    inspectExecutionHealth(
      JSON.parse(await readFile(EXECUTION_HEALTH_PATH, "utf8")),
    );
    return;
  }
  const config = options.configuration ?? (await loadConfig());
  if (config.executionMode !== "paper")
    throw new Error("EXECUTION_WORKER_PAPER_REQUIRED");
  const sha =
    options.sha ??
    (
      await readFile(
        process.env.GANSO_RELEASE_SHA_FILE ?? "/etc/ganso/release-sha",
        "utf8",
      )
    ).trim();
  const pool =
    options.pool ??
    createDatabasePool(config, {
      max: 4,
      queryTimeoutMs: requireStatementBudgets(config).ceilingMs,
      applicationName: "ganso-execution-worker",
    });
  let stopDesk: (() => Promise<void>) | undefined,
    stopScheduler: (() => Promise<void>) | undefined,
    lease: Awaited<ReturnType<typeof claimExecutionWorker>> | undefined,
    haltLive: (() => void) | undefined,
    stopped = false;
  const halt = () => {
    stopped = true;
    haltLive?.();
  };
  options.signal?.addEventListener("abort", halt, { once: true });
  if (options.signal?.aborted) stopped = true;
  process.once("SIGTERM", halt);
  process.once("SIGINT", halt);
  try {
    lease = await claimExecutionWorker(pool, sha);
    const fenced = executionFencedPool(pool, lease);
    const live = await loadJevLiveRuntime({
      pool: fenced,
      lease,
      sha,
      ...options.live,
    });
    const liveLane = createJevLiveLane(live, fenced, lease, sha);
    haltLive = liveLane.halt;
    // Reversible rollout pause. Existing history/reservations/positions are kept;
    // old v1 ownership still requires its independent reconciliation generation.
    await fenced.transaction((tx) =>
      tx.query("UPDATE btc_desk_controls SET enabled=false WHERE enabled"),
    );
    const challengerConfig = await loadChallengerConfig();
    stopDesk = startDeskConsumer(fenced, log, {
      ...challengerConfig,
      enabled: false,
    });
    // Per-account authenticated admission stays separate from constructing a
    // configured provider. No rows or admission are created by boot.
    const backend =
      options.backend ??
      (await loadJevDecisionBackend(pool, {
        admitted: true,
        configuration: challengerConfig,
      }));
    const store = createJevWorkerStore(
      fenced,
      lease,
      backend.status.model,
      liveLane,
    );
    const scheduler = createJevScheduler({
      ...store,
      profile: (a) =>
        `${a.scope.owner_id}:${a.scope.profile_id}:${a.scope.profile_version}`,
      accountKey: (a) => a.scope.account_id,
      evaluate: (batch, signal) => backend.evaluate(batch, signal),
    });
    stopScheduler = scheduler.stop;
    const engineMonitor = createJevEngineMonitor(
      fenced,
      lease,
      sha,
      backend.status.model,
      backend.status.enabled,
    );
    const proposals = createJevProposalLane(fenced, challengerConfig, () =>
      log("JEV_PROPOSAL_LANE_UNAVAILABLE"),
    );
    const funding = createJevFundingLane(fenced, async () =>
      (await store.accounts()).filter((a) => a.scope.mode !== "live"),
    );
    let fundingTask: Promise<void> | null = null,
      lastFundingAt = -Infinity;
    const fundingController = new AbortController();
    let monitorTask: Promise<void> | null = null;
    let lastEvaluationMinute = -1;
    let evaluationTask: Promise<void> | null = null;
    let evaluationStatus = "not_started";
    const finishEvaluation = async () => {
      await evaluationTask;
    };
    const priorStop = stopScheduler;
    stopScheduler = async () => {
      const liveStopped = liveLane.stop();
      const proposalsStopped = proposals.stop();
      fundingController.abort();
      await priorStop?.();
      await proposalsStopped;
      await fundingTask;
      await finishEvaluation();
      await monitorTask;
      await liveStopped;
    };
    while (!stopped) {
      const began = Date.now();
      // Heartbeat fencing is independent of provider latency and API lifetime.
      await fenced.transaction((tx) => tx.query("SELECT 1"));
      liveLane.assertActive();
      liveLane.tick();
      await scheduler.tick();
      await drainDeskCommands(fenced);
      if (!monitorTask)
        monitorTask = engineMonitor
          .tick()
          .catch(() => {
            log("JEV_ENGINE_OBSERVATION_UNAVAILABLE");
          })
          .finally(() => {
            monitorTask = null;
          });
      if (!fundingTask && began - lastFundingAt >= 30000) {
        lastFundingAt = began;
        fundingTask = funding
          .tick(fundingController.signal)
          .catch(() => {
            log("JEV_FUNDING_UNAVAILABLE");
          })
          .finally(() => {
            fundingTask = null;
          });
      }
      const minute = Math.floor(
        (began - JEV_EVALUATION_POLICY.coverage_settlement_delay_ms) / 60000,
      );
      if (minute !== lastEvaluationMinute && !evaluationTask) {
        lastEvaluationMinute = minute;
        evaluationStatus = "running";
        evaluationTask = runJevContinuousEvaluation(fenced)
          .then((r) => {
            evaluationStatus = r.admitted_accounts
              ? "captured"
              : "not_admitted";
          })
          .catch(() => {
            evaluationStatus = "unavailable";
            log("JEV_EVALUATION_UNAVAILABLE");
          })
          .finally(() => {
            evaluationTask = null;
          });
      }
      proposals.tick(began);
      await liveLane.heartbeat();
      await publishHealth({
        service: "execution-worker",
        pid: process.pid,
        timestamp: new Date().toISOString(),
        ready: true,
        code_sha: sha,
        generation: lease.generation,
        version: JEV_SCHEDULER_VERSION,
        admission: "per_account_closed_by_default",
        backend: backend.status,
        metrics: scheduler.metrics,
        dispatch_limits: JEV_DISPATCH_LIMITS,
        fence: fenced.metrics,
        dispatch_admission: store.metrics,
        funding: { version: "jev.funding.v1", ...funding.metrics },
        evaluation: { version: "jev.evaluation.v1", status: evaluationStatus },
        proposals: proposals.metrics,
        live: { ...live.status, metrics: liveLane.metrics },
      });
      await delay(Math.max(0, 250 - (Date.now() - began)));
    }
  } finally {
    stopped = true;
    await publishHealth({
      service: "execution-worker",
      pid: process.pid,
      timestamp: new Date().toISOString(),
      ready: false,
    });
    try {
      await stopScheduler?.();
      await stopDesk?.();
      if (lease) await releaseExecutionWorker(pool, lease);
    } finally {
      await pool.end();
      process.off("SIGTERM", halt);
      process.off("SIGINT", halt);
      options.signal?.removeEventListener("abort", halt);
    }
  }
}
if (process.argv[1]?.endsWith("execution-worker.js"))
  void runExecutionWorker().catch((e) => {
    log(
      e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)
        ? e.message
        : "EXECUTION_WORKER_FAILED",
    );
    process.exitCode = 1;
  });
