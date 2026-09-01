// RFC-015: typed clients for GET /polymarket/overview, GET /polymarket/events
// and GET /polymarket/paper/performance.
//
// Same contract as the RFC-012/013 clients: every validator degrades
// gracefully. Missing or malformed fields become null, rows without a usable
// key are dropped, and nothing throws on garbage input — a panel that crashes
// on one bad field tells the operator less than a panel with one "—" in it.

import { authorizedGet } from "./resolution";
import type { ResolutionFetcher, ResolutionGetResult } from "./resolution";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface PortfolioSummary {
  readonly state: string | null;
  readonly reason: string | null;
  readonly bankroll_usd: number | null;
  readonly high_water_mark_usd: number | null;
  readonly equity_usd: number | null;
  readonly drawdown: number | null;
  readonly realized_pnl_day_usd: number | null;
  readonly realized_pnl_week_usd: number | null;
  readonly manual_halt: boolean;
  readonly halted_at: string | null;
  readonly reduce_only_until: string | null;
  readonly config_version: string | null;
  readonly updated_at: string | null;
}

export interface KillSwitchSummary {
  readonly engaged: boolean;
  readonly reason: string | null;
  readonly engaged_at: string | null;
  readonly rearmed_at: string | null;
  readonly frozen_count: number | null;
}

export interface GateRow {
  readonly gate: string;
  readonly status: string | null;
  readonly reason_code: string | null;
  readonly measured_at: string | null;
}

export interface Overview {
  readonly generated_at: string | null;
  readonly release_sha: string | null;
  readonly portfolio: PortfolioSummary | null;
  readonly circuit_breakers: {
    readonly open: number;
    readonly opened_last_hour: number;
    readonly most_recent_at: string | null;
  };
  readonly kill_switch: KillSwitchSummary | null;
  readonly rfc_009_status: string | null;
  readonly gates: readonly GateRow[];
  readonly collection: {
    readonly last_book_delta_at: string | null;
    readonly last_book_delta_age_ms: number | null;
    readonly open_gaps: number;
    readonly gaps_24h: number;
    readonly universe_members: number;
  };
  readonly model: {
    readonly estimates_last_hour: number;
    readonly last_estimate_at: string | null;
    readonly active_models: number;
    readonly shadow_models: number;
  };
  readonly resolution: {
    readonly markets: number;
    readonly blocked: number;
    readonly buffered: number;
    readonly open_violations: number;
    readonly open_divergences: number;
  };
  readonly paper: {
    readonly open_orders: number;
    readonly positions: number;
    readonly fills_24h: number;
  };
  readonly storage: {
    readonly budget_bytes: number;
    readonly live_bytes: number;
    readonly physical_bytes: number;
    readonly bloat_bytes: number;
    readonly budget_used_pct: number | null;
  };
  readonly drawdown_limit: number;
}

