import { beforeEach, describe, expect, it, vi } from "vitest";

import { SecretValue, type ApiConfig } from "../src/config.js";
import {
  createDatabasePool,
  createPostgresReadinessProbe,
} from "../src/database.js";

// RFC-020 D3: the Pool is an EventEmitter, and `pg` emits 'error' on it when an
// idle client dies. Node turns an unhandled 'error' event into a thrown
// exception, which is how every deploy killed the five profile workers. The
// mock is a real EventEmitter so `emit("error")` behaves exactly as Node does:
// it throws when nothing listens, and does not when something does.
const { pools, MockPool } = await vi.hoisted(async () => {
  // Imported inside the hoisted block: vi.hoisted runs before the file's own
  // imports are evaluated.
  const { EventEmitter } = await import("node:events");
  const created: MockPool[] = [];

  class MockPool extends EventEmitter {
    public readonly config: Record<string, unknown>;
    public readonly query = vi
      .fn()
      .mockResolvedValue({ rows: [], rowCount: 0 });
    public readonly connect = vi.fn();
    public readonly end = vi.fn().mockResolvedValue(undefined);

    public constructor(config: Record<string, unknown>) {
      super();
      this.config = config;
      created.push(this);
    }
  }

  return { pools: created, MockPool };
});

vi.mock("pg", () => ({
  default: { Pool: MockPool },
  Pool: MockPool,
}));

function config(): ApiConfig {
  return {
    database: {
      host: "postgres",
      port: 5432,
      name: "ganso_market",
      user: "ganso_market",
      password: new SecretValue("synthetic-test-value"),
      ssl: false,
      connectTimeoutMs: 2_000,
    },
  } as unknown as ApiConfig;
}

describe("PostgreSQL readiness probe", () => {
  it("uses the fixed SELECT 1 query", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }),
      end: vi.fn(),
    };

    await createPostgresReadinessProbe(pool).check();

    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.query).toHaveBeenCalledWith("SELECT 1");
  });
});

describe("database pool client errors", () => {
  beforeEach(() => {
    pools.length = 0;
    vi.restoreAllMocks();
  });

  it("survives the error event that killed every worker on deploy", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    createDatabasePool(config(), {
      applicationName: "ganso-market-polymarket-recorder",
    });
    const pool = pools[0];
    expect(pool).toBeDefined();

    // Without the handler this line throws, exactly as production did:
    //   throw er; // Unhandled 'error' event
    expect(() => {
      pool?.emit(
        "error",
        new Error("terminating connection due to administrator command"),
      );
    }).not.toThrow();
  });

  it("logs DB_POOL_CLIENT_ERROR with the detail the reason code alone hides", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    createDatabasePool(config(), {
      applicationName: "ganso-market-polymarket-recorder",
    });

    pools[0]?.emit(
      "error",
      new Error("terminating connection due to administrator command"),
    );

    const written = stderr.mock.calls.map((call) => String(call[0]));
    const line = written.find((entry) =>
      entry.includes("DB_POOL_CLIENT_ERROR"),
    );
    expect(line).toBeDefined();
    const logged = JSON.parse(line as string) as Record<string, unknown>;
    expect(logged.level).toBe("error");
    expect(logged.reason_code).toBe("DB_POOL_CLIENT_ERROR");
    expect(logged.error_name).toBe("Error");
    expect(logged.detail).toBe(
      "terminating connection due to administrator command",
    );
    expect(logged.application_name).toBe("ganso-market-polymarket-recorder");
  });

  it("names the api when no application name is given", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    createDatabasePool(config());

    pools[0]?.emit("error", new Error("connection terminated unexpectedly"));

    const line = stderr.mock.calls
      .map((call) => String(call[0]))
      .find((entry) => entry.includes("DB_POOL_CLIENT_ERROR"));
    const logged = JSON.parse(line as string) as Record<string, unknown>;
    expect(logged.application_name).toBe("ganso-market-api");
  });

  it("handles a non-Error payload without throwing", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    createDatabasePool(config());

    expect(() => {
      pools[0]?.emit("error", "socket hang up");
    }).not.toThrow();
  });

  it("registers exactly one error listener and never reconnects by hand", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    createDatabasePool(config());
    const pool = pools[0];

    expect(pool?.listenerCount("error")).toBe(1);
    // The handler logs and stops: no connect(), no end(), no retry loop.
    pool?.emit("error", new Error("terminating connection"));
    expect(pool?.connect).not.toHaveBeenCalled();
    expect(pool?.end).not.toHaveBeenCalled();
    expect(pool?.query).not.toHaveBeenCalled();
  });
});
