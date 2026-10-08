import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlExecutor } from "../../src/database.js";
import { createPgFixture } from "../pg-fixture.js";
import { jevIdentity } from "./jev-v2-fixture.js";
import { jevScope } from "../../src/storage/jev-ledger.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { registerJevPair } from "../../src/storage/jev-store.js";
import {
  closeJevEvidence,
  makeJevEvidence,
  pinJevEvidence,
  readJevEvidence,
  retainJevEvidence,
  storeJevEvidence,
  type JevEvidenceKind,
} from "../../src/storage/jev-evidence.js";
import {
  retainBtcBatch,
  retentionCapacity,
  storeRetentionObject,
} from "../../src/storage/btc-retention.js";
import { BTC_RETENTION_POLICY } from "../../src/trading/retention.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let fixture: Awaited<ReturnType<typeof createPgFixture>>;
const pool = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
    const client = await fixture.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await run({
        async query(sql, params) {
          const r = await client.query(sql, params ? [...params] : []);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
      });
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  },
};
const day = 86400000;
let now: number;
let paper = jevIdentity();
const stamp = (ago: number) => new Date(now - ago * day).toISOString();
const scope = () => jevScope(paper.bindings[0]!.binding, paper.instrument);
function evidence(
  id: string,
  kind: JevEvidenceKind = "order",
  dependencies: string[] = [],
  sources: string[] = [],
  ago = 300,
) {
  return makeJevEvidence({
    object_id: id,
    kind,
    scope: scope(),
    recorded_at: stamp(ago),
    dependencies,
    sources,
    payload:
      kind === "response"
        ? {
            request_id: "req1",
            model: "jev-1.13.0",
            outcome: "received",
            original_body:
              '{ "decisions": ["hold"], "usage": {"input_tokens":123} }',
          }
        : {
            artifact_id: id,
            original: {
              observed: "complete-original",
              queue_ahead: "50000",
              remaining: "1200",
            },
          },
  });
}
const opts = { policy_version: "jev-evidence-v1", limit: 500, execute: true };
const ids = async () =>
  (
    await fixture.pool.query(
      "SELECT object_id FROM jev_evidence_objects ORDER BY object_id",
    )
  ).rows.map((r) => r.object_id);
