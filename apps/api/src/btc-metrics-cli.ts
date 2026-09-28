import {
  accountMetrics,
  compareMetrics,
  type EconomicComparison,
} from "./storage/metrics.js";
import {
  type ReplayArtifact,
  REPLAY_LIMITS,
} from "./storage/replay-dataset.js";
import {
  METRICS_VERSION,
  normalizedReference,
  type CostAllocation,
  type ReferenceInput,
} from "./trading/metrics.js";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PAGE_LIMITS,
  replayPages,
  type ReplayManifest,
  type ReplayPage,
} from "./storage/replay-pages.js";
import {
  evaluationContext,
  validateEvaluationInput,
} from "./storage/evaluation.js";
import { allocatedCosts } from "./trading/metrics.js";
import { replayHash } from "./storage/replay-dataset.js";
import {
  compareWindowArtifacts,
  type WindowComparison,
} from "./storage/window-metrics.js";

/** Offline only: complete pages must pass replay before any metric is emitted. */
export async function pagedEvaluation(directory: string, value?: unknown) {
  const input = validateEvaluationInput(value);
  async function read(name: string) {
    const file = await open(join(directory, name), "r");
    try {
      const bytes = Buffer.alloc(PAGE_LIMITS.bytes * 2 + 1);
      let n = 0;
      while (n < bytes.length) {
        const r = await file.read(bytes, n, bytes.length - n, null);
        if (!r.bytesRead) break;
        n += r.bytesRead;
      }
      if (n > PAGE_LIMITS.bytes * 2) throw new Error("BTC_METRICS_BYTE_LIMIT");
      return JSON.parse(bytes.subarray(0, n).toString("utf8"));
    } finally {
      await file.close();
    }
  }
  const manifest = (await read("manifest.json")) as ReplayManifest;
  async function* pages() {
    for (let i = 0; i < manifest.manifest.pages.length; i++)
      yield (await read(`${i}.json`)) as ReplayPage;
  }
  const replay = await replayPages(manifest, pages());
  const w = replay.window;
  const scope = {
    account_id: w.scope.account_id,
    window: { start: w.start_at, end: w.end_at },
  };
  const costs = allocatedCosts(
    input?.allocation,
    scope.account_id,
    scope.window.start,
    scope.window.end,
  );
  const capital = w.opening.equity_usd_raw;
  return {
    schema_version: "btc.paged-evaluation.v1",
    mode: "paper",
    dataset_id: manifest.dataset_id,
    scope,
    code_sha: manifest.manifest.header.code_sha,
    coverage: {
      pages_verified: manifest.manifest.pages.length,
      counts: manifest.manifest.counts,
      expected_windows: w.expected_fifteen_minute_windows,
      expected_equity_slots: w.expected_equity_slots,
      observed_equity_slots: w.observed_equity_slots,
      complete: w.complete,
    },
    trading: {
      capital_usd_raw: capital,
      equity_usd_raw: w.closing.equity_usd_raw,
      net_pnl_usd_raw: w.net_pnl_usd_raw,
      external_flows_usd_raw: w.external_flows_usd_raw,
      net_return_ppm: null,
    },
    drawdown: w.drawdown,
    equity_curve: {
      points: w.points,
      status: w.complete ? "complete_observed_slots" : "incomplete_slots",
      basis: "persisted_five_minute_observations",
    },
    operational_costs: {
      ...costs,
      allocation_hash: input?.allocation ? replayHash(input.allocation) : null,
    },
    after_operational_costs: {
      net_pnl_usd_raw:
        w.net_pnl_usd_raw !== null && costs.total_usd_raw !== null
          ? (BigInt(w.net_pnl_usd_raw) - BigInt(costs.total_usd_raw)).toString()
          : null,
    },
    evaluation: evaluationContext(input, scope, capital),
    limitations: [
      ...w.limitations,
      "offline_report_import_is_not_server_attestation",
      "no_causal_contribution_or_operational_admission",
    ],
  };
}

async function main() {
  const action = process.argv[2];
  if (action === "version") {
    console.log(
      JSON.stringify({
        schema_version: METRICS_VERSION,
        supported_versions: [METRICS_VERSION, "btc.metrics.v2"],
        mode: "read_only",
        source: "captured_event_replay",
        window: "inception_to_cut",
        offline_paged_report: "btc.paged-evaluation.v1",
      }),
    );
    return;
  }
  if (action !== "report" && action !== "report-window")
    throw new Error(
      "usage: btc-metrics-cli version | report < request.json | report-window DIRECTORY < evaluation-input.json",
    );
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.from(chunk);
    bytes += b.length;
    if (
      bytes >
      (action === "report-window" ? 32768 : 2 * REPLAY_LIMITS.bytes + 2097152)
    )
      throw new Error("BTC_METRICS_BYTE_LIMIT");
    chunks.push(b);
  }
  const value = Buffer.concat(chunks).toString("utf8");
  if (action === "report-window") {
    if (!process.argv[3]) throw new Error("BTC_METRICS_DIRECTORY_REQUIRED");
    console.log(
      JSON.stringify(
        await pagedEvaluation(
          process.argv[3],
          value.trim() ? JSON.parse(value) : undefined,
        ),
      ),
    );
    return;
  }
  const request = JSON.parse(value) as {
    baseline: ReplayArtifact;
    challenger?: ReplayArtifact;
    allocation?: CostAllocation;
    comparison?: EconomicComparison | WindowComparison;
    references?: ReferenceInput[];
  };
  if ((request.references?.length ?? 0) > 8)
    throw new Error("BTC_METRICS_REFERENCE_LIMIT");
  if (request.comparison?.schema_version === "btc.economic-comparison.v2") {
    if (!request.challenger) throw new Error("BTC_METRICS_COMPARISON_DATASETS");
    const result = compareWindowArtifacts(
      request.baseline,
      request.challenger,
      request.comparison,
      request.allocation,
    );
    console.log(
      JSON.stringify({
        ...result,
        references: (request.references ?? []).map((ref) => {
          if (
            ref.window.start !== result.baseline.scope.window.start ||
            ref.window.end !== result.baseline.scope.window.end ||
            ref.capital_usd_raw !== result.baseline.opening.equity_usd_raw
          )
            throw new Error("BTC_METRICS_REFERENCE_WINDOW_OR_CAPITAL");
          return normalizedReference(ref);
        }),
      }),
    );
    return;
  }
  const baseline = accountMetrics(request.baseline, request.allocation);
  const references = (request.references ?? []).map((ref) => {
    if (
      ref.window.start !== baseline.scope.window.start ||
      ref.window.end !== baseline.scope.window.end ||
      ref.capital_usd_raw !== baseline.capital_usd_raw
    )
      throw new Error("BTC_METRICS_REFERENCE_WINDOW_OR_CAPITAL");
    return normalizedReference(ref);
  });
  console.log(
    JSON.stringify({
      ...compareMetrics(
        baseline,
        request.challenger
          ? accountMetrics(request.challenger, request.allocation)
          : null,
        request.comparison,
      ),
      references,
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "BTC_METRICS_FAILED",
    );
    process.exitCode = 1;
  });
