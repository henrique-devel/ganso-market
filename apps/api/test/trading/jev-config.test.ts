import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadChallengerConfig } from "../../src/models/jev-config.js";
import { mockTariff } from "./jev-fixture.js";
describe("Jev protected file configuration (MOCK credentials, no network)", () => {
  it("defaults off without reading a key and does not infer coverage from its presence", async () => {
    const path = await mkdtemp(join(tmpdir(), "jev-mock-config-"));
    try {
      const key = join(path, "key"),
        config = join(path, "config");
      await writeFile(key, "MOCK-secret", { mode: 0o600 });
      const absent = await loadChallengerConfig(config, key);
      expect(absent).toMatchObject({
        enabled: false,
        credentialPresent: true,
        key: null,
        tariff: null,
      });
      await writeFile(config, JSON.stringify({ enabled: false }));
      expect(await loadChallengerConfig(config, key)).toMatchObject({
        enabled: false,
        key: null,
        reasons: ["switch_disabled"],
      });
      await writeFile(
        config,
        JSON.stringify({
          enabled: true,
          tariff: mockTariff(),
          provision_reference: "MOCK-covered",
          billing_bound_reference: "MOCK-bound",
        }),
      );
      const ready = await loadChallengerConfig(config, key);
      expect(ready.enabled).toBe(true);
      expect(JSON.stringify(ready)).not.toContain("MOCK-secret");
      await chmod(key, 0o644);
      expect(await loadChallengerConfig(config, key)).toMatchObject({
        credentialPresent: false,
        key: null,
      });
      await chmod(config, 0o666);
      expect(await loadChallengerConfig(config, key)).toMatchObject({
        enabled: false,
        reasons: ["configuration_invalid"],
      });
    } finally {
      await rm(path, { recursive: true });
    }
  });
  it("rejects a price estimate without a total billing bound reference", async () => {
    const path = await mkdtemp(join(tmpdir(), "jev-mock-config-"));
    try {
      await writeFile(
        join(path, "config"),
        JSON.stringify({
          enabled: true,
          tariff: mockTariff(),
          provision_reference: "MOCK-covered",
        }),
      );
      expect(
        await loadChallengerConfig(join(path, "config"), join(path, "absent")),
      ).toMatchObject({
        enabled: false,
        reasons: ["tariff_or_coverage_attestation_invalid"],
      });
    } finally {
      await rm(path, { recursive: true });
    }
  });
});
