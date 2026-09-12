import { describe, expect, it } from "vitest";
import {
  verifyArchiveReplay,
  type ArchiveReplayRows,
} from "../../src/polymarket/retention-archive-replay.js";

// Literals independent of the verifier; identities intentionally exceed 2^53
// and timestamps differ inside the same millisecond.
const raw = (): Record<string, string[]> => ({
  polymarket_book_snapshots_full: [
    '{"snapshot_id":9007199254740993,"token_id":"archive-token","received_at":"2026-01-01T00:00:00.123456+00:00","source_ts":"2026-01-01T00:00:00.123455+00:00","bids_json":[{"price":"0.4","size":"3"}],"asks_json":[{"price":"0.6","size":"4"}]}',
  ],
  polymarket_book_deltas: [
    '{"delta_id":9007199254740994,"token_id":"archive-token","side":"BUY","price":"0.4","size":"5","received_at":"2026-01-01T00:00:00.123457+00:00","source_ts":"2026-01-01T00:00:00.123456+00:00"}',
    '{"delta_id":9007199254740995,"token_id":"archive-token","side":"SELL","price":"0.6","size":"0","received_at":"2026-01-01T00:00:00.123458+00:00","source_ts":"2026-01-01T00:00:00.123457+00:00"}',
  ],
});

const paper = (): Record<string, string[]> => ({
  paper_orders: [
    '{"order_id":"archive-order","token_id":"archive-token","condition_id":null,"source":"manual","side":"BUY","order_type":"GTC","status":"filled","limit_price":"0.5","size":"2","filled_size":"2","decided_at":"2026-01-01T00:00:00.123456Z","accepted_at":"2026-01-01T00:00:00.123456Z","closed_at":"2026-01-01T00:00:00.123458Z","decision_id":null,"strategy_id":null}',
  ],
  paper_ledger_events: [
    '{"event_id":9007199254740993,"idempotency_key":"archive-order:accepted","order_id":"archive-order","token_id":"archive-token","condition_id":null,"event_type":"order_accepted","event_ts":"2026-01-01T00:00:00.123456Z","payload_json":{"source":"manual","side":"BUY","order_type":"GTC","limit_price":"0.5","size":"2"}}',
    '{"event_id":9007199254740994,"idempotency_key":"archive-order:fill","order_id":"archive-order","token_id":"archive-token","condition_id":null,"event_type":"fill","event_ts":"2026-01-01T00:00:00.123457Z","payload_json":{"side":"BUY","price":"0.4","size":"2","fee":"0.01","book_slice":[{"price":"0.4","size":"2"}]}}',
  ],
  paper_positions: [
    '{"token_id":"archive-token","condition_id":null,"shares":"2","cost_usd":"0.8","fees_paid_usd":"0.01","realized_pnl_usd":"-0.01","opened_at":"2026-01-01T00:00:00.123457Z","resolved_at":null}',
  ],
});

function replace(
  rows: Record<string, string[]>,
  table: string,
  index: number,
  from: string,
  to: string,
): ArchiveReplayRows {
  rows[table]![index] = rows[table]![index]!.replace(from, to);
  return rows;
}

