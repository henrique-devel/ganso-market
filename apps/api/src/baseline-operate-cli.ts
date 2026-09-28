import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadConfig, requireStatementBudgets } from "./config.js";
import { createDatabasePool } from "./database.js";
import {
  operateBaseline,
  type BaselineOperation,
} from "./storage/baseline-periods.js";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const username = process.argv[2];
  if (!username)
    throw new Error("usage: baseline-operate-cli OWNER < operation.json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk);
    if (size > 4096) throw new Error("BTC_BASELINE_OPERATION_SIZE");
    chunks.push(Buffer.from(chunk));
  }
  const input = JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  ) as BaselineOperation;
  const sha = (await readFile("/etc/ganso/release-sha", "utf8")).trim();
  const config = await loadConfig();
  const pool = createDatabasePool(config, {
    max: 1,
    queryTimeoutMs: requireStatementBudgets(config).ceilingMs,
  });
  try {
    const result = await operateBaseline(pool, username, sha, input);
    // Financial checkpoints stay in the journal; no balances/anchors in stdout.
    console.log(
      JSON.stringify({
        action: result.action,
        operation_id: input.operation_id,
        status: "recorded",
      }),
    );
  } finally {
    await pool.end();
  }
}