describe.skipIf(!url)("JEV evidence retention on disposable PostgreSQL", () => {
  beforeEach(async () => {
    fixture = await createPgFixture(url);
    now = Date.now();
    paper = jevIdentity();
    const stress = jevIdentity("stress");
    const manifest = initialJevManifest(1);
    for (const i of [paper, stress]) {
      i.account.started_at = stamp(400);
      i.bindings[0]!.binding.started_at = stamp(400);
      i.bindings[0]!.profile.created_at = stamp(400);
      i.bindings[0]!.profile.manifest_hash = jevHash(manifest);
    }
    await registerJevPair(pool, 1, paper, stress, manifest);
  });
  afterEach(async () => {
    await fixture?.dispose();
  });
  it("retains holds and exact original response/inputs; pins protect transitive replay including required raw", async () => {
    const identity = {
      mode: "paper" as const,
      instrument_id: paper.instrument.instrument_id,
      instrument_version: paper.instrument.instrument_version,
    };
    for (const id of ["needed-raw", "irrelevant-raw"])
      await storeRetentionObject(pool, {
        id,
        class: "raw",
        identity,
        recordedAt: new Date(stamp(301)),
        payload: { trades: [1, 2, 3] },
        dependencies: [],
      });
    const inputs = makeJevEvidence({
      ...evidence("inputs"),
      kind: "inputs",
      sources: ["needed-raw"],
      payload: {
        records: [
          {
            object_id: "needed-raw",
            recorded_at: stamp(301),
            received_at: stamp(301),
            payload: { trades: [1, 2, 3] },
            payload_hash: jevHash({ trades: [1, 2, 3] }),
          },
        ],
      },
    });
    const context = makeJevEvidence({
      ...evidence("context"),
      kind: "context",
      dependencies: ["inputs"],
      payload: {
        input_bundle_id: "inputs",
        context: {
          schema_version: "btc.jev-context.v1",
          scope: scope(),
          cut_at: stamp(300),
          input_refs: inputs.payload.records,
        },
      },
    });
    const response = evidence("response", "response");
    const hold = makeJevEvidence({
      ...evidence("hold"),
      kind: "decision",
      dependencies: ["context", "response"],
      payload: {
        request_id: "req1",
        action: "hold",
        question: { choices: ["hold", "open", "close"] },
        original_decision: { choice: "hold" },
        context_id: "context",
        response_id: "response",
      },
    });
    await storeJevEvidence(pool, [inputs, context, response, hold]);
    await closeJevEvidence(
      pool,
      "operator",
      scope().experiment_id,
      stamp(181),
      "ended",
    );
    await pinJevEvidence(pool, "operator", "audit", "hold", "dependent audit");
    await fixture.pool.query("UPDATE btc_retention_policy SET hold=FALSE");
    expect((await retainJevEvidence(pool, opts)).objects).toEqual([]);
    await retainBtcBatch(pool, {
      datasetId: BTC_RETENTION_POLICY.datasetId,
      policyVersion: BTC_RETENTION_POLICY.version,
      limit: 500,
      execute: true,
    });
    expect(
      (await fixture.pool.query("SELECT object_id FROM btc_retention_objects"))
        .rows,
    ).toEqual([{ object_id: "needed-raw" }]);
    const replay = await readJevEvidence(pool, "operator", "hold");
    expect(replay.objects.map((e) => e.object_id)).toEqual([
      "context",
      "hold",
      "inputs",
      "response",
    ]);
    expect(
      replay.objects.find((e) => e.kind === "response")!.payload.original_body,
    ).toBe(response.payload.original_body);
    await expect(
      readJevEvidence(pool, "another-owner", "hold"),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      fixture.pool.query("DELETE FROM btc_retention_objects"),
    ).rejects.toThrow("PROTECTED");
    await expect(
      fixture.pool.query("DELETE FROM jev_evidence_pins"),
    ).rejects.toThrow("APPEND_ONLY");
  });
  it("expires only disposable leaves after 180d; an active or longer dependent and permanent ledger/results/versions prevail", async () => {
    await storeJevEvidence(pool, [
      evidence("input"),
      evidence("fill", "fill", ["input"]),
      evidence("ledger", "ledger"),
      evidence("result", "result"),
      evidence("version", "version"),
    ]);
    await fixture.pool.query("UPDATE btc_retention_policy SET hold=FALSE");
    expect((await retainJevEvidence(pool, opts)).objects).toEqual([]);
    await closeJevEvidence(
      pool,
      "operator",
      scope().experiment_id,
      stamp(181),
      "ended",
    );
    const active = {
      ...evidence("long-dependent", "funding", ["fill"], [], 100),
      scope: {
        ...scope(),
        account_id: "stress:h1",
        mode: "stress" as const,
        experiment_id: "experiment:stress:h1",
      },
    };
    await storeJevEvidence(pool, [active]);
    expect((await retainJevEvidence(pool, opts)).objects).toEqual([]);
    await closeJevEvidence(
      pool,
      "operator",
      active.scope.experiment_id,
      stamp(99),
      "later-end",
    );
    expect((await retainJevEvidence(pool, opts)).objects).toEqual([]);
    await expect(
      fixture.pool.query("DELETE FROM jev_evidence_objects"),
    ).rejects.toThrow("PROTECTED");
  });
  it("honors HOLD, dry-run, expiry boundary, leaf batches and shared accounting", async () => {
    await storeJevEvidence(pool, [
      evidence("leaf"),
      evidence("root", "fill", ["leaf"]),
      evidence("permanent", "result"),
    ]);
    await closeJevEvidence(
      pool,
      "operator",
      scope().experiment_id,
      stamp(181),
      "ended",
    );
    expect((await retainJevEvidence(pool, opts)).objects).toEqual([]);
    await fixture.pool.query("UPDATE btc_retention_policy SET hold=FALSE");
    const before = (await retentionCapacity(pool)).total_bytes;
    const dry = await retainJevEvidence(pool, { ...opts, execute: false });
    expect(dry.objects.map((r) => r.object_id)).toEqual(["root"]);
    expect(await ids()).toEqual(["leaf", "permanent", "root"]);
    await retainJevEvidence(pool, opts);
    expect(await ids()).toEqual(["leaf", "permanent"]);
    await retainJevEvidence(pool, opts);
    expect(await ids()).toEqual(["permanent"]);
    expect(BigInt((await retentionCapacity(pool)).total_bytes)).toBeLessThan(
      BigInt(before),
    );
    await expect(
      fixture.pool.query("UPDATE jev_evidence_closures SET closed_at=now()"),
    ).rejects.toThrow("APPEND_ONLY");
    await expect(
      storeJevEvidence(pool, [evidence("post-end", "fill", [], [], 100)]),
    ).rejects.toThrow("INVALID_ENVELOPE");
  });
  it("does not expire at 179 days; rejects future/early closure and missing/cross-owner edges atomically", async () => {
    await storeJevEvidence(pool, [evidence("before")]);
    await expect(
      closeJevEvidence(
        pool,
        "operator",
        scope().experiment_id,
        stamp(301),
        "early",
      ),
    ).rejects.toThrow("INVALID_CLOSURE");
    await expect(
      closeJevEvidence(
        pool,
        "operator",
        scope().experiment_id,
        stamp(-1),
        "future",
      ),
    ).rejects.toThrow("INVALID_CLOSURE");
    await closeJevEvidence(
      pool,
      "operator",
      scope().experiment_id,
      stamp(179),
      "end",
    );
    await fixture.pool.query("UPDATE btc_retention_policy SET hold=FALSE");
    expect((await retainJevEvidence(pool, opts)).objects).toEqual([]);
    const before = await retentionCapacity(pool);
    await expect(
      storeJevEvidence(pool, [
        evidence("rollback-first"),
        evidence("missing", "fill", ["absent"]),
      ]),
    ).rejects.toThrow("MISSING_DEPENDENCY");
    expect(await ids()).toEqual(["before"]);
    expect((await retentionCapacity(pool)).total_bytes).toBe(
      before.total_bytes,
    );
    const foreign = evidence("foreign");
    foreign.scope.owner_id = "other";
    await expect(storeJevEvidence(pool, [foreign])).rejects.toThrow(
      "INVALID_ENVELOPE",
    );
  });
  it("serializes concurrent retries, rejects changed originals and leaves direct conflict accounting unchanged", async () => {
    const e = evidence("same");
    const before = BigInt((await retentionCapacity(pool)).total_bytes);
    const results = await Promise.all([
      storeJevEvidence(pool, [e]),
      storeJevEvidence(pool, [e]),
    ]);
    expect(
      results
        .flat()
        .map((r) => r.status)
        .sort(),
    ).toEqual(["duplicate", "stored"]);
    const after = BigInt((await retentionCapacity(pool)).total_bytes);
    expect(after - before).toBe(BigInt(results[0]![0]!.charged_bytes));
    await fixture.pool.query(
      "INSERT INTO jev_evidence_objects SELECT * FROM jev_evidence_objects ON CONFLICT DO NOTHING",
    );
    expect(BigInt((await retentionCapacity(pool)).total_bytes)).toBe(after);
    await expect(
      storeJevEvidence(pool, [
        makeJevEvidence({
          ...e,
          payload: { artifact_id: "same", original: { changed: true } },
        }),
      ]),
    ).rejects.toThrow("COLLISION");
    await expect(
      fixture.pool.query("UPDATE jev_evidence_objects SET envelope='{}'"),
    ).rejects.toThrow("APPEND_ONLY");
    await expect(
      fixture.pool.query("TRUNCATE jev_evidence_objects CASCADE"),
    ).rejects.toThrow("APPEND_ONLY");
  });
  it("refuses crossing collection stop, keeps essential closure headroom and rolls back at full budget", async () => {
    await fixture.pool.query(
      "UPDATE btc_retention_policy SET total_bytes=159999999900",
    );
    await expect(
      storeJevEvidence(pool, [evidence("over-stop")]),
    ).rejects.toThrow("CAPACITY_REFUSED");
    expect(await ids()).toEqual([]);
    await storeJevEvidence(pool, [evidence("essential", "result")]);
    await fixture.pool.query(
      "UPDATE btc_retention_policy SET total_bytes=199999999900",
    );
    await expect(
      closeJevEvidence(
        pool,
        "operator",
        scope().experiment_id,
        stamp(181),
        "end",
      ),
    ).rejects.toThrow("CAPACITY_REFUSED");
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int n FROM jev_evidence_closures",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(await ids()).toEqual(["essential"]);
  });
});
