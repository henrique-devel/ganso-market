import { replayFinancials } from "../../src/storage/valuationstore.js";
import { describe, expect, it } from "vitest";
import { valueFinancials } from "../../src/trading/valuation.js";
import {
  command,
  funding,
  identity,
  iso,
  start,
  usd,
} from "./ledger-fixture.js";
import { financial, history, market, pricedFill } from "./valuation-fixture.js";
import { materializeLedgerBatch } from "../../src/storage/ledger-contract.js";

describe("BTC valuation independent USD/BTC fixtures", () => {
  it.each([
    ["buy", "sell", "65000000000", "10000000", "1010000000"],
    ["buy", "sell", "63000000000", "-10000000", "990000000"],
    ["sell", "buy", "63000000000", "10000000", "1010000000"],
    ["sell", "buy", "65000000000", "-10000000", "990000000"],
  ] as const)(
    "%s then %s @ %s realizes %s",
    (open, close, price, pnl, balance) => {
      const p = financial([
        pricedFill("a", open),
        pricedFill("b", close, "1000000", price),
      ]);
      expect(p.realized_pnl_usd_raw).toBe(pnl);
      expect(p.balance_usd_raw).toBe(balance);
      expect(p.positions[0]).toMatchObject({
        quantity_btc_raw: "0",
        cost_usd14_raw: "0",
      });
    },
  );
  it("weighted cost, partial close, reversal and reopen consume exact remaining basis", () => {
    const fills = [
      pricedFill("a", "buy"),
      pricedFill("b", "buy", "2000000", "67000000000"),
      pricedFill("c", "sell", "1000000", "68000000000"),
    ];
    const partial = financial(fills);
    expect(partial.positions[0]).toMatchObject({
      quantity_btc_raw: "2000000",
      cost_usd14_raw: "132000000000000000",
    }); // 0.02 @ 66000 = $1320
    expect(partial.realized_pnl_usd_raw).toBe("20000000");
    const reversed = financial([
      ...fills,
      pricedFill("d", "sell", "3000000", "65000000000"),
    ]);
    expect(reversed.positions[0]).toMatchObject({
      quantity_btc_raw: "-1000000",
      cost_usd14_raw: "65000000000000000",
    });
    expect(reversed.realized_pnl_usd_raw).toBe("0"); // +20 -20
    const reopened = financial([
      ...fills,
      pricedFill("d", "sell", "2000000", "65000000000"),
      pricedFill("e", "sell", "1000000", "65000000000"),
    ]);
    expect(reopened.positions).toEqual(reversed.positions);
  });
  it("short weighted partial close realizes loss and keeps the remaining short basis", () => {
    const p = financial([
      pricedFill("a", "sell"),
      pricedFill("b", "sell", "2000000", "67000000000"),
      pricedFill("c", "buy", "1000000", "68000000000"),
    ]);
    expect(p.positions[0]).toMatchObject({
      quantity_btc_raw: "-2000000",
      cost_usd14_raw: "132000000000000000",
    });
    expect(p.realized_pnl_usd_raw).toBe("-20000000");
    expect(valueFinancials(p, market()).maintenance).toMatchObject({
      unrealized_pnl_usd_raw: "20000000",
      equity_usd_raw: "1000000000",
    });
  });
  it("costs settle once, fill slippage stays in cost, liquidation marker adds nothing", () => {
    const p = financial([
      pricedFill("a", "buy", "1000000", "64100000000"),
      { event_type: "fee", execution_id: "a", delta: usd("-500000") },
      funding("-250000"),
      pricedFill("b", "sell", "1000000", "65000000000"),
      { event_type: "fee", execution_id: "b", delta: usd("100000") },
      {
        event_type: "liquidation",
        execution_id: "b",
        position_id: "position:1",
      },
    ]);
    expect(p).toMatchObject({
      realized_pnl_usd_raw: "9000000",
      fees_usd_raw: "-400000",
      funding_usd_raw: "-250000",
      balance_usd_raw: "1008350000",
    });
  });
  it("opposite owners have independent balances, maintenance marks and executable sides/depth", () => {
    const long = valueFinancials(financial([pricedFill("a", "buy")]), market());
    const short = valueFinancials(
      financial([pricedFill("a", "sell")], "other"),
      market(),
    );
    expect(long.maintenance).toMatchObject({
      unrealized_pnl_usd_raw: "10000000",
      equity_usd_raw: "1010000000",
    });
    expect(short.maintenance).toMatchObject({
      unrealized_pnl_usd_raw: "-10000000",
      equity_usd_raw: "990000000",
    });
    // Long sells 0.006 @ 64900 + 0.004 @ 64800 = $648.60; short buys $651.40.
    expect(long.closing).toMatchObject({
      gross_pnl_usd_raw: "8600000",
      gross_equity_usd_raw: "1008600000",
      positions: [{ side: "sell", executable_notional_usd_raw: "648600000" }],
    });
    expect(short.closing).toMatchObject({
      gross_pnl_usd_raw: "-11400000",
      gross_equity_usd_raw: "988600000",
      positions: [{ side: "buy", executable_notional_usd_raw: "651400000" }],
    });
  });
  it("does not reuse finite same-side depth between positions or claim full closing equity on partial", () => {
    const second = pricedFill("b", "buy", "2000000");
    if (second.event_type !== "fill") throw new Error("fixture");
    const v = valueFinancials(
      financial([
        pricedFill("a", "buy", "2000000"),
        { ...second, position_id: "position:2" },
      ]),
      market(),
    );
    expect(v.closing).toMatchObject({
      status: "partial",
      gross_equity_usd_raw: null,
      positions: [
        { executable_btc_raw: "2000000", unfilled_btc_raw: "0" },
        { executable_btc_raw: "600000", unfilled_btc_raw: "1400000" },
      ],
    });
    expect(v.maintenance.equity_usd_raw).toBe("1040000000");
  });
  it.each([
    "missing",
    "stale",
    "unknown",
    "future",
    "version",
    "disconnect",
    "gap",
  ] as const)(
    "%s mark cannot become zero PnL or safe equity and never falls back to oracle/book",
    (reason) => {
      const m = market();
      if (reason === "missing") m.context = null;
      else if (reason === "stale")
        m.context!.payload = {
          ...m.context!.payload,
          source_timestamp: iso(start),
        };
      else if (reason === "unknown")
        m.context!.payload = {
          ...m.context!.payload,
          source_timestamp: null,
          quality: "unknown",
        };
      else if (reason === "future")
        m.context!.payload = {
          ...m.context!.payload,
          source_timestamp: iso(start + 100_001),
        };
      else if (reason === "version")
        m.context!.payload = {
          ...m.context!.payload,
          instrument_version: "other",
        };
      else if (reason === "disconnect")
        m.capture!.health.socket.connected = false;
      else m.capture!.health.channels.context.gap_epoch++;
      const v = valueFinancials(financial([pricedFill("a", "buy")]), m);
      expect(v.maintenance).toMatchObject({
        unrealized_pnl_usd_raw: null,
        equity_usd_raw: null,
        usable_for_risk: false,
      });
      if (reason === "unknown") expect(v.maintenance.status).toBe("degraded");
    },
  );
  it.each(["stale", "missing", "crossed", "empty", "unknown", "gap"] as const)(
    "%s book cannot claim a complete exit; mark remains separate",
    (reason) => {
      const m = market();
      if (reason === "missing") m.book = null;
      else if (reason === "stale")
        m.book!.payload = { ...m.book!.payload, quality: "stale" };
      else if (reason === "unknown")
        m.book!.payload = { ...m.book!.payload, source_timestamp: null };
      else if (reason === "gap") m.capture!.health.channels.book.gap_epoch++;
      else if (m.book!.payload.payload.kind === "book")
        m.book!.payload = {
          ...m.book!.payload,
          payload: {
            ...m.book!.payload.payload,
            bids: reason === "empty" ? [] : m.book!.payload.payload.asks,
          },
        };
      const v = valueFinancials(financial([pricedFill("a", "buy")]), m);
      expect(v.closing.gross_equity_usd_raw).toBeNull();
      expect(v.maintenance.equity_usd_raw).toBe("1010000000");
    },
  );
  it("flat balance is known even without market prices, quality remains unavailable", () => {
    const v = valueFinancials(financial([]), {
      as_of: iso(start),
      context: null,
      book: null,
      capture: null,
    });
    expect(v.maintenance).toMatchObject({
      equity_usd_raw: "1000000000",
      quality: "missing",
      usable_for_risk: false,
    });
    expect(v.closing).toMatchObject({
      status: "flat",
      gross_equity_usd_raw: "1000000000",
    });
  });
  it("retains allocation remainders and rounds cumulative signed PnL at the minimum USD unit", () => {
    const id = identity();
    // A finer valid paper instrument version tests arithmetic below current venue lot/tick.
    const fine = {
      ...id,
      instrument: {
        ...id.instrument,
        tick_size: { raw: "1" },
        quantity_step: { raw: "1" },
      },
    };
    const events = history([
      pricedFill("a", "buy", "1", "1"),
      pricedFill("b", "buy", "2", "2"),
      pricedFill("c", "sell", "1", "1"),
    ]);
    const partial = replayFinancials(fine, events);
    expect(partial.positions[0]).toMatchObject({
      cost_usd14_raw: "4",
      realized_usd14_raw: "0",
    });
    const close = materializeLedgerBatch(
      {
        transaction_id: "close",
        events: [command("d", pricedFill("d", "sell", "2", "1"))],
      },
      "4",
      iso(start + 100_000),
    );
    const full = replayFinancials(fine, [...events, ...close]);
    expect(full.realized_pnl_usd_raw).toBe("-1");
    expect(full.positions[0]).toMatchObject({
      cost_usd14_raw: "0",
      realized_usd14_raw: "-2",
    });
    expect(replayFinancials(fine, [...close, ...events].reverse())).toEqual(
      full,
    );
  });
  it("is a pure repeatable read and rejects mixed owners and duplicate executions", () => {
    const p = financial([pricedFill("a", "buy")]),
      m = market();
    const before = JSON.stringify({ p, m });
    expect(valueFinancials(p, m)).toEqual(valueFinancials(p, m));
    expect(JSON.stringify({ p, m })).toBe(before);
    expect(() =>
      replayFinancials(identity(), history([pricedFill("a", "sell")], "other")),
    ).toThrow("OWNERSHIP");
    expect(() =>
      financial([pricedFill("a", "buy"), pricedFill("a", "buy")]),
    ).toThrow("EXECUTION_EXISTS");
  });
});
