import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxy = {
  target: "http://127.0.0.1:3000",
  changeOrigin: false,
  rewrite: (path: string): string => path.replace(/^\/api/, ""),
};

/**
 * The revision this bundle was built from (RFC-015).
 *
 * `deploy/release-sha` carries a git `export-subst` placeholder that
 * `git archive` rewrites to the deployed commit, so the production image
 * always bakes in its exact revision. In a plain checkout the placeholder
 * stays literal and this correctly yields "unknown" — the same resolution the
 * API's provenance module uses, so the panel and the API answer the question
 * the same way or not at all.
 *
 * The panel compares this against the sha the API reports and tells the
 * operator to reload when they differ. On 2026-08-31 a stale bundle in memory
 * made the kill-switch rearm look broken for an hour: logging in inside the
 * app does not reload the SPA, and nothing on screen said which build was
 * running.
 */
function buildSha(): string {
  try {
    const path = fileURLToPath(
      new URL("../../deploy/release-sha", import.meta.url),
    );
    const raw = readFileSync(path, "utf8").trim();
    return /^[0-9a-f]{40}$/.test(raw) ? raw : "unknown";
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha()),
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api/trading/experiment-datasets": apiProxy,
      "/api/trading/experiments": apiProxy,
      "/api/trading/experiment-system": apiProxy,
      "/api/trading/jev": apiProxy,
      "/api/trading/accounts": apiProxy,
      "/api/trading/account": apiProxy,
      "/api/trading/positions": apiProxy,
      "/api/trading/orders": apiProxy,
      "/api/trading/operation": apiProxy,
      "/api/trading/preview": apiProxy,
      "/api/trading/submit": apiProxy,
      "/api/trading/cancel": apiProxy,
      "/api/trading/close": apiProxy,
      "/api/trading/pause": apiProxy,
      "/api/health/live": apiProxy,
      "/api/health/ready": apiProxy,
      "/api/auth/login": apiProxy,
      "/api/auth/refresh": apiProxy,
      "/api/auth/logout": apiProxy,
      "/api/auth/session": apiProxy,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
