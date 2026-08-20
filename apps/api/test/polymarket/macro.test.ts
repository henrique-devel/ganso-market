import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { QueryResult, SqlExecutor } from "../../src/database.js";
import {
  createReleaseCollector,
  extractBlsValue,
  parseMacroCalendar,
  syncCalendar,
} from "../../src/polymarket/macro.js";

const realCalendarJson = JSON.parse(
  readFileSync(
    new URL("../../../../config/macro-calendar.json", import.meta.url),
    "utf8",
  ),
) as unknown;

interface CalendarRow {
  source: string;
  event_key: string;
  event_name: string;
  scheduled_at: Date;
  version: number;
  payload_json: unknown;
}

interface ReleaseRow {
  source: string;
  event_key: string;
  value: string;
  published_at: Date;
  payload_json: unknown;
}

interface GapRow {
  gap_start: Date;
  cause: string;
  details: Record<string, unknown>;
}

// In-memory stand-in for the pieces of Postgres the macro module touches,
// routed by SQL shape (same fake-store pattern as recorder.test.ts).
class FakeMacroDb implements SqlExecutor {
  public readonly calendar: CalendarRow[] = [];
  public readonly releases: ReleaseRow[] = [];
  public readonly gaps: GapRow[] = [];

  public query<R extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    const values = [...(params ?? [])];
    if (text.includes("DISTINCT ON")) {
      const now = values[0] as Date;
      const latestByKey = new Map<string, CalendarRow>();
      for (const row of this.calendar) {
        if (
          row.source !== "bls" ||
          row.scheduled_at.getTime() > now.getTime()
        ) {
          continue;
        }
        const existing = latestByKey.get(row.event_key);
        if (existing === undefined || row.version > existing.version) {
          latestByKey.set(row.event_key, row);
        }
      }
      const rows = [...latestByKey.values()]
        .filter(
          (row) =>
            !this.releases.some(
              (release) =>
                release.source === row.source &&
                release.event_key === row.event_key,
            ),
        )
        .map((row) => ({
          event_key: row.event_key,
          event_name: row.event_name,
          scheduled_at: row.scheduled_at,
          payload_json: row.payload_json,
        }));
      return Promise.resolve({
        rows: rows as unknown as R[],
        rowCount: rows.length,
      });
    }
    if (
      text.includes("FROM polymarket_macro_calendar") &&
      text.includes("ORDER BY version DESC LIMIT 1")
    ) {
      const [source, eventKey] = values as [string, string];
      const matches = this.calendar
        .filter((row) => row.source === source && row.event_key === eventKey)
        .sort((left, right) => right.version - left.version);
      const rows = matches.slice(0, 1).map((row) => ({
        version: row.version,
        payload_json: row.payload_json,
      }));
      return Promise.resolve({
        rows: rows as unknown as R[],
        rowCount: rows.length,
      });
    }
    if (text.includes("INSERT INTO polymarket_macro_calendar")) {
      this.calendar.push({
        source: values[0] as string,
        event_key: values[1] as string,
        event_name: values[2] as string,
        scheduled_at: values[3] as Date,
        version: values[4] as number,
        payload_json: JSON.parse(values[5] as string) as unknown,
      });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (text.includes("INSERT INTO polymarket_macro_releases")) {
      const eventKey = values[0] as string;
      const exists = this.releases.some(
        (row) => row.source === "bls" && row.event_key === eventKey,
      );
      if (exists) {
        // ON CONFLICT (source, event_key) DO NOTHING
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      this.releases.push({
        source: "bls",
        event_key: eventKey,
        value: values[1] as string,
        published_at: values[2] as Date,
        payload_json: JSON.parse(values[3] as string) as unknown,
      });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (text.includes("FROM polymarket_data_gaps")) {
      const eventKey = values[0] as string;
      const found = this.gaps.some(
        (gap) =>
          gap.cause === "release_overdue" && gap.details.event_key === eventKey,
      );
      return Promise.resolve({
        rows: (found ? [{ one: 1 }] : []) as unknown as R[],
        rowCount: found ? 1 : 0,
      });
    }
    if (text.includes("INSERT INTO polymarket_data_gaps")) {
      this.gaps.push({
        gap_start: values[0] as Date,
        cause: "release_overdue",
        details: JSON.parse(values[1] as string) as Record<string, unknown>,
      });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    return Promise.reject(new Error(`unexpected query: ${text}`));
  }
}

const NOW = new Date("2026-08-19T12:00:00Z");

const CPI_ENTRY = {
  source: "bls",
  event_key: "cpi-2026-09",
  event_name: "CPI (August 2026 data)",
  scheduled_at: "2026-09-11T12:30:00Z",
  series_id: "CUSR0000SA0",
  year: "2026",
  period: "M08",
};

function blsBody(value: string): unknown {
  return {
    status: "REQUEST_SUCCEEDED",
    Results: {
      series: [
        {
          seriesID: "CUSR0000SA0",
          data: [{ year: "2026", period: "M08", periodName: "August", value }],
        },
      ],
    },
  };
}

describe("macro calendar sync", () => {
  it("is idempotent: same JSON twice inserts one version per entry", async () => {
    const db = new FakeMacroDb();
    const json = { entries: [CPI_ENTRY] };
    expect(await syncCalendar(db, json, NOW)).toBe(1);
    expect(await syncCalendar(db, json, NOW)).toBe(0);
    expect(db.calendar).toHaveLength(1);
    expect(db.calendar[0]?.version).toBe(1);
    expect(db.calendar[0]?.scheduled_at.toISOString()).toBe(
      "2026-09-11T12:30:00.000Z",
    );
  });

  it("a payload change inserts a new version, unchanged entries do not", async () => {
    const db = new FakeMacroDb();
    await syncCalendar(db, { entries: [CPI_ENTRY] }, NOW);
    const moved = { ...CPI_ENTRY, scheduled_at: "2026-09-12T12:30:00Z" };
    expect(await syncCalendar(db, { entries: [moved] }, NOW)).toBe(1);
    expect(db.calendar).toHaveLength(2);
    expect(db.calendar[1]?.version).toBe(2);
    // Re-sync of the changed payload is again a no-op.
    expect(await syncCalendar(db, { entries: [moved] }, NOW)).toBe(0);
  });

  it("parses the real curated config file (all entries valid)", () => {
    const entries = parseMacroCalendar(realCalendarJson);
    expect(entries.length).toBeGreaterThanOrEqual(10);
    for (const entry of entries) {
      expect(["bls", "bea", "fomc"]).toContain(entry.source);
      expect(Number.isNaN(entry.scheduledAt.getTime())).toBe(false);
    }
    // Every BLS entry must be fetchable: series_id plus year/period pin.
    for (const entry of entries.filter((item) => item.source === "bls")) {
      expect(typeof entry.payload.series_id).toBe("string");
      expect(typeof entry.payload.year).toBe("string");
      expect(typeof entry.payload.period).toBe("string");
    }
  });
});

describe("bls release collector", () => {
  async function seededDb(): Promise<FakeMacroDb> {
    const db = new FakeMacroDb();
    await syncCalendar(db, { entries: [CPI_ENTRY] }, NOW);
    return db;
  }

  it("records a due release exactly once (second poll does not duplicate)", async () => {
    const db = await seededDb();
    const urls: string[] = [];
    const collector = createReleaseCollector({
      pool: db,
      clock: () => new Date("2026-09-11T13:00:00Z"),
      fetcher: (url) => {
        urls.push(url);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(blsBody("321.5")),
        });
      },
    });

    await collector.pollOnce();
    await collector.pollOnce();

    expect(db.releases).toHaveLength(1);
    expect(db.releases[0]?.event_key).toBe("cpi-2026-09");
    expect(db.releases[0]?.value).toBe("321.5");
    expect(db.releases[0]?.published_at.toISOString()).toBe(
      "2026-09-11T12:30:00.000Z",
    );
    // Only the first poll fetched; the second found nothing pending.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("CUSR0000SA0");
    expect(urls[0]).toContain("latest=true");
    expect(db.gaps).toHaveLength(0);
  });

  it("does not record before schedule and retries without a gap within 6h", async () => {
    const db = await seededDb();
    let fetches = 0;
    const failingFetcher = (): Promise<{
      ok: boolean;
      json: () => Promise<unknown>;
    }> => {
      fetches += 1;
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    };

    const before = createReleaseCollector({
      pool: db,
      clock: () => new Date("2026-09-11T12:00:00Z"),
      fetcher: failingFetcher,
    });
    await before.pollOnce();
    expect(fetches).toBe(0);

    const within = createReleaseCollector({
      pool: db,
      clock: () => new Date("2026-09-11T14:00:00Z"),
      fetcher: failingFetcher,
    });
    await within.pollOnce();
    expect(fetches).toBe(1);
    expect(db.releases).toHaveLength(0);
    expect(db.gaps).toHaveLength(0);
  });

  it("emits the overdue gap exactly once after 6h without a value", async () => {
    const db = await seededDb();
    const collector = createReleaseCollector({
      pool: db,
      clock: () => new Date("2026-09-11T19:30:00Z"),
      fetcher: () => Promise.reject(new Error("bls down")),
    });

    await collector.pollOnce();
    await collector.pollOnce();

    expect(db.releases).toHaveLength(0);
    expect(db.gaps).toHaveLength(1);
    expect(db.gaps[0]?.cause).toBe("release_overdue");
    expect(db.gaps[0]?.details.event_key).toBe("cpi-2026-09");
    expect(db.gaps[0]?.gap_start.toISOString()).toBe(
      "2026-09-11T12:30:00.000Z",
    );
  });

  it("ignores a stale latest observation when year/period do not match", () => {
    const stale = {
      status: "REQUEST_SUCCEEDED",
      Results: {
        series: [
          {
            data: [{ year: "2026", period: "M07", value: "320.0" }],
          },
        ],
      },
    };
    expect(extractBlsValue(stale, "2026", "M08")).toBeNull();
    expect(extractBlsValue(blsBody("321.5"), "2026", "M08")?.value).toBe(
      "321.5",
    );
  });
});
