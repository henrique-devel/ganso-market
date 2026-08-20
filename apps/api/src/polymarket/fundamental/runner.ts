// RFC-010 supervised runner: the estimation cycle, the label backfill, the
// daily calibration report with its gate evaluation, and the mandatory
// re-validation sweep. Every job is wrapped so a failure is logged with a
// stable reason code and never propagates: this process must keep producing
// baseline estimates even when a model, a feed or a report is broken.
//
// This process creates estimates and reports only. It has no order path, no
// wallet, no signer and no trading credential of any kind.

import type { DatabasePool } from "../../database.js";
import { runCalibrationJob } from "./calibration.js";
import { CATEGORY_MODELS } from "./catalog.js";
import type { FundamentalConfig } from "./config.js";
import { createEstimator, type Estimator } from "./estimator.js";
import { syncLabels } from "./labels.js";
import type { QueryPool } from "./features.js";
import {
  demoteModel,
  enforceRevalidation,
  getModel,
  listModels,
  registerModel,
} from "./registry.js";
import { DEFAULT_CRYPTO_HYPERPARAMS } from "./models/crypto-updown.js";
import { DEFAULT_MACRO_HYPERPARAMS } from "./models/macro-scheduled.js";

const SERVICE = "polymarket-fundamental";

export interface RunnerIntervals {
  readonly estimateMs?: number;
  readonly labelsMs?: number;
  readonly calibrationMs?: number;
  readonly revalidationMs?: number;
}

export interface RunnerDeps {
  readonly pool: DatabasePool;
  readonly config: FundamentalConfig;
  readonly gitSha: string | null;
  readonly intervals?: RunnerIntervals;
  readonly clock?: () => Date;
}

export interface Runner {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Exposed for the smoke path and for tests. */
  readonly estimator: Estimator;
}

