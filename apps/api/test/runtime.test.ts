import { describe, expect, it, vi } from "vitest";

import { createGracefulShutdown } from "../src/runtime.js";

describe("graceful shutdown", () => {
  it("stops the server before closing PostgreSQL and is idempotent", async () => {
    const events: string[] = [];
    const listeners = new Map<string, () => void>();
    const app = {
      close: vi.fn(async () => {
        events.push("server_closed");
      }),
      log: {
        info: vi.fn(),
        error: vi.fn(),
      },
    };
    const pool = {
      end: vi.fn(async () => {
        events.push("pool_closed");
      }),
    };
    const signals = {
      once(signal: NodeJS.Signals, listener: () => void): void {
        listeners.set(signal, listener);
      },
      off(signal: NodeJS.Signals): void {
        listeners.delete(signal);
      },
    };
    const graceful = createGracefulShutdown(app as never, pool, signals);
    graceful.install();

    await Promise.all([
      graceful.shutdown("SIGTERM"),
      graceful.shutdown("SIGINT"),
    ]);

    expect(events).toEqual(["server_closed", "pool_closed"]);
    expect(app.close).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });
});
