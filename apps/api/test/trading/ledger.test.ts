import { ledgerScope, replayLedger } from "../../src/trading/ledger.js";
import { describe, expect, it } from "vitest";
import {
  genesisBatch,
  materializeLedgerBatch,
  type LedgerBatch,
  type LedgerPayload,
} from "../../src/storage/ledger-contract.js";
import {
  command,
  fill,
  funding,
  identity,
  iso,
  start,
  usd,
} from "./ledger-fixture.js";
const recorded = iso(start + 100_000);
const genesis = () =>
  materializeLedgerBatch(genesisBatch(identity()), "0", recorded);
function project(payloads: LedgerPayload[]) {
  return replayLedger(identity(), [
    ...genesis(),
    ...materializeLedgerBatch(
      {
        transaction_id: "tx",
        events: payloads.map((p, i) => command(`event:${i}`, p)),
      },
      "1",
      recorded,
    ),
  ]);
}
describe("paper ledger pure contract", () => {
  it("starts at exactly 1000 fictitious USD and zero position", () => {
    expect(replayLedger(identity(), genesis())).toEqual({
      schema_version: "btc.ledger.v1",
      scope: ledgerScope(identity()),
      last_sequence: "1",
      cash_usd_raw: "1000000000",
      positions: [],
    });
  });
  it("fill is not a spot purchase; fee, rebate, funding and capital change cash exactly", () => {
    const p = project([
      fill(),
      { event_type: "fee", execution_id: "exec:1", delta: usd("-100000") },
      funding(),
      {
        event_type: "cash",
        reason: "transfer",
        delta: usd("123456789012345678901"),
      },
    ]);
    expect(p.cash_usd_raw).toBe("123456789013345328901");
    expect(p.positions).toEqual([
      { position_id: "position:1", quantity_btc_raw: "1000000" },
    ]);
    expect(
      project([
        fill(),
        { event_type: "fee", execution_id: "exec:1", delta: usd("123") },
      ]).cash_usd_raw,
    ).toBe("1000000123");
  });
  it("short and reducing fills project signed quantity; liquidation itself debits nothing", () => {
    expect(project([fill("e1", "sell")]).positions[0]?.quantity_btc_raw).toBe(
      "-1000000",
    );
    expect(
      project([
        fill(),
        fill("exec:2", "sell"),
        {
          event_type: "liquidation",
          position_id: "position:1",
          execution_id: "exec:2",
        },
      ]),
    ).toMatchObject({
      cash_usd_raw: "1000000000",
      positions: [{ quantity_btc_raw: "0" }],
    });
  });
  it("sorts by durable sequence even with reverse input and late economic timestamps", () => {
    const events = [
      ...genesis(),
      ...materializeLedgerBatch(
        {
          transaction_id: "a",
          events: [command("open", fill(), undefined, start + 5000)],
        },
        "1",
        recorded,
      ),
      ...materializeLedgerBatch(
        { transaction_id: "b", events: [command("fund", funding())] },
        "2",
        recorded,
      ),
    ];
    expect(replayLedger(identity(), events.reverse())).toMatchObject({
      last_sequence: "3",
      cash_usd_raw: "999750000",
    });
  });
  it.each([
    [
      "orphan fee",
      [{ event_type: "fee", execution_id: "none", delta: usd("-1") }],
    ],
    [
      "second genesis",
      [
        {
          event_type: "cash",
          reason: "initial_allocation",
          delta: usd("1000000000"),
        },
      ],
    ],
    ["duplicate execution", [fill(), fill()]],
    [
      "duplicate fee",
      [
        fill(),
        { event_type: "fee", execution_id: "exec:1", delta: usd("-1") },
        { event_type: "fee", execution_id: "exec:1", delta: usd("-1") },
      ],
    ],
    ["duplicate funding", [fill(), funding(), funding()]],
    ["orphan funding", [funding()]],
    [
      "liquidation without close",
      [
        fill(),
        {
          event_type: "liquidation",
          execution_id: "exec:1",
          position_id: "position:1",
        },
      ],
    ],
    ["inexact lot", [fill("e", "buy", "1")]],
  ] as [string, LedgerPayload[]][])("rejects %s", (_name, payloads) => {
    expect(() => project(payloads)).toThrow();
  });
  it("rejects cross-owner, missing sequence, invalid scale and unsupported accounting", () => {
    const other = materializeLedgerBatch(
      genesisBatch(identity("other")),
      "0",
      recorded,
    );
    expect(() => replayLedger(identity(), other)).toThrow("OWNERSHIP");
    expect(() =>
      replayLedger(identity(), [{ ...genesis()[0]!, sequence: usd("2").raw }]),
    ).toThrow("SEQUENCE");
    expect(() =>
      project([
        {
          event_type: "cash",
          reason: "transfer",
          delta: { ...usd("1"), decimals: 8 },
        } as unknown as LedgerPayload,
      ]),
    ).toThrow();
    const batch = {
      transaction_id: "t",
      events: [
        command("pnl", {
          event_type: "realized_pnl",
          position_id: "p",
          execution_id: "e",
          delta: usd("1"),
        } as unknown as LedgerPayload),
      ],
    };
    expect(() => materializeLedgerBatch(batch, "1", recorded)).toThrow(
      "UNSUPPORTED_EVENT",
    );
  });
  it("rejects caller-supplied sequence and non-JSON data", () => {
    const batch = genesisBatch(identity());
    expect(() =>
      materializeLedgerBatch(
        {
          ...batch,
          events: [{ ...batch.events[0]!, sequence: "1" }],
        } as unknown as LedgerBatch,
        "0",
        recorded,
      ),
    ).toThrow("STORE_FIELDS");
    expect(() =>
      materializeLedgerBatch(
        { ...batch, ignored: undefined } as LedgerBatch,
        "0",
        recorded,
      ),
    ).toThrow();
  });
});
