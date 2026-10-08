import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import {
  appendJevLedgerBatch,
  jevHash,
  readJevAccount,
  registerJevLiveIdentity,
  registerJevPair,
} from "../../src/storage/jev-store.js";
import {
  createLedgerAccount,
  readLedgerAccount,
} from "../../src/storage/ledgerstore.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import { createPgFixture } from "../pg-fixture.js";
import { identity } from "./ledger-fixture.js";
import { jevIdentity, jevCommand, usd } from "./jev-v2-fixture.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let fixture: Awaited<ReturnType<typeof createPgFixture>>;
let fail = false;
const store: Pick<DatabasePool, "transaction"> = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
    const client = await fixture.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await run({
        async query<R extends Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[],
        ) {
          if (fail && sql.startsWith("INSERT INTO jev_pairs"))
            await client.query("SELECT 1/0");
          const r = await client.query<R>(
            sql,
            params ? [...params] : undefined,
          );
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
function pair(name = "h1") {
  const horizon = name === "h2" ? 3 : name === "h3" ? 5 : 1;
  const base = initialJevManifest(horizon);
  const manifest =
    name === "four"
      ? { ...base, context: { ...base.context, trade_window_seconds: 30 } }
      : base;
  const paper = jevIdentity("paper", name),
    stress = jevIdentity("stress", name);
  for (const i of [paper, stress]) {
    i.bindings[0]!.profile.manifest_hash = jevHash(manifest);
    i.bindings[0]!.profile.horizon_minutes = horizon;
  }
  return { manifest, paper, stress };
}
describe.skipIf(!url)("dormant JEV registry on disposable PostgreSQL", () => {
  beforeEach(async () => {
    fixture = await createPgFixture(url);
    fail = false;
  });
  afterEach(async () => {
    await fixture?.dispose();
  });
  it("seeds no account, executor or funds and leaves historical 1000 USD intact", async () => {
    expect(
      (await fixture.pool.query("SELECT count(*)::int n FROM jev_accounts"))
        .rows[0].n,
    ).toBe(0);
    await createLedgerAccount(store, identity());
    expect(
      (await readLedgerAccount(store, ledgerScope(identity()))).projection
        .cash_usd_raw,
    ).toBe("1000000000");
    const p = pair();
    await registerJevPair(store, 1, p.paper, p.stress, p.manifest);
    expect(
      (await readJevAccount(store, "operator", p.paper.account.account_id))
        .projection.cash_usd_raw,
    ).toBe("250000000");
    expect(
      (
        await fixture.pool.query(
          "SELECT DISTINCT executor_enabled FROM jev_accounts",
        )
      ).rows,
    ).toEqual([{ executor_enabled: false }]);
  });
  it("serializes duplicate concurrent creation and batches without duplicating capital or fees", async () => {
    const p = pair();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        registerJevPair(store, 1, p.paper, p.stress, p.manifest),
      ),
    );
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int n FROM jev_ledger_events",
        )
      ).rows[0].n,
    ).toBe(2);
    const batch = {
      transaction_id: "trade",
      events: [
        jevCommand(p.paper, "fill"),
        jevCommand(p.paper, "fee", {
          event_type: "fee" as const,
          execution_id: "exec:1",
          delta: usd("-123456"),
        }),
      ],
    };
    await Promise.all(
      Array.from({ length: 4 }, () =>
        appendJevLedgerBatch(
          store,
          "operator",
          p.paper.account.account_id,
          batch,
        ),
      ),
    );
    const read = await readJevAccount(
      store,
      "operator",
      p.paper.account.account_id,
    );
    expect(read.projection).toMatchObject({
      last_sequence: "3",
      cash_usd_raw: "249876544",
    });
    expect(
      (await readJevAccount(store, "operator", p.stress.account.account_id))
        .projection.cash_usd_raw,
    ).toBe("250000000");
    await expect(
      appendJevLedgerBatch(store, "operator", p.paper.account.account_id, {
        ...batch,
        events: [jevCommand(p.paper, "different")],
      }),
    ).rejects.toThrow(/COLLISION/);
  });
  it("rolls back profile/accounts/bindings/genesis together if pairing fails", async () => {
    const p = pair();
    fail = true;
    await expect(
      registerJevPair(store, 1, p.paper, p.stress, p.manifest),
    ).rejects.toThrow();
    for (const table of [
      "jev_profiles",
      "jev_accounts",
      "jev_bindings",
      "jev_ledger_transactions",
      "jev_ledger_events",
    ])
      expect(
        (await fixture.pool.query(`SELECT count(*)::int n FROM ${table}`))
          .rows[0].n,
      ).toBe(0);
  });
  it("allows exactly three slots and rejects incompatible pair/mode/owner or changed fingerprints", async () => {
    for (let slot = 1; slot <= 3; slot++) {
      const p = pair(`h${slot}`);
      await registerJevPair(store, slot, p.paper, p.stress, p.manifest);
    }
    const p = pair("four");
    await expect(
      registerJevPair(store, 4, p.paper, p.stress, p.manifest),
    ).rejects.toThrow(/PAIR/);
    await expect(
      registerJevPair(store, 1, p.paper, p.stress, p.manifest),
    ).rejects.toThrow(/COLLISION/);
    const alias = pair("alias");
    await expect(
      registerJevPair(store, 1, alias.paper, alias.stress, alias.manifest),
    ).rejects.toThrow(/FINGERPRINT_COLLISION/);
    const original = pair();
    await expect(
      registerJevPair(store, 1, original.paper, original.stress, {
        changed: true,
      }),
    ).rejects.toThrow();
    await expect(
      readJevAccount(store, "other", original.paper.account.account_id),
    ).rejects.toThrow(/NOT_FOUND/);
    const b = original.paper.bindings[0]!.binding;
    await expect(
      fixture.pool.query(
        "INSERT INTO jev_bindings(experiment_id,owner_id,account_id,mode,profile_id,profile_version,binding) VALUES('foreign','other',$1,'paper','h1','v1',$2::jsonb)",
        [
          b.account_id,
          JSON.stringify({ ...b, owner_id: "other", experiment_id: "foreign" }),
        ],
      ),
    ).rejects.toThrow();
  });
  it("enforces the live singleton under concurrency, reserves zero cash and preserves it on a new version", async () => {
    const live = jevIdentity("live"),
      manifest = initialJevManifest(1);
    live.bindings[0]!.profile.manifest_hash = jevHash(manifest);
    const other = structuredClone(live);
    other.account.account_id = "another-live";
    other.bindings[0]!.binding.account_id = "another-live";
    other.bindings[0]!.binding.experiment_id = "another-exp";
    const results = await Promise.allSettled([
      registerJevLiveIdentity(store, live, manifest),
      registerJevLiveIdentity(store, other, manifest),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const id = (
      await fixture.pool.query(
        "SELECT account_id FROM jev_accounts WHERE mode='live'",
      )
    ).rows[0].account_id as string;
    const winner = id === live.account.account_id ? live : other;
    const next = structuredClone(winner),
      nextManifest = {
        ...manifest,
        context: { ...manifest.context, trade_window_seconds: 30 },
      };
    next.bindings[0]!.profile.profile_version = "v2";
    next.bindings[0]!.profile.manifest_hash = jevHash(nextManifest);
    next.bindings[0]!.binding.profile_version = "v2";
    next.bindings[0]!.binding.experiment_id = "successor";
    await registerJevLiveIdentity(store, next, nextManifest);
    const read = await readJevAccount(store, "operator", id);
    expect(read.identity.bindings).toHaveLength(2);
    expect(read.projection).toMatchObject({
      cash_usd_raw: "0",
      last_sequence: "0",
    });
    expect(read.events).toEqual([]);
    expect(
      (
        await fixture.pool.query(
          "SELECT DISTINCT technical_state,financial_state FROM jev_profiles",
        )
      ).rows,
    ).toEqual([
      { technical_state: "registered", financial_state: "unqualified" },
    ]);
  });
  it("preserves append-only accounts, versions, pairings and financial events", async () => {
    const p = pair();
    await registerJevPair(store, 1, p.paper, p.stress, p.manifest);
    for (const table of [
      "jev_profiles",
      "jev_accounts",
      "jev_bindings",
      "jev_pairs",
      "jev_ledger_transactions",
      "jev_ledger_events",
    ]) {
      await expect(fixture.pool.query(`DELETE FROM ${table}`)).rejects.toThrow(
        /APPEND_ONLY/,
      );
      await expect(
        fixture.pool.query(`TRUNCATE ${table} CASCADE`),
      ).rejects.toThrow(/APPEND_ONLY/);
    }
    await expect(
      fixture.pool.query("UPDATE jev_accounts SET executor_enabled=true"),
    ).rejects.toThrow(/APPEND_ONLY/);
  });
});
