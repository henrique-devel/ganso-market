import { readFile } from "node:fs/promises";

// This entry is a fail-closed deployment boundary, not a running business worker.
// G2-04.4 must replace it with the completed collector and its readiness contract.
export function inspectBtcWorkerConfig(value: unknown): void {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema_version" in value) ||
    value.schema_version !== 1 ||
    !("execution_mode" in value) ||
    value.execution_mode !== "paper" ||
    !("enabled" in value) ||
    value.enabled !== false
  ) {
    throw new Error("BTC_WORKER_NOT_IMPLEMENTED_OR_INVALID_CONFIG");
  }
}

if (process.argv[1]?.endsWith("/btc-worker.js")) {
  const file = process.env.GANSO_BTC_WORKER_CONFIG_FILE;
  if (!file) throw new Error("BTC_WORKER_CONFIG_REQUIRED");
  inspectBtcWorkerConfig(JSON.parse(await readFile(file, "utf8")));
  console.info(
    JSON.stringify({
      service: "btc-worker",
      status: "disabled",
      execution_mode: "paper",
    }),
  );
}
