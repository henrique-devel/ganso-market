import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRecorderHeartbeat,
  RECORDER_HEARTBEAT_INTERVAL_MS,
  run,
} from "../src/polymarket-recorder.js";

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig,
}));

let directory: string;
const activeHeartbeats: ReturnType<typeof createRecorderHeartbeat>[] = [];

function start(path = join(directory, "heartbeat.json")) {
  const heartbeat = createRecorderHeartbeat(path);
  activeHeartbeats.push(heartbeat);
  return heartbeat;
}

function read(path = join(directory, "heartbeat.json")) {
  return JSON.parse(readFileSync(path, "utf8")) as {
    version: number;
    pid: number;
    seq: number;
    timestamp: string;
    uptime_ms: number;
    phase: string;
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ganso-heartbeat-test-"));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T12:00:00Z"));
});

afterEach(() => {
  for (const heartbeat of activeHeartbeats.splice(0)) heartbeat.stop();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

describe("recorder event-loop heartbeat", () => {
  it("publishes boot immediately, advances progress and stops on shutdown", () => {
    const heartbeat = start();
    const first = read();
    expect(first).toEqual({
      version: 1,
      pid: process.pid,
      seq: 1,
      timestamp: "2026-09-11T12:00:00.000Z",
      uptime_ms: expect.any(Number),
      phase: "starting",
    });
    expect(first.uptime_ms).toBeGreaterThanOrEqual(0);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(RECORDER_HEARTBEAT_INTERVAL_MS);
    expect(read()).toMatchObject({ seq: 2, phase: "starting" });
    heartbeat.markRunning();
    expect(read()).toMatchObject({ seq: 3, phase: "running" });
    vi.advanceTimersByTime(RECORDER_HEARTBEAT_INTERVAL_MS);
    const progress = read();
    expect(progress.seq).toBe(4);
    expect(progress.uptime_ms).toBeGreaterThanOrEqual(first.uptime_ms);
    heartbeat.stop();
    expect(vi.getTimerCount()).toBe(0);
    const final = read();
    expect(final).toMatchObject({ seq: 5, phase: "stopping" });
    heartbeat.markRunning();
    heartbeat.stop();
    vi.advanceTimersByTime(60_000);
    expect(read()).toEqual(final);
  });

  it("replaces a stale symlink without touching its target and keeps only private bounded JSON", () => {
    const target = join(directory, "private-config");
    const path = join(directory, "heartbeat.json");
    writeFileSync(target, "DO_NOT_MODIFY", { mode: 0o600 });
    symlinkSync(target, path);
    start(path);
    vi.advanceTimersByTime(120_000);
    expect(readFileSync(target, "utf8")).toBe("DO_NOT_MODIFY");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(path).size).toBeLessThan(1_024);
    expect(readdirSync(directory).sort()).toEqual([
      "heartbeat.json",
      "private-config",
    ]);
    expect(readFileSync(path, "utf8")).not.toContain("DO_NOT_MODIFY");
  });

  it("bounds failure logging, cleans failed publication and retries after filesystem recovery", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const path = join(directory, "secret=must-not-log");
    mkdirSync(path); // Creating a temporary file works, replacing this fails.
    start(path);
    vi.advanceTimersByTime(60_000);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0]?.[0]).toContain(
      "RECORDER_HEARTBEAT_WRITE_FAILED",
    );
    expect(stderr.mock.calls[0]?.[0]).not.toContain("must-not-log");
    expect(readdirSync(directory)).toEqual(["secret=must-not-log"]);
    rmSync(path, { recursive: true });
    vi.advanceTimersByTime(RECORDER_HEARTBEAT_INTERVAL_MS);
    expect(read(path)).toMatchObject({ phase: "starting" });
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it("clears the heartbeat timer if initialization throws", async () => {
    const error = new Error("configuration rejected");
    loadConfig.mockRejectedValueOnce(error);
    const heartbeat = start();
    await expect(run(heartbeat)).rejects.toBe(error);
    expect(read()).toMatchObject({ phase: "stopping" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
