import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import pg from "pg";

const url = process.env.GANSO_TEST_DATABASE_URL;
const migrations = new URL("../../../migrations/", import.meta.url);
function sql(name: string) {
  return readFileSync(new URL(name, migrations), "utf8")
    .replaceAll(":'migration_version'", String(Number(name.slice(0, 4))))
    .replaceAll(":'migration_checksum'", "'" + "0".repeat(64) + "'");
}
describe.skipIf(!url)("storage budget upgrade", () => {
  it("updates an existing corpus without changing evidence, counters, HOLD or auth relations", async () => {
    const client = new pg.Client({ connectionString: url });
    const schema = `budget_${randomUUID().replaceAll("-", "")}`;
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      for (const name of readdirSync(migrations)
        .filter((n) => /^00\d\d_/.test(n) && Number(n.slice(0, 4)) < 50)
        .sort()) {
        await client.query("BEGIN");
        await client.query(sql(name));
        await client.query("COMMIT");
      }
      await client.query(`INSERT INTO btc_retention_objects
        (object_id,dataset_id,policy_version,class,identity,recorded_at,payload,charged_bytes)
        VALUES ('budget:evidence','btc-paper-v1','btc-retention-v1','raw',
          '{"mode":"paper","instrument_id":"hyperliquid:BTC","instrument_version":"v1"}',clock_timestamp(),'{"preserved":true}',1)`);
      await client.query(
        "INSERT INTO btc_retention_pins(pin_id,object_id,reason) VALUES ('budget:pin','budget:evidence','preserve')",
      );
      const snapshot = async () => ({
        objects: (await client.query("SELECT * FROM btc_retention_objects"))
          .rows,
        pins: (await client.query("SELECT * FROM btc_retention_pins")).rows,
        policy: (
          await client.query(
            "SELECT policy_version,hold,raw_bytes,total_bytes FROM btc_retention_policy",
          )
        ).rows,
        auth: (
          await client.query(
            "SELECT oid FROM pg_class WHERE oid='auth_accounts'::regclass",
          )
        ).rows,
      });
      const before = await snapshot();
      await client.query("BEGIN");
      await client.query(sql("0050_btc_storage_budget.sql"));
      await client.query("COMMIT");
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await client.query(
            "SELECT raw_quota_bytes::text,total_quota_bytes::text,storage_limit_bytes::text,storage_stop_bytes::text FROM btc_retention_policy",
          )
        ).rows[0],
      ).toEqual({
        raw_quota_bytes: "200000000000",
        total_quota_bytes: "200000000000",
        storage_limit_bytes: "200000000000",
        storage_stop_bytes: "160000000000",
      });
      await expect(
        client.query(
          "UPDATE btc_retention_policy SET storage_stop_bytes=200000000000",
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        client.query(
          "UPDATE btc_retention_policy SET total_quota_bytes=200000000001",
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
  }, 60_000);
});
