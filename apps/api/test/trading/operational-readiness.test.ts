import { describe, it, expect, vi } from "vitest";
import {
  consumerReadiness,
  freshness,
  readOperationalReadiness,
  type ConsumerObservation,
} from "../../src/storage/operational-readiness.js";
import type { SqlExecutor } from "../../src/database.js";
const now = new Date("2026-09-28T04:00:00.000Z");
const ready: ConsumerObservation = {
  enabled: true,
  consumer_ready: true,
  consumer_at: now,
  consumer_reason: "operational",
  status: "ready",
  lease_until: new Date(now.getTime() + 10000),
};
describe("operational readiness does not infer readiness from HTTP or durable flags", () => {
  it("fails closed for missing, stale and future measurements", () => {
    expect(freshness(null, now.getTime(), 5000)).toBe("unavailable");
    expect(freshness("invalid", now.getTime(), 5000)).toBe("unavailable");
    expect(freshness(new Date(now.getTime() + 1), now.getTime(), 5000)).toBe(
      "future",
    );
    expect(freshness(new Date(now.getTime() - 5001), now.getTime(), 5000)).toBe(
      "stale",
    );
  });
  it("requires a current heartbeat, ready reconciliation and a live lease per account", () => {
    expect(consumerReadiness(ready, now.getTime()).status).toBe("ready");
    for (const [delta, reason] of [
      [{ lease_until: now }, "lease_expired_or_absent"],
      [{ lease_until: new Date("invalid") }, "lease_expired_or_absent"],
      [{ consumer_at: new Date(now.getTime() - 5001) }, "consumer_stale"],
      [
        { consumer_ready: false, consumer_reason: "BTC_DESK_CYCLE_FAILED" },
        "consumer_not_ready",
      ],
      [{ status: "blocked" }, "reconciliation_not_ready"],
      [{ enabled: false }, "consumer_not_enabled"],
    ] as const)
      expect(
        consumerReadiness({ ...ready, ...delta }, now.getTime()).reasons,
      ).toContain(reason);
  });
  it("reports stopped capture, unavailable host telemetry and restart evidence without claiming process health", async () => {
    const old = new Date(now.getTime() - 86400000);
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            kind: "book",
            source_at: old,
            received_at: old,
            quality: "fresh",
            gap_epoch: 0,
          },
          {
            kind: "context",
            source_at: null,
            received_at: old,
            quality: "unproven",
            gap_epoch: 0,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            at: old,
            restarted: true,
            history_truncated: true,
            socket: { alive: true, connected: true },
            channels: {
              book: {
                status: "healthy",
                needs_revalidation: false,
                gap_epoch: 0,
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const result = await readOperationalReadiness(
      { query } as SqlExecutor,
      now,
    );
    expect(result.status).toBe("not_ready");
    expect(result.channels[0]?.reasons).toContain("source_stale");
    expect(result.channels[1]?.reasons).toContain("source_unavailable");
    expect(result.collector).toMatchObject({
      status: "unavailable",
      capture_status: "stale",
      restarted_at_last_capture: true,
    });
    expect(result.resources.host_cpu).toBeNull();
    expect(result.resources.container_restarts).toBeNull();
    expect(result.history.unavailable).toBe(672);
    expect(query.mock.calls.every(([sql]) => /^SELECT/.test(sql.trim()))).toBe(
      true,
    );
  });
  it("requires current matching channel health even with recent timestamps", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            kind: "book",
            source_at: now,
            received_at: now,
            quality: "fresh",
            gap_epoch: 2,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            at: now,
            restarted: false,
            socket: { alive: true, connected: true },
            channels: {
              book: {
                status: "healthy",
                needs_revalidation: false,
                gap_epoch: 1,
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const result = await readOperationalReadiness(
      { query } as SqlExecutor,
      now,
    );
    expect(result.channels[0]?.reasons).toContain("feed_gap_or_unavailable");
  });
});

it("distinguishes interval edge samples, gaps and absent history without certifying intrainterval continuity", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [
        {
          slot: 0,
          first_at: new Date(now.getTime() - 7 * 86400000 + 1000),
          last_at: new Date(now.getTime() - 7 * 86400000 + 899000),
        },
        {
          slot: 1,
          first_at: new Date(now.getTime() - 7 * 86400000 + 950000),
          last_at: new Date(now.getTime() - 7 * 86400000 + 1000000),
        },
      ],
    });
  const result = await readOperationalReadiness({ query } as SqlExecutor, now);
  expect(result.status).toBe("not_ready");
  expect(result.history).toMatchObject({
    observed: 1,
    incomplete: 1,
    unavailable: 670,
    sampling: "interval_edges_15m_internal_gaps_unmeasured",
  });
});
