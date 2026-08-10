import { describe, expect, it, vi } from "vitest";

import { fetchDashboardStatus, mapHealthResponses } from "../src/health.js";

const readyHealth = {
  service: "api",
  status: "ready",
  checked_at: "2026-08-10T12:00:00.000Z",
  execution_mode: "paper",
  correlation_id: "ready-1",
  reason_codes: [],
  checks: [{ name: "postgres", status: "ready", reason_codes: [] }],
} as const;

const liveHealth = {
  ...readyHealth,
  status: "live",
  correlation_id: "live-1",
  checks: [],
} as const;

describe("dashboard health mapping", () => {
  it("maps valid live and ready responses to ready", () => {
    expect(
      mapHealthResponses(
        { ok: true, body: liveHealth },
        { ok: true, body: readyHealth },
      ),
    ).toEqual({
      kind: "ready",
      checkedAt: readyHealth.checked_at,
    });
  });

  it("maps an explicit readiness veto to not_ready with its reason code", () => {
    const notReady = {
      ...readyHealth,
      status: "not_ready" as const,
      reason_codes: ["POSTGRES_UNAVAILABLE"],
      checks: [
        {
          name: "postgres",
          status: "not_ready" as const,
          reason_codes: ["POSTGRES_UNAVAILABLE"],
        },
      ],
    };

    expect(
      mapHealthResponses(
        { ok: true, body: liveHealth },
        { ok: false, body: notReady },
      ),
    ).toEqual({
      kind: "not_ready",
      checkedAt: notReady.checked_at,
      reasonCode: "POSTGRES_UNAVAILABLE",
    });
  });

  it("maps network failure to unreachable", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(fetchDashboardStatus(fetcher)).resolves.toEqual({
      kind: "unreachable",
    });
  });

  it("rejects a health document with an invalid correlation ID", async () => {
    const fetcher = vi.fn(async (url: string) => ({
      ok: true,
      async json() {
        return url.endsWith("/live")
          ? { ...liveHealth, correlation_id: ".invalid-correlation" }
          : readyHealth;
      },
    }));

    await expect(fetchDashboardStatus(fetcher)).resolves.toEqual({
      kind: "unreachable",
    });
  });

  it("requests only the two public health routes", async () => {
    const fetcher = vi.fn(async (url: string) => ({
      ok: true,
      async json() {
        return url.endsWith("/live") ? liveHealth : readyHealth;
      },
    }));

    await expect(fetchDashboardStatus(fetcher)).resolves.toMatchObject({
      kind: "ready",
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/health/live",
      "/api/health/ready",
    ]);
  });
});
