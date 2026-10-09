import { afterEach, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { signL1Action, getWalletAddress } from "@nktkas/hyperliquid/signing";
const fixture = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: (path: string, flags: number) =>
      fs.open(
        path === "/run/secrets/jev_live_signer" ? fixture.path : path,
        flags,
      ),
  };
});
import { loadJevLiveSigner } from "../../src/models/jev-live-config.js";
let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true });
});
it("uses an ephemeral protected file and the pinned SDK signature contract, without serializing key material", async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-artificial-signer-"));
  fixture.path = join(dir, "key");
  const key = generatePrivateKey(); // Generated in memory, never a repository fixture.
  await writeFile(fixture.path, key, { mode: 0o600 });
  const wallet = await loadJevLiveSigner();
  expect(await getWalletAddress(wallet)).toBe(
    privateKeyToAccount(key).address.toLowerCase(),
  );
  const signature = await signL1Action({
    wallet,
    action: {
      type: "cancelByCloid",
      cancels: [{ asset: 0, cloid: "0x" + "a".repeat(32) }],
    },
    nonce: Date.now(),
    isTestnet: false,
  });
  expect(signature).toMatchObject({
    r: expect.stringMatching(/^0x[a-f0-9]{64}$/),
    s: expect.stringMatching(/^0x[a-f0-9]{64}$/),
    v: expect.any(Number),
  });
  expect(JSON.stringify(wallet)).not.toContain(key);
  await chmod(fixture.path, 0o644);
  await expect(loadJevLiveSigner()).rejects.toThrow(
    "JEV_LIVE_SIGNER_UNAVAILABLE",
  );
  await chmod(fixture.path, 0o600);
  await writeFile(fixture.path, "invalid artificial material");
  await expect(loadJevLiveSigner()).rejects.toThrow(
    "JEV_LIVE_SIGNER_UNAVAILABLE",
  );
  const target = fixture.path;
  fixture.path = join(dir, "link");
  await symlink(target, fixture.path);
  await expect(loadJevLiveSigner()).rejects.toThrow(
    "JEV_LIVE_SIGNER_UNAVAILABLE",
  );
});
