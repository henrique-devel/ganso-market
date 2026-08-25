import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// RFC-012 stop condition and mandatory test: this module scores, vetoes and
// checks consistency — nothing else. A code search over every file it owns
// must find no trading auth, no signer material, no EIP-712 structs, no real
// order path and no state-changing RPC method — not even disarmed. The one
// deliberately allowed network surface is the READ-ONLY eth_getLogs polling
// in onchain.ts; every other file is forbidden to fetch at all.
//
// It also enforces the module's look-ahead poison list: UMA's closedTime
// becomes known AFTER the outcome is public and must never appear here.

const MODULE_ROOT = new URL(
  "../../../src/polymarket/resolution/",
  import.meta.url,
).pathname;

const ENTRYPOINT = new URL(
  "../../../src/polymarket-resolution.ts",
  import.meta.url,
).pathname;

const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /private[_\s-]?key/i, what: "private key material" },
  { pattern: /\bmnemonic\b|seed[_\s-]?phrase/i, what: "seed material" },
  {
    pattern: /\bsigner\b|\bsignTransaction\b|\bsignOrder\b/i,
    what: "a signer",
  },
  { pattern: /\bwallet\b/i, what: "a wallet" },
  {
    pattern: /\bplaceOrder\b|\bcreateOrder\b|\bsubmitOrder\b/i,
    what: "an order path",
  },
  {
    pattern: /\bapi[_\s-]?secret\b|\bapi[_\s-]?passphrase\b/i,
    what: "trading credentials",
  },
  {
    pattern:
      /\bL1_AUTH\b|\bL2_AUTH\b|POLY_ADDRESS|POLY_SIGNATURE|POLY_API_KEY/i,
    what: "Polymarket trading auth headers",
  },
  { pattern: /clob\.polymarket\.com\/order/i, what: "the order endpoint" },
  {
    pattern: /\bexecution_mode\s*[:=]\s*["']live["']/i,
    what: "a live execution mode",
  },
  {
    pattern:
      /\bsignTypedData\b|\bEIP712Domain\b|\bverifyingContract\b|_TypedData/i,
    what: "EIP-712 order signing structs",
  },
  {
    pattern:
      /eth_sendRawTransaction|eth_sendTransaction|eth_sign\b|personal_|eth_accounts/i,
    what: "a state-changing or account RPC method",
  },
  { pattern: /\bclosedTime\b/i, what: "the closedTime look-ahead field" },
];

/**
 * Tables this module is allowed to write to. The 0010 migration defines them;
 * any write outside this list fails the guard.
 */
const WRITABLE_TABLES: readonly string[] = [
  "resolution_score_versions",
  "resolution_scores",
  "resolution_market_state",
  "resolution_clarifications",
  "resolution_uma_timeline",
  "resolution_onchain_events",
  "resolution_onchain_cursor",
  "resolution_adjudication_samples",
  "resolution_layer_divergences",
  "resolution_reports",
  "resolution_runtime_state",
  "graph_edges",
  "graph_violations",
  "graph_sanity_vetoes",
];

/** Strip comments so the guard scans executable code only. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

async function moduleFiles(): Promise<string[]> {
  const files: string[] = [ENTRYPOINT];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.name.endsWith(".ts")) {
        files.push(path);
      }
    }
  };
  await walk(MODULE_ROOT);
  return files;
}

describe("RFC-012 scope", () => {
  it("contains no trading auth, signer, EIP-712, order path or closedTime", async () => {
    const files = await moduleFiles();
    expect(files.length).toBeGreaterThanOrEqual(2);
    const findings: string[] = [];
    for (const file of files) {
      const source = stripComments(await readFile(file, "utf8"));
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(source)) {
          findings.push(`${file}: ${rule.what}`);
        }
      }
    }
    expect(findings).toEqual([]);
  });

  it("writes only to its own tables", async () => {
    const files = await moduleFiles();
    const writes = new Set<string>();
    for (const file of files) {
      const source = stripComments(await readFile(file, "utf8")).replace(
        /DO\s+UPDATE\s+SET/gi,
        "DO_UPDATE_SET",
      );
      for (const match of source.matchAll(
        /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/gi,
      )) {
        const table = match[1];
        if (table !== undefined) {
          writes.add(table.toLowerCase());
        }
      }
    }
    for (const table of writes) {
      expect(WRITABLE_TABLES).toContain(table);
    }
  });

  it("keeps the network surface to the read-only onchain collector", async () => {
    const files = await moduleFiles();
    for (const file of files) {
      const source = stripComments(await readFile(file, "utf8"));
      // The API route file legitimately depends on the RFC-002 auth service
      // to GUARD its endpoints; nothing else in the module may touch auth.
      if (!file.endsWith("api.ts")) {
        expect(source).not.toMatch(/from\s+["'].*auth\//);
      }
      expect(source).not.toMatch(/from\s+["']ws["']/);
      expect(source).not.toMatch(/\bnew WebSocket\b/);
      // eth_getLogs over public RPC is the ONE allowed outbound surface, and
      // it lives in onchain.ts alone.
      if (!file.endsWith("onchain.ts")) {
        expect(source).not.toMatch(/\bfetch\s*\(/);
      }
    }
  });
});
