// RFC-007 tasks 6 (15-min OI/volume/holders sampler) and 7 (UMA status
// poller). The Data API only exposes current values, so each sample is an
// append-only row in polymarket_oi_holders; UMA status transitions become
// immutable rows in polymarket_resolution_events. Concentration shares are
// computed in bigint over scaled decimal strings — no floats. Persistence or
// fetch failures never crash the process: log, record a gap when the whole
// cycle failed, and continue.

import type { SqlExecutor } from "../database.js";
import { sourceTsToDate } from "./recorder.js";

export const DATA_API_BASE_URL = "https://data-api.polymarket.com";
export const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";

const USER_AGENT = "GansoMarketRecorder/1.0 (+public-data-recorder)";

// Shares are decimal ratios with 6 fractional digits ("0.500000").
const SHARE_FRACTION_DIGITS = 6;
const SHARE_SCALE = 10n ** BigInt(SHARE_FRACTION_DIGITS);
// Holder amounts are scaled to fixed-point bigints (same idea as book.ts).
const AMOUNT_FRACTION_DIGITS = 9;

type JsonFetcher = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

function logJson(
  level: "error" | "warn",
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

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asDecimalString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

// Exact fixed-point scaling of a non-negative decimal string; null when the
// value is not a plain decimal (scientific notation, negatives, garbage).
function toScaledAmount(value: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return null;
  }
  const [intPart = "0", fracPart = ""] = value.split(".");
  const fraction = (fracPart + "0".repeat(AMOUNT_FRACTION_DIGITS)).slice(
    0,
    AMOUNT_FRACTION_DIGITS,
  );
  return BigInt(intPart + fraction);
}

function formatShare(millionths: bigint): string {
  const intPart = millionths / SHARE_SCALE;
  const fracPart = (millionths % SHARE_SCALE)
    .toString()
    .padStart(SHARE_FRACTION_DIGITS, "0");
  return `${intPart}.${fracPart}`;
}

/**
 * top1/top5 concentration shares over the returned holders, as decimal ratio
 * strings with 6 places, computed entirely in bigint (half-up rounding).
 */
export function computeConcentration(amounts: readonly string[]): {
  top1Share: string | null;
  top5Share: string | null;
} {
  const scaled = amounts
    .map(toScaledAmount)
    .filter((value): value is bigint => value !== null)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const total = scaled.reduce((acc, value) => acc + value, 0n);
  if (scaled.length === 0 || total <= 0n) {
    return { top1Share: null, top5Share: null };
  }
  const share = (part: bigint): string =>
    formatShare((part * SHARE_SCALE * 2n + total) / (total * 2n));
  const top1 = scaled[0] ?? 0n;
  const top5 = scaled.slice(0, 5).reduce((acc, value) => acc + value, 0n);
  return { top1Share: share(top1), top5Share: share(top5) };
}

// Data API response shapes drift; extract a decimal metric tolerantly from a
// bare number/string, an object with one of the candidate keys, or the first
// element of an array of such objects.
function extractMetric(body: unknown, keys: readonly string[]): string | null {
  if (typeof body === "number" || typeof body === "string") {
    return asDecimalString(body);
  }
  if (Array.isArray(body)) {
    return body.length > 0 ? extractMetric(body[0], keys) : null;
  }
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    for (const key of keys) {
      const value = asDecimalString(record[key]);
      if (value !== null) {
        return value;
      }
    }
  }
  return null;
}

interface HolderGroup {
  readonly tokenId: string | null;
  readonly amounts: readonly string[];
  readonly raw: unknown;
}

// /holders returns (today) an array of { token, holders: [{ proxyWallet,
// amount }] } groups; tolerate a bare holders array or an object wrapper too.
function parseHolderGroups(body: unknown): HolderGroup[] {
  const groups: HolderGroup[] = [];
  const parseHolders = (value: unknown): string[] => {
    if (!Array.isArray(value)) {
      return [];
    }
    const amounts: string[] = [];
    for (const item of value) {
      if (typeof item === "object" && item !== null) {
        const amount = asDecimalString(
          (item as Record<string, unknown>).amount ??
            (item as Record<string, unknown>).balance,
        );
        if (amount !== null) {
          amounts.push(amount);
        }
      }
    }
    return amounts;
  };
  const pushGroup = (item: unknown): void => {
    if (typeof item !== "object" || item === null) {
      return;
    }
    const record = item as Record<string, unknown>;
    const holders = parseHolders(record.holders);
    if (holders.length > 0 || asString(record.token) !== null) {
      groups.push({
        tokenId: asString(record.token) ?? asString(record.asset),
        amounts: holders,
        raw: item,
      });
    }
  };
  if (Array.isArray(body)) {
    for (const item of body) {
      pushGroup(item);
    }
  } else if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (Array.isArray(record.holders)) {
      pushGroup(body);
    }
  }
  return groups;
}

