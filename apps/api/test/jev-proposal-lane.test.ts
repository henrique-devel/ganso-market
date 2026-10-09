import { beforeEach, expect, it, vi } from "vitest";
import { SecretValue } from "../src/config.js";
import {
  disabledChallengerConfig,
  type ChallengerConfig,
} from "../src/models/jev-config.js";
import { createJevProposalLane } from "../src/storage/jev-proposal-lane.js";
import type { DatabasePool } from "../src/database.js";
const mocks = vi.hoisted(() => ({
  retire: vi.fn(),
  admit: vi.fn(),
  generate: vi.fn(),
  transport: vi.fn(),
}));
vi.mock("../src/storage/jev-successions.js", () => ({
  retireFailedJevPairs: mocks.retire,
  admitJevSuccessor: mocks.admit,
}));
vi.mock("../src/storage/jev-generator.js", () => ({
  generateJevProposal: mocks.generate,
}));
vi.mock("../src/models/jev-proposal.js", () => ({
  createProposalTransport: mocks.transport,
}));
const config = (): ChallengerConfig => ({
  ...disabledChallengerConfig(),
  enabled: true,
  credentialPresent: true,
  key: new SecretValue("fixture-only"),
  tariff: {
    version: "v1",
    model: "jev-1.13.0",
    valid_until: "2099-01-01T00:00:00.000Z",
    input_usd6_per_million: "1000000",
    output_usd6_per_million: "0",
    max_billable_input_tokens: 10000,
  },
});
function database(owners = ["operator"]) {
  const query = vi.fn(async () => ({
    rows: owners.map((owner_id) => ({ owner_id })),
    rowCount: owners.length,
  }));
  const transaction = vi.fn(async (run) => run({ query }));
  return {
    pool: { transaction } as Pick<DatabasePool, "transaction">,
    transaction,
    query,
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transport.mockReturnValue({ origin: "real" });
  mocks.retire.mockResolvedValue({ retired_slots: [] });
  mocks.admit.mockResolvedValue({ status: "waiting" });
  mocks.generate.mockResolvedValue({ status: "waiting" });
});
it("disabled or incomplete configuration does not touch controls, accounts or transport", async () => {
  for (const c of [
    disabledChallengerConfig(),
    { ...config(), credentialPresent: false },
    { ...config(), key: null },
    { ...config(), tariff: null },
  ]) {
    const db = database(),
      lane = createJevProposalLane(db.pool, c, vi.fn());
    lane.tick();
    await flush();
    expect(lane.metrics.status).toBe("disabled");
    expect(db.transaction).not.toHaveBeenCalled();
    await lane.stop();
  }
  expect(mocks.transport).not.toHaveBeenCalled();
  expect(mocks.retire).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
});
it("configured worker without explicit enabled owners never retires or admits", async () => {
  const db = database([]),
    lane = createJevProposalLane(db.pool, config(), vi.fn());
  lane.tick();
  await flush();
  expect(lane.metrics.status).toBe("not_admitted");
  expect(mocks.retire).not.toHaveBeenCalled();
  expect(mocks.admit).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
  await lane.stop();
});
it("does not await provider latency in tick, overlap attempts or build a catch-up backlog", async () => {
  let release!: () => void;
  mocks.generate.mockImplementation(async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    return { status: "approved" };
  });
  const db = database(),
    lane = createJevProposalLane(db.pool, config(), vi.fn());
  expect(lane.tick(0)).toBeUndefined();
  await flush();
  for (let now = 250; now <= 180000; now += 250) lane.tick(now);
  expect(mocks.generate).toHaveBeenCalledOnce();
  expect(mocks.retire.mock.calls[0]).toEqual([
    db.pool,
    "operator",
    { model: "jev-1.13.0" },
  ]);
  expect(mocks.admit.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.generate.mock.invocationCallOrder[0]!,
  );
  release();
  await flush();
  lane.tick(180250);
  await flush();
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  release();
  await flush();
  lane.tick(180500);
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  await lane.stop();
  lane.tick(300000);
  expect(mocks.generate).toHaveBeenCalledTimes(2);
});
it("operator stop during retirement prevents admission and a subsequent generation", async () => {
  let release!: () => void;
  mocks.retire.mockImplementation(
    async () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  const db = database(),
    lane = createJevProposalLane(db.pool, config(), vi.fn());
  lane.tick();
  await flush();
  const stopped = lane.stop();
  release();
  await stopped;
  expect(mocks.admit).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
});
it("shutdown cancels the independent attempt and waits for its durable result handling", async () => {
  let signal!: AbortSignal,
    finalized = false;
  mocks.generate.mockImplementation(
    async (_pool, _owner, _tariff, _transport, options) => {
      signal = options.signal;
      await new Promise<void>((r) =>
        signal.addEventListener("abort", () => r(), { once: true }),
      );
      await flush();
      finalized = true;
      return { status: "unavailable" };
    },
  );
  const lane = createJevProposalLane(database().pool, config(), vi.fn());
  lane.tick();
  await flush();
  expect(signal.aborted).toBe(false);
  await lane.stop();
  expect(signal.aborted).toBe(true);
  expect(finalized).toBe(true);
  expect(lane.metrics.status).toBe("stopped");
});
it("a fencing or storage failure reports a safe failure and does not start dependent work", async () => {
  mocks.retire.mockRejectedValue(new Error("EXECUTION_WORKER_FENCED"));
  const failure = vi.fn(),
    lane = createJevProposalLane(database().pool, config(), failure);
  lane.tick(0);
  await flush();
  expect(lane.metrics).toMatchObject({ status: "unavailable", failures: 1 });
  expect(failure).toHaveBeenCalledOnce();
  expect(mocks.admit).not.toHaveBeenCalled();
  lane.tick(1000);
  expect(mocks.retire).toHaveBeenCalledOnce();
  await lane.stop();
});
