import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { riskFixture } from "./risk-fixture.js";
import {
  jevIdentity,
  jevCommand,
  fill,
  usd,
  iso,
  start,
} from "./jev-v2-fixture.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import {
  jevHash,
  registerJevPair,
  registerJevLiveIdentity,
  appendJevLedgerBatch,
  readJevAccount,
} from "../../src/storage/jev-store.js";
import {
  observeJevRisk,
  reconcileJevRisk,
  reserveJevEntry,
  requestJevReduction,
} from "../../src/storage/jev-riskstore.js";
import {
  commandJevPilot,
  readJevPilot,
  type JevPilotObservation,
  type JevPilotCommand,
} from "../../src/storage/jev-pilotstore.js";
import { metadata } from "./bars-fixture.js";
import { jevScope } from "../../src/storage/jev-ledger.js";
import { sizingInput } from "./jev-risk-fixture.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let f: Awaited<ReturnType<typeof riskFixture>>, at: number;
const manifest = initialJevManifest(1);
function pair() {
  const paper = jevIdentity(),
    stress = jevIdentity("stress");
  for (const i of [paper, stress])
    i.bindings[0]!.profile.manifest_hash = jevHash(manifest);
  return { paper, stress };
}
function live() {
  const i = jevIdentity("live");
  i.bindings[0]!.profile.manifest_hash = jevHash(manifest);
  return i;
}
let n = 0;
async function ready(id = "paper:h1") {
  await f.capture({ at, mark: "64000000000" });
  const ledger = await readJevAccount(f.poolAdapter, "operator", id);
  return reconcileJevRisk(f.poolAdapter, "operator", id, {
    operation_id: `reconcile:${++n}`,
    ledger_sequence: ledger.projection.last_sequence,
    observed_at: iso(at),
    funding_through_at: iso(Math.floor(at / 3600000) * 3600000),
    evidence: {
      source: "fixture-only",
      ledger_sequence: ledger.projection.last_sequence,
    },
  });
}
function observation(
  e = "250000000",
  changes: Partial<JevPilotObservation> = {},
): JevPilotObservation {
  return {
    version: "btc.jev-pilot-reconciliation.v1",
    source: "hyperliquid:mainnet:reconciliation",
    evidence_id: `fixture:${++n}`,
    observed_at: iso(at),
    received_at: iso(at),
    funded_capital_usd_raw: "250000000",
    trading_balance_usd_raw: e,
    open_pnl_usd_raw: "0",
    flat: true,
    reconciled: true,
    original: { fixture: true },
    utc_anchor: {
      at: iso(Math.floor(at / 86400000) * 86400000),
      equity_usd_raw: "250000000",
      evidence_id: "fixture-midnight",
      original: { fixture: true },
    },
    ...changes,
  };
}
function pilot(
  action: JevPilotCommand["action"],
  sequence: string,
  e = "250000000",
  changes: Partial<JevPilotCommand> = {},
) {
  return commandJevPilot(f.poolAdapter, "operator", "live:h1", {
    operation_id: `pilot:${++n}`,
    expected_sequence: sequence,
    action,
    observation: observation(e),
    ...(action === "observe"
      ? {}
      : {
          operator_decision: {
            actor_id: "operator",
            decision_id: `operator:${n}`,
            reason: "controlled fixture",
          },
        }),
    ...changes,
  });
}
describe.skipIf(!url)(
  "JE05 immutable risk and pilot on disposable PostgreSQL",
  () => {
    beforeEach(async () => {
      f = await riskFixture(url);
      at = Date.now() - 86400000 - 60000;
      f.setClock(iso(at));
      n = 0;
    });
    afterEach(async () => {
      await f?.dispose();
    });
    it("seeds nothing and preserves v2 money while reserving one exact quantity concurrently", async () => {
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM jev_risk_events"))
          .rows[0].n,
      ).toBe(0);
      const p = pair();
      await registerJevPair(f.poolAdapter, 1, p.paper, p.stress, manifest);
      await ready();
      const input = {
        ...sizingInput,
        decision_at: iso(at),
        atr_captured_at: iso(at - 1000),
      };
      const out = await Promise.all(
        Array.from({ length: 4 }, () =>
          reserveJevEntry(f.poolAdapter, manifest, metadata, input),
        ),
      );
      for (const row of out) {
        expect(row.status).toBe("reserved");
        expect(row.order?.quantity_btc_raw).toBe(row.plan?.quantity_btc_raw);
      }
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM jev_entry_events"))
          .rows[0].n,
      ).toBe(1);
      const account = await readJevAccount(
        f.poolAdapter,
        "operator",
        "paper:h1",
      );
      expect(account.projection.cash_usd_raw).toBe("250000000");
      expect(account.events).toHaveLength(1);
      expect(
        (
          await reserveJevEntry(f.poolAdapter, manifest, metadata, {
            ...input,
            order_id: "second",
          })
        ).status,
      ).toBe("refused");
      await expect(
        reserveJevEntry(f.poolAdapter, manifest, metadata, {
          ...input,
          entry_price_raw: "64000000000",
        }),
      ).rejects.toThrow(/COLLISION/);
    });
    it("funding/fill/checkpoints serialize, include open PnL, and latch exactly 270 to 257.50", async () => {
      const p = pair();
      await registerJevPair(f.poolAdapter, 1, p.paper, p.stress, manifest);
      await ready();
      const input = {
        ...sizingInput,
        decision_at: iso(at),
        atr_captured_at: iso(at - 1000),
      };
      await reserveJevEntry(f.poolAdapter, manifest, metadata, input);
      at += 1000;
      f.setClock(iso(at));
      await f.capture({ at, mark: "66000000000" });
      await appendJevLedgerBatch(f.poolAdapter, "operator", "paper:h1", {
        transaction_id: "open",
        events: [jevCommand(p.paper, "open", fill())],
      });
      let risk = await observeJevRisk(f.poolAdapter, "operator", "paper:h1");
      expect(risk.checkpoint.high_water_usd_raw).toBe("270000000");
      const funding = {
        event_type: "funding" as const,
        position_id: "position:1",
        period_start: iso(start),
        period_end: iso(start + 1000),
        rate: {
          unit: "RATE" as const,
          decimals: 9 as const,
          raw: "100000" as typeof metadata.fees.maker.raw,
        },
        delta: usd("-12500000"),
        origin: {
          ...metadata.instrument.origin,
          kind: "funding" as const,
          source_timestamp: iso(start + 1000),
          received_at: iso(start + 1000),
        },
      };
      await Promise.all([
        appendJevLedgerBatch(f.poolAdapter, "operator", "paper:h1", {
          transaction_id: "funding",
          events: [jevCommand(p.paper, "funding", funding)],
        }),
        observeJevRisk(f.poolAdapter, "operator", "paper:h1"),
      ]);
      risk = await observeJevRisk(f.poolAdapter, "operator", "paper:h1");
      expect(risk.checkpoint.equity_usd_raw).toBe("257500000");
      expect(risk.checkpoint.drawdown_floor_usd_raw).toBe("257500000");
      expect(risk.checkpoint.drawdown_blocked).toBe(true);
      expect(risk.checkpoint.request_close).toBe(true);
      expect(
        (
          await f.pool.query(
            "SELECT status FROM jev_entry_events ORDER BY sequence DESC LIMIT 1",
          )
        ).rows[0].status,
      ).toBe("cancel_requested");
      const retry = await reserveJevEntry(
        f.poolAdapter,
        manifest,
        metadata,
        input,
      );
      expect(retry.status).toBe("cancel_requested");
      expect(retry.order).toBeUndefined();
      const reduction = await requestJevReduction(
        f.poolAdapter,
        "operator",
        "paper:h1",
      );
      expect(reduction.reduce_only).toBe(true);
      expect(reduction.positions).toHaveLength(1);
      const stored = (
        await f.pool.query(
          "SELECT sequence,checkpoint,evidence FROM jev_risk_events WHERE account_id='paper:h1' ORDER BY sequence DESC LIMIT 1",
        )
      ).rows[0];
      const reset = {
        ...stored.checkpoint,
        high_water_usd_raw: "250000000",
        drawdown_floor_usd_raw: "237500000",
      };
      await expect(
        f.pool.query(
          "INSERT INTO jev_risk_events(account_id,sequence,operation_id,checkpoint,evidence) VALUES('paper:h1',$1,'illegal-reset',$2,$3)",
          [String(BigInt(stored.sequence) + 1n), reset, stored.evidence],
        ),
      ).rejects.toThrow(/HWM_OR_CLOCK_RESET/);
      // A restart reads persisted risk, and paper never contaminates stress.
      expect(
        (await observeJevRisk(f.poolAdapter, "operator", "stress:h1"))
          .checkpoint.high_water_usd_raw,
      ).toBe("250000000");
      at += 86400000;
      f.setClock(iso(at));
      await f.capture({ at, mark: "66000000000" });
      expect(
        (await observeJevRisk(f.poolAdapter, "operator", "paper:h1")).checkpoint
          .drawdown_blocked,
      ).toBe(true);
    });
    it("daily rollover needs flat reconciliation, funding/costs remain ledger-only and UTC cannot reset HWM", async () => {
      const p = pair();
      await registerJevPair(f.poolAdapter, 1, p.paper, p.stress, manifest);
      await ready();
      await appendJevLedgerBatch(f.poolAdapter, "operator", "paper:h1", {
        transaction_id: "round-trip",
        events: [
          jevCommand(p.paper, "open", fill()),
          jevCommand(p.paper, "fee", {
            event_type: "fee",
            execution_id: "exec:1",
            delta: usd("-5000000"),
          }),
          jevCommand(p.paper, "close", fill("exec:2", "sell")),
        ],
      });
      let risk = await ready();
      expect(risk.checkpoint.daily_pause_day).toBe(iso(at).slice(0, 10));
      expect(risk.checkpoint.entries_paused).toBe(true);
      at += 86400000;
      f.setClock(iso(at));
      await f.capture({ at });
      risk = await observeJevRisk(f.poolAdapter, "operator", "paper:h1");
      expect(risk.checkpoint.entries_paused).toBe(true);
      risk = await ready();
      expect(risk.checkpoint.entries_paused).toBe(false);
      expect(risk.checkpoint.high_water_usd_raw).toBe("250000000");
      expect(risk.checkpoint.daily_anchor_usd_raw).toBe("245000000");
      expect(risk.ledger.projection.cash_usd_raw).toBe("245000000");
    });
    it("pause refusal commits cancellation and stale data cannot enable a reservation", async () => {
      const p = pair();
      await registerJevPair(f.poolAdapter, 1, p.paper, p.stress, manifest);
      await ready();
      const input = {
        ...sizingInput,
        decision_at: iso(at),
        atr_captured_at: iso(at - 1000),
      };
      await reserveJevEntry(f.poolAdapter, manifest, metadata, input);
      at += 3000;
      f.setClock(iso(at));
      const refused = await reserveJevEntry(f.poolAdapter, manifest, metadata, {
        ...input,
        order_id: "other",
        decision_at: iso(at),
      });
      expect(refused.status).toBe("refused");
      expect(
        (
          await f.pool.query(
            "SELECT status FROM jev_entry_events ORDER BY sequence DESC LIMIT 1",
          )
        ).rows[0].status,
      ).toBe("cancel_requested");
      for (const table of [
        "jev_risk_events",
        "jev_risk_reconciliations",
        "jev_entry_events",
      ]) {
        await expect(f.pool.query(`DELETE FROM ${table}`)).rejects.toThrow(
          /APPEND_ONLY/,
        );
        await expect(f.pool.query(`TRUNCATE ${table}`)).rejects.toThrow();
      }
    });
    it("global fixed DD survives restart/UTC/profile and explicit safe operator rearm is fenced", async () => {
      await registerJevLiveIdentity(f.poolAdapter, live(), manifest);
      const init = await pilot("authorize_supervisor", "0");
      expect(init.checkpoint.executor_enabled).toBe(false);
      const peak = await pilot("observe", "1", "270000000");
      expect(peak.checkpoint.risk.drawdown_floor_usd_raw).toBe("257500000");
      const dd = await pilot("observe", "2", "257500000");
      expect(dd.checkpoint.global_blocked).toBe(true);
      const replay = await commandJevPilot(
        f.poolAdapter,
        "operator",
        "live:h1",
        init.request,
      );
      expect(replay.sequence).toBe("3");
      expect(replay.checkpoint.global_blocked).toBe(true);
      await expect(pilot("select_profile", "3", "270000000")).rejects.toThrow(
        /GLOBAL_BLOCK/,
      );
      await expect(pilot("rearm", "3", "257500000")).rejects.toThrow(/UNSAFE/);
      at += 86400000;
      f.setClock(iso(at));
      const rolled = await pilot("observe", "3", "270000000");
      expect(rolled.checkpoint.global_blocked).toBe(true);
      expect(rolled.checkpoint.risk.high_water_usd_raw).toBe("270000000");
      await expect(
        commandJevPilot(f.poolAdapter, "operator", "live:h1", {
          operation_id: "unauthorized",
          expected_sequence: "4",
          action: "rearm",
          observation: observation("270000000"),
        }),
      ).rejects.toThrow(/OPERATOR/);
      const outcomes = await Promise.allSettled([
        pilot("rearm", "4", "270000000"),
        pilot("rearm", "4", "270000000"),
      ]);
      expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      const read = await readJevPilot(f.poolAdapter, "operator", "live:h1");
      expect(read?.checkpoint.global_blocked).toBe(false);
      expect(read?.checkpoint.risk.high_water_usd_raw).toBe("270000000");
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM jev_ledger_events"))
          .rows[0].n,
      ).toBe(0);
      await expect(
        f.pool.query("DELETE FROM jev_pilot_events"),
      ).rejects.toThrow(/APPEND_ONLY/);
    });
    it("two simulated promotions share singleton fence and cannot reset the global peak", async () => {
      const i = live();
      await registerJevLiveIdentity(f.poolAdapter, i, manifest);
      const b = structuredClone(i.bindings[0]!.binding);
      b.experiment_id = "live:successor";
      b.started_at = iso(start + 1000);
      await f.pool.query(
        "INSERT INTO jev_bindings(experiment_id,owner_id,account_id,mode,profile_id,profile_version,binding) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          b.experiment_id,
          b.owner_id,
          b.account_id,
          b.mode,
          b.profile_id,
          b.profile_version,
          b,
        ],
      );
      await pilot("authorize_supervisor", "0");
      await pilot("observe", "1", "270000000");
      const outcomes = await Promise.allSettled([
        pilot("select_profile", "2", "270000000", {
          experiment_id: b.experiment_id,
        }),
        pilot("select_profile", "2", "270000000", {
          experiment_id: b.experiment_id,
        }),
      ]);
      expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      const read = await readJevPilot(f.poolAdapter, "operator", "live:h1");
      expect(read?.checkpoint.active_experiment_id).toBe(b.experiment_id);
      expect(read?.checkpoint.risk.high_water_usd_raw).toBe("270000000");
      expect(read?.checkpoint.risk.drawdown_floor_usd_raw).toBe("257500000");
      const p = pair();
      await registerJevPair(f.poolAdapter, 1, p.paper, p.stress, manifest);
      await expect(
        commandJevPilot(f.poolAdapter, "operator", "paper:h1", {
          operation_id: "cross",
          action: "observe",
          expected_sequence: "0",
          observation: observation(),
        }),
      ).rejects.toThrow(/LIVE_ONLY/);
      const entry = {
        ...sizingInput,
        scope: jevScope(b, i.instrument),
        decision_at: iso(at),
        atr_captured_at: iso(at - 1000),
      };
      expect(
        await reserveJevEntry(f.poolAdapter, manifest, metadata, entry),
      ).toMatchObject({ status: "refused", reason: "LIVE_ADMISSION_CLOSED" });
    });
    it("unreconciled/stale pilot evidence or missing midnight cannot authorize supervisor", async () => {
      await registerJevLiveIdentity(f.poolAdapter, live(), manifest);
      for (const changes of [
        { utc_anchor: null },
        { reconciled: false },
        { observed_at: iso(at - 3000), received_at: iso(at - 3000) },
      ])
        await expect(
          pilot("authorize_supervisor", "0", "250000000", {
            observation: observation("250000000", changes),
          }),
        ).rejects.toThrow(/NOT_READY/);
      expect(
        await readJevPilot(f.poolAdapter, "operator", "live:h1"),
      ).toBeNull();
    });
  },
);
