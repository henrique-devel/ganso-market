import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// RFC-013 stop condition and mandatory test: "busca de código confirma ausência
// de auth/wallet/ordem real". This module decides how much to bet and when to
// stop — it is the closest thing in the repository to a live trading engine, so
// the guard here is the strictest of the three (RFC-010's, RFC-011's, and this
// one), and it additionally forbids the two things unique to THIS RFC:
//
//   - a stop-loss. The RFC forbids promising one anywhere: a binary book can
//     gap from a high price to near zero, so an exit order does not protect the
//     position. The engine records the total-loss exposure in the sizing
//     instead of pretending a stop exists.
//   - a way to disable a limiter. If any cap or sizing limiter could be turned
//     off by a flag, the min() that bounds every position would be a
//     suggestion. The RFC makes that a stop condition.

const MODULE_ROOT = new URL(
  "../../../src/polymarket/portfolio/",
  import.meta.url,
).pathname;

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
  // RFC-013 specific.
  {
    pattern: /\bstop[_\s-]?loss\b|\bstopLoss\b|\btrailingStop\b/i,
    what: "a stop-loss, which this RFC forbids promising",
  },
  {
    pattern: /\bdisable[_\s-]?(cap|limiter|limit)\b|\bskip[_\s-]?cap\b/i,
    what: "a way to disable a cap or limiter",
  },
  {
    pattern: /\bignore[_\s-]?(cap|limiter|risk)\b|\bforce[_\s-]?size\b/i,
    what: "a way to bypass the sizing limiters",
  },
  {
    pattern: /\bleverage\b|\bmartingale\b/i,
    what: "leverage or martingale sizing",
  },
];

/**
 * Tables this module may write to. Anything outside the list is either another
 * RFC's data or a table nobody declared, and both are bugs.
 */
const WRITABLE_TABLES: readonly string[] = [
  "portfolio_config_versions",
  "portfolio_factor_map_versions",
  "portfolio_decisions",
  "portfolio_exposures",
  "portfolio_state",
  "portfolio_state_events",
  "portfolio_circuit_breakers",
  "portfolio_panel_snapshots",
  "portfolio_gate_measurements",
  "portfolio_gate_reports",
  "portfolio_g2_clock",
  "portfolio_g2_clock_events",
];

async function moduleFiles(): Promise<string[]> {
  const entries = await readdir(MODULE_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(MODULE_ROOT, entry.name));
}

/**
 * Strip block comments and whole-line comments before scanning.
 *
 * The guard is looking for an IMPLEMENTATION, not for prose. The RFC itself
 * requires this module to document the absence of real execution and of any
 * stop-loss, so the words have to be writable in a comment that denies them —
 * scanning comments would make the required documentation fail the guard that
 * exists to enforce it.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    })
    .join("\n");
}

async function readAll(): Promise<{ path: string; text: string }[]> {
  const files = await moduleFiles();
  return Promise.all(
    files.map(async (path) => ({
      path,
      text: stripComments(await readFile(path, "utf8")),
    })),
  );
}

describe("RFC-013 portfolio module scope guard", () => {
  it("owns at least the modules this phase ships", async () => {
    const files = (await moduleFiles()).map((path) => path.split("/").pop());
    for (const expected of [
      "types.ts",
      "config.ts",
      "ev.ts",
      "sizing.ts",
      "state.ts",
      "factors.ts",
    ]) {
      expect(files, expected).toContain(expected);
    }
  });

  it("contains no trading auth, wallet, signer or real order path", async () => {
    for (const { path, text } of await readAll()) {
      for (const { pattern, what } of FORBIDDEN) {
        expect(pattern.test(text), `${path} must not contain ${what}`).toBe(
          false,
        );
      }
    }
  });

  it("writes only to the tables this RFC declares", async () => {
    const writeStatement =
      /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/gi;
    for (const { path, text } of await readAll()) {
      for (const match of text.matchAll(writeStatement)) {
        const table = match[2]?.toLowerCase();
        if (table === undefined) {
          continue;
        }
        expect(
          WRITABLE_TABLES.includes(table),
          `${path} writes to undeclared table ${table}`,
        ).toBe(true);
      }
    }
  });

  it("makes no outbound network call", async () => {
    // The engine is event-driven over data the recorder already wrote. A fetch
    // here would be a new external dependency the RFC does not authorize.
    for (const { path, text } of await readAll()) {
      expect(/\bfetch\s*\(/.test(text), `${path} must not fetch`).toBe(false);
      expect(/\bWebSocket\b/.test(text), `${path} must not open a socket`).toBe(
        false,
      );
    }
  });

  it("never reads closedTime, whose timestamp postdates the public outcome", async () => {
    // Same leakage guard the RFC-010/012 modules carry: closedTime arrives
    // after the outcome is publicly known, so a label built from it leaks.
    for (const { path, text } of await readAll()) {
      expect(
        /closedTime|closed_time/i.test(text),
        `${path} must not use closedTime`,
      ).toBe(false);
    }
  });

  it("documents the absence of real execution and of any stop-loss", async () => {
    // The counterpart of stripping comments above: the guard stops reading
    // prose, so it must still prove the required prose exists.
    const files = await moduleFiles();
    const texts = await Promise.all(
      files.map((path) => readFile(path, "utf8")),
    );
    const corpus = texts.join("\n");
    expect(/stop[- ]loss/i.test(corpus)).toBe(true);
    expect(/simula|simulation|paper/i.test(corpus)).toBe(true);
  });

  it("carries no promise of profit in any user-facing string", async () => {
    for (const { path, text } of await readAll()) {
      expect(
        /\bguaranteed\s+(profit|return)|\brisk[_\s-]?free\b|\bsure\s+thing\b/i.test(
          text,
        ),
        `${path} must not promise profit`,
      ).toBe(false);
    }
  });
});
