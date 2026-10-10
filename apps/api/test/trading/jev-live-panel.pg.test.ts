import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { riskFixture } from "./risk-fixture.js";
import { jevIdentity } from "./jev-v2-fixture.js";
import { registerJevLiveIdentity } from "../../src/storage/jev-store.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { commandJevPilot } from "../../src/storage/jev-pilotstore.js";
import { PgLiveStore } from "../../src/storage/jev-live-store.js";
import { readJevLiveMetricsTx } from "../../src/storage/jev-live-metrics.js";
import {
  readJevLiveAccountTx,
  parseLiveHistoryCursor,
} from "../../src/storage/jev-live-panel.js";
import { readJevPanel } from "../../src/storage/jev-panel.js";
import { registerJevPanelRoutes } from "../../src/jev-panel-api.js";
import Fastify from "fastify";
import type { DatabasePool } from "../../src/database.js";
import {
  liveSnapshot,
  liveIdentity,
  venueFill,
  venueFunding,
} from "../venues/live-fixture.js";
import {
  parseLiveFill,
  parseLiveFunding,
} from "../../src/venues/hyperliquid/live-reconcile.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let f: Awaited<ReturnType<typeof riskFixture>>,
  store: PgLiveStore,
  opening: number;
describe.skipIf(!url)(
  "JE17 live financial sources on disposable PostgreSQL",
  () => {
    beforeEach(async () => {
      f = await riskFixture(url);
      const i = jevIdentity("live"),
        m = initialJevManifest(1);
      i.bindings[0]!.profile.manifest_hash = jevHash(m);
      await registerJevLiveIdentity(f.poolAdapter, i, m);
      store = new PgLiveStore(f.poolAdapter, liveIdentity);
      await store.register();
      opening = Date.now() - 30;
      const s = liveSnapshot(opening, {
        flat: true,
        position_raw: "0",
        open_pnl_raw: "0",
        trading_balance_raw: "250000000",
        equity_raw: "250000000",
        orders: [],
        fills: [],
        funding: [],
      });
      await commandJevPilot(f.poolAdapter, "operator", "live:h1", {
        operation_id: "opening",
        expected_sequence: "0",
        action: "observe",
        observation: {
          version: "btc.jev-pilot-reconciliation.v1",
          source: "hyperliquid:mainnet:reconciliation",
          evidence_id: s.snapshot_id,
          observed_at: new Date(opening).toISOString(),
          received_at: new Date(opening).toISOString(),
          funded_capital_usd_raw: "250000000",
          trading_balance_usd_raw: "250000000",
          open_pnl_usd_raw: "0",
          flat: true,
          reconciled: true,
          original: s,
          utc_anchor: null,
        },
      });
      await store.save(s);
    });
    afterEach(async () => {
      await f?.dispose();
    });
    async function metrics(owner = "operator") {
      return f.poolAdapter.transaction(async (tx) => {
        await tx.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        return readJevLiveMetricsTx(
          tx,
          owner,
          "live:h1",
          new Date().toISOString(),
        );
      });
    }
    const readPool: Pick<DatabasePool, "readOnly"> = {
      readOnly: (_ms, run) =>
        f.poolAdapter.transaction(async (tx) => {
          await tx.query("SET TRANSACTION READ ONLY");
          return run(tx);
        }),
    };
    it("returns sanitized live sources instead of paper receipts and preserves owner isolation/no-store", async () => {
      const v = await readJevPanel(readPool, "operator"),
        a = v.accounts[0]!;
      expect(a.metrics?.source).toBe("hyperliquid_live_reconciled");
      expect(a.execution).toBeNull();
      expect(a.live_state).toMatchObject({
        position_btc_raw: "0",
        orders: [],
        receipts: [],
        protection: { state: "flat" },
      });
      expect(a.risk?.high_water_usd_raw).toBe("250000000");
      expect(JSON.stringify(v)).not.toContain(liveIdentity.signer_address);
      expect(JSON.stringify(v)).not.toContain("reservation");
      expect((await readJevPanel(readPool, "foreign")).accounts).toEqual([]);
      const app = Fastify();
      registerJevPanelRoutes(app, {
        pool: { ...readPool, transaction: f.poolAdapter.transaction },
        authService: {
          session: async (token) =>
            token === "owner"
              ? {
                  status: "ok",
                  username: "operator",
                  expiresAt: new Date(Date.now() + 60000),
                }
              : { status: "unauthenticated" },
        },
      });
      expect((await app.inject({ url: "/trading/jev/panel" })).statusCode).toBe(
        401,
      );
      const r = await app.inject({
        url: "/trading/jev/panel",
        headers: { authorization: "Bearer owner" },
      });
      expect(r.statusCode).toBe(200);
      expect(r.headers["cache-control"]).toBe("no-store");
      for (const suffix of [
        "?owner=foreign",
        "?history_before=bad",
        "?history_before[]=bad",
      ])
        expect(
          (
            await app.inject({
              url: "/trading/jev/panel" + suffix,
              headers: { authorization: "Bearer owner" },
            })
          ).statusCode,
        ).toBe(400);
      await app.close();
    });
    it("does not manufacture protected state from a stop ACK or from old protection", async () => {
      const now = Date.now(),
        fill = parseLiveFill(venueFill(now, { time: now, fee: "0.01" }));
      await store.save(
        liveSnapshot(now, {
          fills: [fill],
          funding: [],
          trading_balance_raw: "249990000",
          equity_raw: "249990000",
          orders: [],
        }),
      );
      const v = await f.poolAdapter.transaction((tx) =>
        readJevLiveAccountTx(
          tx,
          "operator",
          "live:h1",
          new Date().toISOString(),
        ),
      );
      expect(v.live_state.protection.state).toBe("pending");
      expect(v.fills[0]?.fee_usd_raw).toBe("10000");
      expect(v.metrics.trading.pnl_usd6).toBe("-10000");
    });
    it("holds the financial/operational snapshot during a concurrent venue fill without GET writes", async () => {
      let changed = false;
      f.setHook(async (sql) => {
        if (!changed && sql.includes("sum((payload->>'realized_pnl_raw')")) {
          changed = true;
          const now = Date.now(),
            fill = parseLiveFill(venueFill(now, { time: now, fee: "0.01" }));
          await store.save(
            liveSnapshot(now, {
              fills: [fill],
              funding: [],
              trading_balance_raw: "249990000",
              equity_raw: "249990000",
            }),
          );
        }
      });
      const first = await readJevPanel(readPool, "operator");
      f.setHook(null);
      expect(changed).toBe(true);
      expect(first.accounts[0]?.metrics?.trading.pnl_usd6).toBe("0");
      expect(first.accounts[0]?.fills).toEqual([]);
      const next = await readJevPanel(readPool, "operator");
      expect(next.accounts[0]?.metrics?.trading.pnl_usd6).toBe("-10000");
      expect(next.accounts[0]?.fills).toHaveLength(1);
    });
    it("rejects malformed history cursors and keeps a valid cursor bounded", () => {
      expect(() =>
        parseLiveHistoryCursor(
          Buffer.from(
            JSON.stringify({
              started_at: new Date().toISOString(),
              experiment_id: "valid",
              owner_id: "foreign",
            }),
          ).toString("base64url"),
        ),
      ).toThrow();
      const c = {
        started_at: new Date().toISOString(),
        experiment_id: "live:fixture",
      };
      expect(
        parseLiveHistoryCursor(
          Buffer.from(JSON.stringify(c)).toString("base64url"),
        ),
      ).toEqual(c);
    });
    it("paginates 22 historical bindings without truncating account capital or lifetime financial results", async () => {
      const base = jevIdentity("live").bindings[0]!;
      for (let n = 1; n <= 21; n++) {
        const binding = {
          ...base.binding,
          experiment_id: `history:${n}`,
          started_at: new Date(opening - 100000 + 1000 * n).toISOString(),
        };
        await f.poolAdapter.transaction(async (tx) => {
          await tx.query(
            "INSERT INTO jev_bindings(experiment_id,owner_id,account_id,mode,profile_id,profile_version,binding) VALUES($1,'operator','live:h1','live','h1',$2,$3::jsonb)",
            [
              binding.experiment_id,
              base.profile.profile_version,
              JSON.stringify(binding),
            ],
          );
        });
      }
      const at = new Date().toISOString(),
        first = await f.poolAdapter.transaction((tx) =>
          readJevLiveAccountTx(tx, "operator", "live:h1", at),
        );
      expect(first.live_state.history).toHaveLength(20);
      expect(first.live_state.history_next_cursor).not.toBeNull();
      const cursor = parseLiveHistoryCursor(
          first.live_state.history_next_cursor!,
        ),
        second = await f.poolAdapter.transaction((tx) =>
          readJevLiveAccountTx(tx, "operator", "live:h1", at, cursor),
        );
      expect(second.live_state.history).toHaveLength(2);
      expect(second.live_state.history_next_cursor).toBeNull();
      expect(
        new Set(
          [...first.live_state.history, ...second.live_state.history].map(
            (h) => h.experiment_id,
          ),
        ).size,
      ).toBe(22);
      expect(second.metrics.capital_usd6).toBe(first.metrics.capital_usd6);
      expect(second.metrics.strategy_after_jev_usd6).toBe("0");
    });
    it("reconciles original venue fees/funding once across duplicate fills and repeated read-only projections", async () => {
      const now = Date.now(),
        fill = parseLiveFill(
          venueFill(now, { time: now, fee: "0.15", closedPnl: "3.5" }),
        ),
        funding = parseLiveFunding(
          venueFunding(now, {
            time: now,
            delta: {
              type: "funding",
              coin: "BTC",
              usdc: "0.2",
              szi: "0.0001",
              fundingRate: "0.000001",
              nSamples: 1,
            },
          }),
        );
      const s = liveSnapshot(now, {
        fills: [fill],
        funding: [funding],
        trading_balance_raw: "253550000",
        open_pnl_raw: "2000000",
        equity_raw: "255550000",
      });
      await store.save(s);
      await store.save(s);
      const before = (
        await f.pool.query("SELECT count(*)::int n FROM jev_live_events")
      ).rows;
      const a = await metrics(),
        b = await metrics();
      expect(a.metrics).toMatchObject({
        quality: "fresh",
        strategy_after_jev_usd6: "5550000",
        conservative_result_usd6: "3550000",
        trading: {
          realized_usd6: "3500000",
          fees_usd6: "150000",
          funding_usd6: "200000",
        },
      });
      expect(b.metrics.trading).toEqual(a.metrics.trading);
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM jev_live_events"))
          .rows,
      ).toEqual(before);
      expect((await metrics("foreign")).metrics.risk_equity_usd6).toBeNull();
      expect((await metrics("foreign")).source).toBeNull();
    });
    it("makes gaps and stale observations unavailable without resetting preserved HWM", async () => {
      await store.append("gap", "gap:fixture", {
        reason: "RECONCILIATION_UNAVAILABLE",
      });
      expect((await metrics()).metrics.trading.pnl_usd6).toBeNull();
      const old = liveSnapshot(opening + 1, {
        fills: [],
        funding: [],
        flat: true,
        position_raw: "0",
        open_pnl_raw: "0",
      });
      await store.save(old);
      const r = await f.poolAdapter.transaction((tx) =>
        readJevLiveMetricsTx(
          tx,
          "operator",
          "live:h1",
          new Date(opening + 3000).toISOString(),
        ),
      );
      expect(r.metrics.quality).toBe("stale");
      expect(r.metrics.high_water_usd6).toBe("250000000");
    });
  },
);
