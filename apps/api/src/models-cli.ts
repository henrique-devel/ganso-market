// RFC-018 item 4: the operational path that registers a model version.
//
// Until now the only way a row reached `fundamental_models` was the boot
// catalog (`ensureCatalogModels`), which registers the UNCALIBRATED versions
// the image ships with. Training a calibrated version had no path at all — the
// runbook recorded it as a blocker — and the alternative on offer was inserting
// into the table by hand, which would create the lineage every future estimate
// points at with none of the checks that make it trustworthy.
//
// Deliberately a CLI and not an endpoint, for the same reason as `gates-cli`:
// the RFC-010/RFC-013 perimeter publishes reads, and the things that change
// what the system is allowed to believe stay closed at the edge. Promotion is
// already an authenticated POST; REGISTRATION is what was missing, and it is
// the one that mints the identity.
//
// It reuses `registerModel` rather than writing its own INSERT, so every
// guarantee is the same one the estimator gets: identity immutable by content
// (a `model_id` that already exists is REFUSED, never updated), birth always in
// `shadow`, the regime boundary checked before the statement is sent, and the
// `registered` event appended to the audit trail.
//
// Run inside the API container:
//
//   docker compose exec -T api node apps/api/dist/models-cli.js list
//   docker compose exec -T api node apps/api/dist/models-cli.js show <model_id>
//   docker compose exec -T api node apps/api/dist/models-cli.js register \
//     --family crypto_updown_gbm --version 1.2.0 --category crypto_updown \
//     --feature-set-version 1.2.0 --seed 42 \
//     --train-window-start 2026-05-01T00:00:00Z \
//     --train-window-end 2026-08-01T00:00:00Z < hyperparams.json
//
// The path is `apps/api/dist/...` and not `dist/...`: the image's WORKDIR is
// /workspace, the repository root, not the api workspace.
//
// SIMULAÇÃO — SEM EXECUÇÃO REAL. Registering a version unlocks nothing: the
// model is born in `shadow`, it serves no estimate until a PASS gate report and
// an explicit promotion, and RFC-009 stays blocked regardless.

import { ConfigError, loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import {
  MODELS_CLI_USAGE,
  ModelRegisterArgsError,
  flagValue,
  parseRegisterArgs,
} from "./polymarket/fundamental/modelregister.js";
import { resolveGitSha } from "./polymarket/fundamental/provenance.js";
import {
  RegimeBoundaryError,
  getModel,
  listModelEvents,
  listModels,
  registerModel,
} from "./polymarket/fundamental/registry.js";
import type { ModelRecord } from "./polymarket/fundamental/types.js";

class CliError extends Error {
  public readonly reasonCode: string;

  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "CliError";
    this.reasonCode = reasonCode;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function describe(model: ModelRecord): Record<string, unknown> {
  return {
    model_id: model.modelId,
    model_family: model.modelFamily,
    category: model.category,
    version: model.version,
    status: model.status,
    git_sha: model.gitSha,
    feature_set_version: model.featureSetVersion,
    seed: model.seed,
    regime_mix: model.regimeMix,
    train_window_start: model.trainWindowStart?.toISOString() ?? null,
    train_window_end: model.trainWindowEnd?.toISOString() ?? null,
    last_gate_report_id: model.lastGateReportId,
    created_at: model.createdAt?.toISOString() ?? null,
    promoted_at: model.promotedAt?.toISOString() ?? null,
    demoted_at: model.demotedAt?.toISOString() ?? null,
    retired_at: model.retiredAt?.toISOString() ?? null,
  };
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command !== "list" && command !== "show" && command !== "register") {
    throw new CliError("USAGE", MODELS_CLI_USAGE);
  }

  // Read before the pool is opened, like `gates-cli`: a register invoked
  // without a redirect would otherwise hold a connection waiting on a terminal.
  const hyperparamsRaw = command === "register" ? await readStdin() : "";

  const config = await loadConfig();
  const pool = createDatabasePool(config);
  try {
    if (command === "list") {
      const categoryFilter = flagValue(argv, "--category");
      const statusFilter = flagValue(argv, "--status");
      const models = await listModels(pool, {
        ...(categoryFilter === null ? {} : { category: categoryFilter }),
        ...(statusFilter === null ? {} : { status: statusFilter }),
      });
      process.stdout.write(
        `${JSON.stringify({
          status: "ok",
          command,
          models: models.map(describe),
        })}\n`,
      );
      return;
    }

    if (command === "show") {
      const modelId = argv[1] ?? "";
      if (modelId === "" || modelId.startsWith("--")) {
        throw new CliError("MISSING_MODEL_ID", "show requires a model_id");
      }
      const model = await getModel(pool, modelId);
      if (model === null) {
        throw new CliError("MODEL_NOT_FOUND", `${modelId} is not registered`);
      }
      process.stdout.write(
        `${JSON.stringify({
          status: "ok",
          command,
          model: describe(model),
          events: (await listModelEvents(pool, modelId)).map((event) => ({
            event_type: event.eventType,
            gate_report_id: event.gateReportId,
            at: event.at?.toISOString() ?? null,
          })),
        })}\n`,
      );
      return;
    }

    // Provenance is not optional, and the refusal comes from the same place
    // every other argument refusal does.
    const gitSha = await resolveGitSha();
    const input = parseRegisterArgs({ argv, stdin: hyperparamsRaw, gitSha });

    const model = await registerModel(pool, input, new Date());
    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        command,
        model: describe(model),
        // Said out loud so nobody reads a successful registration as an
        // activation: shadow serves nothing.
        note:
          "registered in shadow; it serves no estimate until a PASS gate " +
          "report and an explicit promotion",
      })}\n`,
    );
  } finally {
    await pool.end();
  }
}

void run().catch((error: unknown) => {
  const reasonCode =
    error instanceof CliError ||
    error instanceof ModelRegisterArgsError ||
    error instanceof ConfigError ||
    error instanceof RegimeBoundaryError
      ? error.reasonCode
      : "MODELS_CLI_FAILED";
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      service: "models-cli",
      reason_code: reasonCode,
      error_name: error instanceof Error ? error.name : "UnknownError",
      // Every refusal says WHAT it refused. A bare reason code would send the
      // operator back into the schema to find out why.
      detail: error instanceof Error ? error.message : undefined,
      message: "models_cli_failed",
    })}\n`,
  );
  process.exitCode = 1;
});
