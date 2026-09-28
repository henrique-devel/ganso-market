import { parseTradingAmount } from "@ganso-market/contracts/trading";
import { describe, it, expect, vi } from "vitest";
import {
  identity,
  iso,
  start,
  command,
  usd,
  funding,
} from "./ledger-fixture.js";
import { market, pricedFill } from "./valuation-fixture.js";
import {
  genesisBatch,
  materializeLedgerBatch,
  type LedgerPayload,
} from "../../src/storage/ledger-contract.js";
import { ledgerScope, replayLedger } from "../../src/trading/ledger.js";
import {
  projectFinancials,
  valueFinancials,
} from "../../src/trading/valuation.js";
import {
  REPLAY_EQUITY_CONTRACTS,
  REPLAY_EQUITY_VERSION,
  REPLAY_CONTRACTS,
  REPLAY_VERSION,
  replayHash,
  sealReplayDataset,
  type ReplayDataset,
} from "../../src/storage/replay-dataset.js";
import { accountMetrics } from "../../src/storage/metrics.js";

function fixture(side: "buy" | "sell" = "buy") {
  const id = identity();
  const d: ReplayDataset = {
    schema_version: REPLAY_EQUITY_VERSION,
    contracts: REPLAY_EQUITY_CONTRACTS,
    equity_history: {
      schema_version: "btc.replay-equity.v1",
      observation_ids: [],
    },
    code_sha: "a".repeat(40),
    cut: {
      captured_at: iso(start + 1000),
      ledger_sequence: "1",
      reservation_sequence: "0",
      semantics: "locked_account_snapshot",
    },
    identity: id,
    ledger: materializeLedgerBatch(genesisBatch(id), "0", iso(start)),
    reservations: [],
    decisions: [],
    jev: [],
    roots: [],
    evidence: [],
  };
  const append = (p: LedgerPayload, at: number, economic = at) => {
    const key = `event:${d.ledger.length}`;
    d.ledger.push(
      ...materializeLedgerBatch(
        {
          transaction_id: key,
          events: [command(key, p, ledgerScope(id), economic)],
        },
        String(d.ledger.length),
        iso(at),
      ),
    );
    d.cut.ledger_sequence = String(d.ledger.length);
  };
  append(pricedFill("open", side), start + 1000);
  const sample = (offset: number, price: string, gap = false) => {
    const at = start + offset,
      m = market(at),
      key = `sample:${offset}`;
    if (m.context!.payload.payload.kind !== "mark_funding")
      throw new Error("fixture");
    m.context!.payload = {
      ...m.context!.payload,
      payload: {
        ...m.context!.payload.payload,
        mark_price: parseTradingAmount("USD_PER_BTC", {
          ...m.context!.payload.payload.mark_price,
          raw: price,
        }),
      },
    };
    m.context!.object_id = `${key}:mark`;
    if (gap) m.capture!.health.channels.context.needs_revalidation = true;
    const v = valueFinancials(
      projectFinancials(replayLedger(id, d.ledger), d.ledger),
      m,
    );
    let flows = 0n;
    for (const e of d.ledger)
      if (
        e.payload.event_type === "cash" &&
        e.payload.reason !== "initial_allocation"
      )
        flows += BigInt(e.payload.delta.raw);
    const add = (
      object_id: string,
      payload: unknown,
      dependencies: string[] = [],
    ) => {
      d.roots.push(object_id);
      d.evidence.push({
        object_id,
        payload,
        payload_hash: replayHash(payload),
        dependencies,
        identity: ledgerScope(id),
        recorded_at: iso(at),
        class: "financial",
      });
    };
    add(m.context!.object_id, m.context!.payload);
    add(`${key}:capture`, m.capture);
    add(
      key,
      {
        schema_version: "btc.equity-observation.v1",
        scope: ledgerScope(id),
        observed_at: iso(at),
        slot: iso(Math.floor(at / 300000) * 300000),
        financial_start_at: id.experiment.started_at,
        ledger: {
          last_sequence: d.cut.ledger_sequence,
          hash: replayHash(d.ledger),
        },
        reservations: {
          last_sequence: "0",
          hash: replayHash([]),
          held_usd_raw: "0",
        },
        capital_usd_raw: "1000000000",
        external_flows_usd_raw: flows.toString(),
        realized_pnl_usd_raw: v.realized_pnl_usd_raw,
        fees_usd_raw: v.fees_usd_raw,
        funding_usd_raw: v.funding_usd_raw,
        balance_usd_raw: v.balance_usd_raw,
        equity_usd_raw: v.maintenance.equity_usd_raw,
        unrealized_pnl_usd_raw: v.maintenance.unrealized_pnl_usd_raw,
        mark: { evidence: m.context!.object_id },
        capture_evidence_id: `${key}:capture`,
      },
      [m.context!.object_id, `${key}:capture`],
    );
    d.equity_history!.observation_ids.push(key);
    d.cut.captured_at = iso(at + 1000);
  };
  return {
    d,
    append,
    sample,
    report: () => accountMetrics(sealReplayDataset(d)),
  };
}
describe("versioned observed equity metrics", () => {
  it("hand calculation: $1000→1200→900→1100, observed $300/25% drawdown, open $100 profit; deterministic offline", () => {
    const f = fixture();
    ["64000000000", "84000000000", "54000000000", "74000000000"].forEach(
      (p, i) => f.sample(2000 + i * 300000, p),
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("provider forbidden"));
    try {
      const r = f.report();
      expect(r).toEqual(f.report());
      expect(fetch).not.toHaveBeenCalled();
      expect(r.schema_version).toBe("btc.metrics.v2");
      expect(r.drawdown).toMatchObject({
        max_usd_raw: "300000000",
        max_ppm: "250000",
        intrabar_extreme: null,
      });
      expect(r.trading).toMatchObject({
        equity_usd_raw: "1100000000",
        unrealized_pnl_usd_raw: "100000000",
        net_pnl_usd_raw: "100000000",
      });
    } finally {
      fetch.mockRestore();
    }
  });
  it("short mark uses signed exposure and actual fill price without a second slippage debit", () => {
    const f = fixture("sell");
    f.sample(2000, "54000000000");
    expect(f.report().trading).toMatchObject({
      unrealized_pnl_usd_raw: "100000000",
      equity_usd_raw: "1100000000",
    });
  });
  it("late funding preserves prior cut; external withdrawal is not drawdown; operating bills remain unknown", () => {
    const f = fixture();
    f.sample(2000, "64000000000");
    const before = sealReplayDataset(structuredClone(f.d));
    f.append(
      { event_type: "cash", reason: "transfer", delta: usd("-400000000") },
      start + 300000,
    );
    f.append(funding("-10000000"), start + 300001, start + 1000);
    f.sample(302000, "64000000000");
    expect(accountMetrics(before).trading.net_pnl_usd_raw).toBe("0");
    expect(f.report()).toMatchObject({
      trading: {
        net_pnl_usd_raw: "-10000000",
        equity_usd_raw: "590000000",
        net_return_ppm: null,
      },
      drawdown: { max_usd_raw: "10000000", max_ppm: "10000" },
      after_operational_costs: { net_pnl_usd_raw: null },
    });
  });
  it("losses to zero and negative equity are not clamped", () => {
    const f = fixture();
    f.sample(2000, "64000000000");
    f.append(
      { event_type: "fee", execution_id: "open", delta: usd("-1000000000") },
      start + 300000,
    );
    f.sample(302000, "64000000000");
    f.append(funding("-500000000"), start + 600000);
    f.sample(602000, "64000000000");
    expect(f.report().drawdown).toMatchObject({
      max_usd_raw: "1500000000",
      max_ppm: "1500000",
    });
    expect(f.report().trading.equity_usd_raw).toBe("-500000000");
  });
  it("missing slot and invalid mark invalidate full drawdown while retaining observed lower bounds", () => {
    const f = fixture();
    f.sample(2000, "64000000000");
    f.sample(602000, "54000000000");
    expect(f.report().drawdown).toMatchObject({
      max_usd_raw: null,
      observed_max_usd_raw: "100000000",
      status: "incomplete_equity_history",
    });
    f.sample(902000, "64000000000", true);
    expect(f.report().trading.net_pnl_usd_raw).toBeNull();
    expect(f.report().equity_curve).toMatchObject({
      coverage: { missing_slots: 1, unavailable_slots: 1 },
    });
  });
  it("a cut past mark freshness cannot reuse the last sample's open PnL", () => {
    const f = fixture();
    f.sample(2000, "65000000000");
    f.d.cut.captured_at = iso(start + 20000);
    expect(f.report().trading.equity_usd_raw).toBeNull();
  });
  it("rejects foreign identity, altered values, broken prefix, reordered slots and unsupported schema", () => {
    for (const mutate of [
      (p: any) => (p.scope.account_id = "other"),
      (p: any) => (p.equity_usd_raw = "2"),
      (p: any) => (p.ledger.hash = "0".repeat(64)),
      (p: any) => (p.slot = iso(start + 300000)),
      (p: any) => (p.schema_version = "unknown"),
    ]) {
      const f = fixture();
      f.sample(2000, "65000000000");
      const o = f.d.evidence.at(-1)!;
      mutate(o.payload);
      o.payload_hash = replayHash(o.payload);
      expect(f.report).toThrow("BTC_REPLAY_EQUITY");
    }
  });
  it("includes genesis before a losing first sample and can value a later flat cut without a fresh mark", () => {
    const f = fixture();
    f.sample(2000, "54000000000");
    expect(f.report().drawdown).toMatchObject({
      max_usd_raw: "100000000",
      max_ppm: "100000",
    });
    f.append(
      pricedFill("close", "sell", "1000000", "65000000000"),
      start + 10000,
    );
    f.d.cut.captured_at = iso(start + 20000);
    expect(f.report().trading).toMatchObject({
      equity_usd_raw: "1010000000",
      unrealized_pnl_usd_raw: "0",
    });
  });
  it("rejects downgraded extension, missing mark evidence and duplicate observation slots", () => {
    const f = fixture();
    f.sample(2000, "65000000000");
    f.d.schema_version = REPLAY_VERSION;
    f.d.contracts = REPLAY_CONTRACTS;
    expect(f.report).toThrow("CONTRACT_VERSION");
    f.d.schema_version = REPLAY_EQUITY_VERSION;
    f.d.contracts = REPLAY_EQUITY_CONTRACTS;
    f.d.equity_history!.observation_ids.push(
      f.d.equity_history!.observation_ids[0]!,
    );
    expect(f.report).toThrow("EQUITY_VERSION_OR_LIMIT");
    f.d.equity_history!.observation_ids.pop();
    f.d.evidence_mode = "references";
    const mark = f.d.evidence.shift()!;
    f.d.retained_refs = [
      {
        object_id: mark.object_id,
        recorded_at: mark.recorded_at,
        payload_hash: mark.payload_hash,
      },
    ];
    expect(f.report).toThrow("EQUITY_MARK_EVIDENCE");
  });
  it("legacy datasets keep null exposed equity and v1 metrics; empty v2 history stays incomplete", () => {
    const f = fixture();
    expect(f.report().drawdown.status).toBe("incomplete_equity_history");
    delete f.d.equity_history;
    f.d.schema_version = REPLAY_VERSION;
    f.d.contracts = REPLAY_CONTRACTS;
    expect(f.report()).toMatchObject({
      schema_version: "btc.metrics.v1",
      trading: { equity_usd_raw: null },
      drawdown: { max_usd_raw: null, status: "missing_equity_history" },
    });
  });
});
