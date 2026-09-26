import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgFixture } from "../pg-fixture.js";
import { createDatabasePool, type DatabasePool } from "../../src/database.js";
import { SecretValue, type ApiConfig } from "../../src/config.js";
import { createJevStore } from "../../src/storage/jevstore.js";
import { createJevAdapter } from "../../src/models/jev.js";
import {
  jevHash,
  type JevTransport,
  type JevResult,
} from "../../src/models/jev-contract.js";
import { mockRequest, mockResponse, mockTariff } from "./jev-fixture.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let f: Awaited<ReturnType<typeof createPgFixture>>, db: DatabasePool;
const tariff = mockTariff();
const store = () => createJevStore(db);
async function provision(limit = "5506") {
  // Explicit MOCK budget on a disposable database. Never provision production.
  await db.query(
    `INSERT INTO btc_jev_budgets(origin,month,enabled,provision_reference,tariff_hash,limit_usd6)
    VALUES('mock',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM'),true,'mock-only test fixture',$1,$2)`,
    [jevHash(tariff), limit],
  );
}
function adapter(
  evaluate = vi
    .fn<JevTransport["evaluate"]>()
    .mockResolvedValue(mockResponse()),
) {
  const transport: JevTransport = {
    origin: "mock",
    model: "jev-1.13.0",
    evaluate,
  };
  return {
    evaluate,
    run: createJevAdapter({ store: store(), transport, tariff, enabled: true }),
  };
}
const budget = async () =>
  (await db.query("SELECT * FROM btc_jev_budgets WHERE origin='mock'"))
    .rows[0]!;
const calls = async () =>
  (
    await db.query<{
      result: JevResult;
      token: string;
      fingerprint: string;
      finished_at: Date | null;
    }>(
      "SELECT result,token,fingerprint,finished_at FROM btc_jev_calls ORDER BY request_id",
    )
  ).rows;
