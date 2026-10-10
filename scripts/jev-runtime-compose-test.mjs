import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
// Only the isolated Compose smoke invokes this test harness. No production
// runtime configuration, transport switch, signer secret or activation path.
const password = (
  await readFile("/run/secrets/postgres_password", "utf8")
).trim();
const url = new URL("postgresql://postgres:5432/ganso_jev_runtime_test");
url.username = process.env.PGUSER;
url.password = password;
const child = spawn(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--root",
    "apps/api",
    "test/trading/jev-live-runtime.pg.test.ts",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, GANSO_TEST_DATABASE_URL: url.href },
  },
);
process.exitCode = await new Promise((resolve) =>
  child.once("exit", (code) => resolve(code ?? 1)),
);