export interface UniverseMarket {
  readonly conditionId: string;
  readonly tokenIds: readonly string[];
}

export interface SamplerDeps {
  readonly pool: SqlExecutor;
  readonly fetcher?: JsonFetcher;
  readonly baseUrl?: string;
  readonly clock: () => number;
}

export interface OiHoldersSampler {
  sampleOnce(universe: readonly UniverseMarket[]): Promise<void>;
}

async function insertGap(
  pool: SqlExecutor,
  gapStart: Date,
  gapEnd: Date,
  cause: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO polymarket_data_gaps
         (source, token_id, gap_start, gap_end, cause, details_json)
       VALUES ('data_api',NULL,$1,$2,$3,$4::jsonb)`,
      [gapStart, gapEnd, cause, JSON.stringify(details)],
    );
  } catch (error: unknown) {
    logJson("error", "GAP_PERSIST_FAILED", "polymarket_gap_persist_failed", {
      cause,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

/**
 * 15-minute sampler of open interest (`/oi`), live volume (`/live-volume`)
 * and holders/concentration (`/holders`) per universe market. One row per
 * outcome token when holder data is per-token, else a single market-level
 * row. A failed market is logged and skipped; if the entire cycle fails, a
 * data_api gap row covers the cycle window.
 */
export function createOiHoldersSampler(deps: SamplerDeps): OiHoldersSampler {
  const fetcher: JsonFetcher =
    deps.fetcher ?? (fetch as unknown as JsonFetcher);
  const baseUrl = deps.baseUrl ?? DATA_API_BASE_URL;

  async function fetchJson(path: string): Promise<unknown> {
    const response = await fetcher(`${baseUrl}${path}`, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(
        `data api ${path} returned ${response.status ?? "error"}`,
      );
    }
    return response.json();
  }

  async function tryFetch(path: string, conditionId: string): Promise<unknown> {
    try {
      return await fetchJson(path);
    } catch (error: unknown) {
      logJson(
        "warn",
        "SAMPLER_FETCH_FAILED",
        "polymarket_sampler_fetch_failed",
        {
          condition_id: conditionId,
          path,
          error_name: error instanceof Error ? error.name : "UnknownError",
        },
      );
      return null;
    }
  }

  async function insertSample(row: {
    conditionId: string;
    tokenId: string | null;
    openInterest: string | null;
    liveVolume: string | null;
    holdersCount: number | null;
    top1Share: string | null;
    top5Share: string | null;
    holdersJson: unknown;
  }): Promise<void> {
    await deps.pool.query(
      `INSERT INTO polymarket_oi_holders
         (condition_id, token_id, open_interest, live_volume, holders_count,
          top1_share, top5_share, holders_json, source_ts, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NULL,$9)`,
      [
        row.conditionId,
        row.tokenId,
        row.openInterest,
        row.liveVolume,
        row.holdersCount,
        row.top1Share,
        row.top5Share,
        row.holdersJson === null ? null : JSON.stringify(row.holdersJson),
        new Date(deps.clock()),
      ],
    );
  }

  async function sampleMarket(market: UniverseMarket): Promise<void> {
    const query = `?market=${encodeURIComponent(market.conditionId)}`;
    const oiBody = await tryFetch(`/oi${query}`, market.conditionId);
    const volumeBody = await tryFetch(
      `/live-volume${query}`,
      market.conditionId,
    );
    const holdersBody = await tryFetch(`/holders${query}`, market.conditionId);
    if (oiBody === null && volumeBody === null && holdersBody === null) {
      throw new Error(
        `all data api endpoints failed for ${market.conditionId}`,
      );
    }
    const openInterest = extractMetric(oiBody, [
      "value",
      "oi",
      "openInterest",
      "amount",
    ]);
    const liveVolume = extractMetric(volumeBody, [
      "total",
      "value",
      "volume",
      "amount",
    ]);
    const groups = parseHolderGroups(holdersBody);
    if (groups.length === 0) {
      await insertSample({
        conditionId: market.conditionId,
        tokenId: null,
        openInterest,
        liveVolume,
        holdersCount: null,
        top1Share: null,
        top5Share: null,
        holdersJson: null,
      });
      return;
    }
    for (const group of groups) {
      const { top1Share, top5Share } = computeConcentration(group.amounts);
      await insertSample({
        conditionId: market.conditionId,
        tokenId: group.tokenId,
        openInterest,
        liveVolume,
        holdersCount: group.amounts.length,
        top1Share,
        top5Share,
        holdersJson: group.raw,
      });
    }
  }

  return {
    async sampleOnce(universe: readonly UniverseMarket[]): Promise<void> {
      const startedAtMs = deps.clock();
      let succeeded = 0;
      for (const market of universe) {
        try {
          await sampleMarket(market);
          succeeded += 1;
        } catch (error: unknown) {
          logJson(
            "error",
            "OI_HOLDERS_SAMPLE_FAILED",
            "polymarket_oi_holders_sample_failed",
            {
              condition_id: market.conditionId,
              error_name: error instanceof Error ? error.name : "UnknownError",
            },
          );
        }
      }
      if (universe.length > 0 && succeeded === 0) {
        await insertGap(
          deps.pool,
          new Date(startedAtMs),
          new Date(deps.clock()),
          "oi_holders_sample_failed_all",
          { markets: universe.length },
        );
      }
    },
  };
}

export type ResolutionStatus = "proposed" | "disputed" | "resolved" | "closed";

const RESOLUTION_STATUSES: ReadonlySet<string> = new Set([
  "proposed",
  "disputed",
  "resolved",
  "closed",
]);

/** Map Gamma's umaResolutionStatus/closed fields onto our event types. */
export function normalizeUmaStatus(
  raw: string | null,
  closed: boolean,
): ResolutionStatus | null {
  if (raw !== null) {
    const lower = raw.toLowerCase();
    if (lower.includes("disput") || lower.includes("challeng")) {
      return "disputed";
    }
    if (lower.includes("resolv") || lower.includes("settle")) {
      return "resolved";
    }
    if (lower.includes("propos")) {
      return "proposed";
    }
  }
  return closed ? "closed" : null;
}

export interface UmaStatusPoller {
  pollOnce(conditionIds: readonly string[]): Promise<void>;
}

interface GammaStatusRow {
  readonly conditionId: string;
  readonly rawStatus: string | null;
  readonly closed: boolean;
  readonly resolved: boolean;
}

function parseGammaStatusRow(raw: unknown): GammaStatusRow | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const conditionId =
    asString(record.conditionId) ?? asString(record.condition_id);
  if (conditionId === null) {
    return null;
  }
  let rawStatus = asString(record.umaResolutionStatus);
  if (rawStatus === null && Array.isArray(record.umaResolutionStatuses)) {
    // When Gamma returns the statuses array, the last entry is the current one.
    for (const item of record.umaResolutionStatuses) {
      const value = asString(item);
      if (value !== null) {
        rawStatus = value;
      }
    }
  }
  return {
    conditionId,
    rawStatus,
    closed: record.closed === true,
    resolved: record.resolved === true || record.umaResolved === true,
  };
}

const GAMMA_STATUS_CHUNK = 20;

/**
 * Task 7: poll Gamma for umaResolutionStatus/closed per universe market and
 * turn transitions into immutable polymarket_resolution_events rows with
 * payload {from, to, raw}. State re-hydrates from the database on boot so a
 * restart does not re-emit the current status. Steady state emits nothing.
 */
export function createUmaStatusPoller(deps: SamplerDeps): UmaStatusPoller {
  const fetcher: JsonFetcher =
    deps.fetcher ?? (fetch as unknown as JsonFetcher);
  const baseUrl = deps.baseUrl ?? GAMMA_BASE_URL;
  const lastStatus = new Map<string, ResolutionStatus>();
  let hydrated = false;

  function statusFromEvent(
    eventType: string,
    payload: unknown,
  ): ResolutionStatus | null {
    if (typeof payload === "object" && payload !== null) {
      const to = asString((payload as Record<string, unknown>).to);
      if (to !== null && RESOLUTION_STATUSES.has(to)) {
        return to as ResolutionStatus;
      }
    }
    if (RESOLUTION_STATUSES.has(eventType)) {
      return eventType as ResolutionStatus;
    }
    return eventType === "market_resolved" ? "resolved" : null;
  }

  async function hydrate(): Promise<void> {
    const result = await deps.pool.query<{
      condition_id: string;
      event_type: string;
      payload_json: unknown;
    }>(
      // Only status-bearing events participate: a trailing 'rule_change' (or
      // any other non-status event type) must not shadow the latest status,
      // otherwise a restart would re-emit it as a fresh transition.
      `SELECT DISTINCT ON (condition_id) condition_id, event_type, payload_json
         FROM polymarket_resolution_events
        WHERE event_type IN ('proposed', 'disputed', 'resolved', 'closed', 'market_resolved')
        ORDER BY condition_id, received_at DESC, resolution_event_id DESC`,
    );
    for (const row of result.rows) {
      const status = statusFromEvent(row.event_type, row.payload_json);
      if (status !== null) {
        lastStatus.set(row.condition_id, status);
      }
    }
    hydrated = true;
  }

  async function fetchStatuses(
    conditionIds: readonly string[],
  ): Promise<GammaStatusRow[]> {
    const rows: GammaStatusRow[] = [];
    for (let i = 0; i < conditionIds.length; i += GAMMA_STATUS_CHUNK) {
      const chunk = conditionIds.slice(i, i + GAMMA_STATUS_CHUNK);
      const params = chunk
        .map((id) => `condition_ids=${encodeURIComponent(id)}`)
        .join("&");
      const response = await fetcher(
        `${baseUrl}/markets?limit=${chunk.length}&${params}`,
        { headers: { accept: "application/json", "user-agent": USER_AGENT } },
      );
      if (!response.ok) {
        throw new Error(
          `gamma status poll returned ${response.status ?? "error"}`,
        );
      }
      const body = (await response.json()) as unknown;
      if (Array.isArray(body)) {
        for (const item of body) {
          const parsed = parseGammaStatusRow(item);
          if (parsed !== null) {
            rows.push(parsed);
          }
        }
      }
    }
    return rows;
  }

  return {
    async pollOnce(conditionIds: readonly string[]): Promise<void> {
      if (conditionIds.length === 0) {
        return;
      }
      if (!hydrated) {
        try {
          await hydrate();
        } catch (error: unknown) {
          // Without hydration a restart could duplicate the current status
          // event; skip this cycle and retry hydration on the next one.
          logJson(
            "error",
            "UMA_HYDRATE_FAILED",
            "polymarket_uma_hydrate_failed",
            {
              error_name: error instanceof Error ? error.name : "UnknownError",
            },
          );
          return;
        }
      }
      const startedAtMs = deps.clock();
      let rows: GammaStatusRow[];
      try {
        rows = await fetchStatuses(conditionIds);
      } catch (error: unknown) {
        logJson(
          "error",
          "UMA_STATUS_POLL_FAILED",
          "polymarket_uma_status_poll_failed",
          {
            error_name: error instanceof Error ? error.name : "UnknownError",
          },
        );
        try {
          await deps.pool.query(
            `INSERT INTO polymarket_data_gaps
               (source, token_id, gap_start, gap_end, cause, details_json)
             VALUES ('gamma',NULL,$1,$2,$3,$4::jsonb)`,
            [
              new Date(startedAtMs),
              new Date(deps.clock()),
              "uma_status_poll_failed",
              JSON.stringify({ markets: conditionIds.length }),
            ],
          );
        } catch (gapError: unknown) {
          logJson(
            "error",
            "GAP_PERSIST_FAILED",
            "polymarket_gap_persist_failed",
            {
              cause: "uma_status_poll_failed",
              error_name:
                gapError instanceof Error ? gapError.name : "UnknownError",
            },
          );
        }
        return;
      }
      for (const row of rows) {
        let current = normalizeUmaStatus(row.rawStatus, row.closed);
        if (current === null && row.resolved) {
          current = "resolved";
        }
        const previous = lastStatus.get(row.conditionId) ?? null;
        if (current === null || current === previous) {
          continue;
        }
        try {
          await deps.pool.query(
            `INSERT INTO polymarket_resolution_events
               (condition_id, event_type, payload_json, source_ts, received_at)
             VALUES ($1,$2,$3::jsonb,NULL,$4)`,
            [
              row.conditionId,
              current,
              JSON.stringify({
                from: previous,
                to: current,
                raw: {
                  umaResolutionStatus: row.rawStatus,
                  closed: row.closed,
                  resolved: row.resolved,
                },
              }),
              new Date(deps.clock()),
            ],
          );
          lastStatus.set(row.conditionId, current);
        } catch (error: unknown) {
          // Not updating lastStatus means the transition is retried next poll.
          logJson(
            "error",
            "RESOLUTION_EVENT_PERSIST_FAILED",
            "polymarket_resolution_event_persist_failed",
            {
              condition_id: row.conditionId,
              error_name: error instanceof Error ? error.name : "UnknownError",
            },
          );
        }
      }
    },
  };
}

/**
 * WS `market_resolved` entry point: the orchestrator forwards the event here.
 * Records an immutable market_resolved row; never throws.
 */
export async function recordMarketResolved(
  pool: SqlExecutor,
  conditionId: string,
  payload: unknown,
  clock: () => number = () => Date.now(),
): Promise<void> {
  try {
    let sourceTs: Date | null = null;
    if (typeof payload === "object" && payload !== null) {
      const ts = (payload as Record<string, unknown>).timestamp;
      sourceTs = sourceTsToDate(typeof ts === "string" ? ts : null);
    }
    await pool.query(
      `INSERT INTO polymarket_resolution_events
         (condition_id, event_type, payload_json, source_ts, received_at)
       VALUES ($1,'market_resolved',$2::jsonb,$3,$4)`,
      [conditionId, JSON.stringify(payload ?? {}), sourceTs, new Date(clock())],
    );
  } catch (error: unknown) {
    logJson(
      "error",
      "MARKET_RESOLVED_PERSIST_FAILED",
      "polymarket_market_resolved_persist_failed",
      {
        condition_id: conditionId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      },
    );
  }
}
