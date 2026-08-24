import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// RFC-011 stop condition and mandatory test (task 10): this module simulates
// and nothing else. A code search over every file it owns must find no trading
// auth, no wallet or signer, no private key, no EIP-712 order signing and no
// real order path — not even a disarmed or feature-flagged one. If a future
// change adds any of them, this test fails before the change can ship.
//
// It is the fundamental module's guard (fundamental/scope.test.ts) cloned for
// the paper module, extended with the EIP-712 patterns that guard did not
// cover: a paper broker is one step closer to a real order than an estimator,
// so the struct types used to SIGN real CLOB orders are forbidden here too.

const MODULE_ROOT = new URL("../../../src/polymarket/paper/", import.meta.url)
  .pathname;

const ENTRYPOINT = new URL("../../../src/polymarket-paper.ts", import.meta.url)
  .pathname;

const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /private[_\s-]?key/i, what: "private key material" },
  { pattern: /\bmnemonic\b|seed[_\s-]?phrase/i, what: "wallet seed material" },
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
];

/**
 * Tables this module is allowed to write to. The RFC-011 migrations extend
 * this list PR by PR, and any write outside it fails the guard.
 */
const WRITABLE_TABLES: readonly string[] = [
  "paper_feature_windows",
  "paper_orders",
  "paper_ledger_events",
  "paper_positions",
  "paper_kill_switch",
  "paper_markouts",
  "paper_fill_samples",
  "paper_fill_reports",
];

/**
 * Strip comments before scanning. The module's own prose says "no wallet, no
 * signer, no order path" in several places; matching that prose would make the
 * guard pass or fail for the wrong reason. Only executable code is scanned.
 * `://` is preserved so a URL in a string literal is not mistaken for a comment.
 */
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

describe("RFC-011 scope", () => {
  it("contains no trading auth, wallet, signer, EIP-712 or order path", async () => {
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
      // `ON CONFLICT ... DO UPDATE SET` is an upsert on the table already named
      // by the INSERT, not a second write target; collapse it so the scan does
      // not read "SET" as a table name.
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

  it("never imports the auth service or any network client", async () => {
    const files = await moduleFiles();
    for (const file of files) {
      const source = stripComments(await readFile(file, "utf8"));
      // The future API route file will legitimately depend on the RFC-002 auth
      // service to GUARD its endpoints; nothing else in the module may touch
      // auth, and no file may open a socket or make an outbound request.
      if (!file.endsWith("api.ts")) {
        expect(source).not.toMatch(/from\s+["'].*auth\//);
      }
      expect(source).not.toMatch(/from\s+["']ws["']/);
      expect(source).not.toMatch(/\bnew WebSocket\b/);
      expect(source).not.toMatch(/\bfetch\s*\(/);
    }
  });
});
