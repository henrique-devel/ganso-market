import { describe, expect, it } from "vitest";

import type { QueryResult, SqlExecutor } from "../../../src/database.js";
import {
  fillLabelerTick,
  fillReportIfDue,
  fillSamplerTick,
  markoutTick,
  signedMarkout,
  walkVwap,
  wilsonInterval,
} from "../../../src/polymarket/paper/calibration.js";

type Row = Record<string, unknown>;

const T0 = new Date("2026-08-24T12:00:00.000Z");
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);
const silent = (): void => undefined;

describe("markout math", () => {
  it("signs the markout by the side of the fill", () => {
    // A BUY that the market then leaves behind is adverse (negative).
    expect(signedMarkout("BUY", "0.52", "0.50")).toBe("-0.020000");
    expect(signedMarkout("BUY", "0.52", "0.55")).toBe("0.030000");
    expect(signedMarkout("SELL", "0.48", "0.50")).toBe("-0.020000");
    expect(signedMarkout("SELL", "0.48", "0.45")).toBe("0.030000");
    expect(signedMarkout("BUY", "0.52", null)).toBeNull();
  });

  it("the executable reference walks the fill size, not the touch", () => {
    const bids = [
      { price: "0.50", size: "60" },
      { price: "0.45", size: "40" },
    ];
    // 100 shares: (60x0.50 + 40x0.45) / 100 = 0.48.
    expect(walkVwap(bids, "100")).toBe("0.480000");
    expect(walkVwap(bids, "500")).toBeNull();
  });
});

describe("wilson interval", () => {
  it("brackets the empirical rate and stays inside [0, 1]", () => {
    const interval = wilsonInterval(30, 100);
    expect(interval.rate).toBe("0.300000");
    expect(Number(interval.low)).toBeGreaterThan(0.2);
    expect(Number(interval.low)).toBeLessThan(0.3);
    expect(Number(interval.high)).toBeGreaterThan(0.3);
    expect(Number(interval.high)).toBeLessThan(0.42);
    expect(wilsonInterval(0, 0)).toEqual({
      rate: "0.000000",
      low: "0.000000",
      high: "0.000000",
    });
  });
});

// ---------------------------------------------------------------------------
// Stateful world for the job ticks.

interface World {
  fills: Row[];
  markouts: Row[];
  snapshots: Array<{
    token_id: string;
    received_at: Date;
    source_ts: Date;
    bids_json: unknown;
    asks_json: unknown;
  }>;
  samples: Row[];
  reports: Row[];
  trades: Array<{ token_id: string; price: string; size: string; ts: Date }>;
  tick: string;
}

