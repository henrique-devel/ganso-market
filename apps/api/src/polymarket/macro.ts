import { createHash } from "node:crypto";

import type { SqlExecutor } from "../database.js";

// RFC-007 tasks 9/12: versioned official macro calendar (BLS/BEA/FOMC, UTC)
// and official release values captured at publication time. Source failures
// produce rows in polymarket_data_gaps, never presumed values. Public data
// only; BLS values come from the public v2 timeseries API (no key needed at
// low volume). BEA/FOMC have no stable public value API here: calendar only,
// releases are recorded manually (documented in the runbook).

export const BLS_API_BASE_URL =
  "https://api.bls.gov/publicAPI/v2/timeseries/data";

const RELEASE_OVERDUE_MS = 6 * 60 * 60 * 1_000;
const USER_AGENT = "GansoMarketRecorder/1.0 (+public-data-recorder)";

export type MacroSource = "bls" | "bea" | "fomc";

export interface MacroCalendarEntry {
  readonly source: MacroSource;
  readonly eventKey: string;
  readonly eventName: string;
  readonly scheduledAt: Date;
  /** Raw entry as found in the JSON (series_id, estimated, year, period...). */
  readonly payload: Record<string, unknown>;
}

function logLine(
  level: "info" | "warn" | "error",
  reasonCode: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  process.stderr.write(
    `${JSON.stringify({
      level,
      service: "polymarket-recorder",
      timestamp: new Date().toISOString(),
      reason_code: reasonCode,
      message,
      ...extra,
    })}\n`,
  );
}

function isMacroSource(value: unknown): value is MacroSource {
  return value === "bls" || value === "bea" || value === "fomc";
}

/** Defensive parse of config/macro-calendar.json ({entries: [...]} or bare array). */
export function parseMacroCalendar(json: unknown): MacroCalendarEntry[] {
  const rows = Array.isArray(json)
    ? json
    : typeof json === "object" &&
        json !== null &&
        Array.isArray((json as Record<string, unknown>).entries)
      ? ((json as Record<string, unknown>).entries as unknown[])
      : [];
  const entries: MacroCalendarEntry[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const source = record.source;
    const eventKey = record.event_key;
    const eventName = record.event_name;
    const scheduledAtRaw = record.scheduled_at;
    if (
      !isMacroSource(source) ||
      typeof eventKey !== "string" ||
      eventKey.length === 0 ||
      typeof eventName !== "string" ||
      typeof scheduledAtRaw !== "string"
    ) {
      logLine("warn", "MACRO_CALENDAR_ENTRY_INVALID", "macro_entry_skipped");
      continue;
    }
    const scheduledMs = Date.parse(scheduledAtRaw);
    if (Number.isNaN(scheduledMs)) {
      logLine("warn", "MACRO_CALENDAR_ENTRY_INVALID", "macro_entry_skipped", {
        event_key: eventKey,
      });
      continue;
    }
    entries.push({
      source,
      eventKey,
      eventName,
      scheduledAt: new Date(scheduledMs),
      payload: record,
    });
  }
  return entries;
}

