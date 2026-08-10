import { describe, expect, it, vi } from "vitest";

import { createPostgresReadinessProbe } from "../src/database.js";

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
