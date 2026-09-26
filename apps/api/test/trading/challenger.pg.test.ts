import { readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import { acceptanceFixture } from "./acceptance-fixture.js";
import { fixture, tick, T, AT, px } from "./baseline-fixture.js";
import { type BaselineRegistration } from "../../src/storage/baseline-inputs.js";
import { activateBaseline } from "../../src/baseline-activate-cli.js";
import { consumeBaselineAccount } from "../../src/storage/baseline-runtime.js";
import {
  createChallengerConsumer,
  readChallengerReplay,
} from "../../src/storage/challenger-runtime.js";
import { fundDeskAccount } from "../../src/storage/desk-consumer.js";
import {
  storeRetentionObjectTx,
  withBtcRetentionTransaction,
} from "../../src/storage/btc-retention.js";
import { baselineEvidenceTx } from "../../src/storage/baseline-store.js";
import {
  readLedgerAccount,
  createLedgerAccount,
  appendLedgerBatch,
} from "../../src/storage/ledgerstore.js";
import type { LedgerIdentity } from "../../src/storage/ledger-contract.js";
import { command, usd } from "./ledger-fixture.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import { applyRisk } from "../../src/storage/riskstore.js";
import { withDeskWorker } from "../../src/storage/desk-worker.js";
import {
  JevWireResponse,
  jevHash,
  type JevTransport,
} from "../../src/models/jev-contract.js";
import { createJevAdapter } from "../../src/models/jev.js";
import { createJevStore } from "../../src/storage/jevstore.js";
import { mockTariff, mockResponse } from "./jev-fixture.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
const iso = (v: number) => new Date(v).toISOString();
const manifest = readFileSync(
  new URL("../../../../config/trading/baseline.json", import.meta.url),
  "utf8",
);
const contract = readFileSync(
  new URL(
    "../../../../docs/contracts/btc-baseline-manifest-v1.md",
    import.meta.url,
  ),
  "utf8",
);
let f: Awaited<ReturnType<typeof acceptanceFixture>>, now: number;
let pool: Pick<DatabasePool, "transaction" | "readOnly">,
  r: BaselineRegistration,
  cr: BaselineRegistration;
let input: ReturnType<typeof fixture>, tariff: ReturnType<typeof mockTariff>;
let consumers: ReturnType<typeof createChallengerConsumer>[];
const makeWorker = () => {
  const p = f.worker().pool;
  return Object.assign(p, {
    readOnly: <U>(_ms: number, run: (tx: SqlExecutor) => Promise<U>) =>
      p.transaction(async (tx) => {
        await tx.query("SET TRANSACTION READ ONLY");
        return run(tx);
      }),
  });
};
const orders = async (account = "challenger") =>
  (
    await f.pool.query(
      "SELECT reservation FROM btc_desk_orders WHERE account_id=$1 ORDER BY order_id",
      [account],
    )
  ).rows.map((x) => x.reservation);
const decisions = async (account = "challenger") =>
  (
    await f.pool.query(
      "SELECT decision FROM btc_baseline_decisions WHERE account_id=$1 ORDER BY bar_end_at",
      [account],
    )
  ).rows.map((x) => x.decision);
const jobs = async () =>
  (await f.pool.query("SELECT * FROM btc_jev_challenger_requests")).rows;
const budget = async () =>
  (await f.pool.query("SELECT * FROM btc_jev_budgets WHERE origin='mock'"))
    .rows[0];
function consumer(
  evaluate: JevTransport["evaluate"] = vi
    .fn()
    .mockResolvedValue(mockResponse()),
  enabled = true,
  db = pool,
) {
  const errors: string[] = [];
  const c = createChallengerConsumer(db, {
    account: "challenger",
    sourceAccount: "baseline",
    enabled,
    adapter: createJevAdapter({
      store: createJevStore(db),
      transport: { origin: "mock", model: tariff.model, evaluate },
      tariff,
      enabled: true,
    }),
    onError: (reason) => errors.push(reason),
  });
  consumers.push(c);
  return {
    c,
    evaluate,
    errors,
    async run() {
      await c.tick();
      await c.drain();
      expect(errors).toEqual([]);
    },
  };
}
async function fund(account: string) {
  await fundDeskAccount(pool, account, async (hour) => ({
    source: "hyperliquid:mainnet:fundingHistory",
    received_at: iso(now),
    rows: [
      {
        coin: "BTC",
        time: Date.parse(hour),
        fundingRate: "0.0001",
        premium: "0",
      },
    ],
  }));
}
async function market(
  depth = "10000000",
  bid?: number,
  kinds = ["book", "context", "capture"],
) {
  tick(input, now);
  const book = input.market.book!.payload.payload;
  if (book.kind !== "book") throw new Error("fixture");
  for (const l of [...book.bids, ...book.asks])
    Object.assign(l.quantity, { raw: depth });
  if (bid !== undefined) {
    Object.assign(book.bids[0]!.price, { raw: px(bid) });
    Object.assign(book.asks[0]!.price, { raw: px(bid + 20) });
  }
  await withBtcRetentionTransaction(pool, async (tx) => {
    for (const [kind, row] of Object.entries(input.market)) {
      if (!row || !kinds.includes(kind)) continue;
      const id = `test:${kind}:${now}`;
      await storeRetentionObjectTx(tx, {
        id,
        class: "raw",
        identity: r.scope,
        recordedAt: new Date(now),
        payload: row.payload,
        dependencies: [],
      });
      await tx.query(
        "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,$2,$3,$4)",
        [id, kind, kind === "context" ? null : iso(now), iso(now)],
      );
    }
  });
}
async function seedBars(
  direction: "long" | "short" | "neutral" = "long",
  gap = false,
) {
  const data = fixture(direction);
  await withBtcRetentionTransaction(pool, async (tx) => {
    for (const set of [data.hours, data.quarters])
      for (const row of set.records) {
        if (gap && row === data.hours.records[0])
          row.payload.quality = {
            state: "incomplete",
            reasons: ["capture_gap"],
            continuity: "unproven",
          };
        for (const id of row.payload.input_ids)
          await storeRetentionObjectTx(tx, {
            id,
            class: "raw",
            identity: r.scope,
            recordedAt: new Date(row.recorded_at),
            payload: { synthetic_test_only: true },
            dependencies: [],
          });
        await storeRetentionObjectTx(tx, {
          id: row.object_id,
          class: "bar",
          identity: r.scope,
          recordedAt: new Date(row.recorded_at),
          payload: row.payload,
          dependencies: row.payload.input_ids,
        });
        await tx.query(
          "INSERT INTO btc_market_bars(interval_ms,start_at,end_at,object_id) VALUES($1,$2,$3,$4)",
          [
            row.payload.interval_ms,
            row.payload.start_at,
            row.payload.end_at,
            row.object_id,
          ],
        );
      }
  });
}
describe.skipIf(!url)(
  "Jev challenger on PostgreSQL: MOCK responses, real adapter/budget/broker",
  () => {
    beforeEach(async () => {
      consumers = [];
      now = T - 1000;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      f = await acceptanceFixture(url, () => now, true);
      pool = makeWorker();
      input = fixture();
      await f.pool.query(
        "INSERT INTO auth_accounts(username,password_hash) VALUES('baseline-owner','fixture-only')",
      );
      await withBtcRetentionTransaction(pool, async (tx) => {
        const m = input.metadata!;
        await storeRetentionObjectTx(tx, {
          id: m.object_id,
          class: "raw",
          identity: input.registration.scope,
          recordedAt: new Date(m.recorded_at),
          payload: m.payload,
          dependencies: [],
        });
        await tx.query(
          "INSERT INTO btc_market_records(object_id,kind,received_at) VALUES($1,'metadata',$2)",
          [m.object_id, m.recorded_at],
        );
      });
      r = (
        await activateBaseline(
          pool,
          "baseline-owner",
          "b".repeat(40),
          manifest,
          contract,
        )
      ).registration;
      // Explicitly synthetic prospective challenger registration in disposable PG.
      // There is no activation CLI or production seed in this slice.
      const id: LedgerIdentity = structuredClone(
        (
          await f.pool.query(
            "SELECT identity FROM btc_ledger_accounts WHERE account_id='baseline'",
          )
        ).rows[0].identity,
      );
      Object.assign(id.account, {
        account_id: "challenger",
        purpose: "challenger",
        experiment_id: "mock:challenger",
      });
      Object.assign(id.experiment, { experiment_id: "mock:challenger" });
      cr = { ...r, scope: ledgerScope(id) };
      await withBtcRetentionTransaction(pool, async (tx) => {
        await tx.query(
          "INSERT INTO btc_ledger_accounts(account_id,experiment_id,instrument_id,instrument_version,identity) VALUES('challenger',$1,$2,$3,$4::jsonb)",
          [
            cr.scope.experiment_id,
            cr.scope.instrument_id,
            cr.scope.instrument_version,
            JSON.stringify(id),
          ],
        );
        await tx.query(
          "INSERT INTO btc_desk_controls(account_id,owner_account_id,enabled,broker,latency_ms,signing_key) SELECT 'challenger',owner_account_id,true,'ioc',1000,signing_key FROM btc_desk_controls WHERE account_id='baseline'",
        );
        const evidence_id = "mock:challenger-registration";
        await baselineEvidenceTx(
          tx,
          { registration: cr, evidence_id, enabled: true },
          evidence_id,
          { registration: cr, metadata_id: input.metadata!.object_id },
          iso(now),
          [input.metadata!.object_id],
        );
        await tx.query(
          "INSERT INTO btc_baseline_registrations(account_id,registration,evidence_id) VALUES('challenger',$1::jsonb,$2)",
          [JSON.stringify(cr), evidence_id],
        );
      });
      now = T;
      vi.setSystemTime(now);
      await createLedgerAccount(pool, id);
      await consumeBaselineAccount(pool, "baseline");
      now = AT;
      vi.setSystemTime(now);
      await market();
      await fund("baseline");
      await fund("challenger");
      await seedBars();
      tariff = mockTariff();
      await pool.transaction((tx) =>
        tx.query(
          "INSERT INTO btc_jev_budgets(origin,month,enabled,provision_reference,tariff_hash,limit_usd6) VALUES('mock',$1,true,'explicit MOCK test only',$2,5000000)",
          [iso(now).slice(0, 7), jevHash(tariff)],
        ),
      );
      await consumeBaselineAccount(pool, "baseline");
    });
    afterEach(async () => {
      for (const c of consumers) await c.stop();
      vi.useRealTimers();
      await f?.dispose();
    });
    it.each(["allow", "veto", "abstain"] as const)(
      "%s shares the exact exogenous candidate, fixes proposal before Jev and replays original without another call",
      async (decision) => {
        const response = mockResponse(decision);
        if (decision === "allow")
          Object.assign(response.answers.filter, {
            confidence: 0.7,
            probabilities: { allow: 0.7, veto: 0.2, abstain: 0.1 },
          });
        const original = `\n ${JSON.stringify(response, null, 2)} \n`;
        const a = consumer(
          vi.fn().mockResolvedValue(new JevWireResponse(original)),
        );
        await a.run();
        const source = (await decisions("baseline"))[0],
          challenger = (await decisions())[0];
        expect(challenger.signal).toEqual(source.signal);
        expect(challenger.source_decision_id).toBe(source.decision_id);
        expect(challenger.command.order.quantity_btc_raw).toBe(
          source.command.order.quantity_btc_raw,
        );
        expect(challenger.command.order.risk_plan).toEqual(
          source.command.order.risk_plan,
        );
        expect(await orders()).toHaveLength(decision === "allow" ? 1 : 0);
        expect(await orders("baseline")).toHaveLength(1);
        const first = (await jobs())[0];
        expect(first.outcome.result).toMatchObject({
          decision,
          origin: "mock",
          original_response: original,
          response_hash: jevHash(original),
          cost_usd6: "42",
          input: first.request.input,
        });
        expect((await budget()).committed_usd6).toBe("42");
        const replay = await readChallengerReplay(pool, "challenger", iso(T));
        expect(replay!.adapter_receipt.original_response).toBe(original);
        expect(replay!.source_decision.signal).toEqual(replay!.decision.signal);
        await Promise.all([a.run(), consumer(a.evaluate).run()]);
        expect(await jobs()).toEqual([first]);
        expect(a.evaluate).toHaveBeenCalledTimes(1);
        expect(
          (await readLedgerAccount(pool, cr.scope)).projection.cash_usd_raw,
        ).toBe("1000000000");
        expect(
          (await readLedgerAccount(pool, r.scope)).projection.cash_usd_raw,
        ).toBe("1000000000");
        await expect(
          f.pool.query(
            "UPDATE btc_jev_challenger_requests SET state='prepared'",
          ),
        ).rejects.toThrow("JEV_CHALLENGER_IMMUTABLE");
      },
    );
    it("once per candidate under concurrent consumers; no SQL/account/collector lock spans the model wait", async () => {
      let resolve!: (x: unknown) => void;
      const network = vi.fn<JevTransport["evaluate"]>(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      const a = consumer(network),
        b = consumer(network);
      await Promise.all([a.c.tick(), b.c.tick()]);
      await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
      await withBtcRetentionTransaction(pool, (tx) =>
        tx.query("SELECT raw_bytes FROM btc_retention_policy"),
      );
      await consumeBaselineAccount(pool, "baseline");
      expect(await orders("baseline")).toHaveLength(1);
      expect(await orders()).toHaveLength(0);
      await a.c.tick();
      await b.c.tick();
      resolve(mockResponse());
      await a.c.drain();
      await b.c.drain();
      expect(a.errors).toEqual([]);
      expect(b.errors).toEqual([]);
      expect(await orders()).toHaveLength(1);
      expect(network).toHaveBeenCalledTimes(1);
    });
    it.each(["malformed", "cost_unknown", "error", "limit"])(
      "%s only abstains challenger entry with real cost accounting",
      async (kind) => {
        if (kind === "limit")
          await f.pool.query("UPDATE btc_jev_budgets SET limit_usd6=1");
        const network = vi.fn<JevTransport["evaluate"]>(async () => {
          if (kind === "error") throw new Error("explicit MOCK provider error");
          return kind === "malformed"
            ? { ...mockResponse(), answers: {} }
            : kind === "cost_unknown"
              ? { ...mockResponse(), usage: {} }
              : mockResponse();
        });
        const a = consumer(network);
        await a.run();
        expect(await orders()).toHaveLength(0);
        expect(await orders("baseline")).toHaveLength(1);
        expect((await jobs())[0].outcome.reasons).toContain(
          `jev_${kind === "error" ? "provider_error" : kind === "malformed" ? "malformed_response" : kind === "limit" ? "budget_exhausted" : "cost_unknown"}`,
        );
        expect((await budget()).committed_usd6).toBe(
          kind === "limit" ? "0" : kind === "malformed" ? "42" : "2753",
        );
        if (kind === "cost_unknown")
          expect((await budget()).circuit_open).toBe(true);
        await consumer(network).run();
        expect(network).toHaveBeenCalledTimes(kind === "limit" ? 0 : 1);
      },
    );
    it.each(["price", "risk", "expiry", "fence", "funds", "accounting"])(
      "%s changing during HTTP vetoes admission and never replaces or resizes the proposal",
      async (kind) => {
        let resolve!: (x: unknown) => void;
        const a = consumer(
          vi.fn(
            () =>
              new Promise((r) => {
                resolve = r;
              }),
          ),
        );
        await a.c.tick();
        await vi.waitFor(() => expect(a.evaluate).toHaveBeenCalledOnce());
        const original = (await decisions())[0];
        if (kind === "expiry") now += 5001;
        else now += 100;
        vi.setSystemTime(now);
        if (kind === "price") await market("10000000", 100200);
        else await market();
        if (kind === "risk")
          await withDeskWorker(pool, "challenger", (w) =>
            applyRisk(w, cr.scope, {
              action: "reduce_only",
              operation_id: "mock:pause",
              reason: "mock test pause",
            }),
          );
        if (kind === "fence") {
          await f.pool.query(
            "UPDATE btc_recovery_heads SET lease_until=$1 WHERE account_id='challenger'",
            [iso(now - 1)],
          );
          const replacement = consumer(
            vi.fn().mockResolvedValue(mockResponse()),
            true,
            makeWorker(),
          );
          await replacement.c.tick();
          await replacement.c.drain();
        }
        if (kind === "funds") {
          await withDeskWorker(pool, "challenger", (w) =>
            appendLedgerBatch(w, cr.scope, {
              transaction_id: "mock:withdraw-all",
              events: [
                command(
                  "mock:withdraw-all",
                  {
                    event_type: "cash",
                    reason: "transfer",
                    delta: usd("-999999999"),
                  },
                  cr.scope,
                  now,
                ),
              ],
            }),
          );
        }
        if (kind === "accounting") {
          // Corrupting the projection cannot fabricate funds: recovery/accounting
          // guards must refuse the speculative admission, with no ledger mutation.
          await f.pool.query(
            "UPDATE btc_ledger_projections SET projection=jsonb_set(projection,'{cash_usd_raw}','\"0\"') WHERE account_id='challenger'",
          );
        }
        resolve(mockResponse());
        await a.c.drain();
        expect(await orders()).toHaveLength(0);
        expect(await decisions()).toEqual([original]);
        expect(await orders("baseline")).toHaveLength(1);
        if (kind !== "fence" && kind !== "accounting")
          expect(a.errors).toEqual([]);
      },
    );
    it("default-off skips Jev; an expired original cannot be refreshed by a late first consumer", async () => {
      now += 5001;
      vi.setSystemTime(now);
      await market();
      const a = consumer();
      await a.run();
      expect((await decisions())[0].state).toBe("missed_decision_window");
      expect(await jobs()).toHaveLength(0);
      expect(await orders()).toHaveLength(0);
      expect(a.evaluate).not.toHaveBeenCalled();
    });
    it("disabled composition consumes no budget or network", async () => {
      const a = consumer(undefined, false);
      await a.run();
      expect((await decisions())[0].state).toBe("disabled");
      expect(await jobs()).toHaveLength(0);
      expect(a.evaluate).not.toHaveBeenCalled();
    });
    it("timeout ignores a late allow; stop and risk management continue without awaiting Jev", async () => {
      let resolve!: (x: unknown) => void;
      const a = consumer(
        vi.fn(
          () =>
            new Promise((r) => {
              resolve = r;
            }),
        ),
      );
      await a.c.tick();
      await vi.waitFor(() => expect(a.evaluate).toHaveBeenCalledOnce());
      now += 5001;
      vi.setSystemTime(now);
      await market();
      await a.c.tick();
      await consumeBaselineAccount(pool, "baseline");
      await a.c.stop();
      resolve(mockResponse());
      await Promise.resolve();
      expect(await orders()).toHaveLength(0);
      expect((await budget()).committed_usd6).toBe("2753");
      expect((await jobs())[0].outcome.result.decision).toBe("abstain");
    });
    it("a restart never resends an uncertain committed dispatch claim", async () => {
      // Lose only the acknowledgement after the request claim commits. The real
      // adapter is never entered; the conservative claim is still consumed.
      await f.pool.query(
        "UPDATE btc_recovery_heads SET lease_until=$1 WHERE account_id='challenger'",
        [iso(now - 1)],
      );
      let lost = false;
      const wrapped = {
        ...pool,
        transaction: async <U>(run: (tx: SqlExecutor) => Promise<U>) => {
          let claim = false;
          const value = await pool.transaction((tx) =>
            run({
              query: async (sql, params) => {
                if (sql.includes("SET state='dispatching'")) claim = true;
                return tx.query(sql, params);
              },
            }),
          );
          if (claim && !lost) {
            lost = true;
            throw new Error("mock lost COMMIT ack");
          }
          return value;
        },
      };
      const a = consumer(undefined, true, wrapped);
      await a.c.tick();
      await a.c.drain();
      expect(a.errors).toEqual(["BTC_CHALLENGER_UNAVAILABLE"]);
      expect((await jobs())[0].state).toBe("dispatching");
      expect(a.evaluate).not.toHaveBeenCalled();
      now += 5001;
      vi.setSystemTime(now);
      await market();
      const b = consumer(undefined, true, wrapped);
      await b.run();
      expect((await jobs())[0].outcome.reasons).toContain(
        "recovered_uncertain",
      );
      expect(b.evaluate).not.toHaveBeenCalled();
      expect(await orders()).toHaveLength(0);
    });
    it("an admitted position keeps baseline stop/6h exit rules, risk and funding independent of Jev", async () => {
      const a = consumer();
      await a.run();
      now += 1100;
      vi.setSystemTime(now);
      await market("100000");
      await a.run();
      expect(
        (await readLedgerAccount(pool, cr.scope)).projection.positions[0]!
          .quantity_btc_raw,
      ).toBe("100000");
      await withDeskWorker(pool, "challenger", (w) =>
        applyRisk(w, cr.scope, {
          action: "reduce_only",
          operation_id: "mock:exit",
          reason: "mock exit while Jev unavailable",
        }),
      );
      now += 1100;
      vi.setSystemTime(now);
      await market("100000");
      await a.run();
      now += 1100;
      vi.setSystemTime(now);
      await market("100000");
      await a.run();
      expect(
        (await readLedgerAccount(pool, cr.scope)).projection.positions[0]!
          .quantity_btc_raw,
      ).toBe("0");
      expect(a.evaluate).toHaveBeenCalledTimes(1);
      expect(
        (await orders()).filter((x) => x.order.intent === "open"),
      ).toHaveLength(1);
      expect(
        (await orders()).filter((x) => x.order.intent === "reduce"),
      ).toHaveLength(1);
      await fund("challenger");
    });
    it.each(["reservation", "receipt", "admission"])(
      "lost %s COMMIT acknowledgement is never retried or reapplied",
      async (stage) => {
        await f.pool.query(
          "UPDATE btc_recovery_heads SET lease_until=$1 WHERE account_id='challenger'",
          [iso(now - 1)],
        );
        let lost = false;
        const wrapped = {
          ...pool,
          transaction: async <U>(run: (tx: SqlExecutor) => Promise<U>) => {
            let lose = false;
            const value = await pool.transaction((tx) =>
              run({
                query: async (sql, params) => {
                  if (
                    !lost &&
                    (stage === "reservation"
                      ? sql.includes("INSERT INTO btc_jev_calls")
                      : stage === "receipt"
                        ? sql.includes("UPDATE btc_jev_calls SET result=$4")
                        : sql.includes("SET state='final'"))
                  )
                    lose = true;
                  return tx.query(sql, params);
                },
              }),
            );
            if (lose) {
              lost = true;
              throw new Error("mock lost COMMIT acknowledgement");
            }
            return value;
          },
        };
        const a = consumer(undefined, true, wrapped);
        await a.c.tick();
        await a.c.drain();
        expect(lost).toBe(true);
        expect(await orders()).toHaveLength(stage === "admission" ? 1 : 0);
        const snapshot = await readChallengerReplay(pool, "challenger", iso(T));
        expect(snapshot!.state).toBe("final");
        expect(a.evaluate).toHaveBeenCalledTimes(
          stage === "reservation" ? 0 : 1,
        );
        const b = consumer(a.evaluate, true, wrapped);
        await b.run();
        expect(await readChallengerReplay(pool, "challenger", iso(T))).toEqual(
          snapshot,
        );
        expect(await orders()).toHaveLength(stage === "admission" ? 1 : 0);
        expect(a.evaluate).toHaveBeenCalledTimes(
          stage === "reservation" ? 0 : 1,
        );
      },
    );
    it("own pause is recorded independently, without querying Jev or forcing the baseline pair", async () => {
      await withDeskWorker(pool, "challenger", (w) =>
        applyRisk(w, cr.scope, {
          action: "reduce_only",
          operation_id: "mock:independent-pause",
          reason: "mock own eligibility",
        }),
      );
      const a = consumer();
      await a.run();
      expect((await decisions())[0].signal).toEqual(
        (await decisions("baseline"))[0].signal,
      );
      expect((await decisions())[0].reasons).toContain("risk_pause");
      expect((await decisions())[0].command).toBe(null);
      expect(await orders("baseline")).toHaveLength(1);
      expect(await orders()).toHaveLength(0);
      expect(a.evaluate).not.toHaveBeenCalled();
    });
  },
);