// Deterministic JSON for hashing regardless of key order.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`,
    );
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashCalendarPayload(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/**
 * Version the curated calendar into polymarket_macro_calendar: a new row only
 * when the (source, event_key) pair is new or its payload changed (hash);
 * running twice with the same JSON inserts nothing. Returns rows inserted.
 */
export async function syncCalendar(
  pool: SqlExecutor,
  calendarJson: unknown,
  now: Date,
): Promise<number> {
  const entries = parseMacroCalendar(calendarJson);
  let inserted = 0;
  for (const entry of entries) {
    const hash = hashCalendarPayload(entry.payload);
    const latest = await pool.query<{
      version: number;
      payload_json: unknown;
    }>(
      `SELECT version, payload_json FROM polymarket_macro_calendar
       WHERE source = $1 AND event_key = $2
       ORDER BY version DESC LIMIT 1`,
      [entry.source, entry.eventKey],
    );
    const row = latest.rows[0];
    if (row !== undefined && hashCalendarPayload(row.payload_json) === hash) {
      continue;
    }
    const version = (row?.version ?? 0) + 1;
    await pool.query(
      `INSERT INTO polymarket_macro_calendar
         (source, event_key, event_name, scheduled_at, version, payload_json, source_ts, received_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,NULL,$7)`,
      [
        entry.source,
        entry.eventKey,
        entry.eventName,
        entry.scheduledAt,
        version,
        JSON.stringify(entry.payload),
        now,
      ],
    );
    inserted += 1;
    logLine("info", "MACRO_CALENDAR_VERSIONED", "macro_calendar_versioned", {
      source: entry.source,
      event_key: entry.eventKey,
      version,
    });
  }
  return inserted;
}

type JsonFetcher = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export interface ReleaseCollectorDeps {
  readonly pool: SqlExecutor;
  readonly fetcher?: JsonFetcher;
  readonly clock?: () => Date;
  readonly blsBaseUrl?: string;
}

export interface ReleaseCollector {
  /** One poll pass: fetch due BLS releases, record overdue gaps (once). */
  pollOnce(): Promise<void>;
}

interface PendingReleaseRow extends Record<string, unknown> {
  event_key: string;
  event_name: string;
  scheduled_at: Date | string;
  payload_json: unknown;
}

interface BlsDataPoint {
  readonly value: string;
  readonly point: Record<string, unknown>;
}

// Extract the matching data point from a BLS v2 timeseries response. When the
// calendar entry pins year/period, only that observation is accepted (so a
// stale "latest" before the actual publication is not mistaken for the
// release).
export function extractBlsValue(
  body: unknown,
  expectedYear: string | null,
  expectedPeriod: string | null,
): BlsDataPoint | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const root = body as Record<string, unknown>;
  if (root.status !== "REQUEST_SUCCEEDED") {
    return null;
  }
  const results = root.Results;
  if (typeof results !== "object" || results === null) {
    return null;
  }
  const series = (results as Record<string, unknown>).series;
  if (!Array.isArray(series)) {
    return null;
  }
  for (const oneSeries of series) {
    if (typeof oneSeries !== "object" || oneSeries === null) {
      continue;
    }
    const data = (oneSeries as Record<string, unknown>).data;
    if (!Array.isArray(data)) {
      continue;
    }
    for (const item of data) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const record = item as Record<string, unknown>;
      if (expectedYear !== null && record.year !== expectedYear) {
        continue;
      }
      if (expectedPeriod !== null && record.period !== expectedPeriod) {
        continue;
      }
      const value = record.value;
      if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
        return { value, point: record };
      }
    }
  }
  return null;
}

/**
 * Collects official BLS release values for calendar events whose scheduled_at
 * has passed and that have no row in polymarket_macro_releases yet. HTTP
 * failure or a value not yet published means retry on the next poll; more
 * than 6h past schedule without a value inserts a single 'macro' gap per
 * event. FOMC/BEA events are calendar-only (manual releases) and are not
 * polled here.
 */
