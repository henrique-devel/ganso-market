import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { errorFields } from "../src/errors.js";

describe("RFC-023 D3 — errorFields", () => {
  it("names the error, its message and its SQLSTATE", () => {
    const error = Object.assign(new Error("canceling statement"), {
      name: "error",
      code: "57014",
    });
    expect(errorFields(error)).toEqual({
      error_name: "error",
      error_message: "canceling statement",
      pg_code: "57014",
    });
  });

  it("survives a thrown value that is not an Error", () => {
    expect(errorFields("just a string")).toEqual({
      error_name: "UnknownError",
      error_message: null,
      pg_code: null,
    });
    expect(errorFields(null)).toEqual({
      error_name: "UnknownError",
      error_message: null,
      pg_code: null,
    });
    expect(errorFields(undefined).pg_code).toBeNull();
  });

  it("keeps a non-string code out of pg_code", () => {
    // Some libraries put a number there; printing it would read as a SQLSTATE.
    expect(
      errorFields(Object.assign(new Error("x"), { code: 42 })).pg_code,
    ).toBeNull();
  });

  it("carries a Node error code, which is worth as much as a SQLSTATE", () => {
    expect(
      errorFields(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))
        .pg_code,
    ).toBe("ECONNREFUSED");
  });

  it("copies nothing but the error's own message", () => {
    const error = Object.assign(new Error("boom"), {
      code: "23505",
      // A `pg` error carries the failing statement and its parameters. Neither
      // may reach a log line.
      query: "INSERT INTO paper_orders VALUES ($1)",
      parameters: ["secret-value"],
      detail: "Key (order_id)=(1) already exists.",
    });
    expect(Object.keys(errorFields(error)).sort()).toEqual([
      "error_message",
      "error_name",
      "pg_code",
    ]);
    expect(JSON.stringify(errorFields(error))).not.toContain("secret-value");
  });
});

/** Every .ts under apps/api/src, except the helper itself. */
function sourceFiles(): string[] {
  const root = new URL("../src/", import.meta.url).pathname;
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts") && entry !== "errors.ts") {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

describe("RFC-023 D3 — no log line names an error without saying what it was", () => {
  const files = sourceFiles();

  it("has source to sweep", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it("builds every error log through errorFields", () => {
    // `error_name` as a literal key is exactly the shape that hid
    // `column "occurred_at" does not exist` for about 40 hours: a reason code,
    // a name that says "error", and nothing that identifies the failure. The
    // helper is the only place allowed to write that key, so an `error_name:`
    // literal anywhere else means a site was added without a message.
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (/(^|[^\w.])error_name\s*:/.test(code)) {
          offenders.push(
            `${file.split("/apps/")[1] ?? file}:${String(index + 1)}`,
          );
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("imports the helper wherever it is used", () => {
    const missing = files.filter((file) => {
      const text = readFileSync(file, "utf8");
      return (
        text.includes("errorFields(") &&
        !/import\s*\{[^}]*\berrorFields\b[^}]*\}\s*from/.test(text)
      );
    });
    expect(missing).toEqual([]);
  });
});
