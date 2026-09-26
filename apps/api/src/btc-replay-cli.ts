import { readFile, statfs } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import {
  captureReplayDataset,
  loadReplayDataset,
} from "./storage/replaystore.js";
import {
  REPLAY_CONTRACTS,
  REPLAY_LIMITS,
  REPLAY_VERSION,
  replayDataset,
  requireSameReplayDataset,
  type ReplayArtifact,
} from "./storage/replay-dataset.js";

async function input(): Promise<ReplayArtifact[]> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.from(chunk);
    bytes += b.length;
    if (bytes > 2 * REPLAY_LIMITS.bytes + 2097152)
      throw new Error("BTC_REPLAY_BYTE_LIMIT");
    chunks.push(b);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return (Array.isArray(parsed) ? parsed : [parsed]) as ReplayArtifact[];
}
async function main() {
  const [action, id] = process.argv.slice(2);
  if (action === "version") {
    console.log(
      JSON.stringify({
        schema_version: REPLAY_VERSION,
        contracts: REPLAY_CONTRACTS,
        limits: REPLAY_LIMITS,
      }),
    );
    return;
  }
  if (action === "replay" || action === "compare") {
    const artifacts = await input();
    if (artifacts.length !== (action === "compare" ? 2 : 1))
      throw new Error("BTC_REPLAY_INPUT_COUNT");
    if (action === "compare")
      requireSameReplayDataset(artifacts[0]!, artifacts[1]!);
    console.log(JSON.stringify(replayDataset(artifacts[0]!)));
    return;
  }
  if (!id || !["capture", "export"].includes(action ?? ""))
    throw new Error(
      "usage: btc-replay-cli version | capture ACCOUNT | export DATASET_ID | replay < artifact.json | compare < [artifact,artifact]",
    );
  const config = await loadConfig();
  const pool = createDatabasePool(config, {
    max: 1,
    queryTimeoutMs: 5000,
    applicationName: "btc-replay-on-demand",
  });
  try {
    if (action === "capture") {
      const fs = await statfs("/", { bigint: true });
      if (
        fs.bavail * fs.bsize - 2n * BigInt(REPLAY_LIMITS.bytes) <
        (fs.blocks * fs.bsize) / 4n + 1024n ** 3n
      )
        throw new Error("BTC_REPLAY_DISK_FLOOR");
    }
    const artifact =
      action === "capture"
        ? await captureReplayDataset(
            pool,
            id,
            (await readFile("/etc/ganso/release-sha", "utf8")).trim(),
          )
        : await loadReplayDataset(pool, id);
    console.log(JSON.stringify(artifact));
  } finally {
    await pool.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "BTC_REPLAY_FAILED");
    process.exitCode = 1;
  });
}