export function createReleaseCollector(
  deps: ReleaseCollectorDeps,
): ReleaseCollector {
  const fetcher: JsonFetcher = deps.fetcher ?? fetch;
  const clock = deps.clock ?? ((): Date => new Date());
  const baseUrl = deps.blsBaseUrl ?? BLS_API_BASE_URL;

  async function fetchBls(
    seriesId: string,
    expectedYear: string | null,
    expectedPeriod: string | null,
  ): Promise<BlsDataPoint | null> {
    const url = `${baseUrl}/${encodeURIComponent(seriesId)}?latest=true`;
    try {
      const response = await fetcher(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as unknown;
      return extractBlsValue(body, expectedYear, expectedPeriod);
    } catch (error: unknown) {
      logLine("warn", "MACRO_BLS_FETCH_FAILED", "macro_bls_fetch_failed", {
        error_name: error instanceof Error ? error.name : "UnknownError",
        series_id: seriesId,
      });
      return null;
    }
  }

  async function ensureOverdueGap(
    eventKey: string,
    eventName: string,
    scheduledAt: Date,
  ): Promise<void> {
    const existing = await deps.pool.query(
      `SELECT 1 AS one FROM polymarket_data_gaps
       WHERE source = 'macro' AND cause = 'release_overdue'
         AND details_json->>'event_key' = $1
       LIMIT 1`,
      [eventKey],
    );
    if (existing.rowCount > 0) {
      return;
    }
    await deps.pool.query(
      `INSERT INTO polymarket_data_gaps (source, gap_start, gap_end, cause, details_json)
       VALUES ('macro', $1, NULL, 'release_overdue', $2::jsonb)`,
      [
        scheduledAt,
        JSON.stringify({
          source: "bls",
          event_key: eventKey,
          event_name: eventName,
        }),
      ],
    );
    logLine("warn", "MACRO_RELEASE_OVERDUE", "macro_release_overdue", {
      event_key: eventKey,
      scheduled_at: scheduledAt.toISOString(),
    });
  }

  async function collectOne(row: PendingReleaseRow, now: Date): Promise<void> {
    const payload =
      typeof row.payload_json === "object" && row.payload_json !== null
        ? (row.payload_json as Record<string, unknown>)
        : {};
    const seriesId =
      typeof payload.series_id === "string" ? payload.series_id : null;
    const expectedYear = typeof payload.year === "string" ? payload.year : null;
    const expectedPeriod =
      typeof payload.period === "string" ? payload.period : null;
    const scheduledAt =
      row.scheduled_at instanceof Date
        ? row.scheduled_at
        : new Date(String(row.scheduled_at));

    const found =
      seriesId === null
        ? null
        : await fetchBls(seriesId, expectedYear, expectedPeriod);
    if (found !== null) {
      // published_at is the official schedule instant; BLS payloads carry no
      // publication timestamp, so source_ts stays null.
      const result = await deps.pool.query(
        `INSERT INTO polymarket_macro_releases
           (source, event_key, value, published_at, payload_json, source_ts, received_at)
         VALUES ('bls', $1, $2, $3, $4::jsonb, NULL, $5)
         ON CONFLICT (source, event_key) DO NOTHING`,
        [
          row.event_key,
          found.value,
          scheduledAt,
          JSON.stringify(found.point),
          now,
        ],
      );
      if (result.rowCount > 0) {
        logLine("info", "MACRO_RELEASE_RECORDED", "macro_release_recorded", {
          event_key: row.event_key,
          value: found.value,
        });
      }
      return;
    }
    if (now.getTime() - scheduledAt.getTime() >= RELEASE_OVERDUE_MS) {
      await ensureOverdueGap(row.event_key, row.event_name, scheduledAt);
    }
  }

  return {
    async pollOnce(): Promise<void> {
      const now = clock();
      let pending: readonly PendingReleaseRow[];
      try {
        const result = await deps.pool.query<PendingReleaseRow>(
          `SELECT DISTINCT ON (c.event_key)
             c.event_key, c.event_name, c.scheduled_at, c.payload_json
           FROM polymarket_macro_calendar c
           LEFT JOIN polymarket_macro_releases r
             ON r.source = c.source AND r.event_key = c.event_key
           WHERE c.source = 'bls' AND c.scheduled_at <= $1
             AND r.macro_release_id IS NULL
           ORDER BY c.event_key, c.version DESC`,
          [now],
        );
        pending = result.rows;
      } catch (error: unknown) {
        logLine("error", "MACRO_POLL_FAILED", "macro_poll_failed", {
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
        return;
      }
      for (const row of pending) {
        try {
          await collectOne(row, now);
        } catch (error: unknown) {
          // One bad event must not stop the rest of the pass (or the process).
          logLine("error", "MACRO_RELEASE_FAILED", "macro_release_failed", {
            error_name: error instanceof Error ? error.name : "UnknownError",
            event_key: row.event_key,
          });
        }
      }
    },
  };
}
