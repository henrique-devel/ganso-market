import type {
  DatabasePool,
  QueryResult,
  SqlExecutor,
} from "../../../src/database.js";

// In-memory stand-in for the RFC-007 registry/versioning tables. Dispatches
// on SQL text the modules emit and mimics PostgreSQL semantics closely enough
// for unit tests (jsonb params are parsed back to objects, as pg would).
export type Row = Record<string, unknown>;

function asDate(value: unknown): Date {
  if (!(value instanceof Date)) {
    throw new Error("expected a Date parameter");
  }
  return value;
}

function parseJsonParam(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return JSON.parse(value) as unknown;
  }
  return value;
}

export class FakeDb implements DatabasePool {
  public readonly ruleVersions: Row[] = [];
  public readonly paramVersions: Row[] = [];
  public readonly resolutionEvents: Row[] = [];
  public readonly universeLog: Row[] = [];
  public readonly markets: Row[] = [];
  public readonly events: Row[] = [];
  public readonly eventMarkets: Row[] = [];
  public readonly dataGaps: Row[] = [];
  /** When set, every query rejects (persistence-failure scenarios). */
  public failNextQueries = false;

  public query<R extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    if (this.failNextQueries) {
      return Promise.reject(new Error("simulated database failure"));
    }
    const rows = this.dispatch(text, [...(params ?? [])]);
    return Promise.resolve({
      rows: rows as unknown as R[],
      rowCount: rows.length,
    });
  }

  public transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return run(this);
  }

  public end(): Promise<void> {
    return Promise.resolve();
  }

  private dispatch(text: string, params: unknown[]): Row[] {
    if (text.includes("INSERT INTO polymarket_rule_versions")) {
      this.ruleVersions.push({
        condition_id: params[0],
        version: params[1],
        content_hash: params[2],
        description: params[3],
        resolution_source: params[4],
        resolved_by: params[5],
        end_date: params[6],
        uma_end_date: params[7],
        uma_bond: params[8],
        uma_reward: params[9],
        custom_liveness: params[10],
        automatically_resolved: params[11],
        valid_from: params[12],
        valid_to: null,
        source_ts: params[13],
        received_at: params[14],
      });
      return [];
    }
    if (text.includes("UPDATE polymarket_rule_versions")) {
      for (const row of this.ruleVersions) {
        if (row.condition_id === params[0] && row.valid_to === null) {
          row.valid_to = params[1];
        }
      }
      return [];
    }
    if (text.includes("FROM polymarket_rule_versions")) {
      return this.selectVersion(this.ruleVersions, text, params);
    }
    if (text.includes("INSERT INTO polymarket_param_versions")) {
      this.paramVersions.push({
        condition_id: params[0],
        version: params[1],
        content_hash: params[2],
        fee_base_bps: params[3],
        maker_fee_bps: params[4],
        taker_fee_bps: params[5],
        fee_curve_json: parseJsonParam(params[6]),
        tick_size: params[7],
        min_order_size: params[8],
        neg_risk: params[9],
        valid_from: params[10],
        valid_to: null,
        source_ts: params[11],
        received_at: params[12],
      });
      return [];
    }
    if (text.includes("UPDATE polymarket_param_versions")) {
      for (const row of this.paramVersions) {
        if (row.condition_id === params[0] && row.valid_to === null) {
          row.valid_to = params[1];
        }
      }
      return [];
    }
    if (text.includes("FROM polymarket_param_versions")) {
      return this.selectVersion(this.paramVersions, text, params);
    }
    if (text.includes("INSERT INTO polymarket_resolution_events")) {
      this.resolutionEvents.push({
        condition_id: params[0],
        event_type: "rule_change",
        payload_json: parseJsonParam(params[1]),
        source_ts: params[2],
        received_at: params[3],
      });
      return [];
    }
    if (text.includes("INSERT INTO polymarket_universe_log")) {
      this.universeLog.push({
        condition_id: params[0],
        action: params[1],
        reason: params[2],
        at: params[3],
      });
      return [];
    }
    if (text.includes("FROM polymarket_universe_log")) {
      // DISTINCT ON latest action per condition (insertion order = time order).
      const latest = new Map<string, Row>();
      for (const row of this.universeLog) {
        latest.set(row.condition_id as string, row);
      }
      return [...latest.values()];
    }
    if (text.includes("INSERT INTO polymarket_markets")) {
      this.markets.push({
        condition_id: params[0],
        question: params[1],
        category: params[3],
        clob_token_ids: parseJsonParam(params[5]),
        rules: params[6],
        source_ts: params[15],
      });
      return [];
    }
    if (text.includes("INSERT INTO polymarket_event_markets")) {
      this.eventMarkets.push({
        event_id: params[0],
        condition_id: params[1],
        received_at: params[2],
      });
      return [];
    }
    if (text.includes("INSERT INTO polymarket_events")) {
      this.events.push({
        event_id: params[0],
        slug: params[1],
        title: params[2],
        neg_risk: params[3],
        tags_json: parseJsonParam(params[4]),
      });
      return [];
    }
    if (text.includes("INSERT INTO polymarket_data_gaps")) {
      this.dataGaps.push({
        source: params[0],
        token_id: params[1],
        gap_start: params[2],
        gap_end: params[3],
        cause: params[4],
        details_json: parseJsonParam(params[5]),
      });
      return [];
    }
    throw new Error(`FakeDb: unexpected SQL: ${text}`);
  }

  private selectVersion(table: Row[], text: string, params: unknown[]): Row[] {
    let candidates = table.filter((row) => row.condition_id === params[0]);
    if (text.includes("valid_from <=")) {
      const at = asDate(params[1]);
      candidates = candidates.filter((row) => {
        const validFrom = asDate(row.valid_from);
        const validTo = row.valid_to;
        return (
          validFrom.getTime() <= at.getTime() &&
          (validTo === null || asDate(validTo).getTime() > at.getTime())
        );
      });
    } else {
      candidates = candidates.filter((row) => row.valid_to === null);
    }
    return [...candidates]
      .sort((a, b) => (b.version as number) - (a.version as number))
      .slice(0, 1);
  }
}
