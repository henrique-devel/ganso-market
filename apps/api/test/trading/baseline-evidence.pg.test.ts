import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFixture } from "../pg-fixture.js";
import type { SqlExecutor } from "../../src/database.js";
import { baselineBarsTx } from "../../src/storage/baseline-store.js";
import { baselineHash } from "../../src/storage/baseline-inputs.js";
import { storeRetentionObjectTx } from "../../src/storage/btc-retention.js";
import { fixture as baselineFixture, AT } from "./baseline-fixture.js";

const url = process.env.GANSO_TEST_DATABASE_URL;
describe.skipIf(!url)(
  "bounded baseline evidence on disposable PostgreSQL",
  () => {
    let f: Awaited<ReturnType<typeof createPgFixture>>;
    const data = baselineFixture("neutral");
    const bar = structuredClone(data.hours.records[0]!);
    const ids = Array.from({ length: 4096 }, (_, i) => `corpus:${i * 16}`);
    beforeAll(async () => {
      f = await createPgFixture(url);
    });
    // Keep all 65,536 observations and every physical-storage guard. Bound each
    // preparation phase to 16,384 rows: a shared CI runner can exceed one 60s
    // hook for the entire corpus. Reader/test/SQL deadlines remain unchanged.
    for (let chunk = 0; chunk < 65536; chunk += 16384) {
      beforeAll(async () => {
        for (let start = chunk; start < chunk + 16384; start += 1024) {
          await f.pool.query(
            `WITH inserted AS (
        INSERT INTO btc_retention_objects(object_id,dataset_id,policy_version,class,identity,recorded_at,payload,charged_bytes)
        SELECT 'corpus:'||i,'btc-paper-v1','btc-retention-v1','raw',$1::jsonb,$2::timestamptz,
          jsonb_build_object('synthetic',true,'sequence',i,'book',$3::jsonb),1
        FROM generate_series($4::int,$4::int+1023) i RETURNING object_id,recorded_at
      ) INSERT INTO btc_market_records(object_id,kind,received_at)
        SELECT object_id,'book',recorded_at FROM inserted`,
            [
              data.registration.scope,
              bar.recorded_at,
              data.market.book!.payload,
              start,
            ],
          );
        }
      }, 60000);
    }
    beforeAll(async () => {
      bar.payload.input_ids = ids;
      const c = await f.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(741044,4)");
        await storeRetentionObjectTx(c as unknown as SqlExecutor, {
          id: bar.object_id,
          class: "bar",
          identity: data.registration.scope,
          recordedAt: new Date(bar.recorded_at),
          payload: bar.payload,
          dependencies: ids,
        });
        await c.query(
          "INSERT INTO btc_market_bars(interval_ms,start_at,end_at,object_id) VALUES(3600000,$1,$2,$3)",
          [bar.payload.start_at, bar.payload.end_at, bar.object_id],
        );
        await c.query("COMMIT");
      } finally {
        c.release();
      }
      await f.pool.query("ANALYZE btc_retention_objects");
      await f.pool.query("ANALYZE btc_market_records");
      await f.pool.query("ANALYZE btc_market_bars");
    }, 60000);
    afterAll(async () => {
      await f?.dispose();
    });

    it("keeps exact evidence hashes while bounding decoded batches and unrelated-row scans", async () => {
      const c = await f.pool.connect();
      const legacy = `SELECT o.object_id,o.payload,o.recorded_at,r.received_at
      FROM btc_retention_objects o LEFT JOIN btc_market_records r USING(object_id)
      WHERE o.object_id=ANY($1::text[])`;
      try {
        await c.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
        await c.query("SET LOCAL statement_timeout='1500ms'");
        const started = performance.now();
        const oldRows = (await c.query(legacy, [ids])).rows;
        const expected = oldRows.map((x) => ({
          object_id: x.object_id,
          payload_hash: baselineHash(x.payload),
          recorded_at: x.recorded_at.toISOString(),
          received_at: x.received_at.toISOString(),
        }));
        const oldMs = performance.now() - started;
        const oldPlan = (
          await c.query(`EXPLAIN (ANALYZE,FORMAT JSON,TIMING OFF) ${legacy}`, [
            ids,
          ])
        ).rows[0]["QUERY PLAN"][0];
        let explainMs = 0;
        const batches: number[] = [];
        const scans: { relation: string; rows: number }[] = [];
        function inspect(plan: Record<string, any>) {
          if (plan["Node Type"] === "Seq Scan")
            scans.push({
              relation: plan["Relation Name"],
              rows: plan["Actual Rows"],
            });
          for (const child of plan.Plans ?? []) inspect(child);
        }
        const tx: SqlExecutor = {
          async query(sql, params) {
            const result = await c.query(sql, params ? [...params] : []);
            if (result.rows[0] && "received_at" in result.rows[0]) {
              batches.push(result.rows.length);
              const planStart = performance.now();
              inspect(
                (
                  await c.query(
                    `EXPLAIN (ANALYZE,FORMAT JSON,TIMING OFF) ${sql}`,
                    params ? [...params] : [],
                  )
                ).rows[0]["QUERY PLAN"][0].Plan,
              );
              explainMs += performance.now() - planStart;
            }
            return { rows: result.rows, rowCount: result.rowCount ?? 0 };
          },
        };
        const nextStarted = performance.now();
        const actual = await baselineBarsTx(
          tx,
          3600000,
          12,
          bar.payload.end_at,
          new Date(AT).toISOString(),
        );
        const newMs = performance.now() - nextStarted - explainMs;
        const sorted = (values: typeof expected) =>
          values.sort((a, b) => a.object_id.localeCompare(b.object_id));
        expect(sorted(actual.dependencies)).toEqual(sorted(expected));
        process.stdout.write(
          JSON.stringify({
            baselineEvidence: {
              corpus: 65536,
              inputs: ids.length,
              oldMs,
              newMs,
              legacyPlan: oldPlan.Plan["Node Type"],
              legacyExecutionMs: oldPlan["Execution Time"],
              batches: batches.length,
              largestBatch: Math.max(...batches),
              scans,
            },
          }) + "\n",
        );
        expect(Math.max(...batches)).toBeLessThanOrEqual(256);
        expect(scans.filter((x) => x.rows > ids.length)).toEqual([]);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    }, 30000);
  },
);
