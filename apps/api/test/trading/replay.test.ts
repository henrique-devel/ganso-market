import { describe, it, expect } from "vitest";
import { parseTradingAmount } from "@ganso-market/contracts/trading";
import {
  identity,
  command,
  fill,
  funding,
  usd,
  iso,
  start,
} from "./ledger-fixture.js";
import { order } from "./reservation-fixture.js";
import {
  genesisBatch,
  materializeLedgerBatch,
} from "../../src/storage/ledger-contract.js";
import { baselineHash } from "../../src/storage/baseline-inputs.js";
import { decideBaseline } from "../../src/storage/baseline-policy.js";
import { fixture, AT } from "./baseline-fixture.js";
import { reservationHold, release } from "../../src/trading/reservations.js";
import {
  REPLAY_CONTRACTS,
  REPLAY_VERSION,
  replayDataset,
  sealReplayDataset,
  requireSameReplayDataset,
  type ReplayDataset,
} from "../../src/storage/replay-dataset.js";

export function dataset(): ReplayDataset {
  const id = identity();
  const genesis = materializeLedgerBatch(genesisBatch(id), "0", iso(start));
  const opened = materializeLedgerBatch(
    {
      transaction_id: "open",
      events: [
        command("fill", fill()),
        command("fee", {
          event_type: "fee",
          execution_id: "exec:1",
          delta: usd("-100000"),
        }),
      ],
    },
    "1",
    iso(start + 2000),
  );
  const close = fill("exec:2", "sell");
  if (close.event_type !== "fill") throw new Error("fixture");
  const closed = materializeLedgerBatch(
    {
      transaction_id: "close",
      events: [
        command(
          "close",
          {
            ...close,
            price: parseTradingAmount("USD_PER_BTC", {
              unit: "USD_PER_BTC",
              decimals: 6,
              raw: "65000000000",
            }),
          },
          undefined,
          start + 3000,
        ),
      ],
    },
    "3",
    iso(start + 3000),
  );
  const late = materializeLedgerBatch(
    {
      transaction_id: "late",
      events: [command("funding", funding(), undefined, start + 1000)],
    },
    "4",
    iso(start + 4000),
  );
  return {
    schema_version: REPLAY_VERSION,
    contracts: REPLAY_CONTRACTS,
    code_sha: "a".repeat(40),
    cut: {
      captured_at: iso(start + 5000),
      ledger_sequence: "5",
      reservation_sequence: "0",
      semantics: "locked_account_snapshot",
    },
    identity: id,
    ledger: [...genesis, ...opened, ...closed, ...late],
    reservations: [],
    decisions: [],
    jev: [],
    roots: [],
    evidence: [],
  };
}
describe("bounded captured BTC dataset replay", () => {
  it("replays finite capital, fees and late funding exactly without economic reordering", () => {
    const d = dataset(),
      a = sealReplayDataset(d),
      result = replayDataset(a);
    expect(replayDataset(JSON.parse(JSON.stringify(a)))).toEqual(result);
    expect(result.financials).toMatchObject({
      realized_pnl_usd_raw: "10000000",
      fees_usd_raw: "-100000",
      funding_usd_raw: "-250000",
      balance_usd_raw: "1009650000",
    });
    expect(result.late_funding_event_ids).toEqual(["funding"]);
    const earlier = structuredClone(d);
    earlier.ledger.pop();
    earlier.cut.ledger_sequence = "4";
    earlier.cut.captured_at = iso(start + 3500);
    expect(
      replayDataset(sealReplayDataset(earlier)).financials.funding_usd_raw,
    ).toBe("0");
    expect(() =>
      requireSameReplayDataset(a, sealReplayDataset(earlier)),
    ).toThrow("INCOMPATIBLE_DATASETS");
    d.ledger.reverse();
    expect(() => replayDataset(sealReplayDataset(d))).toThrow("LEDGER_ORDER");
  });
  it("reduces reservations through partial fills and release, with no PnL charge", () => {
    const d = dataset(),
      o = order("order:1", {
        quantity_btc_raw: "1500000",
        valid_until: iso(start + 10000),
      });
    const held = reservationHold(o, 1500000n),
      partial = reservationHold(o, 500000n);
    d.reservations = [
      {
        sequence: "1",
        recorded_at: iso(start + 500),
        request: { action: "reserve", operation_id: "reserve", order: o },
        reservation: held,
        ledger_transaction_id: null,
      },
      {
        sequence: "2",
        recorded_at: iso(start + 2000),
        request: {
          action: "consume",
          operation_id: "consume",
          order_id: o.order_id,
          quantity_btc_raw: "1000000",
          price_usd_raw: "64000000000",
          fee_usd_raw: "100000",
        },
        reservation: partial,
        ledger_transaction_id: "open",
      },
    ];
    d.cut.reservation_sequence = "2";
    const r = replayDataset(sealReplayDataset(d));
    expect(r.active_reserved_usd_raw).toBe("325325000");
    expect(r.financials.balance_usd_raw).toBe("1009650000");
    d.reservations.push({
      sequence: "3",
      recorded_at: iso(start + 4500),
      request: {
        action: "release",
        operation_id: "release",
        order_id: o.order_id,
        reason: "cancelled",
      },
      reservation: release(partial, "cancelled"),
      ledger_transaction_id: null,
    });
    d.cut.reservation_sequence = "3";
    expect(replayDataset(sealReplayDataset(d)).active_reserved_usd_raw).toBe(
      "0",
    );
    d.reservations[1]!.ledger_transaction_id = "late";
    expect(() => replayDataset(sealReplayDataset(d))).toThrow(
      "CONSUMPTION_LEDGER",
    );
  });
  it("preserves a captured gap decision, missing inputs and absent Jev, refusing future evidence", () => {
    const input = fixture();
    input.hours.records = [];
    const decision = decideBaseline(input),
      d = dataset();
    d.identity = identity("baseline");
    d.ledger = materializeLedgerBatch(
      genesisBatch(d.identity),
      "0",
      iso(start),
    );
    d.cut.ledger_sequence = "1";
    d.cut.captured_at = iso(AT + 1000);
    d.decisions = [{ decision, evidence_id: "decision" }];
    d.roots = ["decision"];
    d.evidence = [
      {
        object_id: "decision",
        class: "decision",
        identity: decision.registration.scope,
        recorded_at: decision.decision_at,
        payload: decision,
        payload_hash: baselineHash(decision),
        dependencies: [],
      },
    ];
    const result = replayDataset(sealReplayDataset(d));
    expect(result.decisions[0]).toEqual(decision);
    expect(result.fidelity[0]!.state).toBe("data_unavailable");
    expect(result.fidelity[0]!.missing_inputs.length).toBeGreaterThan(0);
    expect(result.fidelity[0]!.jev).toBe("not_captured");
    d.jev = [
      {
        decision_id: decision.decision_id,
        evidence_id: "decision",
        state: "dispatching",
        origin: "real",
        model: "captured-model",
        request_id: "req",
        request: {},
        outcome: null,
      },
    ];
    expect(replayDataset(sealReplayDataset(d)).fidelity[0]!.jev).toBe(
      "response_missing",
    );
    d.jev[0]!.state = "final";
    d.jev[0]!.outcome = { status: "unavailable" };
    expect(replayDataset(sealReplayDataset(d)).jev[0]!.outcome).toEqual({
      status: "unavailable",
    });
    const ref = decision.input_refs[0]!;
    d.roots.push(ref.object_id);
    d.evidence.push({
      object_id: ref.object_id,
      class: "raw",
      identity: decision.registration.scope,
      recorded_at: iso(AT + 100),
      payload: {},
      payload_hash: baselineHash({}),
      dependencies: [],
    });
    expect(() => replayDataset(sealReplayDataset(d))).toThrow("DECISION_AS_OF");
  });
  it("fails closed for tamper, unsupported versions, incomplete dependencies and cross-account ledger", () => {
    const d = dataset(),
      a = sealReplayDataset(d);
    d.code_sha = "b".repeat(40);
    expect(() => replayDataset(a)).toThrow("HASH");
    const bad = dataset();
    bad.contracts = {
      ...REPLAY_CONTRACTS,
      ledger: "unsupported",
    } as unknown as typeof REPLAY_CONTRACTS;
    expect(() => replayDataset(sealReplayDataset(bad))).toThrow(
      "CONTRACT_VERSION",
    );
    const cross = dataset();
    cross.identity = identity("other");
    expect(() => replayDataset(sealReplayDataset(cross))).toThrow("OWNERSHIP");
    const graph = dataset();
    graph.roots = ["x"];
    graph.evidence = [
      {
        object_id: "x",
        class: "raw",
        identity: graph.ledger[0]!,
        recorded_at: iso(start),
        payload: {},
        payload_hash: baselineHash({}),
        dependencies: ["absent"],
      },
    ];
    expect(() => replayDataset(sealReplayDataset(graph))).toThrow(
      "DEPENDENCY_MISSING",
    );
  });
});