function logJson(
  level: "info" | "warn" | "error",
  reasonCode: string,
  extra: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: SERVICE,
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      ...extra,
    })}\n`,
  );
}

/** Wrap a periodic job so a failure is logged and never propagates. */
function safeJob(name: string, job: () => Promise<void>): () => void {
  let running = false;
  return () => {
    if (running) {
      // A slow cycle must not stack: skipping is safer than queueing writes.
      logJson("warn", "JOB_STILL_RUNNING", { job: name });
      return;
    }
    running = true;
    job()
      .catch((error: unknown) => {
        logJson("error", "JOB_FAILED", {
          job: name,
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      })
      .finally(() => {
        running = false;
      });
  };
}

/**
 * Register the catalog's model versions the first time they are seen. A model
 * is always born in `shadow`: it produces estimates that only the gate can see,
 * and only a PASS plus the operator's manual promotion can ever make it serve.
 *
 * The uncalibrated catalog version has no training window, so it does not touch
 * the regime boundary. A trained version is a NEW version with its own window,
 * registered by the calibration path — never an edit of this row.
 */
export async function ensureCatalogModels(
  pool: QueryPool,
  gitSha: string | null,
  at: Date,
): Promise<string[]> {
  if (gitSha === null) {
    // Without a revision there is no provenance, and a model without complete
    // provenance must not exist at all.
    return [];
  }
  const registered: string[] = [];
  for (const descriptor of CATEGORY_MODELS) {
    const modelId = `${descriptor.family}@${descriptor.version}`;
    if ((await getModel(pool, modelId)) !== null) {
      continue;
    }
    await registerModel(
      pool,
      {
        modelId,
        modelFamily: descriptor.family,
        category: descriptor.category,
        version: descriptor.version,
        gitSha,
        featureSetVersion: descriptor.featureSetVersion,
        hyperparams:
          descriptor.category === "crypto_updown"
            ? (DEFAULT_CRYPTO_HYPERPARAMS as unknown as Record<string, unknown>)
            : (DEFAULT_MACRO_HYPERPARAMS as unknown as Record<string, unknown>),
        seed: 0,
        trainWindowStart: null,
        trainWindowEnd: null,
        regimeMix: false,
      },
      at,
    );
    registered.push(modelId);
  }
  return registered;
}

/**
 * A code change is a regime change for the model that code implements: an
 * ACTIVE model whose recorded revision is not the running revision goes back to
 * shadow and must earn its promotion again. This is the same rule the RFC
 * demands for a venue, fee-schedule or rule change, applied to ourselves.
 */
export async function demoteOnRevisionChange(
  pool: QueryPool,
  gitSha: string | null,
  at: Date,
): Promise<string[]> {
  if (gitSha === null) {
    return [];
  }
  const demoted: string[] = [];
  for (const model of await listModels(pool, { status: "active" })) {
    if (model.gitSha === gitSha) {
      continue;
    }
    const outcome = await demoteModel(
      pool,
      model.modelId,
      at,
      "code_revision_changed",
    );
    if (outcome.ok) {
      demoted.push(model.modelId);
    }
  }
  return demoted;
}

export function createRunner(deps: RunnerDeps): Runner {
  const intervals = deps.intervals ?? {};
  const clock = deps.clock ?? ((): Date => new Date());
  const timers: ReturnType<typeof setInterval>[] = [];
  let stopped = false;

  const estimator = createEstimator({
    pool: deps.pool,
    config: deps.config,
    gitSha: deps.gitSha,
    clock,
  });

  const jobs = {
    async estimate(): Promise<void> {
      await estimator.runCycle();
    },
    async labels(): Promise<void> {
      const report = await syncLabels({ pool: deps.pool, clock });
      logJson("info", "LABELS_SYNCED", {
        inserted: report.inserted,
        updated: report.updated,
        skipped_not_final: report.skippedNotFinal,
        skipped_unparsable: report.skippedUnparsable,
      });
    },
    async calibration(): Promise<void> {
      await runCalibrationJob({
        pool: deps.pool,
        config: deps.config,
        gitSha: deps.gitSha,
        clock,
      });
    },
    async revalidation(): Promise<void> {
      const demoted = await enforceRevalidation(deps.pool, clock());
      if (demoted.length > 0) {
        logJson("warn", "REVALIDATION_REQUIRED", {
          models: demoted.map((entry) => entry.modelId),
          causes: demoted.map((entry) => entry.cause),
        });
      }
    },
  };

  return {
    estimator,
    async start(): Promise<void> {
      logJson("info", "ESTIMATOR_STARTING", {
        git_sha_known: deps.gitSha !== null,
      });
      if (deps.gitSha === null) {
        // Explicit and observable: without a revision no MODEL row may be
        // written, so the process serves the market baseline only.
        logJson("warn", "PROVENANCE_UNAVAILABLE", {
          effect: "models_cannot_serve_baseline_only",
        });
      }

      const schedule = (
        name: string,
        everyMs: number,
        job: () => Promise<void>,
      ): void => {
        const tick = safeJob(name, job);
        timers.push(setInterval(tick, everyMs));
      };

      // The re-validation sweep runs before the first estimation cycle so a
      // model invalidated by a venue/fee/rule change never serves once more.
      await jobs.revalidation().catch((error: unknown) => {
        logJson("error", "JOB_FAILED", {
          job: "revalidation_boot",
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      });
      await jobs.estimate().catch((error: unknown) => {
        logJson("error", "JOB_FAILED", {
          job: "estimate_boot",
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      });

      schedule(
        "estimate",
        intervals.estimateMs ?? deps.config.estimateIntervalMs,
        jobs.estimate,
      );
      schedule("labels", intervals.labelsMs ?? 3_600_000, jobs.labels);
      schedule(
        "calibration",
        intervals.calibrationMs ?? 86_400_000,
        jobs.calibration,
      );
      schedule(
        "revalidation",
        intervals.revalidationMs ?? 900_000,
        jobs.revalidation,
      );
      logJson("info", "ESTIMATOR_STARTED", {});
    },

    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      for (const timer of timers) {
        clearInterval(timer);
      }
      logJson("info", "ESTIMATOR_STOPPED", {});
      return Promise.resolve();
    },
  };
}
