import { join } from "node:path";
import {
  PAGE_LIMITS,
  replayPages,
  type ReplayManifest,
  type ReplayPage,
} from "./storage/replay-pages.js";
import { open, readFile, statfs } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import {
  loadReplayWindowEvidence,
  captureReplayWindow,
  loadReplayManifest,
  loadReplayPage,
  captureReplayDataset,
  loadReplayDataset,
  loadReplayEvidence,
} from "./storage/replaystore.js";
import {
  REPLAY_PAGED_VERSION,
  REPLAY_PAGED_LIMITS,
  REPLAY_EQUITY_CONTRACTS,
  REPLAY_EQUITY_VERSION,
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
  const [action, id, ...decisionIds] = process.argv.slice(2);
  if (action === "version") {
    console.log(
      JSON.stringify({
        schema_version: REPLAY_EQUITY_VERSION,
        supported_versions: [
          REPLAY_VERSION,
          REPLAY_EQUITY_VERSION,
          REPLAY_PAGED_VERSION,
        ],
        paged_limits: { ...REPLAY_PAGED_LIMITS, page: PAGE_LIMITS },
        contracts: REPLAY_EQUITY_CONTRACTS,
        limits: REPLAY_LIMITS,
      }),
    );
    return;
  }
  if (action === "replay-window") {
    if (!id) throw new Error("BTC_REPLAY_DIRECTORY_REQUIRED");
    const read = async (name: string) => {
      const file = await open(join(id, name), "r");
      try {
        const bytes = Buffer.alloc(PAGE_LIMITS.bytes * 2 + 1);
        let n = 0;
        while (n < bytes.length) {
          const r = await file.read(bytes, n, bytes.length - n, null);
          if (!r.bytesRead) break;
          n += r.bytesRead;
        }
        if (n > PAGE_LIMITS.bytes * 2) throw new Error("BTC_REPLAY_BYTE_LIMIT");
        return JSON.parse(bytes.subarray(0, n).toString("utf8"));
      } finally {
        await file.close();
      }
    };
    const manifest = (await read("manifest.json")) as ReplayManifest;
    async function* pages() {
      for (let i = 0; i < manifest.manifest.pages.length; i++)
        yield (await read(`${i}.json`)) as ReplayPage;
    }
    console.log(JSON.stringify(await replayPages(manifest, pages())));
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
  if (
    !id ||
    ![
      "window-evidence",
      "capture-window",
      "manifest",
      "page",
      "capture",
      "capture-references",
      "export",
      "evidence",
    ].includes(action ?? "")
  )
    throw new Error(
      "usage: btc-replay-cli window-evidence DATASET_ID PAGE_INDEX OBJECT_ID | capture-window ACCOUNT START END | manifest DATASET_ID | page DATASET_ID INDEX | replay-window DIRECTORY | version | capture ACCOUNT [DECISION_ID ...] | capture-references ACCOUNT [DECISION_ID ...] | evidence DATASET_ID OBJECT_ID | export DATASET_ID | replay < artifact.json | compare < [artifact,artifact]",
    );
  // Large capture shares no memory budget with the serving API. The operator
  // supplies an ephemeral Linux cgroup within existing host capacity, never a
  // new service. Refuse the API's 384 MiB container and unbounded hosts.
  if (action === "capture-window") {
    const maximum = (
      await readFile("/sys/fs/cgroup/memory.max", "utf8")
    ).trim();
    if (
      !/^[0-9]+$/.test(maximum) ||
      BigInt(maximum) < 768n * 1024n ** 2n ||
      BigInt(maximum) > 1024n ** 3n
    )
      throw new Error("BTC_REPLAY_ISOLATED_MEMORY_BUDGET_REQUIRED");
  }
  const config = await loadConfig();
  const pool = createDatabasePool(config, {
    max: 1,
    queryTimeoutMs: 5000,
    applicationName: "btc-replay-on-demand",
  });
  try {
    if (
      action === "capture-window" ||
      action === "capture" ||
      action === "capture-references"
    ) {
      const fs = await statfs("/", { bigint: true });
      if (
        fs.bavail * fs.bsize -
          2n *
            BigInt(
              action === "capture-window"
                ? REPLAY_PAGED_LIMITS.bytes
                : REPLAY_LIMITS.bytes,
            ) <
        (fs.blocks * fs.bsize) / 4n + 1024n ** 3n
      )
        throw new Error("BTC_REPLAY_DISK_FLOOR");
    }
    const artifact =
      action === "window-evidence"
        ? await loadReplayWindowEvidence(
            pool,
            id,
            Number(decisionIds[0]),
            decisionIds[1] ?? "",
          )
        : action === "capture-window"
          ? await captureReplayWindow(
              pool,
              id,
              (await readFile("/etc/ganso/release-sha", "utf8")).trim(),
              { start_at: decisionIds[0] ?? "", end_at: decisionIds[1] ?? "" },
            )
          : action === "manifest"
            ? await loadReplayManifest(pool, id)
            : action === "page"
              ? await loadReplayPage(pool, id, Number(decisionIds[0]))
              : action === "capture" || action === "capture-references"
                ? await captureReplayDataset(
                    pool,
                    id,
                    (await readFile("/etc/ganso/release-sha", "utf8")).trim(),
                    decisionIds.length ? decisionIds : undefined,
                    action === "capture-references" ? "references" : "embedded",
                  )
                : action === "evidence"
                  ? await loadReplayEvidence(pool, id, decisionIds[0] ?? "")
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
