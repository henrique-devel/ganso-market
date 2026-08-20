import { describe, expect, it } from "vitest";

import type { QueryResult } from "../../src/database.js";
import { bookAt, deltasPage } from "../../src/polymarket/replay.js";

interface CapturedQuery {
  readonly text: string;
  readonly params: unknown[];
}

type Responder = (
  text: string,
  params: readonly unknown[],
) => { rows: Record<string, unknown>[]; rowCount: number } | null;

function fakePool(responder: Responder): {
  captured: CapturedQuery[];
  query: <R extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ) => Promise<QueryResult<R>>;
} {
  const captured: CapturedQuery[] = [];
  return {
    captured,
    query<R extends Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      captured.push({ text, params: [...(params ?? [])] });
      const canned = responder(text, params ?? []);
      return Promise.resolve(
        (canned as QueryResult<R> | null) ?? { rows: [], rowCount: 0 },
      );
    },
  };
}

const ANCHOR_AT = new Date("2026-08-19T10:00:00Z");
const AT = new Date("2026-08-19T10:05:00Z");

describe("bookAt", () => {
  it("reconstructs the book from the anchor plus deltas (duplicates and size 0)", async () => {
    const pool = fakePool((text) => {
      if (text.includes("polymarket_book_snapshots_full")) {
        return {
          rows: [
            {
              snapshot_id: 1,
              bids_json: [
                { price: "0.40", size: "10" },
                { price: "0.39", size: "5" },
              ],
              asks_json: [{ price: "0.60", size: "7" }],
              received_at: ANCHOR_AT,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("polymarket_book_deltas")) {
        return {
          rows: [
            { delta_id: 1, side: "BUY", price: "0.41", size: "3" },
            // Exact duplicate: sizes are absolute, so replay is idempotent.
            { delta_id: 2, side: "BUY", price: "0.41", size: "3" },
            // size 0 removes the level.
            { delta_id: 3, side: "SELL", price: "0.60", size: "0" },
            { delta_id: 4, side: "SELL", price: "0.61", size: "2" },
          ],
          rowCount: 4,
        };
      }
      return null;
    });

    const replayed = await bookAt(pool, "token-1", AT);
    expect(replayed).not.toBeNull();
    expect(replayed?.bids).toEqual([
      { price: "0.41", size: "3" },
      { price: "0.40", size: "10" },
      { price: "0.39", size: "5" },
    ]);
    expect(replayed?.asks).toEqual([{ price: "0.61", size: "2" }]);
    expect(replayed?.anchorReceivedAt).toBe(ANCHOR_AT.toISOString());
    expect(replayed?.deltasApplied).toBe(4);

    // Anchor: latest snapshot with received_at <= at.
    const anchorQuery = pool.captured[0];
    expect(anchorQuery?.text).toContain("received_at <= $2");
    expect(anchorQuery?.text).toContain("ORDER BY received_at DESC");
    expect(anchorQuery?.params).toEqual(["token-1", AT]);
    // Deltas: (anchor.received_at, at], ordered by delta_id.
    const deltaQuery = pool.captured[1];
    expect(deltaQuery?.text).toContain(
      "received_at > $2 AND received_at <= $3",
    );
    expect(deltaQuery?.text).toContain("ORDER BY delta_id ASC");
    expect(deltaQuery?.params).toEqual(["token-1", ANCHOR_AT, AT]);
  });

  it("accepts jsonb columns delivered as JSON strings and honors depth", async () => {
    const pool = fakePool((text) => {
      if (text.includes("polymarket_book_snapshots_full")) {
        return {
          rows: [
            {
              snapshot_id: 2,
              bids_json: JSON.stringify([
                { price: "0.30", size: "1" },
                { price: "0.31", size: "2" },
              ]),
              asks_json: JSON.stringify([]),
              received_at: ANCHOR_AT.toISOString(),
            },
          ],
          rowCount: 1,
        };
      }
      return null;
    });

    const replayed = await bookAt(pool, "token-1", AT, 1);
    expect(replayed?.bids).toEqual([{ price: "0.31", size: "2" }]);
    expect(replayed?.asks).toEqual([]);
    expect(replayed?.deltasApplied).toBe(0);
    expect(replayed?.anchorReceivedAt).toBe(ANCHOR_AT.toISOString());
  });

  it("applies a delta received exactly at the instant (at is INCLUSIVE)", async () => {
    // A single delta stamped exactly `at`; the responder emulates the SQL
    // predicate, so flipping the query to `received_at < $3` fails this test.
    const deltaRows = [
      { delta_id: 1, side: "BUY", price: "0.50", size: "4", received_at: AT },
    ];
    const pool = fakePool((text, params) => {
      if (text.includes("polymarket_book_snapshots_full")) {
        return {
          rows: [
            {
              snapshot_id: 1,
              bids_json: [],
              asks_json: [],
              received_at: ANCHOR_AT,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("polymarket_book_deltas")) {
        const lower = params[1] as Date;
        const upper = params[2] as Date;
        const inclusiveUpper = text.includes("received_at <= $3");
        const rows = deltaRows.filter((row) => {
          const ts = row.received_at.getTime();
          return (
            ts > lower.getTime() &&
            (inclusiveUpper ? ts <= upper.getTime() : ts < upper.getTime())
          );
        });
        return { rows, rowCount: rows.length };
      }
      return null;
    });

    const replayed = await bookAt(pool, "token-1", AT);
    expect(pool.captured[1]?.text).toContain(
      "received_at > $2 AND received_at <= $3",
    );
    expect(replayed?.bids).toEqual([{ price: "0.50", size: "4" }]);
    expect(replayed?.deltasApplied).toBe(1);
  });

  it("returns null when no anchor snapshot covers the instant", async () => {
    const pool = fakePool(() => null);
    const replayed = await bookAt(pool, "token-1", AT);
    expect(replayed).toBeNull();
    // Only the anchor query ran; no delta scan without an anchor.
    expect(pool.captured).toHaveLength(1);
  });
});

describe("deltasPage", () => {
  const FROM = new Date("2026-08-19T00:00:00Z");
  const TO = new Date("2026-08-19T23:59:59Z");

  it("returns a full page with a cursor for the next page", async () => {
    const pool = fakePool(() => ({
      rows: [
        {
          delta_id: "11",
          token_id: "token-1",
          side: "BUY",
          price: "0.41",
          size: "3",
          source_ts: new Date("2026-08-19T10:00:01Z"),
          received_at: new Date("2026-08-19T10:00:02Z"),
          ingest_lag_ms: 1000,
        },
        {
          delta_id: "12",
          token_id: "token-1",
          side: "SELL",
          price: "0.60",
          size: "0",
          source_ts: null,
          received_at: new Date("2026-08-19T10:00:03Z"),
          ingest_lag_ms: null,
        },
      ],
      rowCount: 2,
    }));

    const page = await deltasPage(pool, "token-1", FROM, TO, undefined, 2);
    expect(page.deltas).toHaveLength(2);
    expect(page.deltas[0]).toEqual({
      deltaId: 11,
      tokenId: "token-1",
      side: "BUY",
      price: "0.41",
      size: "3",
      sourceTs: "2026-08-19T10:00:01.000Z",
      receivedAt: "2026-08-19T10:00:02.000Z",
      ingestLagMs: 1000,
    });
    expect(page.deltas[1]?.sourceTs).toBeNull();
    expect(page.deltas[1]?.ingestLagMs).toBeNull();
    // Page filled to the limit: cursor points past the last delta_id.
    expect(page.nextAfterId).toBe(12);

    const query = pool.captured[0];
    expect(query?.text).toContain("ORDER BY delta_id ASC");
    expect(query?.text).toContain("delta_id > $4");
    expect(query?.params).toEqual(["token-1", FROM, TO, 0, 2]);
  });

  it("passes afterId through and ends pagination on a short page", async () => {
    const pool = fakePool(() => ({
      rows: [
        {
          delta_id: 13,
          token_id: "token-1",
          side: "BUY",
          price: "0.42",
          size: "1",
          source_ts: null,
          received_at: new Date("2026-08-19T10:00:04Z"),
          ingest_lag_ms: null,
        },
      ],
      rowCount: 1,
    }));

    const page = await deltasPage(pool, "token-1", FROM, TO, 12, 1000);
    expect(pool.captured[0]?.params).toEqual(["token-1", FROM, TO, 12, 1000]);
    expect(page.deltas).toHaveLength(1);
    expect(page.nextAfterId).toBeNull();
  });
});