describe("DATA-03 bounded archive replay", () => {
  it("replays raw L2 without rounding bigint identities or microseconds", () => {
    expect(verifyArchiveReplay("raw-l2", raw())).toMatchObject({
      fixtureOnly: true,
      executionAllowed: false,
      historicalCompleteness: "unproven",
      anchorId: "9007199254740993",
      firstDeltaId: "9007199254740994",
      lastDeltaId: "9007199254740995",
      anchorReceivedAt: "2026-01-01T00:00:00.123456+00:00",
      lastReceivedAt: "2026-01-01T00:00:00.123458+00:00",
      bids: [{ price: "0.4", size: "5" }],
      asks: [],
      deltasApplied: 2,
    });
  });

  it("does not call global identity adjacency proof of actual token continuity", () => {
    expect(verifyArchiveReplay("raw-l2", raw())["continuity"]).toBe(
      "synthetic-global-id-adjacency-only; real token continuity unproven",
    );
  });

  it("rejects aggregate-only replacement and missing raw anchor", () => {
    expect(() =>
      verifyArchiveReplay("raw-l2", { polymarket_book_1m: ["{}"] }),
    ).toThrow(/exact source tables/);
    const missing = raw();
    missing["polymarket_book_snapshots_full"] = [];
    expect(() => verifyArchiveReplay("raw-l2", missing)).toThrow(/empty/);
  });

  it("fails synthetic delta gaps and duplicate identities", () => {
    for (const id of ["9007199254740996", "9007199254740994"]) {
      expect(() =>
        verifyArchiveReplay(
          "raw-l2",
          replace(raw(), "polymarket_book_deltas", 1, "9007199254740995", id),
        ),
      ).toThrow(/gap\/duplicate/);
    }
  });

  it("rejects token mismatch, missing full L2 levels, and sub-millisecond disorder", () => {
    expect(() =>
      verifyArchiveReplay(
        "raw-l2",
        replace(raw(), "polymarket_book_deltas", 0, "archive-token", "other"),
      ),
    ).toThrow(/token differs/);
    expect(() =>
      verifyArchiveReplay(
        "raw-l2",
        replace(
          raw(),
          "polymarket_book_snapshots_full",
          0,
          '[{"price":"0.4","size":"3"}]',
          "[]",
        ),
      ),
    ).toThrow(/missing/);
    expect(() =>
      verifyArchiveReplay(
        "raw-l2",
        replace(raw(), "polymarket_book_deltas", 1, ".123458", ".123456"),
      ),
    ).toThrow(/precedes/);
  });

  it("rejects malformed JSON and duplicate object keys", () => {
    for (const row of [
      '{"snapshot_id":01}',
      '{"snapshot_id":1,"snapshot_id":2}',
      '{"x":1,}',
      "[1]",
      '{"x":"unterminated}',
    ]) {
      const invalid = raw();
      invalid["polymarket_book_snapshots_full"] = [row];
      expect(() => verifyArchiveReplay("raw-l2", invalid)).toThrow();
    }
  });

  it("accepts escaped JSON strings without treating digits inside them as numbers", () => {
    const rows = raw();
    for (const table of Object.keys(rows))
      rows[table] = rows[table]!.map((row) =>
        row.replace("archive-token", 'token-\\"9007199254740993\\"'),
      );
    expect(verifyArchiveReplay("raw-l2", rows)["tokenId"]).toBe(
      'token-"9007199254740993"',
    );
  });

  it("rejects invalid calendar dates, timezone ambiguity, and precision truncation", () => {
    for (const bad of [
      "2026-02-30T00:00:00.123456Z",
      "2026-01-01T00:00:00.123456-03:00",
      "2026-01-01T00:00:00.1234567Z",
    ]) {
      expect(() =>
        verifyArchiveReplay(
          "raw-l2",
          replace(
            raw(),
            "polymarket_book_snapshots_full",
            0,
            "2026-01-01T00:00:00.123456+00:00",
            bad,
          ),
        ),
      ).toThrow(/timestamp/);
    }
  });

  it("requires source timestamps covering the same raw sequence", () => {
    expect(() =>
      verifyArchiveReplay(
        "raw-l2",
        replace(
          raw(),
          "polymarket_book_snapshots_full",
          0,
          '"source_ts":"2026-01-01T00:00:00.123455+00:00"',
          '"source_ts":null',
        ),
      ),
    ).toThrow();
    expect(() =>
      verifyArchiveReplay(
        "raw-l2",
        replace(
          raw(),
          "polymarket_book_snapshots_full",
          0,
          ".123455",
          ".123459",
        ),
      ),
    ).toThrow(/source timestamp/);
    expect(() =>
      verifyArchiveReplay(
        "raw-l2",
        replace(
          raw(),
          "polymarket_book_deltas",
          1,
          '"source_ts":"2026-01-01T00:00:00.123457+00:00"',
          '"source_ts":"2026-01-01T00:00:00.123455+00:00"',
        ),
      ),
    ).toThrow(/source timestamp/);
  });

  it("reconciles an independently specified order, its ledger, and position", () => {
    expect(verifyArchiveReplay("paper-ledger", paper())).toMatchObject({
      fixtureOnly: true,
      executionAllowed: false,
      eventIds: ["9007199254740993", "9007199254740994"],
      eventCount: 2,
      fills: 1,
      shares: "2.000000000",
      costUsd: "0.800000000",
      feesPaidUsd: "0.010000000",
      realizedPnlUsd: "-0.010000000",
      openedAt: "2026-01-01T00:00:00.123457Z",
    });
  });

  it("replays independently of archive row ordering", () => {
    const rows = paper();
    rows["paper_ledger_events"]!.reverse();
    expect(verifyArchiveReplay("paper-ledger", rows)).toEqual(
      verifyArchiveReplay("paper-ledger", paper()),
    );
    const books = raw();
    books["polymarket_book_deltas"]!.reverse();
    expect(verifyArchiveReplay("raw-l2", books)).toEqual(
      verifyArchiveReplay("raw-l2", raw()),
    );
  });

  it("rejects missing order references, missing acceptance, and ledger duplicates", () => {
    expect(() =>
      verifyArchiveReplay(
        "paper-ledger",
        replace(
          paper(),
          "paper_ledger_events",
          1,
          '"order_id":"archive-order"',
          '"order_id":"other"',
        ),
      ),
    ).toThrow(/dependency/);
    const missing = paper();
    missing["paper_ledger_events"]!.shift();
    expect(() => verifyArchiveReplay("paper-ledger", missing)).toThrow(
      /missing acceptance/,
    );
    const duplicated = paper();
    duplicated["paper_ledger_events"]!.push(
      duplicated["paper_ledger_events"]![1]!,
    );
    expect(() => verifyArchiveReplay("paper-ledger", duplicated)).toThrow(
      /duplicate ledger/,
    );
  });

  it("rejects orders with unresolved external reference closure", () => {
    expect(() =>
      verifyArchiveReplay(
        "paper-ledger",
        replace(
          paper(),
          "paper_orders",
          0,
          '"decision_id":null',
          '"decision_id":9007199254740993',
        ),
      ),
    ).toThrow(/unsupported dependency/);
    expect(() =>
      verifyArchiveReplay(
        "paper-ledger",
        replace(
          paper(),
          "paper_orders",
          0,
          '"condition_id":null',
          '"condition_id":"condition-1"',
        ),
      ),
    ).toThrow(/unsupported dependency/);
  });

  it("rejects partial ledger, missing raw fill slice, and changed economic state", () => {
    expect(() =>
      verifyArchiveReplay(
        "paper-ledger",
        replace(paper(), "paper_ledger_events", 1, '"size":"2"', '"size":"1"'),
      ),
    ).toThrow(/incomplete/);
    expect(() =>
      verifyArchiveReplay(
        "paper-ledger",
        replace(
          paper(),
          "paper_ledger_events",
          1,
          '"book_slice"',
          '"aggregate_1m"',
        ),
      ),
    ).toThrow(/missing/);
    for (const [from, to] of [
      ['"shares":"2"', '"shares":"3"'],
      ['"cost_usd":"0.8"', '"cost_usd":"0.9"'],
      ['"realized_pnl_usd":"-0.01"', '"realized_pnl_usd":"0"'],
    ]) {
      expect(() =>
        verifyArchiveReplay(
          "paper-ledger",
          replace(paper(), "paper_positions", 0, from!, to!),
        ),
      ).toThrow(/reconciliation/);
    }
  });

  it("rejects unsupported decimals and nonempty closure-less profiles", () => {
    expect(() =>
      verifyArchiveReplay(
        "raw-l2",
        replace(
          raw(),
          "polymarket_book_deltas",
          0,
          '"size":"5"',
          '"size":"5.0000000001"',
        ),
      ),
    ).toThrow(/exact decimal/);
    expect(() =>
      verifyArchiveReplay("paper-ledger", {
        ...paper(),
        portfolio_decisions: ["{}"],
      }),
    ).toThrow(/exact source tables/);
    const empty = paper();
    empty["paper_orders"] = [];
    expect(() => verifyArchiveReplay("paper-ledger", empty)).toThrow(/empty/);
  });

  it("refuses numeric JSON money and aliases that would split an existing price level", () => {
    expect(() =>
      verifyArchiveReplay(
        "raw-l2",
        replace(
          raw(),
          "polymarket_book_deltas",
          0,
          '"price":"0.4"',
          '"price":0.4',
        ),
      ),
    ).toThrow(/string/);
    expect(() =>
      verifyArchiveReplay(
        "raw-l2",
        replace(
          raw(),
          "polymarket_book_deltas",
          0,
          '"price":"0.4"',
          '"price":"0.40"',
        ),
      ),
    ).toThrow(/price encoding/);
    expect(() =>
      verifyArchiveReplay(
        "paper-ledger",
        replace(
          paper(),
          "paper_ledger_events",
          1,
          '"fee":"0.01"',
          '"fee":0.01',
        ),
      ),
    ).toThrow(/string/);
  });
});