describe.skipIf(!url)(
  "Jev cost reservation on PostgreSQL; all provider answers MOCK",
  () => {
    beforeEach(async () => {
      f = await createPgFixture(url);
      const params = await f.pool.query("SELECT current_database() AS name");
      const u = new URL(url!);
      db = createDatabasePool(
        {
          database: {
            host: u.hostname,
            port: Number(u.port || 5432),
            user: decodeURIComponent(u.username),
            password: new SecretValue(decodeURIComponent(u.password)),
            name: params.rows[0].name,
            ssl: false,
            connectTimeoutMs: 3000,
          },
        } as ApiConfig,
        { queryTimeoutMs: 3000, applicationName: "jev-mock-pg-test", max: 4 },
      );
    });
    afterEach(async () => {
      await db?.end();
      await f?.dispose();
    });
    it("migration provisions nothing and missing budgets never dispatch", async () => {
      expect((await db.query("SELECT * FROM btc_jev_budgets")).rowCount).toBe(
        0,
      );
      const a = adapter();
      expect((await a.run.evaluate(mockRequest())).reason).toBe(
        "budget_unavailable",
      );
      expect(a.evaluate).not.toHaveBeenCalled();
    });
    it("serializes independent adapter instances at the exact ceiling without holding SQL during network", async () => {
      await provision();
      const resolvers: ((v: unknown) => void)[] = [];
      let entered!: () => void;
      const two = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const network = vi.fn<JevTransport["evaluate"]>(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
            if (resolvers.length === 2) entered();
          }),
      );
      let allDenied!: () => void;
      const denied = new Promise<void>((resolve) => {
        allDenied = resolve;
      });
      let refused = 0;
      const attempts = Array.from({ length: 12 }, (_, i) =>
        adapter(network)
          .run.evaluate(mockRequest(`mock:parallel:${i}`))
          .then((result) => {
            if (result.reason === "budget_exhausted" && ++refused === 10)
              allDenied();
            return result;
          }),
      );
      await two;
      await denied;
      // This takes the same row lock while both network promises remain pending.
      await db.transaction(async (tx) => {
        await tx.query("SET LOCAL lock_timeout='250ms'");
        const b = (
          await tx.query(
            "SELECT committed_usd6 FROM btc_jev_budgets FOR UPDATE",
          )
        ).rows[0]!;
        expect(b.committed_usd6).toBe("5506");
      });
      for (const resolve of resolvers) resolve(mockResponse());
      const result = await Promise.all(attempts);
      expect(result.filter((r) => r.reason === "ok")).toHaveLength(2);
      expect(
        result.filter((r) => r.reason === "budget_exhausted"),
      ).toHaveLength(10);
      expect(network).toHaveBeenCalledTimes(2);
      expect((await budget()).committed_usd6).toBe("84");
    });
    it("idempotency survives a new adapter; changed input conflicts and does not resend", async () => {
      await provision();
      const req = mockRequest();
      expect((await adapter().run.evaluate(req)).reason).toBe("ok");
      const next = adapter();
      expect((await next.run.evaluate(req)).reason).toBe("duplicate");
      expect(
        (
          await next.run.evaluate({
            ...req,
            input: { ...req.input, direction: "short" },
          })
        ).reason,
      ).toBe("idempotency_conflict");
      expect(next.evaluate).not.toHaveBeenCalled();
      expect((await calls()).length).toBe(1);
    });
    it("unknown usage retains maximum cost and persistently opens circuit", async () => {
      await provision("5000000");
      const a = adapter(
        vi.fn().mockResolvedValue({ ...mockResponse(), usage: {} }),
      );
      expect((await a.run.evaluate(mockRequest())).reason).toBe("cost_unknown");
      expect(await budget()).toMatchObject({
        committed_usd6: "2753",
        circuit_open: true,
      });
      const restarted = adapter();
      expect(
        (await restarted.run.evaluate(mockRequest("mock:blocked"))).reason,
      ).toBe("circuit_open");
      expect(restarted.evaluate).not.toHaveBeenCalled();
    });
    it("errors consume the reservation, trips after three failures and never retries", async () => {
      await provision("5000000");
      const a = adapter(vi.fn().mockRejectedValue(new Error("mock error")));
      for (let i = 0; i < 3; i++)
        expect(
          (await a.run.evaluate(mockRequest(`mock:error:${i}`))).reason,
        ).toBe("provider_error");
      expect(await budget()).toMatchObject({
        committed_usd6: "8259",
        circuit_open: true,
        failures: 3,
      });
      expect(
        (await adapter().run.evaluate(mockRequest("mock:fourth"))).reason,
      ).toBe("circuit_open");
      expect(a.evaluate).toHaveBeenCalledTimes(3);
    });
    it("ignores late response, preserves uncertain cost, and immutable receipt", async () => {
      await provision();
      let resolve!: (v: unknown) => void;
      const a = adapter(
        vi.fn(
          () =>
            new Promise((r) => {
              resolve = r;
            }),
        ),
      );
      expect(
        await a.run.evaluate(mockRequest("mock:timeout", 250)),
      ).toMatchObject({
        reason: "timeout",
        decision: "abstain",
        cost_usd6: null,
      });
      const receipt = await calls();
      resolve(mockResponse());
      await new Promise((r) => setTimeout(r, 20));
      expect(await calls()).toEqual(receipt);
      expect((await budget()).committed_usd6).toBe("2753");
      await expect(
        db.query("UPDATE btc_jev_calls SET result='{}'"),
      ).rejects.toThrow("JEV_CALL_IMMUTABLE");
      await expect(db.query("DELETE FROM btc_jev_calls")).rejects.toThrow(
        "JEV_CALL_IMMUTABLE",
      );
    });
    it("recovers a crashed pending attempt without freeing cost or permitting retransmission", async () => {
      await provision();
      let observed!: () => void;
      const entered = new Promise<void>((r) => {
        observed = r;
      });
      const a = adapter(
        vi.fn(() => {
          observed();
          return new Promise(() => {});
        }),
      );
      const running = a.run.evaluate(mockRequest("mock:crash", 300));
      await entered;
      // Simulate lost process finalization: fence still exists but finish fails.
      // A new store will recover the already durable reservation after deadline.
      const pending = (await calls())[0]!;
      await db.query("UPDATE btc_jev_budgets SET enabled=false");
      await expect(
        db.query("UPDATE btc_jev_budgets SET month='2099-01'"),
      ).rejects.toThrow("JEV_PENDING_BILLING_MONTH");
      // Finish the original first; seed a second durable pending receipt through
      // reserve and intentionally never call finish (process crash boundary).
      await running;
      await db.query("UPDATE btc_jev_budgets SET enabled=true");
      const draft = {
        ...pending.result,
        request_id: "mock:orphan",
        deadline_at: new Date(Date.now() + 100).toISOString(),
      };
      const orphan = await store().reserve(
        draft,
        "mock-orphan-fingerprint",
        jevHash(tariff),
      );
      expect(typeof orphan).toBe("object");
      await new Promise((r) => setTimeout(r, 150));
      const resumed = adapter();
      expect(
        (await resumed.run.evaluate(mockRequest("mock:after-crash"))).reason,
      ).toBe("circuit_open");
      expect(resumed.evaluate).not.toHaveBeenCalled();
      expect(await budget()).toMatchObject({
        committed_usd6: "5506",
        circuit_open: true,
      });
      expect(
        (await calls()).find((c) => c.result.request_id === "mock:orphan")!
          .result.reason,
      ).toBe("recovered_uncertain");
      if (typeof orphan !== "string") {
        const late = await store().finish(
          orphan,
          { ...orphan.result, decision: "allow", reason: "ok", cost_usd6: "0" },
          false,
        );
        expect(late).toMatchObject({
          decision: "abstain",
          reason: "recovered_uncertain",
          cost_usd6: null,
        });
      }
    });
    it("recovers abandoned charges even after the provisioned month expires", async () => {
      await provision();
      // Explicit crash fixture in a historical month, with the maximum still held.
      await db.query(
        "UPDATE btc_jev_budgets SET month='2020-01',committed_usd6=2753",
      );
      await db.query(`INSERT INTO btc_jev_calls(origin,request_id,fingerprint,token,month,started_at,deadline_at,reserved_usd6,result)
      VALUES('mock','mock:old-crash','mock-old-fingerprint','00000000-0000-0000-0000-000000000001','2020-01',
      '2020-01-31T23:59:00Z','2020-01-31T23:59:01Z',2753,
      '{"request_id":"mock:old-crash","decision":"abstain","reason":"recovered_uncertain","duration_ms":0,"cost_usd6":null}'::jsonb)`);
      const a = adapter();
      expect((await a.run.evaluate(mockRequest())).reason).toBe("circuit_open");
      expect(a.evaluate).not.toHaveBeenCalled();
      expect((await calls())[0]!.finished_at).not.toBeNull();
      expect(await budget()).toMatchObject({
        month: "2020-01",
        committed_usd6: "2753",
        circuit_open: true,
      });
    });
    it("mismatched tariff, old month and disabled budgets fail before network", async () => {
      await provision();
      const a = adapter();
      await db.query("UPDATE btc_jev_budgets SET tariff_hash=$1", [
        `sha256:${"b".repeat(64)}`,
      ]);
      expect((await a.run.evaluate(mockRequest())).reason).toBe("cost_unknown");
      await db.query("UPDATE btc_jev_budgets SET month='2020-01'");
      expect((await a.run.evaluate(mockRequest())).reason).toBe("timeout");
      await db.query("UPDATE btc_jev_budgets SET enabled=false");
      expect((await a.run.evaluate(mockRequest())).reason).toBe(
        "budget_unavailable",
      );
      expect(a.evaluate).not.toHaveBeenCalled();
    });
    it("rolls back reservation and money together on insertion failure", async () => {
      await provision();
      await db.query(
        "CREATE FUNCTION mock_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'mock_insert_failure'; END $$",
      );
      await db.query(
        "CREATE TRIGGER mock_fail BEFORE INSERT ON btc_jev_calls FOR EACH ROW EXECUTE FUNCTION mock_fail()",
      );
      const a = adapter();
      expect((await a.run.evaluate(mockRequest())).reason).toBe(
        "storage_error",
      );
      expect(a.evaluate).not.toHaveBeenCalled();
      expect((await budget()).committed_usd6).toBe("0");
      expect(await calls()).toHaveLength(0);
    });
  },
);