export interface FeedEvent {
  readonly source: string;
  readonly kind: string;
  readonly event_id: number;
  readonly occurred_at: string | null;
  readonly severity: "info" | "warn" | "alert";
  readonly summary: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface EventPage {
  readonly events: readonly FeedEvent[];
  readonly nextCursor: string | null;
}

/** The three-column report; `null` in the unrealised leg is meaningful. */
export interface Performance {
  /** Ledger replayed with the fills degradation denied. Diagnostic ONLY. */
  readonly optimistic_realized_usd: number | null;
  readonly base_realized_usd: number | null;
  /** `null` when any open position has no executable mark — never zero. */
  readonly base_unrealized_usd: number | null;
  readonly base_net_usd: number | null;
  readonly stress_realized_usd: number | null;
  readonly fees_paid_usd: number | null;
  readonly note: string | null;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumeric(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asCount(value: unknown): number {
  return asNumeric(value) ?? 0;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parsePortfolio(raw: unknown): PortfolioSummary | null {
  if (!isRecord(raw)) {
    return null;
  }
  return {
    state: asString(raw["state"]),
    reason: asString(raw["reason"]),
    bankroll_usd: asNumeric(raw["bankroll_usd"]),
    high_water_mark_usd: asNumeric(raw["high_water_mark_usd"]),
    equity_usd: asNumeric(raw["equity_usd"]),
    drawdown: asNumeric(raw["drawdown"]),
    realized_pnl_day_usd: asNumeric(raw["realized_pnl_day_usd"]),
    realized_pnl_week_usd: asNumeric(raw["realized_pnl_week_usd"]),
    manual_halt: raw["manual_halt"] === true,
    halted_at: asString(raw["halted_at"]),
    reduce_only_until: asString(raw["reduce_only_until"]),
    config_version: asString(raw["config_version"]),
    updated_at: asString(raw["updated_at"]),
  };
}

function parseKillSwitch(raw: unknown): KillSwitchSummary | null {
  if (!isRecord(raw)) {
    return null;
  }
  return {
    engaged: raw["engaged"] === true,
    reason: asString(raw["reason"]),
    engaged_at: asString(raw["engaged_at"]),
    rearmed_at: asString(raw["rearmed_at"]),
    frozen_count: asNumeric(raw["frozen_count"]),
  };
}

function parseOverview(body: unknown): Overview | null {
  if (!isRecord(body)) {
    return null;
  }
  const breakers = record(body["circuit_breakers"]);
  const collection = record(body["collection"]);
  const model = record(body["model"]);
  const resolution = record(body["resolution"]);
  const paper = record(body["paper"]);
  const storage = record(body["storage"]);
  const limits = record(body["limits"]);
  const gatesRaw = body["gates"];
  return {
    generated_at: asString(body["generated_at"]),
    release_sha: asString(body["release_sha"]),
    portfolio: parsePortfolio(body["portfolio"]),
    circuit_breakers: {
      open: asCount(breakers["open"]),
      opened_last_hour: asCount(breakers["opened_last_hour"]),
      most_recent_at: asString(breakers["most_recent_at"]),
    },
    kill_switch: parseKillSwitch(body["kill_switch"]),
    rfc_009_status: asString(body["rfc_009_status"]),
    gates: Array.isArray(gatesRaw)
      ? gatesRaw.flatMap((row): GateRow[] => {
          if (!isRecord(row)) {
            return [];
          }
          const gate = asString(row["gate"]);
          return gate === null
            ? []
            : [
                {
                  gate,
                  status: asString(row["status"]),
                  reason_code: asString(row["reason_code"]),
                  measured_at: asString(row["measured_at"]),
                },
              ];
        })
      : [],
    collection: {
      last_book_delta_at: asString(collection["last_book_delta_at"]),
      last_book_delta_age_ms: asNumeric(collection["last_book_delta_age_ms"]),
      open_gaps: asCount(collection["open_gaps"]),
      gaps_24h: asCount(collection["gaps_24h"]),
      universe_members: asCount(collection["universe_members"]),
    },
    model: {
      estimates_last_hour: asCount(model["estimates_last_hour"]),
      last_estimate_at: asString(model["last_estimate_at"]),
      active_models: asCount(model["active_models"]),
      shadow_models: asCount(model["shadow_models"]),
    },
    resolution: {
      markets: asCount(resolution["markets"]),
      blocked: asCount(resolution["blocked"]),
      buffered: asCount(resolution["buffered"]),
      open_violations: asCount(resolution["open_violations"]),
      open_divergences: asCount(resolution["open_divergences"]),
    },
    paper: {
      open_orders: asCount(paper["open_orders"]),
      positions: asCount(paper["positions"]),
      fills_24h: asCount(paper["fills_24h"]),
    },
    storage: {
      budget_bytes: asCount(storage["budget_bytes"]),
      live_bytes: asCount(storage["live_bytes"]),
      physical_bytes: asCount(storage["physical_bytes"]),
      bloat_bytes: asCount(storage["bloat_bytes"]),
      budget_used_pct: asNumeric(storage["budget_used_pct"]),
    },
    // 10% is the RFC-013 halt threshold; the server publishes it so the bar's
    // end and the engine's trigger can never drift apart.
    drawdown_limit: asNumeric(limits["drawdown_limit"]) ?? 0.1,
  };
}

export function fetchOverview(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<Overview>> {
  return authorizedGet(
    "/api/polymarket/overview",
    accessToken,
    parseOverview,
    fetcher,
    signal,
  );
}

function parseEvents(body: unknown): EventPage | null {
  if (!isRecord(body)) {
    return null;
  }
  const raw = body["events"];
  const page = record(body["page"]);
  return {
    events: Array.isArray(raw)
      ? raw.flatMap((row): FeedEvent[] => {
          if (!isRecord(row)) {
            return [];
          }
          const source = asString(row["source"]);
          const eventId = asNumeric(row["event_id"]);
          if (source === null || eventId === null) {
            return [];
          }
          const severity = row["severity"];
          return [
            {
              source,
              kind: asString(row["kind"]) ?? source,
              event_id: eventId,
              occurred_at: asString(row["occurred_at"]),
              severity:
                severity === "alert" || severity === "warn" ? severity : "info",
              summary: asString(row["summary"]) ?? "—",
              detail: record(row["detail"]),
            },
          ];
        })
      : [],
    nextCursor: asString(page["next_cursor"]),
  };
}

export function fetchEvents(
  accessToken: string,
  after: string | null,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<EventPage>> {
  const query =
    after === null || after === "" ? "" : `?after=${encodeURIComponent(after)}`;
  return authorizedGet(
    `/api/polymarket/events${query}`,
    accessToken,
    parseEvents,
    fetcher,
    signal,
  );
}

function parsePerformance(body: unknown): Performance | null {
  if (!isRecord(body)) {
    return null;
  }
  const columns = record(body["columns"]);
  return {
    optimistic_realized_usd: asNumeric(columns["optimistic_realized_usd"]),
    base_realized_usd: asNumeric(columns["base_realized_usd"]),
    base_unrealized_usd: asNumeric(columns["base_unrealized_usd"]),
    base_net_usd: asNumeric(columns["base_net_usd"]),
    stress_realized_usd: asNumeric(columns["stress_realized_usd"]),
    fees_paid_usd: asNumeric(body["fees_paid_usd"]),
    note: asString(columns["note"]),
  };
}

export function fetchPerformance(
  accessToken: string,
  fetcher: ResolutionFetcher = fetch,
  signal?: AbortSignal,
): Promise<ResolutionGetResult<Performance>> {
  return authorizedGet(
    "/api/polymarket/paper/performance",
    accessToken,
    parsePerformance,
    fetcher,
    signal,
  );
}
