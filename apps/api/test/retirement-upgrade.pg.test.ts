import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import pg from "pg";

const url = process.env.GANSO_TEST_DATABASE_URL;
const migrations = new URL("../../../migrations/", import.meta.url);
function sql(name: string): string {
  return readFileSync(new URL(name, migrations), "utf8")
    .replaceAll(":'migration_version'", String(Number(name.slice(0, 4))))
    .replaceAll(":'migration_checksum'", "'" + "0".repeat(64) + "'");
}

describe.skipIf(!url)("retirement upgrade with existing data", () => {
  it("refuses outside dependencies atomically, then removes only legacy relations and keeps BTC/auth/HOLD", async () => {
    const client = new pg.Client({ connectionString: url });
    const schema = `retire_${randomUUID().replaceAll("-", "")}`;
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      for (const name of readdirSync(migrations)
        .filter((n) => /^00\d\d_/.test(n) && Number(n.slice(0, 4)) < 49)
        .sort()) {
        await client.query("BEGIN");
        await client.query(sql(name));
        await client.query("COMMIT");
      }
      await client.query(
        "INSERT INTO app_settings(setting_key,value_json,value_schema_version) VALUES ('retirement.sentinel','{\"preserved\":true}',1)",
      );
      // Seed a real historical table before applying the destructive migration.
      await client.query(
        "INSERT INTO fast_wallet_state(strategy_id,bankroll_usd) VALUES ('retirement-fixture','1000.000000')",
      );
      const btc = (
        await client.query(
          "SELECT row_to_json(p) AS row FROM btc_retention_policy p",
        )
      ).rows;
      const auth = (
        await client.query(
          "SELECT oid FROM pg_class WHERE oid='auth_accounts'::regclass",
        )
      ).rows;
      await client.query(
        "CREATE TABLE outside_dependency(id text REFERENCES fast_wallet_state(strategy_id))",
      );
      await client.query("BEGIN");
      await expect(
        client.query(sql("0049_retire_polymarket.sql")),
      ).rejects.toMatchObject({ code: "2BP01" });
      await client.query("ROLLBACK");
      expect(
        (await client.query("SELECT count(*)::int AS n FROM fast_wallet_state"))
          .rows[0].n,
      ).toBe(1);
      await client.query("DROP TABLE outside_dependency");
      await client.query("BEGIN");
      await client.query(sql("0049_retire_polymarket.sql"));
      await client.query("COMMIT");
      expect(
        (await client.query("SELECT to_regclass('fast_wallet_state') AS gone"))
          .rows[0].gone,
      ).toBeNull();
      expect(
        (
          await client.query(
            "SELECT row_to_json(p) AS row FROM btc_retention_policy p",
          )
        ).rows,
      ).toEqual(btc);
      expect(
        (
          await client.query(
            "SELECT oid FROM pg_class WHERE oid='auth_accounts'::regclass",
          )
        ).rows,
      ).toEqual(auth);
      expect(
        (
          await client.query(
            "SELECT value_json FROM app_settings WHERE setting_key='retirement.sentinel'",
          )
        ).rows[0].value_json,
      ).toEqual({ preserved: true });
      await expect(
        client.query("DELETE FROM app_settings"),
      ).rejects.toMatchObject({ code: "55000" });
      expect(
        (
          await client.query(
            "SELECT max(version)::int AS version FROM schema_versions",
          )
        ).rows[0].version,
      ).toBe(49);
    } finally {
      await client.query("ROLLBACK");
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
  }, 60_000);
});
