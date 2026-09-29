import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgFixture } from "../pg-fixture.js";
import { canonicalFingerprint } from "../../src/trading/replay.js";
import { fingerprintRecoveryTable } from "../../src/storage/recovery-fingerprint.js";

const url = process.env.GANSO_TEST_DATABASE_URL;
let f: Awaited<ReturnType<typeof createPgFixture>>;
describe.skipIf(!url)(
  "recovery serialization memoization with authoritative PG reads",
  () => {
    beforeEach(async () => {
      f = await createPgFixture(url);
      await f.pool.query(
        "CREATE TABLE btc_fingerprint_test(account_id text, sequence int, payload jsonb)",
      );
      await f.pool.query(`INSERT INTO btc_fingerprint_test VALUES
      ('a',2,'{"z":"😀", "a":[null,1.25,true,{"é":"texto"}]}'),
      ('a',1,'{"amount":"1000000000","nested":{"b":2,"a":1}}'),
      ('b',1,'{"amount":"other account"}')`);
    });
    afterEach(async () => {
      await f?.dispose();
    });
    async function compare(account = "a") {
      const client = await f.pool.connect();
      let fullRows = 0;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const original = await client.query(
          "SELECT to_jsonb(t) AS value FROM btc_fingerprint_test t WHERE account_id=$1 ORDER BY to_jsonb(t)::text",
          [account],
        );
        const expected = createHash("sha256")
          .update(canonicalFingerprint(["btc_fingerprint_test", original.rows]))
          .digest("hex");
        const hash = createHash("sha256");
        const count = await fingerprintRecoveryTable(
          {
            query: async (sql, params) => {
              const result = await client.query(sql, params ? [...params] : []);
              fullRows = result.rows.filter((row) => row.value !== null).length;
              return { rows: result.rows, rowCount: result.rowCount ?? 0 };
            },
          },
          "btc_fingerprint_test",
          account,
          hash,
        );
        const digest = hash.digest("hex");
        expect(digest).toBe(expected);
        expect(count).toBe(original.rowCount);
        await client.query("COMMIT");
        return { digest, count, fullRows };
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    it("preserves v1 bytes on cold/warm reads, ordering, unicode and account isolation", async () => {
      const cold = await compare();
      const warm = await compare();
      expect(warm.digest).toBe(cold.digest);
      expect(warm.fullRows).toBe(0);
      expect((await compare("b")).digest).not.toBe(cold.digest);
      expect((await compare("missing")).count).toBe(0);
    });
    it("detects historical mutation with unchanged row count, deletion and insertion after warmup", async () => {
      const before = await compare();
      await compare();
      await f.pool.query(
        `UPDATE btc_fingerprint_test SET payload='{"amount":"tampered"}' WHERE account_id='a' AND sequence=1`,
      );
      const changed = await compare();
      expect(changed.count).toBe(before.count);
      expect(changed.digest).not.toBe(before.digest);
      expect(changed.fullRows).toBe(1);
      await f.pool.query(
        "DELETE FROM btc_fingerprint_test WHERE account_id='a' AND sequence=2",
      );
      expect((await compare()).count).toBe(1);
      await f.pool.query(
        `INSERT INTO btc_fingerprint_test VALUES ('a',3,'{"new":true}')`,
      );
      expect((await compare()).count).toBe(2);
    });
    it("falls back to full rows after bounded cache eviction", async () => {
      const before = await compare();
      await f.pool.query(
        `INSERT INTO btc_fingerprint_test SELECT 'bulk', n, jsonb_build_object('number',n) FROM generate_series(1,2050) n`,
      );
      expect((await compare("bulk")).count).toBe(2050);
      const after = await compare();
      expect(after.digest).toBe(before.digest);
      expect(after.fullRows).toBe(2);
    });
  },
);
