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

async function main() {
  const action = process.argv[2];
  if (action === "version") {
    console.log(
      JSON.stringify({
        schema_version: METRICS_VERSION,
        mode: "read_only",
        source: "captured_event_replay",
        window: "inception_to_cut",
      }),
    );
    return;
  }
  if (action !== "report")
    throw new Error("usage: btc-metrics-cli version | report < request.json");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.from(chunk);
    bytes += b.length;
    if (bytes > 2 * REPLAY_LIMITS.bytes + 2097152)
      throw new Error("BTC_METRICS_BYTE_LIMIT");
    chunks.push(b);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    baseline: ReplayArtifact;
    challenger?: ReplayArtifact;
    allocation?: CostAllocation;
    comparison?: EconomicComparison;
    references?: ReferenceInput[];
  };
  if ((request.references?.length ?? 0) > 8)
    throw new Error("BTC_METRICS_REFERENCE_LIMIT");
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
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "BTC_METRICS_FAILED");
  process.exitCode = 1;
});