function worldPool(world: World): SqlExecutor {
  let nextSampleId = 1;
  return {
    query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      const rows = ((): Row[] => {
        if (text.includes("FROM paper_ledger_events e")) {
          return world.fills.filter((fill) => {
            const ts = fill["event_ts"] as Date;
            const done = world.markouts.some(
              (m) =>
                m["fill_key"] === fill["idempotency_key"] &&
                m["horizon_s"] === 300,
            );
            return ts.getTime() <= (params[0] as Date).getTime() && !done;
          });
        }
        if (text.startsWith("INSERT INTO paper_markouts")) {
          const exists = world.markouts.some(
            (m) => m["fill_key"] === params[0] && m["horizon_s"] === params[8],
          );
          if (!exists) {
            world.markouts.push({
              fill_key: params[0],
              token_id: params[2],
              side: params[3],
              taker: params[4],
              fill_price: params[5],
              fill_size: params[6],
              fill_ts: params[7],
              horizon_s: params[8],
              mid_markout: params[9],
              exec_bid_markout: params[10],
            });
          }
          return [];
        }
        if (
          text.includes("FROM polymarket_book_snapshots") &&
          text.includes("DISTINCT token_id")
        ) {
          const since = params[0] as Date;
          const seen = new Set<string>();
          for (const s of world.snapshots) {
            if (s.received_at.getTime() > since.getTime()) {
              seen.add(s.token_id);
            }
          }
          return [...seen].sort().map((token_id) => ({ token_id }));
        }
        if (text.includes("FROM polymarket_book_snapshots")) {
          const eligible = world.snapshots
            .filter(
              (s) =>
                s.token_id === params[0] &&
                s.received_at.getTime() <= (params[1] as Date).getTime(),
            )
            .sort((a, b) => b.received_at.getTime() - a.received_at.getTime());
          const first = eligible[0];
          return first === undefined ? [] : [first as unknown as Row];
        }
        if (text.includes("FROM polymarket_param_versions")) {
          return [{ tick_size: world.tick }];
        }
        if (text.startsWith("INSERT INTO paper_fill_samples")) {
          const key = `${String(params[0])}:${String(params[1])}:${(params[2] as Date).toISOString()}:${String(params[3])}:${String(params[6])}`;
          if (world.samples.some((s) => s["key"] === key)) {
            return [];
          }
          world.samples.push({
            key,
            sample_id: nextSampleId,
            token_id: params[0],
            side: params[1],
            sampled_at: params[2],
            distance_ticks: params[3],
            level_price: params[4],
            queue_ahead: params[5],
            life_s: params[6],
            filled: null,
            labeled_at: null,
          });
          nextSampleId += 1;
          return [];
        }
        if (
          text.includes("FROM paper_fill_samples") &&
          text.includes("filled IS NULL")
        ) {
          return world.samples.filter((s) => {
            const sampledAt = s["sampled_at"] as Date;
            const lifeS = s["life_s"] as number;
            return (
              s["filled"] === null &&
              sampledAt.getTime() + lifeS * 1_000 <=
                (params[0] as Date).getTime()
            );
          });
        }
        if (text.includes("FROM polymarket_trades")) {
          let volume = 0;
          for (const trade of world.trades) {
            if (
              trade.token_id === params[0] &&
              Number(trade.price) === Number(params[1]) &&
              trade.ts.getTime() > (params[2] as Date).getTime() &&
              trade.ts.getTime() <= (params[3] as Date).getTime()
            ) {
              volume += Number(trade.size);
            }
          }
          return [{ volume: String(volume) }];
        }
        if (text.startsWith("UPDATE paper_fill_samples")) {
          for (const sample of world.samples) {
            if (sample["sample_id"] === params[0]) {
              sample["filled"] = params[1];
              sample["labeled_at"] = params[2];
            }
          }
          return [];
        }
        if (text.includes("MAX(generated_at) AS last")) {
          const last = world.reports.reduce<Date | null>((acc, r) => {
            const generated = r["generated_at"] as Date;
            return acc === null || generated > acc ? generated : acc;
          }, null);
          return [{ last }];
        }
        if (text.includes("GROUP BY distance_ticks, life_s")) {
          const buckets = new Map<
            string,
            {
              samples: number;
              fills: number;
              from: Date;
              to: Date;
              distance: number;
              life: number;
            }
          >();
          for (const sample of world.samples) {
            if (sample["filled"] === null) {
              continue;
            }
            const distance = sample["distance_ticks"] as number;
            const life = sample["life_s"] as number;
            const sampledAt = sample["sampled_at"] as Date;
            const key = `${String(distance)}:${String(life)}`;
            const bucket = buckets.get(key) ?? {
              samples: 0,
              fills: 0,
              from: sampledAt,
              to: sampledAt,
              distance,
              life,
            };
            bucket.samples += 1;
            if (sample["filled"] === true) {
              bucket.fills += 1;
            }
            if (sampledAt < bucket.from) {
              bucket.from = sampledAt;
            }
            if (sampledAt > bucket.to) {
              bucket.to = sampledAt;
            }
            buckets.set(key, bucket);
          }
          return [...buckets.values()].map((bucket) => ({
            distance_ticks: bucket.distance,
            life_s: bucket.life,
            samples: bucket.samples,
            fills: bucket.fills,
            data_from: bucket.from,
            data_to: bucket.to,
          }));
        }
        if (text.startsWith("INSERT INTO paper_fill_reports")) {
          world.reports.push({
            generated_at: params[0],
            data_from: params[1],
            data_to: params[2],
            samples_total: params[3],
            buckets_json: JSON.parse(params[4] as string) as unknown,
          });
          return [];
        }
        throw new Error(`no handler: ${text.slice(0, 70)}`);
      })();
      return Promise.resolve({ rows: rows as R[], rowCount: rows.length });
    },
  };
}

