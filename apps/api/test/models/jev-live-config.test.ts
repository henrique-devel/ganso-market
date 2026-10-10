import { afterEach, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJevLiveConfig } from "../../src/models/jev-live-config.js";
const original = process.env.GANSO_LIVE_RUNTIME_CONFIG_FILE;
let dir: string | undefined;
afterEach(async () => {
  if (original === undefined) delete process.env.GANSO_LIVE_RUNTIME_CONFIG_FILE;
  else process.env.GANSO_LIVE_RUNTIME_CONFIG_FILE = original;
  if (dir) await rm(dir, { recursive: true });
});
it("defaults closed and rejects environment, activation fields and secret-bearing config", async () => {
  delete process.env.GANSO_LIVE_RUNTIME_CONFIG_FILE;
  expect(await loadJevLiveConfig()).toBeNull();
  dir = await mkdtemp(join(tmpdir(), "jev-live-config-"));
  const path = join(dir, "public.json");
  process.env.GANSO_LIVE_RUNTIME_CONFIG_FILE = path;
  const config = {
    version: "jev.live-runtime.v1",
    identity_hash: "a".repeat(64),
    environment: "mainnet",
  };
  for (const value of [
    { ...config, environment: "testnet" },
    { ...config, enabled: true },
    { ...config, private_key: "invalid" },
    null,
  ]) {
    await writeFile(path, JSON.stringify(value));
    await expect(loadJevLiveConfig()).rejects.toThrow("CONFIG_INVALID");
  }
  await writeFile(path, JSON.stringify(config));
  expect(await loadJevLiveConfig()).toEqual(config);
});