describe("markout tick", () => {
  it("computes signed markouts per horizon and records stale absences", async () => {
    const world: World = {
      fills: [
        {
          idempotency_key: "o1:taker:0",
          order_id: "o1",
          token_id: "tok",
          payload_json: { side: "BUY", price: "0.52", size: "10", taker: true },
          event_ts: at(-400_000),
        },
      ],
      markouts: [],
      snapshots: [
        // Fresh books at +1s/+10s/+60s; nothing near +300s (stale there).
        {
          token_id: "tok",
          received_at: at(-399_500),
          source_ts: at(-399_600),
          bids_json: [{ price: "0.50", size: "100" }],
          asks_json: [{ price: "0.54", size: "100" }],
        },
      ],
      samples: [],
      reports: [],
      trades: [],
      tick: "0.01",
    };
    await markoutTick(worldPool(world), {
      clock: () => T0,
      logSink: silent,
    });
    expect(world.markouts).toHaveLength(4);
    const oneSecond = world.markouts.find((m) => m["horizon_s"] === 1);
    // mid at +1s = 0.52; markout = 0.52 - 0.52 = 0.
    expect(oneSecond?.["mid_markout"]).toBe("0.000000");
    // exec reference walks 10 shares into the bids: 0.50.
    expect(oneSecond?.["exec_bid_markout"]).toBe("-0.020000");
    const fiveMinutes = world.markouts.find((m) => m["horizon_s"] === 300);
    // The only book is ~95s older than the +300s horizon: explicit absence.
    expect(fiveMinutes?.["mid_markout"]).toBeNull();
    // Idempotent: a second tick adds nothing.
    await markoutTick(worldPool(world), { clock: () => T0, logSink: silent });
    expect(world.markouts).toHaveLength(4);
  });
});

describe("P(fill) sampler, labeler and walk-forward report", () => {
  it("samples behind the visible queue, labels after the life, reports buckets", async () => {
    const world: World = {
      fills: [],
      markouts: [],
      snapshots: [
        {
          token_id: "tok",
          received_at: at(-1_000),
          source_ts: at(-1_500),
          bids_json: [{ price: "0.48", size: "100" }],
          asks_json: [{ price: "0.52", size: "80" }],
        },
      ],
      samples: [],
      reports: [],
      trades: [],
      tick: "0.01",
    };
    const pool = worldPool(world);
    await fillSamplerTick(pool, { clock: () => T0, logSink: silent });
    // 2 sides x 4 distances.
    expect(world.samples).toHaveLength(8);
    const touchBuy = world.samples.find(
      (s) => s["side"] === "BUY" && s["distance_ticks"] === 0,
    );
    expect(touchBuy?.["level_price"]).toBe("0.480000");
    expect(touchBuy?.["queue_ahead"]).toBe("100.000000");
    const deepBuy = world.samples.find(
      (s) => s["side"] === "BUY" && s["distance_ticks"] === 5,
    );
    expect(deepBuy?.["level_price"]).toBe("0.430000");
    expect(deepBuy?.["queue_ahead"]).toBe("0.000000");

    // 120 shares trade at the touch inside the life: beats the 100 queue.
    world.trades.push({
      token_id: "tok",
      price: "0.48",
      size: "120",
      ts: at(60_000),
    });
    await fillLabelerTick(pool, {
      clock: () => at(301_000),
      logSink: silent,
    });
    expect(touchBuy?.["filled"]).toBe(true);
    expect(deepBuy?.["filled"]).toBe(false);

    // The report is due (no previous one) and stamps its data window.
    const generated = await fillReportIfDue(pool, {
      clock: () => at(400_000),
      logSink: silent,
    });
    expect(generated).toBe(true);
    const report = world.reports[0];
    expect(report?.["samples_total"]).toBe(8);
    const buckets = report?.["buckets_json"] as Array<Record<string, unknown>>;
    const touchBucket = buckets.find((b) => b["distance_ticks"] === 0);
    // Both sides sampled at the touch; only the BUY side saw the volume.
    expect(touchBucket).toMatchObject({ samples: 2, fills: 1 });
    // Not due again inside the weekly period.
    const again = await fillReportIfDue(pool, {
      clock: () => at(500_000),
      logSink: silent,
    });
    expect(again).toBe(false);
  });
});
